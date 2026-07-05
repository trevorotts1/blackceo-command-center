/**
 * Persona backfill sweep (F3.1 / Persona-Matching-Overhaul FDN-2 — heal net).
 *
 * PROBLEM (A3 / A4):
 *   Persona selection at create-time is fire-and-forget. If every bounded attempt
 *   fails (selector script missing, python3 absent, spawn timeout, JSON parse
 *   error) AND the deterministic create-time fallback itself was skipped for some
 *   reason — or the task pre-dates the no-naked-tasks invariant — the row can sit
 *   with `persona_id IS NULL`. resolvePersonaAndPin has retry + a fallback chain,
 *   but a task that never ran through it (or a legacy backlog card) has no other
 *   mechanism to acquire a persona. That is the "naked task" the F3.1 invariant
 *   forbids.
 *
 * FIX:
 *   Every few minutes, select non-terminal tasks that are still persona-less and
 *   have aged past a short grace window, then re-run resolvePersonaAndPin() for
 *   each. resolvePersonaAndPin either pins a real selected persona, pins the
 *   deterministic fallback (persona_fallback=1), or — for a genuine mechanical
 *   `no_persona_required` task — records the governance pointer and leaves it NULL
 *   by design. This retroactively heals A3/A4 and self-heals a box recovering from
 *   an empty persona universe (A1).
 *
 * ANTI-FURNACE / ANTI-LOOP guards (durable, no self-resurrect):
 *   1. ONE attempt per task, ever: each processed task gets a queryable
 *      `persona_backfill_attempt` audit event, and the selection query EXCLUDES any
 *      task that already has one. So a genuinely mechanical task (which correctly
 *      stays NULL) is attempted exactly once and then drops out — it never loops.
 *   2. Grace window: only tasks older than PERSONA_BACKFILL_GRACE_SECONDS (default
 *      120s) are eligible, so a just-created task whose create-time selection is
 *      still in flight is not double-fired.
 *   3. Batch cap: at most PERSONA_BACKFILL_BATCH (default 10) tasks per tick,
 *      oldest-first, processed sequentially (concurrency 1) so a slow selector
 *      cannot fan out python spawns.
 *   4. Terminal statuses (done / archived / review / blocked) are excluded — a
 *      persona for already-finished or blocked work buys nothing.
 *
 * Trivially disabled: set PERSONA_BACKFILL_SWEEP_ENABLED=0, or remove the one JOBS
 * entry in scheduler.ts.
 */

import { queryAll, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { resolvePersonaAndPin } from '@/lib/tasks';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';

export interface PersonaBackfillResult {
  scanned: number;
  /** Tasks that acquired a persona this tick (matched OR fallback). */
  pinned: number;
  /** Tasks correctly left personaless (no_persona_required / mechanical). */
  leftPersonaless: number;
  skippedReason?: string;
}

interface NakedTaskRow {
  id: string;
  title: string;
  description: string | null;
  department: string | null;
  workspace_id: string | null;
  status: string;
}

// Statuses for which a persona no longer matters (finished / parked work).
const TERMINAL_STATUSES = ['done', 'archived', 'review', 'blocked'];

export async function runPersonaBackfillSweep(): Promise<PersonaBackfillResult> {
  if (
    process.env.PERSONA_BACKFILL_SWEEP_ENABLED === '0' ||
    process.env.PERSONA_BACKFILL_SWEEP_ENABLED === 'false'
  ) {
    return { scanned: 0, pinned: 0, leftPersonaless: 0, skippedReason: 'PERSONA_BACKFILL_SWEEP_ENABLED=0' };
  }

  const batch = Math.max(1, parseInt(process.env.PERSONA_BACKFILL_BATCH || '10', 10) || 10);
  const graceSeconds = Math.max(
    0,
    parseInt(process.env.PERSONA_BACKFILL_GRACE_SECONDS || '120', 10) || 120,
  );
  const graceCutoff = new Date(Date.now() - graceSeconds * 1000).toISOString();

  const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');

  // Persona-less, non-terminal, aged past the grace window, and NOT already
  // attempted by a prior sweep tick (the once-per-task loop guard). Oldest first.
  let rows: NakedTaskRow[];
  try {
    rows = queryAll<NakedTaskRow>(
      `SELECT t.id AS id,
              t.title AS title,
              t.description AS description,
              t.department AS department,
              t.workspace_id AS workspace_id,
              t.status AS status
         FROM tasks t
        WHERE (t.persona_id IS NULL OR t.persona_id = '')
          AND t.status NOT IN (${placeholders})
          AND t.archived_at IS NULL
          AND t.created_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM events e
             WHERE e.task_id = t.id AND e.type = 'persona_backfill_attempt'
          )
        ORDER BY t.created_at ASC
        LIMIT ?`,
      [...TERMINAL_STATUSES, graceCutoff, batch],
    );
  } catch (err) {
    // Pre-migration DB (no persona_id / archived_at column) — nothing to heal.
    return {
      scanned: 0,
      pinned: 0,
      leftPersonaless: 0,
      skippedReason: `query-failed: ${(err as Error).message}`,
    };
  }

  if (rows.length === 0) {
    return { scanned: 0, pinned: 0, leftPersonaless: 0 };
  }

  let pinned = 0;
  let leftPersonaless = 0;

  for (const row of rows) {
    // Stamp the once-per-task attempt marker BEFORE selecting, so even a throw
    // (which resolvePersonaAndPin swallows, but be defensive) cannot cause a re-loop.
    try {
      run(
        `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'persona_backfill_attempt',
          row.id,
          `[PERSONA-BACKFILL] Healing naked task "${row.title}" (status=${row.status}).`,
          new Date().toISOString(),
        ],
      );
    } catch {
      /* audit-only — proceed with the heal regardless */
    }

    const dept =
      canonicalDeptSlug(row.department || row.workspace_id || '') || 'general';
    const description = `${row.title}${row.description ? `. ${row.description}` : ''}`.trim();

    try {
      const pinnedId = await resolvePersonaAndPin(row.id, description, dept);
      if (pinnedId) {
        pinned++;
      } else {
        // no_persona_required (mechanical) — correctly personaless, governance-pointed.
        leftPersonaless++;
      }
    } catch (err) {
      // resolvePersonaAndPin never throws to callers, but never let one task abort
      // the sweep. The attempt marker is already written, so it will not re-loop.
      console.warn(
        `[persona-backfill] heal failed for task ${row.id}:`,
        (err as Error).message,
      );
    }
  }

  return { scanned: rows.length, pinned, leftPersonaless };
}
