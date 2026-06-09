/**
 * Ollama Cloud connector per PRD Section 3.3 (Fix #3).
 *
 * Ollama Cloud is OpenAI-compatible (verified). The base URL is
 * `https://ollama.com/api`. The operator uses Ollama Cloud daily, so this
 * connector is a flagship integration.
 *
 * Endpoints (subject to refresh by Track C2 once the official docs URL is
 * pinned, see Section 5):
 *   - GET  /api/v1/models                 list models
 *   - GET  /api/v1/usage                  current usage / quota
 *   - POST /api/v1/chat/completions       OpenAI-compatible chat
 *
 * Auth: Bearer token in the `Authorization` header.
 *
 * NOTE on Track ownership. Both A1 and C2 list this file. A1 (this commit)
 * lays down the skeleton: types, fetchModels, fetchUsage, chatCompletion
 * with reasonable defaults. C2 will follow up to harden the endpoint URLs,
 * fill in pricing once Ollama publishes it programmatically, and wire this
 * into the central provider registry index (`src/lib/model-providers/index.ts`).
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
  UsageSnapshot,
} from './types';

const PROVIDER_SLUG = 'ollama-cloud';
const PROVIDER_DISPLAY_NAME = 'Ollama Cloud';

const BASE_URL = process.env.OLLAMA_CLOUD_BASE_URL || 'https://ollama.com/api';
const MODELS_ENDPOINT = `${BASE_URL}/v1/models`;
const USAGE_ENDPOINT = `${BASE_URL}/v1/usage`;
const CHAT_ENDPOINT = `${BASE_URL}/v1/chat/completions`;

/**
 * Raw shape returned by Ollama Cloud's `/v1/models`. Best-effort, matches
 * the OpenAI-compatible payload. Anything unexpected lands in raw_metadata.
 */
interface OllamaCloudModelRow {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_window?: number;
  capabilities?: string[];
  /** Some flat-rate providers omit pricing entirely. */
  pricing?: {
    input_per_million?: number;
    output_per_million?: number;
  };
}

interface OllamaCloudModelsResponse {
  object?: string;
  data?: OllamaCloudModelRow[];
}

interface OllamaCloudUsageResponse {
  gpu_seconds_used_5h?: number;
  gpu_seconds_limit_5h?: number;
  gpu_seconds_used_7d?: number;
  gpu_seconds_limit_7d?: number;
  plan_tier?: string;
  [key: string]: unknown;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * Normalize a raw Ollama Cloud model row into the provider-agnostic shape.
 */
function normalizeModel(row: OllamaCloudModelRow): ProviderModel {
  const capabilities = (row.capabilities || []).filter((c): c is ModelCapability =>
    typeof c === 'string'
  );

  // Ollama Cloud is a flat-rate plan for the operator (paid monthly).
  // Default to flat_rate_plan unless the row carries explicit per-token
  // pricing (which would mean Ollama started exposing it programmatically).
  const hasPerTokenPricing =
    row.pricing?.input_per_million !== undefined || row.pricing?.output_per_million !== undefined;

  return {
    model_id: `${PROVIDER_SLUG}/${row.id}`,
    label: row.id,
    provider: PROVIDER_SLUG,
    family: inferFamily(row.id),
    context_window: row.context_window,
    input_cost_per_million: row.pricing?.input_per_million,
    output_cost_per_million: row.pricing?.output_per_million,
    pricing_model: hasPerTokenPricing ? 'per_token' : 'flat_rate_plan',
    pricing_source: 'auto',
    capabilities: capabilities.length > 0 ? capabilities : ['text', 'streaming'],
    status: 'active',
    raw_metadata: row as unknown as Record<string, unknown>,
  };
}

/**
 * Cheap family inference from the model id. Examples:
 *   llama3.3:70b   -> llama
 *   qwen2.5:32b    -> qwen
 *   gpt-oss:20b    -> gpt-oss
 *   deepseek-r1    -> deepseek
 *   kimi-k2.5      -> kimi
 *
 * Returns undefined if we can't confidently categorize it.
 */
function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  const families = [
    'llama',
    'qwen',
    'mistral',
    'mixtral',
    'gemma',
    'phi',
    'deepseek',
    'kimi',
    'gpt-oss',
    'command',
    'yi',
    'falcon',
  ];
  for (const f of families) {
    if (lower.startsWith(f) || lower.includes(`/${f}`) || lower.includes(`-${f}-`) || lower.includes(`:${f}`)) {
      return f;
    }
  }
  return undefined;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama Cloud request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

/**
 * Returns the live catalog of models for this Ollama Cloud account.
 *
 * Throws on network failure, non-2xx, or unparseable JSON so the refresh job
 * can log the failure and not silently corrupt the registry.
 */
export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Ollama Cloud fetchModels called without an apiKey (set OLLAMA_CLOUD_API_KEY)');
  }
  const payload = await fetchJson<OllamaCloudModelsResponse>(MODELS_ENDPOINT, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });

  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map(normalizeModel);
}

/**
 * Returns the operator's current Ollama Cloud usage and quota snapshot.
 *
 * Ollama bills GPU-seconds in two rolling windows (5h and 7d) on the
 * flat-rate plans. We surface both so the System Status panel can show
 * approaching-limit warnings.
 */
export async function fetchUsage(apiKey: string): Promise<UsageSnapshot> {
  if (!apiKey) {
    throw new Error('Ollama Cloud fetchUsage called without an apiKey (set OLLAMA_CLOUD_API_KEY)');
  }
  const payload = await fetchJson<OllamaCloudUsageResponse>(USAGE_ENDPOINT, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });

  return {
    provider: PROVIDER_SLUG,
    taken_at: new Date().toISOString(),
    gpu_seconds_used_5h: payload.gpu_seconds_used_5h,
    gpu_seconds_limit_5h: payload.gpu_seconds_limit_5h,
    gpu_seconds_used_7d: payload.gpu_seconds_used_7d,
    gpu_seconds_limit_7d: payload.gpu_seconds_limit_7d,
    plan_tier: payload.plan_tier,
    raw: payload,
  };
}

/**
 * Proxy a chat completion through Ollama Cloud's OpenAI-compatible
 * endpoint. The request body is forwarded as-is; Ollama Cloud accepts any
 * standard OpenAI fields plus a handful of Ollama extensions.
 *
 * The caller is responsible for stripping the `ollama-cloud/` prefix from
 * the model id (Ollama wants the raw model name) before calling. Doing it
 * here would surprise downstream code that already trusts the registry id
 * shape.
 */
export async function chatCompletion(
  apiKey: string,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  if (!apiKey) {
    throw new Error('Ollama Cloud chatCompletion called without an apiKey');
  }
  return fetchJson<ChatCompletionResponse>(CHAT_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request),
  });
}

/**
 * Default export conforming to ModelProvider. The provider-registry index
 * (owned by Track C2) imports this and indexes by `slug`.
 *
 * envCandidates lists both `OLLAMA_CLOUD_API_KEY` (the canonical name the
 * connector documents) and `OLLAMA_API_KEY` (the name the model-provider
 * probe and some client .env files historically used). The refresh job checks
 * them in order so a client whose key is stored under either name is correctly
 * detected without requiring a rename.
 */
const ollamaCloudProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  envCandidates: ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'],
  fetchModels,
  fetchUsage,
  chatCompletion,
};

export default ollamaCloudProvider;
