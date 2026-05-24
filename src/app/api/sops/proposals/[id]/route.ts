import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { approveProposal, rejectProposal, type SOPProposalRow } from '@/lib/sop-learning';
import { approveAutoResearchProposal, loadProposalWithV1 } from '@/lib/sop-auto-replace';

/**
 * GET /api/sops/proposals/[id]
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const includeDiff = new URL(req.url).searchParams.get('include_diff') === 'true';

    if (includeDiff) {
      // Track S side-by-side diff: proposal + the deleted v1 it replaces.
      const bundle = loadProposalWithV1(id);
      if (!bundle) return NextResponse.json({ error: 'not found' }, { status: 404 });
      return NextResponse.json(bundle);
    }

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
      // Route auto-research proposals through the atomic-swap helper that
      // also re-points impacted tasks. Track N proposals (pattern detection)
      // go through the regular approval path.
      const existing = queryOne<SOPProposalRow & { status: string }>('SELECT * FROM sop_proposals WHERE id = ?', [id]);
      if ((existing?.status as string) === 'auto-generated-pending-review') {
        const result = approveAutoResearchProposal({
          proposalId: id,
          reviewer,
          edits: body.edits || undefined,
        });
        return NextResponse.json(result);
      }
      const result = approveProposal(id, reviewer);
      return NextResponse.json(result);
    }
    if (body.action === 'reject') {
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      // For auto-research proposals we need to flip status to 'rejected' but
      // sop-learning's rejectProposal asserts status='pending'. Handle them
      // here so the rejection still counts toward the 7-day cap.
      const existing = queryOne<SOPProposalRow & { status: string }>('SELECT * FROM sop_proposals WHERE id = ?', [id]);
      if (existing && (existing.status as string) === 'auto-generated-pending-review') {
        const now = new Date().toISOString();
        const note = reason
          ? `${existing.evidence_summary || ''}\n\n[REJECTED] ${reason}`
          : existing.evidence_summary;
        run(
          `UPDATE sop_proposals
             SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, evidence_summary = ?
           WHERE id = ?`,
          [now, reviewer, note, id]
        );
        const updated = queryOne<SOPProposalRow>('SELECT * FROM sop_proposals WHERE id = ?', [id]);
        return NextResponse.json(updated);
      }
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
