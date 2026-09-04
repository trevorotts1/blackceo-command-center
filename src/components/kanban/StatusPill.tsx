'use client';

/**
 * StatusPill — FIX 51a (W18b-B1) — extracted from MissionQueue.tsx.
 *
 * The board card's status pill (style map + P2-01 label map) is the ONE shared
 * visual for every card face: the flat TaskCard in MissionQueue.tsx and the
 * presentation parent card (PresentationParentCard.tsx, FIX 51b) both render it
 * so a card's pill never contradicts the column it sits in.
 *
 * Extraction only — classes, labels, and fallbacks are byte-identical to the
 * originals so no card face changes appearance.
 */

import { BACKLOG_COLUMN_LABEL } from '@/lib/board-labels';

// P2-01: `backlog` maps to the renamed "Being Prepared" column label (imported
// from src/lib/board-labels.ts) so a card's own status pill never contradicts
// the column it's sitting in.
const STATUS_PILL_STYLES: Record<string, string> = {
  backlog: 'bg-gray-100 text-gray-600',
  inbox: 'bg-gray-100 text-gray-600',
  planning: 'bg-gray-100 text-gray-600',
  assigned: 'bg-gray-100 text-gray-600',
  pending_dispatch: 'bg-gray-100 text-gray-600',
  in_progress: 'bg-blue-100 text-blue-700',
  review: 'bg-amber-100 text-amber-700',
  testing: 'bg-amber-100 text-amber-700',
  blocked: 'bg-red-100 text-red-700',
  done: 'bg-emerald-100 text-emerald-700',
};

const STATUS_LABELS: Record<string, string> = {
  backlog: BACKLOG_COLUMN_LABEL,
  inbox: 'New',
  planning: 'Planning',
  assigned: 'Queued',
  pending_dispatch: 'Pending',
  in_progress: 'In Progress',
  review: 'Review',
  testing: 'Testing',
  blocked: 'Blocked',
  done: 'Done',
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      data-testid="card-face-status-pill"
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        STATUS_PILL_STYLES[status] || 'bg-gray-100 text-gray-600'
      }`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );
}

export default StatusPill;
