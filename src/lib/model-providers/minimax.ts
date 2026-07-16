/**
 * MiniMax provider connector per PRD Section 5.2.
 *
 * MiniMax (api.minimaxi.chat) supports an OpenAI-compatible chat completions
 * endpoint and a `text/chatcompletion_v2` endpoint. We standardize on
 * chat/completions for compatibility with the connector contract.
 *
 *   - POST /v1/text/chatcompletion_v2     native shape
 *   - POST /v1/chat/completions           OpenAI-compatible (preferred here)
 *   - GET  /v1/models                     model list (best-effort; see U50 note)
 *
 * Auth: Bearer token in the Authorization header.
 * Env:  MINIMAX_API_KEY
 *
 * U50/H+L.8 — CATALOG HONESTY (swallow-audit closure). This connector used
 * to wrap the `/v1/models` call in a bare `try/catch` that fell through to
 * `CURATED_MODELS` (stamped `status: 'active'`) on ANY failure — a dead key,
 * a network error, a non-2xx response, ALL of it. That is the identical
 * "Fish Audio fallback never `active`" mirage the swallow-audit closes: a
 * dead/invalid MiniMax key made `refreshOneProvider()` log `success: true`
 * and re-stamp the hardcoded catalog `active` every cycle. Fixed the same
 * way as `fish-audio.ts`:
 *   - a live-call failure now PROPAGATES (no try/catch) so
 *     `refreshOneProvider()` records `success: false` with the real error;
 *   - an authenticated, successful call that legitimately lists zero models
 *     resolves to an EMPTY catalog, never substituted with `CURATED_MODELS`;
 *   - `CURATED_MODELS` is retained as documentation-only reference data
 *     (see the constant below) and is NEVER returned by `fetchModels()`.
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
 * U50/H+L.8 — CATALOG HONESTY. This list is documentation-only as of this
 * unit. It is NEVER returned by `fetchModels()` as live data (that silent
 * substitution — a hardcoded catalog stamped `active` on any live-call
 * failure, including a dead/invalid key — was the swallow this unit closes;
 * see the retired fallback behavior in git history). Kept only so a reader
 * knows which model families this connector targets, current as of
 * mid-2026. `normalizeCurated()` below stamps `status: 'unavailable'`
 * (never confirmed against a live call) so this data can never masquerade
 * as a verified, assignable model if it is ever wired into a seed path.
 */
const CURATED_MODELS: Array<{ id: string; ctx: number; caps: ModelCapability[]; family: string }> = [
  { id: 'MiniMax-M2', ctx: 192000, caps: ['text', 'streaming', 'tool_use', 'long_context', 'reasoning'], family: 'minimax-m' },
  { id: 'MiniMax-Text-01', ctx: 1_000_000, caps: ['text', 'streaming', 'tool_use', 'long_context'], family: 'minimax-text' },
  { id: 'abab6.5s-chat', ctx: 245760, caps: ['text', 'streaming', 'tool_use', 'long_context'], family: 'abab' },
  { id: 'abab6.5-chat', ctx: 32768, caps: ['text', 'streaming', 'tool_use'], family: 'abab' },
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

/**
 * U50/H+L.8 — documentation-only normalizer for `CURATED_MODELS`. Never
 * called from `fetchModels()`. `status: 'unavailable'` is deliberate: this
 * data has never been confirmed against a live call and must never
 * masquerade as an assignable model.
 */
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
    status: 'unavailable',
    raw_metadata: { source: 'curated', note: 'Never confirmed live — reference only (U50/H+L.8).' },
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
    capabilities: caps.length > 0 ? caps : ['text', 'streaming'],
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
 * Fetch the MiniMax model catalog.
 *
 * U50/H+L.8 — CATALOG HONESTY. This used to swallow EVERY failure (a dead
 * key, a network error, a non-2xx response) into a bare `catch` that
 * returned `CURATED_MODELS` stamped `active` — so a garbage key made the
 * weekly refresh log `success: true` and re-stamped a hardcoded catalog
 * `active` forever. That swallow is gone:
 *   - a live-call failure now PROPAGATES (via `fetchJson`, no try/catch
 *     here) so `refreshOneProvider()` catches it and records
 *     `success: false` with the real error detail, exactly like every
 *     other connector;
 *   - an authenticated, successful call that legitimately lists zero
 *     models is treated as an EMPTY catalog, never substituted with
 *     `CURATED_MODELS` — presence of a key and a 200 is not a license to
 *     invent rows.
 */
export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('MiniMax fetchModels called without an apiKey (set MINIMAX_API_KEY)');
  }
  const payload = await fetchJson<MinimaxModelsResponse>(MODELS_ENDPOINT_OPTIONAL, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map(normalizeRow).filter((m): m is ProviderModel => m !== null);
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
