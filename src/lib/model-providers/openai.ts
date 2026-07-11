/**
 * OpenAI provider connector per PRD Section 5.2.
 *
 * Standard OpenAI v1 surface:
 *   - GET  /v1/models                  list models
 *   - POST /v1/chat/completions        chat
 *
 * OpenAI does not expose a programmatic per-account usage endpoint suitable
 * for live polling (the dashboard /v1/dashboard/billing/usage path is
 * deprecated and gated). We omit fetchUsage and rely on per-request token
 * accounting in the chat response.
 *
 * Auth: Bearer token in the Authorization header.
 * Env:  OPENAI_API_KEY
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'openai';
const PROVIDER_DISPLAY_NAME = 'OpenAI';

const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const CHAT_ENDPOINT = `${BASE_URL}/chat/completions`;

interface OpenAIModelRow {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  [key: string]: unknown;
}

interface OpenAIModelsResponse {
  object?: string;
  data?: OpenAIModelRow[];
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * Best-effort capability inference for OpenAI model ids. OpenAI does not
 * publish capability metadata on /v1/models, so we encode public knowledge.
 *
 * ── MODEL-07: KIND-FIRST CLASSIFICATION (fixed) ──────────────────────────────
 * `vision` in this registry means IMAGE UNDERSTANDING (the model accepts an
 * image as INPUT). It does NOT mean "image-related".
 *
 * The previous version tested `lower.includes('gpt-4o')` for vision BEFORE it
 * checked what kind of endpoint the model actually was, and the media checks at
 * the bottom were unreachable for anything whose id embedded a chat-family name.
 * So `gpt-4o-mini-tts` — a SPEECH SYNTHESIZER — matched `includes('gpt-4o')` and
 * was written into the registry as an active, vision-capable, tool-using chat
 * model. It landed in the live catalog as one of only two "vision" models on the
 * box. Had the dispatcher selected it for a modality=vision task, it would have
 * handed image-comprehension work to a text-to-speech endpoint. (The model
 * sovereignty gate refusing to guess is the only thing that prevented that.)
 *
 * The fix: classify the model's KIND first and RETURN EARLY. A single-purpose
 * media / embedding endpoint is never eligible for chat-capability inference, so
 * a chat family name buried in its id can no longer claim capabilities it does
 * not have.
 */
function inferCapabilities(modelId: string): ModelCapability[] {
  // Ids arrive provider-prefixed ('openai/gpt-4o'); classify on the bare id.
  const lower = modelId.toLowerCase();
  const base = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;

  // ── 1. SINGLE-PURPOSE ENDPOINTS — kind first, early return. ────────────────
  // Each of these does exactly one thing and is NOT an image-understanding chat
  // model, regardless of which family name appears in its id.
  if (base.includes('embedding')) return ['embeddings'];
  if (base.includes('moderation')) return ['text'];
  // Speech-to-text: whisper-*, gpt-4o-transcribe, gpt-4o-mini-transcribe.
  if (base.includes('whisper') || base.includes('transcribe')) return ['audio_transcription'];
  // Text-to-speech: tts-1, tts-1-hd, gpt-4o-mini-tts.  ← the fake "vision" model.
  if (base.includes('tts')) return ['audio_generation'];
  // Image GENERATION (output), which is the opposite of vision (input):
  // dall-e-2, dall-e-3, gpt-image-1.
  if (base.startsWith('dall-e') || base.includes('gpt-image')) return ['image_generation'];
  if (base.startsWith('sora')) return ['video_generation'];

  // ── 2. AUDIO-IO CHAT (realtime / audio-preview). Speaks and listens; we do
  // NOT claim vision for these — conservative, and the sovereignty gate would
  // rather block than mis-route.
  if (base.includes('realtime') || base.includes('audio')) {
    return ['text', 'streaming', 'tool_use', 'audio_input', 'audio_generation'];
  }

  // ── 3. TEXT / MULTIMODAL CHAT. Only now is family inference safe. ──────────
  const caps: ModelCapability[] = ['text', 'streaming'];
  const isModernChat =
    base.includes('gpt-4') ||
    base.includes('gpt-5') ||
    base.startsWith('o1') ||
    base.startsWith('o3') ||
    base.startsWith('o4');
  if (isModernChat) {
    caps.push('tool_use', 'structured_output', 'long_context');
  }
  // Image UNDERSTANDING. The media endpoints above already returned, so a
  // surviving gpt-4o / gpt-4.1 / gpt-5 id really is the multimodal chat model.
  if (
    base.includes('vision') ||
    base.includes('gpt-4o') ||
    base.includes('gpt-4.1') ||
    base.includes('gpt-4-turbo') ||
    base.includes('gpt-5') ||
    base.startsWith('o1') ||
    base.startsWith('o3') ||
    base.startsWith('o4')
  ) {
    caps.push('vision');
  }
  if (base.startsWith('o1') || base.startsWith('o3') || base.startsWith('o4') || base.startsWith('gpt-5')) {
    caps.push('reasoning');
  }
  return caps;
}

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('gpt-5')) return 'gpt-5';
  if (lower.startsWith('gpt-4')) return 'gpt-4';
  if (lower.startsWith('gpt-3.5')) return 'gpt-3.5';
  if (lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return 'o-series';
  if (lower.includes('embedding')) return 'embedding';
  if (lower.includes('whisper')) return 'whisper';
  if (lower.includes('dall-e')) return 'dall-e';
  if (lower.includes('tts')) return 'tts';
  return undefined;
}

function normalizeModel(row: OpenAIModelRow): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${row.id}`,
    label: row.id,
    provider: PROVIDER_SLUG,
    family: inferFamily(row.id),
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
    throw new Error(`OpenAI request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('OpenAI fetchModels called without an apiKey (set OPENAI_API_KEY)');
  }
  const payload = await fetchJson<OpenAIModelsResponse>(MODELS_ENDPOINT, {
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
    throw new Error('OpenAI chatCompletion called without an apiKey');
  }
  return fetchJson<ChatCompletionResponse>(CHAT_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(request),
  });
}

export const openaiProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
  chatCompletion,
};

export default openaiProvider;
