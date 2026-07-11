/**
 * Unauthorized-401 probe — the CONSUMER that puts the counter on the health
 * surface (FLEET-FIX 2.3 / AUD-71, spec clause "increment a counter exposed via
 * the existing health endpoint").
 *
 * Registered in `runAllProbes()` (`src/lib/system-status.ts`) next to
 * `probeCloudflareAccess`, so the number appears as a component on
 * `GET /api/system/status` and is persisted to `system_status_snapshots` by that
 * orchestrator's `persistSnapshot()` on every run.
 *
 * Data path, end to end:
 *
 *   Edge middleware rejects a caller for bad/missing credentials
 *     -> NextResponse.rewrite() to /api/internal/auth-rejected  (Node runtime)
 *       -> recordUnauthorized401()  -> unauthorized-401-store.ts (globalThis)
 *         -> THIS probe reads it    -> /api/system/status
 *
 * The middleware's own (Edge) module scope holds NO counter — it cannot, and a
 * counter there would be unreadable from here. `unauthorized-401-contract.ts`
 * documents that boundary in full.
 *
 * Status semantics (deliberate):
 *   - credential failures inside the 5-minute window -> `degraded` + `error`.
 *     Something is being turned away RIGHT NOW; on this fleet that is the
 *     signature of the dept-agent write-back trap (a bearer-less or wrong-token
 *     caller), which is the whole reason AUD-71 exists. Windowed, so it clears
 *     itself once the failures stop rather than pinning the pill forever.
 *   - otherwise -> `live`. A lifetime total > 0 with nothing recent is history,
 *     not a current fault, and must not hold the overall pill down.
 */

import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';
import {
  UNAUTHORIZED_401_WINDOW_MS,
  readUnauthorized401Counters,
} from './unauthorized-401-store';

export const UNAUTHORIZED_401_COMPONENT = 'unauthorized_401';
export const UNAUTHORIZED_401_LABEL = 'Unauthorized 401s';

export async function probeUnauthorized401(): Promise<ProbeResult> {
  const start = Date.now();

  return withTimeout<ProbeResult>(
    async () => {
      const now = Date.now();
      const counters = readUnauthorized401Counters(now);
      const windowMinutes = Math.round(UNAUTHORIZED_401_WINDOW_MS / 60_000);
      const degraded = counters.recentCount > 0;

      const detail: Record<string, unknown> = {
        // The number the spec asks to expose.
        count: counters.total,
        // The discrimination AUD-71 is FOR: an operator can tell a caller that
        // sent no Authorization header from one that sent the wrong bearer.
        byReason: counters.byReason,
        recentCount: counters.recentCount,
        windowMs: UNAUTHORIZED_401_WINDOW_MS,
        lastReason: counters.lastEvent?.reason ?? null,
        lastPathname: counters.lastEvent?.pathname ?? null,
        lastMethod: counters.lastEvent?.method ?? null,
        lastUa: counters.lastEvent?.ua ?? null,
        lastSeenAt: counters.lastEvent?.ts ?? null,
        summary: degraded
          ? `${counters.recentCount} credential-failure 401(s) in the last ${windowMinutes}m ` +
            `(missing-header: ${counters.byReason['missing-header']}, ` +
            `token-mismatch: ${counters.byReason['token-mismatch']} lifetime)`
          : counters.total > 0
            ? `no credential-failure 401s in the last ${windowMinutes}m (${counters.total} lifetime)`
            : 'no credential-failure 401s observed',
      };

      return {
        component: UNAUTHORIZED_401_COMPONENT,
        label: UNAUTHORIZED_401_LABEL,
        status: degraded ? 'degraded' : 'live',
        latencyMs: Date.now() - start,
        error: degraded
          ? `${counters.recentCount} caller(s) rejected for bad/missing credentials in the last ${windowMinutes}m`
          : undefined,
        detail,
        probedAt: new Date().toISOString(),
      };
    },
    PROBE_TIMEOUT_MS,
    () => ({
      component: UNAUTHORIZED_401_COMPONENT,
      label: UNAUTHORIZED_401_LABEL,
      status: 'offline',
      latencyMs: Date.now() - start,
      error: 'probe timed out',
      probedAt: new Date().toISOString(),
    })
  );
}

/** Re-exported so callers have one import site for the whole unit. */
export {
  readUnauthorized401Counters,
  recordUnauthorized401,
  __resetUnauthorized401Store,
  UNAUTHORIZED_401_WINDOW_MS,
} from './unauthorized-401-store';
export type { Unauthorized401Counters } from './unauthorized-401-store';
