'use client';

/**
 * Rescue Rangers dashboard: shared empty, loading, and error states.
 *
 * Composed from the existing Command Center conventions and deliberately
 * mirroring `src/components/podcast/states.tsx`: dashed-border empty block,
 * animate-pulse skeletons, red-50 error block with a Retry text button.
 *
 * A MISSING STORE FILE RENDERS THE EMPTY STATE, NEVER AN ERROR. Batch C may
 * still be deploying the durable store when this page ships, and every client
 * box in the fleet will never have one at all — neither case is a fault.
 */

import { LifeBuoy } from 'lucide-react';

export const NO_STORE_COPY =
  'No rescue ticket data on this box yet. The durable ticket store has not been ' +
  'created here — tickets will appear as soon as the rescue receiver records its first one.';

export function EmptyState({ message, title }: { message?: string; title?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-6 py-12 flex flex-col items-center text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50">
        <LifeBuoy className="h-6 w-6 text-brand-600" aria-hidden="true" />
      </span>
      {title ? <p className="mt-4 text-card-title text-gray-900">{title}</p> : null}
      <p className="mt-2 text-body text-gray-600 max-w-md">{message ?? NO_STORE_COPY}</p>
    </div>
  );
}

export function LoadingState({ rows = 4, kpis = 4 }: { rows?: number; kpis?: number }) {
  return (
    <div aria-hidden="true">
      {kpis > 0 && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-6">
          {Array.from({ length: kpis }).map((_, i) => (
            <div key={i} className="h-28 bg-gray-100 rounded-2xl animate-pulse" />
          ))}
        </div>
      )}
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-16 bg-gray-100 rounded-2xl animate-pulse" />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-5 text-sm text-red-700 flex items-center justify-between gap-4">
      <span>Something went wrong loading the rescue view.</span>
      <button
        onClick={onRetry}
        className="text-sm font-medium text-red-700 underline underline-offset-2 hover:text-red-800"
      >
        Retry
      </button>
    </div>
  );
}
