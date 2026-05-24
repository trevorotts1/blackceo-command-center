'use client';

/**
 * /sops/proposals — review queue for auto-detected candidate SOPs.
 *
 * Each card shows the proposal name, department, evidence summary, the
 * draft steps the learning job extracted, and the IDs of the tasks that
 * triggered the pattern. Owner picks Approve / Reject (with optional
 * reason). Approve creates a real `sops` row at version=1; reject stamps
 * the proposal so it never re-surfaces.
 */
import { useEffect, useState, useCallback } from 'react';

interface Proposal {
  id: string;
  proposed_name: string;
  proposed_department: string | null;
  draft_steps: string;
  based_on_task_ids: string;
  evidence_summary: string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  approved_sop_id: string | null;
}

interface DraftStep {
  name: string;
  checklist?: string[];
  success_criteria?: string;
}

export default function SOPProposalsPage() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [rescanning, setRescanning] = useState(false);
  const [lastScanResult, setLastScanResult] = useState<string | null>(null);
  const [pendingReject, setPendingReject] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/sops/proposals?status=${statusFilter}`);
    if (r.ok) setProposals(await r.json());
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function rescan() {
    setRescanning(true);
    setLastScanResult(null);
    try {
      const r = await fetch('/api/sops/proposals', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      const data = await r.json();
      setLastScanResult(
        `Scanned ${data.scanned_tasks ?? '?'} completed tasks, found ${data.clusters_found ?? 0} clusters, created ${data.proposals_created ?? 0} new proposals.`
      );
      await load();
    } catch (err) {
      setLastScanResult(`Rescan failed: ${(err as Error).message}`);
    } finally {
      setRescanning(false);
    }
  }

  async function approve(id: string) {
    const r = await fetch(`/api/sops/proposals/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    if (r.ok) load();
    else alert(`Approve failed: ${(await r.json()).error}`);
  }

  async function reject(id: string) {
    const r = await fetch(`/api/sops/proposals/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reject', reason: rejectReason || undefined }),
    });
    if (r.ok) {
      setPendingReject(null);
      setRejectReason('');
      load();
    } else {
      alert(`Reject failed: ${(await r.json()).error}`);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">SOP Proposals</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Auto-detected patterns in completed tasks. Approve to add as v1 SOP, reject to dismiss.
          </p>
        </div>
        <button
          type="button"
          onClick={rescan}
          disabled={rescanning}
          className="rounded bg-zinc-700 px-3 py-2 text-sm text-white hover:bg-zinc-600 disabled:opacity-50"
        >
          {rescanning ? 'Scanning…' : 'Re-scan now'}
        </button>
      </div>

      {lastScanResult && <div className="mb-4 rounded border border-zinc-700 bg-zinc-900 p-3 text-sm text-zinc-300">{lastScanResult}</div>}

      <div className="mb-4 flex gap-2">
        {(['pending', 'approved', 'rejected'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`rounded px-3 py-1 text-xs ${statusFilter === s ? 'bg-zinc-200 text-zinc-900' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
          >
            {s}
          </button>
        ))}
      </div>

      {proposals.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">
          No {statusFilter} proposals. The learning job runs nightly — patterns appear once enough completed tasks share a signature.
        </div>
      ) : (
        <ul className="space-y-4">
          {proposals.map((p) => {
            let steps: DraftStep[] = [];
            let taskIds: string[] = [];
            try {
              steps = JSON.parse(p.draft_steps);
            } catch {}
            try {
              taskIds = JSON.parse(p.based_on_task_ids);
            } catch {}

            return (
              <li key={p.id} className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
                <div className="mb-2 flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-medium text-zinc-100">{p.proposed_name}</h2>
                    <div className="mt-1 text-xs text-zinc-500">
                      {p.proposed_department || 'no department'} · created {new Date(p.created_at).toLocaleString()}
                      {p.status !== 'pending' && (
                        <>
                          {' · '}
                          <span className={p.status === 'approved' ? 'text-emerald-400' : 'text-red-400'}>{p.status}</span>
                          {p.reviewed_by ? ` by ${p.reviewed_by}` : ''}
                        </>
                      )}
                    </div>
                  </div>
                  {p.status === 'pending' && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => approve(p.id)}
                        className="rounded bg-emerald-700 px-3 py-1.5 text-xs text-white hover:bg-emerald-600"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingReject(p.id)}
                        className="rounded bg-red-900/40 px-3 py-1.5 text-xs text-red-200 hover:bg-red-900/60"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>

                {p.evidence_summary && (
                  <pre className="mb-3 whitespace-pre-wrap rounded bg-zinc-950 p-2 text-xs text-zinc-400">{p.evidence_summary}</pre>
                )}

                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Draft steps</div>
                <ol className="ml-4 list-decimal space-y-1 text-sm text-zinc-300">
                  {steps.map((s, i) => (
                    <li key={i}>
                      <span className="font-medium">{s.name}</span>
                      {s.checklist && s.checklist.length > 0 && (
                        <ul className="ml-4 mt-1 list-disc text-xs text-zinc-500">
                          {s.checklist.map((c, j) => (
                            <li key={j}>{c}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>

                {taskIds.length > 0 && (
                  <div className="mt-3 text-xs text-zinc-500">
                    Based on {taskIds.length} task(s):{' '}
                    <span className="font-mono">{taskIds.slice(0, 4).join(', ')}{taskIds.length > 4 ? ` +${taskIds.length - 4} more` : ''}</span>
                  </div>
                )}

                {pendingReject === p.id && (
                  <div className="mt-3 rounded border border-red-900/40 bg-red-950/30 p-3">
                    <label className="mb-1 block text-xs text-red-200">Reason (optional)</label>
                    <textarea
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      className="mb-2 h-16 w-full resize-none rounded bg-zinc-800 p-2 text-sm text-zinc-100 outline-none"
                      placeholder="Not a real pattern, duplicate of SOP X, …"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setPendingReject(null);
                          setRejectReason('');
                        }}
                        className="rounded px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => reject(p.id)}
                        className="rounded bg-red-700 px-3 py-1.5 text-xs text-white hover:bg-red-600"
                      >
                        Confirm reject
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
