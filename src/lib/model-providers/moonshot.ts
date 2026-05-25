/**
 * Moonshot AI (Kimi) provider connector per PRD Section 5.2.
 *
 * Moonshot is OpenAI-compatible:
 *   - GET  /v1/models               list models
 *   - POST /v1/chat/completions     chat
 *
 * Auth: Bearer token in the Authorization header.
 * Env:  MOONSHOT_API_KEY
 *
 * Note on base URL: the international endpoint is api.moonshot.ai; the China
 * endpoint is api.moonshot.cn. The PRD ships .cn as the default; override
 * via MOONSHOT_BASE_URL when needed.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'moonshot';
const PROVIDER_DISPLAY_NAME = 'Moonshot AI';

const BASE_URL = process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const CHAT_ENDPOINT = `${BASE_URL}/chat/completions`;

interface MoonshotModelRow {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  [key: string]: unknown;
}

interface MoonshotModelsResponse {
  object?: string;
  data?: MoonshotModelRow[];
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
  if (lower.startsWith('kimi-k2') || lower.includes('kimi-k2')) return 'kimi-k2';
  if (lower.startsWith('moonshot-v1')) return 'moonshot-v1';
  if (lower.startsWith('kimi')) return 'kimi';
  if (lower.startsWith('moonshot')) return 'moonshot';
  return undefined;
}

function inferContextWindow(modelId: string): number | undefined {
  // Moonshot encodes context size in the model id, for example moonshot-v1-128k.
  const match = modelId.toLowerCase().match(/(\d+)k/);
  if (match) {
    return parseInt(match[1], 10) * 1024;
  }
  return undefined;
}

function inferCapabilities(modelId: string): ModelCapability[] {
  const lower = modelId.toLowerCase();
  const caps: ModelCapability[] = ['chat', 'streaming', 'tool_use'];
  if (lower.includes('vision') || lower.includes('vl')) {
    caps.push('vision', 'image_input');
  }
  if (lower.includes('128k') || lower.includes('256k') || lower.includes('1m')) {
    caps.push('long_context');
  }
  if (lower.includes('thinking') || lower.includes('kimi-k2')) {
    caps.push('reasoning');
  }
  return caps;
}

function normalizeModel(row: MoonshotModelRow): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${row.id}`,
    label: row.id,
    provider: PROVIDER_SLUG,
    family: inferFamily(row.id),
    context_window: inferContextWindow(row.id),
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
    throw new Error(`Moonshot request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Moonshot fetchModels called without an apiKey (set MOONSHOT_API_KEY)');
  }
  const payload = await fetchJson<MoonshotModelsResponse>(MODELS_ENDPOINT, {
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
    throw new Error('Moonshot chatCompletion called without an apiKey');
  }
  return fetchJson<ChatCompletionResponse>(CHAT_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request),
  });
}

export const moonshotProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
  chatCompletion,
};

export default moonshotProvider;
