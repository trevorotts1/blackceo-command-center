/**
 * Fish Audio provider connector per BLACKCEO-V4-POST-BUILD-FIXES P0-8c.
 *
 * Fish Audio ships TTS / voice cloning models. This connector ONLY registers
 * Fish Audio's voice models in `model_registry` so the Intelligence Settings
 * UI lists them and operator tasks can be assigned to a Fish Audio voice.
 *
 * The actual TTS streaming path is implemented separately by the P0-4
 * adapter in `src/app/api/operator/tts/route.ts`. This file does NOT
 * synthesize audio.
 *
 * Endpoints:
 *   - GET https://api.fish.audio/v1/models   list voice models (Bearer auth)
 *
 * Env: FISH_AUDIO_API_KEY
 *
 * Fish Audio bills TTS by characters, not tokens, so per-million-token
 * pricing fields are left undefined. The character pricing is recorded in
 * `raw_metadata.pricing_per_million_chars` when known.
 */

import type { ModelCapability, ModelProvider, ProviderModel, SmokeTestResult } from './types';

const PROVIDER_SLUG = 'fish-audio';
const PROVIDER_DISPLAY_NAME = 'Fish Audio';

const BASE_URL = process.env.FISH_AUDIO_BASE_URL || 'https://api.fish.audio/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
// GET /wallet/self/api-credit returns the caller's own API credit balance.
// NOTE this endpoint lives at the API ROOT, not under /v1 (confirmed against
// Fish Audio's published OpenAPI schema, docs.fish.audio/api-reference/
// openapi.json, and live-verified 2026-07-15): missing/bad Bearer token ->
// 401 (docs: "No permission -- see authorization schemes"); the /v1/models
// path under this same root 404s, confirming /v1 must not be prefixed here.
const ACCOUNT_ROOT_URL = process.env.FISH_AUDIO_ACCOUNT_BASE_URL || 'https://api.fish.audio';
const API_CREDIT_ENDPOINT = `${ACCOUNT_ROOT_URL}/wallet/self/api-credit`;

/**
 * Returns true when the FISH_AUDIO_API_KEY env var is set. Used by the
 * refresh job to skip providers that the operator has not configured yet.
 */
export function isConfigured(): boolean {
  return Boolean(process.env.FISH_AUDIO_API_KEY);
}

interface FishAudioModelRow {
  /** Fish Audio uses `_id` (Mongo-style) or `id` depending on the endpoint. */
  _id?: string;
  id?: string;
  title?: string;
  name?: string;
  description?: string;
  type?: string;
  visibility?: string;
  state?: string;
  languages?: string[];
  tags?: string[];
  [key: string]: unknown;
}

interface FishAudioModelsResponse {
  items?: FishAudioModelRow[];
  data?: FishAudioModelRow[];
  total?: number;
}

/**
 * U50/H+L.8 — CATALOG HONESTY. This list is documentation-only. It is NEVER
 * returned by `fetchModels()` as live data (that silent substitution — a
 * hardcoded catalog stamped `active` on any live-call failure, including a
 * dead/invalid key — was exactly the "Fish Audio fallback never `active`"
 * mirage this unit fixes; see the retired `FALLBACK_MODELS` behavior in git
 * history). Kept only so a reader knows which model families this connector
 * targets, and updated from the retired Speech-1.5 (S1) family to the
 * current Speech-2 / Speech-2.1-Pro (S2) generation — the connector's own
 * `inferFamily()` below already recognizes the `s2` id prefix. `status` is
 * intentionally NON-`active` (`unavailable`: never confirmed against a live
 * call) so that if this list is ever wired into a seed/migration path in the
 * future, it can never masquerade as a verified, assignable model.
 *
 * Pricing reference (2026): Fish Audio bills TTS at roughly $15 per
 * million characters for s2, $7.50 for the lighter-weight tier. Stored in
 * raw_metadata for the UI to surface without a schema change.
 */
const KNOWN_MODEL_FAMILIES: ProviderModel[] = [
  {
    model_id: `${PROVIDER_SLUG}/s2`,
    label: 'Fish Speech 2 (S2)',
    provider: PROVIDER_SLUG,
    family: 'fish-speech-2',
    pricing_model: 'per_token',
    pricing_source: 'manual',
    capabilities: ['audio_generation'],
    status: 'unavailable',
    raw_metadata: {
      tier: 'quality',
      pricing_per_million_chars: 15,
      pricing_unit: 'characters',
      note: 'Current-generation Fish Speech 2 voice synthesis model. Never confirmed live — reference only.',
    },
  },
  {
    model_id: `${PROVIDER_SLUG}/s2.1-pro`,
    label: 'Fish Speech 2.1 Pro (S2.1 Pro)',
    provider: PROVIDER_SLUG,
    family: 'fish-speech-2',
    pricing_model: 'per_token',
    pricing_source: 'manual',
    capabilities: ['audio_generation'],
    status: 'unavailable',
    raw_metadata: {
      tier: 'pro',
      pricing_per_million_chars: 15,
      pricing_unit: 'characters',
      note: 'Fish Speech 2.1 Pro voice synthesis model. Never confirmed live — reference only.',
    },
  },
];

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('s1') || lower.includes('speech-1.5') || lower.includes('speech_1.5')) {
    return 'fish-speech-1.5';
  }
  if (lower.startsWith('s2') || lower.includes('speech-2') || lower.includes('speech_2')) {
    return 'fish-speech-2';
  }
  return undefined;
}

function inferCapabilities(_row: FishAudioModelRow): ModelCapability[] {
  return ['audio_generation'];
}

function normalizeModel(row: FishAudioModelRow): ProviderModel {
  const nativeId = row._id || row.id || row.name || 'unknown';
  return {
    model_id: `${PROVIDER_SLUG}/${nativeId}`,
    label: row.title || row.name || nativeId,
    provider: PROVIDER_SLUG,
    family: inferFamily(nativeId),
    pricing_model: 'per_token',
    pricing_source: 'auto',
    capabilities: inferCapabilities(row),
    status: 'active',
    raw_metadata: row as unknown as Record<string, unknown>,
  };
}

function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Fish Audio request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

/**
 * Fetch the Fish Audio model catalog.
 *
 * U50/H+L.8 — CATALOG HONESTY. This used to swallow EVERY failure (a dead
 * key, a network error, a non-2xx response) into a bare `catch` that
 * returned a hardcoded catalog stamped `active` — so a garbage key made the
 * weekly refresh log `success: true` and re-stamped a stale S1 catalog
 * `active` forever (the connector's swallow, not the refresh job's
 * logging). That swallow is gone:
 *   - a live-call failure now PROPAGATES (no try/catch here) so
 *     `refreshOneProvider()` catches it and records `success: false` with
 *     the real error detail, exactly like every other connector;
 *   - an authenticated, successful call that legitimately lists zero
 *     models is treated as an EMPTY catalog, never substituted with
 *     `KNOWN_MODEL_FAMILIES` — presence of a key and a 200 is not a
 *     license to invent rows.
 */
export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Fish Audio fetchModels called without an apiKey (set FISH_AUDIO_API_KEY)');
  }
  const payload = await fetchJson<FishAudioModelsResponse | FishAudioModelRow[]>(MODELS_ENDPOINT, {
    method: 'GET',
    headers: jsonHeaders(apiKey),
  });
  const rows: FishAudioModelRow[] = Array.isArray(payload)
    ? payload
    : payload.items || payload.data || [];
  return rows.map(normalizeModel);
}

/**
 * U49/U61 (H+L.7) — real authenticated proof, never the model-list mirage.
 * Hits /wallet/self/api-credit (requires a valid Bearer token; 401s on
 * missing/bad auth) instead of /v1/models. This matters MORE for Fish Audio
 * than most connectors: fetchModels() above used to have a bare `catch` that
 * returned a hardcoded fallback list on ANY failure (dead key included), so a
 * garbage key could make fetchModels() look "successful" — exactly the
 * mirage this proof exists to kill. U50/H+L.8 removed that swallow at the
 * source (fetchModels() now propagates live-call failures instead), and
 * verifyKey here never touched fetchModels or its former fallback either
 * way. Used by `proveProviderAuth()` as the fallback proof method when no
 * `chatCompletion` exists (Fish Audio is not a chat provider). The key is
 * NEVER logged or echoed; only a short, redacted error snippet is kept.
 */
export async function verifyKey(apiKey: string): Promise<SmokeTestResult> {
  const TIMEOUT_MS = 7_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_CREDIT_ENDPOINT, {
      method: 'GET',
      headers: jsonHeaders(apiKey),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      return { ok: true, status: res.status };
    }
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

export const fishAudioProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  // FISH_AUDIO_API_KEY is the only spelling verified in use across this repo
  // (tts route, studio generators, docs) — declared explicitly so detection
  // does not silently rely on the derived <SLUG>_API_KEY fallback and the
  // Intelligence Settings tile's "checked:" hint names it (U48/U60).
  envCandidates: ['FISH_AUDIO_API_KEY'],
  fetchModels,
  verifyKey,
};

export default fishAudioProvider;
