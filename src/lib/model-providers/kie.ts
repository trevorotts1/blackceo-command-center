/**
 * Kie.ai provider connector per PRD Section 5.2.
 *
 * Kie.ai aggregates async image/video generation models (Midjourney proxy,
 * Veo, Suno, Runway, Flux, etc.) behind a unified jobs API:
 *   - GET  /v1/models                 list models (where available)
 *   - POST /v1/<task>/generate        create a generation job (model-specific path)
 *   - GET  /v1/jobs/{id}              poll job status
 *
 * Auth: Bearer token in the Authorization header.
 * Env:  KIE_API_KEY
 *
 * Kie is NOT a chat provider. We omit chatCompletion and expose `generate()`
 * and `getJob()` instead. The connector still conforms to ModelProvider
 * (slug, displayName, fetchModels) for the registry / refresh loop.
 *
 * Note on /models: Kie's catalog endpoint is sparse and shape-volatile. We
 * try it first; the live call's result is authoritative (see U50 note).
 *
 * U50/H+L.8 — CATALOG HONESTY (swallow-audit closure). This connector used
 * to wrap the `/models` call in a bare `try/catch` that fell through to
 * `CURATED_MODELS` (stamped `status: 'active'`) on ANY failure — a dead
 * key, a network error, a non-2xx response, ALL of it. That is the
 * identical "Fish Audio fallback never `active`" mirage the swallow-audit
 * closes: a dead/invalid Kie key made `refreshOneProvider()` log
 * `success: true` and re-stamp the hardcoded catalog `active` every cycle.
 * Fixed the same way as `fish-audio.ts`:
 *   - a live-call failure now PROPAGATES (no try/catch) so
 *     `refreshOneProvider()` records `success: false` with the real error;
 *   - an authenticated, successful call that legitimately lists zero
 *     models resolves to an EMPTY catalog, never substituted with
 *     `CURATED_MODELS`;
 *   - `CURATED_MODELS` is retained as documentation-only reference data
 *     (see the constant below) and is NEVER returned by `fetchModels()`.
 */

import type {
  ModelCapability,
  ModelProvider,
  ProviderModel,
  SmokeTestResult,
} from './types';

const PROVIDER_SLUG = 'kie';
const PROVIDER_DISPLAY_NAME = 'Kie.ai';

const BASE_URL = process.env.KIE_BASE_URL || 'https://api.kie.ai/api/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
// GET /chat/credit returns the caller's own account credit balance. Kie's
// gateway is unusual: it ALWAYS answers HTTP 200 and encodes the real
// outcome in the JSON body's `code` field (live-verified 2026-07-15):
// missing/bad Authorization -> HTTP 200 body
// {"code":401,"msg":"Unauthorized – Authentication failed. ..."}. So auth
// proof here reads `body.code`, never the HTTP status alone.
const CREDIT_ENDPOINT = `${BASE_URL}/chat/credit`;

interface KieModelRow {
  id?: string;
  model?: string;
  name?: string;
  category?: string;
  capabilities?: string[];
  [key: string]: unknown;
}

interface KieModelsResponse {
  data?: KieModelRow[];
  models?: KieModelRow[];
}

export interface KieGenerateRequest {
  /** Kie model id, for example `veo-3`, `flux-1.1-pro`, `midjourney-v6`. */
  model: string;
  /** Path under the API, for example `veo/generate` or `flux/generate`. */
  path?: string;
  /** Free-form request body forwarded to Kie. */
  input: Record<string, unknown>;
}

export interface KieJobResponse {
  id?: string;
  job_id?: string;
  status?: string;
  data?: Record<string, unknown>;
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
 * U50/H+L.8 — CATALOG HONESTY. This list is documentation-only as of this
 * unit. It is NEVER returned by `fetchModels()` as live data (that silent
 * substitution — a hardcoded catalog stamped `active` on any live-call
 * failure, including a dead/invalid key — was the swallow this unit closes;
 * see the retired fallback behavior in git history). Kept only so a reader
 * knows which high-traffic model ids the operator uses today.
 * `normalizeCurated()` below stamps `status: 'unavailable'` (never
 * confirmed against a live call) so this data can never masquerade as a
 * verified, assignable model if it is ever wired into a seed path.
 */
const CURATED_MODELS: Array<{ id: string; kind: ModelCapability; family: string }> = [
  { id: 'veo-3', kind: 'video_generation', family: 'veo' },
  { id: 'veo-3-fast', kind: 'video_generation', family: 'veo' },
  { id: 'midjourney-v6', kind: 'image_generation', family: 'midjourney' },
  { id: 'midjourney-v7', kind: 'image_generation', family: 'midjourney' },
  { id: 'flux-1.1-pro', kind: 'image_generation', family: 'flux' },
  { id: 'flux-kontext-pro', kind: 'image_generation', family: 'flux' },
  { id: 'suno-v4', kind: 'audio_generation', family: 'suno' },
  { id: 'runway-gen3', kind: 'video_generation', family: 'runway' },
];

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes('veo')) return 'veo';
  if (lower.includes('midjourney') || lower.includes('mj')) return 'midjourney';
  if (lower.includes('flux')) return 'flux';
  if (lower.includes('suno')) return 'suno';
  if (lower.includes('runway')) return 'runway';
  if (lower.includes('kling')) return 'kling';
  if (lower.includes('pika')) return 'pika';
  return undefined;
}

function inferCapabilities(modelId: string): ModelCapability[] {
  const lower = modelId.toLowerCase();
  // Video families -> video_generation (NOT 'streaming'); the Studio video tab
  // filters on the video_generation capability tag.
  if (lower.includes('veo') || lower.includes('runway') || lower.includes('kling') || lower.includes('pika') || lower.includes('video')) {
    return ['video_generation'];
  }
  // Audio/music families -> audio_generation (NOT 'audio_input', which is an
  // INPUT capability). The Studio audio tab filters on audio_generation.
  if (lower.includes('suno') || lower.includes('audio') || lower.includes('music')) {
    return ['audio_generation'];
  }
  return ['image_generation'];
}

function normalizeRow(row: KieModelRow): ProviderModel | null {
  const id = row.id || row.model || row.name;
  if (!id) return null;
  const caps = (row.capabilities || []).filter((c): c is ModelCapability => typeof c === 'string');
  return {
    model_id: `${PROVIDER_SLUG}/${id}`,
    label: row.name || id,
    provider: PROVIDER_SLUG,
    family: inferFamily(id),
    pricing_model: 'per_token',
    pricing_source: 'auto',
    capabilities: caps.length > 0 ? caps : inferCapabilities(id),
    status: 'active',
    raw_metadata: row as unknown as Record<string, unknown>,
  };
}

/**
 * U50/H+L.8 — documentation-only normalizer for `CURATED_MODELS`. Never
 * called from `fetchModels()`. `status: 'unavailable'` is deliberate: this
 * data has never been confirmed against a live call and must never
 * masquerade as an assignable model.
 */
function normalizeCurated(entry: { id: string; kind: ModelCapability; family: string }): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${entry.id}`,
    label: entry.id,
    provider: PROVIDER_SLUG,
    family: entry.family,
    pricing_model: 'per_token',
    pricing_source: 'hardcoded',
    capabilities: inferCapabilities(entry.id),
    status: 'unavailable',
    raw_metadata: { source: 'curated', note: 'Never confirmed live — reference only (U50/H+L.8).' },
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kie.ai request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

/**
 * Fetch the Kie.ai model catalog.
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
    throw new Error('Kie.ai fetchModels called without an apiKey (set KIE_API_KEY)');
  }
  const payload = await fetchJson<KieModelsResponse>(MODELS_ENDPOINT, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  const rows = payload?.data || payload?.models || [];
  return rows.map(normalizeRow).filter((m): m is ProviderModel => m !== null);
}

/**
 * Create a generation job on Kie. The caller picks the path (model-specific)
 * and the input shape. Returns the raw response so the caller can extract
 * the job id and poll with `getJob`.
 */
export async function generate(
  apiKey: string,
  request: KieGenerateRequest
): Promise<KieJobResponse> {
  if (!apiKey) {
    throw new Error('Kie.ai generate called without an apiKey');
  }
  const path = request.path || `${request.model}/generate`;
  const url = `${BASE_URL}/${path.replace(/^\/+/, '')}`;
  return fetchJson<KieJobResponse>(url, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({ model: request.model, ...request.input }),
  });
}

/**
 * Poll an async Kie job for completion. The shape is provider-stable enough
 * to expose as-is.
 */
export async function getJob(apiKey: string, jobId: string): Promise<KieJobResponse> {
  if (!apiKey) {
    throw new Error('Kie.ai getJob called without an apiKey');
  }
  const url = `${BASE_URL}/jobs/${encodeURIComponent(jobId)}`;
  return fetchJson<KieJobResponse>(url, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
}

interface KieCreditResponse {
  code?: number;
  msg?: string;
  [key: string]: unknown;
}

/**
 * U49/U61 (H+L.7) — real authenticated proof, never the model-list mirage.
 * Hits /chat/credit (requires a valid Bearer token) instead of /v1/models.
 * Kie's gateway always answers HTTP 200 (never a 401 status), so this reads
 * the JSON body's `code` field for the real outcome — a bare `res.ok` check
 * would be silently wrong here and would fail OPEN (treat a rejected key as
 * proven). `code === 200` is the only success case; every other code
 * (401 unauthorized, or any other value) is reported as a failure, fail-
 * closed. Used by `proveProviderAuth()` as the fallback proof method when no
 * `chatCompletion` exists (Kie is not a chat provider). The key is NEVER
 * logged or echoed.
 */
export async function verifyKey(apiKey: string): Promise<SmokeTestResult> {
  const TIMEOUT_MS = 7_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(CREDIT_ENDPOINT, {
      method: 'GET',
      headers: authHeaders(apiKey),
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Kie answers 200 even on auth failure — never trust res.ok alone.
    let payload: KieCreditResponse | null = null;
    try {
      payload = (await res.json()) as KieCreditResponse;
    } catch {
      payload = null;
    }
    if (!res.ok) {
      // Defensive: if a future Kie revision DOES use real HTTP status codes,
      // still honor a non-2xx as a failure.
      return { ok: false, status: res.status, message: payload?.msg || `${res.status} ${res.statusText}` };
    }
    if (payload && payload.code === 200) {
      return { ok: true, status: res.status };
    }
    return {
      ok: false,
      status: res.status,
      message: payload?.msg
        ? `code ${payload.code}: ${payload.msg}`
        : `unexpected credit response shape (no code:200)`,
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

export const kieProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  // KIE_API_KEY is canonical; KIEAI_API_KEY is the historical probe spelling
  // used by some installs. Both are accepted so no key is missed.
  envCandidates: ['KIE_API_KEY', 'KIEAI_API_KEY', 'KIE_AI_API_KEY'],
  fetchModels,
  verifyKey,
};

export default kieProvider;
