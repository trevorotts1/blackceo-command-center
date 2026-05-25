/**
 * Shared types for model provider connectors.
 *
 * Every provider connector (Ollama Cloud, OpenRouter, Anthropic, OpenAI,
 * Google, Moonshot, Z.AI, MiniMax, Xiaomi, etc.) implements the
 * `ModelProvider` interface. The weekly refresh job in
 * `src/lib/jobs/refresh-models.ts` walks the provider registry and calls
 * `fetchModels()` on each to populate `model_registry`.
 *
 * The Ollama Cloud connector also exposes `fetchUsage()` per PRD Section 3.3
 * (gpu_seconds usage, plan tier). Other connectors that don't track usage
 * may omit the method.
 *
 * Connectors that proxy chat completions implement `chatCompletion()`. This
 * is OpenAI-compatible by design so the operator can swap providers without
 * changing call sites.
 */

/**
 * Capabilities are a flat string array stored as JSON in `model_registry`.
 * The known capability strings are listed below for type-safety, but the
 * column accepts any string so future capabilities can be added without
 * a code change.
 */
export type ModelCapability =
  | 'chat'
  | 'completion'
  | 'embedding'
  | 'vision'
  | 'tool_use'
  | 'json_mode'
  | 'reasoning'
  | 'long_context'
  | 'code'
  | 'image_input'
  | 'audio_input'
  | 'streaming';

/**
 * Pricing model maps to the `pricing_model` CHECK in Migration 031.
 *   - per_token: standard per-million-token billing
 *   - flat_rate_plan: pay one monthly fee for unmetered usage (Ollama Cloud,
 *     some Anthropic API tiers, some self-hosted setups)
 *   - free: provider-confirmed free model
 */
export type PricingModel = 'per_token' | 'flat_rate_plan' | 'free';

/**
 * Status maps to the `status` CHECK in Migration 031.
 *   - active: returned by the provider on the last refresh, callable
 *   - deprecated: was returned at some point but not on the most recent
 *     refresh. Existing assignments still resolve to this model_id but
 *     new assignments should not pick it.
 *   - preview: provider says this is preview-only and may change.
 *   - unavailable: provider returned a hard error for this model id.
 */
export type ModelStatus = 'active' | 'deprecated' | 'preview' | 'unavailable';

/**
 * The normalized shape that every provider returns from `fetchModels()`.
 *
 * Connector implementers should fill in everything they can. Missing fields
 * (for example, a provider that does not publish context_window) are left
 * undefined and the registry CRUD layer writes NULL.
 */
export interface ProviderModel {
  /** Provider-prefixed identifier, for example, `ollama-cloud/llama3.3:70b`. */
  model_id: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Provider slug, lowercase, hyphen-separated. */
  provider: string;
  /** Family (claude, gpt, gemini, llama, qwen, kimi, etc.). Optional. */
  family?: string;
  /** Maximum context window in tokens. */
  context_window?: number;
  /** Per-million-token input cost in USD. */
  input_cost_per_million?: number;
  /** Per-million-token output cost in USD. */
  output_cost_per_million?: number;
  /** Pricing model. Defaults to per_token if omitted. */
  pricing_model?: PricingModel;
  /** Where the pricing came from (auto, manual, provider_api, hardcoded). */
  pricing_source?: string;
  /** Capability tags. */
  capabilities?: ModelCapability[];
  /** Current status. Defaults to active when fetched. */
  status?: ModelStatus;
  /** Provider-specific raw payload. Stored as JSON in raw_metadata. */
  raw_metadata?: Record<string, unknown>;
}

/**
 * Snapshot of a provider's usage / quota state. Currently used by Ollama
 * Cloud where the operator pays a flat rate but is rate-limited by
 * GPU-seconds. Surfaced on the System Status panel and the Usage dashboard.
 */
export interface UsageSnapshot {
  /** Provider slug this snapshot belongs to. */
  provider: string;
  /** ISO timestamp the snapshot was taken. */
  taken_at: string;
  /** GPU-seconds consumed in the rolling 5-hour window. */
  gpu_seconds_used_5h?: number;
  /** GPU-seconds allowed in the rolling 5-hour window for this plan. */
  gpu_seconds_limit_5h?: number;
  /** GPU-seconds consumed in the rolling 7-day window. */
  gpu_seconds_used_7d?: number;
  /** GPU-seconds allowed in the rolling 7-day window for this plan. */
  gpu_seconds_limit_7d?: number;
  /** Plan tier, for example, `free`, `pro`, `enterprise`. */
  plan_tier?: string;
  /** Raw provider payload for debugging. */
  raw?: Record<string, unknown>;
}

/**
 * Minimal OpenAI-compatible chat completion request shape. Connectors that
 * proxy through `chatCompletion()` translate this to their native format.
 */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    tool_call_id?: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** Allow forwarding any extra OpenAI-compatible fields untouched. */
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}

/**
 * The connector contract. `fetchModels` is required. `fetchUsage` and
 * `chatCompletion` are optional, present only on providers that support
 * them.
 */
export interface ModelProvider {
  /** Provider slug used as the `provider` column in `model_registry`. */
  readonly slug: string;
  /** Display name for UI surfaces. */
  readonly displayName: string;
  /** Returns the current model catalog for this provider. */
  fetchModels(apiKey: string): Promise<ProviderModel[]>;
  /** Returns usage / quota snapshot. Optional. */
  fetchUsage?(apiKey: string): Promise<UsageSnapshot>;
  /** Proxy a chat completion through the provider. Optional. */
  chatCompletion?(apiKey: string, request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}
