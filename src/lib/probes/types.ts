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
