/**
 * Fal.ai provider connector per PRD Section 5.2.
 *
 * Fal.ai hosts image/video/audio generation models behind a queue API:
 *   - POST https://queue.fal.run/{model_slug}             enqueue a request
 *   - GET  https://queue.fal.run/{model_slug}/requests/{id}/status
 *   - GET  https://queue.fal.run/{model_slug}/requests/{id}
 *   - POST https://fal.run/{model_slug}                   synchronous run (small jobs)
 *
 * Auth: `Authorization: Key <FAL_KEY>` header (Fal-specific scheme).
 * Env:  FAL_KEY
 *
 * Fal does not expose a public /v1/models discovery endpoint of a stable
 * shape, so fetchModels returns a curated catalog of the high-traffic models
 * the operator uses. The weekly refresh keeps it normalized; the operator
 * can extend via FAL_EXTRA_MODELS (comma-separated slugs) without redeploy.
 */

import type {
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'fal';
const PROVIDER_DISPLAY_NAME = 'Fal.ai';

const RUN_BASE_URL = process.env.FAL_RUN_BASE_URL || 'https://fal.run';
const QUEUE_BASE_URL = process.env.FAL_QUEUE_BASE_URL || 'https://queue.fal.run';

export interface FalRunRequest {
  /** Model slug, for example `fal-ai/flux/dev` or `fal-ai/veo3`. */
  model: string;
  /** Model-specific input payload. */
  input: Record<string, unknown>;
}

export interface FalQueueResponse {
  request_id?: string;
  status?: string;
  response_url?: string;
  status_url?: string;
  [key: string]: unknown;
}

export interface FalRunResponse {
  [key: string]: unknown;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Key ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

const CURATED_MODELS: Array<{ id: string; family: string; caps: ModelCapability[] }> = [
  { id: 'fal-ai/flux/dev', family: 'flux', caps: ['image_generation'] },
  { id: 'fal-ai/flux-pro/v1.1', family: 'flux', caps: ['image_generation'] },
  { id: 'fal-ai/flux-pro/kontext', family: 'flux', caps: ['image_generation', 'vision'] },
  { id: 'fal-ai/flux/schnell', family: 'flux', caps: ['image_generation'] },
  { id: 'fal-ai/recraft-v3', family: 'recraft', caps: ['image_generation'] },
  { id: 'fal-ai/ideogram/v2', family: 'ideogram', caps: ['image_generation'] },
  { id: 'fal-ai/veo3', family: 'veo', caps: ['streaming'] },
  { id: 'fal-ai/kling-video/v2/master/text-to-video', family: 'kling', caps: ['streaming'] },
  { id: 'fal-ai/luma-dream-machine', family: 'luma', caps: ['streaming'] },
  { id: 'fal-ai/minimax/hailuo-02', family: 'minimax-video', caps: ['streaming'] },
  { id: 'fal-ai/elevenlabs/tts/multilingual-v2', family: 'elevenlabs', caps: ['audio_input'] },
  { id: 'fal-ai/whisper', family: 'whisper', caps: ['audio_input'] },
];

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes('flux')) return 'flux';
  if (lower.includes('recraft')) return 'recraft';
  if (lower.includes('ideogram')) return 'ideogram';
  if (lower.includes('veo')) return 'veo';
  if (lower.includes('kling')) return 'kling';
  if (lower.includes('luma')) return 'luma';
  if (lower.includes('minimax')) return 'minimax-video';
  if (lower.includes('elevenlabs')) return 'elevenlabs';
  if (lower.includes('whisper')) return 'whisper';
  if (lower.includes('stable-diffusion') || lower.includes('sdxl')) return 'stable-diffusion';
  return undefined;
}

function inferCapabilities(modelId: string): ModelCapability[] {
  const lower = modelId.toLowerCase();
  if (lower.includes('video') || lower.includes('veo') || lower.includes('kling') || lower.includes('luma') || lower.includes('hailuo') || lower.includes('runway')) {
    return ['streaming'];
  }
  if (lower.includes('tts') || lower.includes('whisper') || lower.includes('audio') || lower.includes('music')) {
    return ['audio_input'];
  }
  return ['image_generation'];
}

function normalizeCurated(entry: { id: string; family: string; caps: ModelCapability[] }): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${entry.id}`,
    label: entry.id,
    provider: PROVIDER_SLUG,
    family: entry.family,
    pricing_model: 'per_token',
    pricing_source: 'hardcoded',
    capabilities: entry.caps,
    status: 'active',
    raw_metadata: { source: 'curated' },
  };
}

function normalizeExtra(slug: string): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${slug}`,
    label: slug,
    provider: PROVIDER_SLUG,
    family: inferFamily(slug),
    pricing_model: 'per_token',
    pricing_source: 'manual',
    capabilities: inferCapabilities(slug),
    status: 'active',
    raw_metadata: { source: 'FAL_EXTRA_MODELS' },
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Fal.ai request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Fal.ai fetchModels called without an apiKey (set FAL_KEY)');
  }
  const curated = CURATED_MODELS.map(normalizeCurated);
  const extra = (process.env.FAL_EXTRA_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeExtra);
  return [...curated, ...extra];
}

/**
 * Enqueue a Fal request via the queue API. Returns the queue handle the
 * caller can poll with `getStatus` / `getResult`.
 */
export async function enqueue(
  apiKey: string,
  request: FalRunRequest
): Promise<FalQueueResponse> {
  if (!apiKey) {
    throw new Error('Fal.ai enqueue called without an apiKey');
  }
  const url = `${QUEUE_BASE_URL}/${request.model.replace(/^\/+/, '')}`;
  return fetchJson<FalQueueResponse>(url, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request.input),
  });
}

/**
 * Run a Fal model synchronously. Suitable for fast models; for video or
 * long-running generations use `enqueue` + poll instead.
 */
export async function run(
  apiKey: string,
  request: FalRunRequest
): Promise<FalRunResponse> {
  if (!apiKey) {
    throw new Error('Fal.ai run called without an apiKey');
  }
  const url = `${RUN_BASE_URL}/${request.model.replace(/^\/+/, '')}`;
  return fetchJson<FalRunResponse>(url, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request.input),
  });
}

export async function getStatus(
  apiKey: string,
  model: string,
  requestId: string
): Promise<FalQueueResponse> {
  if (!apiKey) {
    throw new Error('Fal.ai getStatus called without an apiKey');
  }
  const url = `${QUEUE_BASE_URL}/${model.replace(/^\/+/, '')}/requests/${encodeURIComponent(requestId)}/status`;
  return fetchJson<FalQueueResponse>(url, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
}

export async function getResult(
  apiKey: string,
  model: string,
  requestId: string
): Promise<FalRunResponse> {
  if (!apiKey) {
    throw new Error('Fal.ai getResult called without an apiKey');
  }
  const url = `${QUEUE_BASE_URL}/${model.replace(/^\/+/, '')}/requests/${encodeURIComponent(requestId)}`;
  return fetchJson<FalRunResponse>(url, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
}

export const falProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
};

export default falProvider;
