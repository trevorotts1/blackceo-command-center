'use client';

import { useMemo } from 'react';
import { EmptyState } from './EmptyState';
import type { ConvAiMetrics } from './types';

/**
 * Pixel funnel — horizontal funnel bars. Used for both the Layer-1 pixel
 * funnel and the Layer-2 journey-template funnel (same shape, different label
 * context passed by the parent).
 */
export function PixelFunnel({
  metric,
  emptyTitle = 'Pixel funnel not connected yet',
  emptyHint = 'Funnel stages populate once the pixel-events source is emitting.',
}: {
  metric?: { available: boolean; data: { stage: string; count: number }[] };
  emptyTitle?: string;
  emptyHint?: string;
}) {
  const rows = useMemo(() => metric?.data ?? [], [metric]);
  const max = useMemo(() => Math.max(1, ...rows.map((r) => r.count)), [rows]);

  if (!metric?.available) {
    return <EmptyState title={emptyTitle} hint={emptyHint} />;
  }
  if (rows.length === 0) {
    return <EmptyState title="No funnel events recorded yet" />;
  }

  return (
    <div className="space-y-2">
      {rows.map((r, i) => {
        const widthPct = (r.count / max) * 100;
        const prev = i > 0 ? rows[i - 1].count : r.count;
        const dropPct = prev > 0 ? Math.round(((prev - r.count) / prev) * 100) : 0;
        return (
          <div key={r.stage} className="flex items-center gap-3">
            <span className="text-sm font-medium text-gray-600 w-32 truncate shrink-0">{r.stage}</span>
            <div className="flex-1 bg-gray-100 h-8 rounded-lg overflow-hidden relative">
              <div
                className="h-full rounded-lg bg-gradient-to-r from-indigo-500 to-blue-500 flex items-center justify-end pr-2"
                style={{ width: `${Math.max(widthPct, 6)}%` }}
              >
                <span className="text-xs font-bold text-white tabular-nums">{r.count}</span>
              </div>
            </div>
            <span className="text-xs text-gray-400 w-12 text-right shrink-0">
              {i > 0 && dropPct > 0 ? `-${dropPct}%` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export type { ConvAiMetrics };
