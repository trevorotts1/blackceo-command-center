/**
 * heal-phantom-assignments.ts — C-03 + C-04 (skill6-v2 U34/U35).
 *
 * THE PROBLEM (Maria-pattern S2, class (a) — "fake agent"):
 *   `autoDispatchTask` used to load the task's `assigned_agent_id`, find no
 *   matching `agents` row, and silently `console.warn` + return — no event,
 *   no `recordDispatchFailure`, no backoff, no block, no operator alert. The
 *   card kept its phantom `assigned_agent_id` forever; `intake-advance`
 *   re-selects it every ~2 minutes and re-skipped it forever — a quiet loop,
 *   invisible on the board (task-dispatcher.ts:426-436 pre-fix).
 *
 *   A phantom id can appear even though `tasks.assigned_agent_id` carries a
 *   `REFERENCES agents(id)` clause and the app runs with
 *   `PRAGMA foreign_keys = ON`, because: (i) SQLite only enforces a REFERENCES
 *   clause that was baked into the table's ORIGINAL `CREATE TABLE` — a box
 *   whose `tasks` table predates the clause never enforces it; (ii) migrations
 *   legitimately run windows with `PRAGMA foreign_keys = OFF`
 *   (db/migrations.ts); (iii) raw SQL / manual DB surgery bypasses the API
 *   route's own FK-safe path entirely.
 *
 * THE FIX — ONE shared healing primitive, used by THREE call sites so every
 * phantom assignment produces the SAME durable, queryable event vocabulary
 * regardless of how it was discovered:
 *
 *   1. `autoDispatchTask`'s own real-time "agent not found" branch
 *      (task-dispatcher.ts) — catches a phantom the instant a dispatch
 *      attempt actually touches it. LOUD (console.error + one events row +
 *      one SYSTEM notify), SELF-HEALING (clears the phantom id instead of
 *      hard-blocking), CAPPED (the CAS-guarded UPDATE only fires the event
 *      once per phantom-id-instance — a losing race writes nothing).
 *   2. `intake-advance-sweep`'s per-tick tail — proactively heals any
 *      advanceable-status phantom BEFORE that tick's selection query runs, so
 *      a phantom introduced after this fix ships (raw SQL, a restored
 *      backup, a foreign-keys-off migration window) is healed AND re-routed
 *      within the SAME tick.
 *   3. `scripts/heal-phantom-assignments.ts` — a one-time idempotent sweep
 *      over every non-done, non-archived task in the database (broader scope
 *      than #2, which only looks at the advanceable-status subset).
 *
 * WHY UN-ASSIGNING (not blocking) IS THE RIGHT FIX:
 *   Unlike the `no_specialist_runtime` hold (task-dispatcher.ts, C-06 — a
 *   department genuinely has NO OpenClaw runtime and needs a human to wire
 *   one), a phantom `assigned_agent_id` is immediately, mechanically
 *   recoverable: NULL it and `routeTask()` (department-router.ts) — which
 *   only ever returns REAL agent rows — re-routes the card on the very next
 *   `intake-advance` tick. Hard-blocking it would just trade one silent stall
 *   (skip forever) for another (blocked forever, waiting on a human who has
 *   nothing to fix). The `events` row is the permanent, honest record of what
 *   was removed and why — never discarded, never silently overwritten.
 */

import { v4 as uuidv4 } from 'uuid';
import { run, queryOne, queryAll, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';

/** The exact event `type` every phantom-assignment heal writes. */
export const PHANTOM_HEALED_EVENT_TYPE = 'phantom_agent_healed';
/** The exact `metadata.reason` every phantom-assignment heal writes. */
export const PHANTOM_HEALED_REASON = 'assigned_agent_missing';

/**
 * Heal ONE task's phantom assignment.
 *
 * CAS-guarded: the UPDATE's WHERE clause matches only `assigned_agent_id =
 * deadAgentId` (the exact stale value the caller observed), so two callers
 * racing the SAME phantom id (e.g. a dispatch attempt and the sweep-tail
 * firing in the same window) heal it exactly once — the loser's UPDATE
 * matches 0 rows, writes NO duplicate event, and returns `false`. This is
 * the "capped" half of "loud, capped, self-healing": no matter how many
 * callers observe the same phantom, exactly one events row and one
 * broadcast result from it.
 *
 * Never touches a `done` task (callers are expected to pre-filter, but the
 * WHERE clause additionally excludes it defensively so this primitive is
 * safe to call from any context) and never DELETEs anything — the events
 * row preserves what was removed.
 *
 * @returns true if THIS call performed the heal; false if there was nothing
 *   to heal (already healed by a concurrent caller, or the id no longer
 *   matches).
 */
export function healPhantomAgentAssignment(
  taskId: string,
  deadAgentId: string,
  healedBy: string,
): boolean {
  const now = new Date().toISOString();
  return transaction(() => {
    const claim = run(
      `UPDATE tasks SET assigned_agent_id = NULL, updated_at = ?
         WHERE id = ? AND assigned_agent_id = ? AND status != 'done'`,
      [now, taskId, deadAgentId],
    );
    if (claim.changes !== 1) {
      // Already healed (or reassigned to something else) by a concurrent
      // caller, or the task is done. No duplicate event, no duplicate alert.
      return false;
    }
    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      [
        uuidv4(),
        PHANTOM_HEALED_EVENT_TYPE,
        taskId,
        `[phantom-agent-healed] Task ${taskId} referenced agent id "${deadAgentId}" ` +
          `which has no agents row on this box. Cleared the phantom assignment (by ` +
          `${healedBy}) so intake-advance re-routes it to a real agent.`,
        JSON.stringify({
          reason: PHANTOM_HEALED_REASON,
          dead_agent_id: deadAgentId,
          healed_by: healedBy,
        }),
        now,
      ],
    );
    return true;
  });
}

export interface PhantomHealBatchResult {
  healed: number;
  healedIds: string[];
}

/**
 * Batch-heal every task whose `assigned_agent_id` references a nonexistent
 * `agents` row.
 *
 * Scope:
 *   - `statuses` provided (intake-advance-sweep's per-tick tail): only tasks
 *     currently in one of those statuses — cheap, and matches exactly the set
 *     that tick's own selection query cares about.
 *   - `statuses` omitted (the standalone script): every task that is not
 *     `done` and not archived — the full-box one-time sweep the spec asks for
 *     (`UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id IS
 *     NOT NULL AND assigned_agent_id NOT IN (SELECT id FROM agents) AND
 *     status NOT IN ('done')`, done here as a SELECT-then-heal so each row
 *     gets its own durable event instead of one anonymous bulk UPDATE).
 *
 * Idempotent: a second call over the same DB heals 0 rows (the scan condition
 * `assigned_agent_id NOT IN (SELECT id FROM agents)` is false once the id has
 * been cleared).
 *
 * Never throws: a scan or per-row failure is logged and treated as 0 healed
 * for that row — this runs inside a sweep tick and must never abort it.
 */
export function healPhantomAssignmentsBatch(opts: {
  healedBy: string;
  statuses?: string[];
}): PhantomHealBatchResult {
  const { healedBy, statuses } = opts;

  let rows: Array<{ id: string; assigned_agent_id: string }>;
  try {
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(',');
      rows = queryAll(
        `SELECT id, assigned_agent_id FROM tasks
          WHERE assigned_agent_id IS NOT NULL
            AND assigned_agent_id NOT IN (SELECT id FROM agents)
            AND status IN (${placeholders})
            AND archived_at IS NULL`,
        statuses,
      );
    } else {
      rows = queryAll(
        `SELECT id, assigned_agent_id FROM tasks
          WHERE assigned_agent_id IS NOT NULL
            AND assigned_agent_id NOT IN (SELECT id FROM agents)
            AND status NOT IN ('done')
            AND archived_at IS NULL`,
        [],
      );
    }
  } catch (err) {
    // Pre-migration DB (no events table, e.g.) — non-fatal, matches every
    // other sweep in this codebase's tolerance for an un-migrated box.
    console.warn(
      `[heal-phantom-assignments] scan failed (non-fatal): ${(err as Error).message}`,
    );
    return { healed: 0, healedIds: [] };
  }

  const healedIds: string[] = [];
  for (const row of rows) {
    try {
      if (healPhantomAgentAssignment(row.id, row.assigned_agent_id, healedBy)) {
        healedIds.push(row.id);
        try {
          const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [row.id]);
          if (updated) broadcast({ type: 'task_updated', payload: updated });
        } catch {
          /* broadcast best-effort */
        }
      }
    } catch (err) {
      console.warn(
        `[heal-phantom-assignments] heal failed for task ${row.id} (non-fatal): ${(err as Error).message}`,
      );
    }
  }
  return { healed: healedIds.length, healedIds };
}
