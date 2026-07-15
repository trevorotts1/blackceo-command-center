#!/usr/bin/env tsx
/**
 * scripts/heal-phantom-assignments.ts — C-04 (skill6-v2 U35).
 *
 * One-time, migration-safe, idempotent cleanup of every EXISTING phantom
 * `assigned_agent_id` (a task references an agent id that has no matching
 * `agents` row on this box). Delegates the actual healing to
 * `healPhantomAssignmentsBatch()` (src/lib/jobs/heal-phantom-assignments.ts)
 * — the SAME primitive `autoDispatchTask`'s real-time catch and
 * `intake-advance-sweep`'s per-tick tail use, so a task healed here produces
 * the identical event vocabulary (`type: 'phantom_agent_healed'`,
 * `metadata.reason: 'assigned_agent_missing'`) as one healed live.
 *
 * SCOPE: every task that is NOT `status = 'done'` and NOT archived
 * (`archived_at IS NULL`). `done`/archived rows are NEVER touched — history
 * stays honest; a completed task's record of who it was assigned to when it
 * finished is not something this script's job is to rewrite.
 *
 * IDEMPOTENT: re-running after a successful heal reports 0 healed (the scan
 * condition `assigned_agent_id NOT IN (SELECT id FROM agents)` is false once
 * the id has been cleared).
 *
 * Every healed task gets exactly ONE `events` row naming the dead agent id it
 * was un-assigned from — never a DELETE, never a silent bulk UPDATE with no
 * per-row trace.
 *
 * Usage:
 *   npx tsx scripts/heal-phantom-assignments.ts
 */

import { getDb, closeDb } from '@/lib/db';
import { healPhantomAssignmentsBatch } from '@/lib/jobs/heal-phantom-assignments';

async function main(): Promise<void> {
  // Touch the DB so migrations run and the singleton connection is ready.
  getDb();

  const result = healPhantomAssignmentsBatch({ healedBy: 'heal-phantom-assignments-script' });

  console.log(`[heal-phantom-assignments] healed ${result.healed} phantom assignment(s).`);
  if (result.healed > 0) {
    console.log(`[heal-phantom-assignments] healed task ids: ${result.healedIds.join(', ')}`);
  } else {
    console.log('[heal-phantom-assignments] nothing to heal (idempotent — safe to re-run).');
  }

  closeDb();
}

// Run as a CLI only when invoked directly (importable by tests otherwise).
import { pathToFileURL } from 'url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[heal-phantom-assignments] FATAL:', (err as Error).message);
    process.exit(1);
  });
}
