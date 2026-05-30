'use client';

import { Inbox } from 'lucide-react';

/**
 * Universal empty-state for a metric whose data source has not landed yet.
 *
 * Accessibility: this is never color-only. It pairs an icon + an explicit
 * text label so the "no data yet" state is conveyed without relying on hue.
 * `role="status"` announces it to assistive tech without being assertive.
 */
export function EmptyState({
  title = 'No data yet',
  hint,
  minHeight = 160,
}: {
  title?: string;
  hint?: string;
  minHeight?: number;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center text-center px-4"
      style={{ minHeight }}
    >
      <Inbox className="w-8 h-8 text-gray-400 mb-3" aria-hidden="true" />
      <p className="text-base font-semibold text-gray-600">{title}</p>
      {hint && <p className="text-sm text-gray-500 mt-1 max-w-xs">{hint}</p>}
    </div>
  );
}
