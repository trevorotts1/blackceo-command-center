'use server';

/**
 * PBB-128 / T-32 — the only two mutations the campaign approval view performs.
 *
 * Both build a full `schemas/cc-command.schema.json` command SERVER-SIDE:
 * tenant and actor come from the verified session (never the form), the
 * command id and submitted_at are minted here, and the expected revision is
 * the caller's optimistic-concurrency value. The command then goes through
 * `applyCampaignCommand`, which refuses anything that is not a targeted
 * approve or a targeted hold.
 *
 * There is no send button, no provider call and no dispatch import by design:
 * approving a manifest authorizes; it never publishes. Publication stays on the
 * separate publish queue with its own fresh gate.
 */
import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { resolveCampaignsCompany } from '@/lib/social/company-context';
import { applyCampaignCommand } from '@/lib/campaigns/approval-store';

export interface CampaignActionState {
  ok: boolean;
  code: string | null;
  reason: string;
  revision: number | null;
}

export interface CampaignActionInput {
  campaignId: string;
  kind: 'approve_campaign' | 'hold_placement';
  placementId?: string;
  expectedRevision: number;
  purpose?: string;
}

export async function submitCampaignCommand(input: CampaignActionInput): Promise<CampaignActionState> {
  const headerList = await headers();
  const identity = await resolveCampaignsCompany({ headers: headerList as unknown as Headers });
  if (!identity.ok) {
    return { ok: false, code: 'unauthenticated', reason: identity.error, revision: null };
  }
  const companyId = identity.company.companyId;

  const purpose = (input.purpose ?? '').trim() || (input.kind === 'approve_campaign' ? 'Owner approval of campaign manifest' : 'Owner hold on placement');

  const command = {
    schema_version: 1 as const,
    command_id: randomUUID(),
    tenant_id: companyId,
    actor_id: identity.company.tenant.subject ?? 'owner',
    action: input.kind,
    target_type: input.kind === 'approve_campaign' ? ('campaign' as const) : ('placement' as const),
    target_id: input.kind === 'approve_campaign' ? input.campaignId : (input.placementId ?? ''),
    expected_revision: input.expectedRevision,
    purpose,
    submitted_at: new Date().toISOString(),
  };

  const result = await applyCampaignCommand(command, companyId);
  revalidatePath(`/campaigns/${input.campaignId}/approval`);

  if (result.ok) {
    return { ok: true, code: null, reason: result.receipt.reason, revision: result.receipt.applied_revision };
  }
  return { ok: false, code: result.code, reason: result.reason, revision: result.receipt?.applied_revision ?? null };
}
