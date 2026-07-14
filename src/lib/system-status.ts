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
import { probeCli } from './probes/cli-probe';
import { probeCloudflareTunnel } from './probes/cloudflare-tunnel-probe';
import { probeCloudflareAccess } from './probes/cloudflare-access-probe';
import { probeUnauthorized401 } from './probes/unauthorized-401-probe';
import {
  computeOverallTiered,
  ProbeResult,
  SystemStatus,
  TieredProbeResult,
  tierFor,
} from './probes/types';

export interface SystemStatusPayload {
  overall: SystemStatus;
  probedAt: string;
  components: TieredProbeResult[];
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
    cli,
    cloudflareTunnel,
    cloudflareAccess,
    unauthorized401,
  ] = await Promise.all([
    probeDatabase(),
    probeOpenClawGateway(),
    probeModelProviders(),
    probeTelegram(),
    probeMemory(),
    probeJobs(),
    probeDisk(),
    probeAgents(),
    probeCli(),
    probeCloudflareTunnel(),
    probeCloudflareAccess(),
    // FLEET-FIX 2.3 / AUD-71 — the CONSUMER of the middleware 401 counter. The
    // spec clause is "increment a counter exposed via the existing health
    // endpoint"; registering the probe HERE is what exposes it. Without this
    // line the counter is a producer with no consumer and the clause is unmet.
    probeUnauthorized401(),
  ]);

  const raw: ProbeResult[] = [
    database,
    openclaw,
    ...providers,
    telegram,
    memory,
    jobs,
    disk,
    agents,
    cli,
    cloudflareTunnel,
    cloudflareAccess,
    unauthorized401,
  ];

  for (const c of raw) persistSnapshot(c);

  // U46 — every component row carries its criticality tier (database +
  // openclaw_gateway are `critical`; everything else is `auxiliary`).
  const components: TieredProbeResult[] = raw.map((c) => ({
    ...c,
    tier: tierFor(c.component),
  }));

  // Overall reflects criticality-tiered aggregation, not a flat worst-of-all
  // reduction: a critical outage means `offline`; an auxiliary problem never
  // does. Unknown providers (no key) do not degrade the overall.
  const considered = components.filter(
    (c) => !(c.component.startsWith('provider_') && c.status === 'unknown')
  );
  const overall = computeOverallTiered(considered);

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

    // FALSE-GREEN FIX (§5 guidance, item 4):
    // probed_at is stored as a full ISO-8601 string that already ends in 'Z'
    // (written via new Date().toISOString()).  Appending another 'Z' produces
    // "...ZZ" which Date.parse returns NaN, making cacheAgeMs NaN, causing
    // Number.isFinite(NaN) === false, causing the cache to NEVER serve a hit,
    // forcing every request to re-run all probes regardless of TTL.
    // Fix: parse directly without appending 'Z'.
    const parseTs = (ts: string): number => {
      const ms = Date.parse(ts);
      return Number.isFinite(ms) ? ms : 0;
    };

    const newest = rows.reduce((acc, r) =>
      parseTs(r.probed_at) > parseTs(acc.probed_at) ? r : acc
    );
    const cacheAgeMs = Date.now() - parseTs(newest.probed_at);
    if (!Number.isFinite(cacheAgeMs) || cacheAgeMs > STATUS_CACHE_TTL_MS) {
      return null;
    }

    // U46 — every component row carries its criticality tier here too, so
    // the cached-read path tags rows identically to the fresh-probe path.
    const components: TieredProbeResult[] = rows.map((r) => ({
      component: r.component,
      label: labelFor(r.component),
      status: normalizeStatus(r.status),
      latencyMs: r.latency_ms,
      error: r.error || undefined,
      detail: r.metadata ? safeParse(r.metadata) : undefined,
      probedAt: r.probed_at,
      tier: tierFor(r.component),
    }));

    const considered = components.filter(
      (c) => !(c.component.startsWith('provider_') && c.status === 'unknown')
    );
    // Same shared function as the fresh path — identical inputs (same
    // component/tier/status triples) always produce an identical `overall`.
    const overall = computeOverallTiered(considered);

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
    cli: 'Operator CLIs',
    cloudflare_tunnel: 'Cloudflare Tunnel',
    cloudflare_access: 'Cloudflare Access',
    unauthorized_401: 'Unauthorized 401s',
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
