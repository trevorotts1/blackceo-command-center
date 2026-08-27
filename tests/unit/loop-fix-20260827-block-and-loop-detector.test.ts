/**
 * LOOP-FIX-20260827 — regression tests for the shared blockTaskForQC() helper
 * and the QC identical-result loop detector.
 *
 * Root incident (verified live): task 9102529d sat in `review` while
 * qc-review-sweep rescored it every ~10 min for 8h44m, producing 11+
 * IDENTICAL [QC-UNROUTEABLE] results (2.8/10, passed=0, attempt=1) because
 * qc_reroute_attempts never incremented and nothing ever blocked the task.
 * Separately, task 9e5925c5's "[CAP] ... held for operator review" escalation
 * (intake-advance-sweep.ts) was PROSE-ONLY — status never changed.
 *
 * Verifies:
 *   1. qc-scorer cap-reached path: after QC_MAX_REROUTES ordinary (non-
 *      unrouteable) llm FAILs, the task is blocked with a task_block_events
 *      row AND a real notice (qc_escalation event for SYSTEM audience).
 *   2. qc-review-sweep identical-result loop detector: 3 consecutive
 *      identical `llm` task_qc_results rows block the task and skip the next
 *      rescore entirely (runQCOnReview is never called for it that tick).
 *   3. qc-review-sweep never selects an archived task (archived_at IS NOT NULL),
 *      even when it would otherwise look "stuck".
 *   4. intake-advance-sweep's QC-reroute-cap escalation now actually
 *      transitions the task to `blocked` (not prose-only) with structured
 *      block_* fields and a task_block_events row.
 *
 * Isolated temp DB per describe-style block. No real API keys, no live
 * gateway (OPENCLAW_GATEWAY_URL is deliberately invalid so any accidental
 * dispatch attempt fails fast and cheap instead of hanging).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-loop-fix-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DISABLE_QC_AUTO_SCORER;
delete process.env.DISABLE_QC_REVIEW_SWEEP;
process.env.QC_MAX_REROUTES = '2';
// Deliberately invalid so any incidental dispatch attempt (e.g. from
// intake-advance-sweep's routing step, which we never reach for capped rows)
// fails synchronously instead of hanging on a real connection.
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type QCScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: QCScorerModule['runQCOnReview'];

type SweepModule = typeof import('../../src/lib/jobs/qc-review-sweep');
let runQCReviewSweep: SweepModule['runQCReviewSweep'];
let detectIdenticalQCResultLoop: SweepModule['detectIdenticalQCResultLoop'];

type IntakeModule = typeof import('../../src/lib/jobs/intake-advance-sweep');
let runIntakeAdvanceSweep: IntakeModule['runIntakeAdvanceSweep'];

let taskCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++taskCounter}`;
}

function insertTask(id: string, status: string, opts: { qcAttempts?: number; archivedAt?: string | null } = {}) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, ?, 'medium', NULL, NULL, ?, ?)`,
    [id, `Task ${id}`, status, now, now],
  );
  if (opts.qcAttempts !== undefined) {
    run(`UPDATE tasks SET qc_reroute_attempts = ? WHERE id = ?`, [opts.qcAttempts, id]);
  }
  if (opts.archivedAt !== undefined) {
    run(`UPDATE tasks SET archived_at = ? WHERE id = ?`, [opts.archivedAt, id]);
  }
}

/** Force a deterministic runQCOnReview verdict via the sanctioned test seam. */
async function runQcWithFixture(
  taskId: string,
  verdict: { score: number; pass: boolean; reason: string; gaps: string[] },
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-loop-fix-fixture-'));
  const fixturePath = path.join(dir, 'verdict.json');
  fs.writeFileSync(fixturePath, JSON.stringify(verdict));
  process.env.QC_FIXTURE_JSON_PATH = fixturePath;
  try {
    return await runQCOnReview(taskId);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb();

  const scorer = await import('../../src/lib/qc-scorer');
  runQCOnReview = scorer.runQCOnReview;

  const sweep = await import('../../src/lib/jobs/qc-review-sweep');
  runQCReviewSweep = sweep.runQCReviewSweep;
  detectIdenticalQCResultLoop = sweep.detectIdenticalQCResultLoop;

  const intake = await import('../../src/lib/jobs/intake-advance-sweep');
  runIntakeAdvanceSweep = intake.runIntakeAdvanceSweep;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
  delete process.env.QC_MAX_REROUTES;
  delete process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
});

// ─── 1. qc-scorer cap-reached: blocked + task_block_events + notice ──────────

test('qc-scorer cap-reached: ordinary llm FAILs past QC_MAX_REROUTES block the task with a task_block_events row and a qc_escalation notice', async () => {
  const id = nextId('cap-block');
  insertTask(id, 'review');

  // QC_MAX_REROUTES=2 and the cap trips when newAttempts > QC_MAX_REROUTES,
  // so it takes THREE ordinary (non-unrouteable) llm FAILs to trip it
  // (attempt 1 -> backlog, attempt 2 -> backlog, attempt 3 -> 3 > 2 -> blocked).
  // Gap text names a SYSTEM signal ("wrong SOP assigned") so the block
  // classifies SYSTEM audience -> qc_escalation event (exercised below).
  const gaps = ['Wrong SOP assigned to this department', 'Missing builder for this deliverable type'];
  for (let attempt = 1; attempt <= 2; attempt++) {
    await runQcWithFixture(id, { score: 6.0, pass: false, reason: `Fixture FAIL ${attempt}`, gaps });
    const midTask = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [id]);
    assert.equal(midTask?.status, 'backlog', `sub-cap FAIL ${attempt} must reroute to backlog`);
    // Re-open into review for the next pass (mirrors a real re-dispatch cycle).
    run(`UPDATE tasks SET status = 'review' WHERE id = ?`, [id]);
  }
  await runQcWithFixture(id, { score: 6.0, pass: false, reason: 'Fixture FAIL 3', gaps });

  const task = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [id]);
  assert.equal(task?.status, 'blocked', 'the FAIL that pushes attempts past the cap must block the task');

  const row = queryOne<{
    block_audience: string | null;
    blocked_on_human: string | null;
    ask: string | null;
  }>(`SELECT block_audience, blocked_on_human, ask FROM tasks WHERE id = ?`, [id]);
  assert.ok(row?.block_audience, 'block_audience must be set');
  assert.ok(row?.blocked_on_human, 'blocked_on_human must be set');
  assert.ok(row?.ask, 'ask must be set (MR-06 answerable-card invariant)');

  const blockEvt = queryOne<{ id: string }>(
    `SELECT id FROM task_block_events WHERE task_id = ? LIMIT 1`,
    [id],
  );
  assert.ok(blockEvt, 'a task_block_events row must be recorded for the cap-reached block');

  const escalation = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'qc_escalation' LIMIT 1`,
    [id],
  );
  assert.ok(escalation, 'a qc_escalation notice event must be recorded for a SYSTEM-audience block');
});

// ─── 2. qc-review-sweep: identical-result loop detector ──────────────────────

test('qc-review-sweep loop detector: 3 identical llm results block the task and the sweep skips rescoring it', async () => {
  const id = nextId('loop-detect');
  insertTask(id, 'review');

  // Seed 3 IDENTICAL `llm` task_qc_results rows (as if rescored 3x with the
  // same verdict), each with a distinct scored_at so ORDER BY is deterministic.
  const base = Date.now() - 60_000;
  for (let i = 0; i < 3; i++) {
    run(
      `INSERT INTO task_qc_results (id, task_id, workspace_id, department_slug, score, passed, scoring_path, qc_agent_id, attempt, scored_at)
       VALUES (?, ?, NULL, NULL, ?, ?, 'llm', NULL, ?, ?)`,
      [`qcr-${id}-${i}`, id, 2.8, 0, i + 1, new Date(base + i * 1000).toISOString()],
    );
  }

  const loop = detectIdenticalQCResultLoop(id, 3);
  assert.ok(loop, 'detectIdenticalQCResultLoop must detect 3 identical llm results');
  assert.equal(loop?.score, 2.8);
  assert.equal(loop?.passed, 0);
  assert.equal(loop?.scoring_path, 'llm');

  const result = await runQCReviewSweep();
  assert.equal(result.loopBlocked, 1, 'exactly one task must be loop-blocked this tick');
  assert.equal(result.scored, 0, 'the looped task must NOT be rescored (runQCOnReview must not run for it)');

  const task = queryOne<{ status: string; block_reason: string | null }>(
    `SELECT status, block_reason FROM tasks WHERE id = ?`,
    [id],
  );
  assert.equal(task?.status, 'blocked', 'loop-detected task must be blocked');
  assert.ok(task?.block_reason?.includes('qc_result_loop_detected'), 'block_reason must name the loop-detector cause');

  // Still exactly 3 task_qc_results rows — proves runQCOnReview was never
  // invoked (which would have inserted a 4th row).
  const countRow = queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM task_qc_results WHERE task_id = ?`,
    [id],
  );
  assert.equal(countRow?.c, 3, 'no 4th task_qc_results row should exist — the sweep must skip rescoring, not just log the loop');

  const blockEvt = queryOne<{ id: string }>(
    `SELECT id FROM task_block_events WHERE task_id = ? LIMIT 1`,
    [id],
  );
  assert.ok(blockEvt, 'a task_block_events row must be recorded for the loop-detected block');
});

test('qc-review-sweep loop detector: does NOT trip on heuristic-path identical results (dedicated escape hatch owns that path)', () => {
  const id = nextId('loop-heuristic-safe');
  insertTask(id, 'review');
  const base = Date.now() - 60_000;
  for (let i = 0; i < 3; i++) {
    run(
      `INSERT INTO task_qc_results (id, task_id, workspace_id, department_slug, score, passed, scoring_path, qc_agent_id, attempt, scored_at)
       VALUES (?, ?, NULL, NULL, ?, ?, 'heuristic', NULL, ?, ?)`,
      [`qcr-${id}-${i}`, id, 7.0, 0, i + 1, new Date(base + i * 1000).toISOString()],
    );
  }
  const loop = detectIdenticalQCResultLoop(id, 3);
  assert.equal(loop, null, 'heuristic-path identical results must NEVER trip the loop detector (own escape hatch owns that path)');
});

// ─── 3. qc-review-sweep never selects an archived task ───────────────────────

test('qc-review-sweep: an archived review task is never selected, even if it looks stuck', async () => {
  const id = nextId('archived-skip');
  insertTask(id, 'review', { archivedAt: new Date().toISOString() });

  const result = await runQCReviewSweep();
  const evt = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'qc_review'`,
    [id],
  );
  assert.ok(!evt, 'an archived task must never be scored by the sweep');
  // Also prove it directly against the sweep's own scanned count semantics:
  // the archived task must not contribute to `scanned` on an otherwise-empty board.
  assert.ok(result.scanned === 0 || !queryOne(`SELECT id FROM events WHERE task_id = ? AND type='qc_review'`, [id]));
});

// ─── 4. intake-advance-sweep: cap escalation now actually blocks ─────────────

test('intake-advance-sweep: QC-reroute-cap escalation transitions the task to blocked with structured fields (not prose-only)', async () => {
  const id = nextId('intake-cap');
  insertTask(id, 'backlog', { qcAttempts: 5 }); // >= cap (QC_MAX_REROUTES=2)

  const result = await runIntakeAdvanceSweep();
  assert.ok((result.capped ?? 0) >= 1, 'at least one task must be surfaced as capped this tick');

  const task = queryOne<{ status: string; block_audience: string | null; blocked_on_human: string | null }>(
    `SELECT status, block_audience, blocked_on_human FROM tasks WHERE id = ?`,
    [id],
  );
  assert.equal(task?.status, 'blocked', 'a capped intake-lane task must actually transition to blocked, not just log a [CAP] event');
  assert.ok(task?.block_audience, 'block_audience must be set on the intake-advance cap block');
  assert.ok(task?.blocked_on_human, 'blocked_on_human must be set on the intake-advance cap block');

  const cappedEvt = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'task_capped'`,
    [id],
  );
  assert.ok(cappedEvt, 'the [CAP] task_capped event must still be written (unchanged)');

  const blockEvt = queryOne<{ id: string }>(
    `SELECT id FROM task_block_events WHERE task_id = ? LIMIT 1`,
    [id],
  );
  assert.ok(blockEvt, 'a task_block_events row must be recorded for the intake-advance cap block');
});
