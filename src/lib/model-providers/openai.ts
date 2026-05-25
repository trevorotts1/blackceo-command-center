/**
 * OpenAI provider connector per PRD Section 5.2.
 *
 * Standard OpenAI v1 surface:
 *   - GET  /v1/models                  list models
 *   - POST /v1/chat/completions        chat
 *
 * OpenAI does not expose a programmatic per-account usage endpoint suitable
 * for live polling (the dashboard /v1/dashboard/billing/usage path is
 * deprecated and gated). We omit fetchUsage and rely on per-request token
 * accounting in the chat response.
 *
 * Auth: Bearer token in the Authorization header.
 * Env:  OPENAI_API_KEY
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'openai';
const PROVIDER_DISPLAY_NAME = 'OpenAI';

const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const CHAT_ENDPOINT = `${BASE_URL}/chat/completions`;

interface OpenAIModelRow {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  [key: string]: unknown;
}

interface OpenAIModelsResponse {
  object?: string;
  data?: OpenAIModelRow[];
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * Best-effort capability inference for OpenAI model ids. OpenAI does not
 * publish capability metadata on /v1/models, so we encode public knowledge.
 */
function inferCapabilities(modelId: string): ModelCapability[] {
  const lower = modelId.toLowerCase();
  const caps: ModelCapability[] = ['chat', 'streaming'];
  if (lower.includes('gpt-4') || lower.includes('gpt-5') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) {
    caps.push('tool_use', 'json_mode', 'long_context');
  }
  if (lower.includes('vision') || lower.includes('gpt-4o') || lower.includes('gpt-4.1') || lower.includes('gpt-5')) {
    caps.push('vision', 'image_input');
  }
  if (lower.includes('o1') || lower.includes('o3') || lower.includes('o4') || lower.startsWith('gpt-5')) {
    caps.push('reasoning');
  }
  if (lower.includes('embedding')) {
    return ['embedding'];
  }
  if (lower.includes('whisper') || lower.includes('transcribe')) {
    return ['audio_input'];
  }
  return caps;
}

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('gpt-5')) return 'gpt-5';
  if (lower.startsWith('gpt-4')) return 'gpt-4';
  if (lower.startsWith('gpt-3.5')) return 'gpt-3.5';
  if (lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return 'o-series';
  if (lower.includes('embedding')) return 'embedding';
  if (lower.includes('whisper')) return 'whisper';
  if (lower.includes('dall-e')) return 'dall-e';
  if (lower.includes('tts')) return 'tts';
  return undefined;
}

function normalizeModel(row: OpenAIModelRow): ProviderModel {
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
    throw new Error(`OpenAI request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('OpenAI fetchModels called without an apiKey (set OPENAI_API_KEY)');
  }
  const payload = await fetchJson<OpenAIModelsResponse>(MODELS_ENDPOINT, {
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
    throw new Error('OpenAI chatCompletion called without an apiKey');
  }
  return fetchJson<ChatCompletionResponse>(CHAT_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request),
  });
}

export const openaiProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
  chatCompletion,
};

export default openaiProvider;
