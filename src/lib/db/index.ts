import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { schema } from './schema';
import { runMigrations } from './migrations';

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

export function getDb(): Database.Database {
  if (!db) {
    const isNewDb = !fs.existsSync(DB_PATH);
    
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Initialize base schema (creates tables if they don't exist)
    db.exec(schema);

    // Run migrations for schema updates
    // This handles both new and existing databases
    runMigrations(db);
    
    if (isNewDb) {
      console.log('[DB] New database created at:', DB_PATH);
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
export { runMigrations, getMigrationStatus } from './migrations';
