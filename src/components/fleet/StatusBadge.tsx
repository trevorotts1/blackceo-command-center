'use client';

/**
 * StatusBadge — a quiet status pill with a semantic dot, extracted from the
 * /overview connection-status pill (U016). Reusable by the /fleet page (U009)
 * and any surface that needs a compact live/offline/working/idle indicator.
 *
 * Design language is byte-for-byte the /overview pill: a rounded-full bordered
 * pill, a 1.5-unit dot, x-small medium-weight label. Color is semantic only —
 * no brand hues — so it reads identically on every white-label theme.
 */

import type { ReactNode } from 'react';

export type StatusTone = 'ok' | 'error' | 'info' | 'warn' | 'neutral';

/** Semantic color sets — pill surface/border/text + dot. Mirrors /overview. */
const TONES: Record<StatusTone, { pill: string; dot: string }> = {
  ok: { pill: 'bg-emerald-50 border-emerald-200 text-emerald-700', dot: 'bg-emerald-500' },
  error: { pill: 'bg-red-50 border-red-200 text-red-700', dot: 'bg-red-500' },
  info: { pill: 'bg-blue-50 border-blue-200 text-blue-700', dot: 'bg-blue-500' },
  warn: { pill: 'bg-amber-50 border-amber-200 text-amber-700', dot: 'bg-amber-500' },
  neutral: { pill: 'bg-gray-50 border-gray-200 text-gray-600', dot: 'bg-gray-400' },
};

export interface StatusBadgeProps {
  /** Semantic tone → color set. */
  tone: StatusTone;
  /** Visible label (e.g. "Live", "Offline", "Working"). */
  label: ReactNode;
  /** Pulse the dot (use for live/working states). */
  pulse?: boolean;
  /** Accessible label for the whole pill (role="status"). Defaults to `label` if a string. */
  ariaLabel?: string;
  className?: string;
}

export function StatusBadge({ tone, label, pulse, ariaLabel, className }: StatusBadgeProps) {
  const t = TONES[tone];
  const resolvedAria =
    ariaLabel ?? (typeof label === 'string' ? `Status: ${label}` : 'Status');
  return (
    <span
      role="status"
      aria-label={resolvedAria}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${t.pill} ${className ?? ''}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${t.dot} ${pulse ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
