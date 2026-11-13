/**
 * Owner-message text read route (PD-305b).
 *
 * GET /api/tasks/[id]/messages/owner-messages
 *
 * The owner's messages on one task, WITH their text, oldest first:
 *   200 + JSON array of `{ id, text, created_at }` on success.
 *   404 only when the task does not exist (in this box's company scope).
 *   An existing task with no owner messages returns 200 + [].
 *
 * Why a second route beside `messages/owner-ids`: that route's contract with
 * the engine is a plain array of id STRINGS
 * (`cc_board.list_owner_message_ids`; a non-array response is UNDETERMINED and
 * fails closed — pinned by tests/unit/fix1-owner-ids-oracle.test.ts). It cannot
 * carry text, so this unit adds one read-only route instead of changing it.
 *
 * The owner test is NOT restated here. `listOwnerMessageIds`
 * (src/lib/owner-message-ids.ts) is the one definition of "owner"
 * (`activity_type = 'owner_message'`, the exclusive marker the messages POST
 * route writes for `sender !== 'agent'`), and this route resolves the text rows
 * for exactly the ids it returns.
 *
 * Auth: the same gate as the owner-ids route — external callers are
 * bearer-gated by the global middleware (MC_API_TOKEN) because this path is
 * matched by the middleware; same-origin board reads pass the same-origin
 * passthrough. There is deliberately no route-level credential check, so the
 * refusal for a caller without the credential is the middleware's existing
 * one. The task-existence check uses the same company-scope predicate as the
 * messages read (`tenantTaskWhere`), so a foreign task is 404 and this route is
 * not an existence oracle.
 *
 * Read-only: never writes, never broadcasts, never mutates task state.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne } from '@/lib/db';
import { listOwnerMessageIds } from '@/lib/owner-message-ids';
import { resolveActiveCompanyId } from '@/lib/company';
import { tenantTaskWhere } from '@/lib/presentation-tenant-scope';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** One `task_activities` row as stored; the column is `message`, the contract field is `text`. */
interface OwnerMessageRow {
  id: string;
  message: string;
  created_at: string;
}

// GET /api/tasks/[id]/messages/owner-messages — the owner's messages with text
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Same ownership predicate the messages GET uses: a foreign or unknown task
    // is 404, indistinguishable from a wrong id.
    const own = tenantTaskWhere(resolveActiveCompanyId());
    const task = queryOne<{ id: string }>(
      `SELECT t.id FROM tasks t WHERE t.id = ? AND ${own.sql}`,
      [id, ...own.params],
    );
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // One owner definition, reused. Empty set short-circuits the IN () query.
    const ownerIds = listOwnerMessageIds(id);
    if (ownerIds.length === 0) {
      return NextResponse.json([]);
    }

    const placeholders = ownerIds.map(() => '?').join(', ');
    const rows = queryAll<OwnerMessageRow>(
      `SELECT id, message, created_at
         FROM task_activities
        WHERE task_id = ? AND id IN (${placeholders})
        ORDER BY created_at ASC, id ASC`,
      [id, ...ownerIds],
    );

    return NextResponse.json(
      rows.map((row) => ({ id: row.id, text: row.message, created_at: row.created_at })),
    );
  } catch (error) {
    console.error('[owner-messages:GET]', error);
    return NextResponse.json({ error: 'Failed to fetch owner messages' }, { status: 500 });
  }
}
