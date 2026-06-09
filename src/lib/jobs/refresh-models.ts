/**
 * Weekly model-registry refresh job per PRD Section 3.4 (Fix #4).
 *
 * Exposes:
 *   - `refreshModels()`           run a refresh pass for every provider (or a
 *                                 provided subset)
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
import { ALL_PROVIDERS } from '@/lib/model-providers';
import { resolveProviderApiKey } from '@/lib/provider-key-detection';

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

// `apiKeyFor` is superseded by `resolveProviderApiKey` from
// @/lib/provider-key-detection, which checks all env stores and respects the
// connector's `envCandidates` list. The old single-env-var lookup is removed
// to fix the "Ollama Cloud / OpenRouter show as not set" class of bugs.

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

  // Resolve the API key using the multi-store, multi-alias detection helper.
  // local_endpoint providers (e.g. ollama-local) skip key detection entirely —
  // they authenticate via a local daemon and fetchModels is called with ''.
  const keyResult = resolveProviderApiKey(provider);

  let apiKey: string;
  if ('localEndpoint' in keyResult) {
    // Local endpoint — no key check. Pass empty string; the connector's
    // reachability probe decides whether the daemon is up.
    apiKey = '';
  } else if (!keyResult.found) {
    const checked = keyResult.checked.join(', ');
    const outcome: RefreshOutcome = {
      provider: provider.slug,
      success: false,
      models_added: 0,
      models_updated: 0,
      models_deprecated: 0,
      error_message: `API key not set (checked: ${checked})`,
      run_at: startedIso,
    };
    logRefreshOutcome(outcome);
    return outcome;
  } else {
    apiKey = keyResult.value;
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
 * Run a refresh pass for every provider supplied (defaults to ALL_PROVIDERS
 * from the central registry). Uses `Promise.allSettled` so one bad connector
 * cannot block the others. Per-provider errors are already logged inside
 * `refreshOneProvider()` via `logRefreshOutcome()`.
 */
export async function refreshModels(
  providers: ModelProvider[] = ALL_PROVIDERS
): Promise<RefreshOutcome[]> {
  const settled = await Promise.allSettled(
    providers.map((p) => refreshOneProvider(p))
  );

  const results: RefreshOutcome[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      results.push(r.value);
    } else {
      // refreshOneProvider catches internally, but defensively log any
      // pathological case where the wrapper itself rejected.
      const provider = providers[i];
      const outcome: RefreshOutcome = {
        provider: provider.slug,
        success: false,
        models_added: 0,
        models_updated: 0,
        models_deprecated: 0,
        error_message: r.reason instanceof Error ? r.reason.message : String(r.reason),
        run_at: new Date().toISOString(),
      };
      try {
        logRefreshOutcome(outcome);
      } catch (logError) {
        console.error(`[refresh-models] failed to log outcome for ${provider.slug}:`, logError);
      }
      results.push(outcome);
    }
  }
  return results;
}
