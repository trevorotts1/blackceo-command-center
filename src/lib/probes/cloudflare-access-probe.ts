/**
 * Cloudflare Access probe — confirms that Cloudflare Access is actively in
 * front of this deployment by observing `Cf-Access-Jwt-Assertion` headers on
 * recent inbound requests.
 *
 * The middleware calls `recordCfAccessSeen()` every time it sees the header,
 * keyed by the authenticated user email (or `anon` if absent). We keep a
 * module-level Map and prune anything older than 30 seconds before each read.
 *
 * Status logic:
 *   - a header was seen within the last 30 seconds     -> live
 *   - REQUIRE_CF_ACCESS=true, requests arrived recently but NONE carried
 *     the header                                      -> degraded (a real
 *     bypass or misconfiguration)
 *   - REQUIRE_CF_ACCESS=true and no requests at all in the window
 *     (idle box, or just restarted)                   -> live, idle (absence
 *     of traffic is not evidence that Access is broken)
 *   - REQUIRE_CF_ACCESS!=true (dev mode)               -> live, bypassed
 */

import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

const WINDOW_MS = 30 * 1000;

/** Module-level cache, key -> last seen epoch ms. */
const lastSeen = new Map<string, number>();
/** Last time ANY non-exempt request arrived WITHOUT the Access header. */
let lastRequestWithoutJwt: number | null = null;

/**
 * Middleware hook. Called on every inbound request that carries the
 * `cf-access-jwt-assertion` header. `subject` should be the authenticated
 * email when available, otherwise any stable token (or `anon`).
 */
export function recordCfAccessSeen(subject?: string | null, hadJwt: boolean = true): void {
  if (!hadJwt) {
    lastRequestWithoutJwt = Date.now();
    return;
  }
  const key = subject && subject.length > 0 ? subject : 'anon';
  lastSeen.set(key, Date.now());
}

function prune(now: number): void {
  const toDelete: string[] = [];
  lastSeen.forEach((ts, k) => {
    if (now - ts > WINDOW_MS) toDelete.push(k);
  });
  for (const k of toDelete) lastSeen.delete(k);
}

function newestTimestamp(): number | null {
  let max: number | null = null;
  lastSeen.forEach((ts) => {
    if (max === null || ts > max) max = ts;
  });
  return max;
}

export async function probeCloudflareAccess(): Promise<ProbeResult> {
  const start = Date.now();

  return withTimeout<ProbeResult>(
    async () => {
      const now = Date.now();
      prune(now);

      const requireCfAccess = process.env.REQUIRE_CF_ACCESS === 'true';
      const newest = newestTimestamp();
      const sawRecent = newest !== null && now - newest <= WINDOW_MS;
      const observedSubjects = lastSeen.size;

      if (sawRecent) {
        return {
          component: 'cloudflare_access',
          label: 'Cloudflare Access',
          status: 'live',
          latencyMs: Date.now() - start,
          detail: {
            requireCfAccess,
            observedSubjects,
            lastSeenAgeMs: newest !== null ? now - newest : null,
            summary: 'CF Access JWT observed within the last 30s',
          },
          probedAt: new Date().toISOString(),
        };
      }

      if (!requireCfAccess) {
        return {
          component: 'cloudflare_access',
          label: 'Cloudflare Access',
          status: 'live',
          latencyMs: Date.now() - start,
          detail: {
            requireCfAccess: false,
            observedSubjects: 0,
            summary: 'dev mode bypassed, REQUIRE_CF_ACCESS is not true',
          },
          probedAt: new Date().toISOString(),
        };
      }

      // Nothing carried the header. That only means something if requests
      // actually arrived without it; an idle window proves nothing.
      const arrivedWithout = lastRequestWithoutJwt !== null && now - lastRequestWithoutJwt <= WINDOW_MS;
      if (!arrivedWithout) {
        return {
          component: 'cloudflare_access',
          label: 'Cloudflare Access',
          status: 'live',
          latencyMs: Date.now() - start,
          detail: {
            requireCfAccess: true,
            observedSubjects: 0,
            idle: true,
            summary: 'no requests in the last 30s, so there is nothing to check yet (idle is not a fault)',
          },
          probedAt: new Date().toISOString(),
        };
      }

      return {
        component: 'cloudflare_access',
        label: 'Cloudflare Access',
        status: 'degraded',
        latencyMs: Date.now() - start,
        error: 'requests arrived without a CF Access JWT in the last 30s',
        detail: {
          requireCfAccess: true,
          observedSubjects: 0,
          summary: 'requests arrived without a CF Access JWT in the last 30s',
        },
        probedAt: new Date().toISOString(),
      };
    },
    PROBE_TIMEOUT_MS,
    () => ({
      component: 'cloudflare_access',
      label: 'Cloudflare Access',
      status: 'offline',
      latencyMs: Date.now() - start,
      error: 'probe timed out',
      probedAt: new Date().toISOString(),
    })
  );
}

/** Test-only: clears the in-memory observation map. */
export function __resetCfAccessProbe(): void {
  lastSeen.clear();
  lastRequestWithoutJwt = null;
}
