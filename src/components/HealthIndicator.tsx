'use client';

/**
 * HealthIndicator — the ONE consolidated health affordance (U47).
 *
 * Before this unit the workspace header carried FIVE competing signals of
 * "is everything okay": SystemStatusPill (12-probe worst-of-all), the
 * "Gateway Online/Offline" block (a global `isOnline` boolean written by
 * five unrelated call sites), and — indirectly — the Live Feed rail's own
 * connectivity dot. A phone-width viewport saw only ONE of those (the
 * Gateway pill was `hidden sm:flex`), and the two visible-on-desktop
 * signals could each say something different for the same underlying
 * reality. This component replaces all of that with a single source of
 * truth: U46's criticality-tiered `overall` from `/api/system/status`,
 * rendered as exactly one of three states everywhere — Online / Degraded /
 * Offline — with a viewer-scoped presentation:
 *
 *   - `operator`: clickable, opens the existing SystemStatusDrawer
 *     (regrouped Critical / Auxiliary / Model Providers per U46's tier).
 *   - `client`: non-interactive dot + one plain word. Never renders a
 *     probe id, component name, or any internal detail — a client should
 *     never see "OpenClaw" or "Cloudflare" or a raw error string.
 *
 * Visible at every breakpoint — no `hidden` class at any width. The old
 * Gateway pill's phone-width hiding is the exact defect this unit retires.
 */

import { useCallback, useEffect, useState } from 'react';
import { SystemStatusDrawer } from './SystemStatusDrawer';
import type { SystemStatus, TieredProbeResult } from '@/lib/probes/types';

export type HealthIndicatorViewerRole = 'operator' | 'client';

/** The three states this unit's spec names explicitly (H+L "what"). */
export type HealthTier = 'online' | 'degraded' | 'offline' | 'checking';

interface StatusPayload {
  overall: SystemStatus;
  probedAt: string;
  components: TieredProbeResult[];
  fromCache: boolean;
  cacheAgeMs: number | null;
}

interface Props {
  viewerRole: HealthIndicatorViewerRole;
}

const POLL_INTERVAL_MS = 30 * 1000;

/**
 * Collapse U46's six-state-vocabulary `overall` (which by construction of
 * `computeOverallTiered` only ever returns 'live' | 'degraded' | 'offline')
 * down to this unit's three-state contract. `'unknown'` only appears before
 * the first successful poll resolves.
 */
function toHealthTier(overall: SystemStatus | null): HealthTier {
  if (overall === null) return 'checking';
  if (overall === 'offline') return 'offline';
  if (overall === 'degraded') return 'degraded';
  return 'online';
}

const TIER_LABEL: Record<HealthTier, string> = {
  online: 'Online',
  degraded: 'Degraded',
  offline: 'Offline',
  checking: 'Checking…',
};

const TIER_DOT: Record<HealthTier, string> = {
  online: 'bg-emerald-500 animate-pulse',
  degraded: 'bg-orange-500',
  offline: 'bg-red-500',
  checking: 'bg-gray-400',
};

const TIER_STYLE: Record<HealthTier, { bg: string; text: string; border: string }> = {
  online: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
  degraded: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
  offline: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
  checking: { bg: 'bg-gray-50', text: 'text-gray-600', border: 'border-gray-200' },
};

export function HealthIndicator({ viewerRole }: Props) {
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const fetchStatus = useCallback(async (force = false) => {
    try {
      setLoading(true);
      const url = force ? '/api/system/status?force=1' : '/api/system/status';
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as StatusPayload;
        setPayload(data);
      }
    } catch (err) {
      // Never surface the raw error to a client-variant viewer; log for the
      // operator console only.
      console.error('[HealthIndicator] Failed to load system status:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(() => fetchStatus(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const tier = toHealthTier(payload?.overall ?? null);
  const style = TIER_STYLE[tier];

  // Client variant: a dot + one plain word, never interactive, never a
  // probe/component name, never an error string. Rendered at every
  // breakpoint (no `hidden` class).
  if (viewerRole === 'client') {
    return (
      <div
        data-testid="health-indicator"
        data-viewer-role="client"
        role="status"
        aria-label={`System status: ${TIER_LABEL[tier]}`}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border ${style.bg} ${style.text} ${style.border}`}
      >
        <span className={`w-2 h-2 rounded-full ${TIER_DOT[tier]}`} aria-hidden />
        <span>{TIER_LABEL[tier]}</span>
      </div>
    );
  }

  // Operator variant: clickable, opens the existing SystemStatusDrawer.
  return (
    <>
      <button
        type="button"
        data-testid="health-indicator"
        data-viewer-role="operator"
        onClick={() => setOpen(true)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${style.bg} ${style.text} ${style.border} hover:opacity-90`}
        title="System Status"
        aria-label={`System status: ${TIER_LABEL[tier]}. Click for details.`}
      >
        <span className={`w-2 h-2 rounded-full ${TIER_DOT[tier]}`} aria-hidden />
        <span>{TIER_LABEL[tier]}</span>
      </button>

      {open && (
        <SystemStatusDrawer
          payload={payload}
          loading={loading}
          onRefresh={() => fetchStatus(true)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
