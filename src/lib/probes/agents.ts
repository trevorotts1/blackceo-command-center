/**
 * Agents probe — aggregates agent status counts and reports the worst-case
 * status across the fleet.
 *
 * If any agent is `degraded`, the overall component is degraded.
 * If any agent is `busy` (but none degraded), the component is busy.
 * If any agent is `working`, the component is working.
 * Otherwise it is live.
 */

import { getDb } from '@/lib/db';
import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  SystemStatus,
  withTimeout,
} from './types';

interface AgentRow {
  status: string;
  n: number;
}

export async function probeAgents(): Promise<ProbeResult> {
  const start = Date.now();

  return withTimeout<ProbeResult>(
    async () => {
      try {
        const db = getDb();
        const tablePresent = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'"
          )
          .get();
        if (!tablePresent) {
          return {
            component: 'agents',
            label: 'Agents',
            status: 'unknown',
            latencyMs: Date.now() - start,
            detail: { tablePresent: false },
            probedAt: new Date().toISOString(),
          };
        }

        const rows = db
          .prepare('SELECT status, COUNT(*) AS n FROM agents GROUP BY status')
          .all() as AgentRow[];

        const counts: Record<string, number> = {
          standby: 0,
          working: 0,
          busy: 0,
          degraded: 0,
          offline: 0,
        };
        for (const r of rows) counts[r.status] = r.n;

        let status: SystemStatus = 'live';
        if (counts.degraded > 0) status = 'degraded';
        else if (counts.busy > 0) status = 'busy';
        else if (counts.working > 0) status = 'working';

        const total = Object.values(counts).reduce((a, b) => a + b, 0);

        return {
          component: 'agents',
          label: 'Agents',
          status,
          latencyMs: Date.now() - start,
          detail: { counts, total },
          probedAt: new Date().toISOString(),
        };
      } catch (err) {
        return {
          component: 'agents',
          label: 'Agents',
          status: 'offline',
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
          probedAt: new Date().toISOString(),
        };
      }
    },
    PROBE_TIMEOUT_MS,
    () => ({
      component: 'agents',
      label: 'Agents',
      status: 'offline',
      latencyMs: Date.now() - start,
      error: 'probe timed out',
      probedAt: new Date().toISOString(),
    })
  );
}
