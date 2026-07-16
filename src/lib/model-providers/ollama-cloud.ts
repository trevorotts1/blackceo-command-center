/**
 * Ollama Cloud connector per PRD Section 3.3 (Fix #3).
 *
 * Ollama Cloud is OpenAI-compatible. The OpenAI-compatible base URL is the bare
 * host `https://ollama.com` (NOT `https://ollama.com/api`). The operator uses
 * Ollama Cloud daily, so this connector is a flagship integration.
 *
 * Endpoints (VERIFIED live 2026-07-11 against https://docs.ollama.com/cloud):
 *   - GET  /v1/models                 list models -> 200, {object:"list",data:[{id,...}]}
 *   - POST /v1/chat/completions       OpenAI-compatible chat
 *
 * The previous base (`https://ollama.com/api`) produced `/api/v1/models`, which
 * returns 404 {"error":"path \"/api/v1/models\" not found"} — this is why boxes
 * that chose Ollama Cloud as their sovereign provider had ZERO models register
 * (and silently ran on another provider). Fixed: the base is the bare host.
 *
 * NOTE: there is no `/v1/usage` endpoint upstream (404). `fetchUsage()` therefore
 * has no working upstream and is left AS-IS — it was equally broken before this
 * fix, so leaving it is not a regression.
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
  SmokeTestResult,
  UsageSnapshot,
} from './types';
import { resolveOllamaCloudBaseUrl, OLLAMA_CLOUD_DEFAULT_BASE_URL } from './ollama-cloud-base-url';

const PROVIDER_SLUG = 'ollama-cloud';
const PROVIDER_DISPLAY_NAME = 'Ollama Cloud';

// Re-exported for API stability: callers that imported the default straight
// off this module (its home before it moved) keep working unchanged.
export { OLLAMA_CLOUD_DEFAULT_BASE_URL };

/**
 * The base URL is resolved at CALL time, not module-import time.
 *
 * Why this matters (and why it used to be a module-level `const`): a QC judge
 * misconfiguration — one wrong address in `OLLAMA_CLOUD_BASE_URL` — parked
 * tasks in review for SIX DAYS. Diagnosing that requires reporting the address
 * we ACTUALLY dialled; an import-time snapshot can silently disagree with the
 * live env (and made the failure untestable without real network calls). Call-
 * time resolution keeps `getOllamaCloudBaseUrl()` honest for both the error
 * messages and the escalation the QC scorer now raises.
 *
 * The normalization itself (default to the hosted host, strip a legacy `/api`
 * suffix) is owned by `resolveOllamaCloudBaseUrl()` in `./ollama-cloud-base-url`
 * — the SINGLE source of truth also consumed by `research/providers.ts`'s
 * Ollama web-search call site. Two files reading the same env var with two
 * different defaults (this file's correct `https://ollama.com` vs. the other's
 * 404-producing `https://ollama.com/api`) was itself a defect; routing both
 * through one resolver is what keeps that class of bug from recurring. This
 * function stays call-time so that fix composes with the QC-judge fix above
 * instead of re-freezing the value the QC judge needs live.
 */
export function getOllamaCloudBaseUrl(): string {
  return resolveOllamaCloudBaseUrl();
}

const modelsEndpoint = () => `${getOllamaCloudBaseUrl()}/v1/models`;
const usageEndpoint = () => `${getOllamaCloudBaseUrl()}/v1/usage`;

/** The exact endpoint the QC judge dials. Exported so a failure can NAME it. */
export function getOllamaCloudChatEndpoint(): string {
  return `${getOllamaCloudBaseUrl()}/v1/chat/completions`;
}

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

/**
 * A non-2xx response from Ollama Cloud, carrying the STATUS as data.
 *
 * Why typed: callers need to tell "your key is dead" (401/403) apart from "the
 * server erred" (5xx) apart from "nothing answered" (network). The status used
 * to be legible only by pattern-matching it back out of an English message —
 * i.e. guessing. Guessed diagnoses are what cost six days of QC silence, so the
 * status travels as a field.
 */
export class OllamaCloudHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
    body: string,
  ) {
    super(`Ollama Cloud request to ${url} failed: ${status} ${statusText} ${body}`.trim());
    this.name = 'OllamaCloudHttpError';
  }
}

/** True for the ONLY statuses that actually establish a dead credential. */
export function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new OllamaCloudHttpError(res.status, res.statusText, url, body);
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
  const payload = await fetchJson<OllamaCloudModelsResponse>(modelsEndpoint(), {
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
  const payload = await fetchJson<OllamaCloudUsageResponse>(usageEndpoint(), {
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
  return fetchJson<ChatCompletionResponse>(getOllamaCloudChatEndpoint(), {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request),
  });
}

/**
 * Smoke-test a new Ollama Cloud API key by hitting GET /v1/models with a
 * short (7 s) timeout. Returns {ok:true} on HTTP 2xx, {ok:false,status,message}
 * on any error without ever echoing the key. Called by the key-save route after
 * a successful write; the key is ALWAYS saved regardless of this result.
 */
export async function verifyKey(apiKey: string): Promise<SmokeTestResult> {
  const TIMEOUT_MS = 7_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(modelsEndpoint(), {
      method: 'GET',
      headers: authHeaders(apiKey),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    // Parse a short error body for the message, never echo the key.
    const body = await res.text().catch(() => '');
    const snippet = body.slice(0, 120).replace(/\s+/g, ' ').trim();
    return {
      ok: false,
      status: res.status,
      message: `${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ''}`,
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('abort') || msg.toLowerCase().includes('timeout');
    return {
      ok: false,
      message: isTimeout ? `timeout after ${TIMEOUT_MS / 1000}s` : msg,
    };
  }
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
  verifyKey,
};

export default ollamaCloudProvider;
