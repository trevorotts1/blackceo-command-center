/**
 * Memory probe — reports the size of the agent memory ledger (agent_memory_logs)
 * and whether the most recent write happened within the last 24h.
 *
 * A memory subsystem that hasn't written in a day on an active deployment is
 * suspicious; we flag it as `degraded` rather than `offline` because the DB
 * itself is reachable in that case.
 */

import { getDb } from '@/lib/db';
import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

export async function probeMemory(): Promise<ProbeResult> {
  const start = Date.now();

  return withTimeout<ProbeResult>(
    async () => {
      try {
        const db = getDb();
        const tableExists = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_memory_logs'"
          )
          .get();

        if (!tableExists) {
          return {
            component: 'memory',
            label: 'Memory',
            status: 'unknown',
            latencyMs: Date.now() - start,
            detail: { tablePresent: false },
            probedAt: new Date().toISOString(),
          };
        }

        const count = db
          .prepare('SELECT COUNT(*) AS n FROM agent_memory_logs')
          .get() as { n: number };
        const latestRow = db
          .prepare(
            'SELECT created_at FROM agent_memory_logs ORDER BY created_at DESC LIMIT 1'
          )
          .get() as { created_at: string } | undefined;

        const latestAt = latestRow?.created_at || null;
        let status: ProbeResult['status'] = 'live';
        let error: string | undefined;

        if (count.n === 0) {
          status = 'unknown';
        } else if (latestAt) {
          const ageMs = Date.now() - new Date(latestAt + 'Z').getTime();
          if (Number.isFinite(ageMs) && ageMs > 24 * 60 * 60 * 1000) {
            status = 'degraded';
            error = 'no memory writes in the last 24h';
          }
        }

        return {
          component: 'memory',
          label: 'Memory',
          status,
          latencyMs: Date.now() - start,
          error,
          detail: {
            entries: count.n,
            latestAt,
          },
          probedAt: new Date().toISOString(),
        };
      } catch (err) {
        return {
          component: 'memory',
          label: 'Memory',
          status: 'offline',
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
          probedAt: new Date().toISOString(),
        };
      }
    },
    PROBE_TIMEOUT_MS,
    () => ({
      component: 'memory',
      label: 'Memory',
      status: 'offline',
      latencyMs: Date.now() - start,
      error: 'probe timed out',
      probedAt: new Date().toISOString(),
    })
  );
}
