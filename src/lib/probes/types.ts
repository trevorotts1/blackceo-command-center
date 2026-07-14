/**
 * Shared probe types for the System Status Panel (PRD Section 3.12).
 *
 * The six-state vocabulary is canonical across the codebase. `ok` is accepted
 * as an alias for `live` so simpler downstream consumers can normalize either
 * token. Migration 033 widened the system_status_snapshots CHECK constraint
 * to accept this exact set.
 */

export type SystemStatus =
  | 'live'
  | 'working'
  | 'busy'
  | 'degraded'
  | 'offline'
  | 'unknown';

export interface ProbeResult {
  /** Stable identifier written to system_status_snapshots.component. */
  component: string;
  /** Human-readable label rendered in the status drawer. */
  label: string;
  /** Six-state status. */
  status: SystemStatus;
  /** Probe duration in milliseconds. Null if the probe never ran. */
  latencyMs: number | null;
  /** Last error string when status is degraded or offline. */
  error?: string;
  /** Probe-specific structured detail rendered in the drawer rows. */
  detail?: Record<string, unknown>;
  /** ISO timestamp when this probe finished. */
  probedAt: string;
}

export interface ProbeFn {
  (): Promise<ProbeResult>;
}

/**
 * Criticality tier (U46 — "make 'down' mean down").
 *
 * `critical` components gate the whole-app `overall` status to `offline`
 * when unhealthy; everything else is `auxiliary` and can only ever push
 * `overall` down to `degraded`, never to `offline`.
 */
export type ProbeTier = 'critical' | 'auxiliary';

/**
 * The critical set per U46's binary spec: database + the OpenClaw gateway.
 * Everything else (telegram, memory, jobs, disk, agents, cli, the two
 * Cloudflare probes, unauthorized_401, and every provider_* row) is
 * auxiliary. Kept as a readonly list (not a Set) so it stays trivially
 * diffable in review.
 */
export const CRITICAL_COMPONENTS: readonly string[] = [
  'database',
  'openclaw_gateway',
];

/** Tier lookup used by both the fresh-probe and cached-read code paths. */
export function tierFor(component: string): ProbeTier {
  return CRITICAL_COMPONENTS.includes(component) ? 'critical' : 'auxiliary';
}

/** A probe result once it has been tagged with its criticality tier. */
export interface TieredProbeResult extends ProbeResult {
  tier: ProbeTier;
}

/** Minimal shape `computeOverallTiered` needs — component id, tier, status. */
export interface TieredStatusInput {
  component: string;
  tier: ProbeTier;
  status: SystemStatus;
}

/**
 * Criticality-tiered aggregation (U46).
 *
 * `offline` only if a critical component is `offline`.
 * `degraded` if any critical component is unhealthy-but-not-offline
 * (degraded/unknown/busy/working — a critical component that isn't a clean
 * `live` must never be silently reported as fully healthy), OR criticals are
 * all `live` but at least one auxiliary component is `offline`/`degraded`/
 * `unknown`.
 * `live` otherwise.
 *
 * Both the fresh-probe path (`runAllProbes`) and the cached-read path
 * (`readCachedStatus`) in system-status.ts call this SAME function so their
 * `overall` values are identical for identical inputs by construction.
 */
export function computeOverallTiered(components: TieredStatusInput[]): SystemStatus {
  const critical = components.filter((c) => c.tier === 'critical').map((c) => c.status);
  const auxiliary = components.filter((c) => c.tier === 'auxiliary').map((c) => c.status);

  if (critical.includes('offline')) return 'offline';

  const criticalUnhealthy = critical.some((s) => s !== 'live');
  const auxiliaryUnhealthy = auxiliary.some(
    (s) => s === 'offline' || s === 'degraded' || s === 'unknown'
  );

  if (criticalUnhealthy || auxiliaryUnhealthy) return 'degraded';

  return 'live';
}

/**
 * Wrap a probe with a hard timeout. Probes must never block the orchestrator
 * for more than ~3 seconds (PRD 3.12 calls out non-blocking probes).
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  onTimeout: () => T
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    const result = await Promise.race([fn(), timeout]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Default probe timeout per PRD 3.12 non-blocking requirement. */
export const PROBE_TIMEOUT_MS = 3000;

/** Aggregate a set of probe statuses to a single worst-case status. */
export function worstStatus(statuses: SystemStatus[]): SystemStatus {
  // Priority order from worst to best so the pill reflects the most severe.
  const order: SystemStatus[] = [
    'offline',
    'degraded',
    'busy',
    'working',
    'unknown',
    'live',
  ];
  for (const s of order) {
    if (statuses.includes(s)) return s;
  }
  return 'unknown';
}
