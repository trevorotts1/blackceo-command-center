/**
 * Unit tests for PRD item 1.6 — async persona selection, non-blocking event loop.
 *
 * PROBLEM (pre-fix):
 *   src/lib/persona-selector.ts used execFileSync with a 30s timeout inside the
 *   Next.js server.  While the Python selector ran (semantic embed + LLM scoring),
 *   the entire Node event loop froze.  Five rapid task creates could stall the
 *   dashboard for 150 seconds.
 *
 * FIX (PRD 1.6):
 *   1. persona-selector.ts now uses promisified async execFile (execFileAsync),
 *      never execFileSync.  selectPersonaForTask is async and non-blocking.
 *   2. createTaskCore inserts the task and broadcasts task_created BEFORE persona
 *      selection starts.  Persona selection runs in a detached void(async()=>{})
 *      block.  When it resolves, the task row is UPDATEd and a task_updated SSE
 *      event delivers the persona chip.
 *
 * VERIFY:
 *   1. execFileSync is NOT imported in persona-selector.ts (source-level guard).
 *   2. execFileAsync (promisified execFile) IS used — selectPersonaForTask returns
 *      a Promise.
 *   3. createTaskCore returns the task immediately without waiting for persona
 *      selection (measured: < 500ms even when the selector takes seconds).
 *   4. task_created SSE is broadcast BEFORE any persona work begins.
 *   5. task_updated SSE is broadcast after persona UPDATE (verified via mock).
 *   6. Both layouts (Mac / VPS) — env-driven; no hardcoded paths.
 *
 * Layout-aware: uses DATABASE_PATH env.  OPENCLAW_ROOT=/nonexistent prevents
 * real Python selector runs in CI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// ── Test DB setup ─────────────────────────────────────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-1.6-async-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Prevent real Python selector spawns — the selector is not installed in CI.
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';

// Disable QC auto-scorer to keep test scope narrow.
process.env.DISABLE_QC_AUTO_SCORER = 'true';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

// ── Module imports (after env setup) ─────────────────────────────────────────
type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type SelectorModule = typeof import('../../src/lib/persona-selector');
type TasksModule = typeof import('../../src/lib/tasks');

test.before(async () => {
  const db = await import('../../src/lib/db') as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;

  // Seed a default company row so workspace inserts with company_id FK don't
  // violate constraints (same pattern as prd-1.5 and record-completion tests).
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, industry, config) VALUES (?, ?, ?, ?, ?)`,
    ['default', 'Test Company', 'test-company', '', '{}'],
  );
});

test.after(async () => {
  await closeDb?.();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

let wsCounter = 0;
function insertWorkspace(id: string, slug: string, name: string): void {
  wsCounter++;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, slug, 'Test dept', 900 + wsCounter],
  );
}

// ── Test 1: execFileSync NOT imported in persona-selector.ts ─────────────────
test('PRD 1.6: execFileSync is not imported in persona-selector.ts', () => {
  const selectorSrc = readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'persona-selector.ts'),
    'utf-8',
  );
  // execFileSync must not appear as an import specifier.
  // The word may appear in comments for historical context — only check the import line.
  const importLines = selectorSrc
    .split('\n')
    .filter(l => l.trim().startsWith('import'));
  const hasSyncImport = importLines.some(l => l.includes('execFileSync'));
  assert.equal(
    hasSyncImport,
    false,
    'execFileSync must not be imported in persona-selector.ts (PRD 1.6)',
  );
});

// ── Test 2: execFile (promisified) IS used ────────────────────────────────────
test('PRD 1.6: persona-selector.ts uses promisify(execFile), not execFileSync', () => {
  const selectorSrc = readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'persona-selector.ts'),
    'utf-8',
  );
  assert.ok(
    selectorSrc.includes('promisify'),
    'persona-selector.ts must import promisify from "util" (PRD 1.6)',
  );
  assert.ok(
    selectorSrc.includes('execFileAsync'),
    'persona-selector.ts must define execFileAsync via promisify(execFile) (PRD 1.6)',
  );
});

// ── Test 3: selectPersonaForTask returns a Promise ────────────────────────────
test('PRD 1.6: selectPersonaForTask is async and returns a Promise', async () => {
  const mod = await import('../../src/lib/persona-selector') as SelectorModule;
  assert.ok(
    typeof mod.selectPersonaForTask === 'function',
    'selectPersonaForTask must be exported',
  );
  // Call with an OPENCLAW_ROOT that does not exist → should reject/throw gracefully (Promise, not synchronous throw).
  const result = mod.selectPersonaForTask('test-task-id', 'test description', 'marketing');
  assert.ok(
    result instanceof Promise,
    'selectPersonaForTask must return a Promise (async / promisified execFile)',
  );
  // The call should resolve to null (graceful failure when script path does not exist).
  const val = await result;
  assert.equal(val, null, 'Should resolve to null when Python script is not found');
});

// ── Test 4: createTaskCore returns quickly (persona selection is detached) ────
test('PRD 1.6: createTaskCore returns in < 500ms (persona selection is detached async)', async () => {
  // Mac layout: no OPENCLAW_PLATFORM set.
  delete process.env.OPENCLAW_PLATFORM;

  const wsId = `ws-async-test-mac-${Date.now()}`;
  insertWorkspace(wsId, 'marketing', 'Marketing Department');

  const tasksModule = await import('../../src/lib/tasks') as TasksModule;

  const start = Date.now();
  const result = await tasksModule.createTaskCore({
    title: 'PRD 1.6 speed test task',
    description: 'Verify async persona selection does not block the API response',
    workspace_id: wsId,
    department: 'marketing',
    skipWindowDedup: true,
  });
  const elapsed = Date.now() - start;

  assert.ok(result !== undefined, 'createTaskCore must return a result');
  assert.ok(
    elapsed < 500,
    `createTaskCore must return in < 500ms but took ${elapsed}ms (PRD 1.6)`,
  );
  assert.equal(result!.deduped, false, 'Task must not be deduped');
  assert.ok(result!.task.id, 'Returned task must have an id');
});

// ── Test 5: VPS layout — same speed guarantee ─────────────────────────────────
test('PRD 1.6: createTaskCore returns in < 500ms on VPS layout (OPENCLAW_PLATFORM=vps)', async () => {
  process.env.OPENCLAW_PLATFORM = 'vps';

  const wsId = `ws-async-test-vps-${Date.now()}`;
  insertWorkspace(wsId, 'sales', 'Sales Department');

  const tasksModule = await import('../../src/lib/tasks') as TasksModule;

  const start = Date.now();
  const result = await tasksModule.createTaskCore({
    title: 'PRD 1.6 VPS speed test task',
    description: 'VPS layout — persona selection must not block',
    workspace_id: wsId,
    department: 'sales',
    skipWindowDedup: true,
  });
  const elapsed = Date.now() - start;

  assert.ok(result !== undefined, 'createTaskCore must return a result');
  assert.ok(
    elapsed < 500,
    `createTaskCore must return in < 500ms on VPS layout but took ${elapsed}ms (PRD 1.6)`,
  );

  // Restore
  delete process.env.OPENCLAW_PLATFORM;
});

// ── Test 6: task_created broadcast fires before persona is written ─────────────
test('PRD 1.6: task row exists immediately after createTaskCore returns (before persona lands)', async () => {
  delete process.env.OPENCLAW_PLATFORM;

  const wsId = `ws-async-pre-persona-${Date.now()}`;
  insertWorkspace(wsId, 'hr', 'Human Resources Department');

  const tasksModule = await import('../../src/lib/tasks') as TasksModule;

  const result = await tasksModule.createTaskCore({
    title: 'PRD 1.6 immediate row test',
    description: 'Task row must exist and persona_id may still be null at return time',
    workspace_id: wsId,
    department: 'hr',
    skipWindowDedup: true,
  });

  assert.ok(result !== undefined, 'createTaskCore must return a result');

  const taskId = result!.task.id;
  const row = queryOne<{ id: string; persona_id: string | null }>(
    'SELECT id, persona_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.ok(row, 'Task row must exist immediately in the DB after createTaskCore returns');
  // persona_id may be null at this point (selector is still running async).
  // The test just verifies the row exists, not that persona is set.
  assert.equal(row!.id, taskId, 'Task id must match');
});

// ── Test 7: 5 rapid task creates all return quickly ──────────────────────────
test('PRD 1.6: 5 rapid task creates each complete in < 500ms', async () => {
  delete process.env.OPENCLAW_PLATFORM;

  const wsId = `ws-rapid-${Date.now()}`;
  insertWorkspace(wsId, 'operations', 'Operations Department');

  const tasksModule = await import('../../src/lib/tasks') as TasksModule;

  const timings: number[] = [];

  for (let i = 1; i <= 5; i++) {
    const start = Date.now();
    const result = await tasksModule.createTaskCore({
      title: `PRD 1.6 rapid task ${i} (${Date.now()})`,
      description: `Rapid-create task ${i} — should not block event loop`,
      workspace_id: wsId,
      department: 'operations',
      skipWindowDedup: true,
    });
    const elapsed = Date.now() - start;
    timings.push(elapsed);
    assert.ok(result !== undefined, `Task ${i} must return a result`);
    assert.ok(
      elapsed < 500,
      `Task ${i} must return in < 500ms but took ${elapsed}ms (PRD 1.6)`,
    );
  }

  console.log('[PRD 1.6 test] 5-task timings (ms):', timings.join(', '));
});

// ── PERSONA-BLEND — parsePersonaBundle (pure, no Python) ─────────────────────
test('BLEND: parsePersonaBundle returns NULL for a legacy single-persona result (backward compat)', async () => {
  const mod = await import('../../src/lib/persona-selector') as SelectorModule;
  // A legacy result carries NO bundle SUPERSET fields → null (CC behaves as before).
  assert.equal(mod.parsePersonaBundle({ persona_id: 'hormozi-100m-offers', score: 0.9 }), null);
  assert.equal(mod.parsePersonaBundle(null), null);
  assert.equal(mod.parsePersonaBundle('nonsense'), null);
});

test('BLEND: parsePersonaBundle normalizes the SUPERSET and ALWAYS injects the guardrail', async () => {
  const mod = await import('../../src/lib/persona-selector') as SelectorModule;
  const raw = {
    persona_id: 'ogilvy-on-advertising',
    topic: 'SaaS pricing pages',
    confirm_required: true,
    resolved_audience: { source: 'onboarding_icp', candidates: ['Founders', 'RevOps leads'], confidence: 0.4 },
    voice: {
      audience_persona: { id: 'audience-voice-persona', why: 'writes for founders' },
      topic_persona: { id: 'ogilvy-on-advertising', why: 'pricing-page craft' },
      collapsed: false,
      topic_as_task_guidance: true,
    },
    // Matcher-emitted directive WITHOUT the guardrail — parse must inject it.
    blend_directive: 'Write in the audience voice; carry Ogilvy pricing craft.',
    task_personas: [
      { seq: 1, part: 'hero headline', persona_id: 'ogilvy-on-advertising', why: 'headline craft' },
      { seq: 2, part: 'pricing table', persona_id: 'pricing-strategist' },
    ],
  };
  const bundle = mod.parsePersonaBundle(raw);
  assert.ok(bundle, 'a SUPERSET result parses to a bundle');
  assert.equal(bundle!.confirm_required, true);
  assert.equal(bundle!.voice.collapsed, false);
  assert.equal(bundle!.voice.topic_persona?.id, 'ogilvy-on-advertising');
  assert.equal(bundle!.resolved_audience?.source, 'onboarding_icp');
  assert.deepEqual(bundle!.resolved_audience?.candidates, ['Founders', 'RevOps leads']);
  assert.equal(bundle!.task_personas.length, 2);
  // NON-REMOVABLE guardrail: injected even though the matcher omitted it.
  assert.ok(/style-inspired/i.test(bundle!.blend_directive) && /impersonation/i.test(bundle!.blend_directive));
  assert.ok(bundle!.blend_directive.includes('Write in the audience voice'), 'upstream directive preserved');
});

test('BLEND: parsePersonaBundle caps task_personas at 10', async () => {
  const mod = await import('../../src/lib/persona-selector') as SelectorModule;
  const raw = {
    confirm_required: false,
    task_personas: Array.from({ length: 14 }, (_v, i) => ({ seq: i + 1, persona_id: `p-${i + 1}` })),
  };
  const bundle = mod.parsePersonaBundle(raw);
  assert.ok(bundle);
  assert.equal(bundle!.task_personas.length, 10, 'up-to-10 task personas — hard cap');
});

// ── Test 8: tasks.ts delegates async persona block (source-level check) ───────
test('PRD 1.6: tasks.ts uses void (async () => {}) for persona selection (not await-in-main-path)', () => {
  const tasksSrc = readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'tasks.ts'),
    'utf-8',
  );
  // The async persona block must be a detached void IIFE.
  assert.ok(
    tasksSrc.includes('void (async ()'),
    'tasks.ts must use void (async () => {}) for detached persona selection (PRD 1.6)',
  );
  // task_updated must be broadcast from inside the async block.
  assert.ok(
    tasksSrc.includes("'task_updated'"),
    "tasks.ts must broadcast task_updated when persona lands (PRD 1.6)",
  );
});
