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
 *
 * This is the canonical UNION vocabulary shared with `src/lib/model-registry.ts`
 * and the UI badge / filter components. The `model_registry.capabilities`
 * column accepts any string so future capabilities can be added without a
 * code change, but providers and consumers should stick to the list below.
 *
 * Categories:
 *   Output kinds:  text, embeddings, image_generation, video_generation,
 *                  audio_generation, audio_transcription
 *   Input kinds:   vision (accepts images), audio_input (accepts audio)
 *   Behaviors:     streaming, reasoning, tool_use, structured_output,
 *                  long_context, code_execution, web_search, computer_use
 *
 * Legacy aliases removed in v4.0 Depth 3 Track B:
 *   - 'chat' / 'completion'  -> 'text'
 *   - 'embedding'            -> 'embeddings'
 *   - 'image_input'          -> 'vision'
 *   - 'json_mode'            -> 'structured_output'
 *   - 'code'                 -> 'code_execution'
 */
export type ModelCapability =
  | 'text'
  | 'vision'
  | 'audio_input'
  | 'streaming'
  | 'reasoning'
  | 'tool_use'
  | 'structured_output'
  | 'long_context'
  | 'code_execution'
  | 'embeddings'
  | 'image_generation'
  | 'video_generation'
  | 'audio_generation'
  | 'audio_transcription'
  | 'web_search'
  | 'computer_use';

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
 * How a provider authenticates.
 *
 *   - `api_key`        Standard API key (the default). The refresh job looks up
 *                      `envCandidates` (or falls back to `<SLUG>_API_KEY`) and
 *                      fails the run with a "key not set" error when none are
 *                      present.
 *   - `local_endpoint` No API key exists — the provider authenticates via a
 *                      local daemon endpoint (for example, `ollama-local`). The
 *                      refresh job skips the key check and calls `fetchModels`
 *                      with an empty string; the connector decides whether the
 *                      daemon is reachable. The UI should show "local endpoint —
 *                      no key required" rather than "key not set".
 *   - `oauth`          OAuth / token flow. Treated like `api_key` for key
 *                      detection purposes (a token must be present in env).
 */
export type ProviderAuthType = 'api_key' | 'local_endpoint' | 'oauth';

/**
 * Result of an optional post-save smoke-test.
 *
 * `ok: true`  — the key was verified with a live API call.
 * `ok: false` — the call failed or timed out; the key is STILL saved
 *               (write-only contract). `message` contains a human-readable
 *               reason (e.g. "401 Unauthorized" or "timeout after 7s").
 */
export interface SmokeTestResult {
  ok: boolean;
  /** HTTP status from the provider, when available. */
  status?: number;
  /** Human-readable description (never echoes the key). */
  message?: string;
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
  /**
   * Authentication type. Defaults to `'api_key'` when omitted.
   *
   * Connectors that need no API key (local_endpoint) declare this so the
   * refresh job and the UI handle them correctly instead of reporting
   * "API key not set".
   */
  readonly authType?: ProviderAuthType;
  /**
   * Ordered list of env-var names this provider's API key may live under.
   * The refresh job checks them left-to-right and uses the first present
   * value. If omitted, the job falls back to `<SLUG>_API_KEY` (upper-snake
   * with hyphens → underscores).
   *
   * Specifying multiple candidates lets the refresh job find a key stored
   * under any historically-used name (for example, `OLLAMA_CLOUD_API_KEY`
   * AND `OLLAMA_API_KEY` both map to the same connector).
   */
  readonly envCandidates?: readonly string[];
  /** Returns the current model catalog for this provider. */
  fetchModels(apiKey: string): Promise<ProviderModel[]>;
  /** Returns usage / quota snapshot. Optional. */
  fetchUsage?(apiKey: string): Promise<UsageSnapshot>;
  /** Proxy a chat completion through the provider. Optional. */
  chatCompletion?(apiKey: string, request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  /**
   * Optional post-save smoke-test. After the operator saves a new key via
   * POST /api/clients/[id]/keys, the route calls this (if present) to
   * verify the key is valid before returning. The key is ALWAYS saved first
   * (write-only contract) — this result is advisory, never blocks the save.
   *
   * Implementations must complete within 8 seconds (use AbortController).
   */
  verifyKey?(apiKey: string): Promise<SmokeTestResult>;
}
