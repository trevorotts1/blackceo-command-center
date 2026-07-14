'use client';

/**
 * TaskTimelineCard (U60 / JM-U63c)
 *
 * One Operations Rail card: the three-stop delegation timeline (Received →
 * Routed → Status) plus nested trust sub-steps (ack/progress/done),
 * joined by `task_id` — the exact J.0.7 threading fix this unit lands. Every
 * task the rail shows already carries the requester stamps (the history route
 * scopes to them server-side), so this component trusts its `task` +
 * `trustMessages` props completely; it does no additional filtering.
 */
import { Sparkles } from 'lucide-react';
import StatusPill from '@/components/ui/StatusPill';
import type { ChatMessage, SpawnedTask } from './types';

interface TaskTimelineCardProps {
  task: SpawnedTask;
  trustMessages: ChatMessage[];
  /** Best-effort provenance tag from the delegate response, when this card was
   *  just created client-side (falls back to a generic label once the next
   *  history refresh lands — the field is decorative, never load-bearing). */
  resolvedBy?: string;
  live?: boolean;
}

const TRUST_LABEL: Record<string, string> = {
  trust_ack: 'Received',
  trust_progress: 'In progress',
  trust_done: 'Done',
};

export default function TaskTimelineCard({ task, trustMessages, resolvedBy, live }: TaskTimelineCardProps) {
  const acked = trustMessages.some((m) => m.kind === 'trust_ack') || task.status !== 'backlog';
  const routed = !!task.department;

  return (
    <li
      id={`ops-rail-task-${task.id}`}
      data-testid="ops-rail-card"
      className="rounded-xl border border-bcc-border bg-bcc-white p-3 shadow-card"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-label font-semibold text-bcc-text line-clamp-2">{task.title}</span>
        <StatusPill status={task.status} live={live} />
      </div>

      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-bcc-text-muted rounded border border-bcc-border bg-bcc-border-light px-1.5 py-0.5">
          <Sparkles className="w-3 h-3" /> My AI CEO
        </span>
        {task.department && (
          <span className="text-[10px] font-medium text-brand-800 rounded border border-brand-200 bg-brand-50 px-1.5 py-0.5">
            {task.department}
          </span>
        )}
        {resolvedBy && (
          <span className="text-[10px] font-mono text-bcc-text-muted truncate max-w-[10rem]" title={resolvedBy}>
            {resolvedBy}
          </span>
        )}
      </div>

      {/* Three-stop delegation timeline. */}
      <ol className="mt-2.5 flex items-center gap-1.5" aria-label="Delegation timeline">
        {[
          { label: 'Received', done: true },
          { label: 'Routed', done: routed },
          { label: 'Status', done: acked },
        ].map((stop, i) => (
          <li key={stop.label} className="flex items-center gap-1.5 flex-1 min-w-0">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${stop.done ? 'bg-brand-500' : 'bg-bcc-border'}`}
              aria-hidden="true"
            />
            <span className={`text-[10px] truncate ${stop.done ? 'text-bcc-text-secondary' : 'text-bcc-text-muted'}`}>
              {stop.label}
            </span>
            {i < 2 && <span className="flex-1 h-px bg-bcc-border" aria-hidden="true" />}
          </li>
        ))}
      </ol>

      {/* Nested trust sub-steps, joined by task_id. */}
      {trustMessages.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-bcc-border-light pt-2">
          {trustMessages.map((m) => (
            <li key={m.id} className="flex items-start gap-1.5 text-caption text-bcc-text-secondary">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-brand-700 shrink-0 mt-0.5">
                {TRUST_LABEL[m.kind] ?? m.kind}
              </span>
              <span className="min-w-0 line-clamp-2">{m.content}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
