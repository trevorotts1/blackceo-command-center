/**
 * QC-CAP-ALERT-20260922 — the QC retry cap stops at 5 and TELLS THE OWNER.
 *
 * INCIDENT (live client box, 2026-09-22): a card sat `blocked` carrying
 * `block_reason = "Failed QC 3x, last score 9.0/10"`. 9.0 is ABOVE the 8.5 pass
 * bar — the card failed on a mandatory gap, not on its score — and the only way
 * anyone found out was by reading the database.
 *
 * What this file proves, against a real temp DB and real lifecycle
 * transitions (no mocked scorer, no mocked state machine):
 *
 *   1. attempts 1–4 behave exactly as before: re-route to backlog, no alert.
 *   2. the 5th failure BLOCKS, sends exactly ONE alert, and records the
 *      `qc_cap_alert` activity row.
 *   3. a 6th sweep tick sends NO second alert — proven twice over, once by the
 *      CAS guard (the card has left `review`) and once by the durable marker
 *      (`tasks.qc_cap_alert_attempts`, migration 159) with the card forced back
 *      into `review` at the same attempt count.
 *   4. resume-then-fail sends exactly one NEW alert.
 *   5. the alert body names the GAP, and when the score is at or above the
 *      threshold it says the score passed and a gap failed it.
 *   6. `QC_MAX_REROUTES=3` restores the old cap (child process — the constant
 *      is read once at module load).
 *
 * The owner sender is INJECTED (`send`), the same shape ask-at-capacity uses,
 * so no test can reach a phone. The suite-wide mute and notify.ts's own
 * test-runner refusal remain in force underneath it.
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];

type ScorerModule = typeof import('../../src/lib/qc-scorer');
let rerouteOrBlock: ScorerModule['rerouteOrBlock'];
let qcCapAlertMessage: ScorerModule['qcCapAlertMessage'];
let qcCapBlockReason: ScorerModule['qcCapBlockReason'];
let QC_MAX_REROUTES: number;
let QC_PASS_THRESHOLD: number;

/** An OWNER-audience gap: matches no QC_BLOCK_SYSTEM_SIGNALS pattern. */
const GAP = 'the approved client logo is missing from slides 3 and 7';

/** Captured alerts. The sender returns true = the gateway accepted it. */
let sent: string[] = [];
const recordingSend = (message: string): boolean => {
  sent.push(message);
  return true;
};

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  getDb = db.getDb;
  closeDb = db.closeDb;
  getDb(); // run the full migration chain, including 159

  const scorer = await import('../../src/lib/qc-scorer');
  rerouteOrBlock = scorer.rerouteOrBlock;
  qcCapAlertMessage = scorer.qcCapAlertMessage;
  qcCapBlockReason = scorer.qcCapBlockReason;
  QC_MAX_REROUTES = scorer.QC_MAX_REROUTES;
  QC_PASS_THRESHOLD = scorer.QC_PASS_THRESHOLD;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

let counter = 0;
function newTask(title: string): string {
  const id = `qccap-${Date.now()}-${++counter}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, 'review', 'medium', NULL, ?, ?)`,
    [id, title, 'Deck for the quarterly client review.', now, now],
  );
  return id;
}

/** Put a card back in `review` without touching its attempt counters. */
function forceBackToReview(taskId: string): void {
  run(`UPDATE tasks SET status = 'review' WHERE id = ?`, [taskId]);
}

function taskRow(taskId: string) {
  return queryOne<{
    status: string;
    block_reason: string | null;
    block_audience: string | null;
    qc_reroute_attempts: number | null;
    qc_cap_alert_attempts: number | null;
  }>(
    `SELECT status, block_reason, block_audience, qc_reroute_attempts, qc_cap_alert_attempts
     FROM tasks WHERE id = ?`,
    [taskId],
  );
}

function capAlertEvents(taskId: string) {
  return queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'qc_cap_alert' ORDER BY created_at`,
    [taskId],
  );
}

/** One QC failure at `attempts`, through the shared cap primitive. */
async function failOnce(taskId: string, title: string, attempts: number, score: number, cap = QC_MAX_REROUTES) {
  return rerouteOrBlock({
    taskId,
    taskTitle: title,
    taskDescription: 'Deck for the quarterly client review.',
    attempts,
    cap,
    score,
    reason: `Fixture verdict: attempt ${attempts}.`,
    gaps: [GAP],
    kickbackNote: `[QC-FAIL] Score ${score.toFixed(1)}/10 (attempt ${attempts}/${cap}).`,
    send: recordingSend,
  });
}

// ─── 1. The default cap is 5, and attempts 1–4 are unchanged ────────────────

test('the shipped cap is 5', () => {
  assert.equal(QC_MAX_REROUTES, 5, 'QC_MAX_REROUTES default must be 5');
});

test('attempts 1-4 re-route exactly as before and alert nobody', async () => {
  sent = [];
  const title = 'Q3 board deck';
  const id = newTask(title);

  for (let attempt = 1; attempt <= 4; attempt++) {
    forceBackToReview(id);
    const outcome = await failOnce(id, title, attempt, 6.0);
    assert.equal(outcome, 'rerouted', `attempt ${attempt} must re-route, not block`);

    const row = taskRow(id);
    assert.ok(row);
    assert.equal(row.status, 'backlog', `attempt ${attempt} must land the card in backlog`);
    assert.equal(row.qc_reroute_attempts, attempt, `attempt counter must read ${attempt}`);
    assert.equal(row.qc_cap_alert_attempts, null, 'no alert marker below the cap');
    assert.equal(sent.length, 0, `no owner alert may be sent on attempt ${attempt}`);
    assert.equal(capAlertEvents(id).length, 0, 'no qc_cap_alert activity below the cap');
  }
});

// ─── 2/3/4. The 5th failure stops, alerts once, and never floods ────────────

test('the 5th failure blocks, sends ONE alert, records the activity — and a 6th tick sends nothing', async () => {
  sent = [];
  const title = 'Client onboarding one-pager';
  const id = newTask(title);
  run(`UPDATE tasks SET qc_reroute_attempts = 4 WHERE id = ?`, [id]);

  // THE 5TH FAILURE — score 9.0, ABOVE the 8.5 bar, failed on a hard gap.
  const outcome = await failOnce(id, title, 5, 9.0);
  assert.equal(outcome, 'blocked', 'the 5th failure must stop retrying');

  const blocked = taskRow(id);
  assert.ok(blocked);
  assert.equal(blocked.status, 'blocked', 'card must be blocked');
  assert.equal(blocked.block_audience, 'OWNER', 'gap classifies to the OWNER lane');
  assert.equal(blocked.qc_reroute_attempts, 5, 'attempt counter persisted');
  assert.equal(blocked.qc_cap_alert_attempts, 5, 'durable alert marker stamped at the attempt count');

  assert.equal(sent.length, 1, `exactly ONE owner alert, got ${sent.length}`);

  // The board must show WHY, not just a score that passed.
  assert.ok(
    blocked.block_reason?.includes(GAP),
    `block_reason must name the gap, got: ${blocked.block_reason}`,
  );
  assert.ok(
    blocked.block_reason?.includes('PASSED'),
    `block_reason must say the score passed when it is at/above the bar, got: ${blocked.block_reason}`,
  );

  // The alert is auditable as a task activity.
  const events = capAlertEvents(id);
  assert.equal(events.length, 1, 'exactly one qc_cap_alert activity row');
  assert.ok(events[0].message.includes('attempt 5'), 'activity row names the attempt count');
  assert.ok(events[0].message.includes(GAP), 'activity row carries the gap');

  // ── 6TH SWEEP TICK, guard 1: the card has left `review`, CAS refuses. ──
  const secondTick = await failOnce(id, title, 5, 9.0);
  assert.equal(secondTick, 'lost-race', 'a blocked card cannot be re-blocked from review');
  assert.equal(sent.length, 1, 'no second alert from a repeated sweep tick');

  // ── 6TH SWEEP TICK, guard 2: force the card back into `review` at the SAME
  // attempt count (what a restart plus a re-score would look like). The block
  // lands again; the durable marker still refuses to re-send. ──
  forceBackToReview(id);
  const thirdTick = await failOnce(id, title, 5, 9.0);
  assert.equal(thirdTick, 'blocked', 'the block itself still lands');
  assert.equal(sent.length, 1, `the marker must suppress the re-send, got ${sent.length} alerts`);
  assert.equal(capAlertEvents(id).length, 1, 'no duplicate activity row either');

  // ── RESUME, THEN FAIL AGAIN → exactly ONE more alert. ──
  // Unblocking clears the block_* columns but never resets qc_reroute_attempts,
  // so the next failure arrives at 6 and outranks the marker.
  run(`UPDATE tasks SET status = 'review', block_reason = NULL, block_audience = NULL WHERE id = ?`, [id]);
  const afterResume = await failOnce(id, title, 6, 9.0);
  assert.equal(afterResume, 'blocked', 'a resumed card that fails again blocks again');
  assert.equal(sent.length, 2, `resume-then-fail earns exactly one NEW alert, got ${sent.length}`);
  assert.equal(taskRow(id)?.qc_cap_alert_attempts, 6, 'marker advances to the new attempt count');
  assert.equal(capAlertEvents(id).length, 2, 'the new alert is audited too');
});

// ─── 5. The alert body ───────────────────────────────────────────────────────

test('the alert names the gap, the attempts, the cap, and the score against the bar', async () => {
  sent = [];
  const title = 'Investor update memo';
  const id = newTask(title);
  run(`UPDATE tasks SET qc_reroute_attempts = 4 WHERE id = ?`, [id]);

  await failOnce(id, title, 5, 9.0);
  assert.equal(sent.length, 1);
  const body = sent[0];

  assert.ok(body.includes(title), 'the alert names the card');
  assert.ok(body.includes('STOPPED retrying'), 'the alert says retrying has stopped');
  assert.ok(body.includes('5 failed QC attempts'), 'the alert gives the attempt count');
  assert.ok(body.includes('limit 5'), 'the alert gives the cap');
  assert.ok(body.includes('9.0/10'), 'the alert gives the last score');
  assert.ok(body.includes(`${QC_PASS_THRESHOLD}/10`), 'the alert gives the pass threshold');
  assert.ok(body.includes(GAP), 'the alert names the ACTUAL GAP, not just the score');
  assert.ok(
    body.includes('PASSES'),
    `a score at/above the bar must be called out as passing, got:\n${body}`,
  );
});

test('a below-threshold score is not described as passing', () => {
  const body = qcCapAlertMessage({
    taskTitle: 'Late deck',
    attempts: 5,
    cap: 5,
    score: 4.2,
    gaps: [GAP],
    reason: 'scored low',
  });
  assert.ok(body.includes('4.2/10'), 'names the score');
  assert.ok(body.includes('under the'), 'says the score is under the bar');
  assert.ok(!body.includes('PASSES'), 'must NOT claim a failing score passed');
  assert.ok(body.includes(GAP), 'still names the gap');
});

test('block_reason falls back to the verdict reason when there are no gaps', () => {
  const reason = qcCapBlockReason({ attempts: 5, score: 3.1, gaps: [], reason: 'deliverable never registered' });
  assert.ok(reason.includes('Failed QC 5x'), 'keeps the attempt count the board already showed');
  assert.ok(reason.includes('deliverable never registered'), 'falls back to the verdict reason');
});

// ─── 6. The cap is env-overridable ───────────────────────────────────────────

test('QC_MAX_REROUTES=3 restores the old cap', () => {
  const readCap = (env: NodeJS.ProcessEnv): string =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', '-e', "import('./src/lib/qc-cap.ts').then((m) => console.log('CAP=' + m.QC_MAX_REROUTES))"],
      { cwd: REPO_ROOT, env, encoding: 'utf8' },
    ).trim();

  const overridden = readCap({ ...process.env, QC_MAX_REROUTES: '3' });
  assert.ok(overridden.includes('CAP=3'), `QC_MAX_REROUTES=3 must yield 3, got: ${overridden}`);

  const noOverride = { ...process.env };
  delete noOverride.QC_MAX_REROUTES;
  const shipped = readCap(noOverride);
  assert.ok(shipped.includes('CAP=5'), `the shipped default must be 5, got: ${shipped}`);
});
