/**
 * System Status orchestrator (PRD Section 3.12).
 *
 * Runs every probe in parallel, persists each result as a row in
 * system_status_snapshots, and returns a single aggregated payload for the
 * API/UI. A 30-second cache is applied at the API layer; this function
 * itself is always fresh.
 */

import { getDb } from '@/lib/db';
import { probeDatabase } from './probes/db';
import { probeOpenClawGateway } from './probes/openclaw-gateway';
import { probeModelProviders } from './probes/model-providers';
import { probeTelegram } from './probes/telegram';
import { probeMemory } from './probes/memory';
import { probeJobs } from './probes/jobs';
import { probeDisk } from './probes/disk';
import { probeAgents } from './probes/agents';
import {
  ProbeResult,
  SystemStatus,
  worstStatus,
} from './probes/types';

export interface SystemStatusPayload {
  overall: SystemStatus;
  probedAt: string;
  components: ProbeResult[];
  fromCache: boolean;
  cacheAgeMs: number | null;
}

/** Cache TTL for the API layer (PRD 3.12 specifies a 30-second cache). */
export const STATUS_CACHE_TTL_MS = 30 * 1000;

function persistSnapshot(result: ProbeResult): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO system_status_snapshots (probed_at, component, status, latency_ms, error, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      result.probedAt,
      result.component,
      result.status,
      result.latencyMs,
      result.error || null,
      JSON.stringify(result.detail || {})
    );
  } catch (err) {
    // Persistence failure should never break the response. Log and move on.
    console.error('[system-status] failed to persist snapshot:', err);
  }
}

/**
 * Run every probe in parallel and return the aggregated payload.
 * Each probe enforces its own timeout (PROBE_TIMEOUT_MS in probes/types.ts).
 */
export async function runAllProbes(): Promise<SystemStatusPayload> {
  const [
    database,
    openclaw,
    providers,
    telegram,
    memory,
    jobs,
    disk,
    agents,
  ] = await Promise.all([
    probeDatabase(),
    probeOpenClawGateway(),
    probeModelProviders(),
    probeTelegram(),
    probeMemory(),
    probeJobs(),
    probeDisk(),
    probeAgents(),
  ]);

  const components: ProbeResult[] = [
    database,
    openclaw,
    ...providers,
    telegram,
    memory,
    jobs,
    disk,
    agents,
  ];

  for (const c of components) persistSnapshot(c);

  // Overall pill color reflects the worst non-provider status, with providers
  // considered too. Unknown providers (no key) do not degrade the overall.
  const considered = components.filter(
    (c) => !(c.component.startsWith('provider_') && c.status === 'unknown')
  );
  const overall = worstStatus(considered.map((c) => c.status));

  return {
    overall,
    probedAt: new Date().toISOString(),
    components,
    fromCache: false,
    cacheAgeMs: null,
  };
}

/**
 * Build the payload from the latest row per component in
 * system_status_snapshots. Returns null if there is no cached data or it is
 * older than STATUS_CACHE_TTL_MS.
 */
export function readCachedStatus(): SystemStatusPayload | null {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT s.* FROM system_status_snapshots s
         JOIN (
           SELECT component, MAX(probed_at) AS max_probed_at
           FROM system_status_snapshots
           GROUP BY component
         ) latest
         ON s.component = latest.component AND s.probed_at = latest.max_probed_at`
      )
      .all() as Array<{
        component: string;
        status: string;
        probed_at: string;
        latency_ms: number | null;
        error: string | null;
        metadata: string | null;
      }>;

    if (rows.length === 0) return null;

    const newest = rows.reduce((acc, r) =>
      new Date(r.probed_at + 'Z').getTime() > new Date(acc.probed_at + 'Z').getTime() ? r : acc
    );
    const cacheAgeMs = Date.now() - new Date(newest.probed_at + 'Z').getTime();
    if (!Number.isFinite(cacheAgeMs) || cacheAgeMs > STATUS_CACHE_TTL_MS) {
      return null;
    }

    const components: ProbeResult[] = rows.map((r) => ({
      component: r.component,
      label: labelFor(r.component),
      status: normalizeStatus(r.status),
      latencyMs: r.latency_ms,
      error: r.error || undefined,
      detail: r.metadata ? safeParse(r.metadata) : undefined,
      probedAt: r.probed_at,
    }));

    const considered = components.filter(
      (c) => !(c.component.startsWith('provider_') && c.status === 'unknown')
    );
    const overall = worstStatus(considered.map((c) => c.status));

    return {
      overall,
      probedAt: newest.probed_at,
      components,
      fromCache: true,
      cacheAgeMs,
    };
  } catch (err) {
    console.error('[system-status] cache read failed:', err);
    return null;
  }
}

/** Cached read with `force` bypass — entry point used by the API route. */
export async function getSystemStatus(opts: { force?: boolean } = {}): Promise<SystemStatusPayload> {
  if (!opts.force) {
    const cached = readCachedStatus();
    if (cached) return cached;
  }
  return runAllProbes();
}

function normalizeStatus(s: string): SystemStatus {
  if (s === 'ok') return 'live';
  if (s === 'down') return 'offline';
  if (
    s === 'live' ||
    s === 'working' ||
    s === 'busy' ||
    s === 'degraded' ||
    s === 'offline' ||
    s === 'unknown'
  ) {
    return s;
  }
  return 'unknown';
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function labelFor(component: string): string {
  const labels: Record<string, string> = {
    database: 'Database',
    openclaw_gateway: 'OpenClaw Gateway',
    telegram: 'Telegram',
    memory: 'Memory',
    jobs: 'Background Jobs',
    disk: 'Disk',
    agents: 'Agents',
    provider_openrouter: 'OpenRouter',
    provider_anthropic: 'Anthropic',
    provider_openai: 'OpenAI',
    provider_google: 'Google',
    provider_zai: 'Z.AI',
    provider_moonshot: 'Moonshot',
    provider_minimax: 'MiniMax',
    provider_kieai: 'Kie.ai',
    provider_falai: 'Fal.ai',
    provider_ollama_cloud: 'Ollama Cloud',
  };
  return labels[component] || component;
}
