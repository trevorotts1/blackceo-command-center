/**
 * unfreeze-sovereignty-blocks.ts — P1-01 per-box REMEDIATION (residue cleanup).
 *
 * A code update alone does NOT clean a box that was already damaged by the
 * phantom-worker chain: tasks that the old classifier flipped to `vision` and the
 * sovereignty gate then blocked stay frozen with `block_reason LIKE
 * 'model_sovereignty%'`, and a box whose catalog self-destructed (MODEL-07) may
 * still have zero active models. This script performs the two residue steps the
 * new code cannot do for a pre-existing damaged box. It is invoked by the P6-01
 * per-box rollout AFTER the v5.17.0 code is deployed on that box.
 *
 * It does THREE things, in order:
 *   1. Unfreeze every task blocked on a model-sovereignty reason: reset the
 *      dispatch attempt-accounting and return it to `backlog` so the intake sweep
 *      re-dispatches it (now correctly, with the conservative classifier +
 *      vision→text downgrade).
 *   2. Force ONE model refresh so a self-destructed catalog re-activates its
 *      re-seen models (the refresh upsert reactivates rows).
 *   3. Assert at least one active model exists afterward.
 *
 * SAFE: idempotent (re-running unfreezes nothing new once tasks have advanced),
 * archived tasks are never touched, and it never prints a secret value — only
 * counts and pass/fail. Dry-run by default unless --apply is passed.
 *
 *   npx tsx scripts/remediate/unfreeze-sovereignty-blocks.ts            # dry-run
 *   npx tsx scripts/remediate/unfreeze-sovereignty-blocks.ts --apply    # execute
 */

import { getDb, run, queryAll, queryOne } from '../../src/lib/db';
import { refreshModels } from '../../src/lib/jobs/refresh-models';

const APPLY = process.argv.includes('--apply');
// Allow skipping the network refresh in constrained rollout stages (the SQL
// unfreeze still runs); the caller can refresh separately.
const SKIP_REFRESH = process.argv.includes('--skip-refresh');

const SOVEREIGNTY_BLOCK_PREDICATE =
  `block_reason LIKE 'model_sovereignty%' AND archived_at IS NULL`;

async function main(): Promise<void> {
  getDb(); // ensure migrations are applied before touching the schema

  const frozen = queryAll<{ id: string; title: string }>(
    `SELECT id, title FROM tasks WHERE ${SOVEREIGNTY_BLOCK_PREDICATE}`,
  );
  console.log(
    `[unfreeze] ${frozen.length} task(s) frozen on a model-sovereignty block` +
      (APPLY ? ' — unfreezing.' : ' — DRY RUN (pass --apply to execute).'),
  );

  if (APPLY && frozen.length > 0) {
    // Exact P1-01 unfreeze: reset attempt-accounting + return to backlog. Also
    // clears the now-stale block metadata (block_needs/block_audience) so the card
    // is a clean backlog item, not a half-blocked one.
    const res = run(
      `UPDATE tasks
         SET dispatch_attempts = 0,
             next_dispatch_eligible_at = NULL,
             status = 'backlog',
             block_reason = NULL,
             block_needs = NULL,
             block_audience = NULL,
             updated_at = ?
       WHERE ${SOVEREIGNTY_BLOCK_PREDICATE}`,
      [new Date().toISOString()],
    );
    console.log(`[unfreeze] returned ${res.changes} task(s) to backlog.`);
  }

  // ── Step 2: one forced model refresh so a self-destructed catalog self-heals.
  if (APPLY && !SKIP_REFRESH) {
    console.log('[unfreeze] forcing one model refresh to reactivate re-seen models…');
    try {
      const outcomes = await refreshModels();
      const added = outcomes.reduce((n, o) => n + (o.models_added ?? 0), 0);
      const updated = outcomes.reduce((n, o) => n + (o.models_updated ?? 0), 0);
      const ok = outcomes.filter((o) => o.success).length;
      console.log(
        `[unfreeze] refresh complete — providers ok=${ok}/${outcomes.length}, ` +
          `added=${added}, updated=${updated}.`,
      );
    } catch (err) {
      // Never crash the rollout on a transient provider hiccup — the unfreeze
      // itself already landed; the next scheduled refresh will retry.
      console.warn('[unfreeze] model refresh failed (non-fatal):', (err as Error).message);
    }
  } else if (APPLY && SKIP_REFRESH) {
    console.log('[unfreeze] --skip-refresh set; skipping the forced model refresh.');
  }

  // ── Step 3: assert at least one active model exists (the acceptance gate).
  const active = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM model_registry WHERE status = 'active'`,
  );
  const activeCount = active?.n ?? 0;
  console.log(`[unfreeze] active models now: ${activeCount}`);

  if (APPLY && !SKIP_REFRESH && activeCount === 0) {
    console.error(
      '[unfreeze] FAIL: zero active models after refresh — this box still cannot ' +
        'dispatch. Investigate provider connectivity / keys before releasing tasks.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[unfreeze] ${APPLY ? 'DONE' : 'DRY-RUN OK'}.`);
}

main().catch((err) => {
  console.error('[unfreeze] fatal:', (err as Error).message);
  process.exitCode = 1;
});
