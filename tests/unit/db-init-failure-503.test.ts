/**
 * DATA-02 — DB-init / migration-failure health surface.
 *
 * Proves the "exported-but-not-wired" gap is closed end-to-end:
 *   1. runMigrations() records WHICH migration threw (getLastFailedMigrationId).
 *   2. getDb() captures that into a durable module snapshot (getDbInitFailure)
 *      and re-throws instead of handing back a half-migrated DB.
 *   3. GET /api/health reads the snapshot and answers HTTP 503 with
 *      status='error', reason='migration_failed', failedMigration=<id> —
 *      fail-CLOSED — instead of the old generic 200 'degraded'.
 *   4. A repeated poll returns the SAME 503 WITHOUT re-running migrations, so
 *      the health check never thrashes the DB or the watchdog.
 *
 * Simulated failed migration WITHOUT editing the historical, hardcoded
 * migration list: the temp DB is pre-created with the `_migrations` bookkeeping
 * table plus a BEFORE INSERT trigger that RAISE(ABORT)s. The first pending
 * migration's record-INSERT (or its own up()) therefore throws inside
 * runMigrations() — a genuine migration-loop failure driven through the real
 * code path, not a mock.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`). Node's
 * runner isolates each test FILE in its own process, so the DATABASE_PATH set
 * below (captured by @/lib/db's DB_PATH const at import) is scoped to this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-data02-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

// Poison the DB so the FIRST pending migration cannot record itself: any INSERT
// into _migrations aborts. getDb() → exec(schema) (fresh base tables, succeeds)
// → runMigrations() → first migration record-INSERT → RAISE(ABORT) → throws.
{
  const seed = new Database(TMP_DB);
  seed.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TRIGGER _data02_poison_migrations_insert
      BEFORE INSERT ON _migrations
    BEGIN
      SELECT RAISE(ABORT, 'DATA-02 simulated migration failure');
    END;
  `);
  seed.close();
}

type DbModule = typeof import('../../src/lib/db');
type RouteModule = typeof import('../../src/app/api/health/route');

let dbmod: DbModule;
let GET: RouteModule['GET'];

test.before(async () => {
  dbmod = (await import('../../src/lib/db')) as DbModule;
  const route = (await import('../../src/app/api/health/route')) as RouteModule;
  GET = route.GET;
});

test('DATA-02: GET /api/health returns 503 fail-closed via the catch branch on a failed migration', async () => {
  // Nothing has called getDb() yet, so getDbInitFailure() is null and the route
  // exercises its CATCH branch: getDb() throws, the failure is captured, 503.
  assert.equal(dbmod.getDbInitFailure(), null, 'precondition: no failure captured before first getDb()');

  const res = await GET();
  assert.equal(res.status, 503, 'a failed migration must fail CLOSED with 503, not 200 degraded');

  const body = (await res.json()) as {
    status: string;
    reason: string;
    failedMigration: string | null;
    error: string;
  };
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'migration_failed');
  assert.ok(
    typeof body.failedMigration === 'string' && body.failedMigration.length > 0,
    'the 503 body must name the failing migration id',
  );
  assert.equal(typeof body.error, 'string');
});

test('DATA-02: captured failure names the exact migration and matches getLastFailedMigrationId()', () => {
  const failure = dbmod.getDbInitFailure();
  assert.ok(failure, 'getDbInitFailure() must be populated after the failed init');
  assert.ok(
    typeof failure!.migrationId === 'string' && failure!.migrationId!.length > 0,
    'the captured failure must carry the failing migration id',
  );
  assert.equal(
    failure!.migrationId,
    dbmod.getLastFailedMigrationId(),
    'getDbInitFailure().migrationId must equal getLastFailedMigrationId()',
  );

  // getDb() re-throws (never returns a half-migrated handle).
  assert.throws(() => dbmod.getDb(), 'getDb() must re-throw on a failed migration');
});

test('DATA-02: repeated poll returns the SAME deterministic 503 without thrashing', async () => {
  // The failure is now captured, so this GET takes the TOP fast-path (reads the
  // snapshot, never re-invokes getDb()) — deterministic 503, no re-migration.
  const failureBefore = dbmod.getDbInitFailure();

  const res = await GET();
  assert.equal(res.status, 503);
  const body = (await res.json()) as { reason: string; failedMigration: string | null };
  assert.equal(body.reason, 'migration_failed');
  assert.equal(body.failedMigration, failureBefore!.migrationId, 'same failing migration reported on every poll');

  // The snapshot is unchanged (not re-derived / not cleared) across polls.
  assert.equal(dbmod.getDbInitFailure()!.migrationId, failureBefore!.migrationId);
});

test.after(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});
