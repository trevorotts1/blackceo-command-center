import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { schema } from './schema';
import { runMigrations, getLastFailedMigrationId } from './migrations';

/**
 * C8 HARD-ISOLATION GUARD.
 *
 * DB_PATH used to be `process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db')`
 * — a SILENT fallback to the LIVE database for any process that reached this
 * module without DATABASE_PATH set. That is exactly how test/maintenance
 * scripts leaked fixtures (test-dept SOPs, smoke-test-dept/no-script-dept
 * workspaces, the testco company row) straight into a production Kanban board
 * — the live cron then advanced and Telegram-notified on them (the C8 leak
 * class; see tests/unit/c8-db-isolation-guard.test.ts, the sop-embedding-provider
 * and p4-01-persona-reason-blend-rationale test comments, and the July-14
 * "EMERGENCY DISARM" note in .env.local).
 *
 * Resolution order now:
 *   1. DATABASE_PATH env var — an explicit override always wins. This is how
 *      the real server's process manager points at the live file (e.g.
 *      ecosystem.cc-prod.config.cjs), and how every isolated test/script
 *      points at its own throwaway file (tests/unit/_isolated-db.ts et al.).
 *   2. The REAL Next.js server process, with NO DATABASE_PATH set — detected
 *      via an explicit IN-PROCESS marker (`globalThis.__CC_SERVER_ENTRYPOINT__`)
 *      that src/instrumentation.ts sets as the very first statement of the
 *      Next.js boot hook, before it ever imports this module. This is
 *      deliberately NOT an env var: nothing outside this process's own
 *      compiled code — no ecosystem/pm2 file, no hand-edited .env, no shell
 *      export a script could inherit or copy — can set it. Only the server's
 *      own entrypoint running in THIS process can. Falls back to the historic
 *      default (`process.cwd()/mission-control.db`) so the server keeps
 *      working with zero box-local config, exactly as before this change.
 *   3. Anything else — a script, a test, `tsx`/`node` run ad-hoc from the app
 *      directory, a maintenance one-liner — HARD-FAILS at module-evaluation
 *      time with a clear, actionable error instead of silently opening the
 *      live database. This is the actual fix: the failure mode changes from
 *      "silent corruption of production data" to "the script won't start
 *      until you set DATABASE_PATH."
 *
 * Exported so other server-side modules (e.g. persona-selector.ts) can pass
 * it as DASHBOARD_DB_PATH in subprocess env — making the Python selector hit
 * the correct DB on both Mac and VPS layouts without its own candidate-list
 * heuristics.
 */
declare global {
  // eslint-disable-next-line no-var
  var __CC_SERVER_ENTRYPOINT__: boolean | undefined;
}

function resolveDbPath(): string {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;

  if (globalThis.__CC_SERVER_ENTRYPOINT__ === true) {
    return path.join(process.cwd(), 'mission-control.db');
  }

  throw new Error(
    '[db] C8 GUARD: refusing to resolve a database path. DATABASE_PATH is not set, and this process ' +
      'is not the Command Center server (no __CC_SERVER_ENTRYPOINT__ marker from src/instrumentation.ts). ' +
      'Falling through here would silently open the LIVE mission-control.db and let this process write ' +
      'into a production Kanban board (the C8 leak class). Set DATABASE_PATH to an explicit, non-live ' +
      'path before importing @/lib/db — e.g. `import \'./_isolated-db\';` as the FIRST import in a test, ' +
      'or `DATABASE_PATH=/tmp/whatever.db` for a one-off script.',
  );
}

export const DB_PATH = resolveDbPath();

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

// ---------------------------------------------------------------------------
// B2 — canonical timestamp helpers (timestamp-dialect fix)
// ---------------------------------------------------------------------------
//
// mission-control.db stores timestamps in TWO dialects inside the SAME TEXT
// columns:
//   • ISO-8601 with a 'T' separator and 'Z' suffix — `new Date().toISOString()`
//     (every Node writer), e.g. `2026-07-10T18:40:29.584Z`.
//   • SQLite space-separated — `datetime('now')`, e.g. `2026-07-10 18:40:29`.
//
// A naive TEXT comparison `col >= datetime('now','-10 minutes')` is WRONG: 'T'
// (0x54) sorts AFTER ' ' (0x20) at index 10, so an ISO-'T' value ALWAYS compares
// "greater" than a space-format bound regardless of the real instant. Every time
// window (QC re-score, stale, dispatch backoff) silently degenerates — a proven
// 10-minute QC window became "the rest of the UTC day". These helpers give every
// writer one canonical format and every window predicate a dialect-safe compare.

/** Canonical write format for every new timestamp (ISO-8601, UTC). ALL writers
 *  should use this so new rows land in a single dialect. */
export function timeNow(): string {
  return new Date().toISOString();
}

/**
 * Wrap a SQL time expression (a column reference OR a bound `?` placeholder) so
 * BOTH dialects compare correctly. `replace(replace(expr,'T',' '),'Z','')` folds
 * the ISO-'T'/'Z' form to the SQLite space form and the outer `datetime(...)`
 * parses it to a single canonical instant. Apply to EVERY side of a time-window
 * predicate, e.g.
 *   `${sqlTime('e.created_at')} >= datetime('now','-10 minutes')`
 *   `${sqlTime('t.updated_at')} <= ${sqlTime('?')}`
 */
export function sqlTime(expr: string): string {
  return `datetime(replace(replace(${expr}, 'T', ' '), 'Z', ''))`;
}

/**
 * Sub-second-precise sibling of `sqlTime()` (MODEL-07).
 *
 * `sqlTime()` wraps `datetime(...)`, which TRUNCATES to whole seconds. That is
 * fine for minute/day-scale windows, but it is NOT safe when the two sides of a
 * comparison can land inside the SAME SECOND — the truncation collapses them to
 * equal and a strict `<` / `>` silently becomes false.
 *
 * `julianday(...)` parses the same normalized value to a REAL (a true numeric
 * instant) and PRESERVES fractional seconds, so the comparison stays correct at
 * millisecond resolution. Use this for any predicate where the bound is "now"
 * and the column may have been written moments earlier in the same run — e.g.
 * the model-registry deprecation cutoff, where a same-second collapse would let
 * a model that genuinely vanished from the provider catalog escape tombstoning.
 *
 * Like `sqlTime()`, it folds the ISO 'T'/'Z' dialect to the SQLite space form
 * first, so it is correct for BOTH dialects. This is a real datetime comparison,
 * never a lexicographic byte-sort.
 */
export function sqlTimePrecise(expr: string): string {
  return `julianday(replace(replace(${expr}, 'T', ' '), 'Z', ''))`;
}

/**
 * Parse a DB timestamp string to epoch millis, correcting the space-dialect
 * misparse. `new Date('2026-07-10 18:40:29')` is read as LOCAL time by V8 (age
 * shifts by the box's UTC offset), whereas the ISO-'T'-'Z' form parses as UTC.
 * Both dialects store UTC, so normalize the space form to ISO-UTC before parsing.
 * Returns NaN for empty / unparseable input.
 */
export function parseDbTime(ts: string | null | undefined): number {
  if (!ts) return NaN;
  let s = String(ts).trim();
  if (!s) return NaN;
  // SQLite space form 'YYYY-MM-DD HH:MM:SS' → ISO 'YYYY-MM-DDTHH:MM:SS'.
  if (!s.includes('T') && s.includes(' ')) s = s.replace(' ', 'T');
  // No timezone marker → the value is UTC → append 'Z' so V8 parses it as UTC.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s = `${s}Z`;
  return Date.parse(s);
}

// Export migration utilities for CLI use
export { runMigrations, getMigrationStatus, reseedWorkspacesFromConfig, autoSeedTrioAgents, getLastFailedMigrationId, checkDispatchSchemaHealth } from './migrations';
export type { DispatchSchemaHealth } from './migrations';
