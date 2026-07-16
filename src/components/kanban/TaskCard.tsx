/**
 * Kanban task-card persona UI (DEP-5 / F3.7 + F3.9; A-U5 adds the per-scope row).
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
 * `PersonaScopeChips` (A-U5, master spec v2 Section A.6; generalized to
 * per-PART governance by U115 §E6-1, closes G7) is the per-PAGE/per-PART
 * analog: one chip per `task.persona_bundle_scopes` row (a
 * `task_persona_bundle_scope` table row, migration 104 + U115's migration
 * 106) — a multi-page funnel build's opt-in/sales/thank-you pages, OR a
 * multi-part campaign's sales page + nurture emails + social posts, each
 * carrying its OWN governing blend + audience. Reuses the exact chip visuals +
 * gating pattern above verbatim (≥2 rows required, same colors, same overflow
 * "+N" affordance) so a scoped funnel and a decomposed multi-persona task read
 * as ONE consistent visual language on the board. U115 acceptance (c): the
 * SAME component renders on the board card AND (via `PersonaPlanPanel`,
 * TaskOverviewPanels.tsx) the task-detail modal — single source, no
 * divergence — so this is the ONE place the per-part row is ever assembled.
 *
 * The card itself (drag handlers, status, etc.) lives in `MissionQueue.tsx`; this
 * module is the ONE place the per-sub-task slot chips (and per-scope chips) are
 * rendered, so the board and any future card surface stay consistent.
 */
'use client';

import type { Task, TaskSubtaskPersona, TaskPersonaBundleScope } from '@/lib/types';

/** Title-case a persona id / slug for display ("bly-copywriters" → "Bly Copywriters").
 * Exported for reuse by the B-U6 / U20 persona-mismatch chip (MissionQueue.tsx),
 * which needs the same slug->label formatting for declared/used persona ids. */
export function humanize(slug: string): string {
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

/** A-U5 chip label: the page's role/slug (whichever is present), falling back
 * — U115 (E6-1) — to the part's declared role, then to the bare scope key so
 * a chip never renders empty. A per-PAGE row (funnel) always has page_role/
 * page_slug and never reaches the part_role fallback; a per-PART row
 * (U115, no page concept) has neither and falls through to part_role. */
function scopeChipLabel(row: TaskPersonaBundleScope): string {
  return (
    (row.page_role && row.page_role.trim()) ||
    (row.page_slug && row.page_slug.trim()) ||
    (row.part_role && row.part_role.trim()) ||
    row.scope
  );
}

export function PersonaScopeChips({
  task,
  max = 4,
}: {
  task: Pick<Task, 'persona_bundle_scopes'>;
  max?: number;
}) {
  const scopes = task.persona_bundle_scopes;
  // Only a genuine multi-page/scope blend (>=2 scoped bundles) warrants a
  // chip row — a single scoped bundle degrades to the card's existing single
  // persona chip, same threshold PersonaSlotChips uses for sub-task plans.
  if (!Array.isArray(scopes) || scopes.length < 2) return null;

  const ordered = [...scopes].sort((a, b) => a.scope.localeCompare(b.scope));
  const shown = ordered.slice(0, max);
  const overflow = ordered.length - shown.length;

  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1"
      data-testid="persona-scope-chips"
      aria-label="Per-page persona blend"
    >
      {shown.map((row) => {
        const label = scopeChipLabel(row);
        const persona = row.persona_id ? row.persona_name || humanize(row.persona_id) : null;
        // U115 (E6-1, closes G7) acceptance (c): the chip names its blend AND
        // its audience — never fabricated; absent on every pre-U115 row (no
        // audience_label column value), so a plain funnel/page chip renders
        // exactly as before.
        const audience = row.audience_label && row.audience_label.trim() ? row.audience_label.trim() : null;
        return (
          <span
            key={`${row.scope}-${row.persona_id ?? 'none'}`}
            className={
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ' +
              (persona
                ? 'bg-violet-500/15 text-violet-300 ring-1 ring-inset ring-violet-500/30'
                : 'bg-zinc-500/10 text-zinc-400 ring-1 ring-inset ring-zinc-500/20')
            }
            title={
              persona
                ? `${label}: ${persona}${audience ? ` for ${audience}` : ''}${row.scope_reason ? ` — ${row.scope_reason}` : ''}`
                : `${label}: no persona required`
            }
          >
            <span className="uppercase tracking-wide opacity-70">{label}</span>
            <span aria-hidden>→</span>
            <span>{persona ?? '—'}</span>
            {audience && (
              <span className="normal-case tracking-normal opacity-60">for {audience}</span>
            )}
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="text-[10px] text-zinc-400" title={`${overflow} more page${overflow === 1 ? '' : 's'}`}>
          +{overflow}
        </span>
      )}
    </div>
  );
}

export default PersonaSlotChips;
