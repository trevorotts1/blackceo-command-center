/**
 * Google Gemini provider connector per PRD Section 5.2.
 *
 * Google Generative Language API has a distinct shape:
 *   - GET  /v1beta/models?key=...
 *   - POST /v1beta/models/{model}:generateContent?key=...
 *
 * Auth: API key passed as the `key` query parameter (no Authorization header).
 * Env:  GEMINI_API_KEY
 *
 * The connector translates the OpenAI-style ChatCompletionRequest into a
 * Gemini generateContent request and the response back to the OpenAI shape.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'google';
const PROVIDER_DISPLAY_NAME = 'Google Gemini';

const BASE_URL = process.env.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiModelRow {
  name: string;
  baseModelId?: string;
  version?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  [key: string]: unknown;
}

interface GeminiModelsResponse {
  models?: GeminiModelRow[];
  nextPageToken?: string;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: { role?: string; parts?: Array<{ text?: string }> };
    finishReason?: string;
    index?: number;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  [key: string]: unknown;
}

function commonHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function stripModelsPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes('gemini-2')) return 'gemini-2';
  if (lower.includes('gemini-1.5')) return 'gemini-1.5';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('embedding')) return 'embedding';
  if (lower.includes('imagen')) return 'imagen';
  if (lower.includes('veo')) return 'veo';
  return undefined;
}

function inferCapabilities(row: GeminiModelRow): ModelCapability[] {
  const lower = row.name.toLowerCase();
  const methods = row.supportedGenerationMethods || [];
  const caps: ModelCapability[] = [];
  if (methods.includes('generateContent') || methods.includes('streamGenerateContent')) {
    caps.push('text', 'streaming');
  }
  if (methods.includes('embedContent') || lower.includes('embedding')) {
    caps.push('embeddings');
  }
  if (lower.includes('gemini') && !lower.includes('embedding')) {
    caps.push('vision', 'tool_use', 'long_context');
  }
  if (lower.includes('thinking') || lower.includes('pro')) {
    caps.push('reasoning');
  }
  return caps.length > 0 ? caps : ['text'];
}

function normalizeModel(row: GeminiModelRow): ProviderModel {
  const id = stripModelsPrefix(row.name);
  return {
    model_id: `${PROVIDER_SLUG}/${id}`,
    label: row.displayName || id,
    provider: PROVIDER_SLUG,
    family: inferFamily(id),
    context_window: row.inputTokenLimit,
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
    throw new Error(`Google Gemini request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Google Gemini fetchModels called without an apiKey (set GEMINI_API_KEY)');
  }
  const url = `${BASE_URL}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
  const payload = await fetchJson<GeminiModelsResponse>(url, {
    method: 'GET',
    headers: commonHeaders(),
  });
  const rows = Array.isArray(payload?.models) ? payload.models : [];
  return rows.map(normalizeModel);
}

/**
 * Translate OpenAI-style messages to Gemini's contents+systemInstruction shape.
 * Gemini uses roles `user` and `model`; system goes in a separate field.
 */
export async function chatCompletion(
  apiKey: string,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  if (!apiKey) {
    throw new Error('Google Gemini chatCompletion called without an apiKey');
  }

  const systemMessages = request.messages.filter((m) => m.role === 'system');
  const contents = request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const body: Record<string, unknown> = { contents };
  if (systemMessages.length > 0) {
    body.systemInstruction = {
      role: 'system',
      parts: [{ text: systemMessages.map((m) => m.content).join('\n\n') }],
    };
  }
  const generationConfig: Record<string, unknown> = {};
  if (typeof request.temperature === 'number') generationConfig.temperature = request.temperature;
  if (typeof request.max_tokens === 'number') generationConfig.maxOutputTokens = request.max_tokens;
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  // Strip provider prefix if the caller passed `google/gemini-2.0-flash`.
  const model = request.model.startsWith(`${PROVIDER_SLUG}/`)
    ? request.model.slice(PROVIDER_SLUG.length + 1)
    : request.model;

  const url = `${BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const raw = await fetchJson<GeminiGenerateContentResponse>(url, {
    method: 'POST',
    headers: commonHeaders(),
    body: JSON.stringify(body),
  });

  const candidate = raw.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .map((p) => p.text || '')
    .join('');

  return {
    model: raw.modelVersion || model,
    choices: [
      {
        index: candidate?.index ?? 0,
        message: { role: 'assistant', content: text },
        finish_reason: candidate?.finishReason,
      },
    ],
    usage: raw.usageMetadata
      ? {
          prompt_tokens: raw.usageMetadata.promptTokenCount,
          completion_tokens: raw.usageMetadata.candidatesTokenCount,
          total_tokens: raw.usageMetadata.totalTokenCount,
        }
      : undefined,
  };
}

export const googleProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  // GEMINI_API_KEY is the canonical name (matches the connector); GOOGLE_API_KEY
  // is an older/alternate spelling used by some client installs and the probes.
  envCandidates: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  fetchModels,
  chatCompletion,
};

export default googleProvider;
