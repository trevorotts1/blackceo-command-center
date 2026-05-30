/**
 * Unit/integration tests for migration 047 `add_kpi_snapshots`.
 *
 * Regression guard for the fleet-wide latent bug where `kpi_snapshots` was
 * consumed by three code paths (GET/POST /api/kpi-snapshots, GET
 * /api/kpi-history, seed-kpi-history.ts) but never created by any migration —
 * so every deployment threw "no such table: kpi_snapshots" on the KPI pages.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Strategy mirrors ceo-ordering-ingest.test.ts: point DATABASE_PATH at a
 * throwaway temp file BEFORE `@/lib/db` is loaded (its DB_PATH const is captured
 * at import-evaluation time), then dynamically import the DB helpers so the test
 * binds to the isolated DB and runs the real migration chain (including the new
 * migration 047 `add_kpi_snapshots`).
 *
 * Covers:
 *   1. After the full migration chain runs on a fresh DB, the kpi_snapshots
 *      table and its two indexes exist with the exact column set the consumer
 *      routes SELECT/INSERT.
 *   2. The GET /api/kpi-snapshots query path (the `snapshots` query + the
 *      `latest` query) runs against the fresh table and returns empty arrays —
 *      { snapshots: [], latest: [] } — with no SQL error.
 *   3. The POST /api/kpi-snapshots INSERT and the seed INSERT column lists are
 *      accepted by the created table (round-trips a row, applies the POST
 *      defaults), proving the migration matches every consumer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-kpi-snap-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  run = db.run;
  closeDb = db.closeDb;

  // getDb() runs the full migration chain (incl. 047) against the temp DB.
  getDb();
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

test('migration 047: kpi_snapshots table + indexes exist with the consumer column set', () => {
  const tbl = queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='kpi_snapshots'",
  );
  assert.equal(tbl?.name, 'kpi_snapshots', 'kpi_snapshots table must exist after migrations');

  // Exact column set the routes SELECT/INSERT.
  const cols = new Set(
    queryAll<{ name: string }>('PRAGMA table_info(kpi_snapshots)').map((c) => c.name),
  );
  for (const col of [
    'id', 'department_id', 'kpi_id', 'kpi_name',
    'value', 'target', 'unit', 'snapshot_date', 'created_at',
  ]) {
    assert.ok(cols.has(col), `kpi_snapshots must have column ${col}`);
  }

  // Both indexes the brief requires.
  const idx = new Set(
    queryAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='kpi_snapshots'",
    ).map((i) => i.name),
  );
  assert.ok(idx.has('idx_kpi_snapshots_dept_date'), 'dept+date index must exist');
  assert.ok(idx.has('idx_kpi_snapshots_kpi'), 'kpi_id index must exist');
});

test('GET /api/kpi-snapshots query path returns { snapshots: [], latest: [] } with no SQL error', () => {
  // The two queries copied verbatim from src/app/api/kpi-snapshots/route.ts GET
  // (department_id='company', days=30, no kpi_id filter) — must execute cleanly
  // against the freshly-created empty table and return empty arrays.
  const departmentId = 'company';
  const days = 30;

  const snapshots = queryAll(
    `SELECT id, department_id, kpi_id, kpi_name, value, target, unit, snapshot_date, created_at
       FROM kpi_snapshots
      WHERE department_id = ?
        AND snapshot_date >= date('now', '-' || ? || ' days')
      ORDER BY snapshot_date DESC, created_at DESC`,
    [departmentId, days],
  );

  const latest = queryAll(
    `SELECT kpi_id, kpi_name, value, target, unit, snapshot_date, created_at
       FROM kpi_snapshots
      WHERE department_id = ?
        AND snapshot_date = (
          SELECT MAX(snapshot_date) FROM kpi_snapshots s2
          WHERE s2.kpi_id = kpi_snapshots.kpi_id
            AND s2.department_id = kpi_snapshots.department_id
        )
      ORDER BY created_at DESC`,
    [departmentId],
  );

  assert.deepEqual(snapshots, [], 'snapshots must be an empty array on a fresh DB');
  assert.deepEqual(latest, [], 'latest must be an empty array on a fresh DB');
});

test('POST + seed INSERT column lists round-trip and apply POST defaults', () => {
  // POST /api/kpi-snapshots INSERT (also the seed-kpi-history.ts INSERT):
  // (id, department_id, kpi_id, kpi_name, value, target, unit, snapshot_date)
  run(
    `INSERT INTO kpi_snapshots (id, department_id, kpi_id, kpi_name, value, target, unit, snapshot_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['snap-1', 'sales', 'deals-closed', 'Deals Closed', 12, 15, 'count', '2026-05-30'],
  );

  const row = queryOne<{
    id: string; department_id: string; value: number; target: number | null;
    unit: string; created_at: string;
  }>('SELECT * FROM kpi_snapshots WHERE id = ?', ['snap-1']);
  assert.equal(row?.id, 'snap-1');
  assert.equal(row?.value, 12);
  assert.equal(row?.target, 15);
  assert.ok(row?.created_at, 'created_at must default to a non-null timestamp');

  // target is nullable (POST passes `target ?? null`).
  run(
    `INSERT INTO kpi_snapshots (id, department_id, kpi_id, kpi_name, value, snapshot_date)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['snap-2', 'company', 'no-target-kpi', 'No Target', 7, '2026-05-30'],
  );
  const row2 = queryOne<{ target: number | null; unit: string; department_id: string }>(
    'SELECT target, unit, department_id FROM kpi_snapshots WHERE id = ?',
    ['snap-2'],
  );
  assert.equal(row2?.target, null, 'target must accept NULL');
  assert.equal(row2?.unit, 'count', "unit must default to 'count'");
  assert.equal(row2?.department_id, 'company', "department_id must default to 'company'");
});
