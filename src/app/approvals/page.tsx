import { headers } from 'next/headers';
import Link from 'next/link';
import { resolveTenantContext } from '@/lib/auth/tenant-context';
import { listApprovalRequests } from '@/lib/approval-requests';
import { ApprovalCard } from '@/components/approvals/ApprovalCard';

export const dynamic = 'force-dynamic';

/** /approvals — everything your assistant is waiting on you to approve. */
export default async function ApprovalsPage() {
  const headerList = await headers();
  let items;
  try {
    const ctx = await resolveTenantContext({ headers: headerList as unknown as Headers });
    items = listApprovalRequests(ctx.tenantId, 'all', 100);
  } catch {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-xl font-semibold text-gray-900">Approvals</h1>
        <p className="mt-2 text-gray-600">Sign in with your account to see what is waiting for you.</p>
      </div>
    );
  }
  const waiting = items.filter((i) => i.status === 'pending');
  const earlier = items.filter((i) => i.status !== 'pending');
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Approvals</h1>
        <Link href="/" className="text-sm text-brand-700 underline">Back to dashboard</Link>
      </div>
      {waiting.length === 0 ? (
        <p className="rounded-xl bg-gray-50 border border-gray-200 p-6 text-gray-700">Nothing is waiting for you right now.</p>
      ) : (
        waiting.map((i) => <ApprovalCard key={i.request_id} item={i} />)
      )}
      {earlier.length > 0 ? (
        <>
          <h2 className="pt-4 text-lg font-semibold text-gray-700">Earlier</h2>
          {earlier.map((i) => <ApprovalCard key={i.request_id} item={i} />)}
        </>
      ) : null}
    </div>
  );
}
