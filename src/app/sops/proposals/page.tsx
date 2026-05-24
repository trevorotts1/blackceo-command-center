'use client';

/**
 * /sops/proposals — review queue for both:
 *   • Track N pattern-detected proposals (status='pending')
 *   • Track S auto-research replacements (status='auto-generated-pending-review')
 *
 * For auto-research items the card surfaces the 🤖 badge, the deleted v1
 * side-by-side, and the research-source URLs so the operator can spot-check.
 * Approving an auto-research proposal atomically inserts v2 and re-points
 * every task that referenced v1.
 */
import { useEffect, useState, useCallback } from 'react';

type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'auto-generated-pending-review'
  | 'escalated';

interface Proposal {
  id: string;
  proposed_name: string;
  proposed_department: string | null;
  draft_steps: string;
  based_on_task_ids: string;
  evidence_summary: string | null;
  status: ProposalStatus;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  approved_sop_id: string | null;
  replaces_sop_id?: string | null;
  confidence?: number | null;
  auto_research_attempts?: number | null;
  research_sources?: string | null;
}

interface V1Sop {
  id: string;
  name: string;
  steps: string;
  version: number;
}

interface DraftStep {
  name: string;
  checklist?: string[];
  success_criteria?: string;
}

interface ResearchSource {
  title: string;
  url: string;
}

type FilterTab = 'pending' | 'auto-generated-pending-review' | 'approved' | 'rejected' | 'escalated';

export default function SOPProposalsPage() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [v1Map, setV1Map] = useState<Record<string, V1Sop | null>>({});
  const [statusFilter, setStatusFilter] = useState<FilterTab>('auto-generated-pending-review');
  const [rescanning, setRescanning] = useState(false);
  const [lastScanResult, setLastScanResult] = useState<string | null>(null);
  const [pendingReject, setPendingReject] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/sops/proposals?status=${statusFilter}`);
    if (!r.ok) {
      setProposals([]);
      return;
    }
    const data: Proposal[] = await r.json();
    setProposals(data);

    // Bulk-fetch the v1 SOPs for each auto-research proposal so we can show
    // the side-by-side diff inline.
    const needsDiff = data.filter((p) => p.replaces_sop_id);
    const map: Record<string, V1Sop | null> = {};
    await Promise.all(
      needsDiff.map(async (p) => {
        try {
          const bundle = await fetch(`/api/sops/proposals/${p.id}?include_diff=true`).then((r2) =>
            r2.ok ? r2.json() : null
          );
          map[p.id] = bundle?.v1 ?? null;
        } catch {
          map[p.id] = null;
        }
      })
    );
    setV1Map(map);
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
            Auto-researched replacements (🤖) and pattern-detected drafts. Approve to add as a new SOP version, reject to dismiss.
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
        {(['auto-generated-pending-review', 'pending', 'approved', 'rejected', 'escalated'] as FilterTab[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`rounded px-3 py-1 text-xs ${statusFilter === s ? 'bg-zinc-200 text-zinc-900' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
          >
            {s === 'auto-generated-pending-review' ? '🤖 auto-research' : s}
          </button>
        ))}
      </div>

      {proposals.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">
          No {statusFilter} proposals.
        </div>
      ) : (
        <ul className="space-y-4">
          {proposals.map((p) => {
            let steps: DraftStep[] = [];
            let v1Steps: DraftStep[] = [];
            let taskIds: string[] = [];
            let sources: ResearchSource[] = [];
            try {
              steps = JSON.parse(p.draft_steps);
            } catch {}
            try {
              taskIds = JSON.parse(p.based_on_task_ids);
            } catch {}
            try {
              if (p.research_sources) sources = JSON.parse(p.research_sources);
            } catch {}
            const v1 = v1Map[p.id];
            try {
              if (v1?.steps) v1Steps = JSON.parse(v1.steps);
            } catch {}

            const isAutoResearch = p.status === 'auto-generated-pending-review';
            const isEscalated = p.status === 'escalated';

            return (
              <li key={p.id} className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
                <div className="mb-2 flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-medium text-zinc-100">
                      {isAutoResearch && <span className="mr-2" title="Auto-researched">🤖</span>}
                      {isEscalated && <span className="mr-2" title="Escalated — safety cap hit">⚠️</span>}
                      {p.proposed_name}
                    </h2>
                    <div className="mt-1 text-xs text-zinc-500">
                      {p.proposed_department || 'no department'} · created {new Date(p.created_at).toLocaleString()}
                      {typeof p.confidence === 'number' && (
                        <> · confidence <span className="font-mono">{p.confidence.toFixed(2)}</span></>
                      )}
                      {typeof p.auto_research_attempts === 'number' && p.auto_research_attempts > 0 && (
                        <> · attempt {p.auto_research_attempts}/3</>
                      )}
                      {p.status !== 'pending' && p.status !== 'auto-generated-pending-review' && (
                        <>
                          {' · '}
                          <span className={p.status === 'approved' ? 'text-emerald-400' : 'text-red-400'}>{p.status}</span>
                          {p.reviewed_by ? ` by ${p.reviewed_by}` : ''}
                        </>
                      )}
                    </div>
                  </div>
                  {(p.status === 'pending' || isAutoResearch) && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => approve(p.id)}
                        className="rounded bg-emerald-700 px-3 py-1.5 text-xs text-white hover:bg-emerald-600"
                      >
                        Approve {isAutoResearch ? '+ swap' : ''}
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

                {sources.length > 0 && (
                  <div className="mb-3 rounded border border-blue-900/40 bg-blue-950/20 p-2 text-xs">
                    <div className="mb-1 font-medium text-blue-300">Research sources</div>
                    <ul className="space-y-0.5">
                      {sources.map((s, i) => (
                        <li key={i} className="truncate">
                          <span className="text-zinc-500">[{i + 1}]</span>{' '}
                          <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                            {s.title || s.url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {p.evidence_summary && (
                  <pre className="mb-3 whitespace-pre-wrap rounded bg-zinc-950 p-2 text-xs text-zinc-400">{p.evidence_summary}</pre>
                )}

                {isAutoResearch && v1 ? (
                  <div className="mb-3 grid grid-cols-2 gap-3">
                    <div>
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-red-400">Deleted v1: {v1.name}</div>
                      <ol className="ml-4 list-decimal space-y-1 text-sm text-zinc-400 line-through decoration-red-500/40">
                        {v1Steps.map((s, i) => (
                          <li key={i}>{s.name}</li>
                        ))}
                      </ol>
                    </div>
                    <div>
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-400">Proposed v2</div>
                      <ol className="ml-4 list-decimal space-y-1 text-sm text-zinc-200">
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
                    </div>
                  </div>
                ) : (
                  <>
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
                  </>
                )}

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
