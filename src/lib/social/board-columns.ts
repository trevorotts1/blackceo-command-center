/**
 * src/lib/social/board-columns.ts — F36 campaign-board column mapping.
 *
 * Extracted from the campaign page so the blocked→attention rule is testable
 * in the Node unit runner (the page is a client component; importing it in a
 * DB-backed test would pull framer-motion + jsdom deps).
 *
 * The W8 board mapped `blocked` onto the `review` column, which hid stuck
 * work behind work awaiting QC. F36: blocked jobs surface in a visible
 * "Attention" column; `review` is reserved for artifacts awaiting QC.
 */

export type KanbanColumn = 'new' | 'queued' | 'in_progress' | 'attention' | 'review' | 'done';

export type BoardTaskStatus =
  | 'inbox' | 'backlog' | 'planning' | 'assigned' | 'pending_dispatch'
  | 'in_progress' | 'testing' | 'review' | 'blocked' | 'done';

export const KANBAN_COLUMNS: { key: KanbanColumn; label: string; color: string }[] = [
  { key: 'new',         label: 'New',         color: 'bg-slate-100'  },
  { key: 'queued',      label: 'Queued',      color: 'bg-blue-50'    },
  { key: 'in_progress', label: 'In Progress', color: 'bg-amber-50'   },
  { key: 'attention',   label: 'Attention',   color: 'bg-red-50'     },
  { key: 'review',      label: 'Review',      color: 'bg-violet-50'  },
  { key: 'done',        label: 'Done',        color: 'bg-emerald-50' },
];

/**
 * status → column. blocked NEVER lands in review: it maps to 'attention' so
 * a stuck job is visibly "needs attention", not "awaiting QC" (F36 required
 * outcome).
 */
export const STATUS_TO_COLUMN: Partial<Record<BoardTaskStatus, KanbanColumn>> = {
  inbox: 'new', backlog: 'new', planning: 'queued', assigned: 'queued',
  pending_dispatch: 'queued', in_progress: 'in_progress', testing: 'in_progress',
  review: 'review', blocked: 'attention', done: 'done',
};

/** Resolve a card's column; unknown statuses open in New (previous behavior). */
export function columnForStatus(status: string): KanbanColumn {
  return STATUS_TO_COLUMN[status as BoardTaskStatus] ?? 'new';
}