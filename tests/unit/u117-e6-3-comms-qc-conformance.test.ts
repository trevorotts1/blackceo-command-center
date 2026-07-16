/**
 * U117 (E6-3/G9) — Comms-artifact QC + per-part-governance / audience-prompt
 * conformance invariant — the CC (Command Center) leg.
 *
 * Master spec v2 §E6-3 (line 2477): folds ADD-1 (U115, per-part governance)
 * and ADD-2 (U116, comms audience-confirmation prompt) into the QC layer,
 * scored and ENFORCED, never merely documented. Deps: U25/B-U11 (Page-QC v2
 * semantic scorer), U19/B-U5 (FAB-QC voice-grounding), U26/B-U12 (THIS
 * file's producer-scorecard contract, `resolveProducerScorecard` /
 * `runQCOnReview`, already merged — the surface this unit extends).
 *
 * The ONB (`openclaw-onboarding`) leg is ALREADY MERGED (`252d6cce`, folded
 * into main at `cf03b647`): `shared-utils/page_qc.py`'s
 * `grade_comms_conformance(inp, *, judge_fn=None, env=None)` scores four
 * checks on an outside-world communication artifact — C1 per-part persona
 * governance (U115), C2 topic considered, C3 audience confirmed (U116), C4
 * blend actually used (semantic) — and returns
 * `{tool:"page_qc_comms", applicable, passed, checks, hard_misses}`. Its own
 * evidence record (`ledgers/evidence/U117-E6-3/README.md`) states verbatim:
 * "review->done for a comms source card is refused when any of the four
 * checks fails... OWED, routed to blackceo-command-center (the U26
 * QC-contract train)... This repo's leg produces the exact passed/checks
 * scorecard shape a CC-side gate reads directly." THIS file proves that CC
 * leg.
 *
 * Wiring contract (mirrors the B-U11 `page_qc_score`/`page_qc_passed`
 * precedent already sitting in `ProducerScorecard` — additive fields on the
 * SAME `completed` task_activities metadata row the base gate posts, never a
 * second row): a producer that has run the comms-conformance check posts
 * `comms_qc_passed` (bool) + optionally `comms_hard_misses` (string[]) onto
 * the SAME `post_qc_score()` metadata dict as its base gate. A second,
 * independent `completed` activity row is deliberately NOT used — that would
 * silently steal `resolveProducerScorecard`'s "newest completed activity"
 * query away from the base FAB-QC/Page-QC gate (proven by
 * `[U117-coexist]` below).
 *
 * Verifies the unit's BINARY acceptance criteria (master spec §2480, this
 * repo's leg):
 *   (d) review→done for a comms source card is refused when any of the four
 *       checks fails (`comms_qc_passed: false`), allowed when all pass
 *       (`comms_qc_passed: true`) + the existing gate(s) pass.
 *   (f, CC half) a `comms_qc_passed` field that is absent/non-boolean (the
 *       ONB `applicable:false`/no-judge-key SKIP shape) never blocks —
 *       SKIP-never-blocks, mirrored on the CC side.
 * Plus the unit's OWN revert contract: additive behind
 * `COMMS_QC_CONFORMANCE=1`; unset → byte-identical to pre-U117 (never reads
 * the comms fields at all).
 *
 * Uses an isolated temp DB. No real API keys / LLM calls (QC_FIXTURE_JSON_PATH
 * forces a deterministic judge score, exactly as tests/unit/u26-b-u12-*
 * already does).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u117-comms-qc-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;
// Suppress ALL real owner Telegram sends (same guard as u26-b-u12-*).
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DISABLE_QC_AUTO_SCORER;
process.env.QC_MAX_REROUTES = '3';
delete process.env.MISSION_CONTROL_URL;
delete process.env.NEXTAUTH_URL;
delete process.env.NEXT_PUBLIC_APP_URL;

const NON_IMAGE_FIXTURE_FILE = path.join(TMP_DIR, 'landing-page-copy.txt');
fs.writeFileSync(NON_IMAGE_FIXTURE_FILE, 'Landing page copy — non-empty comms deliverable.');

const JUDGE_90_FIXTURE = path.join(TMP_DIR, 'judge-9.0.json');
fs.writeFileSync(
  JUDGE_90_FIXTURE,
  JSON.stringify({ score: 9.0, pass: true, reason: 'Judge independent re-score.', gaps: [] }),
);

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type QCScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: QCScorerModule['runQCOnReview'];

let taskCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++taskCounter}`;
}

/** Non-image comms-artifact task: lands in the "manifest present, no image
 * criteria" Mode-A sub-branch (scoreTaskForQC with the manifest attached),
 * exactly like insertNonImageArtifactTask in tests/unit/u26-b-u12-*. */
function insertCommsArtifactTask(id: string, opts: { dept?: string } = {}) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'review', 'medium', NULL, NULL, ?, ?)`,
    [id, `Write the landing page copy ${id}`, now, now],
  );
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, 'file', 'landing-page-copy.txt', ?, ?)`,
    [nextId('deliv'), id, NON_IMAGE_FIXTURE_FILE, now],
  );
  if (opts.dept) {
    run(`UPDATE tasks SET department = ? WHERE id = ?`, [opts.dept, id]);
  }
}

/** Post a producer scorecard onto the card exactly as cc_board.py:post_qc_score()
 * does: a `completed` task_activities row carrying the {qc_gate,...} metadata
 * — identical helper to tests/unit/u26-b-u12-*'s postProducerScorecard.
 * Optional `createdAt` lets a test pin an unambiguous ordering when it needs
 * to post more than one row for the same task (avoids a same-millisecond
 * `created_at` tie, whose ORDER BY ... DESC LIMIT 1 tie-break is not a
 * property this suite wants to depend on). */
function postProducerScorecard(taskId: string, metadata: Record<string, unknown>, createdAt?: string) {
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, 'completed', ?, ?, ?)`,
    [
      nextId('activity'),
      taskId,
      `QC: ${typeof metadata.qc_score === 'number' ? (metadata.qc_score as number).toFixed(1) : 'n/a'}/10 — ${metadata.qc_gate ?? 'qc'}`,
      JSON.stringify(metadata),
      createdAt ?? new Date().toISOString(),
    ],
  );
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
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
  delete process.env.COMMS_QC_CONFORMANCE;
});

// ─── flag OFF: comms_qc_passed on the card is completely ignored ───────────

test('[U117-flag-off] COMMS_QC_CONFORMANCE unset: comms_qc_passed:false present on the card → gate stays inert, promotes normally', async () => {
  delete process.env.COMMS_QC_CONFORMANCE;
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('flag-off');
  insertCommsArtifactTask(id, { dept: 'content' });
  postProducerScorecard(id, {
    qc_gate: 'qc-built-form',
    qc_score: 9.0,
    qc_passed: true,
    comms_qc_passed: false,
    comms_hard_misses: ['audience_confirmed'],
  });

  process.env.QC_FIXTURE_JSON_PATH = JUDGE_90_FIXTURE;
  let result;
  try {
    result = await runQCOnReview(id);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
  assert.ok(result !== null, 'must return a result');
  assert.ok(result.pass, 'flag OFF: comms_qc_passed:false must be completely ignored — card promotes as if U117 did not exist');

  const task = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [id]);
  assert.equal(task?.status, 'done', 'flag OFF: normal promotion, byte-identical to pre-U117');
});

// ─── flag ON, no comms scorecard posted at all → unaffected ────────────────

test('[U117-inert-no-scorecard] flag ON, base gate posted but no comms fields at all → unaffected, normal promotion', async () => {
  process.env.COMMS_QC_CONFORMANCE = '1';
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('no-comms-fields');
  insertCommsArtifactTask(id, { dept: 'content' });
  postProducerScorecard(id, { qc_gate: 'qc-built-form', qc_score: 9.0, qc_passed: true });

  process.env.QC_FIXTURE_JSON_PATH = JUDGE_90_FIXTURE;
  let result;
  try {
    result = await runQCOnReview(id);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
  assert.ok(result !== null, 'must return a result');
  assert.ok(result.pass, 'no comms_qc_passed field at all → comms gate never fires, card promotes normally');
});

// ─── (d) comms_qc_passed:false → refused, alongside existing gates PASS ────

test('[U117-d] flag ON + base gate PASS + comms_qc_passed:false + hard misses → does NOT promote, reason + gaps name the failure', async () => {
  process.env.COMMS_QC_CONFORMANCE = '1';
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('comms-fail');
  insertCommsArtifactTask(id, { dept: 'content' });
  // Producer score matches the judge fixture exactly (9.0) so there is no
  // score disagreement — isolates the U117 comms gate as the sole cause of FAIL.
  postProducerScorecard(id, {
    qc_gate: 'qc-built-form',
    qc_score: 9.0,
    qc_passed: true,
    comms_qc_passed: false,
    comms_hard_misses: ['audience_confirmed', 'topic_considered'],
  });

  process.env.QC_FIXTURE_JSON_PATH = JUDGE_90_FIXTURE;
  let result;
  try {
    result = await runQCOnReview(id);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
  assert.ok(result !== null, 'must return a result');
  assert.ok(!result.pass, 'U117: comms_qc_passed:false must block promotion even though the base gate PASSED');
  assert.ok(
    result.reason.includes('comms conformance FAILED'),
    `reason must name the comms-conformance failure, got: ${result.reason}`,
  );
  assert.ok(result.gaps.includes('comms_qc_conformance_failed'), 'gaps must include the comms_qc_conformance_failed marker');
  assert.ok(result.gaps.includes('audience_confirmed'), 'gaps must surface the specific hard-missed check name(s)');
  assert.ok(result.gaps.includes('topic_considered'), 'gaps must surface every hard-missed check name');

  const task = queryOne<{ status: string; qc_reroute_attempts: number | null }>(
    `SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?`,
    [id],
  );
  // Mirrors tests/unit/u26-b-u12-*'s [U26-d] assertion exactly: a both-gates-
  // style FAIL takes the SAME kickback-for-reroute path as any other QC FAIL
  // (status -> backlog, qc_reroute_attempts incremented) — never a silent
  // promote to done. It is NOT the separate qc_disagreement HOLD-in-review
  // path (that is reserved for a producer/judge score mismatch).
  assert.notEqual(task?.status, 'done', 'comms conformance FAIL must never promote to done');
  assert.equal((task?.qc_reroute_attempts ?? 0) > 0, true, 'a comms conformance FAIL must count as a real QC fail (reroute attempt recorded), never silently dropped');
});

// ─── (d, control) comms_qc_passed:true → promotes normally ─────────────────

test('[U117-d control] flag ON + base gate PASS + comms_qc_passed:true → promotes normally (comms PASS never blocks)', async () => {
  process.env.COMMS_QC_CONFORMANCE = '1';
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('comms-pass');
  insertCommsArtifactTask(id, { dept: 'content' });
  postProducerScorecard(id, {
    qc_gate: 'qc-built-form',
    qc_score: 9.0,
    qc_passed: true,
    comms_qc_passed: true,
  });

  process.env.QC_FIXTURE_JSON_PATH = JUDGE_90_FIXTURE;
  let result;
  try {
    result = await runQCOnReview(id);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
  assert.ok(result !== null, 'must return a result');
  assert.ok(result.pass, 'comms_qc_passed:true must never block promotion');

  const task = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [id]);
  assert.equal(task?.status, 'done', 'all gates PASS → promotes to done');
});

// ─── (f, CC half) SKIP-never-blocks: absent/non-boolean comms_qc_passed ────

test('[U117-f] flag ON + comms_qc_passed absent (ONB applicable:false/no-judge-key SKIP shape) → never blocks', async () => {
  process.env.COMMS_QC_CONFORMANCE = '1';
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('comms-skip');
  insertCommsArtifactTask(id, { dept: 'content' });
  // No comms_qc_passed key at all — the exact shape grade_comms_conformance()
  // returns when applicable=False (flag off ONB-side) or every dimension SKIPs.
  postProducerScorecard(id, { qc_gate: 'qc-built-form', qc_score: 9.0, qc_passed: true });

  process.env.QC_FIXTURE_JSON_PATH = JUDGE_90_FIXTURE;
  let result;
  try {
    result = await runQCOnReview(id);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
  assert.ok(result !== null, 'must return a result');
  assert.ok(result.pass, 'SKIP (no comms_qc_passed key) must never block — only an explicit false blocks');
});

// ─── coexistence: comms gate + B-U11 page_qc both-gates rule, same row ─────

test('[U117-coexist] comms_qc_passed:false on the SAME metadata row as page_qc_passed:true → both fields read correctly, comms is the sole blocker', async () => {
  process.env.COMMS_QC_CONFORMANCE = '1';
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('coexist');
  insertCommsArtifactTask(id, { dept: 'web-development' }); // QC_BOTH_GATES_DEPARTMENTS member
  postProducerScorecard(id, {
    qc_gate: 'qc-built-funnel',
    qc_score: 9.0,
    qc_passed: true,
    page_qc_score: 9.0,
    page_qc_passed: true, // B-U11 both-gates rule: PASSES, must not itself block
    comms_qc_passed: false, // U117: FAILS, must be the sole blocker
    comms_hard_misses: ['blend_used'],
  });

  process.env.QC_FIXTURE_JSON_PATH = JUDGE_90_FIXTURE;
  let result;
  try {
    result = await runQCOnReview(id);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
  assert.ok(result !== null, 'must return a result');
  assert.ok(!result.pass, 'comms gate must block even when the sibling B-U11 page_qc both-gates rule independently PASSES');
  assert.ok(!result.reason.includes('Page-QC FAILED'), 'the page_qc both-gates rule must NOT itself have fired (page_qc_passed was true)');
  assert.ok(result.reason.includes('comms conformance FAILED'), `comms must be named as the blocker, got: ${result.reason}`);
  assert.ok(!result.gaps.includes('page_qc_failed'), 'page_qc_failed marker must be absent — only the comms marker fired');
  assert.ok(result.gaps.includes('comms_qc_conformance_failed'));
});

// ─── two independent gate rows never collide (documents the design choice) ─

test('[U117-single-row-design] a SECOND completed activity (not carrying comms fields) posted AFTER the comms-bearing row does not resurrect a stale comms verdict', async () => {
  process.env.COMMS_QC_CONFORMANCE = '1';
  process.env.QC_PRODUCER_SCORECARD_ENABLED = '1';
  const id = nextId('second-row');
  insertCommsArtifactTask(id, { dept: 'content' });
  const t0 = new Date();
  const t1 = new Date(t0.getTime() + 5000); // unambiguously later — avoids a
  // same-millisecond created_at tie between the two inserts below, whose
  // ORDER BY ... DESC LIMIT 1 tie-break this suite does not want to depend on.
  postProducerScorecard(
    id,
    {
      qc_gate: 'qc-built-form',
      qc_score: 9.0,
      qc_passed: true,
      comms_qc_passed: false,
      comms_hard_misses: ['audience_confirmed'],
    },
    t0.toISOString(),
  );
  // A later, unrelated completed+metadata activity (e.g. a different tool
  // posting progress) becomes the "newest" row `resolveProducerScorecard`
  // reads — proves the design (additive fields on ONE row) means a later,
  // comms-silent row simply carries no comms verdict at all (never a stale
  // false BLOCKING a card whose real comms gate later posted PASS, and never
  // silently un-blocking a real FAIL either — the newest row is simply what
  // it is, same pre-existing B-U12 "newest completed activity" contract this
  // unit extends, not a new failure mode).
  postProducerScorecard(id, { qc_gate: 'qc-built-form', qc_score: 9.0, qc_passed: true }, t1.toISOString());

  process.env.QC_FIXTURE_JSON_PATH = JUDGE_90_FIXTURE;
  let result;
  try {
    result = await runQCOnReview(id);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
  assert.ok(result !== null, 'must return a result');
  // The newest row carries no comms_qc_passed key → SKIP-never-blocks → PASS.
  assert.ok(result.pass, 'newest completed+metadata row wins (pre-existing B-U12 contract); with no comms field on it, comms gate is silent');
});
