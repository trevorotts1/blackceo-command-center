/**
 * Owner-message-id oracle route (FIX-1 CC side).
 *
 * GET /api/tasks/[id]/messages/owner-ids
 *
 * The authoritative owner-approval source for the presentations engine's phase
 * skip (FIX-1). Returns the ids of the REAL owner-authored messages for a task,
 * read from task_activities where activity_type = 'owner_message' (the type the
 * messages POST route writes for sender === 'owner').
 *
 * Contract with the engine's cc_board.list_owner_message_ids():
 *   - 200 + JSON array of id strings on success (sorted, de-duplicated).
 *   - 404 only when the task does not exist.
 *   - An existing task with no owner messages returns 200 + [] — the engine
 *     must treat an empty set as "no authentic approvals exist", never as an
 *     oracle failure.
 *
 * A forged owner_msg_id (e.g. the live E2E's "e2e-test-002") is simply not in
 * the returned set — the engine's load_skip_approvals then raises
 * AF-FORGED-APPROVAL and the build FAILS. The route itself is read-only: it
 * never writes, never broadcasts, and never mutates task state.
 *
 * Auth: external callers are bearer-gated by the global middleware (MC_API_TOKEN)
 * exactly like every other /api read route; this route is NOT in the webhook
 * family, so it needs no x-webhook-signature HMAC. Same-origin board reads pass
 * the same-origin passthrough.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { listOwnerMessageIds } from '@/lib/owner-message-ids';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/tasks/[id]/messages/owner-ids — real owner-authored message ids
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const task = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [id]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const ids = listOwnerMessageIds(id);
    return NextResponse.json(ids);
  } catch (error) {
    console.error('[owner-ids:GET]', error);
    return NextResponse.json({ error: 'Failed to fetch owner message ids' }, { status: 500 });
  }
}
