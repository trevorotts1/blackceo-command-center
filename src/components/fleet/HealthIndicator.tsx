'use client';

/**
 * HealthIndicator — a compact health panel of label/status rows, extracted from
 * the /overview "System" panel (U016). Reusable by the /fleet page (U009) to
 * render per-box or per-subsystem health (gateway reachable, agents working,
 * last heartbeat, etc.).
 *
 * Design language mirrors /overview's System card: a quiet hairline card, a
 * "System"-style heading, and rows that pair a muted label with a semantic
 * status (icon + colored text for ok/error, or a mono tabular value for
 * counts). No brand hues; status color is semantic only.
 */

import { CheckCircle2, CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export type HealthStatus = 'ok' | 'error' | 'unknown';

export interface HealthRow {
  /** Row label (e.g. "Gateway", "Agents", "Last heartbeat"). */
  label: string;
  /** How to render the value: a discrete status pill, or a free-form value. */
  status?: HealthStatus;
  /** Text shown next to a status icon (e.g. "Operational" / "Unreachable"). */
  statusText?: string;
  /** A free-form value (e.g. "3 working / 5", "2m ago") — rendered in mono. */
  value?: ReactNode;
}

export interface HealthIndicatorProps {
  /** Panel heading. Defaults to "System". */
  title?: string;
  rows: HealthRow[];
  /** Optional footer content (e.g. a call-to-action link). */
  footer?: ReactNode;
  className?: string;
}

function StatusValue({ status, text }: { status: HealthStatus; text?: string }) {
  if (status === 'ok') {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
        <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
        {text ?? 'Operational'}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-red-700">
        <CircleAlert className="w-3.5 h-3.5" aria-hidden="true" />
        {text ?? 'Unreachable'}
      </span>
    );
  }
  return <span className="text-xs font-medium text-gray-400">{text ?? 'Unknown'}</span>;
}

export function HealthIndicator({ title = 'System', rows, footer, className }: HealthIndicatorProps) {
  return (
    <div className={`bg-white border border-gray-200 rounded-xl p-4 flex flex-col ${className ?? ''}`}>
      <h2 className="text-sm font-semibold text-gray-900 mb-3">{title}</h2>
      <ul className="space-y-2.5 flex-1">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center justify-between gap-2">
            <span className="text-sm text-gray-600">{row.label}</span>
            {row.status ? (
              <StatusValue status={row.status} text={row.statusText} />
            ) : (
              <span className="text-xs font-mono tabular-nums font-medium text-gray-700">
                {row.value ?? '–'}
              </span>
            )}
          </li>
        ))}
      </ul>
      {footer ? <div className="mt-4">{footer}</div> : null}
    </div>
  );
}
