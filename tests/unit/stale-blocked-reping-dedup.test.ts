/**
 * stale-blocked-reping-dedup.test.ts — SWEEP-DEDUP.
 *
 * THE INCIDENT this pins: the stale sweep runs on a `* /10 * * * *` cron, but the
 * blocked re-ping window is 72h wide and the blocked branch had NO dedup guard. So
 * every operator-blocked task past the 72h threshold re-escalated on EVERY tick —
 * 6/hour/task, for the entire 72h→144h window. A live board with 71 such tasks
 * produced ~426 escalations/hour and buried the escalation channel in hundreds of
 * identical messages (and ~99k `stale_repinged` event rows). Worse, the operator
 * branch wrote NO dedupable key at all, so there was nothing to dedupe against.
 *
 * These tests count REAL escalations end-to-end: a local HTTP server stands in for
 * the escalation webhook (operator) and the Command Center's /api/events (owner), so
 * we assert on messages that ACTUALLY left the process, not on an internal counter.
 *
 * The contract, in both directions:
 *   CAP    — N ticks over the same stuck task ⇒ AT MOST ONE escalation per window.
 *   ANTI-  — but a still-stuck task MUST escalate again on the NEXT window, and the
 *   SILENCE  dedup guard MUST FAIL OPEN: if its query throws, the escalation goes
 *            through anyway. Dedup may cost a duplicate; it may never cost silence.
 *
 *   node --import tsx --test tests/unit/stale-blocked-reping-dedup.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1'; // RUNG 2 (operator Telegram) off — webhook only.
delete process.env.DISABLE_STALE_TASK_SWEEP;
delete process.env.STALE_REPING_DEDUP_HOURS; // exercise the 24h default

import './_isolated-db'; // MUST be first.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne } from '../../src/lib/db';
import { runStaleTaskSweep } from '../../src/lib/jobs/stale-task-sweep';

// ── The escalation sink: every message that actually leaves the process ──────────
let server: http.Server;
/** POSTs to the Rescue-Rangers-style webhook — the OPERATOR escalation path. */
let operatorEscalations: string[] = [];
/** POSTs to the Command Center /api/events — the OWNER re-ping path. */
let ownerEscalations: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url?.startsWith('/rescue')) operatorEscalations.push(body);
      else if (req.url?.startsWith('/api/events')) ownerEscalations.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.RESCUE_RANGERS_WEBHOOK_URL = `http://127.0.0.1:${port}/rescue`;
  process.env.MISSION_CONTROL_URL = `http://127.0.0.1:${port}`;
  // SAFETY-06 (PR #176) gates the operator escalation webhook off in a test run so
  // no suite can POST to a LIVE endpoint by omission. This suite's whole point is to
  // COUNT that operator escalation — and it has already pointed the webhook at its
  // OWN 127.0.0.1 sink above, so opting in here can only ever reach that capture
  // server. Telegram stays muted (OWNER_NOTIFY_TELEGRAM_DISABLED, set suite-wide by
  // tests/setup/no-owner-telegram.ts and re-asserted here so this file is safe run
  // directly). Without the opt-in the webhook never fires and every CAP/anti-silence
  // assertion measures 0 escalations.
  process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
});

after(async () => {
  delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
  delete process.env.MISSION_CONTROL_URL;
  delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  operatorEscalations = [];
  ownerEscalations = [];
});

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

/**
 * A blocked task past the 72h re-ping threshold but short of the 144h return
 * threshold — i.e. sitting squarely in the window that used to re-fire every tick.
 * A non-empty `ask` is supplied because F3's migration-104 invariant now REJECTS a
 * blocked_on_human row with an empty ask (the unanswerable poison state). The ask
 * content is irrelevant to what this suite proves — dedup caps the re-ping
 * regardless of ask text — it exists only so the fixture satisfies the DB invariant.
 */
function seedBlockedTask(who: 'operator' | 'owner', ageHours = 80): string {
  const id = uuidv4();
  // tasks.workspace_id defaults to 'default' and REFERENCES workspaces(id), so an
  // isolated DB needs a real workspace row or the INSERT trips the FK.
  const wsId = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [
    wsId,
    'operations',
    `operations-${uuidv4().slice(0, 8)}`,
  ]);
  // blocked_reason is CHECK-constrained to ('decision','approval','credential','payment').
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, blocked_on_human, blocked_reason, ask, updated_at, last_progress_at)
     VALUES (?, ?, 'blocked', ?, ?, 'decision', 'Awaiting a human decision (fixture)', ?, ?)`,
    [id, `Blocked task ${id.slice(0, 8)}`, wsId, who, hoursAgo(ageHours), hoursAgo(ageHours)],
  );
  return id;
}

/**
 * Escalations that actually left the process FOR THIS TASK. Scoped by task id
 * because the isolated DB persists across tests in this file — a global count
 * would also pick up still-blocked tasks seeded by earlier tests.
 */
function escalationsFor(taskId: string, sink: string[]): number {
  return sink.filter((body) => body.includes(taskId)).length;
}

function repingEventCount(taskId: string): number {
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events
      WHERE task_id = ? AND type IN ('stale_repinged', 'stale_blocked_repinged')`,
    [taskId],
  );
  return row?.n ?? 0;
}

/**
 * notifySystem() fire-and-forgets its POST (`void fetch`), so give the in-flight
 * request a moment to land before counting. Polls rather than sleeping blind.
 */
async function settle(expected: number, sink: () => string[], timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (sink().length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  // One extra beat so a SURPLUS (the bug) also has time to arrive and be counted —
  // otherwise an over-firing sweep could pass by racing the assertion.
  await new Promise((r) => setTimeout(r, 120));
}

// ── THE REGRESSION TEST ─────────────────────────────────────────────────────────
// This is the acceptance criterion for the whole incident. It FAILS on pre-fix code
// (which escalates once per task PER TICK: 3 tasks × 6 ticks = 18 messages).
test('CAP: N operator-blocked tasks × 6 cron ticks ⇒ ONE escalation each, not one per tick', async () => {
  const taskIds = [seedBlockedTask('operator'), seedBlockedTask('operator'), seedBlockedTask('operator')];

  // A deliverable on one of them: the sweep must never destroy real work-product.
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description)
     VALUES (?, ?, 'file', ?, ?, ?)`,
    [uuidv4(), taskIds[0], 'Real work product', '/tmp/not-needed.md', 'produced by a dispatched agent'],
  );

  // Six ticks of the */10 cron == one hour of real time on the live box.
  const TICKS = 6;
  const repingedPerTick: number[] = [];
  for (let i = 0; i < TICKS; i++) {
    const result = await runStaleTaskSweep();
    repingedPerTick.push(result.repinged);
  }
  await settle(taskIds.length, () => operatorEscalations);

  for (const id of taskIds) {
    assert.equal(
      escalationsFor(id, operatorEscalations),
      1,
      `task ${id} escalated ${escalationsFor(id, operatorEscalations)}× over ${TICKS} ticks — ` +
        `it must escalate exactly ONCE per window (pre-fix: ${TICKS}× — the flood)`,
    );
    assert.equal(repingEventCount(id), 1, `exactly one dedup key row written for ${id}`);
  }
  assert.equal(
    operatorEscalations.length,
    taskIds.length,
    `${taskIds.length} tasks × ${TICKS} ticks ⇒ ${taskIds.length} escalations total, not ${taskIds.length * TICKS}`,
  );
  assert.equal(repingedPerTick[0], taskIds.length, 'the first tick re-pings all three');
  assert.deepEqual(
    repingedPerTick.slice(1),
    [0, 0, 0, 0, 0],
    'every subsequent tick is deduped to zero — this is the line that fails pre-fix',
  );

  // ARCHIVE-never-DELETE: the sweep must not have destroyed tasks or their work.
  for (const id of taskIds) {
    const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id]);
    assert.equal(task?.status, 'blocked', 'the task itself is untouched — deduping is not deleting');
  }
  const deliverables = queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM task_deliverables WHERE task_id = ?',
    [taskIds[0]],
  );
  assert.equal(deliverables?.n, 1, 'the real work-product on a blocked task survives the sweep');
});

// ── (c) the dedup key is written on BOTH branches, not just the operator one ─────
test('CAP: the OWNER branch is deduped too (the audit INSERT is shared by both paths)', async () => {
  const taskId = seedBlockedTask('owner');

  for (let i = 0; i < 4; i++) await runStaleTaskSweep();
  await settle(1, () => ownerEscalations);

  assert.equal(repingEventCount(taskId), 1, 'the owner branch writes exactly one dedup key across 4 ticks');
  assert.equal(
    escalationsFor(taskId, ownerEscalations),
    1,
    `owner re-ping fires once, not once per tick — got ${escalationsFor(taskId, ownerEscalations)}`,
  );
  assert.equal(
    escalationsFor(taskId, operatorEscalations),
    0,
    'an owner-blocked task never escalates to the operator channel',
  );
});

// ── ANTI-SILENCE #1: a cap is not a mute ────────────────────────────────────────
test('ANTI-SILENCE: a still-stuck task escalates AGAIN on the next window', async () => {
  const taskId = seedBlockedTask('operator');

  await runStaleTaskSweep();
  await settle(1, () => operatorEscalations);
  assert.equal(escalationsFor(taskId, operatorEscalations), 1, 'window 1: the stuck task reaches a human');

  // Immediately re-sweeping is deduped...
  await runStaleTaskSweep();
  await settle(1, () => operatorEscalations);
  assert.equal(escalationsFor(taskId, operatorEscalations), 1, 'still within the window: no duplicate');

  // ...but once the window has passed (dedup key ages out beyond 24h), the task is
  // STILL stuck, and a stuck task MUST keep reaching a human.
  run(`UPDATE events SET created_at = ? WHERE task_id = ?`, [hoursAgo(25), taskId]);

  await runStaleTaskSweep();
  await settle(2, () => operatorEscalations);
  assert.equal(
    escalationsFor(taskId, operatorEscalations),
    2,
    'window 2: the task is still stuck, so it escalates again — dedup CAPS, it never MUTES',
  );
});

// ── ANTI-SILENCE #2: the guard fails OPEN ───────────────────────────────────────
test('ANTI-SILENCE: the dedup guard FAILS OPEN — a throwing query escalates anyway', async () => {
  const taskId = seedBlockedTask('operator');

  // Tick 1: escalates and writes the dedup key.
  await runStaleTaskSweep();
  await settle(1, () => operatorEscalations);
  assert.equal(escalationsFor(taskId, operatorEscalations), 1, 'baseline: one escalation');
  assert.equal(repingEventCount(taskId), 1, 'baseline: dedup key written');

  // Tick 2: suppressed by the dedup key — this is the escalation we are about to
  // prove CANNOT be lost to a query error.
  await runStaleTaskSweep();
  await settle(1, () => operatorEscalations);
  assert.equal(escalationsFor(taskId, operatorEscalations), 1, 'tick 2 is deduped away');

  // Now break the dedup query underneath the guard: no `events` table ⇒
  // wasRecentlyRepinged() throws. It MUST fail open and escalate regardless.
  run(`ALTER TABLE events RENAME TO events_failopen_probe`);
  try {
    await runStaleTaskSweep();
    await settle(2, () => operatorEscalations);
    assert.equal(
      escalationsFor(taskId, operatorEscalations),
      2,
      'the dedup query threw — the escalation MUST still go through (fail-open), never be swallowed',
    );
  } finally {
    run(`ALTER TABLE events_failopen_probe RENAME TO events`);
  }
});
