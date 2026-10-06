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
 *   1. ONE attempt per task per RETRY WINDOW: each processed task gets a queryable
 *      `persona_backfill_attempt` audit event, and the selection query EXCLUDES any
 *      task whose newest one is younger than PERSONA_BACKFILL_RETRY_HOURS (default
 *      6). It used to be once-ever, but an attempt that FAILED (selector throw,
 *      e.g. `persona_company_context_missing` before the company map was wired)
 *      then left the card persona-less for the life of the box — the triad gate
 *      parks it and nothing ever re-tries. A mechanical task that correctly stays
 *      NULL now costs one cheap attempt per window, not a loop (same posture as
 *      the PHASE-2 blend backfill below).
 *   2. Grace window: only tasks older than PERSONA_BACKFILL_GRACE_SECONDS (default
 *      120s) are eligible, so a just-created task whose create-time selection is
 *      still in flight is not double-fired.
 *   3. Batch cap: at most PERSONA_BACKFILL_BATCH (default 10) tasks per tick,
 *      oldest-first, processed sequentially (concurrency 1) so a slow selector
 *      cannot fan out python spawns.
 *   4. Terminal statuses (done / archived / review / blocked) are excluded — a
 *      persona for already-finished or blocked work buys nothing. EXCEPT a card
 *      blocked with block_reason='triad_incomplete': the triad gate parked it
 *      precisely BECAUSE it has no persona, and this sweep is the only thing that
 *      supplies one. Excluding it was a deadlock (gate waits for a persona, sweep
 *      skips blocked cards). A pin on such a card releases it to backlog with its
 *      dispatch budget reset — those attempts were triad holds, not dispatches.
 *
 * Trivially disabled: set PERSONA_BACKFILL_SWEEP_ENABLED=0, or remove the one JOBS
 * entry in scheduler.ts.
 */

import { queryAll, queryOne, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { resolvePersonaAndPin, shouldUsePersonaBlend } from '@/lib/tasks';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { transition } from '@/lib/task-lifecycle';

export interface PersonaBackfillResult {
  scanned: number;
  /** Tasks that acquired a persona this tick (matched OR fallback). */
  pinned: number;
  /** Tasks correctly left personaless (no_persona_required / mechanical). */
  leftPersonaless: number;
  /**
   * P4-02 step 3 — content tasks that already had a persona but NO voice blend
   * (`blend_directive IS NULL`, pre-D1-fix rows: the Podcast Engine / Anthology
   * tasks) that got the blend re-run this tick and acquired a directive.
   */
  blendBackfilled: number;
  /** Blend-eligible content tasks scanned this tick (the second-phase pool). */
  blendScanned: number;
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

/** Default retry window for a FAILED blend backfill attempt (hours). */
export const PERSONA_BACKFILL_RETRY_HOURS_DEFAULT = 6;

/**
 * How long a `blend_backfilled` marker suppresses a re-attempt.
 * Env: PERSONA_BACKFILL_RETRY_HOURS (non-numeric / negative → the default;
 * a huge value restores the old never-retry behavior).
 */
function blendRetryHours(): number {
  const raw = parseInt(process.env.PERSONA_BACKFILL_RETRY_HOURS ?? '', 10);
  return Number.isNaN(raw) || raw < 0 ? PERSONA_BACKFILL_RETRY_HOURS_DEFAULT : raw;
}

export async function runPersonaBackfillSweep(): Promise<PersonaBackfillResult> {
  if (
    process.env.PERSONA_BACKFILL_SWEEP_ENABLED === '0' ||
    process.env.PERSONA_BACKFILL_SWEEP_ENABLED === 'false'
  ) {
    return {
      scanned: 0, pinned: 0, leftPersonaless: 0, blendBackfilled: 0, blendScanned: 0,
      skippedReason: 'PERSONA_BACKFILL_SWEEP_ENABLED=0',
    };
  }

  const batch = Math.max(1, parseInt(process.env.PERSONA_BACKFILL_BATCH || '10', 10) || 10);
  const graceSeconds = Math.max(
    0,
    parseInt(process.env.PERSONA_BACKFILL_GRACE_SECONDS || '120', 10) || 120,
  );
  const graceCutoff = new Date(Date.now() - graceSeconds * 1000).toISOString();

  const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
  const retryCutoff = new Date(Date.now() - blendRetryHours() * 3_600_000).toISOString();

  // Persona-less, non-terminal (or triad-parked for the missing persona), aged
  // past the grace window, and NOT attempted within the retry window. Oldest first.
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
          AND (t.status NOT IN (${placeholders})
               OR (t.status = 'blocked' AND t.block_reason = 'triad_incomplete'))
          AND t.archived_at IS NULL
          AND t.created_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM events e
             WHERE e.task_id = t.id AND e.type = 'persona_backfill_attempt'
               AND e.created_at > ?
          )
        ORDER BY t.created_at ASC
        LIMIT ?`,
      [...TERMINAL_STATUSES, graceCutoff, retryCutoff, batch],
    );
  } catch (err) {
    // Pre-migration DB (no persona_id / archived_at column) — nothing to heal.
    return {
      scanned: 0,
      pinned: 0,
      leftPersonaless: 0,
      blendBackfilled: 0,
      blendScanned: 0,
      skippedReason: `query-failed: ${(err as Error).message}`,
    };
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
        if (row.status === 'blocked') await releaseTriadParkedCard(row.id);
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

  // ── PHASE 2 (P4-02 step 3): heal blend-less CONTENT tasks ──────────────────
  // The naked-persona phase above only heals `persona_id IS NULL`. A content
  // task created BEFORE the D1 fix (--blend never passed) has a real persona
  // pinned but NO voice blend — `blend_directive IS NULL`, no task_persona_bundle
  // row (the Podcast Engine / Anthology tasks). Left alone they stay blend-less
  // forever. Re-run the voice-first blend for them exactly once.
  const blend = await runPersonaBlendBackfill(batch, graceCutoff);

  return {
    scanned: rows.length,
    pinned,
    leftPersonaless,
    blendBackfilled: blend.blendBackfilled,
    blendScanned: blend.blendScanned,
  };
}

/**
 * A triad-parked card just acquired its missing persona: put it back in the
 * advance lane. dispatch_attempts is reset because every attempt it burned was a
 * triad hold (the card was never dispatchable), not a dispatch failure — left at
 * the cap, the advancer re-blocks it instantly ("dispatch-attempt cap reached").
 * CAS on expectedFrom:'blocked' so a concurrent Resume/heal wins cleanly.
 */
async function releaseTriadParkedCard(taskId: string): Promise<void> {
  try {
    await transition(taskId, 'backlog', {
      actor: 'persona-backfill',
      reason: '[PERSONA-BACKFILL] missing persona supplied — triad complete, re-entering dispatch queue',
      expectedFrom: 'blocked',
      extraColumns: {
        dispatch_attempts: 0,
        next_dispatch_eligible_at: null,
        block_reason: null,
        block_needs: null,
        block_audience: null,
      },
    });
  } catch (err) {
    console.warn(`[persona-backfill] release failed for task ${taskId}:`, (err as Error).message);
  }
}

interface BlendCandidateRow {
  id: string;
  title: string;
  description: string | null;
  department: string | null;
  workspace_id: string | null;
  status: string;
}

/**
 * P4-02 step 3 — re-run the audience/topic voice blend for content tasks that
 * already carry a persona but never got a blend directive (pre-D1-fix rows).
 *
 * GUARDS (mirroring the naked-phase anti-loop discipline):
 *   1. Never overwrite a non-null bundle: a task that ALREADY has a
 *      `task_persona_bundle` row is excluded at the SQL layer — the blend it
 *      already computed (possibly operator-confirmed) is never clobbered.
 *   2. ONE attempt per RETRY WINDOW: each processed task gets a queryable
 *      `blend_backfilled` audit event, and the selection query EXCLUDES any task
 *      whose newest one is younger than PERSONA_BACKFILL_RETRY_HOURS (default 6).
 *      An attempt that FAILED (selector timeout — the live stall: the content task
 *      never got a `task_persona_bundle` row, so checkPersonaDispatchReady returned
 *      `persona_bundle_required` on every dispatch tick FOREVER) is therefore
 *      retried on the next window instead of being excluded for the life of the
 *      box; a task whose selector legitimately returns no bundle (non-content edge,
 *      stale install) costs one cheap attempt per window, not a loop.
 *   3. Content-only: `isContentTask()` is an LLM-free semantic classifier (never
 *      a grep-as-content-judge — 2.4); a non-content task is skipped (its
 *      `blend_directive` staying NULL is correct, not a defect).
 *   4. Grace window + batch cap + terminal-status exclusion: identical to the
 *      naked phase.
 */
export async function runPersonaBlendBackfill(
  batch: number,
  graceCutoff: string,
): Promise<{ blendScanned: number; blendBackfilled: number }> {
  const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
  const retryCutoff = new Date(Date.now() - blendRetryHours() * 3_600_000).toISOString();

  let rows: BlendCandidateRow[];
  try {
    rows = queryAll<BlendCandidateRow>(
      `SELECT t.id AS id,
              t.title AS title,
              t.description AS description,
              t.department AS department,
              t.workspace_id AS workspace_id,
              t.status AS status
         FROM tasks t
        WHERE t.persona_id IS NOT NULL AND t.persona_id != ''
          AND (t.blend_directive IS NULL OR t.blend_directive = '')
          AND t.status NOT IN (${placeholders})
          AND t.archived_at IS NULL
          AND t.created_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM task_persona_bundle b WHERE b.task_id = t.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM events e
             WHERE e.task_id = t.id AND e.type = 'blend_backfilled'
               AND e.created_at > ?
          )
        ORDER BY t.created_at ASC
        LIMIT ?`,
      [...TERMINAL_STATUSES, graceCutoff, retryCutoff, batch],
    );
  } catch (err) {
    // Pre-090 DB (no blend_directive / task_persona_bundle) — nothing to heal.
    console.warn('[persona-backfill] blend-phase query skipped:', (err as Error).message);
    return { blendScanned: 0, blendBackfilled: 0 };
  }

  // Semantic content filter in TS (never grep-as-content-judge — meta-rule 2.4).
  const contentRows = rows.filter((r) =>
    shouldUsePersonaBlend(`${r.title}${r.description ? ` ${r.description}` : ''}`, r.department || r.workspace_id),
  );

  let blendBackfilled = 0;

  for (const row of contentRows) {
    // Stamp the once-per-task attempt marker BEFORE re-running so even a throw
    // cannot cause a re-loop (identical guard posture to the naked phase).
    try {
      run(
        `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'blend_backfilled',
          row.id,
          `[BLEND-BACKFILL] re-running the voice blend for content task "${row.title}" ` +
            `(had a persona but no blend_directive — pre-D1-fix row).`,
          new Date().toISOString(),
        ],
      );
    } catch {
      /* audit-only — proceed with the heal regardless */
    }

    const dept = canonicalDeptSlug(row.department || row.workspace_id || '') || 'general';
    const description = `${row.title}${row.description ? `. ${row.description}` : ''}`.trim();

    try {
      await resolvePersonaAndPin(row.id, description, dept, undefined, { blend: true });
      // Confirm the heal actually landed a directive before counting it — a
      // re-run that STILL produced no bundle already emitted `persona_blend_missing`
      // inside resolvePersonaAndPin, and must not be counted as a successful heal.
      const healed = queryOne<{ blend_directive: string | null }>(
        'SELECT blend_directive FROM tasks WHERE id = ?',
        [row.id],
      );
      if (healed?.blend_directive) blendBackfilled++;
    } catch (err) {
      console.warn(
        `[persona-backfill] blend heal failed for task ${row.id}:`,
        (err as Error).message,
      );
    }
  }

  return { blendScanned: contentRows.length, blendBackfilled };
}
