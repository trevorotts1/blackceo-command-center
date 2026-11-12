import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveTenantContext } from '@/lib/auth/tenant-context';
import { loadApprovalRequest } from '@/lib/approval-requests';
import { ApprovalCard } from '@/components/approvals/ApprovalCard';

export const dynamic = 'force-dynamic';

/** /approvals/<requestId> — the stable deep link an agent sends to the owner. */
export default async function ApprovalDetailPage(props: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await props.params;
  const headerList = await headers();
  let item;
  try {
    const ctx = await resolveTenantContext({ headers: headerList as unknown as Headers });
    item = loadApprovalRequest(ctx.tenantId, requestId);
  } catch {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-xl font-semibold text-gray-900">Approval</h1>
        <p className="mt-2 text-gray-600">Sign in with your account to answer this.</p>
      </div>
    );
  }
  if (!item) notFound();
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <Link href="/approvals" className="text-sm text-brand-700 underline">All approvals</Link>
      <ApprovalCard item={item} detail />
    </div>
  );
}
