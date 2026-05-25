/**
 * Model Registry helpers (PRD Section 5.1).
 *
 * Thin, type-safe read/write/upsert helpers over the `model_registry` table
 * provisioned by Migration 031. This module is the FUTURE source of truth for
 * the AI model catalog. Provider connectors (Section 5.2) populate the table
 * on the weekly refresh job (Section 5.3). Consumer routes (Intelligence
 * Settings, persona selector, etc.) read it via `/api/models`.
 *
 * The hardcoded AVAILABLE_MODELS array in the legacy code path is being
 * deprecated. Track A1 modifies the consumer routes to read from here; this
 * file is the producer side.
 */

import { queryAll, queryOne, run, transaction } from './db';

// Valid capability tags per PRD Section 5.1. Stored as a JSON array of strings
// in the `capabilities` column.
export const MODEL_CAPABILITIES = [
  'text',
  'vision',
  'image_generation',
  'video_generation',
  'audio_generation',
  'audio_transcription',
  'embeddings',
  'tool_use',
  'code_execution',
  'web_search',
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
 * Raw row shape as returned by better-sqlite3 before JSON decode.
 */
interface ModelRegistryRow {
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
  capabilities: string;
  status: ModelStatus;
  added_at: string;
  last_seen_at: string;
  raw_metadata: string;
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

function decodeRow(row: ModelRegistryRow): ModelRegistryEntry {
  let capabilities: ModelCapability[] = [];
  try {
    const parsed = JSON.parse(row.capabilities || '[]');
    if (Array.isArray(parsed)) {
      capabilities = parsed.filter((c): c is ModelCapability => typeof c === 'string');
    }
  } catch (err) {
    console.error('[model-registry] capabilities JSON parse failed for', row.model_id, err);
  }

  let raw_metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.raw_metadata || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw_metadata = parsed as Record<string, unknown>;
    }
  } catch (err) {
    console.error('[model-registry] raw_metadata JSON parse failed for', row.model_id, err);
  }

  return {
    id: row.id,
    model_id: row.model_id,
    label: row.label,
    provider: row.provider,
    family: row.family,
    context_window: row.context_window,
    input_cost_per_million: row.input_cost_per_million,
    output_cost_per_million: row.output_cost_per_million,
    pricing_model: row.pricing_model,
    pricing_source: row.pricing_source,
    capabilities,
    status: row.status,
    added_at: row.added_at,
    last_seen_at: row.last_seen_at,
    raw_metadata,
  };
}

/**
 * List models from the registry. By default returns only `status = 'active'`
 * entries (the common UI case). Pass `status: null` to list everything.
 *
 * `capability` filter uses SQLite's LIKE against the JSON text column. The
 * capabilities array is small (under 10 items per model) so this is cheap and
 * avoids the json1 extension dependency.
 */
export function listModels(options: ModelRegistryListOptions = {}): ModelRegistryEntry[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const statusFilter = options.status === undefined ? 'active' : options.status;
  if (statusFilter !== null) {
    clauses.push('status = ?');
    params.push(statusFilter);
  }

  if (options.provider) {
    clauses.push('provider = ?');
    params.push(options.provider);
  }

  if (options.family) {
    clauses.push('family = ?');
    params.push(options.family);
  }

  if (options.capability) {
    // capabilities is a JSON array of strings; match the quoted token to
    // avoid prefix collisions (for example, 'audio' inside 'audio_generation').
    clauses.push('capabilities LIKE ?');
    params.push(`%"${options.capability}"%`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  let limitClause = '';
  if (typeof options.limit === 'number' && options.limit > 0) {
    limitClause = ` LIMIT ${Math.floor(options.limit)}`;
    if (typeof options.offset === 'number' && options.offset > 0) {
      limitClause += ` OFFSET ${Math.floor(options.offset)}`;
    }
  }

  const rows = queryAll<ModelRegistryRow>(
    `SELECT * FROM model_registry ${where} ORDER BY provider ASC, label ASC${limitClause}`,
    params
  );

  return rows.map(decodeRow);
}

/**
 * Fetch a single model by its provider-scoped `model_id`. Returns null when
 * not found.
 */
export function getModel(modelId: string): ModelRegistryEntry | null {
  const row = queryOne<ModelRegistryRow>(
    'SELECT * FROM model_registry WHERE model_id = ?',
    [modelId]
  );
  return row ? decodeRow(row) : null;
}

/**
 * Fetch a model by its surrogate primary key. Useful when the API exposes the
 * numeric id and we need a stable handle.
 */
export function getModelByPk(id: number): ModelRegistryEntry | null {
  const row = queryOne<ModelRegistryRow>(
    'SELECT * FROM model_registry WHERE id = ?',
    [id]
  );
  return row ? decodeRow(row) : null;
}

/**
 * Distinct providers that currently have at least one row. Sorted alphabetically.
 */
export function listProviders(): string[] {
  const rows = queryAll<{ provider: string }>(
    'SELECT DISTINCT provider FROM model_registry ORDER BY provider ASC'
  );
  return rows.map((r) => r.provider);
}

/**
 * Result of an upsert. `inserted` means a new row was created; `updated`
 * means the existing row was rewritten.
 */
export type UpsertOutcome = 'inserted' | 'updated';

/**
 * Insert-or-update a single model. The natural key is `model_id`. Updates
 * always bump `last_seen_at` to now so the weekly refresh job can detect
 * stale entries (those not seen this run = deprecated).
 */
export function upsertModel(input: ModelRegistryUpsertInput): UpsertOutcome {
  const existing = queryOne<{ id: number }>(
    'SELECT id FROM model_registry WHERE model_id = ?',
    [input.model_id]
  );

  const capabilitiesJson = JSON.stringify(input.capabilities ?? []);
  const rawMetadataJson = JSON.stringify(input.raw_metadata ?? {});

  if (existing) {
    run(
      `UPDATE model_registry SET
         label = ?,
         provider = ?,
         family = ?,
         context_window = ?,
         input_cost_per_million = ?,
         output_cost_per_million = ?,
         pricing_model = COALESCE(?, pricing_model),
         pricing_source = COALESCE(?, pricing_source),
         capabilities = ?,
         status = COALESCE(?, status),
         last_seen_at = datetime('now'),
         raw_metadata = ?
       WHERE model_id = ?`,
      [
        input.label,
        input.provider,
        input.family ?? null,
        input.context_window ?? null,
        input.input_cost_per_million ?? null,
        input.output_cost_per_million ?? null,
        input.pricing_model ?? null,
        input.pricing_source ?? null,
        capabilitiesJson,
        input.status ?? null,
        rawMetadataJson,
        input.model_id,
      ]
    );
    return 'updated';
  }

  run(
    `INSERT INTO model_registry (
       model_id, label, provider, family, context_window,
       input_cost_per_million, output_cost_per_million,
       pricing_model, pricing_source, capabilities, status,
       raw_metadata
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.model_id,
      input.label,
      input.provider,
      input.family ?? null,
      input.context_window ?? null,
      input.input_cost_per_million ?? null,
      input.output_cost_per_million ?? null,
      input.pricing_model ?? 'per_token',
      input.pricing_source ?? 'auto',
      capabilitiesJson,
      input.status ?? 'active',
      rawMetadataJson,
    ]
  );
  return 'inserted';
}

/**
 * Aggregate counters returned by `bulkUpsertModels`. Mirrors the column names
 * on `model_registry_refresh_log` so the refresh cron can log directly.
 */
export interface BulkUpsertResult {
  models_added: number;
  models_updated: number;
}

/**
 * Bulk upsert wrapped in a single SQLite transaction. Use this from the
 * weekly refresh job so a provider's full catalog is applied atomically.
 */
export function bulkUpsertModels(inputs: ModelRegistryUpsertInput[]): BulkUpsertResult {
  return transaction(() => {
    let added = 0;
    let updated = 0;
    for (const input of inputs) {
      const outcome = upsertModel(input);
      if (outcome === 'inserted') added += 1;
      else updated += 1;
    }
    return { models_added: added, models_updated: updated };
  });
}

/**
 * Mark every active model belonging to `provider` whose `model_id` is NOT in
 * `seenModelIds` as `deprecated`. Called by the refresh job after a successful
 * pull so models that disappear from a provider's API get retired. Returns
 * the number of rows transitioned.
 */
export function markMissingAsDeprecated(provider: string, seenModelIds: string[]): number {
  if (seenModelIds.length === 0) {
    // Defensive: if a provider returns zero models, do NOT mass-deprecate.
    // That almost always indicates an upstream outage, not a real catalog
    // empty-out.
    return 0;
  }

  const placeholders = seenModelIds.map(() => '?').join(', ');
  const result = run(
    `UPDATE model_registry
        SET status = 'deprecated',
            last_seen_at = datetime('now')
      WHERE provider = ?
        AND status = 'active'
        AND model_id NOT IN (${placeholders})`,
    [provider, ...seenModelIds]
  );
  return result.changes;
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

interface ModelRegistryRefreshLogRow {
  id: number;
  run_at: string;
  provider: string;
  success: number;
  models_added: number;
  models_updated: number;
  models_deprecated: number;
  error_message: string | null;
}

function decodeRefreshLogRow(row: ModelRegistryRefreshLogRow): ModelRegistryRefreshLogEntry {
  return {
    id: row.id,
    run_at: row.run_at,
    provider: row.provider,
    success: row.success === 1,
    models_added: row.models_added ?? 0,
    models_updated: row.models_updated ?? 0,
    models_deprecated: row.models_deprecated ?? 0,
    error_message: row.error_message,
  };
}

export function listRefreshLog(limit = 50): ModelRegistryRefreshLogEntry[] {
  const rows = queryAll<ModelRegistryRefreshLogRow>(
    `SELECT * FROM model_registry_refresh_log ORDER BY run_at DESC LIMIT ?`,
    [Math.max(1, Math.floor(limit))]
  );
  return rows.map(decodeRefreshLogRow);
}

export function getLatestRefreshPerProvider(): ModelRegistryRefreshLogEntry[] {
  // SQLite-friendly "latest per group": grab the max id per provider (id is
  // monotonic AUTOINCREMENT) and join back to the row.
  const rows = queryAll<ModelRegistryRefreshLogRow>(
    `SELECT l.* FROM model_registry_refresh_log l
       JOIN (
         SELECT provider, MAX(id) AS max_id
           FROM model_registry_refresh_log
          GROUP BY provider
       ) latest ON latest.max_id = l.id
       ORDER BY l.run_at DESC`
  );
  return rows.map(decodeRefreshLogRow);
}

/**
 * Append a refresh run outcome to `model_registry_refresh_log`. Returns the
 * surrogate id of the new row.
 */
export function logRefresh(params: {
  provider: string;
  success: boolean;
  models_added?: number;
  models_updated?: number;
  models_deprecated?: number;
  error_message?: string | null;
}): number {
  const result = run(
    `INSERT INTO model_registry_refresh_log
       (provider, success, models_added, models_updated, models_deprecated, error_message)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      params.provider,
      params.success ? 1 : 0,
      params.models_added ?? 0,
      params.models_updated ?? 0,
      params.models_deprecated ?? 0,
      params.error_message ?? null,
    ]
  );
  return Number(result.lastInsertRowid);
}
