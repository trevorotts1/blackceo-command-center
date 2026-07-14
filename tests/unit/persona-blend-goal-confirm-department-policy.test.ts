/**
 * PERSONA-BLEND / A-U4 — per-department confirm-timeout policy (D23, master-spec
 * v2 §A.5 item 5).
 *
 * Proves the CC-owned half of A-U4's binary acceptance criterion (c):
 *
 *   "for a funnels-department task, confirm-window expiry yields status
 *    blocked with block_audience='OWNER' and NEVER a house-voice write
 *    (fixture test); a low-stakes-department task still releases at 30 min
 *    (both policies tested)."
 *
 * Kills the silent timeout for BUILD departments (funnels / web-development):
 * D23's ratified default hard-holds those departments to 'blocked' on
 * confirm-window expiry instead of the existing NEVER-NAKED house-voice
 * release every other department keeps. This is the exact cookie-cutter-
 * under-a-silent-timeout outcome the operator is fighting on funnels.
 *
 *   A. isHardHoldConfirmDepartment — the pure department predicate (default
 *      list + env override).
 *   B. blockForOwnerConfirm — status -> 'blocked', block_audience='OWNER',
 *      event + notify on the transition, idempotent (status-guarded).
 *   C. POLICY SIMULATION — exercises the EXACT branch task-dispatcher.ts's
 *      audience-confirm gate runs at deadline_fallback (evaluate -> branch on
 *      isHardHoldConfirmDepartment -> blockForOwnerConfirm OR
 *      markAudienceDeadlineFallback) for a funnels-department task AND a
 *      marketing-department (low-stakes) task, proving BOTH policies without
 *      needing autoDispatchTask's full agent-claim/SSE machinery.
 *
 * Node built-in test runner under tsx (`npm run test:unit`). DATABASE_PATH
 * points at a throwaway file BEFORE `@/lib/db` is imported (same pattern as
 * tests/unit/persona-blend-audience-confirm.test.ts).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-goal-confirm-dept-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
process.env.DISABLE_QC_AUTO_SCORER = 'true';
delete process.env.HARD_HOLD_CONFIRM_DEPARTMENTS;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];

type SelectorModule = typeof import('../../src/lib/persona-selector');
let persistPersonaBundle: SelectorModule['persistPersonaBundle'];

type TasksModule = typeof import('../../src/lib/tasks');
let evaluateAudienceConfirmGate: TasksModule['evaluateAudienceConfirmGate'];
let markAudienceDeadlineFallback: TasksModule['markAudienceDeadlineFallback'];
let isHardHoldConfirmDepartment: TasksModule['isHardHoldConfirmDepartment'];
let hardHoldConfirmDepartments: TasksModule['hardHoldConfirmDepartments'];
let blockForOwnerConfirm: TasksModule['blockForOwnerConfirm'];
let AUDIENCE_CONFIRM_DEADLINE_MS: TasksModule['AUDIENCE_CONFIRM_DEADLINE_MS'];

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}`;

function insertTask(id: string, department: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, department, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', NULL, NULL, ?, ?, ?)`,
    [id, `Goal-confirm task ${id}`, department, now, now],
  );
}

function bundle(overrides: Partial<import('../../src/lib/types').PersonaBundle> = {}): import('../../src/lib/types').PersonaBundle {
  return {
    topic: 'landing page copy',
    confirm_required: true,
    resolved_audience: {
      source: 'onboarding_icp',
      candidates: ['Founders'],
      confidence: 0.9,
      label: 'Founders',
      id: null,
    },
    voice: {
      audience_persona: { id: 'audience-voice-persona', why: 'writes for founders' },
      topic_persona: { id: 'ogilvy-on-advertising', why: 'landing-page craft' },
      collapsed: false,
      topic_as_task_guidance: true,
    },
    blend_directive: 'Write in the audience voice; carry the topic persona expertise.',
    task_personas: [
      { seq: 1, part: 'headline', persona_id: 'ogilvy-on-advertising', why: 'headline craft' },
    ],
    catalog_version: '1.4',
    conversion_goal: '',
    goal_source: 'asked',
    goal_confirm_required: true,
    ...overrides,
  };
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  ({ run, queryOne, queryAll, getDb, closeDb } = db);
  getDb();

  ({ persistPersonaBundle } = await import('../../src/lib/persona-selector'));
  const tasks = await import('../../src/lib/tasks');
  evaluateAudienceConfirmGate = tasks.evaluateAudienceConfirmGate;
  markAudienceDeadlineFallback = tasks.markAudienceDeadlineFallback;
  isHardHoldConfirmDepartment = tasks.isHardHoldConfirmDepartment;
  hardHoldConfirmDepartments = tasks.hardHoldConfirmDepartments;
  blockForOwnerConfirm = tasks.blockForOwnerConfirm;
  AUDIENCE_CONFIRM_DEADLINE_MS = tasks.AUDIENCE_CONFIRM_DEADLINE_MS;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ── A. isHardHoldConfirmDepartment ───────────────────────────────────────────

test('[dept] default hard-hold list is exactly funnels + web-development', () => {
  assert.deepEqual(hardHoldConfirmDepartments(), ['funnels', 'web-development']);
  assert.equal(isHardHoldConfirmDepartment('funnels'), true);
  assert.equal(isHardHoldConfirmDepartment('web-development'), true);
});

test('[dept] every other department keeps the existing 30-min house-voice release policy', () => {
  for (const dept of ['marketing', 'operations', 'sales', 'general', 'support']) {
    assert.equal(isHardHoldConfirmDepartment(dept), false, `${dept} must NOT be hard-hold`);
  }
});

test('[dept] null/undefined/empty department never hard-holds (fail-open to existing behavior)', () => {
  assert.equal(isHardHoldConfirmDepartment(null), false);
  assert.equal(isHardHoldConfirmDepartment(undefined), false);
  assert.equal(isHardHoldConfirmDepartment(''), false);
});

test('[dept] NO-WEAKENING: env override widens (never silently narrows) the hard-hold list', () => {
  process.env.HARD_HOLD_CONFIRM_DEPARTMENTS = 'funnels,web-development,sales';
  try {
    assert.deepEqual(hardHoldConfirmDepartments(), ['funnels', 'web-development', 'sales']);
    assert.equal(isHardHoldConfirmDepartment('sales'), true, 'operator-widened dept is honored');
    assert.equal(isHardHoldConfirmDepartment('marketing'), false, 'un-widened dept unaffected');
  } finally {
    delete process.env.HARD_HOLD_CONFIRM_DEPARTMENTS;
  }
});

// ── B. blockForOwnerConfirm ──────────────────────────────────────────────────

test('[block] sets status=blocked, block_audience=OWNER, writes one event, idempotent', () => {
  const id = nextId('block');
  insertTask(id, 'funnels');
  const gate = { hold: false, state: 'deadline_fallback' as const,
    reason: 'unconfirmed past deadline', audienceLabel: 'Founders', candidates: ['Founders'],
    prompt: 'Confirm the audience for this content task: "Founders".', firstHold: false };

  blockForOwnerConfirm(id, 'funnels', gate);
  blockForOwnerConfirm(id, 'funnels', gate); // second call must be a no-op (idempotent)

  const row = queryOne<{ status: string; block_audience: string | null; block_reason: string | null; block_needs: string | null }>(
    'SELECT status, block_audience, block_reason, block_needs FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(row?.status, 'blocked');
  assert.equal(row?.block_audience, 'OWNER');
  assert.ok(row?.block_reason && /HARD-HOLD/.test(row.block_reason));
  assert.ok(row?.block_needs && /Confirm the audience/.test(row.block_needs));

  const events = queryAll<{ id: string }>(
    "SELECT id FROM events WHERE task_id = ? AND type = 'audience_confirm_blocked_owner'",
    [id],
  );
  assert.equal(events.length, 1, 'exactly one block event even after a repeated call (idempotent)');
});

test('[block] never releases under house-voice — no confirm_state mutation, no deadline_fallback event', () => {
  const id = nextId('block-no-release');
  insertTask(id, 'funnels');
  persistPersonaBundle(id, bundle({ confirm_required: true }));

  const gate = evaluateAudienceConfirmGate(id, Date.now() + AUDIENCE_CONFIRM_DEADLINE_MS + 60_000);
  assert.equal(gate.state, 'deadline_fallback', 'sanity: past-deadline signal fires identically regardless of department');

  blockForOwnerConfirm(id, 'funnels', gate);

  const bundleRow = queryOne<{ confirm_state: string }>(
    'SELECT confirm_state FROM task_persona_bundle WHERE task_id = ?', [id],
  );
  assert.notEqual(bundleRow?.confirm_state, 'deadline_fallback',
    'blockForOwnerConfirm must NEVER flip confirm_state to deadline_fallback — that IS the house-voice release path this policy replaces');
  const fallbackEvents = queryAll<{ id: string }>(
    "SELECT id FROM events WHERE task_id = ? AND type = 'audience_confirm_deadline_fallback'", [id],
  );
  assert.equal(fallbackEvents.length, 0, 'no deadline_fallback event — the house-voice release never fired');

  const t = queryOne<{ status: string; persona_id: string | null; blend_directive: string | null }>(
    'SELECT status, persona_id, blend_directive FROM tasks WHERE id = ?', [id],
  );
  assert.equal(t?.status, 'blocked');
  assert.ok(!t?.blend_directive || !/neutral/i.test(t.blend_directive),
    'the directive was never neutralized-and-released the way the house-voice fallback does');
});

// ── C. POLICY SIMULATION — the exact branch task-dispatcher.ts runs ─────────

/** Mirrors task-dispatcher.ts's audience-confirm gate block at the
 * deadline_fallback branch point EXACTLY, so this test proves the real
 * dispatch-time POLICY without invoking autoDispatchTask's full
 * agent-claim/SSE/model-sovereignty machinery. */
function simulateDeadlineGate(taskId: string, department: string, nowMs: number): 'blocked_owner' | 'house_voice_released' | 'held' | 'proceed' {
  const gate = evaluateAudienceConfirmGate(taskId, nowMs);
  if (gate.hold) return 'held';
  if (gate.state === 'deadline_fallback') {
    if (isHardHoldConfirmDepartment(department)) {
      blockForOwnerConfirm(taskId, department, gate);
      return 'blocked_owner';
    }
    markAudienceDeadlineFallback(taskId);
    return 'house_voice_released';
  }
  return 'proceed';
}

test('[policy] ACCEPT (c): funnels-department task past deadline -> blocked, block_audience=OWNER, NEVER house-voice', () => {
  const id = nextId('policy-funnels');
  insertTask(id, 'funnels');
  persistPersonaBundle(id, bundle({ confirm_required: true }));

  const future = Date.now() + AUDIENCE_CONFIRM_DEADLINE_MS + 60_000;
  const outcome = simulateDeadlineGate(id, 'funnels', future);

  assert.equal(outcome, 'blocked_owner');
  const row = queryOne<{ status: string; block_audience: string | null }>(
    'SELECT status, block_audience FROM tasks WHERE id = ?', [id],
  );
  assert.equal(row?.status, 'blocked');
  assert.equal(row?.block_audience, 'OWNER');
  const bundleRow = queryOne<{ confirm_state: string }>(
    'SELECT confirm_state FROM task_persona_bundle WHERE task_id = ?', [id],
  );
  assert.equal(bundleRow?.confirm_state, 'pending', 'confirm_state never flips to deadline_fallback for a hard-hold department');
});

test('[policy] ACCEPT (c): web-development-department task past deadline -> also hard-held', () => {
  const id = nextId('policy-webdev');
  insertTask(id, 'web-development');
  persistPersonaBundle(id, bundle({ confirm_required: true }));

  const future = Date.now() + AUDIENCE_CONFIRM_DEADLINE_MS + 60_000;
  const outcome = simulateDeadlineGate(id, 'web-development', future);

  assert.equal(outcome, 'blocked_owner');
});

test('[policy] ACCEPT (c): a low-stakes department (marketing) STILL releases under house-voice at 30 min', () => {
  const id = nextId('policy-marketing');
  insertTask(id, 'marketing');
  persistPersonaBundle(id, bundle({ confirm_required: true }));

  const future = Date.now() + AUDIENCE_CONFIRM_DEADLINE_MS + 60_000;
  const outcome = simulateDeadlineGate(id, 'marketing', future);

  assert.equal(outcome, 'house_voice_released', 'unchanged pre-A-U4 behavior for non-build departments');
  const row = queryOne<{ status: string; block_audience: string | null }>(
    'SELECT status, block_audience FROM tasks WHERE id = ?', [id],
  );
  assert.notEqual(row?.status, 'blocked', 'a low-stakes department task is never blocked by this policy');
  assert.equal(row?.block_audience, null);
  const bundleRow = queryOne<{ confirm_state: string }>(
    'SELECT confirm_state FROM task_persona_bundle WHERE task_id = ?', [id],
  );
  assert.equal(bundleRow?.confirm_state, 'deadline_fallback');
});

test('[policy] NO-WEAKENING: within the deadline, a funnels task is HELD exactly like any other department (policy only changes what happens AFTER the deadline)', () => {
  const id = nextId('policy-funnels-early');
  insertTask(id, 'funnels');
  persistPersonaBundle(id, bundle({ confirm_required: true }));

  const outcome = simulateDeadlineGate(id, 'funnels', Date.now());
  assert.equal(outcome, 'held', 'the pending-hold phase is IDENTICAL across departments — only the post-deadline branch differs');
});
