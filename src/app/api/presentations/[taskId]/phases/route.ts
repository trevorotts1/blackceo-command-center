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
  requiredPhaseIdsForLabel,
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
        `SELECT t.id, t.status, t.description FROM tasks t
          WHERE t.id = ? AND ${own.sql}`,
      )
      .get(taskId, ...own.params) as { id: string; status: string; description: string | null } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // PRES-020 — canonical execution record: the parent card's `Ref:` run
    // identity (FIX 57) is the authoritative run id. It scopes both the
    // activity reduction (stale run/attempt rows ignored) and the wall-clock
    // attribution (canonical run wins over arrival order).
    const canonicalRunId = (() => {
      const desc = task.description;
      if (typeof desc !== 'string') return null;
      const m = desc.match(/^Ref:\s*(\S.*?)\s*$/m);
      return m ? m[1] : null;
    })();

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

    // PRES-020 — per-id completion receipts: a completion-typed activity
    // proves its phase id ONLY when the matching producer QC scorecard row
    // carries the scorecard contract with an explicit pass. Presence of a
    // deliverable or a bare completion event without QC never completes the
    // id — that is the "deliverable presence without QC" acceptance check.
    // Fail-closed: a QC row the CC cannot parse counts as absent, never as
    // proof. Scoped to the canonical run so a retry's fresh attempt does not
    // inherit the superseded attempt's receipts.
    const completionReceipts: Record<string, boolean> = {};
    try {
      const qcRows = db
        .prepare(
          `SELECT metadata FROM task_activities
            WHERE task_id = ? AND activity_type = 'completed' AND metadata IS NOT NULL`,
        )
        .all(taskId) as Array<{ metadata: string | null }>;
      for (const row of qcRows) {
        if (typeof row.metadata !== 'string') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.metadata);
        } catch {
          continue;
        }
        if (typeof parsed !== 'object' || parsed === null) continue;
        const rec = parsed as Record<string, unknown>;
        const gate = typeof rec.qc_gate === 'string' ? rec.qc_gate : null;
        if (gate == null || !(gate in PHASE_TO_LABEL)) continue;
        if (rec.qc_passed === true) completionReceipts[gate] = true;
      }
    } catch {
      // Best-effort: receipts stay empty and every completion-typed activity
      // counts (legacy behavior) rather than failing the phases read.
    }

    const progress = computePhaseProgress(activities, deliverables, {
      completionReceipts,
      activeScope: canonicalRunId ? { run_id: canonicalRunId } : null,
    });

    // ── FIX 53 (R5A §E, §H6) — per-label elapsed from stage timings ──────
    // The stage-timings ingest (W16b) lands the engine's phase_exit rows in
    // presentation_stage_timings. W18b's migration 131 adds task_id so rows
    // link to the task; until every box has it, the column is probed
    // CO-OPERATIVELY (delete-guard.ts hasArchivedAtColumn pattern) and the
    // lookup falls back to run_id = the task id — the engine names the run
    // after the parent task, so child-card steppers resolve the same way.
    // On an un-migrated box the query still runs without task_id; elapsed_s
    // just stays null instead of crashing the whole endpoint (DATA-01).
    // PRES-037 (W3 WF12-B) — current-registered-execution timing. The
    // task's registered run is requester_session_key (set by the parent
    // ingest when the producer supplies one); only that run's phase_exit
    // rows feed the stepper, so out-of-order replays from an OLD run never
    // move the current bars. Task-linked rows without a session key resolve
    // via task_id (FIX 53 linkage). run_summary rows never feed per-label
    // elapsed (same rule as before). Every SELECT is cooperative: a missing
    // table/column (pre-migration box) degrades to null elapsed, never 500.
    let elapsed: Partial<Record<typeof PHASE_LABELS[number], number>> = {};
    let timingBreakdown: Record<string, { wall_s: number; provider_s: number; queue_s: number; qc_s: number }> = {};
    try {
      const timingCols = new Set(
        (
          db.prepare(`PRAGMA table_info(presentation_stage_timings)`).all() as { name: string }[]
        ).map((c) => c.name),
      );
      if (timingCols.size > 0) {
        const hasTaskIdCol = timingCols.has('task_id');
        const hasSplit = timingCols.has('provider_s') && timingCols.has('queue_s') && timingCols.has('qc_s');
        const selectSplit = hasSplit ? ', provider_s, queue_s, qc_s' : '';
        type TimingRow = {
          run_id: string;
          phase_id: string | null;
          duration_s: number | null;
          provider_s?: number | null;
          queue_s?: number | null;
          qc_s?: number | null;
        };
        let rows: TimingRow[] = [];
        const registered = db
          .prepare('SELECT requester_session_key FROM tasks WHERE id = ?')
          .get(taskId) as { requester_session_key: string | null } | undefined;
        const registeredRun = registered?.requester_session_key ?? null;
        if (registeredRun) {
          rows = db
            .prepare(
              `SELECT run_id, phase_id, duration_s${selectSplit}
                 FROM presentation_stage_timings
                WHERE run_id = ? AND event = 'phase_exit'
                ORDER BY id ASC`,
            )
            .all(registeredRun) as TimingRow[];
        } else if (hasTaskIdCol) {
          rows = db
            .prepare(
              `SELECT run_id, phase_id, duration_s${selectSplit}
                 FROM presentation_stage_timings
                WHERE task_id = ? AND event = 'phase_exit'
                ORDER BY id ASC`,
            )
            .all(taskId) as TimingRow[];
        } else {
          rows = db
            .prepare(
              `SELECT run_id, phase_id, duration_s${selectSplit}
                 FROM presentation_stage_timings
                WHERE run_id = ? AND event = 'phase_exit'
                ORDER BY id ASC`,
            )
            .all(taskId) as TimingRow[];
        }
        elapsed = phaseElapsedSeconds(rows, canonicalRunId);
        if (hasSplit) {
          const acc = new Map<string, { wall_s: number; provider_s: number; queue_s: number; qc_s: number }>();
          for (const r of rows) {
            if (typeof r.phase_id !== 'string' || !r.phase_id) continue;
            const label = PHASE_TO_LABEL[r.phase_id];
            if (!label) continue;
            const cur = acc.get(label) ?? { wall_s: 0, provider_s: 0, queue_s: 0, qc_s: 0 };
            if (typeof r.duration_s === 'number' && Number.isFinite(r.duration_s)) cur.wall_s += r.duration_s;
            if (typeof r.provider_s === 'number' && Number.isFinite(r.provider_s)) cur.provider_s += r.provider_s;
            if (typeof r.queue_s === 'number' && Number.isFinite(r.queue_s)) cur.queue_s += r.queue_s;
            if (typeof r.qc_s === 'number' && Number.isFinite(r.qc_s)) cur.qc_s += r.qc_s;
            acc.set(label, cur);
          }
          timingBreakdown = Object.fromEntries(acc);
        }
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

    // PRES-037 — timing_breakdown is ADDITIVE: wall_s per label plus the
    // provider/queue/QC split when the producer stamped it. Absent when the
    // box predates migration 141 or no row carries a split ({} — never null,
    // so the stepper can read breakdown[label] without a guard). elapsed_s
    // keeps its exact FIX 53 meaning (wall seconds, null when unknown).
    // PRES-020 — honest per-label progress. The old projection emitted a
    // fabricated 50/100 with null started_at and empty artifacts: one id done
    // out of five read as 100, a started label read as 50. Now:
    //   - percent = doneIds/totalIds scaled (0 when nothing applies yet),
    //   - units_completed/units_total expose the same fraction as integers so
    //     the client never re-derives it from the rounded percent,
    //   - started_at stays an honest null (task_activities carry no per-label
    //     start timestamps; the route must not invent one) — wall-clock lives
    //     in elapsed_s, and evidence links ride on `receipts`.
    return NextResponse.json({
      job_id: taskId,
      terminal,
      current_phase: (currentPhase ?? PHASE_LABELS[0]) as typeof PHASE_LABELS[number],
      phases: progress.phases.map((step) => {
        const total = step.totalIds;
        const done = Math.min(step.doneIds, total);
        const percent =
          step.status === 'done' ? 100 : total > 0 ? Math.round((done / total) * 100) : 0;
        const requiredIds = requiredPhaseIdsForLabel(step.label);
        return {
          id: step.label.toLowerCase(),
          label: step.label,
          status: step.status,
          started_at: null,
          // FIX 53 — real wall-clock seconds per label from the stage-timings
          // stream; null when that label has no timing row yet (stepper hides it).
          elapsed_s: (elapsed[step.label] ?? null) as number | null,
          artifacts: [] as string[],
          percent,
          units_completed: done,
          units_total: total,
          receipts: requiredIds
            .filter((id) => completionReceipts[id] === true)
            .map((id) => ({ phase_id: id, verified: true as const })),
        };
      }),
      unmapped: progress.unmapped,
      timing_breakdown: timingBreakdown,
    });
  } catch (error) {
    console.error('[U060] GET /api/presentations/[taskId]/phases error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
