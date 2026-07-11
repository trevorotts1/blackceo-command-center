/**
 * POST   /api/workspaces/[id]/archive — soft-archive a department (stamp archived_at).
 * DELETE /api/workspaces/[id]/archive — un-archive it.
 *
 * C6 / AUD-16 + B8 / AUD-46.
 *
 * The converge step (syncDeclinedWorkspaceArchive) archives declined departments
 * automatically from the honored declined set. This route is the MANUAL half: the
 * operator's own archive, and the first step of the two-step a hard DELETE now
 * requires.
 *
 * `archived_reason` matters. A converge un-archives only rows it archived itself
 * (reason='declined'), so an operator archive made here — reason='operator' —
 * SURVIVES a resync and is never silently undone. Conversely, archiving a
 * department here does NOT fabricate a decline: it never writes to build-state,
 * so the owner's canonical answers stay the single source of decision truth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { archiveWorkspace, unarchiveWorkspace } from '@/lib/workspaces/archive';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const OPERATOR_REASON = 'operator';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = getDb();

    const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id);
    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const changed = archiveWorkspace(db, id, OPERATOR_REASON);
    const row = db
      .prepare('SELECT archived_at, archived_reason FROM workspaces WHERE id = ?')
      .get(id) as { archived_at: string | null; archived_reason: string | null };

    return NextResponse.json({
      ok: true,
      id,
      archived_at: row.archived_at,
      archived_reason: row.archived_reason,
      already_archived: !changed,
      note:
        'Department soft-archived — hidden from the board, row and history PRESERVED. ' +
        'Retrieve with ?includeArchived=true. It is now also eligible for a hard ' +
        'DELETE /api/workspaces/' + id + ' (irreversible).',
    });
  } catch (error) {
    console.error('Failed to archive workspace:', error);
    return NextResponse.json({ error: 'Failed to archive workspace' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = getDb();

    const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id);
    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const changed = unarchiveWorkspace(db, id);

    return NextResponse.json({
      ok: true,
      id,
      archived_at: null,
      was_archived: changed,
      note:
        'Department restored to the board. NOTE: if the owner still has a provenanced ' +
        'NO on record for this department, the next converge will re-archive it — the ' +
        'owner\'s answer is authoritative, not this route.',
    });
  } catch (error) {
    console.error('Failed to un-archive workspace:', error);
    return NextResponse.json({ error: 'Failed to un-archive workspace' }, { status: 500 });
  }
}
