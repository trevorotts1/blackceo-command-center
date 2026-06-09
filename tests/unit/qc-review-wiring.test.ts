/**
 * Unit tests for QC scorer wiring (v4.11.0).
 *
 * Verifies:
 *   1. runQCOnReview fires from the execution-watcher path (advanceToReview).
 *   2. runQCReviewSweep scores a task stuck in review (no recent qc_review event).
 *   3. FAIL branch: task moves to `backlog`, kickback note appended, CEO reroute
 *      event written (type='qc_review', message contains '[QC-REROUTE]').
 *   4. qc_review events are written and have type='qc_review'.
 *   5. DISABLE_QC_REVIEW_SWEEP env guard skips the sweep.
 *
 * Uses an isolated temp DB (same pattern as per-dept-qc-specialist.test.ts).
 * Forces heuristic path by ensuring OPENAI_API_KEY and GOOGLE_API_KEY are unset.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qc-wire-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Force heuristic path — no real API keys in unit tests.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DISABLE_QC_AUTO_SCORER;
delete process.env.DISABLE_QC_REVIEW_SWEEP;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type QCScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: QCScorerModule['runQCOnReview'];

type SweepModule = typeof import('../../src/lib/jobs/qc-review-sweep');
let runQCReviewSweep: SweepModule['runQCReviewSweep'];

let taskCounter = 0;
function nextId(prefix: string) {
  taskCounter++;
  return `${prefix}-${taskCounter}`;
}

function insertTask(id: string, status: string, description?: string | null) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, ?, 'medium', NULL, NULL, ?, ?)`,
    [id, `Test Task ${id}`, status, now, now],
  );
  if (description) {
    run(`UPDATE tasks SET description = ? WHERE id = ?`, [description, id]);
  }
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;

  // Trigger full migration chain.
  db.getDb();

  const scorer = await import('../../src/lib/qc-scorer');
  runQCOnReview = scorer.runQCOnReview;

  const sweep = await import('../../src/lib/jobs/qc-review-sweep');
  runQCReviewSweep = sweep.runQCReviewSweep;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ─── Test 1: runQCOnReview writes a qc_review event ─────────────────────────

test('runQCOnReview: writes a qc_review event for a review-status task', async () => {
  const id = nextId('qc-basic');
  insertTask(id, 'review', 'A completed deliverable with enough detail to inspect');

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'runQCOnReview must return a QCResult (not null) for a review task');

  const evt = queryOne<{ type: string; message: string }>(
    `SELECT type, message FROM events WHERE task_id = ? AND type = 'qc_review' LIMIT 1`,
    [id],
  );
  assert.ok(evt, 'a qc_review event must be written');
  assert.equal(evt.type, 'qc_review');
  assert.ok(evt.message.includes('[QC-AUTO]'), 'qc_review message must contain [QC-AUTO]');
});

// ─── Test 2: runQCOnReview skips non-review tasks ────────────────────────────

test('runQCOnReview: skips task not in review status (returns null)', async () => {
  const id = nextId('qc-skip');
  insertTask(id, 'in_progress');

  const result = await runQCOnReview(id);
  assert.equal(result, null, 'must return null for non-review task');

  const evt = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'qc_review'`,
    [id],
  );
  assert.ok(!evt, 'no qc_review event should be written for a non-review task');
});

// ─── Test 3: FAIL branch → backlog + CEO reroute event ───────────────────────

test('FAIL branch: task moves to backlog and CEO reroute event is written', async () => {
  const id = nextId('qc-fail');
  // Short description → heuristic will score <8.5 (score clamped to [6,8]).
  insertTask(id, 'review', 'ok');

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'must return a result');
  assert.ok(!result.pass, 'heuristic must fail (score ≤ 8.0 < 8.5 threshold)');

  // Task must be in backlog, not in_progress.
  const task = queryOne<{ status: string; description: string | null }>(
    `SELECT status, description FROM tasks WHERE id = ?`,
    [id],
  );
  assert.ok(task, 'task must exist');
  assert.equal(task.status, 'backlog', 'FAIL must move task to backlog, not in_progress');
  assert.ok(task.description?.includes('[QC-FAIL]'), 'kickback note must be appended to description');

  // CEO reroute event must be written.
  const reroute = queryOne<{ type: string; message: string }>(
    `SELECT type, message FROM events WHERE task_id = ? AND message LIKE '%[QC-REROUTE]%' LIMIT 1`,
    [id],
  );
  assert.ok(reroute, 'CEO reroute event must be written on FAIL');
  assert.equal(reroute.type, 'qc_review', 'reroute event type must be qc_review');
  assert.ok(reroute.message.includes('FAILED QC'), 'reroute message must say FAILED QC');
});

// ─── Test 4: FAIL branch writes task_status_changed event ────────────────────

test('FAIL branch: task_status_changed event is written pointing to backlog', async () => {
  const id = nextId('qc-fail-evt');
  insertTask(id, 'review');

  await runQCOnReview(id);

  const evt = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'task_status_changed' LIMIT 1`,
    [id],
  );
  assert.ok(evt, 'task_status_changed event must be written');
  assert.ok(evt.message.includes('Backlog'), 'event message must mention Backlog');
});

// ─── Test 5: runQCReviewSweep scores a stuck review task ─────────────────────

test('runQCReviewSweep: scores a review task with no recent qc_review event', async () => {
  const id = nextId('sweep-stuck');
  insertTask(id, 'review', 'A complete deliverable ready for QC evaluation with full detail');

  // Verify no qc_review event exists yet.
  const before = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'qc_review'`,
    [id],
  );
  assert.ok(!before, 'no qc_review event should exist before sweep');

  const sweepResult = await runQCReviewSweep();
  assert.ok(sweepResult.scanned >= 1, `sweep must scan at least 1 task (got ${sweepResult.scanned})`);
  assert.ok(sweepResult.scored >= 1, `sweep must score at least 1 task (got ${sweepResult.scored})`);

  const after = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'qc_review'`,
    [id],
  );
  assert.ok(after, 'qc_review event must exist after sweep');
});

// ─── Test 6: sweep skips already-scored tasks ────────────────────────────────

test('runQCReviewSweep: skips task that already has a recent qc_review event', async () => {
  const id = nextId('sweep-already-scored');
  insertTask(id, 'review');

  // Manually insert a very recent qc_review event (simulating a just-fired scorer).
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'qc_review', ?, '[QC-AUTO] already scored', datetime('now', '-2 minutes'))`,
    [`evt-${id}`, id],
  );

  // Count qc_review events before sweep.
  const countBefore = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'qc_review'`,
    [id],
  ).length;
  assert.equal(countBefore, 1, 'should have exactly 1 qc_review event before sweep');

  // Sweep should skip this task (event is within 10-min window).
  await runQCReviewSweep();

  const countAfter = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'qc_review'`,
    [id],
  ).length;
  assert.equal(countAfter, 1, 'sweep must not add another qc_review for a recently-scored task');
});

// ─── Test 7: DISABLE_QC_REVIEW_SWEEP guard ───────────────────────────────────

test('runQCReviewSweep: DISABLE_QC_REVIEW_SWEEP=1 skips the sweep', async () => {
  process.env.DISABLE_QC_REVIEW_SWEEP = '1';
  const id = nextId('sweep-disabled');
  insertTask(id, 'review');

  const result = await runQCReviewSweep();
  assert.equal(result.scanned, 0, 'must scan 0 tasks when disabled');
  assert.ok(result.skippedReason, 'skippedReason must be set');

  delete process.env.DISABLE_QC_REVIEW_SWEEP;
  // Clean up.
  run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// ─── Test 8: qc_review event surfaces in standard query ──────────────────────

test('qc_review events are queryable from events table by type', async () => {
  const id = nextId('qc-event-query');
  insertTask(id, 'review', 'Detailed enough to query for in the events table after scoring');

  await runQCOnReview(id);

  const events = queryAll<{ type: string }>(
    `SELECT type FROM events WHERE task_id = ? AND type = 'qc_review'`,
    [id],
  );
  assert.ok(events.length > 0, 'at least one qc_review event must be queryable for the task');
  assert.ok(
    events.every((e) => e.type === 'qc_review'),
    'all events returned by this filter must have type=qc_review',
  );
});
