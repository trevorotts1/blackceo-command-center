/**
 * Rescue Rangers ticket dashboard (P13): database access.
 *
 * READ-ONLY BY CONSTRUCTION. The durable ticket store's writer
 * (fleet-heartbeat/scripts/lib/rescue-ticket-store.mjs, driven by the rescue
 * receiver and the SLA/GC sweeps) is the ONLY code that creates the schema or
 * writes ticket data. This module opens rescue-tickets.sqlite with
 * better-sqlite3 { readonly: true, fileMustExist: true }. No schema creation,
 * no migrations, no PRAGMA writes happen here.
 *
 * Pattern copied deliberately from `src/lib/podcast/db.ts` — the Command
 * Center's existing "read another process's SQLite file" precedent — right
 * down to the stale-handle re-probe, so there is one way to do this in the
 * app, not two.
 *
 * WAL NOTE (fleet memory: WAL mtime lags). The store runs `journal_mode=WAL`,
 * so the main database file's mtime does NOT advance when the receiver
 * commits — freshness must never be derived from `fs.stat`. Every consumer
 * here reads `MAX(updated_at)` out of the table instead. A readonly
 * better-sqlite3 handle still sees committed WAL frames because it opens the
 * -wal/-shm sidecars alongside the main file; that is why this module never
 * copies the .sqlite file aside before reading it (a copy WITHOUT its -wal
 * would silently serve a stale snapshot).
 *
 * ABSENCE IS NOT AN ERROR. If the store file does not exist yet (Batch C not
 * deployed on this box, or any client box, which never runs a receiver),
 * readers get null and the UI renders the empty state — never a 500.
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * Resolution order:
 *   1. RESCUE_TICKET_DB — the SAME env var the store module itself honours
 *      (rescue-ticket-store.mjs `defaultDbPath()`), so pointing the pipeline
 *      at a different file automatically points the dashboard at it too.
 *   2. The store's own default location on the operator box.
 */
export function resolveRescueDbPath(): string {
  const explicit = process.env.RESCUE_TICKET_DB;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return path.join(os.homedir(), 'clawd', 'fleet-heartbeat', 'state', 'rescue-tickets.sqlite');
}

let readDb: Database.Database | null = null;

/**
 * Read-only handle over the durable ticket store. Returns null when the file
 * does not exist yet so pages render the empty state instead of an error.
 */
export function getRescueReadDb(): Database.Database | null {
  const dbPath = resolveRescueDbPath();
  if (readDb) {
    try {
      // The handle can outlive a deleted/rotated file; re-probe before reuse.
      readDb.prepare('SELECT 1').get();
      return readDb;
    } catch {
      try {
        readDb.close();
      } catch {
        /* already dead */
      }
      readDb = null;
    }
  }
  if (!fs.existsSync(dbPath)) return null;
  try {
    readDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    return readDb;
  } catch {
    return null;
  }
}

/**
 * Does this box carry the durable store AND has the writer created its
 * tables? A file that exists but has no `tickets` table (an interrupted first
 * run) must read as "not available yet", not as "zero tickets".
 */
export function isRescueStoreAvailable(db: Database.Database | null): boolean {
  if (!db) return false;
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tickets'")
      .get() as { name?: string } | undefined;
    return !!row?.name;
  } catch {
    return false;
  }
}

/** Cheap freshness probe for polling clients; never uses file mtime (WAL). */
export function getRescueLastUpdatedAt(db: Database.Database): string | null {
  try {
    const row = db.prepare('SELECT MAX(updated_at) AS last FROM tickets').get() as
      | { last: string | null }
      | undefined;
    return row?.last ?? null;
  } catch {
    return null;
  }
}
