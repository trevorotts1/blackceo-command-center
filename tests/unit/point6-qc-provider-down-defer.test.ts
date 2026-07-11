/**
 * Point 6 fix 1 — provider-down QC deferral (distinct from a keyless install).
 *
 * When a scoring key IS configured but every LLM call fails (provider outage /
 * network blip), QC must NOT storm the board into human review. The task is held
 * in `review` with a DISTINCT [QC-DEFERRED-PROVIDER-DOWN] marker and auto-rescored
 * by qc-review-sweep the moment the provider returns. A genuinely keyless install
 * (no key at all) keeps the old [QC-HEURISTIC] "human review required" behavior.
 *
 * Coverage:
 *   1. provider-down (key present + QC_SIMULATE_PROVIDER_DOWN) → task stays in
 *      review with [QC-DEFERRED-PROVIDER-DOWN], NOT [QC-HEURISTIC]; qc_reroute
 *      _attempts unchanged; result.heuristicReason === 'provider-down'.
 *   2. recovery: provider returns (fixture LLM pass) → runQCOnReview re-scores →
 *      task auto-approves to done.
 *   3. sweep auto-rescores a deferred task once the retry window elapses (recovery).
 *   4. sweep does NOT re-score a freshly-deferred task (within the retry window).
 *   5. no-key regression: no key at all → still [QC-HEURISTIC] (heuristicReason
 *      'no-key'), never a provider-down deferral.
 *
 * Isolated temp DB. No real API calls (simulate flag + QC_FIXTURE_JSON_PATH).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qc-provdown-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
const PASS_FIXTURE = path.join(TMP_DIR, 'qc-pass-fixture.json');
process.env.DATABASE_PATH = TMP_DB;

// Clean slate: no keys, no fixture, scorer enabled, sweep enabled.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
// QC-08: the judge is a client-owned Ollama Cloud model — clear any ambient
// judge model/key so the no-key + fresh-defer cases see a truly keyless box.
delete process.env.QC_JUDGE_MODEL;
delete process.env.OLLAMA_CLOUD_API_KEY;
delete process.env.OLLAMA_API_KEY;
delete process.env.QC_SIMULATE_PROVIDER_DOWN;
delete process.env.QC_FIXTURE_JSON_PATH;
delete process.env.DISABLE_QC_AUTO_SCORER;
delete process.env.DISABLE_QC_REVIEW_SWEEP;

fs.writeFileSync(
  PASS_FIXTURE,
  JSON.stringify({ score: 9.2, pass: true, reason: 'Recovered LLM score — passes gate', gaps: [] }),
);

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type ScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: ScorerModule['runQCOnReview'];

type SweepModule = typeof import('../../src/lib/jobs/qc-review-sweep');
let runQCReviewSweep: SweepModule['runQCReviewSweep'];

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}`;
const SOP_ID = 'sop-provider-down-fixture';

function insertReviewTask(id: string, description = 'A completed deliverable ready for QC inspection.') {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, sop_id, created_at, updated_at)
     VALUES (?, ?, ?, 'review', 'medium', NULL, NULL, ?, ?, ?)`,
    [id, `Provider-down task ${id}`, description, SOP_ID, now, now],
  );
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb();

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, success_criteria, steps, department, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      SOP_ID,
      'Provider-down Fixture SOP',
      'provider-down-fixture',
      'Deliverable must be complete, verified, and meet all stated requirements.',
      JSON.stringify([{ step: 1, action: 'Complete the deliverable' }]),
      'general-task',
      now,
      now,
    ],
  );

  const scorer = await import('../../src/lib/qc-scorer');
  runQCOnReview = scorer.runQCOnReview;
  const sweep = await import('../../src/lib/jobs/qc-review-sweep');
  runQCReviewSweep = sweep.runQCReviewSweep;
});

test.after(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.QC_JUDGE_MODEL;
  delete process.env.OLLAMA_CLOUD_API_KEY;
  delete process.env.QC_SIMULATE_PROVIDER_DOWN;
  delete process.env.QC_FIXTURE_JSON_PATH;
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── 1: provider-down → deferred marker, stays in review ─────────────────────
test('[Point6.1a] provider-down: task DEFERRED in review with [QC-DEFERRED-PROVIDER-DOWN], not human-required', async () => {
  // QC-08: the judge is the client's Ollama Cloud model. A configured judge +
  // key + QC_SIMULATE_PROVIDER_DOWN exercises the provider-down (defer) branch.
  process.env.QC_JUDGE_MODEL = 'ollama-cloud/qwen2.5:32b';
  process.env.OLLAMA_CLOUD_API_KEY = 'fake-ollama-key';
  process.env.QC_SIMULATE_PROVIDER_DOWN = '1';
  const id = nextId('provdown');
  insertReviewTask(id);

  try {
    const result = await runQCOnReview(id);
    assert.ok(result, 'must return a QCResult');
    assert.equal(result.scoringPath, 'heuristic', 'provider-down falls back to heuristic scoring');
    assert.equal(result.heuristicReason, 'provider-down', 'heuristicReason must be provider-down');
  } finally {
    delete process.env.QC_JUDGE_MODEL;
    delete process.env.OLLAMA_CLOUD_API_KEY;
    delete process.env.QC_SIMULATE_PROVIDER_DOWN;
  }

  const task = queryOne<{ status: string; qc_reroute_attempts: number | null }>(
    'SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(task!.status, 'review', 'provider-down task must stay in review');
  assert.equal(task!.qc_reroute_attempts ?? 0, 0, 'provider-down must NOT increment reroute attempts');

  const deferred = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND message LIKE '%[QC-DEFERRED-PROVIDER-DOWN]%' LIMIT 1`,
    [id],
  );
  assert.ok(deferred, 'a [QC-DEFERRED-PROVIDER-DOWN] event must be written');

  const heuristicEvt = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND message LIKE '%[QC-HEURISTIC]%' LIMIT 1`,
    [id],
  );
  assert.ok(!heuristicEvt, 'provider-down must NOT write a [QC-HEURISTIC] human-required event');
});

// ── 2: recovery via runQCOnReview → done ────────────────────────────────────
test('[Point6.1b] recovery: provider returns → runQCOnReview re-scores → task auto-approves to done', async () => {
  const id = nextId('recover-direct');
  insertReviewTask(id);

  // Defer it first (provider down) — client Ollama Cloud judge configured.
  process.env.QC_JUDGE_MODEL = 'ollama-cloud/qwen2.5:32b';
  process.env.OLLAMA_CLOUD_API_KEY = 'fake-ollama-key';
  process.env.QC_SIMULATE_PROVIDER_DOWN = '1';
  await runQCOnReview(id);
  delete process.env.QC_SIMULATE_PROVIDER_DOWN;
  delete process.env.QC_JUDGE_MODEL;
  delete process.env.OLLAMA_CLOUD_API_KEY;

  let deferred = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id]);
  assert.equal(deferred!.status, 'review', 'must be deferred in review before recovery');

  // Provider returns — a real LLM score (fixture) passes the gate.
  process.env.QC_FIXTURE_JSON_PATH = PASS_FIXTURE;
  try {
    const result = await runQCOnReview(id);
    assert.ok(result, 'must return a result on recovery');
    assert.equal(result.scoringPath, 'llm', 'recovery uses the llm path');
    assert.ok(result.pass, 'fixture score passes the gate');
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id]);
  assert.equal(task!.status, 'done', 'recovered task must auto-approve to done');
});

// ── 3: sweep auto-rescores a deferred task once the retry window elapses ─────
test('[Point6.1c] sweep: re-scores a deferred task after the retry window (recovery → done)', async () => {
  const id = nextId('sweep-recover');
  insertReviewTask(id);

  // Simulate a deferral written 15 minutes ago (older than the 5-min retry window).
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'qc_review', ?, '[QC-DEFERRED-PROVIDER-DOWN] earlier deferral', datetime('now', '-15 minutes'))`,
    [nextId('evt'), id],
  );

  process.env.QC_FIXTURE_JSON_PATH = PASS_FIXTURE; // provider back
  try {
    const res = await runQCReviewSweep();
    assert.ok(res.scored >= 1, `sweep must score at least the recovered task (scored=${res.scored})`);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id]);
  assert.equal(task!.status, 'done', 'sweep must auto-rescore the deferred task to done once the provider returns');
});

// ── 4: sweep does NOT re-score a freshly-deferred task (within retry window) ──
test('[Point6.1d] sweep: skips a freshly-deferred task inside the retry window', async () => {
  // No keys, no fixture → if this task were (wrongly) selected it would be
  // re-scored (adding an event); asserting the event count is unchanged proves
  // the sweep left it alone.
  delete process.env.OPENAI_API_KEY;
  delete process.env.QC_SIMULATE_PROVIDER_DOWN;
  delete process.env.QC_FIXTURE_JSON_PATH;

  const id = nextId('sweep-fresh');
  insertReviewTask(id);
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'qc_review', ?, '[QC-DEFERRED-PROVIDER-DOWN] just now', datetime('now'))`,
    [nextId('evt'), id],
  );

  const before = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'qc_review'`,
    [id],
  ).length;

  await runQCReviewSweep();

  const after = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'qc_review'`,
    [id],
  ).length;
  assert.equal(after, before, 'a freshly-deferred task must not be re-scored inside the retry window');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id]);
  assert.equal(task!.status, 'review', 'freshly-deferred task must stay in review');
});

// ── 5: no-key regression → still [QC-HEURISTIC], never a provider-down defer ─
test('[Point6.1e] no-key regression: keyless install still writes [QC-HEURISTIC] (heuristicReason no-key)', async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.QC_SIMULATE_PROVIDER_DOWN;
  delete process.env.QC_FIXTURE_JSON_PATH;

  const id = nextId('nokey');
  insertReviewTask(id);

  const result = await runQCOnReview(id);
  assert.ok(result, 'must return a result');
  assert.equal(result.scoringPath, 'heuristic', 'no-key falls back to heuristic');
  assert.equal(result.heuristicReason, 'no-key', 'heuristicReason must be no-key');

  const heuristicEvt = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND message LIKE '%[QC-HEURISTIC]%' LIMIT 1`,
    [id],
  );
  assert.ok(heuristicEvt, 'no-key must write a [QC-HEURISTIC] event');
  assert.ok(heuristicEvt.message.toLowerCase().includes('human review required'), 'no-key event says human review required');

  const deferred = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND message LIKE '%[QC-DEFERRED-PROVIDER-DOWN]%' LIMIT 1`,
    [id],
  );
  assert.ok(!deferred, 'no-key must NOT write a provider-down deferral');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id]);
  assert.equal(task!.status, 'review', 'no-key task stays in review');
});
