/**
 * OpenRouter provider connector per PRD Section 5.2.
 *
 * OpenRouter aggregates 100+ models behind an OpenAI-compatible API.
 *   - GET  /api/v1/models              rich catalog including pricing + ctx
 *   - POST /api/v1/chat/completions    chat
 *
 * Auth: Bearer token in the Authorization header.
 * Env:  OPENROUTER_API_KEY
 *
 * OpenRouter exposes per-token pricing in /models, so the connector records
 * it directly. Free variants (model ids ending in `:free`) are marked with
 * pricing_model = 'free'.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'openrouter';
const PROVIDER_DISPLAY_NAME = 'OpenRouter';

const BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const CHAT_ENDPOINT = `${BASE_URL}/chat/completions`;

interface OpenRouterModelRow {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
  };
  architecture?: {
    modality?: string;
    tokenizer?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  supported_parameters?: string[];
  [key: string]: unknown;
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelRow[];
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  // OpenRouter encourages but does not require these for routing analytics.
  if (process.env.OPENROUTER_HTTP_REFERER) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER;
  }
  if (process.env.OPENROUTER_X_TITLE) {
    headers['X-Title'] = process.env.OPENROUTER_X_TITLE;
  }
  return headers;
}

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  // model ids are like `anthropic/claude-3.5-sonnet` or `meta-llama/llama-3.1-70b`
  const segment = lower.split('/')[1] || lower;
  if (segment.includes('claude')) return 'claude';
  if (segment.includes('gpt')) return 'gpt';
  if (segment.includes('gemini')) return 'gemini';
  if (segment.includes('llama')) return 'llama';
  if (segment.includes('qwen')) return 'qwen';
  if (segment.includes('mistral') || segment.includes('mixtral')) return 'mistral';
  if (segment.includes('deepseek')) return 'deepseek';
  if (segment.includes('grok')) return 'grok';
  if (segment.includes('kimi')) return 'kimi';
  if (segment.includes('glm')) return 'glm';
  return undefined;
}

function inferCapabilities(row: OpenRouterModelRow): ModelCapability[] {
  const caps: ModelCapability[] = ['text', 'streaming'];
  const inputs = row.architecture?.input_modalities || [];
  const params = row.supported_parameters || [];
  if (inputs.includes('image')) caps.push('vision');
  if (inputs.includes('audio')) caps.push('audio_input');
  if (params.includes('tools') || params.includes('tool_choice')) caps.push('tool_use');
  if (params.includes('response_format')) caps.push('structured_output');
  if (params.includes('reasoning')) caps.push('reasoning');
  if ((row.context_length || 0) >= 100000) caps.push('long_context');
  return caps;
}

function parsePrice(price?: string): number | undefined {
  if (!price) return undefined;
  const n = parseFloat(price);
  if (!isFinite(n)) return undefined;
  // OpenRouter prices are per-token in USD; convert to per-million.
  return n * 1_000_000;
}

function normalizeModel(row: OpenRouterModelRow): ProviderModel {
  const isFree = row.id.endsWith(':free');
  const inputPerM = parsePrice(row.pricing?.prompt);
  const outputPerM = parsePrice(row.pricing?.completion);

  return {
    model_id: `${PROVIDER_SLUG}/${row.id}`,
    label: row.name || row.id,
    provider: PROVIDER_SLUG,
    family: inferFamily(row.id),
    context_window: row.context_length,
    input_cost_per_million: isFree ? 0 : inputPerM,
    output_cost_per_million: isFree ? 0 : outputPerM,
    pricing_model: isFree ? 'free' : 'per_token',
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
    throw new Error(`OpenRouter request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('OpenRouter fetchModels called without an apiKey (set OPENROUTER_API_KEY)');
  }
  const payload = await fetchJson<OpenRouterModelsResponse>(MODELS_ENDPOINT, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map(normalizeModel);
}

export async function chatCompletion(
  apiKey: string,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  if (!apiKey) {
    throw new Error('OpenRouter chatCompletion called without an apiKey');
  }
  return fetchJson<ChatCompletionResponse>(CHAT_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request),
  });
}

export const openrouterProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
  chatCompletion,
};

export default openrouterProvider;
