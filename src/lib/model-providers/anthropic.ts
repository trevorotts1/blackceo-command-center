/**
 * Anthropic provider connector per PRD Section 5.2.
 *
 * Anthropic uses its own request shape (/v1/messages), not OpenAI-compatible.
 * The connector translates the OpenAI-style ChatCompletionRequest into an
 * Anthropic Messages request and back so call sites can stay provider-agnostic.
 *
 *   - GET  /v1/models                  list models (live as of 2024)
 *   - POST /v1/messages                chat (system prompt is a top-level field)
 *
 * Auth: x-api-key header plus the mandatory anthropic-version date header.
 * Env:  ANTHROPIC_API_KEY
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'anthropic';
const PROVIDER_DISPLAY_NAME = 'Anthropic';

const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const MESSAGES_ENDPOINT = `${BASE_URL}/messages`;
const ANTHROPIC_VERSION = process.env.ANTHROPIC_API_VERSION || '2023-06-01';

interface AnthropicModelRow {
  id: string;
  type?: string;
  display_name?: string;
  created_at?: string;
  [key: string]: unknown;
}

interface AnthropicModelsResponse {
  data?: AnthropicModelRow[];
  has_more?: boolean;
  first_id?: string;
  last_id?: string;
}

interface AnthropicMessagesResponse {
  id?: string;
  type?: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function inferFamily(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes('opus')) return 'claude-opus';
  if (lower.includes('sonnet')) return 'claude-sonnet';
  if (lower.includes('haiku')) return 'claude-haiku';
  if (lower.startsWith('claude')) return 'claude';
  return undefined;
}

function inferCapabilities(modelId: string): ModelCapability[] {
  const lower = modelId.toLowerCase();
  const caps: ModelCapability[] = ['text', 'streaming', 'tool_use', 'long_context', 'vision'];
  if (lower.includes('opus') || lower.includes('sonnet')) {
    caps.push('reasoning');
  }
  return caps;
}

function normalizeModel(row: AnthropicModelRow): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${row.id}`,
    label: row.display_name || row.id,
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
    throw new Error(`Anthropic request to ${url} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function fetchModels(apiKey: string): Promise<ProviderModel[]> {
  if (!apiKey) {
    throw new Error('Anthropic fetchModels called without an apiKey (set ANTHROPIC_API_KEY)');
  }
  const payload = await fetchJson<AnthropicModelsResponse>(MODELS_ENDPOINT, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map(normalizeModel);
}

/**
 * Translate an OpenAI-style chat request to Anthropic's Messages API and
 * normalize the response back to OpenAI's ChatCompletionResponse shape.
 */
export async function chatCompletion(
  apiKey: string,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  if (!apiKey) {
    throw new Error('Anthropic chatCompletion called without an apiKey');
  }

  // Split out the system prompt; Anthropic wants it as a top-level field.
  const systemMessages = request.messages.filter((m) => m.role === 'system');
  const otherMessages = request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

  const body: Record<string, unknown> = {
    model: request.model,
    messages: otherMessages,
    max_tokens: request.max_tokens ?? 4096,
  };
  if (systemMessages.length > 0) {
    body.system = systemMessages.map((m) => m.content).join('\n\n');
  }
  if (typeof request.temperature === 'number') {
    body.temperature = request.temperature;
  }
  if (request.stream) {
    body.stream = true;
  }

  const raw = await fetchJson<AnthropicMessagesResponse>(MESSAGES_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });

  const text = (raw.content || [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');

  return {
    id: raw.id,
    model: raw.model,
    choices: [
      {
        index: 0,
        message: { role: raw.role || 'assistant', content: text },
        finish_reason: raw.stop_reason,
      },
    ],
    usage: raw.usage
      ? {
          prompt_tokens: raw.usage.input_tokens,
          completion_tokens: raw.usage.output_tokens,
          total_tokens:
            (raw.usage.input_tokens ?? 0) + (raw.usage.output_tokens ?? 0) || undefined,
        }
      : undefined,
  };
}

export const anthropicProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
  chatCompletion,
};

export default anthropicProvider;
