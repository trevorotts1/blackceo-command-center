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
 *   - REQUIRE_CF_ACCESS=true but nothing seen recently -> degraded
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

/**
 * Middleware hook. Called on every inbound request that carries the
 * `cf-access-jwt-assertion` header. `subject` should be the authenticated
 * email when available, otherwise any stable token (or `anon`).
 */
export function recordCfAccessSeen(subject?: string | null): void {
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

      return {
        component: 'cloudflare_access',
        label: 'Cloudflare Access',
        status: 'degraded',
        latencyMs: Date.now() - start,
        error: 'expected CF Access JWT but none observed in last 30s',
        detail: {
          requireCfAccess: true,
          observedSubjects: 0,
          summary: 'expected CF Access JWT but none observed in last 30s',
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
}
