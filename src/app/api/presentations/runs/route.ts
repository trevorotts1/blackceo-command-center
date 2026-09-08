import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { z } from 'zod';
import { boardWhereClause } from '@/lib/workspaces/board-query';
import { resolveActiveCompanyId } from '@/lib/company';
import {
  registerPresentationRun,
  getRunBindingHistory,
} from '@/lib/presentation-run-bindings';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/presentations/runs — PRES-010 run registration.
 *
 * The producer-side door for the run-binding registry: the presentation engine
 * (cc_board.py, at ingest/registration time) or an authorized operator stamps
 * the canonical ABSOLUTE run root for one (task, company, presentation, run)
 * tuple. GET /api/presentations/[taskId]/deliverables resolves the GHL ledger
 * ONLY through the newest binding — this endpoint existing is what lets the
 * first-directory fallback be deleted honestly.
 *
 * Auth: same posture as every other external /api write — the middleware's
 * MC_API_TOKEN bearer gate applies to external callers, and same-origin UI
 * callers ride the passthrough. Registration carries a run ROOT (a directory),
 * never a credential.
 *
 * Idempotent: re-registering the identical (task, root, company) tuple returns
 * the existing binding. A RELOCATION re-registers with the new root; the newest
 * row becomes the active binding and history is retained.
 *
 * Body:
 *   task_id           (required) the deck-run parent card id
 *   run_root          (required) canonical absolute run directory (~ expanded)
 *   company_id        (optional) tenant binding
 *   presentation_id   (optional) the presentation id
 *   run_id            (optional) the engine's run id (pj_...)
 *   registered_by     (optional) producer identity for the audit trail
 */
const RegisterRunSchema = z.object({
  task_id: z.string().min(1),
  run_root: z.string().min(1),
  company_id: z.string().min(1).nullable().optional(),
  presentation_id: z.string().min(1).nullable().optional(),
  run_id: z.string().min(1).nullable().optional(),
  registered_by: z.string().min(1).nullable().optional(),
});

/**
 * The ONE task-scope check for both POST and GET, shared with the deliverables
 * and phases routes: ownership joins through workspaces.company_id (tasks carry
 * no direct company_id), applying the SAME boardWhereClause the Kanban board
 * uses. A NULL workspace_id is the box's own unattributed data and stays
 * visible (boardWhereClause's posture); an out-of-scope workspace is treated as
 * not found — an out-of-scope task id can neither be registered against nor
 * have its binding history read (run_root paths would otherwise leak
 * cross-company to any bearer caller that knows a task id).
 */
function scopedTaskExists(taskId: string): { id: string } | undefined {
  const db = getDb();
  const activeCompanyId = resolveActiveCompanyId(db);
  const scope = boardWhereClause(activeCompanyId);
  const scopedWorkspaceIds = (
    db.prepare(`SELECT w.id FROM workspaces w ${scope.sql}`).all(...scope.params) as { id: string }[]
  ).map((w) => w.id);
  const scopeIdList = scopedWorkspaceIds.length > 0 ? scopedWorkspaceIds : ['__no_workspace__'];
  return db
    .prepare(
      `SELECT id FROM tasks
        WHERE id = ? AND (workspace_id IS NULL OR workspace_id IN (${scopeIdList.map(() => '?').join(',')}))`,
    )
    .get(taskId, ...scopeIdList) as { id: string } | undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const rawBody = await request.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsedBody = RegisterRunSchema.safeParse(parsed);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: 'Invalid registration body', detail: parsedBody.error.issues.slice(0, 5) },
        { status: 400 },
      );
    }
    const body = parsedBody.data;
    const db = getDb();

    // Scope: the task must exist AND be readable in the caller's company scope
    // (scopedTaskExists above — the same boardWhereClause convention as the
    // deliverables route).
    const taskExists = scopedTaskExists(body.task_id);
    if (!taskExists) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const result = registerPresentationRun({
      taskId: body.task_id,
      runRoot: body.run_root,
      companyId: body.company_id ?? null,
      presentationId: body.presentation_id ?? null,
      runId: body.run_id ?? null,
      registeredBy: body.registered_by ?? null,
    });
    if (!result.ok) {
      const status = result.code === 'registry_unavailable' ? 500 : 422;
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status },
      );
    }
    return NextResponse.json(
      { ok: true, binding: result.binding, idempotent: result.idempotent ?? false },
      { status: result.idempotent ? 200 : 201 },
    );
  } catch (error) {
    console.error('Error registering presentation run:', error);
    return NextResponse.json({ error: 'Failed to register presentation run' }, { status: 500 });
  }
}

/**
 * GET /api/presentations/runs?task_id=<id> — binding history for one task
 * (audit surface: every registration ever made, oldest first).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const taskId = new URL(request.url).searchParams.get('task_id');
    if (!taskId) {
      return NextResponse.json({ error: 'task_id query parameter is required' }, { status: 400 });
    }
    const exists = scopedTaskExists(taskId);
    if (!exists) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    return NextResponse.json({ bindings: getRunBindingHistory(taskId) });
  } catch (error) {
    console.error('Error reading presentation run bindings:', error);
    return NextResponse.json({ error: 'Failed to read run bindings' }, { status: 500 });
  }
}