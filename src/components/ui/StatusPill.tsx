'use client';

/**
 * StatusPill (U60 / JM-U63a shared primitive)
 *
 * The animated task-status chip used on TaskTimelineCard and the transcript's
 * live-dot. Semantic colors only (`semantic-*` / `bcc-*` tokens) — never a raw
 * hex or an indigo/purple/fuchsia utility.
 */
const STATUS_STYLES: Record<string, string> = {
  done: 'bg-semantic-successLight text-emerald-700 border-emerald-200',
  completed: 'bg-semantic-successLight text-emerald-700 border-emerald-200',
  in_progress: 'bg-semantic-infoLight text-blue-700 border-blue-200',
  'in-progress': 'bg-semantic-infoLight text-blue-700 border-blue-200',
  blocked: 'bg-semantic-warningLight text-amber-700 border-amber-200',
  backlog: 'bg-bcc-border-light text-bcc-text-secondary border-bcc-border',
};

function styleFor(status: string): string {
  return STATUS_STYLES[status.toLowerCase()] ?? 'bg-bcc-border-light text-bcc-text-secondary border-bcc-border';
}

interface StatusPillProps {
  status: string;
  /** Pulses the leading dot — reserve for a status that is actively live-updating. */
  live?: boolean;
}

export default function StatusPill({ status, live }: StatusPillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded border px-1.5 py-0.5 ${styleFor(status)}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${live ? 'animate-pulse' : ''}`} />
      {status.replace(/_/g, ' ')}
    </span>
  );
}
