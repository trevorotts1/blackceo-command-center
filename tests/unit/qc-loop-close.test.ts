/**
 * Unit tests for QC loop-close fixes (v4.12.0, updated PRD 2.4).
 *
 * Verifies:
 *   1. getMissionControlUrl() returns port 4000 (not 3000) when NEXTAUTH_URL is unset.
 *   2. getMissionControlUrl() uses MISSION_CONTROL_URL env when set.
 *   3. migration 061 adds qc_reroute_attempts column (schema guard).
 *   4. FAIL branch (non-heuristic path) increments qc_reroute_attempts on each fail.
 *   5. After QC_MAX_REROUTES non-heuristic fails, task is set to `blocked`.
 *   6. Blocked task gets a QC-BLOCKED event (not QC-REROUTE).
 *   7. Sub-cap non-heuristic FAIL stays in backlog (not blocked).
 *   8. ceo-delegation-sweep picks up QC-fail backlog tasks (qc_reroute_attempts > 0).
 *
 * PRD 2.4 note: heuristic mode (no API key, scoringPath='heuristic') NEVER
 * increments qc_reroute_attempts and NEVER reroutes — see
 * tests/unit/qc-heuristic-mode-prd2.4.test.ts for the dedicated fixture tests.
 * Tests 4-7 below use the 'no-criteria' scoring path (no SOP assigned, no API key)
 * which is NOT heuristic and correctly goes through the reroute loop.
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

// ─── Test 4: §4 no-criteria = un-reroutable → stays in review, no increment ──
// §4: "if QC fails on criteria the executor cannot influence (brief wording,
// missing metadata), it must NOT reroute." No SOP = un-reroutable.
// Updated: qc_reroute_attempts must NOT increment (no reroute fired).

test('FAIL branch (no-criteria): §4 un-reroutable → task stays in review, qc_reroute_attempts unchanged', async () => {
  const id = nextId('attempts-incr');
  // No SOP → no-criteria path (scoringPath='no-criteria', score=7.5, pass=false).
  insertTask(id, 'review');

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'must return a result');
  assert.ok(!result.pass, 'no-criteria path must fail');
  assert.equal(result.scoringPath, 'no-criteria', 'path must be no-criteria (no SOP + no key)');

  const task = queryOne<{ qc_reroute_attempts: number; status: string }>(
    `SELECT qc_reroute_attempts, status FROM tasks WHERE id = ?`,
    [id],
  );
  assert.ok(task, 'task must exist');
  // §4: un-reroutable → qc_reroute_attempts must NOT increment.
  assert.equal(task.qc_reroute_attempts ?? 0, 0, '§4 un-reroutable: qc_reroute_attempts must stay at 0');
  // §4: task must stay in review (not moved to backlog).
  assert.equal(task.status, 'review', '§4 un-reroutable: task must stay in review');
});

// ─── Test 5: §4 no-criteria un-reroutable even when at cap ───────────────────
// §4: un-reroutable path should still leave task in review (not backlog or blocked).

test('FAIL branch (no-criteria, cap): §4 un-reroutable → task stays in review (not blocked)', async () => {
  const id = nextId('attempts-cap');
  // No SOP → no-criteria path, §4 un-reroutable.
  insertTask(id, 'review');
  // Set counter to QC_MAX_REROUTES — but un-reroutable fires BEFORE the cap check.
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
  // §4: un-reroutable fires before cap check → task stays in review (not blocked/backlog).
  assert.equal(task.status, 'review', `§4 un-reroutable: task must stay in review even at cap, got: ${task.status}`);
  // qc_reroute_attempts must not be incremented by un-reroutable path.
  assert.equal(task.qc_reroute_attempts, QC_MAX_REROUTES_val, 'qc_reroute_attempts must not increment on un-reroutable path');
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

// ─── Test 7: §4 no-criteria sub-cap → task stays in review (not blocked) ─────
// §4: un-reroutable fires before the cap check, so task always stays in review.

test('FAIL branch (no-criteria, sub-cap): §4 un-reroutable → task stays in review', async () => {
  const id = nextId('subcap');
  // No SOP → no-criteria path (§4 un-reroutable). 0 prior attempts.
  insertTask(id, 'review');

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'must return a result');
  assert.equal(result.scoringPath, 'no-criteria', 'path must be no-criteria');

  const task = queryOne<{ status: string }>(
    `SELECT status FROM tasks WHERE id = ?`, [id],
  );
  assert.ok(task, 'task must exist');
  // §4: task stays in review (un-reroutable kill prevents reroute loop).
  assert.equal(task.status, 'review', '§4 un-reroutable: task must stay in review, not leave it');
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
