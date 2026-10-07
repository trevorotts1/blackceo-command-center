/**
 * V23-CC1 — Agnes AI provider connector.
 *
 * Agnes exposes an OpenAI-compatible surface at base
 * https://apihub.agnes-ai.com/v1 (gateway `Authorization: Bearer`;
 * see onboarding `shared-utils/llm_score.py` AGNES_BASE_URL):
 *   - GET  /v1/models                 model catalog (best-effort parse)
 *   - POST /v1/chat/completions       chat
 *
 * Env: AGNES_API_KEY (canon; AGNES_AI_API_KEY and AGNES_KEY are the same
 * family per the onboarding secret-name canon — see llm_score.agnes_api_keys).
 *
 * Catalog honesty (same rule as minimax/fish-audio): a live-call failure
 * PROPAGATES so refreshModels() records success=false; there is no curated
 * fallback stamped active. The agnes-3.0-flash id therefore reaches
 * model_registry only when the provider actually lists it — never from a
 * hardcoded constant in this repo.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'agnes';
const PROVIDER_DISPLAY_NAME = 'Agnes AI';

const BASE_URL = process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const CHAT_ENDPOINT = `${BASE_URL}/chat/completions`;

interface AgnesModelRow {
  id?: string;
  name?: string;
  created?: number;
  owned_by?: string;
  context_window?: number;
  capabilities?: string[];
  [key: string]: unknown;
}

interface AgnesModelsResponse {
  data?: AgnesModelRow[];
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
  if (lower.includes('agnes-3')) return 'agnes-3';
  if (lower.includes('agnes-2')) return 'agnes-2';
  if (lower.includes('agnes')) return 'agnes';
  return undefined;
}

function normalizeRow(row: AgnesModelRow): ProviderModel | null {
  const id = row.id || row.name;
  if (!id) return null;
  const caps = (row.capabilities || []).filter(
    (c): c is ModelCapability => typeof c === 'string',
  );
  return {
    model_id: `${PROVIDER_SLUG}/${id}`,
    label: (typeof row.name === 'string' && row.name) || id,
    provider: PROVIDER_SLUG,
    family: inferFamily(id),
    context_window: row.context_window,
    pricing_model: 'per_token',
    pricing_source: 'auto',
    capabilities: caps.length > 0 ? caps : ['text', 'streaming'],
    status: 'active',
    raw_metadata: row as unknown as Record<string, unknown>,
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Agnes request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Agnes fetchModels called without an apiKey (set AGNES_API_KEY)');
  }
  const payload = await fetchJson<AgnesModelsResponse>(MODELS_ENDPOINT, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map(normalizeRow).filter((m): m is ProviderModel => m !== null);
}

export async function chatCompletion(
  apiKey: string,
  request: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<ChatCompletionResponse> {
  if (!apiKey) {
    throw new Error('Agnes chatCompletion called without an apiKey');
  }
  // Strip the provider prefix when the caller passed `agnes/agnes-3.0-flash`.
  const req =
    request.model.startsWith(`${PROVIDER_SLUG}/`)
      ? { ...request, model: request.model.slice(PROVIDER_SLUG.length + 1) }
      : request;
  return fetchJson<ChatCompletionResponse>(CHAT_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(req),
    signal,
  });
}

export const agnesProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  envCandidates: ['AGNES_API_KEY', 'AGNES_AI_API_KEY', 'AGNES_KEY'],
  fetchModels,
  chatCompletion,
};

export default agnesProvider;
