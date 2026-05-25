/**
 * Weekly model-registry refresh job per PRD Section 3.4 (Fix #4).
 *
 * Status: SKELETON. Track A1 lays down the contract and the database write
 * shape. Track C4 (primary owner per PRD Section 16.4) fills in:
 *   - the node-cron schedule registration (Sunday 03:00 local)
 *   - the full provider iteration loop
 *   - the cron registration in `src/app/api/cron/register/route.ts`
 *   - the manual-trigger route `POST /api/cron/refresh-models`
 *
 * What this file currently exposes:
 *   - `refreshModels()`           run a refresh pass NOW
 *   - `refreshOneProvider()`      run a refresh pass for one provider
 *   - `logRefreshOutcome()`       append to `model_registry_refresh_log`
 *
 * The pass walks each registered provider, calls `fetchModels()`, then
 * upserts into `model_registry`:
 *   - new model_ids       INSERT, status = 'active'
 *   - known model_ids     UPDATE last_seen_at and metadata
 *   - missing model_ids   set status = 'deprecated' (do NOT delete; existing
 *                         department/role assignments must still resolve)
 *
 * Errors are isolated per provider so one bad connector cannot wipe the
 * whole registry. Every provider gets its own row in
 * `model_registry_refresh_log` with success=0/1 and an error_message.
 */

import { getDb } from '@/lib/db';
import type { Database as BetterDatabase } from 'better-sqlite3';
import type { ModelProvider, ProviderModel } from '@/lib/model-providers/types';

export interface RefreshOutcome {
  provider: string;
  success: boolean;
  models_added: number;
  models_updated: number;
  models_deprecated: number;
  error_message?: string;
  /** ISO timestamp the run completed. */
  run_at: string;
}

/**
 * Read the per-provider API key from env. Centralizing this here makes it
 * easy for Track C4 to swap in a per-deployment secret store later.
 */
function apiKeyFor(slug: string): string | undefined {
  // Convention: SLUG_API_KEY in uppercase, hyphens -> underscores.
  const envKey = slug.toUpperCase().replace(/-/g, '_') + '_API_KEY';
  return process.env[envKey];
}

/**
 * Upsert a single model. Treats `model_id` as the conflict key.
 *
 * Returns 'added' on a fresh insert, 'updated' on an existing row.
 */
function upsertModel(
  db: BetterDatabase,
  m: ProviderModel
): 'added' | 'updated' {
  const existing = db
    .prepare('SELECT id FROM model_registry WHERE model_id = ?')
    .get(m.model_id) as { id: number } | undefined;

  const capabilitiesJson = JSON.stringify(m.capabilities || []);
  const rawJson = JSON.stringify(m.raw_metadata || {});
  const pricingModel = m.pricing_model || 'per_token';
  const pricingSource = m.pricing_source || 'auto';
  const status = m.status || 'active';

  if (existing) {
    db.prepare(
      `UPDATE model_registry SET
        label = ?,
        provider = ?,
        family = ?,
        context_window = ?,
        input_cost_per_million = ?,
        output_cost_per_million = ?,
        pricing_model = ?,
        pricing_source = ?,
        capabilities = ?,
        status = ?,
        last_seen_at = datetime('now'),
        raw_metadata = ?
      WHERE id = ?`
    ).run(
      m.label,
      m.provider,
      m.family ?? null,
      m.context_window ?? null,
      m.input_cost_per_million ?? null,
      m.output_cost_per_million ?? null,
      pricingModel,
      pricingSource,
      capabilitiesJson,
      status,
      rawJson,
      existing.id
    );
    return 'updated';
  }

  db.prepare(
    `INSERT INTO model_registry (
      model_id, label, provider, family, context_window,
      input_cost_per_million, output_cost_per_million,
      pricing_model, pricing_source, capabilities, status,
      raw_metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    m.model_id,
    m.label,
    m.provider,
    m.family ?? null,
    m.context_window ?? null,
    m.input_cost_per_million ?? null,
    m.output_cost_per_million ?? null,
    pricingModel,
    pricingSource,
    capabilitiesJson,
    status,
    rawJson
  );
  return 'added';
}

/**
 * Mark every model belonging to `provider` whose last_seen_at predates the
 * cutoff as `deprecated`. This is how rows that disappeared from the latest
 * provider catalog get tombstoned without losing existing assignments.
 */
function deprecateMissingModels(
  db: BetterDatabase,
  provider: string,
  cutoffIso: string
): number {
  const result = db
    .prepare(
      `UPDATE model_registry
       SET status = 'deprecated'
       WHERE provider = ? AND last_seen_at < ? AND status = 'active'`
    )
    .run(provider, cutoffIso);
  return result.changes;
}

/**
 * Append one row to `model_registry_refresh_log`. Surfaced on the Model
 * Configuration screen and System Status Panel.
 */
export function logRefreshOutcome(outcome: RefreshOutcome): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO model_registry_refresh_log
      (run_at, provider, success, models_added, models_updated, models_deprecated, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    outcome.run_at,
    outcome.provider,
    outcome.success ? 1 : 0,
    outcome.models_added,
    outcome.models_updated,
    outcome.models_deprecated,
    outcome.error_message ?? null
  );
}

/**
 * Run a refresh pass for one provider. Wrapped in a transaction so a partial
 * failure does not leave the registry half-updated.
 */
export async function refreshOneProvider(provider: ModelProvider): Promise<RefreshOutcome> {
  const startedIso = new Date().toISOString();
  const apiKey = apiKeyFor(provider.slug);

  if (!apiKey) {
    const outcome: RefreshOutcome = {
      provider: provider.slug,
      success: false,
      models_added: 0,
      models_updated: 0,
      models_deprecated: 0,
      error_message: `API key not set in env (expected ${provider.slug.toUpperCase().replace(/-/g, '_')}_API_KEY)`,
      run_at: startedIso,
    };
    logRefreshOutcome(outcome);
    return outcome;
  }

  try {
    const models = await provider.fetchModels(apiKey);
    const db = getDb();
    let added = 0;
    let updated = 0;

    const txn = db.transaction((rows: ProviderModel[]) => {
      for (const row of rows) {
        if (upsertModel(db, row) === 'added') added += 1;
        else updated += 1;
      }
    });
    txn(models);

    const deprecated = deprecateMissingModels(db, provider.slug, startedIso);

    const outcome: RefreshOutcome = {
      provider: provider.slug,
      success: true,
      models_added: added,
      models_updated: updated,
      models_deprecated: deprecated,
      run_at: new Date().toISOString(),
    };
    logRefreshOutcome(outcome);
    return outcome;
  } catch (error) {
    const outcome: RefreshOutcome = {
      provider: provider.slug,
      success: false,
      models_added: 0,
      models_updated: 0,
      models_deprecated: 0,
      error_message: error instanceof Error ? error.message : String(error),
      run_at: new Date().toISOString(),
    };
    logRefreshOutcome(outcome);
    return outcome;
  }
}

/**
 * Run a refresh pass for every provider supplied. The provider registry
 * (owned by Track C2 in `src/lib/model-providers/index.ts`) will pass the
 * full list. Until that exists, callers pass an explicit array.
 */
export async function refreshModels(providers: ModelProvider[]): Promise<RefreshOutcome[]> {
  const results: RefreshOutcome[] = [];
  for (const provider of providers) {
    // Sequential, not parallel, so a slow provider does not stack with
    // others and we can rate-limit politely.
    const outcome = await refreshOneProvider(provider);
    results.push(outcome);
  }
  return results;
}
