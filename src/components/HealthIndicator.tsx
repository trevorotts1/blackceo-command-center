'use client';

/**
 * HealthIndicator — the ONE consolidated health affordance (U47, reshaped by
 * U-06 / CC-004).
 *
 * One source of truth: U46's criticality-tiered `overall` from
 * `/api/system/status`, combined with migration/embedding readiness via
 * `parseReadiness`, rendered with a viewer-scoped presentation:
 *
 *   - `client`: a plain button with a small panel under it. The badge says
 *     "All systems working" / "Needs attention" / "Offline" / "Checking…" /
 *     "Status not available"; opening it lists plain-English reasons
 *     (`clientReasons`) and the check time. Never a probe id, component
 *     name, address or raw error string.
 *   - `operator`: clickable, opens the existing SystemStatusDrawer with the
 *     internal wording.
 *
 * Visible at every breakpoint — no `hidden` class at any width.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { SystemStatusDrawer } from './SystemStatusDrawer';
import { parseReadiness, type HealthTier, type StatusPayload } from '@/lib/health-readiness';
import { clientLabel, clientReasons } from '@/lib/health-client-reasons';
export type { HealthTier } from '@/lib/health-readiness';

export type HealthIndicatorViewerRole = 'operator' | 'client';

interface Props {
  viewerRole: HealthIndicatorViewerRole;
}

const POLL_INTERVAL_MS = 60 * 1000;

const TIER_LABEL: Record<HealthTier, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  checking: 'Checking…',
  unknown: 'Unknown',
};

const TIER_DOT: Record<HealthTier, string> = {
  healthy: 'bg-emerald-500 animate-pulse',
  degraded: 'bg-orange-500',
  unavailable: 'bg-red-500',
  checking: 'bg-gray-400',
  unknown: 'bg-gray-400',
};

const TIER_STYLE: Record<HealthTier, { bg: string; text: string; border: string }> = {
  healthy: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
  degraded: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
  unavailable: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
  checking: { bg: 'bg-gray-50', text: 'text-gray-600', border: 'border-gray-200' },
  unknown: { bg: 'bg-gray-50', text: 'text-gray-600', border: 'border-gray-200' },
};

export function HealthIndicator({ viewerRole }: Props) {
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [healthStatus, setHealthStatus] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const [tier, setTier] = useState<HealthTier>('checking');
  const active = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const clientRef = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(async (force = false) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const request = ++sequence.current;
    setLoading(true);
    const timeout = setTimeout(() => {
      if (request !== sequence.current) return;
      controller.abort();
      setPayload(null);
      setHealthStatus(null);
      setTier('unavailable');
      setLoading(false);
    }, 10_000);
    try {
      const url = force ? '/api/system/status?force=1' : '/api/system/status';
      const [statusResponse, healthResponse] = await Promise.all([
        fetch(url, { cache: 'no-store', signal: controller.signal }),
        fetch('/api/health', { cache: 'no-store', signal: controller.signal }),
      ]);
      if (!statusResponse.ok || !healthResponse.ok) throw new Error('Health request failed');
      const [status, health] = await Promise.all([statusResponse.json(), healthResponse.json()]);
      if (request !== sequence.current || controller.signal.aborted) return;
      const next = parseReadiness(status, health);
      const reported = (health as { status?: unknown } | null)?.status;
      setPayload(next.payload);
      setHealthStatus(typeof reported === 'string' ? reported : null);
      setTier(next.tier);
    } catch {
      if (request !== sequence.current || controller.signal.aborted) return;
      setPayload(null);
      setHealthStatus(null);
      setTier('unavailable');
    } finally {
      clearTimeout(timeout);
      if (request === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Poll once a minute, but only while the tab is visible: a background tab
    // hammering the status probes is load nobody is reading.
    const poll = () => {
      if (document.visibilityState === 'hidden') return;
      void fetchStatus();
    };
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchStatus();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      ++sequence.current;
      active.current?.abort();
    };
  }, [fetchStatus]);

  // Close the client panel on Escape or an outside click.
  useEffect(() => {
    if (!open || viewerRole !== 'client') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (clientRef.current && !clientRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, viewerRole]);

  const style = TIER_STYLE[tier];

  if (viewerRole === 'client') {
    const reasons = clientReasons(payload, healthStatus);
    const label = clientLabel(tier);
    const checkedAt = format(
      payload?.probedAt ? new Date(payload.probedAt) : new Date(),
      'h:mm a'
    );
    return (
      <div className="relative" ref={clientRef}>
        <button
          type="button"
          data-testid="health-indicator"
          data-viewer-role="client"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-label={`System status: ${label}. Click for details.`}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border cursor-pointer transition-colors hover:opacity-90 ${style.bg} ${style.text} ${style.border}`}
        >
          <span className={`w-2 h-2 rounded-full ${TIER_DOT[tier]}`} aria-hidden />
          <span>{label}</span>
        </button>

        {open && (
          <div
            role="dialog"
            aria-label="System status details"
            className="absolute right-0 top-full mt-2 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-50 p-4"
          >
            {tier === 'healthy' ? (
              <p className="text-sm text-gray-700">Everything is running normally.</p>
            ) : (
              <ul className="space-y-3">
                {reasons.map((reason) => (
                  <li key={reason.title}>
                    <p className="text-sm font-medium text-gray-900">{reason.title}</p>
                    <p className="text-xs text-gray-600 mt-0.5">{reason.body}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-gray-500">Checked at {checkedAt}</p>
          </div>
        )}
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
