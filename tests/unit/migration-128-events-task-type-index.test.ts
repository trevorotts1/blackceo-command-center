/**
 * Unit tests for migration 128 `add_events_task_type_index`.
 *
 * The model-skew dedupe lookup added in 85590ee
 * (skewObservationAlreadyRecorded in src/lib/runtime-model.ts) runs
 * `SELECT metadata FROM events WHERE task_id = ? AND type = ?` up to twice
 * per dispatch. Before this migration the events table carried only
 * idx_events_created (created_at DESC) and the PK autoindex, so EXPLAIN QUERY
 * PLAN returned `SCAN events` — a full-table scan per lookup, growing
 * linearly with the events table.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Strategy mirrors kpi-snapshots-migration.test.ts: point DATABASE_PATH at a
 * throwaway temp file BEFORE `@/lib/db` is loaded, then dynamically import
 * the DB helpers so the test binds to the isolated DB and runs the real
 * migration chain (including migration 128).
 *
 * Covers:
 *   1. After the full migration chain runs on a FRESH DB, the index exists
 *      (fresh-DB apply proven) and EXPLAIN QUERY PLAN flips the skew-dedupe
 *      lookup from `SCAN events` to `SEARCH events USING INDEX
 *      idx_events_task_type (task_id=? AND type=?)`.
 *   2. IDEMPOTENCY: re-running the migration body on an already-migrated DB
 *      is a no-op (CREATE INDEX IF NOT EXISTS), and running the migration
 *      chain a second time neither duplicates the index nor re-records the
 *      migration row.
 *   3. The lookup actually returns the right rows through the index
 *      (round-trip on a seeded table, provider-skew duplicate semantics
 *      intact).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-events-idx-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let queryAll: DbModule['queryAll'];
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];
let dbHandle: import('better-sqlite3').Database;

const SKEW_LOOKUP_SQL = `SELECT metadata FROM events WHERE task_id = ? AND type = ?`;

function plan(sql: string, params: string[]): string {
  const rows = dbHandle.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
    detail: string;
  }[];
  return rows.map((r) => r.detail).join(' | ');
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  queryAll = db.queryAll;
  run = db.run;
  closeDb = db.closeDb;

  // getDb() runs the full migration chain (incl. 128) against the temp DB.
  dbHandle = getDb();
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

test('migration 128: fresh-DB apply creates idx_events_task_type and flips the skew lookup to an index search', () => {
  // The migration recorded itself.
  const applied = queryAll<{ id: string }>(
    "SELECT id FROM _migrations WHERE id = '128'",
  );
  assert.equal(applied.length, 1, 'migration 128 must be recorded in _migrations');

  // The index exists with the exact measured column order.
  const idxCols = queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_task_type'",
  );
  assert.equal(idxCols.length, 1, 'idx_events_task_type must exist');
  const cols = queryAll<{ name: string }>(
    'PRAGMA index_info(idx_events_task_type)',
  ).map((c) => c.name);
  assert.deepEqual(cols, ['task_id', 'type'], 'index must be (task_id, type)');

  // THE FIX: before/after plans for the exact query the dedupe lookup runs.
  // On the un-migrated schema this plan was `SCAN events` (verified on the
  // live read-only DB before authoring the migration).
  const detail = plan(SKEW_LOOKUP_SQL, ['t1', 'model_skew_detected']);
  assert.match(
    detail,
    /SEARCH events USING INDEX idx_events_task_type/,
    `dedupe lookup must use the new index; got: ${detail}`,
  );
  assert.doesNotMatch(detail, /SCAN events/, `no full scan may remain; got: ${detail}`);
});

test('migration 128 is idempotent: re-applying the migration body is a no-op and the chain re-run does not duplicate', () => {
  const before = queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_task_type'",
  );
  assert.equal(before.length, 1, 'precondition: exactly one index');

  // (a) the migration body alone, on an already-migrated DB — IF NOT EXISTS.
  dbHandle.exec(`CREATE INDEX IF NOT EXISTS idx_events_task_type ON events(task_id, type)`);
  const afterBody = queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_task_type'",
  );
  assert.equal(afterBody.length, 1, 're-applying the body must not duplicate the index');

  // (b) re-run the migration chain itself — getDb() re-invocation path
  // (runMigrations skips applied ids; nothing may change).
  const beforeRows = queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  getDb(); // second call: no pending migrations, chain must be a no-op
  const afterRows = queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  assert.deepEqual(afterRows, beforeRows, 'chain re-run must not change the index set');
});

test('skew-dedupe lookup round-trips correct rows through the index', () => {
  // events.task_id REFERENCES tasks(id) (FK pragma is ON in the db layer) —
  // seed the parent task rows the events point at. tasks.workspace_id
  // REFERENCES workspaces(id), which references companies(id): seed the chain.
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config) VALUES ('default', 'Index Test Co', 'default', '{}')`,
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('default', 'Index Test WS', 'index-test-ws')`,
  );
  run(
    `INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)`,
    ['task-idx-1', 'skew dedupe round-trip fixture', 'in_progress'],
  );
  run(
    `INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)`,
    ['task-idx-2', 'skew dedupe round-trip fixture', 'in_progress'],
  );

  // Seed exactly the shape skewObservationAlreadyRecorded reads.
  const seed = (id: string, type: string, taskId: string | null, metadata: string | null) =>
    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, datetime('now'))`,
      [id, type, taskId, `event ${id}`, metadata],
    );

  seed('ev-skew-1', 'model_skew_detected', 'task-idx-1', JSON.stringify({ intended_model: 'ollama/x', runtime_model: 'y' }));
  seed('ev-skew-2', 'model_skew_detected', 'task-idx-1', JSON.stringify({ intended_model: 'ollama/z', runtime_model: 'w' }));
  seed('ev-other-task', 'model_skew_detected', 'task-idx-2', JSON.stringify({ intended_model: 'ollama/x', runtime_model: 'y' }));
  seed('ev-other-type', 'model_runtime_confirmed', 'task-idx-1', JSON.stringify({ intended_model: 'ollama/x', runtime_model: 'y' }));

  // The dedupe lookup, verbatim from runtime-model.ts:317.
  const rows = queryAll<{ metadata: string | null }>(
    `SELECT metadata FROM events WHERE task_id = ? AND type = ?`,
    ['task-idx-1', 'model_skew_detected'],
  );
  assert.equal(rows.length, 2, 'lookup must return only the matching task+type rows');
  const metas = rows.map((r) => JSON.parse(r.metadata as string));
  assert.ok(metas.some((m) => m.intended_model === 'ollama/x'));
  assert.ok(metas.some((m) => m.intended_model === 'ollama/z'));

  // The plan under load still hits the index with real data present.
  const detail = plan(SKEW_LOOKUP_SQL, ['task-idx-1', 'model_skew_detected']);
  assert.match(detail, /SEARCH events USING INDEX idx_events_task_type/);
});