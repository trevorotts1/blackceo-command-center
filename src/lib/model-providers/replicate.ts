/**
 * Replicate provider connector per PRD Section 5.2.
 *
 * Replicate hosts open-source models behind an async predictions API:
 *   - GET  /v1/models                      list public models (paginated)
 *   - POST /v1/predictions                 create a prediction
 *   - GET  /v1/predictions/{id}            poll prediction status
 *   - POST /v1/predictions/{id}/cancel     cancel a running prediction
 *
 * Auth: `Authorization: Token <REPLICATE_API_TOKEN>`.
 * Env:  REPLICATE_API_TOKEN
 *
 * Replicate is NOT a chat provider. We expose `createPrediction` / `getPrediction`
 * / `cancelPrediction` instead of chatCompletion.
 */

import type {
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'replicate';
const PROVIDER_DISPLAY_NAME = 'Replicate';

const BASE_URL = process.env.REPLICATE_BASE_URL || 'https://api.replicate.com/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const PREDICTIONS_ENDPOINT = `${BASE_URL}/predictions`;

interface ReplicateLatestVersion {
  id?: string;
  created_at?: string;
  openapi_schema?: unknown;
}

interface ReplicateModelRow {
  url?: string;
  owner?: string;
  name?: string;
  description?: string;
  visibility?: string;
  github_url?: string;
  paper_url?: string;
  license_url?: string;
  cover_image_url?: string;
  default_example?: { input?: Record<string, unknown> };
  latest_version?: ReplicateLatestVersion;
  [key: string]: unknown;
}

interface ReplicateModelsResponse {
  results?: ReplicateModelRow[];
  next?: string | null;
  previous?: string | null;
}

export interface ReplicatePredictionRequest {
  /** Either `version` (sha) or `model` (owner/name) is required by Replicate. */
  version?: string;
  model?: string;
  input: Record<string, unknown>;
  webhook?: string;
  webhook_events_filter?: string[];
  stream?: boolean;
}

export interface ReplicatePredictionResponse {
  id?: string;
  status?: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled' | string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: unknown;
  logs?: string;
  metrics?: Record<string, unknown>;
  urls?: { get?: string; cancel?: string; stream?: string };
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  [key: string]: unknown;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Token ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function inferFamily(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.includes('flux')) return 'flux';
  if (lower.includes('llama')) return 'llama';
  if (lower.includes('sdxl') || lower.includes('stable-diffusion')) return 'stable-diffusion';
  if (lower.includes('whisper')) return 'whisper';
  if (lower.includes('musicgen')) return 'musicgen';
  if (lower.includes('bark')) return 'bark';
  if (lower.includes('clip')) return 'clip';
  if (lower.includes('video') || lower.includes('zeroscope') || lower.includes('animatediff')) return 'video';
  return undefined;
}

function inferCapabilities(row: ReplicateModelRow): ModelCapability[] {
  const name = (row.name || '').toLowerCase();
  const desc = (row.description || '').toLowerCase();
  const blob = `${name} ${desc}`;
  if (blob.includes('video')) return ['streaming'];
  if (blob.includes('audio') || blob.includes('music') || blob.includes('speech') || blob.includes('tts') || blob.includes('whisper')) {
    return ['audio_input'];
  }
  if (blob.includes('embedding')) return ['embedding'];
  if (blob.includes('llm') || blob.includes('chat') || blob.includes('text-generation') || name.includes('llama') || name.includes('mistral')) {
    return ['chat', 'streaming'];
  }
  return ['image_input'];
}

function normalizeModel(row: ReplicateModelRow): ProviderModel {
  const id = row.owner && row.name ? `${row.owner}/${row.name}` : row.name || '';
  return {
    model_id: `${PROVIDER_SLUG}/${id}`,
    label: id,
    provider: PROVIDER_SLUG,
    family: inferFamily(id),
    pricing_model: 'per_token',
    pricing_source: 'auto',
    capabilities: inferCapabilities(row),
    status: 'active',
    raw_metadata: row as unknown as Record<string, unknown>,
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Replicate request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

/**
 * List public Replicate models. The catalog is enormous (10k+), so we cap at
 * `REPLICATE_MODEL_LIMIT` (default 200) following the first page of results.
 * The operator can raise the limit or filter by owner via env to grow the cache.
 */
export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Replicate fetchModels called without an apiKey (set REPLICATE_API_TOKEN)');
  }
  const limit = parseInt(process.env.REPLICATE_MODEL_LIMIT || '200', 10);
  const collected: ProviderModel[] = [];
  let url: string | null = MODELS_ENDPOINT;
  while (url && collected.length < limit) {
    const payload: ReplicateModelsResponse = await fetchJson<ReplicateModelsResponse>(url, {
      method: 'GET',
      headers: authHeaders(apiKey),
    });
    const rows = payload.results || [];
    for (const row of rows) {
      collected.push(normalizeModel(row));
      if (collected.length >= limit) break;
    }
    url = payload.next || null;
  }
  return collected;
}

export async function createPrediction(
  apiKey: string,
  request: ReplicatePredictionRequest
): Promise<ReplicatePredictionResponse> {
  if (!apiKey) {
    throw new Error('Replicate createPrediction called without an apiKey');
  }
  return fetchJson<ReplicatePredictionResponse>(PREDICTIONS_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request),
  });
}

export async function getPrediction(
  apiKey: string,
  predictionId: string
): Promise<ReplicatePredictionResponse> {
  if (!apiKey) {
    throw new Error('Replicate getPrediction called without an apiKey');
  }
  const url = `${PREDICTIONS_ENDPOINT}/${encodeURIComponent(predictionId)}`;
  return fetchJson<ReplicatePredictionResponse>(url, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
}

export async function cancelPrediction(
  apiKey: string,
  predictionId: string
): Promise<ReplicatePredictionResponse> {
  if (!apiKey) {
    throw new Error('Replicate cancelPrediction called without an apiKey');
  }
  const url = `${PREDICTIONS_ENDPOINT}/${encodeURIComponent(predictionId)}/cancel`;
  return fetchJson<ReplicatePredictionResponse>(url, {
    method: 'POST',
    headers: authHeaders(apiKey),
  });
}

export const replicateProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
};

export default replicateProvider;
