import Link from 'next/link';
import type { ApprovalRequest } from '@/lib/approval-requests';
import { ApprovalPreview } from './ApprovalPreview';
import { DecisionButtons } from './DecisionButtons';

const STATUS_LABEL: Record<ApprovalRequest['status'], string> = {
  pending: 'Waiting for you',
  approved: 'Approved',
  changes_requested: 'Changes requested',
  expired: 'Expired',
};

export function ApprovalCard({ item, detail }: { item: ApprovalRequest; detail?: boolean }) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm" data-testid="approval-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-900">
          {detail ? item.title : <Link href={item.path} className="hover:underline">{item.title}</Link>}
        </h2>
        <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">{STATUS_LABEL[item.status]}</span>
      </div>
      <p className="mt-2 text-gray-700 whitespace-pre-wrap">{item.summary}</p>
      <ApprovalPreview preview={item.preview} />
      {item.status === 'pending' ? <DecisionButtons requestId={item.request_id} /> : null}
      {item.status === 'changes_requested' && item.decision_note ? (
        <p className="mt-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">Your note: {item.decision_note}</p>
      ) : null}
      {item.status === 'pending' ? (
        <p className="mt-3 text-xs text-gray-500">Answer by {new Date(item.expires_at).toLocaleString()}.</p>
      ) : null}
    </section>
  );
}
