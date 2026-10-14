/**
 * POST /api/presentations/[taskId]/resume — Item 19 (FIX-PLAN).
 *
 * The board's resume action for a PARKED presentation engine run. It calls
 * the same resume path the engine honors (the launcher dispatch the on-box
 * poller uses for parked runs: presentation_job.launcher --resume, via
 * src/lib/presentation-engine-resume.ts) and reports the engine's
 * RESULTING state, read back from the run's state.json. It never writes
 * engine state and never moves the board task: a board-side status flip
 * would fabricate a state change for a card the board does not dispatch.
 *
 * Responses:
 *   200 { resumed: true,  detail, engine }  — the engine consumed the
 *          resume; `engine` is the fresh state read (park cleared, or a
 *          new park the engine recorded after consuming it).
 *   202 { resumed: false, dispatched: true, detail, engine } — the
 *          launcher spawned the engine but the state has not caught up
 *          yet; the card keeps reading the engine state, unchanged here.
 *   409 { resumed: false, code, error, engine } — a refusal, in plain
 *          words: unbound run, unavailable binding, no engine state,
 *          terminal run, not parked, launcher missing, or the launcher's
 *          own refusal output.
 *   404 — the task does not exist in the active company's scope (the same
 *          PRES-009 predicate the sibling presentation reads use).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveActiveCompanyId } from '@/lib/company';
import { tenantTaskWhere } from '@/lib/presentation-tenant-scope';
import { resumeParkedEngineRun } from '@/lib/presentation-engine-resume';
import type { TaskEngineView } from '@/lib/presentation-engine-state';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function engineJson(view: TaskEngineView | null) {
  if (!view) return null;
  return {
    terminal: view.terminal,
    park_status: view.park,
    elections: view.elections,
    run_bound: view.runDir != null,
  };
}

export async function POST(_request: NextRequest, props: { params: Promise<{ taskId: string }> }) {
  const params = await props.params;
  try {
    const { taskId } = params;
    const db = getDb();

    // Company scope (PRES-009) — identical predicate to the sibling
    // presentation routes: an out-of-scope task is a 404, never a leak.
    const activeCompanyId = resolveActiveCompanyId(db);
    const own = tenantTaskWhere(activeCompanyId);
    const task = db
      .prepare(`SELECT t.id FROM tasks t WHERE t.id = ? AND ${own.sql}`)
      .get(taskId, ...own.params) as { id: string } | undefined;
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const outcome = await resumeParkedEngineRun(taskId);
    if (outcome.kind === 'resumed') {
      return NextResponse.json({
        resumed: true,
        detail: outcome.detail,
        engine: engineJson(outcome.view),
      });
    }
    if (outcome.kind === 'dispatched_pending') {
      return NextResponse.json(
        {
          resumed: false,
          dispatched: true,
          detail: outcome.detail,
          engine: engineJson(outcome.view),
        },
        { status: 202 },
      );
    }
    return NextResponse.json(
      {
        resumed: false,
        code: outcome.code,
        error: outcome.refusal,
        engine: engineJson(outcome.view),
      },
      { status: 409 },
    );
  } catch (error) {
    console.error('[Item 19] POST /api/presentations/[taskId]/resume error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
