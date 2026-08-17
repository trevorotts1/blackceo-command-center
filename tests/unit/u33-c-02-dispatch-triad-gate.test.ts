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

  // It never even attempted the gateway connection — GUARD 7 fires before that
  // step. TRIAD-PARK: the hold now ALSO records a failed advance attempt (that
  // accounting is the fix — without it the sweeps re-held this card forever), so
  // the original "zero deferred events" assertion is no longer the right way to
  // prove the gateway was never contacted. The reason string is: a triad hold
  // records `triad_incomplete`, and only code PAST GUARD 7 can record
  // `gateway_down`.
  const deferredEvents = eventsFor(taskId, 'task_dispatch_deferred');
  assert.equal(
    deferredEvents.filter((e) => /gateway_down/.test(e.message)).length,
    0,
    'a held card must never reach the gateway-connection attempt',
  );
  assert.equal(deferredEvents.length, 1, 'the hold records exactly one failed advance attempt');
  assert.match(deferredEvents[0].message, /triad_incomplete/, 'the recorded failure is classified as a Triad hold');
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

// ── (4) TRIAD-PARK: the hold must PARK, not re-loop forever ─────────────────
//
// The defect this covers: GUARD 7 used to `return` without recording the failed
// attempt, so neither the exponential backoff nor the attempt cap engaged and
// all three sweeps re-selected the same card every ~2 minutes. One production
// card accumulated 218 re-dispatches over ~6 days; four siblings burned 612
// attempts between them. Parking is the existing anti-furnace machinery — this
// class just reaches it after TRIAD_HOLD_MAX_ATTEMPTS (3) instead of never.

/** Simulate the backoff window elapsing, exactly as a later sweep tick would. */
function clearBackoff(id: string): void {
  run('UPDATE tasks SET next_dispatch_eligible_at = NULL WHERE id = ?', [id]);
}

function taskRow(id: string) {
  return queryOne<{
    status: string;
    dispatch_attempts: number | null;
    block_audience: string | null;
    blocked_notice_sent_at: string | null;
    next_dispatch_eligible_at: string | null;
  }>(
    `SELECT status, dispatch_attempts, block_audience, blocked_notice_sent_at, next_dispatch_eligible_at
       FROM tasks WHERE id = ?`,
    [id],
  );
}

test('[TRIAD-PARK a] a held card is PARKED to blocked after the small attempt cap, not re-looped', async () => {
  const sopId = (globalThis as Record<string, unknown>).__triadGateTestSopId as string;
  const taskId = 'task-triad-park';
  seedTask({ id: taskId, description: 'Groomed text but no SOP.', sopId: null, personaId: 'hormozi-100m-offers' });

  // Attempt 1: held, backoff stamped — and that backoff alone already stops the
  // every-2-minutes hammering (GUARD 6 skips until it elapses).
  await autoDispatchTask(taskId, 'test');
  const afterFirst = taskRow(taskId);
  assert.equal(afterFirst?.status, 'backlog', 'still on the board after one hold');
  assert.equal(afterFirst?.dispatch_attempts, 1, 'the hold records a failed advance attempt (the fix)');
  assert.ok(afterFirst?.next_dispatch_eligible_at, 'a backoff window is stamped, so sweeps skip it meanwhile');

  // Attempts 2 and 3, each after its backoff window elapsed.
  clearBackoff(taskId);
  await autoDispatchTask(taskId, 'test');
  clearBackoff(taskId);
  await autoDispatchTask(taskId, 'test');

  const parked = taskRow(taskId);
  assert.equal(parked?.status, 'blocked', 'parked out of the advance lane at the cap (3), not at 140+');
  assert.equal(parked?.dispatch_attempts, 3, 'parked after exactly TRIAD_HOLD_MAX_ATTEMPTS attempts');
});

test('[TRIAD-PARK b] parking emits exactly ONE system-audience notification', async () => {
  const taskId = 'task-triad-park'; // parked by the previous test
  const blockedEvents = eventsFor(taskId, 'task_blocked');
  assert.equal(blockedEvents.length, 1, 'exactly one block announcement, not one per sweep tick');
  assert.match(blockedEvents[0].message, /triad_incomplete/, 'the block names the Triad cause');

  const row = taskRow(taskId);
  assert.equal(row?.block_audience, 'SYSTEM', 'the block is an OPERATOR concern, never an owner-facing one');

  const snapshots = queryAll<{ block_audience: string | null }>(
    'SELECT block_audience FROM task_block_events WHERE task_id = ?',
    [taskId],
  );
  assert.equal(snapshots.length, 1, 'one block-history snapshot');
  assert.equal(snapshots[0].block_audience, 'SYSTEM');
});

test('[TRIAD-PARK d] parking has NO requester-facing side effect', () => {
  const taskId = 'task-triad-park';
  const row = taskRow(taskId);

  // The trust engine is the only path that messages a requester about a blocked
  // card, and it selects ONLY block_audience='OWNER' (jobs/trust-engine.ts
  // CANDIDATE_SQL). Asserting against that exact condition proves the parked
  // card is invisible to it — stronger than mocking the notifier.
  assert.notEqual(row?.block_audience, 'OWNER');
  const trustEngineWouldSelect = queryAll<{ id: string }>(
    `SELECT id FROM tasks WHERE id = ? AND status = 'blocked' AND block_audience = 'OWNER'`,
    [taskId],
  );
  assert.equal(trustEngineWouldSelect.length, 0, 'the trust engine must never select a Triad-parked card');
  assert.equal(row?.blocked_notice_sent_at, null, 'no blocked notice was ever sent to the requester');
});

test('[TRIAD-PARK c] a parked card is never re-selected, and neither is an archived one', async () => {
  const parkedId = 'task-triad-park';
  const holdsBefore = eventsFor(parkedId, 'triad_gate_hold').length;
  const deferredBefore = eventsFor(parkedId, 'task_dispatch_deferred').length;

  clearBackoff(parkedId);
  await autoDispatchTask(parkedId, 'test');

  assert.equal(
    eventsFor(parkedId, 'triad_gate_hold').length,
    holdsBefore,
    'a parked (blocked) card is skipped by GUARD 3 before the Triad gate is even reached',
  );
  assert.equal(
    eventsFor(parkedId, 'task_dispatch_deferred').length,
    deferredBefore,
    'a parked card accrues no further attempts — the furnace is out',
  );

  // Archived cards are likewise terminal for dispatch (GUARD 3, DISP-12).
  const sopId = (globalThis as Record<string, unknown>).__triadGateTestSopId as string;
  const archivedId = 'task-triad-archived';
  seedTask({ id: archivedId, description: null, sopId, personaId: 'hormozi-100m-offers' });
  run('UPDATE tasks SET archived_at = ? WHERE id = ?', [new Date().toISOString(), archivedId]);

  await autoDispatchTask(archivedId, 'test');

  assert.equal(eventsFor(archivedId, 'triad_gate_hold').length, 0, 'an archived card is never held or re-selected');
  assert.equal(eventsFor(archivedId, 'task_dispatch_deferred').length, 0, 'an archived card accrues no attempts');
});

test('[TRIAD-PARK] the hold log line is deduped — one per card per window, not one per sweep tick', async () => {
  const sopId = (globalThis as Record<string, unknown>).__triadGateTestSopId as string;
  const taskId = 'task-triad-dedupe';
  seedTask({ id: taskId, description: null, sopId, personaId: 'hormozi-100m-offers' });

  await autoDispatchTask(taskId, 'test');
  assert.equal(eventsFor(taskId, 'triad_gate_hold').length, 1, 'the first hold is always announced');

  // A second hold inside the dedupe window must NOT re-announce, even though the
  // attempt itself is still recorded. This is what stopped the log flood: the
  // observed card wrote 500 identical lines.
  clearBackoff(taskId);
  await autoDispatchTask(taskId, 'test');

  assert.equal(
    eventsFor(taskId, 'triad_gate_hold').length,
    1,
    'a repeat hold inside the window writes no second triad_gate_hold line',
  );
  assert.equal(
    taskRow(taskId)?.dispatch_attempts,
    2,
    'the attempt is still counted — dedupe silences the log, it does not skip the accounting',
  );
});
