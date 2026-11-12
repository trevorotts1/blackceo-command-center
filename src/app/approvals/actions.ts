'use server';

/**
 * The only mutation the approvals page performs: the owner's decision. Identity
 * is resolved SERVER-SIDE from the request's session cookie / verified Access
 * JWT via resolveTenantContext — never from the form. Approve mints the launch
 * approval record through decideApprovalRequest (registered owner only; the
 * agent bearer is refused). Server actions carry Next's own origin check.
 */
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { decideApprovalRequest } from '@/lib/approval-requests';

export interface DecisionState { ok: boolean; error: string | null; status: string | null }

export async function submitApprovalDecision(
  requestId: string,
  decision: 'approve' | 'request_changes',
  note: string,
): Promise<DecisionState> {
  const headerList = await headers();
  let ctx;
  try {
    ctx = await resolveTenantContext({ headers: headerList as unknown as Headers });
  } catch (err) {
    if (err instanceof TenantAccessError) return { ok: false, error: 'Sign in as the account owner to answer this.', status: null };
    throw err;
  }
  const result = decideApprovalRequest(ctx, requestId, { decision, note });
  revalidatePath('/approvals');
  revalidatePath(`/approvals/${requestId}`);
  if (result.status === 200) return { ok: true, error: null, status: String(result.payload.status) };
  const code = String(result.payload.error);
  const friendly: Record<string, string> = {
    client_identity_required: 'Only the account owner can answer this.',
    request_expired: 'This request has expired. Ask your assistant to send a new one.',
    request_not_pending: 'This was already answered.',
    request_not_found: 'This request could not be found.',
  };
  return { ok: false, error: friendly[code] ?? 'That did not go through. Please try again.', status: null };
}
