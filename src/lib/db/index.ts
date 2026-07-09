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

/**
 * DATA-02: durable snapshot of the last DB-init failure.
 *
 * Captured by getDb() when schema init or migrations throw, and read by
 * src/instrumentation.ts (to fail-closed on boot) and GET /api/health (to serve
 * a deterministic 503 "migration <N> failed" instead of a generic degraded 200).
 * Cleared once getDb() completes a clean init.
 */
export interface DbInitFailure {
  /** Human-readable error message from the throwing init step. */
  message: string;
  /**
   * The failing migration id (from getLastFailedMigrationId()) when the failure
   * happened inside runMigrations(); null when it failed earlier (open/pragma/
   * base schema) — i.e. a DB-open failure, not a migration failure.
   */
  migrationId: string | null;
  /** ISO-8601 timestamp of the capture. */
  timestamp: string;
}

let dbInitFailure: DbInitFailure | null = null;

/**
 * The captured DB-init failure (schema apply or migration run), or null when the
 * DB last initialized cleanly. Read by the boot hook and the health route so a
 * failed migration fails CLOSED (503) instead of silently degrading. DATA-02.
 */
export function getDbInitFailure(): DbInitFailure | null {
  return dbInitFailure;
}

export function getDb(): Database.Database {
  if (!db) {
    const isNewDb = !fs.existsSync(DB_PATH);

    // DATA-02: capture any init failure into module state (getDbInitFailure)
    // and re-throw. Callers that don't handle the throw still boot far enough
    // for /api/health to read the captured failure and answer 503 fail-closed.
    let opened: Database.Database | null = null;
    try {
      opened = new Database(DB_PATH);
      opened.pragma('journal_mode = WAL');
      opened.pragma('foreign_keys = ON');

      // Initialize base schema (creates tables if they don't exist)
      opened.exec(schema);

      // Run migrations for schema updates
      // This handles both new and existing databases
      runMigrations(opened);

      // Only publish the handle after a fully successful init so a half-migrated
      // DB is never handed to a caller (and a retry re-runs the failing step).
      db = opened;
      dbInitFailure = null;

      if (isNewDb) {
        console.log('[DB] New database created at:', DB_PATH);
      }
    } catch (err) {
      dbInitFailure = {
        message: err instanceof Error ? err.message : String(err),
        migrationId: getLastFailedMigrationId(),
        timestamp: new Date().toISOString(),
      };
      // Close the half-open handle so we never leak it or reuse it on retry.
      if (opened) {
        try {
          opened.close();
        } catch {
          /* ignore secondary close errors */
        }
      }
      db = null;
      throw err;
    }
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
export { runMigrations, getMigrationStatus, reseedWorkspacesFromConfig, autoSeedTrioAgents, getLastFailedMigrationId } from './migrations';
