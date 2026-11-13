/**
 * Database probe — confirms the SQLite connection is reachable, reports file
 * size, applied vs expected migration counts, and the last backup timestamp.
 */

import fs from 'fs';
import path from 'path';
import { getDb, getMigrationStatus } from '@/lib/db';
import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db');

export async function probeDatabase(): Promise<ProbeResult> {
  const start = Date.now();

  return withTimeout<ProbeResult>(
    async () => {
      try {
        const db = getDb();
        // Cheap query to confirm the handle is alive.
        const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
        if (!row || row.ok !== 1) {
          return offline(start, 'SELECT 1 returned no row');
        }

        // File size on disk.
        let fileSize = 0;
        try {
          fileSize = fs.statSync(DB_PATH).size;
        } catch {
          // Non-fatal — file might be on a different absolute path in some envs.
        }

        // Applied vs expected migration count. The migration runner keys
        // applied-state on `_migrations` alone; `schema_migrations` is not
        // created by any migration, so the old query against it always threw
        // and appliedCount was pinned at 0 — which, with a real pending count,
        // would have made this critical probe permanently degraded.
        let appliedCount = 0;
        let pendingCount = 0;
        try {
          const migrationStatus = getMigrationStatus(db);
          appliedCount = migrationStatus.applied.length;
          pendingCount = migrationStatus.pending.length;
        } catch {
          // Registry unavailable — report what we know rather than guess.
        }
        const expectedCount = appliedCount + pendingCount;

        // Last backup timestamp from the manifest table if present.
        let lastBackupAt: string | null = null;
        try {
          const r = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='backup_log'"
            )
            .get();
          if (r) {
            const b = db
              .prepare('SELECT created_at FROM backup_log ORDER BY created_at DESC LIMIT 1')
              .get() as { created_at: string } | undefined;
            lastBackupAt = b?.created_at ?? null;
          }
        } catch {
          // Optional table.
        }

        const migrationsGap = expectedCount - appliedCount;
        const status =
          migrationsGap > 0
            ? ('degraded' as const)
            : ('live' as const);
        const error =
          migrationsGap > 0
            ? `${migrationsGap} migration(s) pending`
            : undefined;

        return {
          component: 'database',
          label: 'Database',
          status,
          latencyMs: Date.now() - start,
          error,
          detail: {
            path: DB_PATH,
            fileSizeBytes: fileSize,
            appliedMigrations: appliedCount,
            expectedMigrations: expectedCount,
            lastBackupAt,
          },
          probedAt: new Date().toISOString(),
        };
      } catch (err) {
        return offline(start, err instanceof Error ? err.message : String(err));
      }
    },
    PROBE_TIMEOUT_MS,
    () => offline(start, 'probe timed out')
  );
}

function offline(start: number, message: string): ProbeResult {
  return {
    component: 'database',
    label: 'Database',
    status: 'offline',
    latencyMs: Date.now() - start,
    error: message,
    detail: { path: DB_PATH },
    probedAt: new Date().toISOString(),
  };
}
