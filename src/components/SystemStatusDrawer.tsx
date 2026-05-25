'use client';

/**
 * SystemStatusDrawer — slide-out drawer with per-component detail (PRD 3.12).
 *
 * Receives the current payload from SystemStatusPill and exposes a refresh
 * button that triggers `?force=1` re-runs.
 */

import { X, RefreshCw } from 'lucide-react';

type SystemStatus =
  | 'live'
  | 'working'
  | 'busy'
  | 'degraded'
  | 'offline'
  | 'unknown';

interface ProbeResult {
  component: string;
  label: string;
  status: SystemStatus;
  latencyMs: number | null;
  error?: string;
  detail?: Record<string, unknown>;
  probedAt: string;
}

interface StatusPayload {
  overall: SystemStatus;
  probedAt: string;
  components: ProbeResult[];
  fromCache: boolean;
  cacheAgeMs: number | null;
}

interface Props {
  payload: StatusPayload | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

const STATUS_DOT: Record<SystemStatus, string> = {
  live: 'bg-emerald-500',
  working: 'bg-emerald-500 animate-pulse',
  busy: 'bg-amber-500 animate-pulse',
  degraded: 'bg-orange-500',
  offline: 'bg-red-500',
  unknown: 'bg-gray-400',
};

const STATUS_TEXT: Record<SystemStatus, string> = {
  live: 'text-emerald-700',
  working: 'text-emerald-700',
  busy: 'text-amber-700',
  degraded: 'text-orange-700',
  offline: 'text-red-700',
  unknown: 'text-gray-600',
};

export function SystemStatusDrawer({ payload, loading, onRefresh, onClose }: Props) {
  const components = payload?.components || [];

  // Group components by category for readability.
  const core = components.filter((c) =>
    ['database', 'openclaw_gateway', 'memory', 'jobs', 'disk', 'agents', 'telegram'].includes(c.component)
  );
  const providers = components.filter((c) => c.component.startsWith('provider_'));

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-black/30"
        onClick={onClose}
        aria-hidden
      />
      <aside className="w-96 bg-white border-l border-gray-200 shadow-xl flex flex-col">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">System Status</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {payload?.fromCache
                ? `Cached ${Math.round((payload.cacheAgeMs || 0) / 1000)}s ago`
                : payload
                ? `Live as of ${new Date(payload.probedAt).toLocaleTimeString()}`
                : 'Loading...'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onRefresh}
              disabled={loading}
              className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-50"
              title="Force refresh"
              aria-label="Force refresh status"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"
              title="Close"
              aria-label="Close status drawer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <Section title="Core" rows={core} />
          <Section title="Model Providers" rows={providers} />
        </div>
      </aside>
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: ProbeResult[] }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{title}</h3>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.component} className="border border-gray-100 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-2 h-2 rounded-full ${STATUS_DOT[r.status]}`} />
                <span className="text-sm font-medium text-gray-900 truncate">{r.label}</span>
              </div>
              <span className={`text-xs font-semibold uppercase ${STATUS_TEXT[r.status]}`}>
                {r.status}
              </span>
            </div>
            <div className="mt-1 text-xs text-gray-500 flex items-center gap-3">
              {typeof r.latencyMs === 'number' && <span>{r.latencyMs}ms</span>}
              {r.error && <span className="text-orange-600 truncate">{r.error}</span>}
            </div>
            {r.detail && Object.keys(r.detail).length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">Detail</summary>
                <pre className="mt-1 text-xs text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(r.detail, null, 2)}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
