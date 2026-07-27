/**
 * PresentationDeliverablesPanel Component
 *
 * U063: the nine-row deliverables checklist for presentation-department tasks.
 * Mounted beside DeliverablesList for presentation tasks only.
 *
 * Conventions: kebab-case data-testid on panel root and each addressable
 * chunk (copied from DispatchHoldPanel, TaskOverviewPanels.tsx:370-387).
 * Wide table inside its own overflow-x: auto container.
 * Every state carries a text label; colour is never the signal.
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { FileText, ExternalLink, Download, AlertTriangle, CheckCircle, HelpCircle, Info } from 'lucide-react';

type Verification = 'verified' | 'size-only' | 'absent';
type SizeSource = 'db' | 'stat' | 'unknown';

interface DeliveryRow {
  key: string; filename: string; label: string; min_bytes: number;
  present: boolean; produced_at: string | null; size_bytes: number | null;
  size_source: SizeSource; below_floor: boolean | null;
  mime_type: string | null; sha256: string | null;
  verification: Verification; ghl_url: string | null;
}

interface ExtraDeliverable { id: string; deliverable_type: string; title: string; path: string | null; created_at: string; }

interface DeliverablesResponse { rows: DeliveryRow[]; extra: ExtraDeliverable[]; ghl_ledger_present: boolean; }

interface PresentationDeliverablesPanelProps { taskId: string; }

export function PresentationDeliverablesPanel({ taskId }: PresentationDeliverablesPanelProps) {
  const [data, setData] = useState<DeliverablesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/presentations/${taskId}/deliverables`);
      if (!res.ok) { const b = await res.json().catch(() => null); setError((b as { error?: string })?.error || `HTTP ${res.status}`); }
      else setData(await res.json() as DeliverablesResponse);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [taskId]);

  useEffect(() => { load(); }, [load]);

  const fmtTs = (ts: string | null) => ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  const fmtSize = (b: number | null) => b === null ? '—' : b < 1024 ? `${b} B` : b < 1_048_576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1_048_576).toFixed(1)} MB`;
  const srcLabel = (s: SizeSource) => s === 'db' ? 'recorded' : s === 'stat' ? 'measured on disk' : 'cannot verify';

  if (loading) return <div className="mt-4 flex items-center justify-center py-8" data-testid="presentation-deliverables-panel"><div className="text-gray-500">Loading presentation deliverables...</div></div>;
  if (error) return <div className="mt-4 flex items-center justify-center py-8" data-testid="presentation-deliverables-panel"><div className="text-red-600 text-sm">Failed to load deliverables: {error}</div></div>;
  if (!data) return <div className="mt-4 flex items-center justify-center py-8" data-testid="presentation-deliverables-panel"><div className="text-gray-500">No deliverables data</div></div>;

  const { rows } = data;

  return (
    <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden" data-testid="presentation-deliverables-panel">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><FileText className="w-4 h-4 text-indigo-600" />Presentation Deliverables</h3>
        <span className="text-xs text-gray-500">{rows.filter(r => r.present).length} of {rows.length} produced{!data.ghl_ledger_present && <span className="ml-2 text-gray-400" title="No GHL media upload ledger found">(GHL uploads not found)</span>}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="border-b border-gray-200 bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
            <th className="text-left px-4 py-2 font-medium">Artifact</th><th className="text-left px-4 py-2 font-medium">Filename</th><th className="text-left px-4 py-2 font-medium">Status</th><th className="text-left px-4 py-2 font-medium">Produced</th><th className="text-right px-4 py-2 font-medium">Size</th><th className="text-right px-4 py-2 font-medium">Floor</th><th className="text-center px-4 py-2 font-medium">Verification</th><th className="text-center px-4 py-2 font-medium">GHL</th><th className="text-center px-4 py-2 font-medium">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(row => {
              const isTp = row.key === 'teleprompter_html';
              return (
                <tr key={row.key} className={`hover:bg-gray-50 ${!row.present ? 'opacity-60' : ''}`} data-testid={`presentation-deliverable-row-${row.key}`}>
                  <td className="px-4 py-2.5 text-gray-900 font-medium whitespace-nowrap">{row.label}</td>
                  <td className="px-4 py-2.5 text-gray-600 font-mono text-xs whitespace-nowrap">{row.filename}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{row.present ? <span className="inline-flex items-center gap-1 text-green-700 text-xs font-medium"><CheckCircle className="w-3.5 h-3.5" />Present</span> : <span className="inline-flex items-center gap-1 text-gray-400 text-xs font-medium"><Info className="w-3.5 h-3.5" />Not produced</span>}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{fmtTs(row.produced_at)}</td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap"><span className="text-xs text-gray-700">{fmtSize(row.size_bytes)}</span><span className="block text-[10px] text-gray-400">{srcLabel(row.size_source)}</span></td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">{row.below_floor === true ? <span className="inline-flex items-center gap-1 text-orange-700 text-xs font-medium" data-testid={`below-floor-${row.key}`}><AlertTriangle className="w-3.5 h-3.5" />Below floor</span> : row.below_floor === false ? <span className="inline-flex items-center gap-1 text-green-700 text-xs font-medium"><CheckCircle className="w-3.5 h-3.5" />Above floor</span> : <span className="text-xs text-gray-400">—</span>}</td>
                  <td className="px-4 py-2.5 text-center whitespace-nowrap">{row.verification === 'verified' ? <span className="inline-flex items-center gap-1 text-green-700 text-xs font-medium" data-testid={`verification-${row.key}`}><CheckCircle className="w-3.5 h-3.5" />Verified</span> : row.verification === 'size-only' ? <span className="inline-flex items-center gap-1 text-blue-600 text-xs font-medium" data-testid={`verification-${row.key}`}><HelpCircle className="w-3.5 h-3.5" />Size-only</span> : <span className="text-xs text-gray-400" data-testid={`verification-${row.key}`}>—</span>}</td>
                  <td className="px-4 py-2.5 text-center whitespace-nowrap">{row.ghl_url ? <a href={row.ghl_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-700 text-xs font-medium" data-testid={`ghl-link-${row.key}`}><ExternalLink className="w-3.5 h-3.5" />View</a> : <span className="text-xs text-gray-400" data-testid={`ghl-none-${row.key}`}>Not uploaded</span>}</td>
                  <td className="px-4 py-2.5 text-center whitespace-nowrap">{isTp && row.present ? <div className="flex flex-col items-center gap-0.5"><a href={`/api/artifacts/${taskId}/${encodeURIComponent(row.filename)}`} className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700" data-testid="teleprompter-download"><Download className="w-3.5 h-3.5" />Download</a><span className="text-[10px] text-gray-400">In-app viewer ships in a later unit</span></div> : isTp && !row.present ? <span className="text-xs text-gray-400">—</span> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.extra.length > 0 && (
        <div className="border-t border-gray-200 px-4 py-3" data-testid="presentation-extra-deliverables">
          <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Other deliverables ({data.extra.length})</h4>
          <div className="space-y-1">{data.extra.map(ex => <div key={ex.id} className="text-xs text-gray-600 flex items-center gap-2"><span className="capitalize text-gray-400">{ex.deliverable_type}</span><span>{ex.title}</span>{ex.path && <span className="text-gray-400 font-mono truncate max-w-[200px]">({ex.path})</span>}</div>)}</div>
        </div>
      )}
    </div>
  );
}
