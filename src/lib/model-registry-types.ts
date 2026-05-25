/**
 * Model Registry — client-safe types and constants.
 *
 * This module contains ONLY the pure types, constant vocabulary, and interface
 * definitions from the model registry. It MUST NOT import `./db` or any other
 * server-only module so it remains safe to import from client components
 * (`'use client'` files) without dragging Node built-ins (`fs`, `better-sqlite3`,
 * `path`, `os`) into the browser bundle.
 *
 * The runtime DB-touching helpers (`listModels`, `upsertModel`,
 * `bulkUpsertModels`, `markMissingAsDeprecated`, refresh-log helpers, etc.)
 * live in `./model-registry.ts` and re-export the types from this file for
 * backwards compatibility with server-side callers.
 */

// Canonical UNION capability vocabulary. Single source of truth shared with
// `src/lib/model-providers/types.ts` (producer side) and the UI badge / filter
// (consumer side). v4.0 Depth 3 Track B aligned these three previously
// divergent vocabularies.
//
// Stored as a JSON array of strings in the `capabilities` column. The column
// accepts any string so future capabilities can be added without a code
// change, but producers and consumers should stick to the list below.
export const MODEL_CAPABILITIES = [
  // Output kinds
  'text',
  'embeddings',
  'image_generation',
  'video_generation',
  'audio_generation',
  'audio_transcription',
  // Input kinds
  'vision',
  'audio_input',
  // Behaviors
  'streaming',
  'reasoning',
  'tool_use',
  'structured_output',
  'long_context',
  'code_execution',
  'web_search',
  'computer_use',
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export type ModelStatus = 'active' | 'deprecated' | 'preview' | 'unavailable';

export type ModelPricingModel = 'per_token' | 'flat_rate_plan' | 'free';

/**
 * Mirrors the migration 031 column set, with JSON columns deserialized.
 *
 * `capabilities` is stored as a JSON array of strings in SQLite and surfaced
 * as a typed string array here. `raw_metadata` is stored as JSON text and
 * surfaced as an arbitrary object so callers don't have to re-parse.
 */
export interface ModelRegistryEntry {
  id: number;
  model_id: string;
  label: string;
  provider: string;
  family: string | null;
  context_window: number | null;
  input_cost_per_million: number | null;
  output_cost_per_million: number | null;
  pricing_model: ModelPricingModel;
  pricing_source: string;
  capabilities: ModelCapability[];
  status: ModelStatus;
  added_at: string;
  last_seen_at: string;
  raw_metadata: Record<string, unknown>;
}

/**
 * Input shape for upsert. `model_id` is the natural key (unique constraint
 * from migration 031). Everything else is optional on update; on insert the
 * non-nullable columns default per the schema.
 */
export interface ModelRegistryUpsertInput {
  model_id: string;
  label: string;
  provider: string;
  family?: string | null;
  context_window?: number | null;
  input_cost_per_million?: number | null;
  output_cost_per_million?: number | null;
  pricing_model?: ModelPricingModel;
  pricing_source?: string;
  capabilities?: ModelCapability[];
  status?: ModelStatus;
  raw_metadata?: Record<string, unknown>;
}

/**
 * Filters supported by `listModels`. All are AND-combined.
 *
 * - `provider`: exact match on the provider slug
 * - `capability`: model must include this capability tag
 * - `status`: defaults to 'active' unless explicitly overridden (pass `null`
 *   to list models in every status, useful for admin views)
 * - `family`: exact match on the family column
 */
export interface ModelRegistryListOptions {
  provider?: string;
  capability?: ModelCapability | string;
  status?: ModelStatus | null;
  family?: string;
  limit?: number;
  offset?: number;
}

/**
 * Result of an upsert. `inserted` means a new row was created; `updated`
 * means the existing row was rewritten.
 */
export type UpsertOutcome = 'inserted' | 'updated';

/**
 * Aggregate counters returned by `bulkUpsertModels`. Mirrors the column names
 * on `model_registry_refresh_log` so the refresh cron can log directly.
 */
export interface BulkUpsertResult {
  models_added: number;
  models_updated: number;
}

/**
 * Most recent refresh log row per provider. Used by the System Status Panel
 * and the Model Configuration screen ("last refreshed at" + success badge).
 */
export interface ModelRegistryRefreshLogEntry {
  id: number;
  run_at: string;
  provider: string;
  success: boolean;
  models_added: number;
  models_updated: number;
  models_deprecated: number;
  error_message: string | null;
}
