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

import { getDb, sqlTimePrecise, timeNow } from '@/lib/db';
import type { Database as BetterDatabase } from 'better-sqlite3';
import type { ModelProvider, ProviderModel } from '@/lib/model-providers/types';
import { ALL_PROVIDERS } from '@/lib/model-providers';
import { resolveProviderApiKey } from '@/lib/provider-key-detection';
import { notifySystem } from '@/lib/notify';

/**
 * MODEL-07 circuit-breaker thresholds. A refresh that would deprecate at least
 * MASS_DEPRECATION_MIN_ROWS rows AND at least MASS_DEPRECATION_RATIO of a
 * provider's active catalog is treated as a WIPE and refused (see
 * `deprecateMissingModels`). Small, ordinary retirements pass straight through.
 */
const MASS_DEPRECATION_MIN_ROWS = Math.max(
  1,
  parseInt(process.env.MODEL_REFRESH_MASS_DEPRECATION_MIN_ROWS || '10', 10)
);
const MASS_DEPRECATION_RATIO = 0.5;

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
  m: ProviderModel,
  seenAt: string = timeNow()
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
        last_seen_at = ?,
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
      seenAt,
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
      last_seen_at, raw_metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    // MODEL-07: stamp last_seen_at EXPLICITLY in the canonical ISO dialect.
    // The column DEFAULT is `datetime('now')` (SQLite space form); relying on it
    // put fresh rows in the OTHER dialect from every JS writer — half the reason
    // the deprecation predicate below mis-sorted them.
    seenAt,
    rawJson
  );
  return 'added';
}

/**
 * Mark every model belonging to `provider` whose last_seen_at predates the
 * cutoff as `deprecated`. This is how rows that disappeared from the latest
 * provider catalog get tombstoned without losing existing assignments.
 *
 * ── MODEL-07: CATALOG SELF-DESTRUCT (fixed) ──────────────────────────────────
 * This predicate used to compare `last_seen_at < ?` as raw TEXT, with:
 *   • the column written by SQLite `datetime('now')` → `2026-07-11 16:02:42`
 *     (SPACE separator), and
 *   • the bound cutoff from JS `.toISOString()` → `2026-07-11T16:02:41.637Z`
 *     ('T' separator).
 * Both sides land on the SAME DATE (the cutoff IS this run's start), so the
 * separator ALWAYS decided the comparison — and ' ' (0x20) sorts BELOW 'T'
 * (0x54). Every row the refresh had just stamped therefore satisfied
 * `last_seen_at < cutoff` and instantly re-deprecated ITSELF. A refresh took a
 * live 20-model catalog to 0 active models, every run, on every box.
 *
 * The fix parses BOTH sides to a real datetime instead of sorting them as
 * strings, using `sqlTimePrecise()` — the sub-second-precise sibling of the
 * repo's B2 `sqlTime()` helper. It folds the ISO 'T'/'Z' form to the SQLite
 * space form and wraps it in `julianday(...)`, so the comparison is between
 * numeric INSTANTS, not bytes — correct for legacy space-dialect rows AND
 * canonical ISO rows alike.
 *
 * Why `sqlTimePrecise()` and not plain `sqlTime()`: `sqlTime()` wraps
 * `datetime(...)`, which truncates to whole SECONDS. The cutoff here IS "now",
 * and a model's `last_seen_at` may have been stamped moments earlier in the same
 * second — truncation would collapse them to equal and a model that genuinely
 * VANISHED from the provider catalog would escape tombstoning. `julianday(...)`
 * keeps fractional seconds, so both directions stay correct.
 *
 * NOTE: this is a real datetime comparison, not a tolerance window or fudge
 * factor. A model that genuinely vanished from the provider catalog still has a
 * strictly-older `last_seen_at` and is still correctly deprecated (test 3 in
 * tests/unit/model-catalog-self-destruct.test.ts pins exactly that).
 */
function deprecateMissingModels(
  db: BetterDatabase,
  provider: string,
  cutoffIso: string
): { deprecated: number; refused?: string } {
  const wherePredicate = `provider = ?
         AND ${sqlTimePrecise('last_seen_at')} < ${sqlTimePrecise('?')}
         AND status = 'active'`;

  // ── MODEL-07 CIRCUIT BREAKER ────────────────────────────────────────────────
  // Count FIRST, mutate second. A refresh that is about to tombstone most of a
  // provider's catalog is not a cleanup — it is a bug (a dialect mismatch, an
  // empty/failed provider response, a schema drift). The self-destruct above ran
  // on a Sunday cron and silently deprecated 557 models a week for a MONTH
  // because nothing ever looked at the magnitude of what it was about to do.
  //
  // So: refuse, and SCREAM. A mass-deprecation now requires a deliberate opt-in
  // (MODEL_REFRESH_ALLOW_MASS_DEPRECATION=1) for the genuine case where a
  // provider really did retire most of its catalog. Refusing is always the safe
  // side: a stale 'active' row is recoverable, a wiped catalog is not (it takes
  // every task's model resolution down with it).
  const wouldDeprecate =
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM model_registry WHERE ${wherePredicate}`)
        .get(provider, cutoffIso) as { n: number } | undefined
    )?.n ?? 0;

  const activeTotal =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM model_registry WHERE provider = ? AND status = 'active'`
        )
        .get(provider) as { n: number } | undefined
    )?.n ?? 0;

  if (wouldDeprecate === 0) return { deprecated: 0 };

  const ratio = activeTotal > 0 ? wouldDeprecate / activeTotal : 0;
  const massDeprecation =
    wouldDeprecate >= MASS_DEPRECATION_MIN_ROWS && ratio >= MASS_DEPRECATION_RATIO;
  const optedIn =
    process.env.MODEL_REFRESH_ALLOW_MASS_DEPRECATION === '1' ||
    process.env.MODEL_REFRESH_ALLOW_MASS_DEPRECATION === 'true';

  if (massDeprecation && !optedIn) {
    const pct = Math.round(ratio * 100);
    const refused =
      `REFUSED mass-deprecation: this refresh would deprecate ${wouldDeprecate} of ` +
      `${activeTotal} active '${provider}' models (${pct}%). That is a catalog wipe, ` +
      `not a cleanup — refusing. Nothing was deprecated. Investigate the provider ` +
      `response and the last_seen_at dialect. Override with ` +
      `MODEL_REFRESH_ALLOW_MASS_DEPRECATION=1 only if this retirement is real.`;
    // LOUD: this must never be a silent no-op again.
    console.error(`[refresh-models] ${refused}`);
    notifySystem(`🚨 Model catalog: ${refused}`, {
      agent: 'refresh-models',
      action: 'escalate',
    });
    return { deprecated: 0, refused };
  }

  const result = db
    .prepare(
      `UPDATE model_registry
       SET status = 'deprecated'
       WHERE ${wherePredicate}`
    )
    .run(provider, cutoffIso);
  return { deprecated: result.changes };
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

    // MODEL-07: ONE canonical `seen` stamp for the whole pass, taken AFTER the
    // cutoff (`startedIso`). Every row this run touches is stamped with it, so
    // `last_seen_at < cutoff` is false for all of them by construction — a
    // just-refreshed model can never deprecate itself again.
    const seenAt = timeNow();

    const txn = db.transaction((rows: ProviderModel[]) => {
      for (const row of rows) {
        if (upsertModel(db, row, seenAt) === 'added') added += 1;
        else updated += 1;
      }
    });
    txn(models);

    const { deprecated, refused } = deprecateMissingModels(db, provider.slug, startedIso);

    const outcome: RefreshOutcome = {
      provider: provider.slug,
      success: true,
      models_added: added,
      models_updated: updated,
      models_deprecated: deprecated,
      // A refused mass-deprecation is recorded in the refresh log so it is
      // VISIBLE on the Model Configuration screen instead of vanishing into a
      // console nobody reads. The refresh itself still succeeded (the catalog
      // was refreshed); only the destructive step was withheld.
      ...(refused ? { error_message: refused } : {}),
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
