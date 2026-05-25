'use client';

/**
 * SystemStatusPill — top-bar component (PRD Section 3.12).
 *
 * Polls /api/system/status every 30s. Color reflects the overall (worst)
 * component status. Clicking the pill opens SystemStatusDrawer.
 */

import { useEffect, useState, useCallback } from 'react';
import { SystemStatusDrawer } from './SystemStatusDrawer';

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

const POLL_INTERVAL_MS = 30 * 1000;

const STATUS_STYLES: Record<SystemStatus, { dot: string; bg: string; text: string; border: string; label: string }> = {
  live: {
    dot: 'bg-emerald-500 animate-pulse',
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    border: 'border-emerald-200',
    label: 'LIVE',
  },
  working: {
    dot: 'bg-emerald-500 animate-pulse',
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    border: 'border-emerald-200',
    label: 'WORKING',
  },
  busy: {
    dot: 'bg-amber-500 animate-pulse',
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    border: 'border-amber-200',
    label: 'BUSY',
  },
  degraded: {
    dot: 'bg-orange-500',
    bg: 'bg-orange-50',
    text: 'text-orange-700',
    border: 'border-orange-200',
    label: 'DEGRADED',
  },
  offline: {
    dot: 'bg-red-500',
    bg: 'bg-red-50',
    text: 'text-red-700',
    border: 'border-red-200',
    label: 'OFFLINE',
  },
  unknown: {
    dot: 'bg-gray-400',
    bg: 'bg-gray-50',
    text: 'text-gray-600',
    border: 'border-gray-200',
    label: 'UNKNOWN',
  },
};

export function SystemStatusPill() {
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
      console.error('Failed to load system status:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(() => fetchStatus(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const overall: SystemStatus = payload?.overall || 'unknown';
  const style = STATUS_STYLES[overall];

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${style.bg} ${style.text} ${style.border} hover:opacity-90`}
        title="System Status"
        aria-label={`System status: ${style.label}`}
      >
        <span className={`w-2 h-2 rounded-full ${style.dot}`} />
        <span>{style.label}</span>
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
