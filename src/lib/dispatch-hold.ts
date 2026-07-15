/**
 * U37 (C-06, master spec v2 `skill6-blended-persona-kanban-MASTER-SPEC-v2-2026-07-13.md`
 * §C+I.2) — S2 class-b visibility: "routed but not runnable" must be visible
 * ON THE CARD, not only in events.
 *
 * `autoDispatchTask` already HOLDs a task (loud, capped, self-healing — see
 * `task-dispatcher.ts` RESOLVER-DISPATCH gate) when a card is routed to a real
 * `agents` row that has NO corresponding OpenClaw runtime on disk
 * (`~/.openclaw/agents/<dept-slug>/` missing). That hold writes a durable
 * `task_activities` row (`activity_type: 'routed_but_not_dispatched'`,
 * `metadata.reason: 'no_specialist_runtime'`) plus a mirrored `events` row —
 * but until this unit, that signal was ONLY visible in the activity feed. The
 * board card looked like a normal, healthy assignment.
 *
 * This module is the READ-PATH that powers the card-face chip (MissionQueue's
 * TaskCard) and the task-detail modal panel (TaskOverviewPanels'
 * DispatchHoldPanel) — display only, no lifecycle change (per the unit's
 * binary acceptance (c), the existing block-on-cap path via
 * `recordDispatchFailure` is untouched).
 *
 * Deliberately keyed off the task's LATEST `task_activities` row (any type),
 * not "has this task ever held" — so the chip disappears the instant a later
 * activity (a successful dispatch's `status_changed` row, or any other
 * activity) supersedes the hold. Never a stale banner once the runtime is
 * wired and dispatch succeeds (binary acceptance (b)).
 */
import { queryOne } from '@/lib/db';

export const DISPATCH_HOLD_ACTIVITY_TYPE = 'routed_but_not_dispatched';

/** Class-b hold chip payload — mirrors the `dispatch_hold` field the tasks GET
 * routes attach to each row (src/lib/types.ts). */
export interface DispatchHoldInfo {
  /** The verbatim hold message task-dispatcher.ts wrote, INCLUDING the fix
   * instruction ("Wire the department runtime to release."). Never re-derived
   * or paraphrased — the card/modal show exactly what the dispatcher wrote. */
  message: string;
  reason: string | null;
  workspace_id: string | null;
  role: string | null;
  created_at: string;
}

/**
 * Read-path: is the task's newest `task_activities` row a class-b "routed but
 * not runnable" hold? Fail-soft: any query error (pre-migration box, missing
 * table, malformed metadata) returns null rather than breaking the board —
 * matching the fail-soft discipline of the sibling B-U6/U20 comparator
 * (`getOpenPersonaMismatch`, src/lib/persona-mismatch.ts).
 */
export function getOpenDispatchHold(taskId: string): DispatchHoldInfo | null {
  try {
    const row = queryOne<{
      activity_type: string;
      message: string;
      metadata: string | null;
      created_at: string;
    }>(
      `SELECT activity_type, message, metadata, created_at
         FROM task_activities
        WHERE task_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [taskId],
    );
    if (!row || row.activity_type !== DISPATCH_HOLD_ACTIVITY_TYPE) return null;

    let reason: string | null = null;
    let workspace_id: string | null = null;
    let role: string | null = null;
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
        reason = typeof parsed.reason === 'string' ? parsed.reason : null;
        workspace_id = typeof parsed.workspace_id === 'string' ? parsed.workspace_id : null;
        role = typeof parsed.role === 'string' ? parsed.role : null;
      } catch {
        // Malformed metadata never blocks the message itself from rendering.
      }
    }

    return { message: row.message, reason, workspace_id, role, created_at: row.created_at };
  } catch (err) {
    console.warn(`[dispatch-hold] read skipped for task ${taskId} (non-fatal):`, (err as Error).message);
    return null;
  }
}
