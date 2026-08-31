/**
 * Unit tests for QC loop-close fixes (v4.12.0, updated PRD 2.4, updated
 * LOOP-FIX-20260827).
 *
 * Verifies:
 *   1. getMissionControlUrl() returns port 4000 (not 3000) when NEXTAUTH_URL is unset.
 *   2. getMissionControlUrl() uses MISSION_CONTROL_URL env when set.
 *   3. migration 061 adds qc_reroute_attempts column (schema guard).
 *   4. FAIL branch (un-reroutable, no-criteria): increments qc_reroute_attempts
 *      AND blocks the task IMMEDIATELY (does not wait for the cap).
 *   5. Un-reroutable failure blocks immediately EVEN below the cap (the cap
 *      check never runs for an un-reroutable verdict — see #4).
 *   6. Blocked-via-unrouteable task keeps its QC-UNROUTEABLE event (not QC-REROUTE).
 *   7. A second, ordinary (non-unrouteable) FAIL still reroutes to backlog
 *      sub-cap, proving the un-reroutable change did not touch that path.
 *   8. ceo-delegation-sweep picks up QC-fail backlog tasks (qc_reroute_attempts > 0).
 *
 * LOOP-FIX-20260827: task 9102529d sat in `review` for 8h44m getting rescored
 * every ~10 min with an IDENTICAL [QC-UNROUTEABLE] verdict because the old §4
 * behavior (tested by #4/#5/#7 below, pre-fix) left the task in `review` with
 * qc_reroute_attempts NEVER incremented — the safety valve never tripped. An
 * un-reroutable verdict now increments the counter and blocks the task via
 * blockTaskForQC() on its FIRST occurrence (re-scoring cannot fix a verdict
 * that says "human review required"). See tests/unit/qc-heuristic-mode-prd2.4.test.ts
 * for the (unchanged, still-never-increments) heuristic-mode path — that path
 * is NOT un-reroutable classification and has its own dedicated escape hatch.
 *
 * PRD 2.4 note: heuristic mode (no API key, scoringPath='heuristic') NEVER
 * increments qc_reroute_attempts and NEVER reroutes — see
 * tests/unit/qc-heuristic-mode-prd2.4.test.ts for the dedicated fixture tests.
 *
 * Uses an isolated temp DB. Forces no-criteria path (no API keys, no SOP).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qc-loop-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Force heuristic path — no real API keys in unit tests.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DISABLE_QC_AUTO_SCORER;
// Set cap to 2 so tests run faster (cap reached after 2 reroutes, not 3).
process.env.QC_MAX_REROUTES = '2';
// Ensure getMissionControlUrl() returns port 4000 default.
delete process.env.NEXTAUTH_URL;
delete process.env.NEXT_PUBLIC_APP_URL;
delete process.env.MISSION_CONTROL_URL;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type QCScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: QCScorerModule['runQCOnReview'];
let QC_MAX_REROUTES_val: number;

let taskCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++taskCounter}`;
}

/** Insert a minimal task row that satisfies all FK constraints. */
function insertTask(id: string, status: string, opts: { description?: string | null; qcAttempts?: number; dept?: string } = {}) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, ?, 'medium', NULL, NULL, ?, ?)`,
    [id, `Task ${id}`, status, now, now],
  );
  if (opts.description !== undefined) {
    run(`UPDATE tasks SET description = ? WHERE id = ?`, [opts.description ?? '', id]);
  }
  if (opts.qcAttempts !== undefined) {
    run(`UPDATE tasks SET qc_reroute_attempts = ? WHERE id = ?`, [opts.qcAttempts, id]);
  }
  if (opts.dept !== undefined) {
    run(`UPDATE tasks SET department = ?, workspace_id = ? WHERE id = ?`, [opts.dept, opts.dept, id]);
  }
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  getDb = db.getDb;

  // Trigger full migration chain (incl. migration 061).
  getDb();

  const scorer = await import('../../src/lib/qc-scorer');
  runQCOnReview = scorer.runQCOnReview;
  QC_MAX_REROUTES_val = scorer.QC_MAX_REROUTES;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
  delete process.env.QC_MAX_REROUTES;
});

// ─── Test 1: getMissionControlUrl defaults to port 4000 ─────────────────────

test('getMissionControlUrl: returns localhost:4000 when NEXTAUTH_URL is unset', async () => {
  // Ensure the env vars are cleared.
  const savedNAU = process.env.NEXTAUTH_URL;
  const savedMCU = process.env.MISSION_CONTROL_URL;
  delete process.env.NEXTAUTH_URL;
  delete process.env.MISSION_CONTROL_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;

  const { getMissionControlUrl } = await import('../../src/lib/config');
  const url = getMissionControlUrl();
  // Must include :4000, must NOT be :3000.
  assert.ok(url.includes('4000'), `getMissionControlUrl must return port 4000 when no env set, got: ${url}`);
  assert.ok(!url.includes('3000'), `getMissionControlUrl must NOT return port 3000, got: ${url}`);

  // Restore
  if (savedNAU !== undefined) process.env.NEXTAUTH_URL = savedNAU;
  if (savedMCU !== undefined) process.env.MISSION_CONTROL_URL = savedMCU;
});

// ─── Test 2: getMissionControlUrl respects MISSION_CONTROL_URL ───────────────

test('getMissionControlUrl: uses MISSION_CONTROL_URL env when set', async () => {
  process.env.MISSION_CONTROL_URL = 'http://localhost:9876';
  const { getMissionControlUrl } = await import('../../src/lib/config');
  // Re-import to pick up env change (module cache means we need to re-read env).
  // The function reads process.env at call time so it works without re-import.
  const url = getMissionControlUrl();
  assert.ok(url.includes('9876'), `getMissionControlUrl must use MISSION_CONTROL_URL, got: ${url}`);
  delete process.env.MISSION_CONTROL_URL;
});

// ─── Test 3: migration 061 adds qc_reroute_attempts column ──────────────────

test('migration 061: qc_reroute_attempts column exists on tasks table', () => {
  const cols = queryAll<{ name: string }>('PRAGMA table_info(tasks)', []);
  assert.ok(
    cols.some((c) => c.name === 'qc_reroute_attempts'),
    'tasks.qc_reroute_attempts must exist after migration 061',
  );
});

// ─── Test 4: un-reroutable → increments qc_reroute_attempts AND blocks NOW ───
// LOOP-FIX-20260827: an un-reroutable verdict LITERALLY says "human review
// required" — re-scoring it again can never change that. It now increments
// the counter (so the safety valve is never silently dead) AND transitions
// the task straight to `blocked` on its FIRST occurrence, instead of leaving
// it in `review` to be rescored identically forever (the 8h44m incident).

test('FAIL branch (no-criteria): un-reroutable verdict increments qc_reroute_attempts AND blocks immediately', async () => {
  const id = nextId('attempts-incr');
  // No SOP → no-criteria path (scoringPath='no-criteria', score=7.5, pass=false).
  insertTask(id, 'review');

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'must return a result');
  assert.ok(!result.pass, 'no-criteria path must fail');
  assert.equal(result.scoringPath, 'no-criteria', 'path must be no-criteria (no SOP + no key)');

  const task = queryOne<{ qc_reroute_attempts: number; status: string; block_audience: string | null; blocked_on_human: string | null }>(
    `SELECT qc_reroute_attempts, status, block_audience, blocked_on_human FROM tasks WHERE id = ?`,
    [id],
  );
  assert.ok(task, 'task must exist');
  // The counter must increment exactly once — the safety valve now moves.
  assert.equal(task.qc_reroute_attempts ?? 0, 1, 'un-reroutable verdict must increment qc_reroute_attempts by exactly one');
  // The task must be blocked immediately, not left in review.
  assert.equal(task.status, 'blocked', 'un-reroutable verdict must block the task immediately');
  // no-criteria is a SYSTEM signal (SOP/rubric missing) per the shared classifier.
  assert.equal(task.block_audience, 'SYSTEM', 'no-criteria un-reroutable block must be classified SYSTEM audience');
  assert.equal(task.blocked_on_human, 'operator', 'SYSTEM audience must set blocked_on_human=operator');

  const blockEvt = queryOne<{ id: string }>(
    `SELECT id FROM task_block_events WHERE task_id = ? LIMIT 1`,
    [id],
  );
  assert.ok(blockEvt, 'a task_block_events row must be recorded for the immediate block');
});

// ─── Test 5: un-reroutable blocks even when qc_reroute_attempts is already at cap ─
// Proves the un-reroutable branch runs (and increments) BEFORE the cap check —
// it does not depend on the cap value at all, it always blocks on first sight.

test('FAIL branch (no-criteria, at cap): un-reroutable verdict still blocks via the un-reroutable path, not double-counted by the cap branch', async () => {
  const id = nextId('attempts-cap');
  // No SOP → no-criteria path, un-reroutable.
  insertTask(id, 'review');
  run(`UPDATE tasks SET qc_reroute_attempts = ? WHERE id = ?`, [QC_MAX_REROUTES_val, id]);

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'must return a result');
  assert.ok(!result.pass, 'no-criteria path must fail');
  assert.equal(result.scoringPath, 'no-criteria', 'path must be no-criteria');

  const task = queryOne<{ status: string; qc_reroute_attempts: number }>(
    `SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?`,
    [id],
  );
  assert.ok(task, 'task must exist');
  assert.equal(task.status, 'blocked', `un-reroutable verdict must block the task even when already at cap, got: ${task.status}`);
  // Incremented by exactly one past the pre-seeded cap value — proves the
  // un-reroutable branch's own increment ran exactly once, not the cap
  // branch's (which would have thrown a CAS_CONFLICT trying to re-enter
  // `blocked` from `blocked`, never reached here since un-reroutable returns).
  assert.equal(task.qc_reroute_attempts, QC_MAX_REROUTES_val + 1, 'qc_reroute_attempts must increment by exactly one from the un-reroutable branch');
});

// ─── Test 6: §4 no-criteria → QC-UNROUTEABLE event, no QC-BLOCKED ───────────

test('FAIL branch (no-criteria, cap): §4 un-reroutable → QC-UNROUTEABLE event, no QC-BLOCKED', async () => {
  const id = nextId('blocked-evt');
  // No SOP → no-criteria path, §4 un-reroutable.
  insertTask(id, 'review');
  run(`UPDATE tasks SET qc_reroute_attempts = ? WHERE id = ?`, [QC_MAX_REROUTES_val, id]);

  await runQCOnReview(id);

  // §4: QC-UNROUTEABLE event must exist (not QC-BLOCKED).
  const unrouteableEvt = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND message LIKE '%[QC-UNROUTEABLE]%' LIMIT 1`,
    [id],
  );
  assert.ok(unrouteableEvt, '§4: QC-UNROUTEABLE event must be written for no-criteria failure');
  assert.ok(
    unrouteableEvt.message.includes('Human review'),
    `QC-UNROUTEABLE message must mention Human review, got: ${unrouteableEvt.message}`,
  );

  // No QC-REROUTE event.
  const reroute = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND message LIKE '%[QC-REROUTE]%' LIMIT 1`,
    [id],
  );
  assert.ok(!reroute, '§4: no QC-REROUTE event should be written for un-reroutable failure');
});

// ─── Test 7: an ORDINARY (non-unrouteable) sub-cap FAIL still reroutes ───────
// Proves the un-reroutable behavior change (tests 4-5 above) did NOT touch the
// ordinary reroute-to-backlog path: a real `llm` FAIL whose gaps do not match
// any un-reroutable signal must still land in `backlog`, sub-cap, exactly as
// before. Forces scoringPath='llm' via the sanctioned QC_FIXTURE_JSON_PATH
// test seam (see u39-c-08-s4-lifecycle-contract.test.ts) so this can never
// silently drift onto the no-criteria/unrouteable lane under test above.
test('FAIL branch (ordinary llm fail, sub-cap): task still reroutes to backlog (un-reroutable fix did not touch this path)', async () => {
  const id = nextId('subcap-ordinary');
  insertTask(id, 'review');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-qc-loop-fixture-'));
  const fixturePath = path.join(dir, 'verdict.json');
  fs.writeFileSync(fixturePath, JSON.stringify({
    score: 6.0,
    pass: false,
    reason: 'Fixture FAIL: output is missing the requested section.',
    gaps: ['Missing the requested section', 'Wrong file format delivered'],
  }));
  process.env.QC_FIXTURE_JSON_PATH = fixturePath;
  let result;
  try {
    result = await runQCOnReview(id);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(result !== null, 'must return a result');
  assert.equal(result.scoringPath, 'llm', 'fixture must force scoringPath=llm, not no-criteria/heuristic');
  assert.ok(!result.pass, 'fixture verdict must fail');

  const task = queryOne<{ status: string; qc_reroute_attempts: number }>(
    `SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?`, [id],
  );
  assert.ok(task, 'task must exist');
  assert.equal(task.status, 'backlog', 'an ordinary (non-unrouteable) sub-cap FAIL must still reroute to backlog');
  assert.equal(task.qc_reroute_attempts, 1, 'qc_reroute_attempts must increment by exactly one');
});

// ─── Test 8: ceo-delegation-sweep picks up QC-fail backlog tasks ─────────────

test('ceo-delegation-sweep: QC-fail backlog task (qc_reroute_attempts > 0) is included in sweep', () => {
  // We only test that the query logic returns qc-fail tasks — not the full
  // routeTask round-trip (requires a full agents/workspaces seed and internet).
  const id = nextId('sweep-qcfail');
  insertTask(id, 'backlog', { description: '[QC-FAIL] score 7.0/10. Needs rework.' });
  // Directly set counter to 1 (> 0 = QC-fail marker).
  run(`UPDATE tasks SET qc_reroute_attempts = 1 WHERE id = ?`, [id]);

  // The sweep queries: status='backlog' AND qc_reroute_attempts > 0.
  const rows = queryAll<{ id: string; qc_reroute_attempts: number }>(
    `SELECT id, qc_reroute_attempts FROM tasks
     WHERE status = 'backlog' AND qc_reroute_attempts > 0 AND archived_at IS NULL`,
    [],
  );
  const found = rows.find((r) => r.id === id);
  assert.ok(found, 'ceo-delegation-sweep query must include QC-fail backlog task');
  assert.ok((found.qc_reroute_attempts ?? 0) > 0, 'qc_reroute_attempts must be > 0');

  // Clean up
  run(`DELETE FROM tasks WHERE id = ?`, [id]);
});
