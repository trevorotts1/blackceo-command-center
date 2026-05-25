/**
 * Kie.ai provider connector per PRD Section 5.2.
 *
 * Kie.ai aggregates async image/video generation models (Midjourney proxy,
 * Veo, Suno, Runway, Flux, etc.) behind a unified jobs API:
 *   - GET  /v1/models                 list models (where available)
 *   - POST /v1/<task>/generate        create a generation job (model-specific path)
 *   - GET  /v1/jobs/{id}              poll job status
 *
 * Auth: Bearer token in the Authorization header.
 * Env:  KIE_API_KEY
 *
 * Kie is NOT a chat provider. We omit chatCompletion and expose `generate()`
 * and `getJob()` instead. The connector still conforms to ModelProvider
 * (slug, displayName, fetchModels) for the registry / refresh loop.
 *
 * Note on /models: Kie's catalog endpoint is sparse and shape-volatile. We
 * try it first, then fall back to a small curated catalog of high-traffic
 * model ids the operator uses today.
 */

import type {
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'kie';
const PROVIDER_DISPLAY_NAME = 'Kie.ai';

const BASE_URL = process.env.KIE_BASE_URL || 'https://api.kie.ai/api/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;

interface KieModelRow {
  id?: string;
  model?: string;
  name?: string;
  category?: string;
  capabilities?: string[];
  [key: string]: unknown;
}

interface KieModelsResponse {
  data?: KieModelRow[];
  models?: KieModelRow[];
}

export interface KieGenerateRequest {
  /** Kie model id, for example `veo-3`, `flux-1.1-pro`, `midjourney-v6`. */
  model: string;
  /** Path under the API, for example `veo/generate` or `flux/generate`. */
  path?: string;
  /** Free-form request body forwarded to Kie. */
  input: Record<string, unknown>;
}

export interface KieJobResponse {
  id?: string;
  job_id?: string;
  status?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

const CURATED_MODELS: Array<{ id: string; kind: ModelCapability; family: string }> = [
  { id: 'veo-3', kind: 'streaming', family: 'veo' },
  { id: 'veo-3-fast', kind: 'streaming', family: 'veo' },
  { id: 'midjourney-v6', kind: 'image_input', family: 'midjourney' },
  { id: 'midjourney-v7', kind: 'image_input', family: 'midjourney' },
  { id: 'flux-1.1-pro', kind: 'image_input', family: 'flux' },
  { id: 'flux-kontext-pro', kind: 'image_input', family: 'flux' },
  { id: 'suno-v4', kind: 'audio_input', family: 'suno' },
  { id: 'runway-gen3', kind: 'streaming', family: 'runway' },
];

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes('veo')) return 'veo';
  if (lower.includes('midjourney') || lower.includes('mj')) return 'midjourney';
  if (lower.includes('flux')) return 'flux';
  if (lower.includes('suno')) return 'suno';
  if (lower.includes('runway')) return 'runway';
  if (lower.includes('kling')) return 'kling';
  if (lower.includes('pika')) return 'pika';
  return undefined;
}

function inferCapabilities(modelId: string): ModelCapability[] {
  const lower = modelId.toLowerCase();
  if (lower.includes('veo') || lower.includes('runway') || lower.includes('kling') || lower.includes('pika') || lower.includes('video')) {
    return ['streaming'];
  }
  if (lower.includes('suno') || lower.includes('audio') || lower.includes('music')) {
    return ['audio_input'];
  }
  return ['image_input'];
}

function normalizeRow(row: KieModelRow): ProviderModel | null {
  const id = row.id || row.model || row.name;
  if (!id) return null;
  const caps = (row.capabilities || []).filter((c): c is ModelCapability => typeof c === 'string');
  return {
    model_id: `${PROVIDER_SLUG}/${id}`,
    label: row.name || id,
    provider: PROVIDER_SLUG,
    family: inferFamily(id),
    pricing_model: 'per_token',
    pricing_source: 'auto',
    capabilities: caps.length > 0 ? caps : inferCapabilities(id),
    status: 'active',
    raw_metadata: row as unknown as Record<string, unknown>,
  };
}

function normalizeCurated(entry: { id: string; kind: ModelCapability; family: string }): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${entry.id}`,
    label: entry.id,
    provider: PROVIDER_SLUG,
    family: entry.family,
    pricing_model: 'per_token',
    pricing_source: 'hardcoded',
    capabilities: inferCapabilities(entry.id),
    status: 'active',
    raw_metadata: { source: 'curated' },
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kie.ai request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Kie.ai fetchModels called without an apiKey (set KIE_API_KEY)');
  }
  try {
    const res = await fetch(MODELS_ENDPOINT, { method: 'GET', headers: authHeaders(apiKey) });
    if (res.ok) {
      const payload = (await res.json()) as KieModelsResponse;
      const rows = payload?.data || payload?.models || [];
      const normalized = rows.map(normalizeRow).filter((m): m is ProviderModel => m !== null);
      if (normalized.length > 0) return normalized;
    }
  } catch {
    // fall through
  }
  return CURATED_MODELS.map(normalizeCurated);
}

/**
 * Create a generation job on Kie. The caller picks the path (model-specific)
 * and the input shape. Returns the raw response so the caller can extract
 * the job id and poll with `getJob`.
 */
export async function generate(
  apiKey: string,
  request: KieGenerateRequest
): Promise<KieJobResponse> {
  if (!apiKey) {
    throw new Error('Kie.ai generate called without an apiKey');
  }
  const path = request.path || `${request.model}/generate`;
  const url = `${BASE_URL}/${path.replace(/^\/+/, '')}`;
  return fetchJson<KieJobResponse>(url, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({ model: request.model, ...request.input }),
  });
}

/**
 * Poll an async Kie job for completion. The shape is provider-stable enough
 * to expose as-is.
 */
export async function getJob(apiKey: string, jobId: string): Promise<KieJobResponse> {
  if (!apiKey) {
    throw new Error('Kie.ai getJob called without an apiKey');
  }
  const url = `${BASE_URL}/jobs/${encodeURIComponent(jobId)}`;
  return fetchJson<KieJobResponse>(url, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
}

export const kieProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
};

export default kieProvider;
