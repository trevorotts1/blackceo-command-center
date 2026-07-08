import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { schema } from './schema';
import { runMigrations, getLastFailedMigrationId } from './migrations';

/**
 * The authoritative, process-resolved path to mission-control.db.
 *
 * Exported so other server-side modules (e.g. persona-selector.ts) can pass
 * it as DASHBOARD_DB_PATH in subprocess env — making the Python selector
 * hit the correct DB on both Mac and VPS layouts without its own candidate-
 * list heuristics.
 *
 * Resolution order:
 *   1. DATABASE_PATH env var (explicit override)
 *   2. process.cwd()/mission-control.db  (default install: ~/projects/command-center)
 */
export const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db');

let db: Database.Database | null = null;

/** DATA-02: a captured migration/boot failure, exported so a health endpoint can
 *  surface a precise 503 ("migration <id> failed") instead of an opaque outage. */
export interface DbInitFailure {
  failedMigrationId: string | null;
  message: string;
  at: string;
}
let initFailure: DbInitFailure | null = null;

/** DATA-02: the last DB-initialization failure, or null once the DB is healthy.
 *  A health/instrumentation route can read this to report a fail-closed board. */
export function getDbInitFailure(): DbInitFailure | null {
  return initFailure;
}

export function getDb(): Database.Database {
  // Serialize boot (DATA-02): only publish the module singleton AFTER migrations
  // complete. A previous version assigned `db` BEFORE runMigrations, so a failed
  // migration left a half-migrated handle assigned — every later getDb() returned
  // it WITHOUT re-running migrations, silently serving traffic on a schema missing
  // columns (the exact "unguarded runtime read breaks on un-migrated box" trap,
  // DATA-01). We now build on a LOCAL handle and only assign `db` on full success.
  if (db) return db;

  const isNewDb = !fs.existsSync(DB_PATH);

  const handle = new Database(DB_PATH);
  handle.pragma('journal_mode = WAL');
  // DATA-15: this DB is written by TWO processes — the Node app and the detached
  // Python persona selector (persona-selector.ts spawns it with DASHBOARD_DB_PATH).
  // SQLite allows a single writer; without a busy timeout a concurrent write fails
  // instantly with SQLITE_BUSY. Wait up to 5s for the write lock instead of erroring.
  // (The Python side must set its own busy_timeout too — see persona-selector.ts,
  // owned by lane L11.)
  handle.pragma('busy_timeout = 5000');
  handle.pragma('foreign_keys = ON');

  // Initialize base schema (creates tables if they don't exist)
  handle.exec(schema);

  // Run migrations for schema updates (handles both new and existing databases).
  // DATA-02: fail-closed — if a migration throws, record which one failed, close
  // the half-migrated handle (so a watchdog restart re-attempts from clean rather
  // than thrashing on a poisoned connection), and re-throw. We do NOT assign `db`,
  // so no request is ever served against an incompletely-migrated schema.
  try {
    runMigrations(handle);
  } catch (err) {
    initFailure = {
      failedMigrationId: getLastFailedMigrationId(),
      message: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    };
    try {
      handle.close();
    } catch {
      /* best-effort — the throw below is what matters */
    }
    throw err;
  }

  initFailure = null;
  db = handle;

  if (isNewDb) {
    console.log('[DB] New database created at:', DB_PATH);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Type-safe query helpers
export function queryAll<T>(sql: string, params: unknown[] = []): T[] {
  const stmt = getDb().prepare(sql);
  return stmt.all(...params) as T[];
}

export function queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
  const stmt = getDb().prepare(sql);
  return stmt.get(...params) as T | undefined;
}

export function run(sql: string, params: unknown[] = []): Database.RunResult {
  const stmt = getDb().prepare(sql);
  return stmt.run(...params);
}

export function transaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}

// Export migration utilities for CLI use
export { runMigrations, getMigrationStatus, reseedWorkspacesFromConfig, autoSeedTrioAgents } from './migrations';
