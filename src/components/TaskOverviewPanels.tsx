'use client';

/**
 * P2-02 — TASK-DETAIL WINDOW panels.
 *
 * The task modal's tabs/fields were defined but never populated or shown. These
 * panels FILL IN and ACTUALLY USE the rich fields the `Task` interface already
 * carries but the form never surfaced: which persona is working on a task AND
 * WHY, the voice/topic/audience blend, the SOP, the planning metadata, and the
 * honest "why is this blocked / what do you need to decide" transparency.
 *
 * Every panel renders a DESIGNED empty-state when its data is absent — never a
 * dead control and never a raw NULL (P2-02 step 6).
 */

import { useEffect, useState } from 'react';
import { Bot, FileText, GitBranch, AlertTriangle, ChevronDown, Users } from 'lucide-react';
import type { Task } from '@/lib/types';
// U42 (C-11) — reuse the EXACT card-face chip components for the modal's
// multi-persona plan + per-page/per-part scoped-blend rows. Single source: the
// modal must never re-derive or restate what the board card already renders,
// only surface the SAME rows in the task-detail window (C+I.0 point 10 /
// spec L1176-1179).
import { PersonaSlotChips, PersonaScopeChips } from './kanban/TaskCard';

// A slug like "russell-brunson" → "Russell Brunson" for display. Presentation
// only — the authoritative name is persona_name when the selector resolved one.
function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function formatScore(score?: number | null): string | null {
  if (typeof score !== 'number' || score <= 0) return null;
  // Scores are 0..1 fits; a >1 value is already a percentage-ish number.
  const pct = score <= 1 ? Math.round(score * 100) : Math.round(score);
  return `${pct}% match`;
}

/**
 * U42 (C-11) sub-item 2 — "honest engine-card persona surface". Recognized
 * board-producer sources (INGEST-10 `RECOGNIZED_BOARD_SOURCES`,
 * `app/api/tasks/[id]/status/route.ts:177`): Skill 6 (funnel/survey/
 * web-development) and the Anthology Engine (anthology). Producer-ingested
 * cards are NOT routed through the CC selector the way an organic task is
 * (C+I.0 point 13 / D-C3 grounding: producer cards move themselves, no CC
 * dispatch routing fires from this card family), so the generic "one is
 * selected automatically when the task leaves Backlog" empty copy is not true
 * for them — this UI-only distinction picks an honest producer-specific empty
 * copy instead, read-only from the already-immutable `tasks.source` column
 * (falls back to the legacy `Source: <value>` description marker for a
 * pre-migration row, same fallback order `resolveBoardSource` uses).
 */
const RECOGNIZED_ENGINE_SOURCES: Record<string, string> = {
  funnel: 'a Skill 6 funnel build',
  survey: 'a Skill 6 survey build',
  'web-development': 'a Skill 6 web-development build',
  anthology: 'the Anthology Engine',
};

const LEGACY_ENGINE_SOURCE_MARKER = /^Source:\s*(funnel|survey|web-development|anthology)\s*$/m;

// U104 (E4-7) — exported so the OTHER engine-mirrored-honesty surfaces (the
// GatePanel-adjacent Planning/Activity/Deliverables/Sessions tabs in
// TaskModal) resolve the SAME producer label this panel already proved out in
// U42, instead of re-deriving the source→label mapping a second time.
export function engineSourceLabel(task: Pick<Task, 'source' | 'description'>): string | null {
  const stamped = typeof task.source === 'string' ? task.source.trim().toLowerCase() : '';
  if (stamped && RECOGNIZED_ENGINE_SOURCES[stamped]) return RECOGNIZED_ENGINE_SOURCES[stamped];
  if (!stamped && typeof task.description === 'string') {
    const m = task.description.match(LEGACY_ENGINE_SOURCE_MARKER);
    if (m) return RECOGNIZED_ENGINE_SOURCES[m[1]] ?? null;
  }
  return null;
}

/**
 * "Who's Working On This" — task persona (name + mode + score) with the stored
 * one-sentence WHY, plus voice/topic/audience chips when the task went through a
 * persona blend. `blend_directive` shows on expand.
 */
export function WhoIsWorkingPanel({ task }: { task: Task }) {
  const hasPersona = Boolean(task.persona_id);
  const hasBlend = Boolean(task.voice_persona_id || task.topic_persona_id || task.audience_label);
  // U42 (C-11) sub-item 2 — only consulted for the empty-state COPY below; a
  // producer card that DOES carry a persona/blend (B-U7 producer-pinned
  // bundle, or any future producer metadata) always takes the populated
  // branch above unchanged — this never suppresses a real value.
  const engineSource = !hasPersona && !hasBlend ? engineSourceLabel(task) : null;

  const personaName =
    task.persona_name && task.persona_name !== 'N/A'
      ? task.persona_name
      : task.persona_id
        ? humanizeSlug(task.persona_id)
        : null;

  const scoreLabel = formatScore(task.persona_score);

  const voiceLabel =
    task.voice_persona_id
      ? task.voice_persona_id === task.persona_id && personaName
        ? personaName
        : humanizeSlug(task.voice_persona_id)
      : null;
  const topicLabel = task.topic_persona_id ? humanizeSlug(task.topic_persona_id) : null;

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="rounded-full bg-indigo-100 p-1.5">
          <Bot className="h-4 w-4 text-indigo-600" />
        </div>
        <h4 className="text-sm font-semibold text-gray-900">Who&apos;s Working On This</h4>
      </div>

      {hasPersona ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-gray-900">{personaName}</span>
            {task.persona_mode && (
              <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 border border-indigo-200">
                {task.persona_mode}
              </span>
            )}
            {scoreLabel && (
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 border border-gray-200">
                {scoreLabel}
              </span>
            )}
          </div>
          {/* WHY — the stored one-sentence reason (persona_reason). Honest
              empty-state when a pin predates the reason column. */}
          {task.persona_reason ? (
            <p className="text-xs text-gray-600">
              <span className="font-medium text-gray-500">Why: </span>
              {task.persona_reason}
            </p>
          ) : (
            <p className="text-xs italic text-gray-400">
              No selection reason on record for this persona pick.
            </p>
          )}
        </div>
      ) : engineSource ? (
        <p className="text-sm italic text-gray-400" data-testid="engine-card-empty-persona">
          Captured via {engineSource} — this card family does not carry a Command Center
          persona pin unless the build reported one. No persona/voice metadata was included
          with this build.
        </p>
      ) : (
        <p className="text-sm italic text-gray-400">
          No persona assigned yet — one is selected automatically when the task leaves Backlog.
        </p>
      )}

      {/* Voice / Topic / Audience blend chips — only when the task carries the
          blend mirror columns (a content task that went through --blend). */}
      {hasBlend && (
        <div className="mt-3 border-t border-gray-200 pt-3">
          <div className="flex flex-wrap gap-2">
            {voiceLabel && (
              <span className="inline-flex items-center gap-1 rounded-md bg-purple-50 px-2 py-1 text-[11px] font-medium text-purple-700 border border-purple-200">
                VOICE: {voiceLabel}
              </span>
            )}
            {topicLabel && (
              <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 border border-blue-200">
                TOPIC: {topicLabel}
              </span>
            )}
            {task.audience_label && (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 border border-emerald-200">
                AUDIENCE: {task.audience_label}
              </span>
            )}
          </div>
          {task.blend_directive && (
            <details className="group mt-2">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-gray-700">
                <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                Blend directive
              </summary>
              <p className="mt-1 rounded-md bg-white border border-gray-200 p-2 text-[11px] leading-relaxed text-gray-600">
                {task.blend_directive}
              </p>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * U42 (C-11) — "Task-detail card FULLY populated — personas included" (master
 * spec v2 §C+I.2, unit C-11, master id U42).
 *
 * Closes the verified gap at C+I.0 point 10: the board card already renders
 * two families of multi-persona chip rows — `PersonaSlotChips` (the
 * decomposed sub-task plan, `subtask_personas`, DEP-5/F3.7+F3.9) and
 * `PersonaScopeChips` (the per-page/per-part scoped blend, `persona_bundle_
 * scopes`, A-U5 §A.6, generalized to per-part governance by U115 §E6-1) — but
 * the task-detail modal rendered NEITHER (targeted grep confirmed NOT-FOUND
 * in `TaskModal.tsx` + `TaskOverviewPanels.tsx`). This panel surfaces BOTH,
 * reusing the exact card-face components so the modal and the card can never
 * diverge (single source, no re-derivation).
 *
 * Sub-item 4 (U115 per-part governance) reuses this SAME `persona_bundle_
 * scopes` table and `PersonaScopeChips` component — U115 persists per-part
 * rows keyed `(task_id, part_id)` into the identical `task_persona_bundle_
 * scope` table A-U5 already writes for per-PAGE funnel blends (master spec
 * L2465: "reuses the U5 scoped-bundle table + chip pattern — never a new
 * bundle store"). Until U115 lands, no producer writes a part-scoped row, so
 * this block simply has nothing to show — never invented, never a stub
 * control. DISPLAY side only; ships correctly for today's per-page data and
 * requires zero further change when U115's per-part rows start arriving.
 *
 * Each block independently honors the card face's own >=2-row chip threshold
 * (`PersonaSlotChips`/`PersonaScopeChips` already return null below that), so
 * a single-persona / single-scope task renders NO plan block at all — never a
 * dead "no plan" placeholder for the common case.
 */
export function PersonaPlanPanel({
  task,
}: {
  task: Pick<Task, 'subtask_personas' | 'persona_bundle_scopes'>;
}) {
  const planCount = Array.isArray(task.subtask_personas) ? task.subtask_personas.length : 0;
  const scopeCount = Array.isArray(task.persona_bundle_scopes) ? task.persona_bundle_scopes.length : 0;
  const hasPlan = planCount >= 2;
  const hasScopes = scopeCount >= 2;

  // Nothing to show: mirrors the card face's own >=2 rule exactly, so the
  // panel never renders an empty shell for a plain single-persona task.
  if (!hasPlan && !hasScopes) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4" data-testid="persona-plan-panel">
      <div className="mb-3 flex items-center gap-2">
        <div className="rounded-full bg-violet-100 p-1.5">
          <Users className="h-4 w-4 text-violet-600" />
        </div>
        <h4 className="text-sm font-semibold text-gray-900">Persona Plan</h4>
      </div>

      {hasPlan && (
        <div className={hasScopes ? 'mb-3' : undefined}>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Sub-task plan
          </p>
          <PersonaSlotChips task={task} />
        </div>
      )}

      {hasScopes && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Per-page / per-part blend
          </p>
          <PersonaScopeChips task={task} />
        </div>
      )}
    </div>
  );
}

/**
 * The SOP surfaced as a named link with a "change" affordance that reuses the
 * caller's existing Add-an-SOP flow (never a second one). Empty-state when no
 * SOP is attached.
 */
export function TaskSopPanel({
  task,
  onChangeSop,
  changing,
}: {
  task: Task;
  onChangeSop: () => void;
  changing?: boolean;
}) {
  const [sopTitle, setSopTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!task.sop_id) {
      setSopTitle(null);
      return;
    }
    setLoading(true);
    fetch(`/api/sops/${encodeURIComponent(task.sop_id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        // /api/sops/[id] returns the SOP row (or { sop }) — tolerate both shapes.
        const sop = data?.sop ?? data;
        setSopTitle(sop?.title || sop?.name || null);
      })
      .catch(() => {
        if (!cancelled) setSopTitle(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.sop_id]);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="rounded-full bg-amber-100 p-1.5">
            <FileText className="h-4 w-4 text-amber-700" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">SOP</p>
            {task.sop_id ? (
              <a
                href={`/sops/${encodeURIComponent(task.sop_id)}`}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-sm font-medium text-indigo-600 hover:underline"
                title={sopTitle || task.sop_id}
              >
                {loading ? 'Loading SOP…' : sopTitle || humanizeSlug(task.sop_id)}
              </a>
            ) : (
              <p className="text-sm italic text-gray-400">No SOP attached</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onChangeSop}
          disabled={changing}
          className="flex-shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
        >
          {changing ? 'Finding…' : task.sop_id ? 'Change' : 'Add an SOP'}
        </button>
      </div>
    </div>
  );
}

/**
 * The QC block-transparency panel (migration 073 block_reason / block_needs /
 * block_audience). Read-only — it explains WHY the scorer blocked the task and
 * what is needed, phrased as "NEEDS YOUR DECISION" for an OWNER-audience block.
 * Distinct from the editable Blocked-gate form fields.
 */
export function BlockedReasonPanel({ task }: { task: Task }) {
  if (task.status !== 'blocked') return null;

  const isOwner = task.block_audience === 'OWNER';
  const heading = isOwner ? 'NEEDS YOUR DECISION' : 'Blocked — action needed';

  // block_gaps is a JSON-encoded string[] when present.
  let gaps: string[] = [];
  if (task.block_gaps) {
    try {
      const parsed = JSON.parse(task.block_gaps);
      if (Array.isArray(parsed)) gaps = parsed.filter((g) => typeof g === 'string');
    } catch {
      gaps = [];
    }
  }

  const hasAny = Boolean(task.block_reason || task.block_needs || gaps.length > 0);

  return (
    <div
      className={`rounded-xl border p-4 ${
        isOwner ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50'
      }`}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className={`h-4 w-4 ${isOwner ? 'text-red-600' : 'text-amber-600'}`} />
        <h4 className={`text-sm font-semibold ${isOwner ? 'text-red-900' : 'text-amber-900'}`}>
          {heading}
        </h4>
      </div>

      {hasAny ? (
        <div className="mt-2 space-y-2">
          {task.block_reason && (
            <p className={`text-xs ${isOwner ? 'text-red-800' : 'text-amber-800'}`}>
              <span className="font-semibold">Reason: </span>
              {task.block_reason}
            </p>
          )}
          {gaps.length > 0 && (
            <div className={`text-xs ${isOwner ? 'text-red-800' : 'text-amber-800'}`}>
              <span className="font-semibold">What&apos;s missing:</span>
              <ul className="mt-1 list-disc list-inside">
                {gaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          )}
          {task.block_needs && (
            <p className={`text-xs font-medium ${isOwner ? 'text-red-900' : 'text-amber-900'}`}>
              <span className="font-semibold">Next step: </span>
              {task.block_needs}
            </p>
          )}
        </div>
      ) : (
        <p className={`mt-2 text-xs italic ${isOwner ? 'text-red-700' : 'text-amber-700'}`}>
          This task is blocked but no machine-readable reason was recorded. Open the requester
          thread or activity trail for context.
        </p>
      )}
    </div>
  );
}

/**
 * Planning metadata — dependencies, parallel_candidates, sprint, source. Each
 * renders an honest empty-state ("No dependencies recorded") rather than a blank
 * pane (P2-02 step 3).
 */
export function PlanningMetaPanel({ task }: { task: Task }) {
  const deps = Array.isArray(task.dependencies) ? task.dependencies.filter(Boolean) : [];
  const parallels = Array.isArray(task.parallel_candidates)
    ? task.parallel_candidates.filter(Boolean)
    : [];

  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <div className="mt-1 text-sm text-gray-700">{children}</div>
    </div>
  );

  const emptyState = (msg: string) => <span className="text-sm italic text-gray-400">{msg}</span>;

  const chips = (items: string[]) => (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it, i) => (
        <span
          key={i}
          className="inline-flex items-center rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 border border-gray-200"
        >
          {it}
        </span>
      ))}
    </div>
  );

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-1 flex items-center gap-2">
        <div className="rounded-full bg-gray-100 p-1.5">
          <GitBranch className="h-4 w-4 text-gray-600" />
        </div>
        <h4 className="text-sm font-semibold text-gray-900">Planning</h4>
      </div>
      <div className="divide-y divide-gray-100">
        <Row label="Dependencies">
          {deps.length > 0 ? chips(deps) : emptyState('No dependencies recorded')}
        </Row>
        <Row label="Parallel candidates">
          {parallels.length > 0 ? chips(parallels) : emptyState('No parallel candidates recorded')}
        </Row>
        <Row label="Sprint">{task.sprint ? task.sprint : emptyState('Not assigned to a sprint')}</Row>
        <Row label="Source">{task.source ? task.source : emptyState('No source recorded')}</Row>
      </div>
    </div>
  );
}
