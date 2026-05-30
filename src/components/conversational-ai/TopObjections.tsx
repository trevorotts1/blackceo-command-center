'use client';

import { useMemo } from 'react';
import { EmptyState } from './EmptyState';
import type { ConvAiMetrics } from './types';

export function TopObjections({
  metric,
}: {
  metric?: ConvAiMetrics['topObjections'];
}) {
  const rows = useMemo(() => metric?.data ?? [], [metric]);
  const max = useMemo(() => Math.max(1, ...rows.map((r) => r.count)), [rows]);

  if (!metric?.available) {
    return (
      <EmptyState
        title="Objections not tracked yet"
        hint="The most common objections surface here once conversations are tagged."
      />
    );
  }
  if (rows.length === 0) {
    return <EmptyState title="No objections recorded yet" />;
  }

  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.objection}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-gray-700 truncate pr-3">{r.objection}</span>
            <span className="text-sm font-bold text-gray-900 tabular-nums">{r.count}</span>
          </div>
          <div
            className="w-full bg-gray-100 h-2 rounded-full overflow-hidden"
            role="img"
            aria-label={`${r.objection}: ${r.count} occurrences`}
          >
            <div
              className="h-full rounded-full bg-amber-500"
              style={{ width: `${(r.count / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
