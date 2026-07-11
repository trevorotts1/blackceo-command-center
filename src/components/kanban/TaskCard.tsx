/**
 * Kanban task-card persona UI (DEP-5 / F3.7 + F3.9).
 *
 * `PersonaSlotChips` renders one chip per sub-task on a DECOMPOSED (multi-persona)
 * task — the `task.subtask_personas` plan rows written by `decompose-task.py` and
 * surfaced through the tasks GET route + the persona-plan SSE broadcast. A single-
 * persona task carries no plan rows, so this renders nothing (the card keeps its
 * existing single `🧠 <persona>` chip untouched).
 *
 * Each chip shows the declared SLOT name (F3.9) when present, otherwise the
 * inferred task category, plus the persona that filled it. A mechanical / empty
 * sub-task (no persona) renders a muted "—" chip so the plan stays legible.
 *
 * The card itself (drag handlers, status, etc.) lives in `MissionQueue.tsx`; this
 * module is the ONE place the per-sub-task slot chips are rendered, so the board
 * and any future card surface stay consistent.
 */
'use client';

import type { Task, TaskSubtaskPersona } from '@/lib/types';

/** Title-case a persona id / slug for display ("bly-copywriters" → "Bly Copywriters"). */
function humanize(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function chipLabel(row: TaskSubtaskPersona): string {
  return (row.slot && row.slot.trim()) || (row.task_category && row.task_category.trim()) || `part ${row.seq}`;
}

export function PersonaSlotChips({
  task,
  max = 4,
}: {
  task: Pick<Task, 'subtask_personas'>;
  max?: number;
}) {
  const plan = task.subtask_personas;
  // Only a genuine multi-persona plan (≥2 sub-tasks) warrants slot chips.
  if (!Array.isArray(plan) || plan.length < 2) return null;

  const ordered = [...plan].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const shown = ordered.slice(0, max);
  const overflow = ordered.length - shown.length;

  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1"
      data-testid="persona-slot-chips"
      aria-label="Persona plan"
    >
      {shown.map((row) => {
        const label = chipLabel(row);
        const persona = row.persona_id ? row.persona_name || humanize(row.persona_id) : null;
        return (
          <span
            key={`${row.seq}-${row.persona_id ?? 'none'}`}
            className={
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ' +
              (persona
                ? 'bg-violet-500/15 text-violet-300 ring-1 ring-inset ring-violet-500/30'
                : 'bg-zinc-500/10 text-zinc-400 ring-1 ring-inset ring-zinc-500/20')
            }
            title={
              persona
                ? `${label}: ${persona}${row.subtask_text ? ` — ${row.subtask_text}` : ''}`
                : `${label}: no persona required`
            }
          >
            <span className="uppercase tracking-wide opacity-70">{label}</span>
            <span aria-hidden>→</span>
            <span>{persona ?? '—'}</span>
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="text-[10px] text-zinc-400" title={`${overflow} more sub-task${overflow === 1 ? '' : 's'}`}>
          +{overflow}
        </span>
      )}
    </div>
  );
}

export default PersonaSlotChips;
