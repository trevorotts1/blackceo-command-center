'use client';

/**
 * ModuleHealthDot — per-module vault-write health indicator (Feature 2).
 *
 * Renders a small status dot + accessible label showing whether a persisting
 * Operator sub-module (Goals / Journal / Notebook / Studio / Research) is
 * actually saving AND whether its last write reached the operator vault.
 *
 * Data source: GET /api/operator/health (read-only probe — see
 * `src/lib/operator/module-health.ts`). Polls every 30s, same cadence as
 * SystemStatusPill, and reuses that component's exact six-state color
 * vocabulary so the dots speak one visual language across the app.
 *
 * Honesty contract: the dot only goes GREEN when a vault write is confirmed.
 * Amber = saved to DB but vault mirror unconfirmed. Red = DB error or last
 * vault write failed. Grey = nothing determinable yet (unknown). Unknown is
 * NEVER shown as green.
 *
 * Accessibility: status is conveyed by icon + visible/`aria-label` TEXT, never
 * color alone (WCAG 2.1 AA, matches the v4.1.x a11y bar). The dot carries a
 * `title` + `aria-label`; when `showLabel` is set, the human-readable message
 * renders as adjacent text.
 */

import { useEffect, useState, useCallback } from 'react';
import type { ModuleId } from '@/lib/operator/module-health';

type ModuleStatus = 'live' | 'working' | 'busy' | 'degraded' | 'offline' | 'unknown';

interface ModuleHealthPayload {
  module: ModuleId;
  label: string;
  status: ModuleStatus;
  message: string;
  vault: { ok: boolean | null; lastWriteAt: string | null; notApplicable?: boolean };
  checkedAt: string;
}

interface HealthResponse {
  overall: ModuleStatus;
  modules: ModuleHealthPayload[];
  probedAt: string;
}

const POLL_INTERVAL_MS = 30 * 1000;

// Mirrors STATUS_STYLES in src/components/SystemStatusPill.tsx so module dots
// and the global system pill share one color language.
const STATUS_STYLES: Record<ModuleStatus, { dot: string; text: string; label: string }> = {
  live: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Vault OK' },
  working: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Vault OK' },
  busy: { dot: 'bg-amber-500', text: 'text-amber-700', label: 'Saved' },
  degraded: { dot: 'bg-orange-500', text: 'text-orange-700', label: 'Degraded' },
  offline: { dot: 'bg-red-500', text: 'text-red-700', label: 'Error' },
  unknown: { dot: 'bg-gray-400', text: 'text-gray-600', label: 'Unknown' },
};

// ---------------------------------------------------------------------------
// Shared fetch hook. One poll feeds every dot on a page (the home grid mounts
// several at once; sharing avoids N parallel requests per tick).
// ---------------------------------------------------------------------------
function useModuleHealth(): { data: HealthResponse | null; loading: boolean } {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/operator/health', { cache: 'no-store' });
      if (res.ok) {
        setData((await res.json()) as HealthResponse);
      }
    } catch {
      // Network/transient — leave prior state, dot falls back to unknown.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const id = setInterval(fetchHealth, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchHealth]);

  return { data, loading };
}

interface ModuleHealthDotProps {
  module: ModuleId;
  /** When true, render the human-readable message text next to the dot. */
  showLabel?: boolean;
  className?: string;
}

/**
 * A single module's health dot. Self-fetches (so it can be dropped onto any
 * server-rendered sub-module page header without prop drilling). For the home
 * grid where many dots mount at once, prefer passing a shared payload via
 * <ModuleHealthDotFromPayload/> below to avoid duplicate polling.
 */
export default function ModuleHealthDot({ module, showLabel, className }: ModuleHealthDotProps) {
  const { data, loading } = useModuleHealth();
  const found = data?.modules.find((m) => m.module === module) || null;
  const status: ModuleStatus = found?.status ?? 'unknown';
  const message = found?.message ?? (loading ? 'Checking vault health…' : 'Health unavailable.');

  return <Dot status={status} message={message} label={found?.label ?? module} showLabel={showLabel} className={className} />;
}

/**
 * Stateless dot driven by an already-fetched payload row. Use this when a
 * parent already holds the /api/operator/health response (e.g. the home grid).
 */
export function ModuleHealthDotFromPayload({
  row,
  showLabel,
  className,
}: {
  row: ModuleHealthPayload | null | undefined;
  showLabel?: boolean;
  className?: string;
}) {
  const status: ModuleStatus = row?.status ?? 'unknown';
  const message = row?.message ?? 'Health unavailable.';
  return <Dot status={status} message={message} label={row?.label ?? 'Module'} showLabel={showLabel} className={className} />;
}

function Dot({
  status,
  message,
  label,
  showLabel,
  className,
}: {
  status: ModuleStatus;
  message: string;
  label: string;
  showLabel?: boolean;
  className?: string;
}) {
  const style = STATUS_STYLES[status];
  const ariaLabel = `${label} vault health: ${style.label}. ${message}`;
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      title={message}
      className={`inline-flex items-center gap-1.5 ${className ?? ''}`}
    >
      <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`} />
      {showLabel ? (
        <span className={`text-[13px] font-medium ${style.text}`}>{style.label}</span>
      ) : (
        // Screen-reader-only label so the dot is never color-only even without
        // visible text (WCAG 2.1 AA / 1.4.1 Use of Color).
        <span className="sr-only">{style.label}</span>
      )}
    </span>
  );
}

/** Hook export so a parent (home grid) can fetch once and feed many dots. */
export { useModuleHealth };
export type { ModuleHealthPayload, ModuleStatus };
