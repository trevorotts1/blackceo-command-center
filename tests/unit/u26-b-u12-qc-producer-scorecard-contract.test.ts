/**
 * U26 / B-U12 — `runQCOnReview` READS the posted producer score.
 *
 * Closes the verified break (MASTER SPEC v2 §B.5 / B-U12): the CC judge used
 * to ALWAYS independently re-score a review card from scratch, never reading
 * the producer scorecard `cc_board.py:post_qc_score()` already posts onto the
 * card (`{qc_gate, qc_score, qc_passed, scorecard_path}` metadata on a
 * `completed` task_activities row — "single source" was a documented lie).
 *
 * Verifies the unit's BINARY acceptance criteria:
 *   (a) a review card carrying a producer scorecard is resolved WITHOUT a
 *       fresh description-rubric re-score — the qc event carries the
 *       "[producer-confirmed" path marker.
 *   (b) an artificial producer-9.2 / judge-7.5 disagreement (diff > 1.0)
 *       produces a HELD card (stays in review, unchanged) + exactly one
 *       `qc_disagreement` operator event.
 *   (c) an unreadable `scorecard_path` falls back to today's independent
 *       behavior unchanged (regression fixture).
 *   (d) with both-gates enabled, a card with the producer's own gate PASS +
 *       `page_qc_passed: false` (the B-U11 Page-QC v2 extension field) does
 *       NOT promote, even though the producer's own gate passed.
 *   (e) the whole branch is flag-gated: with QC_PRODUCER_SCORECARD_ENABLED
 *       unset, a producer scorecard on the card is completely ignored —
 *       bit-identical to pre-U26 behavior.
 *
 * Uses an isolated temp DB. No real API keys / LLM calls (QC_FIXTURE_JSON_PATH
 * forces a deterministic judge score where a real evidence-tree score is
 * needed to create a controlled agreement/disagreement).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u26-producer-scorecard-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

// No real API keys in unit tests — any path that would need one either short
// circuits via QC_FIXTURE_JSON_PATH or is intentionally exercised as no-criteria.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DISABLE_QC_AUTO_SCORER;
process.env.QC_MAX_REROUTES = '3';
delete process.env.MISSION_CONTROL_URL;
delete process.env.NEXTAUTH_URL;
delete process.env.NEXT_PUBLIC_APP_URL;

const NON_IMAGE_FIXTURE_FILE = path.join(TMP_DIR, 'q3-budget.txt');
fs.writeFileSync(NON_IMAGE_FIXTURE_FILE, 'Q3 budget summary content — non-empty deliverable.');

const JUDGE_75_FIXTURE = path.join(TMP_DIR, 'judge-7.5.json');
fs.writeFileSync(
  JUDGE_75_FIXTURE,
  JSON.stringify({ score: 7.5, pass: false, reason: 'Judge independent re-score.', gaps: ['minor gap'] }),
);
const JUDGE_90_FIXTURE = path.join(TMP_DIR, 'judge-9.0.json');
fs.writeFileSync(
  JUDGE_90_FIXTURE,
  JSON.stringify({ score: 9.0, pass: true, reason: 'Judge independent re-score.', gaps: [] }),
);

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type QCScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: QCScorerModule['runQCOnReview'];

let taskCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++taskCounter}`;
}

/** Minimal task row, no SOP / no deliverables → would normally be 'no-criteria'. */
function insertBareTask(id: string, opts: { dept?: string } = {}) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'review', 'medium', NULL, NULL, ?, ?)`,
    [id, `Bare Task ${id}`, now, now],
  );
  if (opts.dept) {
    run(`UPDATE tasks SET department = ? WHERE id = ?`, [opts.dept, id]);
  }
}

/** Task with a non-image, non-deck title + one valid non-image deliverable — lands in
 * the "manifest present but no image criteria" Mode-A sub-branch, which calls
 * scoreTaskForQC(input) with the manifest attached (QC_FIXTURE_JSON_PATH-controllable). */
function insertNonImageArtifactTask(id: string, opts: { dept?: string } = {}) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'review', 'medium', NULL, NULL, ?, ?)`,
    [id, `Draft the Q3 budget summary ${id}`, now, now],
  );
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, 'file', 'q3-budget.txt', ?, ?)`,
    [nextId('deliv'), id, NON_IMAGE_FIXTURE_FILE, now],
  );
  if (opts.dept) {
    run(`UPDATE tasks SET department = ? WHERE id = ?`, [opts.dept, id]);
  }
}

/** Post a producer scorecard onto the card exactly as cc_board.py:post_qc_score()
 * does: a `completed` task_activities row carrying the {qc_gate,...} metadata. */
function postProducerScorecard(
  taskId: string,
  metadata: Record<string, unknown>,
) {
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, 'completed', ?, ?, ?)`,
    [
      nextId('activity'),
      taskId,
      `QC: ${typeof metadata.qc_score === 'number' ? metadata.qc_score.toFixed(1) : 'n/a'}/10 — ${metadata.qc_gate ?? 'qc'}`,
      JSON.stringify(metadata),
      new Date().toISOString(),
    ],
  );
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // trigger migrations

  const scorer = await import('../../src/lib/qc-scorer');
  runQCOnReview = scorer.runQCOnReview;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.QC_MAX_REROUTES;
  delete process.env.QC_FIXTURE_JSON_PATH;
  delete process.env.QC_PRODUCER_SCORECARD_ENABLED;
});

// ─── (e) flag OFF: producer scorecard on the card is completely ignored ─────

test('[U26-e] flag OFF: producer scorecard present but QC_PRODUCER_SCORECARD_ENABLED unset → today\'s behavior unchanged', async () => {
  delete process.env.QC_PRODUCER_SCORECARD_ENABLED;
  const id = nextId('flag-off');
  insertBareTask(id);
  postProducerScorecard(id, { qc_gate: 'qc-built-form', qc_score: 9.0, qc_passed: true });

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'must return a result');
  assert.equal(result.scoringPath, 'no-criteria', 'flag OFF: producer scorecard must be ignored — falls to no-criteria exactly as before U26');
});

// ─── (a) agreement / confirmation path — no fresh description-rubric re-score ─

test('[U26-a] flag ON + producer scorecard (no manifest) → producer verdict used directly, [producer-confirmed] marker on the qc event, no fresh no-criteria re-score', async () => {
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('confirmed');
  insertBareTask(id);
  postProducerScorecard(id, { qc_gate: 'qc-built-form', qc_score: 9.0, qc_passed: true });

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'must return a result');
  assert.equal(result.scoringPath, 'llm', 'producer-confirmation path must report scoringPath=llm, not no-criteria');
  assert.ok(result.pass, 'producer PASS verdict must be honored');
  assert.equal(result.score, 9.0, 'producer score must be used directly');

  const task = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [id]);
  assert.ok(task, 'task must exist');
  assert.equal(task.status, 'done', 'PASS producer verdict must promote review → done');

  const evt = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'qc_review' ORDER BY created_at DESC LIMIT 1`,
    [id],
  );
  assert.ok(evt, 'a qc_review event must be written');
  assert.ok(
    evt.message.includes('producer-confirmed'),
    `qc event must carry the producer-confirmed path marker, got: ${evt.message}`,
  );
});

// ─── (b) disagreement > 1.0 → HELD + exactly one qc_disagreement event ──────

test('[U26-b] flag ON + producer=9.2 vs judge=7.5 (diff 1.7 > 1.0) → HELD in review, exactly one qc_disagreement event', async () => {
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('disagree');
  insertNonImageArtifactTask(id);
  postProducerScorecard(id, { qc_gate: 'qc-built-funnel', qc_score: 9.2, qc_passed: true });

  process.env.QC_FIXTURE_JSON_PATH = JUDGE_75_FIXTURE;
  let result;
  try {
    result = await runQCOnReview(id);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
  assert.ok(result !== null, 'must return a result');
  assert.ok(!result.pass, 'a disagreement must never auto-promote');
  assert.ok(result.reason.includes('QC-DISAGREEMENT'), `reason must name the disagreement, got: ${result.reason}`);

  const task = queryOne<{ status: string; qc_reroute_attempts: number | null }>(
    `SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?`,
    [id],
  );
  assert.ok(task, 'task must exist');
  assert.equal(task.status, 'review', 'disagreement must HOLD the card in review, never a silent kickback');
  assert.equal(task.qc_reroute_attempts ?? 0, 0, 'disagreement must not consume a reroute attempt');

  const disagreementEvents = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'qc_disagreement'`,
    [id],
  );
  assert.equal(disagreementEvents.length, 1, `exactly one qc_disagreement event must be written, got ${disagreementEvents.length}`);
});

// ─── (c) unreadable scorecard_path → fail-closed fallback, unchanged behavior ─

test('[U26-c] flag ON + unreadable scorecard_path → falls back to today\'s independent scoring (regression-safe)', async () => {
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('unreadable-path');
  insertBareTask(id);
  postProducerScorecard(id, {
    qc_gate: 'qc-built-form',
    qc_score: 9.0,
    qc_passed: true,
    scorecard_path: path.join(TMP_DIR, 'does-not-exist-scorecard.json'),
  });

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'must return a result');
  assert.equal(
    result.scoringPath,
    'no-criteria',
    'an unreadable scorecard_path must fall back to independent scoring unchanged (no-criteria, exactly as pre-U26)',
  );

  const task = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [id]);
  assert.ok(task, 'task must exist');
  assert.equal(task.status, 'review', 'no-criteria path is un-reroutable — task stays in review, unchanged from pre-U26 behavior');
});

// ─── (d) both-gates rule: FAB-QC PASS + Page-QC FAIL → does not promote ──────

test('[U26-d] both-gates: web-development card, producer PASS + page_qc_passed:false → does NOT promote', async () => {
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('both-gates');
  insertNonImageArtifactTask(id, { dept: 'web-development' });
  // Producer score matches the judge fixture exactly (9.0) so there is no
  // score disagreement — isolates the both-gates rule as the sole cause of FAIL.
  postProducerScorecard(id, {
    qc_gate: 'qc-built-funnel',
    qc_score: 9.0,
    qc_passed: true,
    page_qc_score: 6.0,
    page_qc_passed: false,
  });

  process.env.QC_FIXTURE_JSON_PATH = JUDGE_90_FIXTURE;
  let result;
  try {
    result = await runQCOnReview(id);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
  assert.ok(result !== null, 'must return a result');
  assert.ok(!result.pass, 'both-gates: Page-QC FAIL must block promotion even though FAB-QC (producer gate) PASSED');
  assert.ok(
    result.reason.includes('both-gates') && result.reason.includes('Page-QC FAILED'),
    `reason must name the both-gates rule, got: ${result.reason}`,
  );
  assert.ok(result.gaps.includes('page_qc_failed'), 'gaps must include the page_qc_failed marker');

  const task = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [id]);
  assert.ok(task, 'task must exist');
  assert.notEqual(task.status, 'done', 'both-gates FAIL must never promote to done');
});

// ─── (d, control) both-gates rule stays inert when page_qc_passed is absent ──

test('[U26-d control] both-gates: web-development card, no page_qc_passed posted → producer/judge agreement promotes normally', async () => {
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('both-gates-inert');
  insertNonImageArtifactTask(id, { dept: 'web-development' });
  postProducerScorecard(id, { qc_gate: 'qc-built-funnel', qc_score: 9.0, qc_passed: true });

  process.env.QC_FIXTURE_JSON_PATH = JUDGE_90_FIXTURE;
  let result;
  try {
    result = await runQCOnReview(id);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
  assert.ok(result !== null, 'must return a result');
  assert.ok(result.pass, 'with no page_qc_passed posted, the both-gates rule must stay inert (B-U11 not yet shipped)');

  const task = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [id]);
  assert.ok(task, 'task must exist');
  assert.equal(task.status, 'done', 'agreement + no both-gates block must promote normally');
});
