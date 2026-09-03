/**
 * FLEET-01 — global agent-dispatch concurrency ceiling: auto-advance
 * (autoDispatchTask GUARD 9) integration coverage.
 *
 * See tests/unit/agent-dispatch-concurrency-limit.test.ts for the probe-level
 * unit coverage of the underlying checkDispatchConcurrencyLimit() primitive
 * and the fleet-safety rationale. This suite drives the REAL
 * `autoDispatchTask()` (src/lib/task-dispatcher.ts, GUARD 9) end to end,
 * proving the gate is wired correctly into the auto-advance path:
 *
 *   (1) [MANDATORY] env var UNSET → identical to today: even with the
 *       ceiling deeply oversubscribed, autoDispatchTask never holds — it
 *       reaches the gateway-connection attempt exactly as it always has.
 *   (2) ceiling=3, 3 in flight → a 4th Triad-complete card is HELD by GUARD 9
 *       — status unchanged (still in its intake lane), dispatch_attempts
 *       unchanged (no failure recorded, no backoff), and the gateway is NEVER
 *       contacted (proves GUARD 9 fires before the OpenClaw connect step).
 *   (3) one of the 3 in-flight tasks completes → the SAME held card, on its
 *       next autoDispatchTask call (the next sweep tick, in production),
 *       clears GUARD 9 and proceeds past it (proven the same way the rest of
 *       this suite family proves "cleared a gate": it reaches the
 *       gateway-connection attempt, recorded as a gateway_down deferred
 *       event — the technique u33-c-02-dispatch-triad-gate.test.ts already
 *       established, since no unit test in this repo drives a live
 *       chat.send).
 *   (4) the durable dispatch_concurrency_hold event is deduped across repeat
 *       holds within the log-interval window (same pattern as
 *       triad_gate_hold), so a card held every ~2-minute tick for hours does
 *       not flood the events table.
 *
 * Hermetic: OPENCLAW_GATEWAY_URL is a deliberately invalid URL — `new URL()`
 * throws synchronously in OpenClawClient.connect(), so a card that clears
 * every guard up to and including GUARD 9 fails its gateway connection
 * cheaply with zero open sockets/timers (identical setup to
 * u33-c-02-dispatch-triad-gate.test.ts).
 *
 *   node --import tsx --test tests/unit/agent-dispatch-concurrency-ceiling-auto.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fleet01-auto-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Deliberately invalid — see file header.
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

const AGENT_ID = 'agent-fleet01-auto';

test.before(async () => {
  const db: DbModule = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // run the full migration chain

  run(
    `INSERT INTO agents (id, name, role, is_master, workspace_id) VALUES (?, ?, ?, 0, NULL)`,
    [AGENT_ID, 'FLEET-01 Test Agent', 'specialist'],
  );

  const sopId = 'sop-fleet01-auto-test';
  run(
    `INSERT INTO sops (id, name, slug, steps, success_criteria, department)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sopId, 'FLEET-01 Test SOP', 'fleet01-auto-test-sop', 'Step 1.', 'Done.', 'general'],
  );
  (globalThis as Record<string, unknown>).__fleet01SopId = sopId;

  const dispatcher: DispatcherModule = await import('../../src/lib/task-dispatcher');
  autoDispatchTask = dispatcher.autoDispatchTask;
});

test.after(async () => {
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

test.beforeEach(() => {
  delete process.env.AGENT_DISPATCH_MAX_CONCURRENT;
  // The DB is shared across tests in this file (matching the rest of this
  // suite family's strategy). Retire any in_progress rows a PRIOR test left
  // behind so each test's in-flight count starts at a deterministic zero —
  // otherwise later tests would inherit earlier tests' in-flight fixtures and
  // the global ceiling would never look "freed". UPDATE (never DELETE) avoids
  // disturbing FK-dependent rows (events, task_activities) written by earlier
  // autoDispatchTask calls.
  run(`UPDATE tasks SET status = 'done' WHERE status = 'in_progress'`);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

let seedCounter = 0;

/** A Triad-complete backlog card (clears GUARD 7) assigned to the fixture agent. */
function seedTriadCompleteTask(id: string): void {
  const sopId = (globalThis as Record<string, unknown>).__fleet01SopId as string;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks
       (id, title, description, status, priority, assigned_agent_id, workspace_id, business_id,
        sop_id, persona_id, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', ?, NULL, NULL, ?, ?, ?, ?)`,
    [
      id, `Task ${id}`, 'A fully-groomed FLEET-01 test task.', AGENT_ID,
      sopId, 'hormozi-100m-offers', now, now,
    ],
  );
}

/** A bare in_progress task occupying a global concurrency slot. */
function seedInFlightTask(id: string): string {
  const taskId = id ?? `fleet01-inflight-${seedCounter++}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'seed', 'in_progress', 'high', NULL, NULL, ?, ?)`,
    [taskId, `In-flight ${taskId}`, now, now],
  );
  return taskId;
}

function eventsFor(id: string, type: string) {
  return queryAll<{ message: string; created_at: string }>(
    'SELECT message, created_at FROM events WHERE task_id = ? AND type = ? ORDER BY created_at',
    [id, type],
  );
}

function taskRow(id: string) {
  return queryOne<{ status: string; dispatch_attempts: number | null }>(
    `SELECT status, dispatch_attempts FROM tasks WHERE id = ?`,
    [id],
  );
}

function gatewayDownEvents(id: string) {
  return eventsFor(id, 'task_dispatch_deferred').filter((e) => /gateway_down/.test(e.message));
}

// ── (1) MANDATORY: env unset → identical to today, any load ─────────────────

test('[FLEET-01 mandatory] env var UNSET: autoDispatchTask never holds on concurrency, even deeply oversubscribed', async () => {
  delete process.env.AGENT_DISPATCH_MAX_CONCURRENT;
  // 10 tasks "in flight" — no plausible fleet box configures a ceiling this
  // low, and yet with the env var unset it must not matter at all.
  for (let i = 0; i < 10; i++) seedInFlightTask(`fleet01-unset-inflight-${seedCounter++}`);

  const taskId = `fleet01-unset-mover-${seedCounter++}`;
  seedTriadCompleteTask(taskId);

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  assert.equal(
    eventsFor(taskId, 'dispatch_concurrency_hold').length,
    0,
    'with the env var unset, GUARD 9 must never fire — zero dispatch_concurrency_hold events',
  );
  assert.ok(
    gatewayDownEvents(taskId).length >= 1,
    'the card must reach the gateway-connection attempt exactly as it always has (proves GUARD 9 is a pass-through when unset)',
  );
});

// ── (2) ceiling=3, 3 in flight → 4th HELD, intake lane, not failed/blocked ──

test('[FLEET-01] ceiling=3 with 3 in flight: a 4th Triad-complete card is HELD — status/attempts untouched, gateway never contacted', async () => {
  process.env.AGENT_DISPATCH_MAX_CONCURRENT = '3';
  for (let i = 0; i < 3; i++) seedInFlightTask(`fleet01-c3-inflight-${seedCounter++}`);

  const taskId = `fleet01-c3-held-${seedCounter++}`;
  seedTriadCompleteTask(taskId);

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  const row = taskRow(taskId);
  assert.equal(row?.status, 'backlog', 'a capacity-held card stays in its current lane — no status change');
  assert.equal(
    row?.dispatch_attempts ?? 0,
    0,
    'a capacity hold must NEVER record a dispatch attempt (no accounting, no backoff, no risk of hardBlock)',
  );

  const holdEvents = eventsFor(taskId, 'dispatch_concurrency_hold');
  assert.equal(holdEvents.length, 1, 'exactly one durable, queryable dispatch_concurrency_hold event');
  assert.match(holdEvents[0].message, /3\/3/, 'the hold event names the exact in-flight\/ceiling counts');

  assert.equal(
    gatewayDownEvents(taskId).length,
    0,
    'GUARD 9 must hold BEFORE the OpenClaw connect step — the gateway is never contacted',
  );

  // Never marked failed/blocked/errored by any OTHER mechanism either.
  assert.notEqual(row?.status, 'blocked');
});

// ── (3) one completes → the held card proceeds past GUARD 9 next tick ──────

test('[FLEET-01] freeing one slot lets the previously-held card clear GUARD 9 on its next autoDispatchTask call', async () => {
  process.env.AGENT_DISPATCH_MAX_CONCURRENT = '3';
  const inflight = [
    seedInFlightTask(`fleet01-c3b-inflight-${seedCounter++}`),
    seedInFlightTask(`fleet01-c3b-inflight-${seedCounter++}`),
    seedInFlightTask(`fleet01-c3b-inflight-${seedCounter++}`),
  ];

  const taskId = `fleet01-c3b-held-then-cleared-${seedCounter++}`;
  seedTriadCompleteTask(taskId);

  // First tick: held (mirrors case 2). The hold itself records NO attempt.
  await autoDispatchTask(taskId, 'test');
  assert.equal(taskRow(taskId)?.status, 'backlog');
  assert.equal(gatewayDownEvents(taskId).length, 0, 'held on the first tick — gateway not yet contacted');
  assert.equal(taskRow(taskId)?.dispatch_attempts ?? 0, 0, 'the capacity hold itself records zero dispatch attempts');

  // A slot frees — exactly what the agent-completion webhook does when an
  // in-flight task finishes.
  run(`UPDATE tasks SET status = 'done' WHERE id = ?`, [inflight[0]]);

  // Second tick (simulated): the SAME card, called again — clears GUARD 9 and
  // proceeds to the (hermetically-failing) gateway connection attempt. That
  // subsequent gateway_down failure legitimately records ITS OWN attempt via
  // the pre-existing recordDispatchFailure path further down the function —
  // unrelated to GUARD 9, and proof positive the card is no longer held.
  await autoDispatchTask(taskId, 'test');
  assert.ok(
    gatewayDownEvents(taskId).length >= 1,
    'once a slot frees, the next autoDispatchTask call for the held card must clear GUARD 9 and reach the gateway-connection step',
  );
  assert.equal(
    eventsFor(taskId, 'dispatch_concurrency_hold').length,
    1,
    'still only the ONE hold event from the first (held) tick — the second tick cleared the gate, so no second hold',
  );
});

// ── (4) the durable hold event is deduped, not one row per tick ────────────

test('[FLEET-01] the dispatch_concurrency_hold event is deduped across repeat holds inside the log window', async () => {
  process.env.AGENT_DISPATCH_MAX_CONCURRENT = '3';
  process.env.DISPATCH_CONCURRENCY_HOLD_LOG_INTERVAL_SECONDS = '3600'; // wide window for this test
  try {
    for (let i = 0; i < 3; i++) seedInFlightTask(`fleet01-dedupe-inflight-${seedCounter++}`);

    const taskId = `fleet01-dedupe-held-${seedCounter++}`;
    seedTriadCompleteTask(taskId);

    await autoDispatchTask(taskId, 'test');
    assert.equal(eventsFor(taskId, 'dispatch_concurrency_hold').length, 1, 'first hold is always announced');

    // Repeat calls inside the window (simulating repeated sweep ticks at
    // capacity) must not write a second durable event row.
    await autoDispatchTask(taskId, 'test');
    await autoDispatchTask(taskId, 'test');

    assert.equal(
      eventsFor(taskId, 'dispatch_concurrency_hold').length,
      1,
      'repeat holds inside the dedupe window must not flood the events table',
    );
    // Still no attempt accounting across any of the repeats.
    assert.equal(taskRow(taskId)?.dispatch_attempts ?? 0, 0);
  } finally {
    delete process.env.DISPATCH_CONCURRENCY_HOLD_LOG_INTERVAL_SECONDS;
  }
});
