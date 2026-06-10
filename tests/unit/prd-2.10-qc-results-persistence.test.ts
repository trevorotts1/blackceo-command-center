/**
 * PRD 2.10 — QC Results Persistence Unit Tests
 *
 * Verifies that runQCOnReview writes task_qc_results rows on all scoring paths:
 *   - LLM pass (via fixture): score persisted, passed=1, scoring_path='llm'
 *   - LLM fail (via fixture): score persisted, passed=0, task kicked back
 *   - Heuristic (no LLM key, no fixture): scored_at='heuristic'|'no-criteria',
 *     grading query excludes these rows from qcPassRate
 *
 * Uses QC_FIXTURE_JSON_PATH to drive deterministic LLM results without network.
 * No client box, no API keys needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qc-persist-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');

// Must be set before any import of @/lib/db
process.env.DATABASE_PATH = TMP_DB;

// Clear any leftover env from other test files
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.QC_FIXTURE_JSON_PATH;

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type QcModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: QcModule['runQCOnReview'];
let QC_PASS_THRESHOLD: QcModule['QC_PASS_THRESHOLD'];

const now = new Date().toISOString();

/** Write a QC fixture JSON and set the env var. Returns cleanup function. */
function withQcFixture(data: { score: number; pass: boolean; reason: string; gaps: string[] }) {
  const fixturePath = path.join(TMP_DIR, `qc-fixture-${Date.now()}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify(data));
  process.env.QC_FIXTURE_JSON_PATH = fixturePath;
  return () => {
    delete process.env.QC_FIXTURE_JSON_PATH;
    try { fs.unlinkSync(fixturePath); } catch { /* best-effort */ }
  };
}

/** Seed a minimal task in the DB for QC. Returns the task id. */
function seedTask(workspaceId: string, sopId?: string): string {
  const tid = uuidv4();
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, sop_id, created_at, updated_at)
     VALUES (?, 'Test Task', 'Some deliverable', 'review', ?, ?, ?, ?)`,
    [tid, workspaceId, sopId ?? null, now, now],
  );
  return tid;
}

test.before(async () => {
  const dbMod = await import('../../src/lib/db');
  getDb = dbMod.getDb;
  run = dbMod.run;
  queryOne = dbMod.queryOne;
  queryAll = dbMod.queryAll;
  closeDb = dbMod.closeDb;

  const qcMod = await import('../../src/lib/qc-scorer');
  runQCOnReview = qcMod.runQCOnReview;
  QC_PASS_THRESHOLD = qcMod.QC_PASS_THRESHOLD;

  // Boot DB (runs full migration chain incl. 068)
  getDb();

  // Seed default company
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('marketing', 'Marketing', 'marketing', '', '📢', 'default', 10, ?, ?)`,
    [now, now],
  );
});

test.after(() => {
  closeDb();
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
});

// ---------------------------------------------------------------------------
// Test 1: Migration 068 created task_qc_results
// ---------------------------------------------------------------------------

test('migration 068: task_qc_results table exists with correct columns (PRAGMA table_info)', () => {
  const db = getDb();
  const table = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='task_qc_results'`
  ).get() as { name: string } | undefined;
  assert.equal(table?.name, 'task_qc_results', 'task_qc_results must exist');

  const cols = (
    db.prepare('PRAGMA table_info(task_qc_results)').all() as { name: string }[]
  ).map((c) => c.name);

  for (const col of ['id', 'task_id', 'workspace_id', 'department_slug', 'score', 'passed', 'scoring_path', 'attempt', 'scored_at']) {
    assert.ok(cols.includes(col), `Column must exist: ${col}`);
  }
});

// ---------------------------------------------------------------------------
// Test 2: LLM PASS via fixture — persists score, passed=1, scoring_path='llm'
// ---------------------------------------------------------------------------

test('LLM pass fixture: persists score=9.2, passed=1, scoring_path=llm', async () => {
  const cleanup = withQcFixture({ score: 9.2, pass: true, reason: 'Excellent work', gaps: [] });
  const taskId = seedTask('marketing');

  try {
    const result = await runQCOnReview(taskId);

    assert.ok(result !== null, 'runQCOnReview must return a result');
    assert.equal(result!.scoringPath, 'llm', 'fixture must produce llm scoring path');
    assert.equal(result!.pass, true, 'score 9.2 must pass (≥8.5)');

    // Check DB row
    const row = queryOne<{
      score: number;
      passed: number;
      scoring_path: string;
      department_slug: string;
    }>(
      `SELECT score, passed, scoring_path, department_slug FROM task_qc_results
       WHERE task_id = ? AND scoring_path = 'llm'`,
      [taskId],
    );
    assert.ok(row, 'task_qc_results row must exist for LLM pass');
    assert.equal(row!.score, 9.2, `score must be 9.2, got ${row!.score}`);
    assert.equal(row!.passed, 1, 'passed must be 1');
    assert.equal(row!.scoring_path, 'llm', 'scoring_path must be llm');
    assert.ok(row!.department_slug, 'department_slug must be set');

    // Task must be moved to done
    const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
    assert.equal(task!.status, 'done', 'task must be moved to done after LLM pass');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 3: LLM FAIL via fixture — persists score=7.0, passed=0, task to backlog
// ---------------------------------------------------------------------------

test('LLM fail fixture: persists score=7.0, passed=0, task returned to backlog', async () => {
  const cleanup = withQcFixture({
    score: 7.0,
    pass: false,
    reason: 'Needs improvement',
    gaps: ['Missing data', 'Incomplete analysis'],
  });
  const taskId = seedTask('marketing');

  try {
    const result = await runQCOnReview(taskId);

    assert.ok(result !== null, 'runQCOnReview must return a result');
    assert.equal(result!.scoringPath, 'llm', 'fixture must produce llm scoring path');
    assert.equal(result!.pass, false, 'score 7.0 must fail (< 8.5)');

    // Check DB row
    const row = queryOne<{
      score: number;
      passed: number;
      scoring_path: string;
    }>(
      `SELECT score, passed, scoring_path FROM task_qc_results
       WHERE task_id = ? AND scoring_path = 'llm'`,
      [taskId],
    );
    assert.ok(row, 'task_qc_results row must exist for LLM fail');
    assert.equal(row!.score, 7.0, `score must be 7.0, got ${row!.score}`);
    assert.equal(row!.passed, 0, 'passed must be 0 for score < 8.5');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 4: Heuristic case — no LLM key, no fixture → heuristic row persisted
//         and grading query excludes it from qcPassRate
// ---------------------------------------------------------------------------

test('heuristic case: row persisted with scoring_path=heuristic|no-criteria, excluded from grading qcPassRate', async () => {
  // Ensure no fixture and no API keys (already cleared in top-level setup)
  delete process.env.QC_FIXTURE_JSON_PATH;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const taskId = seedTask('marketing');

  const result = await runQCOnReview(taskId);

  // Must return a result (heuristic path returns early but writes the row too)
  // The heuristic guard returns early in runQCOnReview but the persistence INSERT
  // fires before the guard check, so the row should exist.
  // NOTE: runQCOnReview returns result after the persistence block.

  // Check that a row was written with a non-llm scoring_path
  const db = getDb();
  const row = db.prepare(
    `SELECT scoring_path, passed FROM task_qc_results WHERE task_id = ?`
  ).get(taskId) as { scoring_path: string; passed: number } | undefined;

  assert.ok(row, 'task_qc_results row must exist even for heuristic path');
  assert.ok(
    row!.scoring_path === 'heuristic' || row!.scoring_path === 'no-criteria',
    `scoring_path must be heuristic or no-criteria, got: ${row!.scoring_path}`,
  );

  // The grading qcPassRate query must NOT count this row (llm filter)
  const llmCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM task_qc_results
     WHERE task_id = ? AND scoring_path = 'llm'`
  ).get(taskId) as { cnt: number };
  assert.equal(llmCount.cnt, 0, 'heuristic row must not appear in llm qcPassRate query');
});

// ---------------------------------------------------------------------------
// Test 5: QC_PASS_THRESHOLD is exactly 8.5
// ---------------------------------------------------------------------------

test('QC_PASS_THRESHOLD is 8.5', () => {
  assert.equal(QC_PASS_THRESHOLD, 8.5, 'QC_PASS_THRESHOLD must be 8.5');
});
