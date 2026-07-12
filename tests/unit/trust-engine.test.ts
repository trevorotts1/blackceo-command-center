/**
 * P1-04 — Trust engine planner + executor tests (the report-back loop).
 *
 * FAIL-FIRST: against the pre-P1-04 tree src/lib/jobs/trust-engine.ts does not
 * exist, so the import fails and every test errors. With the fix they pass.
 *
 * These are the P1-04 QC break-it probes rendered as real, failable tests:
 *   • a task stalled in backlog gets the HONEST queued-ack, never silence;
 *   • a task completed with NO deliverable gets the flagged honest message, never
 *     a fabricated location, and the QC smell is escalated to the operator lane;
 *   • a crash between claim and send produces NO duplicate on the resweep (the
 *     durable stamp is the sole idempotency guard);
 *   • no message is ever targeted at a SYSTEM/operator-internal chat;
 *   • quiet-hours hold; digest coalescing; blocked-on-owner ask reaches the client.
 *
 * The planner (planSends) is pure and is tested directly. The executor
 * (executeSends / runTrustEngineSweep) is tested against an isolated DB so the
 * claim-then-send idempotency is exercised for real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKLOG_COLUMN_SUBTITLE } from '../../src/lib/board-labels';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-trust-engine-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

type DbModule = typeof import('../../src/lib/db');
type EngineModule = typeof import('../../src/lib/jobs/trust-engine');

let db: DbModule;
let engine: EngineModule;

function mkTask(over: Partial<import('../../src/lib/jobs/trust-engine').TrustTaskRow>): import('../../src/lib/jobs/trust-engine').TrustTaskRow {
  return {
    id: over.id ?? 'task-x',
    title: over.title ?? 'Sample task',
    status: over.status ?? 'backlog',
    department: over.department ?? 'sales',
    assigned_agent_name: over.assigned_agent_name ?? null,
    created_at: over.created_at ?? new Date().toISOString(),
    requester_channel: 'requester_channel' in over ? (over.requester_channel ?? null) : 'telegram',
    requester_chat_id: 'requester_chat_id' in over ? (over.requester_chat_id ?? null) : '12345',
    ack_sent_at: over.ack_sent_at ?? null,
    progress_last_sent_at: over.progress_last_sent_at ?? null,
    completion_sent_at: over.completion_sent_at ?? null,
    block_audience: over.block_audience ?? null,
    block_needs: over.block_needs ?? null,
  };
}

// Constructed in LOCAL time (no 'Z') so isQuietHour()'s getHours() is deterministic
// regardless of the CI box timezone: 15:00 is never quiet, 04:00 always is.
const DAYTIME = new Date(2026, 6, 11, 15, 0, 0);
const NIGHT = new Date(2026, 6, 11, 4, 0, 0);
const noDeliverable = () => null;

test.before(async () => {
  db = await import('../../src/lib/db');
  engine = await import('../../src/lib/jobs/trust-engine');
  db.getDb();

  // tasks.workspace_id DEFAULTs to 'default' with a FK to workspaces(id); seed a
  // matching company + workspace so the executor-test inserts satisfy the FK.
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('default', 'Default', 'default', 'Default ws', '📁', 'default', 0, ?, ?)`,
    [now, now],
  );
});

test.after(() => {
  try { db.closeDb(); } catch { /* ignore */ }
});

// ── PLANNER: ACK honesty ─────────────────────────────────────────────────────

test('ACK: a task stalled in backlog past the grace window gets the HONEST queued-ack (not silence)', () => {
  const old = new Date(DAYTIME.getTime() - 11 * 60 * 1000).toISOString(); // 11 min old, still backlog
  const plans = engine.planSends([mkTask({ id: 't1', status: 'backlog', created_at: old })], {
    now: DAYTIME,
    deliverableFor: noDeliverable,
  });
  assert.equal(plans.length, 1, 'a stalled-backlog task must still be acknowledged');
  assert.match(plans[0].message, /queued for grooming/i);
  assert.equal(plans[0].stamps[0].guardColumn, 'ack_sent_at');
  assert.equal(plans[0].stamps[0].eventType, 'trust_ack');
});

test('P2-01 step 3: the backlog-parked ACK uses the SAME honest "being prepared" language as the board', () => {
  const old = new Date(DAYTIME.getTime() - 11 * 60 * 1000).toISOString();
  const plans = engine.planSends([mkTask({ id: 't1b', status: 'backlog', created_at: old })], {
    now: DAYTIME,
    deliverableFor: noDeliverable,
  });
  assert.equal(plans.length, 1);
  // The exact operator-specified explainer (src/lib/board-labels.ts) must be
  // reused verbatim here, not paraphrased — a single source of truth so the
  // board's hover subtitle and the trust-engine message can never drift.
  assert.ok(
    plans[0].message.includes(BACKLOG_COLUMN_SUBTITLE),
    `expected the ACK to include the shared BACKLOG_COLUMN_SUBTITLE copy, got: ${plans[0].message}`,
  );
  assert.match(plans[0].message, /queued for grooming/i, 'still the pre-existing honest phrase');
});

test('ACK: a fresh backlog task inside the grace window is NOT acked yet (avoids premature noise)', () => {
  const fresh = new Date(DAYTIME.getTime() - 60 * 1000).toISOString(); // 1 min old
  const plans = engine.planSends([mkTask({ id: 't2', status: 'backlog', created_at: fresh })], {
    now: DAYTIME,
    deliverableFor: noDeliverable,
  });
  assert.equal(plans.length, 0, 'a fresh backlog task must wait for the grace window');
});

test('ACK: a task advanced past backlog gets the assigned-to-department ack', () => {
  const plans = engine.planSends(
    [mkTask({ id: 't3', status: 'assigned', department: 'sales', assigned_agent_name: 'Candace' })],
    { now: DAYTIME, deliverableFor: noDeliverable },
  );
  assert.equal(plans.length, 1);
  assert.match(plans[0].message, /assigned to the sales department/i);
  assert.match(plans[0].message, /Candace/);
});

test('no requester_chat_id => never reported on', () => {
  const plans = engine.planSends(
    [mkTask({ id: 't4', status: 'done', requester_chat_id: null })],
    { now: DAYTIME, deliverableFor: noDeliverable },
  );
  assert.equal(plans.length, 0);
});

// ── PLANNER: PROGRESS + ETA, BLOCKED ─────────────────────────────────────────

test('PROGRESS: first in_progress touch sends progress + a coarse ETA, stamps eta_estimate', () => {
  const plans = engine.planSends(
    [mkTask({ id: 't5', status: 'in_progress', department: 'presentations', assigned_agent_name: 'Deck Bot' })],
    { now: DAYTIME, deliverableFor: noDeliverable },
  );
  assert.equal(plans.length, 1);
  assert.match(plans[0].message, /in progress with Deck Bot/i);
  assert.match(plans[0].message, /Estimated completion:/i);
  assert.equal(plans[0].stamps[0].guardColumn, 'progress_last_sent_at');
  assert.equal(plans[0].stamps[0].extraSets.eta_estimate, engine.etaForDepartment('presentations'));
});

test('BLOCKED on OWNER: the client is told what is needed (the ask that never reached anyone)', () => {
  const plans = engine.planSends(
    [mkTask({ id: 't6', status: 'blocked', block_audience: 'OWNER', block_needs: 'the Q3 revenue figure' })],
    { now: DAYTIME, deliverableFor: noDeliverable },
  );
  assert.equal(plans.length, 1);
  assert.match(plans[0].message, /waiting on you/i);
  assert.match(plans[0].message, /the Q3 revenue figure/);
  assert.equal(plans[0].stamps[0].eventType, 'trust_progress');
});

test('BLOCKED on SYSTEM is NOT surfaced to the client (operator-internal)', () => {
  const plans = engine.planSends(
    [mkTask({ id: 't6b', status: 'blocked', block_audience: 'SYSTEM', ack_sent_at: new Date().toISOString() })],
    { now: DAYTIME, deliverableFor: noDeliverable },
  );
  assert.equal(plans.length, 0, 'a SYSTEM-audience block must never message the client');
});

// ── PLANNER: DONE — honesty about deliverables ───────────────────────────────

test('DONE with a registered deliverable reports the real location', () => {
  const plans = engine.planSends(
    [mkTask({ id: 't7', status: 'done', title: 'Sales one-pager' })],
    {
      now: DAYTIME,
      deliverableFor: () => ({ location: '/Users/box/Downloads/one-pager.pdf', summary: "Here's the one-pager." }),
    },
  );
  assert.equal(plans.length, 1);
  assert.match(plans[0].message, /Find it here: \/Users\/box\/Downloads\/one-pager\.pdf/);
  assert.equal(plans[0].stamps[0].extraSets.result_location, '/Users/box/Downloads/one-pager.pdf');
  assert.equal(plans[0].doneWithoutDeliverable.length, 0);
});

test('DONE with ZERO deliverables sends the honest message (NO fabricated location) and flags the QC smell', () => {
  const plans = engine.planSends(
    [mkTask({ id: 't8', status: 'done', title: 'Mystery task' })],
    { now: DAYTIME, deliverableFor: noDeliverable },
  );
  assert.equal(plans.length, 1);
  assert.match(plans[0].message, /ask me for details/i);
  assert.doesNotMatch(plans[0].message, /Find it here:/i, 'must NOT fabricate a location');
  assert.equal(plans[0].stamps[0].extraSets.result_location, null, 'result_location must stay NULL');
  assert.equal(plans[0].doneWithoutDeliverable.length, 1, 'the QC smell must be flagged to the operator lane');
  assert.equal(plans[0].doneWithoutDeliverable[0].taskId, 't8');
});

// ── PLANNER: quiet hours, digest, operator-audience guard ────────────────────

test('QUIET HOURS: nothing is sent between 22:00 and 07:00 (DONE included, default hold till morning)', () => {
  const plans = engine.planSends(
    [mkTask({ id: 't9', status: 'done' }), mkTask({ id: 't10', status: 'in_progress' })],
    { now: DAYTIME, isNight: true, deliverableFor: noDeliverable },
  );
  assert.equal(plans.length, 0, 'quiet hours hold everything');
});

test('DIGEST: more than the threshold of sends to ONE chat coalesce into a single digest message', () => {
  const chat = '77777';
  const tasks = [
    mkTask({ id: 'd1', status: 'assigned', requester_chat_id: chat }),
    mkTask({ id: 'd2', status: 'assigned', requester_chat_id: chat }),
    mkTask({ id: 'd3', status: 'assigned', requester_chat_id: chat }),
    mkTask({ id: 'd4', status: 'assigned', requester_chat_id: chat }),
  ];
  const plans = engine.planSends(tasks, { now: DAYTIME, deliverableFor: noDeliverable });
  assert.equal(plans.length, 1, 'four sends to one chat coalesce into one digest');
  assert.match(plans[0].message, /quick updates/i);
  assert.equal(plans[0].stamps.length, 4, 'the digest claims all four stamps together');
});

test('OPERATOR/SYSTEM guard: a trust message is NEVER targeted at a blocked (operator-internal) chat', () => {
  const plans = engine.planSends(
    [mkTask({ id: 't11', status: 'done', requester_chat_id: 'operator-chat' })],
    { now: DAYTIME, deliverableFor: noDeliverable, blockedChatIds: new Set(['operator-chat']) },
  );
  assert.equal(plans.length, 0, 'a message must never go to an operator-internal chat');
});

// ── EXECUTOR: claim-then-send idempotency + crash-safety (against a real DB) ──

function insertTask(o: {
  id: string; title: string; status: string; requester_chat_id: string | null;
  created_at?: string; ack_sent_at?: string | null;
}): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, title, status, priority, requester_channel, requester_chat_id,
        ack_sent_at, created_at, updated_at)
     VALUES (?, ?, ?, 'medium', 'telegram', ?, ?, ?, ?)`,
    [o.id, o.title, o.status, o.requester_chat_id, o.ack_sent_at ?? null, o.created_at ?? now, now],
  );
}

test('EXECUTOR idempotency: re-running the sweep does NOT re-send (the durable stamp is the guard)', () => {
  insertTask({ id: 'ex1', title: 'Assigned task', status: 'assigned', requester_chat_id: '5001' });

  const sent1: string[] = [];
  const r1 = engine.runTrustEngineSweep({
    now: DAYTIME,
    send: (chat, msg) => { sent1.push(`${chat}:${msg}`); return true; },
  });
  assert.equal(r1.sent, 1, 'first sweep sends the ack');

  const sent2: string[] = [];
  const r2 = engine.runTrustEngineSweep({
    now: DAYTIME,
    send: (chat, msg) => { sent2.push(`${chat}:${msg}`); return true; },
  });
  assert.equal(sent2.length, 0, 'resweep must NOT re-send — the ack_sent_at stamp dedupes');
  assert.equal(r2.scanned, 0, 'the stamped task is no longer a candidate');

  const row = db.queryOne<{ ack_sent_at: string | null }>(
    'SELECT ack_sent_at FROM tasks WHERE id = ?', ['ex1'],
  );
  assert.ok(row?.ack_sent_at, 'ack_sent_at must be stamped exactly once');
});

test('EXECUTOR crash-safety: a throw in the send step leaves the claim durable — resweep produces NO duplicate', () => {
  insertTask({ id: 'ex2', title: 'Crashy task', status: 'assigned', requester_chat_id: '5002' });

  // Simulate a crash between the durable claim and the fire-and-forget dispatch.
  const r1 = engine.runTrustEngineSweep({
    now: DAYTIME,
    send: () => { throw new Error('simulated gateway crash'); },
  });
  assert.equal(r1.claimed, 1, 'the send was claimed (stamped) before the crash');
  assert.equal(r1.sent, 0, 'the crash prevented an actual dispatch');

  // The stamp is durable, so the resweep sees the task as already handled.
  const sent2: string[] = [];
  const r2 = engine.runTrustEngineSweep({
    now: DAYTIME,
    send: (chat, msg) => { sent2.push(`${chat}:${msg}`); return true; },
  });
  assert.equal(sent2.length, 0, 'no duplicate on resweep — the durable stamp is the guard');
  assert.equal(r2.scanned, 0);
});

test('EXECUTOR re-attempts UNSTAMPED sends: a task held at night is delivered on the next daytime sweep', () => {
  insertTask({ id: 'ex3', title: 'Night task', status: 'assigned', requester_chat_id: '5003' });

  // Night sweep: everything is held, so NOTHING is sent and NOTHING is stamped.
  const rNight = engine.runTrustEngineSweep({
    now: NIGHT,
    send: () => { throw new Error('must not send during quiet hours'); },
  });
  assert.equal(rNight.sent, 0, 'quiet hours: no send');
  const heldRow = db.queryOne<{ ack_sent_at: string | null }>(
    'SELECT ack_sent_at FROM tasks WHERE id = ?', ['ex3'],
  );
  assert.equal(heldRow?.ack_sent_at, null, 'held task stays UNSTAMPED so it can be re-attempted');

  // Next daytime sweep: the unstamped task is re-attempted and delivered.
  const sent: string[] = [];
  const rDay = engine.runTrustEngineSweep({ now: DAYTIME, send: (c, m) => { sent.push(`${c}:${m}`); return true; } });
  assert.equal(rDay.sent, 1, 'the previously-held task is re-attempted and delivered by day');
  const nowStamped = db.queryOne<{ ack_sent_at: string | null }>(
    'SELECT ack_sent_at FROM tasks WHERE id = ?', ['ex3'],
  );
  assert.ok(nowStamped?.ack_sent_at, 'now stamped after the successful daytime send');
});

test('EXECUTOR writes an events row per send (operator-visibility Activity trail)', () => {
  insertTask({ id: 'ex4', title: 'Trail task', status: 'assigned', requester_chat_id: '5004' });
  engine.runTrustEngineSweep({ now: DAYTIME, send: () => true });
  const ev = db.queryOne<{ type: string }>(
    "SELECT type FROM events WHERE task_id = ? AND type = 'trust_ack'", ['ex4'],
  );
  assert.equal(ev?.type, 'trust_ack', 'a trust_ack events row must be written for the Activity tab');
});
