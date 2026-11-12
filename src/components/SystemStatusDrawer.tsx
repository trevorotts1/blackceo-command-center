'use client';

/**
 * SystemStatusDrawer — slide-out drawer with per-component detail (PRD 3.12).
 *
 * U47: reused as-is by the consolidated <HealthIndicator/> (operator
 * variant only — the client variant never opens this drawer). Receives the
 * current payload and exposes a refresh button that triggers `?force=1`
 * re-runs.
 *
 * U-06 (CC-039): the old bootstrap admin action is gone. It posted
 * `/api/system/bootstrap` from the browser without a bearer token, so the
 * route refused it every time — a button that could not work. Bootstrap runs
 * out of band; this drawer is diagnostics only.
 *
 * U47 change: rows are grouped by the U46 `tier` field (Critical /
 * Auxiliary / Model Providers) instead of a hand-maintained component-id
 * allowlist, so a new probe added to system-status.ts's roster is
 * automatically classified instead of silently missing from every group.
 * The drawer is also responsive (`w-full sm:w-96`) instead of a fixed
 * `w-96` that overflowed a 375px viewport.
 */

import { useEffect, useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import type { SystemStatus, TieredProbeResult } from '@/lib/probes/types';
import { explainStatus } from '@/lib/status-explanations';

interface StatusPayload {
  overall: SystemStatus;
  probedAt: string;
  components: TieredProbeResult[];
  fromCache: boolean;
  cacheAgeMs: number | null;
}

interface Props {
  payload: StatusPayload | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

/**
 * U47: fold the Live Feed connectivity dot (previously only shown inline in
 * LiveFeed.tsx's own header, PRD's "third independent signal") into the
 * drawer as an additional auxiliary row, so the operator can see it
 * alongside every other probe instead of having to notice a tiny dot inside
 * a separate collapsible rail. Sourced from the SAME client-feed endpoint
 * LiveFeed.tsx already polls — this is a read-only presentational fetch,
 * not a new probe registered in system-status.ts's roster (out of this
 * unit's file lane), so it degrades to 'unknown' rather than throwing if
 * the endpoint is unreachable.
 */
function useLiveFeedRow(open: boolean): TieredProbeResult | null {
  const [row, setRow] = useState<TieredProbeResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const poll = async () => {
      const probedAt = new Date().toISOString();
      try {
        const res = await fetch('/api/events/client-feed?limit=1', { cache: 'no-store' });
        if (cancelled) return;
        if (!res.ok) {
          setRow({
            component: 'live_feed',
            label: 'Live Feed',
            status: 'unknown',
            latencyMs: null,
            probedAt,
            tier: 'auxiliary',
          });
          return;
        }
        const data = (await res.json()) as { source?: string; gateway_error?: string };
        const unreachable = data.source === 'gateway_unreachable';
        setRow({
          component: 'live_feed',
          label: 'Live Feed',
          status: unreachable ? 'offline' : 'live',
          latencyMs: null,
          error: unreachable ? data.gateway_error : undefined,
          probedAt,
          tier: 'auxiliary',
        });
      } catch {
        if (!cancelled) {
          setRow({
            component: 'live_feed',
            label: 'Live Feed',
            status: 'unknown',
            latencyMs: null,
            probedAt,
            tier: 'auxiliary',
          });
        }
      }
    };

    poll();
    const interval = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [open]);

  return row;
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

  // U47: fold the Live Feed dot in as an extra auxiliary row. Only polled
  // while the drawer is actually open.
  const liveFeedRow = useLiveFeedRow(true);

  // U47: group by the U46 `tier` field instead of a hand-maintained
  // component-id allowlist — Critical / Auxiliary / Model Providers.
  // Providers are carved out of "auxiliary" into their own section for
  // readability (tierFor() classifies every provider_* row 'auxiliary',
  // same as every other non-critical probe).
  const critical = components.filter((c) => c.tier === 'critical');
  const providers = components.filter((c) => c.component.startsWith('provider_'));
  const auxiliary = components.filter(
    (c) => c.tier === 'auxiliary' && !c.component.startsWith('provider_')
  );
  const auxiliaryWithFeed = liveFeedRow ? [...auxiliary, liveFeedRow] : auxiliary;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-black/30"
        onClick={onClose}
        aria-hidden
      />
      {/* U47: responsive — a fixed w-96 (24rem) overflowed a 375px viewport;
          full-width below sm, fixed width at sm and up. */}
      <aside className="w-full sm:w-96 bg-white border-l border-gray-200 shadow-xl flex flex-col">
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
          <Section title="Critical" rows={critical} />
          <Section title="Auxiliary" rows={auxiliaryWithFeed} />
          <Section title="Model Providers" rows={providers} />
        </div>
      </aside>
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: TieredProbeResult[] }) {
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
            <StatusExplanationBlock row={r} />
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

/** Plain-English "what does this mean for me" for any row that is not healthy. */
function StatusExplanationBlock({ row }: { row: TieredProbeResult }) {
  const info = explainStatus(row);
  if (!info) return null;
  return (
    <details className="mt-2" data-testid={`status-explain-${row.component}`}>
      <summary className="text-xs font-medium text-brand-700 cursor-pointer hover:underline">
        What does this mean for me?
      </summary>
      <div className="mt-1 space-y-1 text-xs text-gray-700 bg-orange-50 border border-orange-100 rounded p-2">
        <p>{info.meaning}</p>
        <p className="font-medium">{info.actionNeeded ? 'You need to act.' : 'You do not need to do anything.'}</p>
        <p>{info.nextStep}</p>
        {info.link ? (
          <a href={info.link.href} className="underline text-brand-700">{info.link.label}</a>
        ) : null}
      </div>
    </details>
  );
}
