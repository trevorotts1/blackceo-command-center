/**
 * ensure-fleet-primary-model.ts — FIX-24 (Error 13 / T-24) per-box reconcile.
 *
 * Registers the LIVE fleet primary model id (`deepseek-v4-flash:0731-cloud`,
 * registry-scoped `ollama-cloud/deepseek-v4-flash:0731-cloud`) in `model_registry`
 * so the operator catalog names the model the fleet actually runs — and never
 * the retired `:cloud` build or a phantom `0713`.
 *
 * The weekly refresh pulls the live Ollama Cloud catalog, so the row appears
 * after any refresh; this reconcile makes it present NOW on a box that has not
 * refreshed since the 2026-08-06 fleet rollout (the exact state that triggered
 * Error 13's catalog/instruction truth gap).
 *
 * SAFE: idempotent (upsert by natural key, never duplicates), never deprecates,
 * never touches client/provider sovereignty, never prints a secret. Dry-run by
 * default unless --apply is passed (identical to unfreeze-sovereignty-blocks.ts).
 *
 *   npx tsx scripts/remediate/ensure-fleet-primary-model.ts          # dry-run
 *   npx tsx scripts/remediate/ensure-fleet-primary-model.ts --apply   # register
 */

import { getDb, queryOne } from '../../src/lib/db';
import { ensureFleetPrimaryModel, FLEET_PRIMARY_MODEL_ID } from '../../src/lib/model-registry';

const APPLY = process.argv.includes('--apply');

function main(): void {
  getDb(); // ensure migrations are applied before touching the schema

  const existing = queryOne<{ id: number }>(
    'SELECT id FROM model_registry WHERE model_id = ?',
    [FLEET_PRIMARY_MODEL_ID],
  );

  if (existing) {
    console.log(
      `[fix24] live fleet primary already registered: ${FLEET_PRIMARY_MODEL_ID} (row id ${existing.id}).`,
    );
    return;
  }

  if (!APPLY) {
    console.log(
      `[fix24] DRY RUN: ${FLEET_PRIMARY_MODEL_ID} is not in the registry. ` +
        `Pass --apply to register the live fleet primary id.`,
    );
    return;
  }

  const outcome = ensureFleetPrimaryModel();
  console.log(`[fix24] registered ${FLEET_PRIMARY_MODEL_ID} (${outcome}).`);
}

main();
