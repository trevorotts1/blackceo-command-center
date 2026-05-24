import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { approveProposal, rejectProposal, type SOPProposalRow } from '@/lib/sop-learning';

/**
 * GET /api/sops/proposals/[id]
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const proposal = queryOne<SOPProposalRow>('SELECT * FROM sop_proposals WHERE id = ?', [id]);
    if (!proposal) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(proposal);
  } catch (error) {
    console.error('[GET /api/sops/proposals/:id] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch proposal' }, { status: 500 });
  }
}

/**
 * PATCH /api/sops/proposals/[id]
 *
 * Body: { action: 'approve' | 'reject', reviewer?: string, reason?: string }
 *
 * Approving creates a real `sops` row (version=1) and links it via
 * `approved_sop_id`. Rejecting just stamps the proposal and appends an
 * optional reason to evidence_summary.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();

    const reviewer = typeof body.reviewer === 'string' ? body.reviewer : null;

    if (body.action === 'approve') {
      const result = approveProposal(id, reviewer);
      return NextResponse.json(result);
    }
    if (body.action === 'reject') {
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const updated = rejectProposal(id, reviewer, reason);
      return NextResponse.json(updated);
    }
    return NextResponse.json({ error: 'action must be approve or reject' }, { status: 400 });
  } catch (error) {
    const msg = (error as Error).message;
    console.error('[PATCH /api/sops/proposals/:id] Failed:', msg);
    const status = msg.includes('not found') ? 404 : msg.includes('already') ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
