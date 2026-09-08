/**
 * GET /api/presentations/[taskId]/phases
 * U060 — Live phase progress for a presentation task.
 *
 * Queries task_activities and task_deliverables for the given task, reduces
 * through computePhaseProgress, and returns all seven labels in PHASE_LABELS
 * order plus job-level metadata.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  computePhaseProgress,
  phaseElapsedSeconds,
  PHASE_LABELS,
  PHASE_TO_LABEL,
} from '@/lib/presentation-phases';
import { resolveActiveCompanyId } from '@/lib/company';
import { tenantTaskWhere } from '@/lib/presentation-tenant-scope';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_request: NextRequest, props: { params: Promise<{ taskId: string }> }) {
  const params = await props.params;
  try {
    const { taskId } = params;
    const db = getDb();

    // ── Company scope (PRES-009: ingest-grade ownership predicate) ────────
    // Ownership is proven by the SAME predicate the ingest front door uses
    // (src/lib/presentation-tenant-scope.ts): a durably attributed workspace
    // resolving to the active company, OR a durable task_request_keys creation
    // identity stamped for it. A NULL workspace alone is NOT proof — the old
    // `workspace_id IS NULL` arm showed an unattributed task to EVERY active
    // company. An out-of-scope or ambiguous task is 404, never distinguishing
    // "exists but not yours" from "doesn't exist".
    const activeCompanyId = resolveActiveCompanyId(db);
    const own = tenantTaskWhere(activeCompanyId);

    const task = db
      .prepare(
        `SELECT id, status FROM tasks t
          WHERE t.id = ? AND ${own.sql}`,
      )
      .get(taskId, ...own.params) as { id: string; status: string } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const activities = db
      .prepare(
        'SELECT activity_type, metadata FROM task_activities WHERE task_id = ?',
      )
      .all(taskId) as Array<{
      activity_type: string;
      metadata?: string | null;
    }>;

    // FIX 50b — SELECT path alongside deliverable_type: the teleprompter is
    // detected by the basename of the registered path
    // (presenter-teleprompter.html), not by its type — the registration
    // contract's deliverable_type enum has no 'teleprompter' value.
    const deliverables = db
      .prepare(
        'SELECT deliverable_type, path FROM task_deliverables WHERE task_id = ?',
      )
      .all(taskId) as Array<{ deliverable_type: string; path: string | null }>;

    const progress = computePhaseProgress(activities, deliverables);

    // ── FIX 53 (R5A §E, §H6) — per-label elapsed from stage timings ──────
    // The stage-timings ingest (W16b) lands the engine's phase_exit rows in
    // presentation_stage_timings. W18b's migration 131 adds task_id so rows
    // link to the task; until every box has it, the column is probed
    // CO-OPERATIVELY (delete-guard.ts hasArchivedAtColumn pattern) and the
    // lookup falls back to run_id = the task id — the engine names the run
    // after the parent task, so child-card steppers resolve the same way.
    // On an un-migrated box the query still runs without task_id; elapsed_s
    // just stays null instead of crashing the whole endpoint (DATA-01).
    let elapsed: Partial<Record<typeof PHASE_LABELS[number], number>> = {};
    try {
      const hasTaskIdCol = (
        db.prepare(
          `SELECT count(*) AS n FROM pragma_table_info('presentation_stage_timings') WHERE name = 'task_id'`,
        ).get() as { n: number }
      ).n > 0;
      if (hasTaskIdCol) {
        const rows = db
          .prepare(
            `SELECT run_id, phase_id, duration_s
               FROM presentation_stage_timings
              WHERE task_id = ? AND event = 'phase_exit'
              ORDER BY id ASC`,
          )
          .all(taskId) as Array<{
          run_id: string;
          phase_id: string | null;
          duration_s: number | null;
        }>;
        elapsed = phaseElapsedSeconds(rows);
      } else {
        const rows = db
          .prepare(
            `SELECT run_id, phase_id, duration_s
               FROM presentation_stage_timings
              WHERE run_id = ? AND event = 'phase_exit'
              ORDER BY id ASC`,
          )
          .all(taskId) as Array<{
          run_id: string;
          phase_id: string | null;
          duration_s: number | null;
        }>;
        elapsed = phaseElapsedSeconds(rows);
      }
    } catch (timingErr) {
      // Missing table (fresh box predating migration 127) or a transient
      // SQLite hiccup: elapsed is best-effort — never fail the phases read.
      console.warn(
        '[U060] stage-timings elapsed lookup skipped:',
        timingErr instanceof Error ? timingErr.message : timingErr,
      );
      elapsed = {};
    }

    // Determine current_phase: the last label that has been seen or the
    // Teleprompter if its deliverable exists, falling back to the first label
    // whose phase mapped. If nothing is active, current_phase is null.
    let currentPhase: typeof PHASE_LABELS[number] | null = null;
    for (const step of progress.phases) {
      if (step.status !== 'not_started') {
        currentPhase = step.label;
      }
    }
    if (currentPhase == null && activities.length > 0) {
      // An unmapped phase id was in the activities but nothing mapped.
      // current_phase stays null — the client can use the first label as the
      // current position.
    }

    // job_id and terminal are extracted from the task row already fetched
    // (and company-scope-verified) above.
    const terminal = task.status === 'done' || task.status === 'blocked';

    // Per-step artifacts: count of deliverables per label (best-effort).

    return NextResponse.json({
      job_id: taskId,
      terminal,
      current_phase: (currentPhase ?? PHASE_LABELS[0]) as typeof PHASE_LABELS[number],
      phases: progress.phases.map((step) => ({
        id: step.label.toLowerCase(),
        label: step.label,
        status: step.status,
        started_at: step.status !== 'not_started' ? null : null,
        // FIX 53 — real wall-clock seconds per label from the stage-timings
        // stream; null when that label has no timing row yet (stepper hides it).
        elapsed_s: (elapsed[step.label] ?? null) as number | null,
        artifacts: [] as string[],
        percent: step.status === 'done' ? 100 : step.status === 'in_progress' ? 50 : 0,
      })),
      unmapped: progress.unmapped,
    });
  } catch (error) {
    console.error('[U060] GET /api/presentations/[taskId]/phases error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
