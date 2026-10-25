import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Breadcrumb } from '@/components/Breadcrumb';
import { CampaignApprovalBoard } from '@/components/campaign-approval/CampaignApprovalBoard';
import { loadCampaignApprovalSnapshot } from '@/lib/campaigns/approval-store';
import { resolveCampaignsCompany } from '@/lib/social/company-context';

export const dynamic = 'force-dynamic';

/**
 * PBB-128 / T-32 — /campaigns/[id]/approval
 *
 * The campaign calendar with its REAL approval manifest, publication receipts
 * and targeted approve/hold controls. Tenant resolution is the same F01/F36
 * path every campaign surface uses; a campaign owned by another company is
 * indistinguishable from one that does not exist (404, no leak).
 */
export default async function CampaignApprovalPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const headerList = await headers();
  const identity = await resolveCampaignsCompany({ headers: headerList as unknown as Headers });

  if (!identity.ok) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-lg font-semibold text-slate-800">Campaign approval</h1>
        <p className="mt-2 text-sm text-slate-600">A verified company identity is required to open this view.</p>
      </div>
    );
  }

  const snapshot = loadCampaignApprovalSnapshot(id, identity.company.companyId);
  if (!snapshot) notFound();

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <Breadcrumb
        items={[
          { label: 'Home', href: '/' },
          { label: 'Campaigns', href: `/campaigns/${id}` },
          { label: 'Approval' },
        ]}
      />
      <CampaignApprovalBoard view={snapshot.view} />
    </div>
  );
}
