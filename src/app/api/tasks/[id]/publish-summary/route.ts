import { NextRequest, NextResponse } from 'next/server';
import { queryOne, queryAll } from '@/lib/db';
import { buildTaskSummary } from '@/lib/social/summary';
import {
  resolvePublishCompany,
  assertTaskOwnedByCompany,
} from '@/lib/social/company-context';
import type { SummaryPublishRow } from '@/lib/social/summary';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/tasks/[id]/publish-summary — F30 client summary endpoint.
 *
 * Derives the client completion/exception summary from PERSISTED state only:
 *   - the canonical task row (status, block fields, dispatch attempts),
 *   - its task_events transition history (last verified milestone),
 *   - the company-scoped publish_queue rows linked to this task (F01/F03
 *     contract: task_id or cc_task_id linkage).
 *
 * Company binding (F01 seam, read-only reuse): the caller's company is
 * resolved the same way every company-scoped route does; a foreign/absent
 * task answers 404 indistinguishably and NOTHING is derived or leaked.
 */
export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const identity = await resolvePublishCompany(req);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const companyId = identity.company.companyId;

  const params = await props.params;
  const taskId = params.id;
  const ownership = assertTaskOwnedByCompany(taskId, companyId);
  if (!ownership.owned) {
    return NextResponse.json({ error: 'task not found' }, { status: 404 });
  }

  const task = queryOne<{
    id: string;
    status: string;
    block_reason: string | null;
    block_needs: string | null;
    dispatch_attempts: number | null;
    next_dispatch_eligible_at: string | null;
    updated_at: string;
  }>(
    `SELECT id, status, block_reason, block_needs, dispatch_attempts, next_dispatch_eligible_at, updated_at
       FROM tasks WHERE id = ?`,
    [taskId],
  );
  if (!task) {
    return NextResponse.json({ error: 'task not found' }, { status: 404 });
  }

  const events = queryAll<{ to_status: string; created_at: string; reason: string | null }>(
    `SELECT to_status, created_at, reason FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 20`,
    [taskId],
  ).reverse();

  const publishRows = queryAll<SummaryPublishRow>(
    `SELECT * FROM publish_queue WHERE company_id = ? AND (task_id = ? OR cc_task_id = ?)
      ORDER BY created_at DESC LIMIT 10`,
    [companyId, taskId, taskId],
  );

  const summary = buildTaskSummary(task, publishRows, events);
  return NextResponse.json({ summary });
}