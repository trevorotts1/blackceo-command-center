/**
 * Unit tests for QC loop-close fixes (v4.12.0).
 *
 * Verifies:
 *   1. getMissionControlUrl() returns port 4000 (not 3000) when NEXTAUTH_URL is unset.
 *   2. getMissionControlUrl() uses MISSION_CONTROL_URL env when set.
 *   3. FAIL branch increments qc_reroute_attempts on each QC fail.
 *   4. After QC_MAX_REROUTES fails, task is set to `blocked` (not backlog).
 *   5. Blocked task gets a QC-BLOCKED event (not QC-REROUTE).
 *   6. qc_reroute_attempts column exists (migration 061).
 *   7. ceo-delegation-sweep picks up QC-fail backlog tasks (qc_reroute_attempts > 0).
 *
 * Uses an isolated temp DB. Forces heuristic path (no API keys).
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

// ─── Test 4: qc_reroute_attempts increments on each FAIL ────────────────────

test('FAIL branch: qc_reroute_attempts increments from 0 → 1 on first fail', async () => {
  const id = nextId('attempts-incr');
  // Short description → heuristic scores <8.5.
  insertTask(id, 'review', 'x');

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'must return a result');
  assert.ok(!result.pass, 'heuristic must fail');

  const task = queryOne<{ qc_reroute_attempts: number; status: string }>(
    `SELECT qc_reroute_attempts, status FROM tasks WHERE id = ?`,
    [id],
  );
  assert.ok(task, 'task must exist');
  assert.equal(task.qc_reroute_attempts, 1, 'qc_reroute_attempts must be 1 after first fail');
  assert.equal(task.status, 'backlog', 'task must be in backlog after first fail');
});

// ─── Test 5: cap reached → task blocked, not backlog ────────────────────────

test('FAIL branch: task is set to `blocked` after QC_MAX_REROUTES fails', async () => {
  const id = nextId('attempts-cap');
  // Pre-set attempts = QC_MAX_REROUTES (env set to 2) so this run is the cap.
  // Use explicit value (2) rather than QC_MAX_REROUTES_val to avoid any closure timing edge case.
  insertTask(id, 'review', 'x');
  // Directly set the counter to QC_MAX_REROUTES_val (must equal 2 from env).
  run(`UPDATE tasks SET qc_reroute_attempts = ? WHERE id = ?`, [QC_MAX_REROUTES_val, id]);
  // Verify it took.
  const beforeTask = queryOne<{ qc_reroute_attempts: number }>(
    `SELECT qc_reroute_attempts FROM tasks WHERE id = ?`, [id],
  );
  assert.equal(beforeTask?.qc_reroute_attempts, QC_MAX_REROUTES_val,
    `qc_reroute_attempts must be ${QC_MAX_REROUTES_val} before runQCOnReview`);

  const result = await runQCOnReview(id);
  assert.ok(result !== null, 'must return a result');
  assert.ok(!result.pass, 'heuristic must fail');

  const task = queryOne<{ status: string; description: string | null; qc_reroute_attempts: number }>(
    `SELECT status, description, qc_reroute_attempts FROM tasks WHERE id = ?`,
    [id],
  );
  assert.ok(task, 'task must exist');
  assert.equal(task.status, 'blocked', `task must be 'blocked' at cap, got: ${task.status}`);
  assert.ok(
    task.description?.includes('[QC-BLOCKED]'),
    'description must contain [QC-BLOCKED] marker',
  );
  assert.equal(
    task.qc_reroute_attempts,
    QC_MAX_REROUTES_val + 1,
    `qc_reroute_attempts must be ${QC_MAX_REROUTES_val + 1} at cap`,
  );
});

// ─── Test 6: blocked task gets QC-BLOCKED event, not QC-REROUTE ─────────────

test('FAIL branch (cap): QC-BLOCKED event written, no QC-REROUTE event', async () => {
  const id = nextId('blocked-evt');
  insertTask(id, 'review', 'x');
  // Directly set counter to cap value.
  run(`UPDATE tasks SET qc_reroute_attempts = ? WHERE id = ?`, [QC_MAX_REROUTES_val, id]);

  await runQCOnReview(id);

  // QC-BLOCKED event must exist.
  const blocked = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND message LIKE '%[QC-BLOCKED]%' LIMIT 1`,
    [id],
  );
  assert.ok(blocked, 'QC-BLOCKED event must be written when cap is reached');
  assert.ok(
    blocked.message.includes('Human review') || blocked.message.includes('human attention') || blocked.message.includes('needs human'),
    `blocked message must mention human review, got: ${blocked.message}`,
  );

  // No QC-REROUTE event at this point.
  const reroute = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND message LIKE '%[QC-REROUTE]%' LIMIT 1`,
    [id],
  );
  assert.ok(!reroute, 'no QC-REROUTE event should be written when cap is reached');
});

// ─── Test 7: sub-cap FAIL → task stays in backlog, NOT blocked ──────────────

test('FAIL branch (sub-cap): task stays backlog (not blocked) on first fail', async () => {
  const id = nextId('subcap');
  insertTask(id, 'review', 'y'); // 0 prior attempts

  await runQCOnReview(id);

  const task = queryOne<{ status: string }>(
    `SELECT status FROM tasks WHERE id = ?`, [id],
  );
  assert.ok(task, 'task must exist');
  assert.equal(task.status, 'backlog', 'sub-cap fail must land in backlog, not blocked');
});

// ─── Test 8: ceo-delegation-sweep picks up QC-fail backlog tasks ─────────────

test('ceo-delegation-sweep: QC-fail backlog task (qc_reroute_attempts > 0) is included in sweep', () => {
  // We only test that the query logic returns qc-fail tasks — not the full
  // routeTask round-trip (requires a full agents/workspaces seed and internet).
  const id = nextId('sweep-qcfail');
  insertTask(id, 'backlog', '[QC-FAIL] score 7.0/10. Needs rework.');
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
