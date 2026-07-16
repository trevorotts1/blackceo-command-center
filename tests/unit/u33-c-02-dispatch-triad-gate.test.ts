/**
 * u33-c-02-dispatch-triad-gate.test.ts — skill6-v2 U33 / C-02 (part 2).
 *
 * `autoDispatchTask`'s new GUARD 7 (gate-consistency pin): the automatic
 * advancer must honor the SAME Triad gate the UI PATCH path already enforces
 * (checkTriad, src/lib/sops.ts:432) before claiming a card — closing the
 * asymmetry the master spec records (C+I.0 point 4): the UI PATCH blocks a
 * Triad-incomplete card from leaving Backlog while the pre-U33 CAS claim
 * (DISP-02, task-dispatcher.ts) did not care.
 *
 * Coverage (BINARY acceptance (b)):
 *   (1) a fixture card with an empty description is NOT claimable — it is
 *       HELD with a queryable `triad_gate_hold` event, and never reaches the
 *       gateway-connection step at all;
 *   (2) a Triad-complete card is NEVER held by this gate — it clears GUARD 7
 *       and proceeds to the next pipeline stage (the gateway connection
 *       attempt), proven by the `task_dispatch_deferred` (`gateway_down`)
 *       event that ONLY the code past GUARD 7 can write. This is the same
 *       "prove it reached the next stage" technique
 *       `phantom-agent-dispatch-heal.test.ts` and
 *       `point6-backlog-redispatch-cap.test.ts` already use in this suite —
 *       no unit test in this codebase drives `autoDispatchTask` through a
 *       live `chat.send` (that requires a real signed-handshake OpenClaw
 *       gateway connection with no mock precedent anywhere in this repo);
 *       the DISP-02 CAS claim itself is pre-existing, unmodified code whose
 *       own correctness this unit does not touch — U33 only proves its NEW
 *       gate correctly discriminates complete vs. incomplete Triads;
 *   (3) the TRIAD_ADVANCER_GATE=0 kill switch restores the pre-U33 bypass.
 *
 * Hermetic: OPENCLAW_GATEWAY_URL is a deliberately invalid URL, matching
 * point6-backlog-redispatch-cap.test.ts — `new URL()` throws synchronously in
 * OpenClawClient.connect(), so no socket / timer is ever opened.
 *
 *   node --import tsx --test tests/unit/u33-c-02-dispatch-triad-gate.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-triad-gate-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Deliberately invalid — `new URL(this.url)` in OpenClawClient.connect()
// throws synchronously, so a task that clears GUARD 7 fails its gateway
// connection cheaply with zero open sockets/timers.
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type DispatcherModule = typeof import('../../src/lib/task-dispatcher');
let autoDispatchTask: DispatcherModule['autoDispatchTask'];

const AGENT_ID = 'agent-triad-gate';

test.before(async () => {
  const db: DbModule = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // run the full migration chain

  // A non-master specialist agent (workspace_id NULL → no FK dependency,
  // matching point6-backlog-redispatch-cap.test.ts's minimal-fixture style).
  run(
    `INSERT INTO agents (id, name, role, is_master, workspace_id) VALUES (?, ?, ?, 0, NULL)`,
    [AGENT_ID, 'Triad Gate Test Agent', 'specialist'],
  );

  const sopId = 'sop-triad-gate-test';
  run(
    `INSERT INTO sops (id, name, slug, steps, success_criteria, department)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sopId, 'Triad Gate Test SOP', 'triad-gate-test-sop', 'Step 1.', 'Done.', 'general'],
  );
  (globalThis as Record<string, unknown>).__triadGateTestSopId = sopId;

  const dispatcher: DispatcherModule = await import('../../src/lib/task-dispatcher');
  autoDispatchTask = dispatcher.autoDispatchTask;
});

test.after(async () => {
  // Matches the rest of this suite's convention: close the OpenClaw client's
  // shared, non-unref'd periodic timer so the process can exit cleanly.
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try {
    const g = globalThis as Record<string, NodeJS.Timeout | undefined>;
    const timer = g['__openclaw_cache_cleanup_timer__'];
    if (timer) { clearInterval(timer); delete g['__openclaw_cache_cleanup_timer__']; }
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedTask(opts: {
  id: string;
  description: string | null;
  sopId: string | null;
  personaId: string | null;
}): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks
       (id, title, description, status, priority, assigned_agent_id, workspace_id, business_id,
        sop_id, persona_id, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', ?, NULL, NULL, ?, ?, ?, ?)`,
    [opts.id, `Task ${opts.id}`, opts.description, AGENT_ID, opts.sopId, opts.personaId, now, now],
  );
}

function eventsFor(id: string, type: string) {
  return queryAll<{ message: string }>(
    'SELECT message FROM events WHERE task_id = ? AND type = ? ORDER BY created_at',
    [id, type],
  );
}

function taskStatus(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

// ── (1) Triad-incomplete: NOT claimable, loud hold ──────────────────────────

test('[U33/C-02 b] empty-description task is NOT claimable — held with a queryable triad_gate_hold event', async () => {
  const sopId = (globalThis as Record<string, unknown>).__triadGateTestSopId as string;
  const taskId = 'task-triad-empty-desc';
  seedTask({ id: taskId, description: null, sopId, personaId: 'hormozi-100m-offers' });

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  assert.equal(taskStatus(taskId), 'backlog', 'a Triad-incomplete card must never be claimed (status unchanged)');

  const holdEvents = eventsFor(taskId, 'triad_gate_hold');
  assert.equal(holdEvents.length, 1, 'exactly one triad_gate_hold event must be written');
  assert.match(holdEvents[0].message, /Missing: description/, 'names the missing field via board-labels vocabulary');

  // It never even attempted the gateway connection — GUARD 7 fires before
  // that step, so no gateway_down deferred-attempt event exists either.
  const deferredEvents = eventsFor(taskId, 'task_dispatch_deferred');
  assert.equal(deferredEvents.length, 0, 'a held card must never reach the gateway-connection attempt');
});

test('[U33/C-02] a card missing ONLY its persona is also held, naming just that field', async () => {
  const sopId = (globalThis as Record<string, unknown>).__triadGateTestSopId as string;
  const taskId = 'task-triad-no-persona';
  seedTask({ id: taskId, description: 'A real description of the work.', sopId, personaId: null });

  await autoDispatchTask(taskId, 'test');

  assert.equal(taskStatus(taskId), 'backlog');
  const holdEvents = eventsFor(taskId, 'triad_gate_hold');
  assert.equal(holdEvents.length, 1);
  assert.match(holdEvents[0].message, /Missing: persona/);
});

// ── (2) Triad-complete: NOT held — proceeds past GUARD 7 ────────────────────

test('[U33/C-02 b] a Triad-complete card is never held — it clears GUARD 7 and reaches the gateway-connection step', async () => {
  const sopId = (globalThis as Record<string, unknown>).__triadGateTestSopId as string;
  const taskId = 'task-triad-complete';
  seedTask({
    id: taskId,
    description: 'A fully-groomed task with everything the Triad requires.',
    sopId,
    personaId: 'hormozi-100m-offers',
  });

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  // Zero triad_gate_hold events — the gate did NOT fire for this card.
  assert.equal(eventsFor(taskId, 'triad_gate_hold').length, 0, 'a Triad-complete card must never be held by GUARD 7');

  // Proof it advanced PAST GUARD 7: the invalid gateway URL makes connect()
  // fail synchronously, recorded as a gateway_down deferred-attempt event —
  // a code path ONLY reachable once GUARD 7 has let the task through.
  const deferredEvents = eventsFor(taskId, 'task_dispatch_deferred');
  assert.ok(deferredEvents.length >= 1, 'must reach the gateway-connection attempt (proves GUARD 7 cleared)');
  assert.match(deferredEvents[0].message, /gateway_down/, 'the deferred attempt is specifically a gateway_down failure');
});

// ── (3) Kill switch ──────────────────────────────────────────────────────────

test('[U33/C-02] TRIAD_ADVANCER_GATE=0 restores the pre-U33 bypass (no hold, even Triad-incomplete)', async () => {
  const taskId = 'task-triad-killswitch';
  seedTask({ id: taskId, description: null, sopId: null, personaId: null });

  process.env.TRIAD_ADVANCER_GATE = '0';
  try {
    await autoDispatchTask(taskId, 'test');
  } finally {
    delete process.env.TRIAD_ADVANCER_GATE;
  }

  assert.equal(eventsFor(taskId, 'triad_gate_hold').length, 0, 'the kill switch must fully disable the gate');
  // It must have proceeded past where GUARD 7 would have held it, same proof
  // technique as the positive-path test above.
  assert.ok(
    eventsFor(taskId, 'task_dispatch_deferred').length >= 1,
    'with the gate disabled, even a Triad-incomplete card reaches the gateway-connection step (pre-U33 behavior)',
  );
});
