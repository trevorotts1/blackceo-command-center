/**
 * Unit tests for PRD item 3.4 — SENTINEL_IDS guard converts to loud warning.
 *
 * CONTEXT (PRD Section 4, item 3.4):
 *   `src/lib/tasks.ts` filtered persona ids like "schemaVersion" and
 *   "domainTags" that an old, buggy list_available_personas() emitted.
 *   The underlying bug was fixed in persona-selector-v2.py (lines 604-611).
 *   PRD 3.4 says: keep the guard for one release, but LOG A LOUD WARNING with
 *   the installed skill version when a sentinel appears, so stale installs get
 *   identified and updated instead of silently tolerated.
 *
 * WHAT THESE TESTS VERIFY:
 *   1. SENTINEL_IDS set is exported from tasks.ts and contains all five known
 *      sentinel ids (schemaVersion, created, domainTags, perspectiveTags, personas).
 *   2. getInstalledSkillVersion() reads from ONBOARDING_VERSION env var (CI path),
 *      then falls back to file candidates, then returns "unknown".
 *   3. getInstalledSkillVersion() reads the correct file on Mac layout.
 *   4. getInstalledSkillVersion() returns "unknown" when no source is available.
 *   5. When a sentinel id appears, console.warn fires with the sentinel id, the
 *      skill version, and the task id — and the task row is NOT updated with
 *      that sentinel as persona_id (guard still filters).
 *   6. When a real (non-sentinel) persona id appears, no warn fires and the
 *      task row IS updated with that persona id.
 *   7. Source-level: the inline SENTINEL_IDS Set literal is gone from the async
 *      persona block; the module-level exported constant is used instead.
 *   8. tasks.ts exports getInstalledSkillVersion (source-level check).
 *   9. All five known sentinel ids are recognized by the exported set.
 *
 * PERSONA_FIXTURE_JSON env var is used to inject a fixture persona result
 * without spawning Python — test/CI only (never set in production).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// ── Test DB setup ─────────────────────────────────────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-3.4-sentinel-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Prevent real Python selector spawns (default; overridden per-test with fixture).
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';

// Disable QC auto-scorer.
process.env.DISABLE_QC_AUTO_SCORER = 'true';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.PERSONA_FIXTURE_JSON;

// ── Module imports ────────────────────────────────────────────────────────────
type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type TasksModule = typeof import('../../src/lib/tasks');

test.before(async () => {
  const db = await import('../../src/lib/db') as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;

  // Seed a default company row so workspace inserts with company_id FK pass.
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, industry, config) VALUES (?, ?, ?, ?, ?)`,
    ['default', 'Test Company', 'test-company', '', '{}'],
  );
});

test.after(async () => {
  delete process.env.PERSONA_FIXTURE_JSON;
  delete process.env.ONBOARDING_VERSION;
  await closeDb?.();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
let wsCounter = 0;
function insertWorkspace(id: string, slug: string, name: string): void {
  wsCounter++;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, slug, 'Test dept', 9000 + wsCounter],
  );
}

// ── Test 1: SENTINEL_IDS is exported and contains all five known ids ──────────
test('PRD 3.4: SENTINEL_IDS is exported from tasks.ts', async () => {
  const mod = await import('../../src/lib/tasks') as TasksModule;
  assert.ok(
    mod.SENTINEL_IDS instanceof Set,
    'SENTINEL_IDS must be an exported Set from tasks.ts (PRD 3.4)',
  );
  const expected = ['schemaVersion', 'created', 'domainTags', 'perspectiveTags', 'personas'];
  for (const id of expected) {
    assert.ok(
      mod.SENTINEL_IDS.has(id),
      `SENTINEL_IDS must contain "${id}" (PRD 3.4)`,
    );
  }
  assert.equal(
    mod.SENTINEL_IDS.size,
    expected.length,
    `SENTINEL_IDS must have exactly ${expected.length} entries (PRD 3.4)`,
  );
});

// ── Test 2: getInstalledSkillVersion reads ONBOARDING_VERSION env var ─────────
test('PRD 3.4: getInstalledSkillVersion reads ONBOARDING_VERSION env var', async () => {
  const mod = await import('../../src/lib/tasks') as TasksModule;
  const prev = process.env.ONBOARDING_VERSION;
  try {
    process.env.ONBOARDING_VERSION = 'v11.9.0-test';
    const ver = mod.getInstalledSkillVersion();
    assert.equal(ver, 'v11.9.0-test', 'getInstalledSkillVersion must return ONBOARDING_VERSION env value');
  } finally {
    if (prev !== undefined) {
      process.env.ONBOARDING_VERSION = prev;
    } else {
      delete process.env.ONBOARDING_VERSION;
    }
  }
});

// ── Test 3: getInstalledSkillVersion reads Mac-layout version file ────────────
test('PRD 3.4: getInstalledSkillVersion reads Mac-layout .onboarding-version file', async () => {
  const mod = await import('../../src/lib/tasks') as TasksModule;
  delete process.env.ONBOARDING_VERSION;

  const macVersionPath = path.join(os.homedir(), '.onboarding-version');
  const hadExisting = fs.existsSync(macVersionPath);
  const existingContent = hadExisting ? fs.readFileSync(macVersionPath, 'utf-8') : null;

  try {
    fs.writeFileSync(macVersionPath, 'v11.5.0-mac-test\n', 'utf-8');
    const ver = mod.getInstalledSkillVersion();
    assert.equal(
      ver,
      'v11.5.0-mac-test',
      'getInstalledSkillVersion must read ~/.onboarding-version on Mac layout',
    );
  } finally {
    if (existingContent !== null) {
      fs.writeFileSync(macVersionPath, existingContent, 'utf-8');
    } else {
      try { fs.unlinkSync(macVersionPath); } catch { /* ok */ }
    }
  }
});

// ── Test 4: getInstalledSkillVersion returns "unknown" when no source ─────────
test('PRD 3.4: getInstalledSkillVersion returns "unknown" when no source is available', async () => {
  const mod = await import('../../src/lib/tasks') as TasksModule;
  delete process.env.ONBOARDING_VERSION;

  const macVersionPath = path.join(os.homedir(), '.onboarding-version');
  const hadExisting = fs.existsSync(macVersionPath);
  const existingContent = hadExisting ? fs.readFileSync(macVersionPath, 'utf-8') : null;

  try {
    if (hadExisting) fs.unlinkSync(macVersionPath);
    const ver = mod.getInstalledSkillVersion();
    assert.equal(
      ver,
      'unknown',
      'getInstalledSkillVersion must return "unknown" when no version file or env var exists',
    );
  } finally {
    if (existingContent !== null) {
      fs.writeFileSync(macVersionPath, existingContent, 'utf-8');
    }
  }
});

// ── Test 5: sentinel id fires console.warn AND guard still filters ────────────
test('PRD 3.4: sentinel persona id fires loud console.warn with skill version and is filtered', async () => {
  delete process.env.OPENCLAW_PLATFORM;
  process.env.ONBOARDING_VERSION = 'v11.3.2-stale-test';

  // Inject a sentinel id via the fixture env var.
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'schemaVersion',
    persona_name: 'Schema Version (STALE)',
    interaction_mode: 'standard',
    score: 5.0,
    persona_version: 1,
  });

  const wsId = `ws-sentinel-warn-${Date.now()}`;
  insertWorkspace(wsId, 'finance', 'Finance Department');

  const mod = await import('../../src/lib/tasks') as TasksModule;

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
    originalWarn(...args);
  };

  let taskId: string | undefined;
  try {
    const result = await mod.createTaskCore({
      title: 'Sentinel guard test task',
      description: 'Test that sentinel fires loud warning',
      workspace_id: wsId,
      department: 'finance',
      skipWindowDedup: true,
    });
    taskId = result?.task.id;
  } finally {
    console.warn = originalWarn;
    delete process.env.PERSONA_FIXTURE_JSON;
    delete process.env.ONBOARDING_VERSION;
  }

  // Give the async persona block time to settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  // Verify: at least one warning containing the sentinel id and skill version.
  const sentinelWarnings = warnings.filter(
    (w) => w.includes('STALE INSTALL DETECTED') && w.includes('schemaVersion'),
  );
  assert.ok(
    sentinelWarnings.length > 0,
    `Expected a console.warn containing "STALE INSTALL DETECTED" and "schemaVersion". ` +
    `Got warnings:\n${warnings.join('\n')}`,
  );

  // The warning must contain the installed skill version.
  const versionWarning = sentinelWarnings.find((w) => w.includes('v11.3.2-stale-test'));
  assert.ok(
    versionWarning,
    `The sentinel warning must include the installed skill version "v11.3.2-stale-test". ` +
    `Got sentinel warnings:\n${sentinelWarnings.join('\n')}`,
  );

  // The warning must include the task_id.
  if (taskId) {
    const taskIdInWarn = sentinelWarnings.some((w) => w.includes(taskId!));
    assert.ok(
      taskIdInWarn,
      `The sentinel warning must include the task_id "${taskId}". ` +
      `Got sentinel warnings:\n${sentinelWarnings.join('\n')}`,
    );
  }

  // The guard must still filter: persona_id on the task row must NOT be 'schemaVersion'.
  if (taskId) {
    const row = queryOne<{ persona_id: string | null }>(
      'SELECT persona_id FROM tasks WHERE id = ?',
      [taskId],
    );
    assert.ok(row, 'Task row must exist');
    assert.notEqual(
      row!.persona_id,
      'schemaVersion',
      'Guard must still filter sentinel: task persona_id must NOT be "schemaVersion"',
    );
  }
});

// ── Test 6: real persona id does not fire a warning and IS persisted ──────────
test('PRD 3.4: real persona id does not fire console.warn and IS written to task row', async () => {
  delete process.env.OPENCLAW_PLATFORM;
  delete process.env.ONBOARDING_VERSION;

  // Inject a real (non-sentinel) persona id via the fixture env var.
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'seth-godin-marketing',
    persona_name: 'Seth Godin',
    interaction_mode: 'leadership',
    score: 8.7,
    persona_version: 2,
  });

  const wsId = `ws-real-persona-${Date.now()}`;
  insertWorkspace(wsId, 'marketing', 'Marketing Department');

  const mod = await import('../../src/lib/tasks') as TasksModule;

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
    originalWarn(...args);
  };

  let taskId: string | undefined;
  try {
    const result = await mod.createTaskCore({
      title: 'Real persona guard test task',
      description: 'Real persona should NOT trigger warning and SHOULD be persisted',
      workspace_id: wsId,
      department: 'marketing',
      skipWindowDedup: true,
    });
    taskId = result?.task.id;
  } finally {
    console.warn = originalWarn;
    delete process.env.PERSONA_FIXTURE_JSON;
  }

  // Give the async persona block time to settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  // No sentinel warning should have fired.
  const sentinelWarnings = warnings.filter((w) => w.includes('STALE INSTALL DETECTED'));
  assert.equal(
    sentinelWarnings.length,
    0,
    `No "STALE INSTALL DETECTED" warning should fire for a real persona id. ` +
    `Got:\n${sentinelWarnings.join('\n')}`,
  );

  // The real persona_id must be written to the task row.
  if (taskId) {
    const row = queryOne<{ persona_id: string | null }>(
      'SELECT persona_id FROM tasks WHERE id = ?',
      [taskId],
    );
    assert.ok(row, 'Task row must exist');
    assert.equal(
      row!.persona_id,
      'seth-godin-marketing',
      'Real persona id must be written to task row',
    );
  }
});

// ── Test 7: source-level — no inline SENTINEL_IDS literal in async block ──────
test('PRD 3.4: tasks.ts uses module-level SENTINEL_IDS (no inline Set literal in async persona block)', () => {
  const tasksSrc = readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'tasks.ts'),
    'utf-8',
  );

  const asyncBlockStart = tasksSrc.indexOf('ASYNC PERSONA SELECTION');
  assert.ok(asyncBlockStart !== -1, 'async persona selection block must exist in tasks.ts');

  const asyncBlockSource = tasksSrc.slice(asyncBlockStart);
  const inlineSetLiteral = asyncBlockSource.match(/const\s+SENTINEL_IDS\s*=\s*new\s+Set\s*\(\s*\[/);
  assert.equal(
    inlineSetLiteral,
    null,
    'The async persona block must NOT contain an inline "const SENTINEL_IDS = new Set([...])". ' +
    'It must use the module-level exported SENTINEL_IDS constant (PRD 3.4)',
  );

  // The module-level exported constant must exist.
  assert.ok(
    tasksSrc.includes('export const SENTINEL_IDS = new Set('),
    'tasks.ts must export SENTINEL_IDS as a module-level constant (PRD 3.4)',
  );
});

// ── Test 8: source-level — getInstalledSkillVersion is exported ───────────────
test('PRD 3.4: tasks.ts exports getInstalledSkillVersion function', () => {
  const tasksSrc = readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'tasks.ts'),
    'utf-8',
  );
  assert.ok(
    tasksSrc.includes('export function getInstalledSkillVersion'),
    'tasks.ts must export getInstalledSkillVersion function (PRD 3.4)',
  );
});

// ── Test 9: all five known sentinel ids are recognized ────────────────────────
test('PRD 3.4: all five known sentinel ids are members of SENTINEL_IDS', async () => {
  const mod = await import('../../src/lib/tasks') as TasksModule;
  const knownSentinels = [
    'schemaVersion',
    'created',
    'domainTags',
    'perspectiveTags',
    'personas',
  ];
  for (const id of knownSentinels) {
    assert.ok(
      mod.SENTINEL_IDS.has(id),
      `SENTINEL_IDS must recognize "${id}" as a sentinel (PRD 3.4)`,
    );
  }
});
