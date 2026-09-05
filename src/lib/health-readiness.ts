import { computeOverallTiered, type SystemStatus, type TieredProbeResult } from './probes/types';

export type HealthTier = 'healthy' | 'degraded' | 'unavailable' | 'checking' | 'unknown';
export interface StatusPayload {
  overall: SystemStatus;
  probedAt: string;
  components: TieredProbeResult[];
  fromCache: boolean;
  cacheAgeMs: number | null;
}

const statuses = new Set(['live', 'working', 'busy', 'degraded', 'offline', 'unknown']);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Readiness, not HTTP reachability: use the server's tiered probe contract,
 * plus migration/embedding readiness which /api/health deliberately keeps
 * separate from liveness. An incomplete result can never certify health. */
export function parseReadiness(status: unknown, health: unknown): { tier: HealthTier; payload: StatusPayload | null } {
  if (!record(status) || !statuses.has(String(status.overall)) || !Array.isArray(status.components)
    || typeof status.probedAt !== 'string' || !record(health) || !record(health.embeddings)
    || !['ok', 'degraded', 'error'].includes(String(health.status))
    || !['ok', 'degraded'].includes(String(health.embeddings.status))
    || typeof health.embeddings.degraded !== 'boolean') {
    return { tier: 'unknown', payload: null };
  }
  const components: TieredProbeResult[] = [];
  for (const item of status.components) {
    if (!record(item) || typeof item.component !== 'string' || typeof item.label !== 'string'
      || !statuses.has(String(item.status)) || !['critical', 'auxiliary'].includes(String(item.tier))
      || typeof item.probedAt !== 'string') return { tier: 'unknown', payload: null };
    components.push(item as unknown as TieredProbeResult);
  }
  // These are required server probes, not optional provider connections.
  if (!['database', 'openclaw_gateway'].every((id) => components.some((c) => c.component === id))) {
    return { tier: 'unknown', payload: null };
  }
  components.push({
    component: 'embedding_readiness', label: 'Embedding readiness', tier: 'auxiliary',
    status: health.embeddings.degraded || health.embeddings.status === 'degraded' ? 'degraded' : 'live',
    latencyMs: null, probedAt: status.probedAt,
  });
  const computed = computeOverallTiered(components);
  const overall = status.overall === 'offline' || computed === 'offline' || health.status === 'error' ? 'offline'
    : status.overall === 'degraded' || computed === 'degraded' || health.status === 'degraded' ? 'degraded'
    : status.overall === 'live' ? 'live' : 'unknown';
  const payload: StatusPayload = {
    overall, components, probedAt: status.probedAt,
    fromCache: status.fromCache === true,
    cacheAgeMs: typeof status.cacheAgeMs === 'number' ? status.cacheAgeMs : null,
  };
  return { tier: overall === 'live' ? 'healthy' : overall === 'offline' ? 'unavailable' : overall, payload };
}
