/**
 * xAI (Grok) provider connector per PRD Section 5.2 + SCOPE-ADDITION Addition 3.
 *
 * xAI exposes an OpenAI-compatible surface plus an optional `search_parameters`
 * field for Live Search:
 *   - GET  /v1/models                  list models
 *   - POST /v1/chat/completions        chat (accepts search_parameters)
 *
 * Auth: Bearer token in the Authorization header.
 * Env:  X_AI_API_KEY
 *
 * Live Search: pass `search_parameters: { mode: 'on' }` in the request body to
 * enable Grok's web-grounded responses. The connector forwards extra fields
 * untouched, so callers control this per request.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'xai';
const PROVIDER_DISPLAY_NAME = 'xAI (Grok)';

const BASE_URL = process.env.X_AI_BASE_URL || 'https://api.x.ai/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const CHAT_ENDPOINT = `${BASE_URL}/chat/completions`;

interface XaiModelRow {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  [key: string]: unknown;
}

interface XaiModelsResponse {
  object?: string;
  data?: XaiModelRow[];
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('grok-4') || lower.includes('grok-4')) return 'grok-4';
  if (lower.startsWith('grok-3') || lower.includes('grok-3')) return 'grok-3';
  if (lower.startsWith('grok-2') || lower.includes('grok-2')) return 'grok-2';
  if (lower.startsWith('grok')) return 'grok';
  return undefined;
}

function inferCapabilities(modelId: string): ModelCapability[] {
  const lower = modelId.toLowerCase();
  const caps: ModelCapability[] = ['chat', 'streaming', 'tool_use', 'long_context'];
  if (lower.includes('vision') || lower.includes('grok-4') || lower.includes('grok-2-vision') || lower.includes('image')) {
    caps.push('vision', 'image_input');
  }
  if (lower.includes('reasoning') || lower.includes('grok-4')) {
    caps.push('reasoning');
  }
  return caps;
}

function normalizeModel(row: XaiModelRow): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${row.id}`,
    label: row.id,
    provider: PROVIDER_SLUG,
    family: inferFamily(row.id),
    pricing_model: 'per_token',
    pricing_source: 'auto',
    capabilities: inferCapabilities(row.id),
    status: 'active',
    raw_metadata: row as unknown as Record<string, unknown>,
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`xAI request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('xAI fetchModels called without an apiKey (set X_AI_API_KEY)');
  }
  const payload = await fetchJson<XaiModelsResponse>(MODELS_ENDPOINT, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map(normalizeModel);
}

/**
 * OpenAI-compatible. The request is forwarded as-is so callers can set
 * `search_parameters: { mode: 'on' }` for Live Search.
 */
export async function chatCompletion(
  apiKey: string,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  if (!apiKey) {
    throw new Error('xAI chatCompletion called without an apiKey');
  }
  return fetchJson<ChatCompletionResponse>(CHAT_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request),
  });
}

export const xaiProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
  chatCompletion,
};

export default xaiProvider;
