/**
 * ElevenLabs provider connector per PRD Section 5.2.
 *
 * ElevenLabs is TTS / voice cloning / speech-to-speech / STT, not chat:
 *   - GET  /v1/models                                list TTS models
 *   - GET  /v1/voices                                list voices
 *   - POST /v1/text-to-speech/{voice_id}             synthesize speech (binary audio)
 *   - POST /v1/speech-to-text                        transcribe
 *
 * Auth: `xi-api-key` header (NOT a Bearer token).
 * Env:  ELEVENLABS_API_KEY
 *
 * The connector omits chatCompletion and exposes `textToSpeech`, `speechToText`,
 * and `listVoices` instead. fetchModels normalizes the /v1/models response.
 */

import type {
  ModelCapability,
  ModelProvider,
  ProviderModel,
  SmokeTestResult,
} from './types';

const PROVIDER_SLUG = 'elevenlabs';
const PROVIDER_DISPLAY_NAME = 'ElevenLabs';

const BASE_URL = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const VOICES_ENDPOINT = `${BASE_URL}/voices`;
// GET /v1/user returns the authenticated caller's own account (subscription
// tier, character usage/limits). Live-verified (2026-07-15) to 401 with
// no/garbage key ({"detail":{"type":"authentication_error",...}}) — a
// genuinely auth-gated endpoint, distinct from /v1/models.
const USER_ENDPOINT = `${BASE_URL}/user`;

interface ElevenLabsModelRow {
  model_id: string;
  name?: string;
  can_be_finetuned?: boolean;
  can_do_text_to_speech?: boolean;
  can_do_voice_conversion?: boolean;
  can_use_style?: boolean;
  can_use_speaker_boost?: boolean;
  serves_pro_voices?: boolean;
  token_cost_factor?: number;
  description?: string;
  requires_alpha_access?: boolean;
  max_characters_request_free_user?: number;
  max_characters_request_subscribed_user?: number;
  languages?: Array<{ language_id?: string; name?: string }>;
  [key: string]: unknown;
}

interface ElevenLabsVoice {
  voice_id: string;
  name?: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
  [key: string]: unknown;
}

interface ElevenLabsVoicesResponse {
  voices?: ElevenLabsVoice[];
}

export interface ElevenLabsTtsRequest {
  voice_id: string;
  text: string;
  model_id?: string;
  voice_settings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
  output_format?: string;
}

export interface ElevenLabsSttRequest {
  /** Audio bytes; the connector handles multipart. */
  audio: Blob | Uint8Array | ArrayBuffer;
  /** `scribe_v1` is the current ElevenLabs STT model. */
  model_id?: string;
  filename?: string;
  language_code?: string;
}

export interface ElevenLabsTtsResult {
  audio: ArrayBuffer;
  contentType: string;
}

export interface ElevenLabsSttResult {
  text?: string;
  language_code?: string;
  language_probability?: number;
  words?: Array<{ text: string; start: number; end: number; type?: string }>;
  [key: string]: unknown;
}

function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    'xi-api-key': apiKey,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function audioHeaders(apiKey: string): Record<string, string> {
  return {
    'xi-api-key': apiKey,
    Accept: 'audio/mpeg',
    'Content-Type': 'application/json',
  };
}

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes('eleven_v3') || lower.includes('eleven-v3')) return 'eleven-v3';
  if (lower.includes('eleven_turbo_v2') || lower.includes('turbo')) return 'eleven-turbo';
  if (lower.includes('eleven_flash')) return 'eleven-flash';
  if (lower.includes('eleven_multilingual')) return 'eleven-multilingual';
  if (lower.includes('eleven_monolingual')) return 'eleven-monolingual';
  if (lower.includes('scribe')) return 'scribe';
  if (lower.startsWith('eleven')) return 'eleven';
  return undefined;
}

function inferCapabilities(row: ElevenLabsModelRow): ModelCapability[] {
  const caps: ModelCapability[] = [];
  if (row.can_do_text_to_speech) caps.push('audio_input');
  // STT (scribe) shows up here too via the model list with a different flag set.
  if (row.model_id.toLowerCase().includes('scribe') || (row as Record<string, unknown>).can_do_speech_to_text) {
    caps.push('audio_input');
  }
  if (caps.length === 0) caps.push('audio_input');
  return caps;
}

function normalizeModel(row: ElevenLabsModelRow): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${row.model_id}`,
    label: row.name || row.model_id,
    provider: PROVIDER_SLUG,
    family: inferFamily(row.model_id),
    pricing_model: 'per_token',
    pricing_source: 'auto',
    capabilities: inferCapabilities(row),
    status: 'active',
    raw_metadata: row as unknown as Record<string, unknown>,
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('ElevenLabs fetchModels called without an apiKey (set ELEVENLABS_API_KEY)');
  }
  // /v1/models returns a bare array, not a {data: [...]} envelope.
  const payload = await fetchJson<ElevenLabsModelRow[] | { models?: ElevenLabsModelRow[] }>(MODELS_ENDPOINT, {
    method: 'GET',
    headers: jsonHeaders(apiKey),
  });
  const rows = Array.isArray(payload) ? payload : payload.models || [];
  return rows.map(normalizeModel);
}

export async function listVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  if (!apiKey) {
    throw new Error('ElevenLabs listVoices called without an apiKey');
  }
  const payload = await fetchJson<ElevenLabsVoicesResponse>(VOICES_ENDPOINT, {
    method: 'GET',
    headers: jsonHeaders(apiKey),
  });
  return payload.voices || [];
}

/**
 * Synthesize speech. Returns the raw audio bytes plus the response content-type
 * (typically `audio/mpeg`). The caller writes to disk or streams to the client.
 */
export async function textToSpeech(
  apiKey: string,
  request: ElevenLabsTtsRequest
): Promise<ElevenLabsTtsResult> {
  if (!apiKey) {
    throw new Error('ElevenLabs textToSpeech called without an apiKey');
  }
  const url = `${BASE_URL}/text-to-speech/${encodeURIComponent(request.voice_id)}${
    request.output_format ? `?output_format=${encodeURIComponent(request.output_format)}` : ''
  }`;
  const body: Record<string, unknown> = { text: request.text };
  if (request.model_id) body.model_id = request.model_id;
  if (request.voice_settings) body.voice_settings = request.voice_settings;
  const res = await fetch(url, {
    method: 'POST',
    headers: audioHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ElevenLabs textToSpeech failed: ${res.status} ${res.statusText} ${text}`.trim());
  }
  const audio = await res.arrayBuffer();
  return {
    audio,
    contentType: res.headers.get('content-type') || 'audio/mpeg',
  };
}

/**
 * Transcribe audio. Uses multipart/form-data; the connector wraps the
 * supplied bytes for the caller.
 */
export async function speechToText(
  apiKey: string,
  request: ElevenLabsSttRequest
): Promise<ElevenLabsSttResult> {
  if (!apiKey) {
    throw new Error('ElevenLabs speechToText called without an apiKey');
  }
  const form = new FormData();
  const filename = request.filename || 'audio.mp3';
  let blob: Blob;
  if (request.audio instanceof Blob) {
    blob = request.audio;
  } else if (request.audio instanceof Uint8Array) {
    blob = new Blob([request.audio as unknown as ArrayBuffer]);
  } else {
    blob = new Blob([request.audio]);
  }
  form.append('file', blob, filename);
  form.append('model_id', request.model_id || 'scribe_v1');
  if (request.language_code) form.append('language_code', request.language_code);

  const res = await fetch(`${BASE_URL}/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ElevenLabs speechToText failed: ${res.status} ${res.statusText} ${text}`.trim());
  }
  return (await res.json()) as ElevenLabsSttResult;
}

/**
 * U49/U61 (H+L.7) — real authenticated proof, never the model-list mirage.
 * Hits /v1/user (requires a valid xi-api-key; 401s on missing/bad auth)
 * instead of /v1/models. Used by `proveProviderAuth()` as the fallback proof
 * method when no `chatCompletion` exists (ElevenLabs is not a chat
 * provider). The key is NEVER logged or echoed; only a short, redacted
 * error snippet is kept.
 */
export async function verifyKey(apiKey: string): Promise<SmokeTestResult> {
  const TIMEOUT_MS = 7_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(USER_ENDPOINT, {
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

export const elevenlabsProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  // ELEVENLABS_API_KEY is the only spelling verified in use across this repo
  // (tts route, studio generators, docs) — declared explicitly so detection
  // does not silently rely on the derived <SLUG>_API_KEY fallback and the
  // Intelligence Settings tile's "checked:" hint names it (U48/U60).
  envCandidates: ['ELEVENLABS_API_KEY'],
  fetchModels,
  verifyKey,
};

export default elevenlabsProvider;
