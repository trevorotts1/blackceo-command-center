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

import type { ModelCapability, ModelProvider, ProviderModel } from './types';

const PROVIDER_SLUG = 'fish-audio';
const PROVIDER_DISPLAY_NAME = 'Fish Audio';

const BASE_URL = process.env.FISH_AUDIO_BASE_URL || 'https://api.fish.audio/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;

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
 * Manually-maintained fallback catalog when the live API is unreachable
 * (no key, network sandboxed, etc.). These are the Fish Audio "Speech 1.5"
 * (S1) family models documented at https://docs.fish.audio.
 *
 * Pricing reference (2026): Fish Audio bills TTS at roughly $15 per
 * million characters for s1, $7.50 for s1-mini. Stored in raw_metadata
 * for the UI to surface without a schema change.
 */
const FALLBACK_MODELS: ProviderModel[] = [
  {
    model_id: `${PROVIDER_SLUG}/s1`,
    label: 'Fish Speech 1.5 (S1)',
    provider: PROVIDER_SLUG,
    family: 'fish-speech-1.5',
    pricing_model: 'per_token',
    pricing_source: 'manual',
    capabilities: ['audio_generation'],
    status: 'active',
    raw_metadata: {
      tier: 'quality',
      pricing_per_million_chars: 15,
      pricing_unit: 'characters',
      note: 'Highest-quality Fish Speech 1.5 voice synthesis model.',
    },
  },
  {
    model_id: `${PROVIDER_SLUG}/s1-mini`,
    label: 'Fish Speech 1.5 Mini (S1 Mini)',
    provider: PROVIDER_SLUG,
    family: 'fish-speech-1.5',
    pricing_model: 'per_token',
    pricing_source: 'manual',
    capabilities: ['audio_generation'],
    status: 'active',
    raw_metadata: {
      tier: 'speed',
      pricing_per_million_chars: 7.5,
      pricing_unit: 'characters',
      note: 'Lower-latency Fish Speech 1.5 variant for real-time use.',
    },
  },
  {
    model_id: `${PROVIDER_SLUG}/s1-base`,
    label: 'Fish Speech 1.5 Base (S1 Base)',
    provider: PROVIDER_SLUG,
    family: 'fish-speech-1.5',
    pricing_model: 'per_token',
    pricing_source: 'manual',
    capabilities: ['audio_generation'],
    status: 'active',
    raw_metadata: {
      tier: 'base',
      pricing_per_million_chars: 15,
      pricing_unit: 'characters',
      note: 'Base Fish Speech 1.5 voice model for cloned voices.',
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
 * Fetch the Fish Audio model catalog. Falls back to the manually-maintained
 * list when the API is unreachable or returns an unexpected shape, so the
 * refresh job always populates at least the canonical S1 family.
 */
export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Fish Audio fetchModels called without an apiKey (set FISH_AUDIO_API_KEY)');
  }
  try {
    const payload = await fetchJson<FishAudioModelsResponse | FishAudioModelRow[]>(MODELS_ENDPOINT, {
      method: 'GET',
      headers: jsonHeaders(apiKey),
    });
    const rows: FishAudioModelRow[] = Array.isArray(payload)
      ? payload
      : payload.items || payload.data || [];
    if (rows.length === 0) {
      return FALLBACK_MODELS;
    }
    return rows.map(normalizeModel);
  } catch {
    // Live endpoint unreachable; ship the manually-maintained catalog so
    // Intelligence Settings still has a usable Fish Audio voice list.
    return FALLBACK_MODELS;
  }
}

export const fishAudioProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
};

export default fishAudioProvider;
