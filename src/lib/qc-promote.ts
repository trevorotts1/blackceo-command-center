/**
 * U38 (C-07, master spec v2
 * `skill6-blended-persona-kanban-MASTER-SPEC-v2-2026-07-13.md` §C+I.2) — S3
 * closure: the human-promote control for parked review cards.
 *
 * The QC auto-scorer (`qc-scorer.ts`) parks a `review` task ON PURPOSE when it
 * runs in heuristic mode (no LLM/judge key configured) rather than silently
 * approving or endlessly re-scoring it: the FIRST N passes each write a
 * `[QC-HEURISTIC]` `qc_review` event and leave the task in `review`; after
 * `QC_HEURISTIC_NO_KEY_MAX_PASSES` (default 3) passes it escalates ONCE to a
 * terminal `[QC-HEURISTIC-FINAL]` event and the qc-review-sweep excludes the
 * task permanently (`qc-scorer.ts:4104-4186`). The stale sweep also leaves
 * such a task untouched rather than bouncing it (`stale-task-sweep.ts:111-133`,
 * `isParkedInReview`). Both of those existing read-paths ask "has this task
 * EVER carried a heuristic marker" (a COUNT/EXISTS query) — they don't need to
 * know WHICH marker or WHEN.
 *
 * This module answers a narrower question for the human-promote control: is
 * the task's NEWEST `qc_review` event SPECIFICALLY `[QC-HEURISTIC]` or
 * `[QC-HEURISTIC-FINAL]`, right now? That distinction matters here because the
 * promote button must NEVER render for an LLM-scored review card (whose
 * latest `qc_review` event is `[QC-AUTO]` or `[QC-DEFERRED-PROVIDER-DOWN]` —
 * see `qc-scorer.ts:4085-4101,4192-4198`) even if an OLDER heuristic pass
 * exists somewhere in the task's history (e.g. the box gained a judge key and
 * has since been re-scored by an LLM, which stays authoritative).
 *
 * Fail-soft, same discipline as the sibling U37/C-06 read-path
 * (`src/lib/dispatch-hold.ts`): any query error (pre-migration box, malformed
 * row) returns null rather than breaking the board or the modal.
 */
import { queryOne } from '@/lib/db';

export type QcHeuristicParkMarker = 'QC-HEURISTIC' | 'QC-HEURISTIC-FINAL';

/** Promote-panel payload — mirrors the `qc_heuristic_park` field the tasks GET
 * routes attach to each row (src/lib/types.ts). */
export interface QcHeuristicParkInfo {
  /** Which of the two heuristic markers the latest qc_review event carries. */
  marker: QcHeuristicParkMarker;
  /** The verbatim qc_review event message qc-scorer.ts wrote. Never re-derived
   * or paraphrased — the panel shows exactly what the scorer wrote. */
  message: string;
  created_at: string;
}

/**
 * Read-path: is this task's NEWEST `qc_review` event a heuristic-parked
 * marker? Returns null for every other case — no such event, the newest one
 * is `[QC-AUTO]` / `[QC-DEFERRED-PROVIDER-DOWN]` / anything else, or the query
 * itself fails.
 */
export function getQcHeuristicPark(taskId: string): QcHeuristicParkInfo | null {
  try {
    const row = queryOne<{ message: string; created_at: string }>(
      `SELECT message, created_at FROM events
        WHERE task_id = ? AND type = 'qc_review'
        ORDER BY created_at DESC
        LIMIT 1`,
      [taskId],
    );
    if (!row) return null;

    // SQLite LIKE treats '[' literally (no bracket char-classes) — same fact
    // stale-task-sweep.ts's isParkedInReview relies on — so a plain
    // string.includes() exact-substring check is equivalent and needs no
    // escaping. '[QC-HEURISTIC-FINAL]' does NOT contain the substring
    // '[QC-HEURISTIC]' (the character right after "HEURISTIC" differs — ']'
    // vs '-'), so checking FINAL first is defensive but the two branches
    // never actually overlap.
    if (row.message.includes('[QC-HEURISTIC-FINAL]')) {
      return { marker: 'QC-HEURISTIC-FINAL', message: row.message, created_at: row.created_at };
    }
    if (row.message.includes('[QC-HEURISTIC]')) {
      return { marker: 'QC-HEURISTIC', message: row.message, created_at: row.created_at };
    }
    return null;
  } catch (err) {
    console.warn(`[qc-promote] read skipped for task ${taskId} (non-fatal):`, (err as Error).message);
    return null;
  }
}
