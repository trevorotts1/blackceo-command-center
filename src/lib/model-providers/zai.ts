/**
 * Z.AI provider connector per PRD Section 5.2.
 *
 * Z.AI hosts the GLM family (GLM-4, GLM-4V, GLM-4.5, etc.) behind an
 * OpenAI-compatible PaaS endpoint.
 *   - GET  /paas/v4/models              list models
 *   - POST /paas/v4/chat/completions    chat
 *
 * Auth: Bearer token in the Authorization header.
 * Env:  ZAI_API_KEY
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'zai';
const PROVIDER_DISPLAY_NAME = 'Z.AI';

const BASE_URL = process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const CHAT_ENDPOINT = `${BASE_URL}/chat/completions`;

interface ZaiModelRow {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  [key: string]: unknown;
}

interface ZaiModelsResponse {
  object?: string;
  data?: ZaiModelRow[];
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
  if (lower.startsWith('glm-4.5') || lower.startsWith('glm-4-5')) return 'glm-4.5';
  if (lower.startsWith('glm-4v')) return 'glm-4v';
  if (lower.startsWith('glm-4')) return 'glm-4';
  if (lower.startsWith('glm-3')) return 'glm-3';
  if (lower.startsWith('glm')) return 'glm';
  if (lower.includes('cogview') || lower.includes('image')) return 'cogview';
  if (lower.includes('cogvideo') || lower.includes('video')) return 'cogvideo';
  if (lower.includes('embedding')) return 'embedding';
  return undefined;
}

function inferCapabilities(modelId: string): ModelCapability[] {
  const lower = modelId.toLowerCase();
  if (lower.includes('embedding')) return ['embedding'];
  const caps: ModelCapability[] = ['chat', 'streaming', 'tool_use'];
  if (lower.includes('glm-4v') || lower.includes('vision') || lower.includes('glm-4.5v')) {
    caps.push('vision', 'image_input');
  }
  if (lower.includes('glm-4') || lower.includes('glm-4.5')) {
    caps.push('long_context', 'json_mode');
  }
  if (lower.includes('thinking') || lower.includes('reason') || lower.includes('air')) {
    caps.push('reasoning');
  }
  return caps;
}

function normalizeModel(row: ZaiModelRow): ProviderModel {
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
    throw new Error(`Z.AI request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Z.AI fetchModels called without an apiKey (set ZAI_API_KEY)');
  }
  const payload = await fetchJson<ZaiModelsResponse>(MODELS_ENDPOINT, {
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
    throw new Error('Z.AI chatCompletion called without an apiKey');
  }
  return fetchJson<ChatCompletionResponse>(CHAT_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request),
  });
}

export const zaiProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
  chatCompletion,
};

export default zaiProvider;
