/**
 * Ollama Local connector per v4.0.1 P0-8a.
 *
 * Talks to a self-hosted Ollama daemon over HTTP. By default the daemon
 * listens on `http://localhost:11434` and exposes both Ollama's native
 * `/api/tags` catalog endpoint and an OpenAI-compatible
 * `/v1/chat/completions` proxy. Models served locally are unmetered, so
 * every row is emitted with `pricing_model: 'free'` and zero cost fields.
 *
 * No API key is required; the connector ignores the `apiKey` argument that
 * the shared `ModelProvider` interface mandates. A short reachability probe
 * is exposed via `isConfigured()` so the System Status panel and the
 * weekly refresh job can skip this connector cleanly when the daemon is
 * offline instead of throwing.
 *
 * Endpoints:
 *   - GET  /api/tags                       list locally pulled models
 *   - POST /v1/chat/completions            OpenAI-compatible chat
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'ollama-local';
const PROVIDER_DISPLAY_NAME = 'Ollama (local)';

const BASE_URL = process.env.OLLAMA_LOCAL_HOST || 'http://localhost:11434';
const TAGS_ENDPOINT = `${BASE_URL}/api/tags`;
const CHAT_ENDPOINT = `${BASE_URL}/v1/chat/completions`;

/** Reachability probe timeout. Keep short so admin UIs do not hang. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Raw row returned by Ollama's `/api/tags`. The daemon emits more fields
 * than this (digest, size, modified_at, etc.) but only `name` is required;
 * everything else lands in `raw_metadata` untouched.
 */
interface OllamaTagRow {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
    format?: string;
  };
  [key: string]: unknown;
}

interface OllamaTagsResponse {
  models?: OllamaTagRow[];
}

function jsonHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * Normalize an Ollama `/api/tags` row into the provider-agnostic shape.
 * Local models are free by definition so all cost fields are zeroed out.
 */
function normalizeModel(row: OllamaTagRow): ProviderModel {
  const nativeId = row.name;
  return {
    model_id: `${PROVIDER_SLUG}/${nativeId}`,
    label: nativeId,
    provider: PROVIDER_SLUG,
    family: row.details?.family || inferFamily(nativeId),
    input_cost_per_million: 0,
    output_cost_per_million: 0,
    pricing_model: 'free',
    pricing_source: 'auto',
    capabilities: ['text', 'streaming'],
    status: 'active',
    raw_metadata: row as unknown as Record<string, unknown>,
  };
}

/**
 * Cheap family inference from the local model id. Mirrors the heuristic
 * used in the Ollama Cloud connector so the two surfaces stay consistent.
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
    if (
      lower.startsWith(f) ||
      lower.includes(`/${f}`) ||
      lower.includes(`-${f}-`) ||
      lower.includes(`:${f}`)
    ) {
      return f;
    }
  }
  return undefined;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Ollama Local request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim()
    );
  }
  return (await res.json()) as T;
}

/**
 * Returns true when the local Ollama daemon answers `/api/tags` within
 * `PROBE_TIMEOUT_MS`. Used by the System Status panel and the refresh job
 * so we never throw a hard error just because the operator has not started
 * the daemon yet.
 */
export async function isConfigured(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(TAGS_ENDPOINT, {
      method: 'GET',
      headers: jsonHeaders(),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the live catalog of locally pulled Ollama models. The `apiKey`
 * argument is required by the shared `ModelProvider` interface but
 * intentionally ignored: the local daemon does not authenticate.
 */
export async function fetchModels(_apiKey: string): Promise<ProviderModel[]> {
  const payload = await fetchJson<OllamaTagsResponse>(TAGS_ENDPOINT, {
    method: 'GET',
    headers: jsonHeaders(),
  });

  const rows = Array.isArray(payload?.models) ? payload.models : [];
  return rows.map(normalizeModel);
}

/**
 * Proxy a chat completion through the local daemon's OpenAI-compatible
 * endpoint. The caller is responsible for stripping the `ollama-local/`
 * prefix from `request.model` before calling; Ollama expects the raw
 * native name (for example, `llama3.3:70b`).
 */
export async function chatCompletion(
  _apiKey: string,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  return fetchJson<ChatCompletionResponse>(CHAT_ENDPOINT, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(request),
  });
}

/**
 * Default export conforming to ModelProvider. The provider-registry index
 * imports this and indexes it by `slug`.
 */
const ollamaLocalProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
  chatCompletion,
};

export default ollamaLocalProvider;
