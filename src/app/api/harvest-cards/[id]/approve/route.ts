import { NextRequest, NextResponse } from 'next/server';
import {
  approveHarvestCard,
  findHarvestCard,
  resolveHarvestClientId,
  resolveWorkspaceBase,
} from '@/lib/winner-harvest';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/harvest-cards/[id]/approve
 *
 * The CC-repo half of A-U11 (winner-harvest flywheel) — the live operator-
 * approval action ONB's own `shared-utils/winner_harvest.py` module
 * docstring names as OWED. Flips ONE card in THIS box's own client-scoped
 * `harvest-cards.json` ledger to `approved`.
 *
 * `client_id` is NEVER accepted from the request body or params — it is
 * always derived from this box's own identity (`resolveHarvestClientId()`).
 * That is the cross-client guarantee: this route cannot even LOOK at another
 * client's ledger file, let alone approve a card in it, so it does not rely
 * on ONB's own `card_candidate_mismatch` backstop (that guard lives inside
 * `harvest_into_library`, which this route never calls).
 *
 * Body: `{ approvedBy: string }` — required, non-empty operator identity.
 * Never auto-approves: every call requires this explicit field.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: cardId } = await params;
    if (!cardId) {
      return NextResponse.json({ error: 'card id required' }, { status: 400 });
    }

    let body: { approvedBy?: unknown } = {};
    try {
      body = await request.json();
    } catch {
      /* empty/invalid JSON body — falls through to the approvedBy check below */
    }
    const approvedBy = typeof body.approvedBy === 'string' ? body.approvedBy.trim() : '';
    if (!approvedBy) {
      return NextResponse.json({ error: 'approvedBy is required' }, { status: 400 });
    }

    const workspaceBase = resolveWorkspaceBase();
    const clientId = resolveHarvestClientId();
    if (!workspaceBase || !clientId) {
      return NextResponse.json(
        {
          error:
            'winner-harvest workspace not resolvable on this box (unbranded box, or no HOME/CLIENT_WORKSPACE_BASE_DIR)',
        },
        { status: 409 },
      );
    }

    const existing = findHarvestCard(workspaceBase, clientId, cardId);
    if (!existing) {
      return NextResponse.json({ error: 'harvest card not found' }, { status: 404 });
    }

    const card = approveHarvestCard(workspaceBase, clientId, cardId, approvedBy);
    return NextResponse.json({ success: true, card });
  } catch (error) {
    console.error('Failed to approve harvest card:', error);
    return NextResponse.json({ error: 'Failed to approve harvest card' }, { status: 500 });
  }
}
