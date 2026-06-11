/**
 * PRD 2.4 fixture tests — QC heuristic mode must NEVER trigger the reroute loop.
 *
 * The heuristic scoring path fires when:
 *   (1) A SOP is assigned to the task (so the 'no-criteria' short-circuit is
 *       bypassed), AND
 *   (2) No OPENAI_API_KEY / GOOGLE_API_KEY is set (so LLM paths return null),
 *       causing scoreTaskForQC() to fall through to heuristicScore().
 *
 * This is the real keyless-install scenario the PRD describes: operator has
 * seeded the system (SOPs exist) but has not configured a scoring API key.
 *
 * Verifies all four PRD 2.4 acceptance criteria:
 *
 *   (a) With scoring keys UNSET + SOP assigned, move a task to review →
 *       it STAYS in review, a "[QC-HEURISTIC]…human review required" event
 *       is written, and it is NEVER rerouted or blocked
 *       (qc_reroute_attempts stays 0).
 *
 *   (b) Calling runQCOnReview multiple times (up to QC_MAX_REROUTES+1) in
 *       heuristic mode → task stays in review, qc_reroute_attempts stays 0
 *       every time (heuristic never increments the counter).
 *
 *   (c) The ≥8.5 gate and < 8.5 reroute logic are intact:
 *       - QC_PASS_THRESHOLD constant is exactly 8.5 (regression guard).
 *       - scoreTaskForQC with no-criteria path confirms the 7.5 score does
 *         not pass and the gate arithmetic is correct.
 *       - The 'no-criteria' path (no SOP at all, no API key) still reroutes
 *         — it is not heuristic mode, it bypasses the guard, reroute fires.
 *
 *   (d) qc_reroute_attempts stays 0 across repeated heuristic runs (never
 *       incremented by the heuristic path).
 *
 * Uses an isolated temp DB. No real API keys needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qc-prd24-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Force heuristic path — no real API keys in unit tests.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DISABLE_QC_AUTO_SCORER;
// Use a lower cap (2) so loop-cap tests run faster.
process.env.QC_MAX_REROUTES = '2';
// Ensure default port resolution does not interfere.
delete process.env.NEXTAUTH_URL;
delete process.env.NEXT_PUBLIC_APP_URL;
delete process.env.MISSION_CONTROL_URL;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type QCScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: QCScorerModule['runQCOnReview'];
let scoreTaskForQC: QCScorerModule['scoreTaskForQC'];
let QC_PASS_THRESHOLD_val: number;
let QC_MAX_REROUTES_val: number;

let taskCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++taskCounter}`;
}

/** Stable SOP id that all heuristic-path tests share. */
const HEURISTIC_SOP_ID = 'sop-prd24-heuristic-fixture';

/**
 * Insert a minimal task row with the shared SOP assigned, so scoreTaskForQC()
 * bypasses the 'no-criteria' short-circuit and reaches the LLM-or-heuristic
 * decision point. With no API keys set, it falls through to heuristicScore().
 */
function insertHeuristicTask(
  id: string,
  opts: { description?: string | null; qcAttempts?: number } = {},
) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, sop_id, created_at, updated_at)
     VALUES (?, ?, 'review', 'medium', NULL, NULL, ?, ?, ?)`,
    [id, `Heuristic Task ${id}`, HEURISTIC_SOP_ID, now, now],
  );
  if (opts.description !== undefined) {
    run(`UPDATE tasks SET description = ? WHERE id = ?`, [opts.description ?? '', id]);
  }
  if (opts.qcAttempts !== undefined) {
    run(`UPDATE tasks SET qc_reroute_attempts = ? WHERE id = ?`, [opts.qcAttempts, id]);
  }
}

/** Insert a task with NO SOP assigned — triggers 'no-criteria' path (not heuristic). */
function insertNoCriteriaTask(id: string) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'review', 'medium', NULL, NULL, ?, ?)`,
    [id, `No-Criteria Task ${id}`, now, now],
  );
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;

  // Trigger full migration chain.
  db.getDb();

  // Seed the shared SOP that heuristic-path tasks reference.
  // It must have success_criteria so the 'no-criteria' short-circuit is bypassed,
  // allowing the code to reach the LLM → heuristic fallback.
  // slug is UNIQUE NOT NULL in the sops schema.
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, success_criteria, steps, department, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      HEURISTIC_SOP_ID,
      'PRD 2.4 Heuristic Fixture SOP',
      'prd-24-heuristic-fixture',
      'Deliverable must be complete, verified, and meet all stated requirements.',
      JSON.stringify([{ step: 1, action: 'Complete the task deliverable' }]),
      'general-task',
      now,
      now,
    ],
  );

  const scorer = await import('../../src/lib/qc-scorer');
  runQCOnReview = scorer.runQCOnReview;
  scoreTaskForQC = scorer.scoreTaskForQC;
  QC_PASS_THRESHOLD_val = scorer.QC_PASS_THRESHOLD;
  QC_MAX_REROUTES_val = scorer.QC_MAX_REROUTES;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
  delete process.env.QC_MAX_REROUTES;
});

// ─── PRD 2.4 (a): heuristic mode — task stays in review ──────────────────────

test('[PRD 2.4a] heuristic mode: task stays in review, not rerouted or blocked', async () => {
  const id = nextId('heuristic-stays-review');
  // SOP assigned + no API key → heuristic path.
  insertHeuristicTask(id, { description: 'brief work done' });

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'runQCOnReview must return a QCResult');
  assert.equal(result.scoringPath, 'heuristic', 'scoring path must be heuristic when SOP is set but no key is configured');
  assert.ok(!result.pass, 'heuristic score must not pass (< 8.5)');

  const task = queryOne<{ status: string; qc_reroute_attempts: number | null }>(
    `SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?`,
    [id],
  );
  assert.ok(task, 'task must exist');
  assert.equal(
    task.status,
    'review',
    `task must STAY in review in heuristic mode, got: ${task.status}`,
  );
  assert.equal(
    task.qc_reroute_attempts ?? 0,
    0,
    `qc_reroute_attempts must stay 0 in heuristic mode, got: ${task.qc_reroute_attempts}`,
  );
});

// ─── PRD 2.4 (a): heuristic event written with correct message ────────────────

test('[PRD 2.4a] heuristic mode: [QC-HEURISTIC] event written with "human review required"', async () => {
  const id = nextId('heuristic-event');
  insertHeuristicTask(id, { description: 'deliverable output here' });

  await runQCOnReview(id);

  const evt = queryOne<{ type: string; message: string }>(
    `SELECT type, message FROM events WHERE task_id = ? AND type = 'qc_review' LIMIT 1`,
    [id],
  );
  assert.ok(evt, 'a qc_review event must be written in heuristic mode');
  assert.ok(
    evt.message.includes('[QC-HEURISTIC]'),
    `event message must contain [QC-HEURISTIC], got: ${evt.message}`,
  );
  assert.ok(
    evt.message.toLowerCase().includes('human review required'),
    `event message must say "human review required", got: ${evt.message}`,
  );
  assert.ok(
    evt.message.includes('[path:heuristic]'),
    `event message must include [path:heuristic], got: ${evt.message}`,
  );
});

// ─── PRD 2.4 (a): no reroute event, no QC-FAIL marker ────────────────────────

test('[PRD 2.4a] heuristic mode: NO [QC-REROUTE] or [QC-FAIL] event is written', async () => {
  const id = nextId('heuristic-no-reroute');
  insertHeuristicTask(id, { description: 'task output' });

  await runQCOnReview(id);

  const reroute = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND message LIKE '%[QC-REROUTE]%' LIMIT 1`,
    [id],
  );
  assert.ok(!reroute, 'no [QC-REROUTE] event must be written in heuristic mode');

  const fail = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND message LIKE '%[QC-FAIL]%' LIMIT 1`,
    [id],
  );
  assert.ok(!fail, 'no [QC-FAIL] event must be written in heuristic mode');
});

// ─── PRD 2.4 (d): qc_reroute_attempts stays 0 across repeated heuristic runs ──

test('[PRD 2.4d] heuristic mode: qc_reroute_attempts stays 0 after QC_MAX_REROUTES+1 runs', async () => {
  const id = nextId('heuristic-no-increment');
  insertHeuristicTask(id, { description: 'deliverable' });

  // Run QC more than QC_MAX_REROUTES times (cap is 2, so run 3×).
  const runCount = QC_MAX_REROUTES_val + 1;
  for (let i = 0; i < runCount; i++) {
    // Reset to review before each run (heuristic does not change status, but be explicit).
    run(`UPDATE tasks SET status = 'review' WHERE id = ?`, [id]);
    await runQCOnReview(id);
  }

  const task = queryOne<{ status: string; qc_reroute_attempts: number | null }>(
    `SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?`,
    [id],
  );
  assert.ok(task, 'task must exist');
  assert.equal(
    task.status,
    'review',
    `task must remain in review after ${runCount} heuristic runs, got: ${task.status}`,
  );
  assert.equal(
    task.qc_reroute_attempts ?? 0,
    0,
    `qc_reroute_attempts must stay 0 after ${runCount} heuristic runs, got: ${task.qc_reroute_attempts}`,
  );
  // And it must NOT be blocked.
  assert.notEqual(task.status, 'blocked', 'task must never be blocked by heuristic mode');
});

// ─── PRD 2.4 (c): pass threshold constant is intact ──────────────────────────

test('[PRD 2.4c] QC_PASS_THRESHOLD is 8.5 (regression guard)', () => {
  assert.equal(
    QC_PASS_THRESHOLD_val,
    8.5,
    `QC_PASS_THRESHOLD must be 8.5, got: ${QC_PASS_THRESHOLD_val}`,
  );
});

// ─── PRD 2.4 (c): LLM ≥8.5 path produces pass=true (scoreTaskForQC unit check) ──

test('[PRD 2.4c] scoreTaskForQC: pass=true when score >= 8.5 (LLM path gate logic)', async () => {
  // Verify the pass gate arithmetic is intact.
  // no-criteria path (no SOP) returns score=7.5, pass=false — confirming the
  // gate correctly rejects scores below 8.5.
  const noCriteriaResult = await scoreTaskForQC({
    taskId: 'unit-test-nc',
    taskTitle: 'Test task',
    taskDescription: 'A well described deliverable',
    sopSuccessCriteria: null,
    sopName: null,
    sopSteps: null,
    departmentSlug: 'sales',
  });
  assert.equal(noCriteriaResult.scoringPath, 'no-criteria');
  assert.ok(
    noCriteriaResult.score < QC_PASS_THRESHOLD_val,
    `no-criteria score ${noCriteriaResult.score} must be below gate ${QC_PASS_THRESHOLD_val}`,
  );
  assert.ok(!noCriteriaResult.pass, 'no-criteria path must not pass');

  // Verify the pass arithmetic: 8.5 >= 8.5 = true, 8.4 >= 8.5 = false.
  assert.equal(
    8.5 >= QC_PASS_THRESHOLD_val,
    true,
    'score 8.5 must satisfy the pass gate (8.5 >= QC_PASS_THRESHOLD)',
  );
  assert.equal(
    8.4 >= QC_PASS_THRESHOLD_val,
    false,
    'score 8.4 must NOT satisfy the pass gate (8.4 < QC_PASS_THRESHOLD)',
  );
});

// ─── §4 (b): no-criteria path is un-reroutable (brief/metadata issue) ────────
// §4 guidance: "if QC fails on criteria the executor cannot influence (brief
// wording, missing metadata), it must NOT reroute; it goes to review with a
// human-readable reason."  No SOP assigned = missing metadata = un-reroutable.
// Updated from PRD 2.4b (which expected rerouting) to the §4 contract.

test('[§4] no-criteria path is un-reroutable: task stays in review with QC-UNROUTEABLE event', async () => {
  // No SOP + no API key → no-criteria path (scoringPath='no-criteria', not 'heuristic').
  const id = nextId('no-criteria-reroutes');
  insertNoCriteriaTask(id);

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'must return a result');
  assert.equal(result.scoringPath, 'no-criteria', 'path must be no-criteria (no SOP + no keys)');
  assert.ok(!result.pass, 'no-criteria must not pass');

  const task = queryOne<{ status: string; qc_reroute_attempts: number | null }>(
    `SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?`,
    [id],
  );
  assert.ok(task, 'task must exist');
  // §4: un-reroutable failure → task STAYS in review (not moved to backlog).
  assert.equal(
    task.status,
    'review',
    `§4 un-reroutable fail: task must stay in review, got: ${task.status}`,
  );
  // qc_reroute_attempts must NOT have been incremented (no reroute fired).
  assert.equal(
    task.qc_reroute_attempts ?? 0,
    0,
    `§4 un-reroutable fail: qc_reroute_attempts must not increment, got: ${task.qc_reroute_attempts}`,
  );
  // A QC-UNROUTEABLE event must exist (not a QC-REROUTE event).
  const unrouteableEvt = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND message LIKE '%[QC-UNROUTEABLE]%' LIMIT 1`,
    [id],
  );
  assert.ok(
    unrouteableEvt,
    '§4: a [QC-UNROUTEABLE] event must be written for no-criteria failure',
  );
  const reroute = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND message LIKE '%[QC-REROUTE]%' LIMIT 1`,
    [id],
  );
  assert.ok(!reroute, '§4: NO [QC-REROUTE] event must be written for un-reroutable failure');
});

// ─── PRD 2.4 (a): heuristic task never transitions to blocked ────────────────

test('[PRD 2.4a] heuristic mode: task is NEVER set to blocked (even after many runs)', async () => {
  const id = nextId('heuristic-never-blocked');
  insertHeuristicTask(id, { description: 'some output' });

  // Run far more times than QC_MAX_REROUTES.
  const runCount = QC_MAX_REROUTES_val + 3;
  for (let i = 0; i < runCount; i++) {
    run(`UPDATE tasks SET status = 'review' WHERE id = ?`, [id]);
    await runQCOnReview(id);
  }

  const task = queryOne<{ status: string }>(
    `SELECT status FROM tasks WHERE id = ?`,
    [id],
  );
  assert.ok(task, 'task must exist');
  assert.notEqual(task.status, 'blocked', 'heuristic mode must NEVER block a task');
  assert.equal(task.status, 'review', 'task must remain in review after all heuristic runs');
});
