/**
 * block-events.ts — MR-30 block-history audit trail.
 *
 * When a task enters `blocked`, a snapshot of its block metadata (reason, gaps,
 * needs, audience, human-block fields) is written to `task_block_events`. The
 * most recent row is surfaced in the task-detail modal (as Task.last_block_event)
 * even AFTER the card leaves blocked, so the operator can confirm the underlying
 * issue was resolved.
 *
 * This parallels the dispatch-hold and qc-promote patterns (computed per-row on
 * GET, derived from a dedicated audit table, never a persisted column).
 */

import { v4 as uuidv4 } from 'uuid';
import { run, queryOne, queryAll, transaction } from '@/lib/db';
import type { TaskBlockEvent } from '@/lib/types';

/**
 * Record a block snapshot. Call this together with the status flip to `blocked`.
 *
 * The INSERT runs inside its own `transaction()` so the snapshot is a single
 * atomic write — it either lands whole or not at all. Because better-sqlite3
 * transactions nest as savepoints, a caller that wraps BOTH the status flip and
 * this call in one `transaction()` gets the full DISP-09 guarantee (the block
 * and its audit row commit together, or neither does); a caller that invokes it
 * immediately after the flip still gets an atomic, isolated audit write.
 *
 * Best-effort; never throws — losing the audit row is not worse than the
 * pre-existing state of having no history at all.
 */
export function recordBlockEvent(params: {
  taskId: string;
  blockReason?: string | null;
  blockGaps?: string | null;
  blockNeeds?: string | null;
  blockAudience?: string | null;
  blockedOnHuman?: string | null;
  ask?: string | null;
  actor?: string | null;
}): void {
  try {
    transaction(() => {
      run(
        `INSERT INTO task_block_events
           (id, task_id, block_reason, block_gaps, block_needs, block_audience,
            blocked_on_human, ask, actor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          params.taskId,
          params.blockReason ?? null,
          params.blockGaps ?? null,
          params.blockNeeds ?? null,
          params.blockAudience ?? null,
          params.blockedOnHuman ?? null,
          params.ask ?? null,
          params.actor ?? null,
        ],
      );
    });
  } catch {
    // Pre-migration DB or table-lock transient — best-effort audit, never throw
  }
}

/**
 * Fetch the most recent block event for a task. Returns null when the table
 * has not been created, the task was never blocked, or the row has been
 * cascade-deleted.
 */
export function getLatestBlockEvent(taskId: string): TaskBlockEvent | null {
  try {
    return (
      queryOne<TaskBlockEvent>(
        `SELECT * FROM task_block_events
         WHERE task_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [taskId],
      ) ?? null
    );
  } catch {
    return null; // table absent (pre-migration) — fail soft
  }
}
