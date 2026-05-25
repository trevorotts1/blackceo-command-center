/**
 * MiniMax provider connector per PRD Section 5.2.
 *
 * MiniMax (api.minimaxi.chat) supports an OpenAI-compatible chat completions
 * endpoint and a `text/chatcompletion_v2` endpoint. We standardize on
 * chat/completions for compatibility with the connector contract.
 *
 *   - POST /v1/text/chatcompletion_v2     native shape
 *   - POST /v1/chat/completions           OpenAI-compatible (preferred here)
 *
 * MiniMax does not expose a public /models discovery endpoint of the same
 * shape, so fetchModels returns a curated static catalog of the families
 * MiniMax currently publishes. The weekly refresh will keep this in sync
 * after a manual roll, which is acceptable because MiniMax's catalog turns
 * over slowly.
 *
 * Auth: Bearer token in the Authorization header.
 * Env:  MINIMAX_API_KEY
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'minimax';
const PROVIDER_DISPLAY_NAME = 'MiniMax';

const BASE_URL = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.chat/v1';
const CHAT_ENDPOINT = `${BASE_URL}/chat/completions`;
const MODELS_ENDPOINT_OPTIONAL = `${BASE_URL}/models`;

interface MinimaxModelRow {
  id?: string;
  name?: string;
  context_window?: number;
  capabilities?: string[];
  [key: string]: unknown;
}

interface MinimaxModelsResponse {
  data?: MinimaxModelRow[];
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * Curated catalog as of mid-2026. The weekly refresh job overlays anything
 * the /models endpoint returns on top of this baseline.
 */
const CURATED_MODELS: Array<{ id: string; ctx: number; caps: ModelCapability[]; family: string }> = [
  { id: 'MiniMax-M2', ctx: 192000, caps: ['chat', 'streaming', 'tool_use', 'long_context', 'reasoning'], family: 'minimax-m' },
  { id: 'MiniMax-Text-01', ctx: 1_000_000, caps: ['chat', 'streaming', 'tool_use', 'long_context'], family: 'minimax-text' },
  { id: 'abab6.5s-chat', ctx: 245760, caps: ['chat', 'streaming', 'tool_use', 'long_context'], family: 'abab' },
  { id: 'abab6.5-chat', ctx: 32768, caps: ['chat', 'streaming', 'tool_use'], family: 'abab' },
  { id: 'speech-02-hd', ctx: 0, caps: ['audio_input'], family: 'speech' },
  { id: 'video-01', ctx: 0, caps: ['streaming'], family: 'video' },
];

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('minimax-m')) return 'minimax-m';
  if (lower.startsWith('minimax-text')) return 'minimax-text';
  if (lower.startsWith('abab')) return 'abab';
  if (lower.startsWith('speech')) return 'speech';
  if (lower.startsWith('video')) return 'video';
  if (lower.startsWith('image')) return 'image';
  return undefined;
}

function normalizeCurated(entry: { id: string; ctx: number; caps: ModelCapability[]; family: string }): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${entry.id}`,
    label: entry.id,
    provider: PROVIDER_SLUG,
    family: entry.family,
    context_window: entry.ctx > 0 ? entry.ctx : undefined,
    pricing_model: 'per_token',
    pricing_source: 'hardcoded',
    capabilities: entry.caps,
    status: 'active',
    raw_metadata: { source: 'curated' },
  };
}

function normalizeRow(row: MinimaxModelRow): ProviderModel | null {
  const id = row.id || row.name;
  if (!id) return null;
  const caps = (row.capabilities || []).filter((c): c is ModelCapability => typeof c === 'string');
  return {
    model_id: `${PROVIDER_SLUG}/${id}`,
    label: id,
    provider: PROVIDER_SLUG,
    family: inferFamily(id),
    context_window: row.context_window,
    pricing_model: 'per_token',
    pricing_source: 'auto',
    capabilities: caps.length > 0 ? caps : ['chat', 'streaming'],
    status: 'active',
    raw_metadata: row as unknown as Record<string, unknown>,
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MiniMax request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

/**
 * Try the optional /models endpoint first; if it 404s or returns an
 * unexpected shape, fall back to the curated catalog. The refresh job
 * still gets a usable, normalized catalog either way.
 */
export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('MiniMax fetchModels called without an apiKey (set MINIMAX_API_KEY)');
  }

  try {
    const res = await fetch(MODELS_ENDPOINT_OPTIONAL, {
      method: 'GET',
      headers: authHeaders(apiKey),
    });
    if (res.ok) {
      const payload = (await res.json()) as MinimaxModelsResponse;
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const normalized = rows
        .map(normalizeRow)
        .filter((m): m is ProviderModel => m !== null);
      if (normalized.length > 0) {
        return normalized;
      }
    }
  } catch {
    // Fall through to curated catalog.
  }

  return CURATED_MODELS.map(normalizeCurated);
}

export async function chatCompletion(
  apiKey: string,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  if (!apiKey) {
    throw new Error('MiniMax chatCompletion called without an apiKey');
  }
  return fetchJson<ChatCompletionResponse>(CHAT_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request),
  });
}

export const minimaxProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
  chatCompletion,
};

export default minimaxProvider;
