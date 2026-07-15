'use client';

import { useState, useCallback, useRef } from 'react';
import { X, Save, Trash2, Activity, Package, Bot, ClipboardList, Plus } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { triggerAutoDispatch, shouldTriggerAutoDispatch } from '@/lib/auto-dispatch';
import { ActivityLog } from './ActivityLog';
import { DeliverablesList } from './DeliverablesList';
import { SessionsList } from './SessionsList';
import { PlanningTab } from './PlanningTab';
import { AgentModal } from './AgentModal';
import { MicDictateButton } from './MicDictateButton';
import { BLOCKED_REASONS, BLOCKED_AUDIENCES } from './kanban/BlockTaskModal';
// U12 — B11 Gate Panel. Rendered for anthology gate cards (isAnthologyTask).
import { GatePanel } from './anthology/GatePanel';
import { isAnthologyTask } from './anthology/anthology-card';
// U13 — B12 Assembly cockpit. Rendered only for the anthology's Assembly card;
// self-contained in its own component so it stays isolated from other TaskModal work.
import { AssemblyCockpit } from './anthology/AssemblyCockpit';
import { resolveAnthologyAssembly } from './anthology/assembly-cockpit-logic';
// D3 — audience-confirm panel (persona-blend / W7 --blend). Rendered only for
// a task that actually went through the blend (task.blend_directive present)
// so a plain non-content task never fires the extra gate-status fetch.
import { AudienceConfirmPanel } from './AudienceConfirmPanel';
// P2-02 — the task-detail panels that fill in and actually USE the modal's
// fields: who's working on this + why, the SOP link, the QC block transparency,
// and the planning metadata.
// U42 (C-11) adds PersonaPlanPanel — the modal's multi-persona plan +
// per-page/per-part scoped-blend rows, reusing the card face's own chip
// components (single source, no divergence).
import {
  WhoIsWorkingPanel,
  PersonaPlanPanel,
  TaskSopPanel,
  BlockedReasonPanel,
  PlanningMetaPanel,
  // U104 (E4-7) — single source for the "which board-producer engine, if
  // any" label, reused across the Planning/Activity/Deliverables/Sessions
  // tabs below instead of re-deriving it per tab.
  engineSourceLabel,
} from './TaskOverviewPanels';
// U105 (E4-8) — in-app "i" help icons next to this form's fields. Reads the
// typed copy map; presentation only, no change to any field's behavior.
import { FieldHelp } from './ui/FieldHelp';
import { TASK_FIELD_HELP } from '@/lib/task-field-help';
import type { Task, TaskPriority, TaskStatus } from '@/lib/types';

type TabType = 'overview' | 'planning' | 'activity' | 'deliverables' | 'sessions';

// The `blocked_reason` / `blocked_on_human` / `ask` columns (migration 071 —
// the human-only Blocked gate enforced by PATCH /api/tasks/[id]) exist on the
// tasks row and are returned by the API, but are not yet declared on the
// shared `Task` interface in src/lib/types.ts (out of scope for this file).
// This local type lets us read/write them without an `any` cast.
type BlockedFields = {
  blocked_reason?: string | null;
  blocked_on_human?: string | null;
  ask?: string | null;
};

interface TaskModalProps {
  task?: Task;
  onClose: () => void;
  workspaceId?: string;
  /**
   * Seeds the create form's status when opened from a column's "+" button
   * (MissionQueue passes the column's underlying status). Ignored when
   * editing an existing task, which always keeps its own status.
   */
  initialStatus?: TaskStatus;
}

export function TaskModal({ task, onClose, workspaceId, initialStatus }: TaskModalProps) {
  const { agents, addTask, updateTask, addEvent } = useMissionControl();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [usePlanningMode, setUsePlanningMode] = useState(false);
  // Track in-flight interim dictation text so we can replace it cleanly
  // when the final transcript arrives, without duplicating words.
  const titleInterimRef = useRef('');
  const descInterimRef = useRef('');
  // Auto-switch to planning tab if task has planning session
  const [activeTab, setActiveTab] = useState<TabType>(task?.planning_session_key ? 'planning' : 'overview');

  // Stable callback for when spec is locked - use window.location.reload() to refresh data
  const handleSpecLocked = useCallback(() => {
    window.location.reload();
  }, []);

  // Existing task's blocked-gate fields (see BlockedFields comment above).
  const taskBlocked = task as (Task & BlockedFields) | undefined;

  // U13 — resolve the anthology assembly card behind this task (null for any
  // non-assembly card). Drives whether the Assembly cockpit renders on overview.
  const anthologyAssembly = resolveAnthologyAssembly(task);

  // U104 (E4-7) — the board-producer engine label (e.g. "the Anthology
  // Engine", "a Skill 6 funnel build"), or null for an ordinary task. Single
  // computation, reused by the Planning/Activity/Deliverables/Sessions tabs
  // below so every honest empty-state copy in this modal agrees.
  const engineLabel = task ? engineSourceLabel(task) : null;

  const [form, setForm] = useState({
    title: task?.title || '',
    description: task?.description || '',
    priority: task?.priority || 'medium' as TaskPriority,
    // New-task creation seeds from `initialStatus` (set by MissionQueue's
    // per-column "+" button); editing always keeps the task's own status.
    status: task?.status || initialStatus || 'backlog' as TaskStatus,
    assigned_agent_id: task?.assigned_agent_id || '',
    due_date: task?.due_date || '',
    // Blocked-gate fields — only meaningful when status === 'blocked', but
    // kept in form state unconditionally so the inline fields are controlled
    // inputs from the first render.
    blocked_reason: taskBlocked?.blocked_reason || '',
    blocked_on_human: taskBlocked?.blocked_on_human || '',
    ask: taskBlocked?.ask || '',
  });

  // Triad gate error — populated when the backend refuses a backlog → start
  // transition because the task is missing description / SOP / persona.
  // Wired to a banner with inline remediation CTAs.
  const [triadError, setTriadError] = useState<{ missing: string[] } | null>(null);
  // Client-side mirror of the API's Blocked gate (PATCH /api/tasks/[id] 400s
  // "Blocked requires a human-only reason" without these) — validated before
  // the request goes out so the user gets inline feedback instead of a round
  // trip. `touchedBlocked` gates the message so it doesn't show before the
  // user has tried to submit once.
  const [touchedBlocked, setTouchedBlocked] = useState(false);
  const [suggestingPersona, setSuggestingPersona] = useState(false);
  const [suggestingSop, setSuggestingSop] = useState(false);
  // P2-03 — generic non-201/200 save-failure banner. Before this, ANY save
  // failure that wasn't the specific Triad-error shape (see triadError above)
  // fell through handleSubmit's `if (res.ok)` block silently: isSubmitting
  // reset to false in `finally`, the modal stayed open, and NOTHING told the
  // operator the save failed — this is the "New Task doesn't really work"
  // report (a 400 from a schema mismatch produced exactly this silent no-op).
  // Populated for every non-ok response the other handled branches don't
  // already cover; cleared on a fresh submit attempt and on close.
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Client-side mirror of the API's Blocked gate (see BlockedFields comment
    // above) — catches the missing-fields case before a round trip instead of
    // relying solely on the server's 400.
    if (form.status === 'blocked') {
      const missingBlocked = !form.blocked_reason || !form.blocked_on_human || !form.ask.trim();
      if (missingBlocked) {
        setTouchedBlocked(true);
        return;
      }
    }

    setIsSubmitting(true);
    setTriadError(null);
    setSubmitError(null);
    setTouchedBlocked(false);

    try {
      const url = task ? `/api/tasks/${task.id}` : '/api/tasks';
      const method = task ? 'PATCH' : 'POST';

      const payload: Record<string, unknown> = {
        ...form,
        // Planning mode doesn't change status - it just creates a planning session
        // New tasks always start in 'backlog'
        assigned_agent_id: form.assigned_agent_id || null,
        due_date: form.due_date || null,
        // P2-03: never send the literal string 'default' — no box seeds a
        // workspace row with id 'default' outside the standalone `npm run
        // db:seed` script, so this modal (opened from the cross-department
        // /tasks/all board, which passes no `workspaceId` prop, on a brand
        // new task) was stamping a PHANTOM workspace id on every create.
        // createTaskCore's lookup now nulls an unresolvable workspace_id
        // server-side (see src/lib/tasks.ts), but the client should not
        // manufacture an id it has no reason to believe exists in the first
        // place — omit the key entirely and let the server default it.
        workspace_id: workspaceId || task?.workspace_id || undefined,
      };
      // The blocked_reason/blocked_on_human/ask fields only mean anything on a
      // ->'blocked' transition (the API ignores them otherwise) — drop them
      // rather than send stale/empty values for every non-blocked save.
      if (form.status !== 'blocked') {
        delete payload.blocked_reason;
        delete payload.blocked_on_human;
        delete payload.ask;
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      // P2-03 — every non-ok response is now surfaced to the operator. The
      // Triad-incomplete shape gets its own dedicated banner (with
      // remediation CTAs, handled below); everything else — validation
      // failures, a 500, a 503 misconfiguration — falls through to the
      // generic submitError banner instead of failing silently.
      if (!res.ok) {
        let errBody: unknown = null;
        try {
          errBody = await res.json();
        } catch {
          // Non-JSON error body — leave errBody null, fall through to the
          // generic status-code message below.
        }
        const errObj = (errBody ?? {}) as {
          error?: string;
          message?: string;
          missing?: string[];
          details?: Array<{ path?: string[]; message?: string }>;
        };

        if (errObj.error === 'Triad incomplete' && Array.isArray(errObj.missing)) {
          setTriadError({ missing: errObj.missing });
          setIsSubmitting(false);
          return;
        }

        const detailText = Array.isArray(errObj.details)
          ? errObj.details
              .map((d) => `${(d.path ?? []).join('.')}: ${d.message ?? ''}`.trim())
              .filter(Boolean)
              .join('; ')
          : '';
        setSubmitError(
          [errObj.message, errObj.error, detailText].filter(Boolean).join(' — ') ||
            `Save failed (HTTP ${res.status}). Please try again or contact the operator.`,
        );
        setIsSubmitting(false);
        return;
      }

      if (res.ok) {
        const savedTask = await res.json();

        if (task) {
          updateTask(savedTask);

          // Check if auto-dispatch should be triggered and execute it
          if (shouldTriggerAutoDispatch(task.status, savedTask.status, savedTask.assigned_agent_id)) {
            const result = await triggerAutoDispatch({
              taskId: savedTask.id,
              taskTitle: savedTask.title,
              agentId: savedTask.assigned_agent_id,
              agentName: savedTask.assigned_agent?.name || 'Unknown Agent',
              workspaceId: savedTask.workspace_id
            });

            if (!result.success) {
              console.error('Auto-dispatch failed:', result.error);
            }
          }

          onClose();
        } else {
          addTask(savedTask);
          addEvent({
            id: crypto.randomUUID(),
            type: 'task_created',
            task_id: savedTask.id,
            message: `New task: ${savedTask.title}`,
            created_at: new Date().toISOString(),
          });

          // If planning mode is enabled, auto-generate questions and keep modal open
          if (usePlanningMode) {
            // Trigger question generation in background
            fetch(`/api/tasks/${savedTask.id}/planning`, { method: 'POST' })
              .then((res) => {
                if (res.ok) {
                  // Update our local task reference and switch to planning tab
                  setActiveTab('planning');
                } else {
                  return res.json().then((data) => {
                    console.error('Failed to start planning:', data.error);
                  });
                }
              })
              .catch((error) => {
                console.error('Failed to start planning:', error);
              });
          }
          onClose();
        }
      }
    } catch (error) {
      console.error('Failed to save task:', error);
      // P2-03 — a network-level failure (fetch threw: offline, DNS, CORS,
      // server unreachable) must also be visible, not just the console.
      setSubmitError('Could not reach the server. Check your connection and try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * B8 / AUD-46 — "Remove from board" SOFT-ARCHIVES; it never hard-deletes.
   *
   * This button used to issue a hard DELETE, which irreversibly destroyed the task
   * and its whole history (deliverables, QC results, events) on one click of a
   * browser confirm(). That is the accidental-purge vector B8 exists to close, and
   * the hard-delete route now REFUSES an un-archived row (409) anyway.
   *
   * Soft-archive does what the operator actually means by "delete this card": it
   * leaves the board (GET /api/tasks filters archived_at IS NULL) while the row
   * stays fully recoverable (?includeArchived=true, or POST the archive route's
   * DELETE to restore). A genuine irreversible purge is still available — it is
   * simply a deliberate, separately-audited second step, not a stray click.
   */
  const handleDelete = async () => {
    if (
      !task ||
      !confirm(
        `Remove "${task.title}" from the board?\n\n` +
          `It will be archived — hidden from the board, but preserved and recoverable.`,
      )
    )
      return;

    try {
      const res = await fetch(`/api/tasks/${task.id}/archive`, { method: 'POST' });
      if (res.ok) {
        useMissionControl.setState((state) => ({
          tasks: state.tasks.filter((t) => t.id !== task.id),
        }));
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        console.error('Failed to archive task:', data);
      }
    } catch (error) {
      console.error('Failed to archive task:', error);
    }
  };

  // Widened from the original 5 (backlog/in_progress/review/blocked/done) to
  // the full set of underlying statuses the board actually uses, including
  // the ones that get bucketed into synthetic columns (inbox/planning/
  // assigned -> To-Do, testing -> Review/QC — see MissionQueue's
  // BOARD_PRESETS comment). `pending_dispatch` is intentionally omitted: it's
  // a transient internal state set by the dispatcher, not something a human
  // should pick from a create/edit form.
  const statuses: TaskStatus[] = [
    'backlog',
    'inbox',
    'planning',
    'assigned',
    'in_progress',
    'review',
    'testing',
    'blocked',
    'done',
  ];
  const statusLabels: Record<TaskStatus, string> = {
    backlog: 'Backlog',
    inbox: 'Inbox (new)',
    planning: 'Planning',
    assigned: 'Assigned (queued)',
    pending_dispatch: 'Pending Dispatch',
    in_progress: 'In Progress',
    review: 'Review / QC',
    testing: 'Testing',
    blocked: 'Blocked',
    done: 'Done',
  };
  const priorities: TaskPriority[] = ['low', 'medium', 'high', 'critical'];

  /**
   * Auto-suggest a persona for the current task using the persona-selector-v2
   * scoring endpoint. On success the persona is attached server-side and we
   * clear the Triad error so the user can retry the transition.
   */
  const handleSuggestPersona = async () => {
    if (!task?.id) return;
    setSuggestingPersona(true);
    try {
      const res = await fetch('/api/persona-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: task.id, auto_assign: true }),
      });
      if (res.ok) {
        // Reload the task in the store so the persona pill re-renders.
        const fresh = await fetch(`/api/tasks/${task.id}`);
        if (fresh.ok) {
          const updated = await fresh.json();
          updateTask(updated);
        }
        setTriadError((prev) => {
          if (!prev) return prev;
          const remaining = prev.missing.filter((m) => m !== 'persona' && m !== 'persona_id');
          return remaining.length === 0 ? null : { missing: remaining };
        });
      } else {
        console.error('Persona auto-suggest failed:', await res.text());
      }
    } catch (err) {
      console.error('Persona auto-suggest failed:', err);
    } finally {
      setSuggestingPersona(false);
    }
  };

  /**
   * Auto-attach a suggested SOP via /api/sops/suggest. The suggest endpoint
   * returns a ranked list — we take the top hit and PATCH it onto the task.
   */
  const handleAttachSop = async () => {
    if (!task?.id) return;
    setSuggestingSop(true);
    try {
      const params = new URLSearchParams();
      if (task.department) params.set('department', task.department);
      if (form.title || task.title) params.set('task_title', form.title || task.title);
      if (form.description || task.description)
        params.set('task_description', form.description || task.description || '');

      const sugRes = await fetch(`/api/sops/suggest?${params.toString()}`);
      if (!sugRes.ok) {
        console.error('SOP suggest failed:', sugRes.status);
        return;
      }
      const body = await sugRes.json();
      const topSopId =
        Array.isArray(body?.suggestions) && body.suggestions[0]?.sop?.id;
      if (!topSopId) {
        // Nothing matched — fall back to the SOP library in a new tab so the
        // user can pick one manually.
        window.open('/sops/proposals', '_blank');
        return;
      }
      const patchRes = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sop_id: topSopId }),
      });
      if (patchRes.ok) {
        const updated = await patchRes.json();
        updateTask(updated);
        setTriadError((prev) => {
          if (!prev) return prev;
          const remaining = prev.missing.filter((m) => m !== 'sop' && m !== 'sop_id');
          return remaining.length === 0 ? null : { missing: remaining };
        });
      }
    } catch (err) {
      console.error('SOP attach failed:', err);
    } finally {
      setSuggestingSop(false);
    }
  };

  const tabs = [
    { id: 'overview' as TabType, label: 'Overview', icon: null },
    { id: 'planning' as TabType, label: 'Planning', icon: <ClipboardList className="w-4 h-4" /> },
    { id: 'activity' as TabType, label: 'Activity', icon: <Activity className="w-4 h-4" /> },
    { id: 'deliverables' as TabType, label: 'Deliverables', icon: <Package className="w-4 h-4" /> },
    { id: 'sessions' as TabType, label: 'Sessions', icon: <Bot className="w-4 h-4" /> },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-stretch sm:items-center justify-center z-50 p-0 sm:p-4">
      {/* P5-01 step 4 responsiveness: full-screen sheet on mobile (no rounded
          corners, full height), centered dialog on ≥sm. */}
      <div className="bg-white border-0 sm:border border-gray-200 rounded-none sm:rounded-xl w-full max-w-2xl h-full sm:h-auto max-h-full sm:max-h-[90vh] flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">
            {task ? task.title : 'Create New Task'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-gray-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs - only show for existing tasks */}
        {task && (
          <div className="flex border-b border-gray-200 flex-shrink-0 bg-gray-50">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'text-indigo-600 border-b-2 border-indigo-600 bg-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-4 bg-white">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <>
          {/* Anthology Gate Panel (SPEC B11 / U12) — the card detail IS the Gate
              Panel for an anthology CHAPTER / gate card: the current deliverable +
              EXACTLY the actions gate_engine.py status returns for the open gate
              (via U11). Rendered above the standard task form; non-anthology tasks
              skip it entirely. It sits OUTSIDE the form so its Approve/Hold/etc.
              buttons never submit the task edit form.

              DOUBLE-RENDER PRECEDENCE (U12/U13): the ASSEMBLY card must show ONLY
              the Assembly cockpit, never the Gate Panel. `anthologyAssembly` is
              non-null EXACTLY for the assembly card, so gating the Gate Panel on
              `!anthologyAssembly` makes the two surfaces mutually exclusive by
              construction — the SAME value drives both (cockpit renders iff
              `anthologyAssembly`, Gate Panel iff anthology card AND not assembly). */}
          {task && isAnthologyTask(task) && !anthologyAssembly && (
            <div className="mb-4">
              <GatePanel task={task} />
            </div>
          )}
          {/* D3 — Audience-confirm panel (persona-blend / W7 --blend). A content
              task carries a persisted `blend_directive` mirror column iff it
              went through --blend (D1); that cheap presence check gates the
              panel's mount so a plain task never fires the extra gate-status
              fetch. The panel itself GETs /api/tasks/[id]/audience and renders
              nothing unless the gate is actively HOLDing the task. Sits outside
              the form, same as GatePanel, so its Confirm button never submits
              the task-edit form. */}
          {task && task.blend_directive && (
            <AudienceConfirmPanel taskId={task.id} onConfirmed={() => window.location.reload()} />
          )}
          {/* P2-02 — task-detail panels for an existing task (skipped on the
              anthology Assembly card, whose overview is the cockpit only). They
              sit OUTSIDE the form so their buttons/links never submit the edit
              form. Each panel renders a designed empty-state when its data is
              absent — never a dead control, never a raw NULL. */}
          {task && !anthologyAssembly && (
            <div className="mb-4 space-y-3">
              <WhoIsWorkingPanel task={task} />
              {/* U42 (C-11) — multi-persona sub-task plan + per-page/per-part
                  scoped blend, mirroring the board card's PersonaSlotChips /
                  PersonaScopeChips (single source). Renders nothing for a
                  plain single-persona task (same >=2 rule the card uses). */}
              <PersonaPlanPanel task={task} />
              <TaskSopPanel task={task} onChangeSop={handleAttachSop} changing={suggestingSop} />
              <BlockedReasonPanel task={task} />
            </div>
          )}
            <form onSubmit={handleSubmit} className="space-y-4">
          {/* U13 — B12 Assembly cockpit: readiness → arm (typed name) → order →
              sign-off. Only for the anthology's Assembly card; its own component. */}
          {anthologyAssembly && (
            <AssemblyCockpit
              anthologyId={anthologyAssembly.anthologyId}
              anthologyName={anthologyAssembly.anthologyName}
            />
          )}
          {/* P2-03 — generic save-failure banner. Covers every non-ok response
              the Triad banner below doesn't already own: a Zod validation
              400 (e.g. a schema/payload mismatch), a 500, a 503
              misconfiguration, or a network failure. Previously these all
              failed SILENTLY — the modal just sat there with no feedback,
              which is the concrete shape of the operator's "create task
              doesn't really work" report. */}
          {submitError && (
            <div
              data-testid="task-save-error"
              role="alert"
              className="rounded-xl border border-red-300 bg-red-50 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-red-800">
                  <strong className="font-semibold">Couldn&apos;t save this task.</strong>{' '}
                  {submitError}
                </p>
                <button
                  type="button"
                  onClick={() => setSubmitError(null)}
                  className="shrink-0 rounded-lg border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-50"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {/* Triad Rule error banner — surfaces when /api/tasks PATCH refuses
              a backlog → start transition because the task is missing one or
              more of: description, SOP, persona. Each missing piece gets its
              own inline remediation CTA. */}
          {triadError && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-full bg-amber-100 p-1.5">
                  <ClipboardList className="h-4 w-4 text-amber-700" />
                </div>
                <div className="flex-1">
                  <h4 className="text-sm font-semibold text-amber-900">
                    Triad Rule, can&apos;t start this task yet
                  </h4>
                  <p className="mt-1 text-xs text-amber-800">
                    Every task needs a description, a SOP, and a persona before it can
                    leave Backlog. Missing:{' '}
                    <strong>{triadError.missing.join(', ')}</strong>.
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {(triadError.missing.includes('sop') ||
                      triadError.missing.includes('sop_id')) && (
                      <button
                        type="button"
                        onClick={handleAttachSop}
                        disabled={suggestingSop}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-amber-700 disabled:opacity-60"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {suggestingSop ? 'Finding SOP...' : 'Add an SOP'}
                      </button>
                    )}
                    {(triadError.missing.includes('persona') ||
                      triadError.missing.includes('persona_id')) && (
                      <button
                        type="button"
                        onClick={handleSuggestPersona}
                        disabled={suggestingPersona}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-60"
                      >
                        <Bot className="h-3.5 w-3.5" />
                        {suggestingPersona ? 'Suggesting...' : 'Auto-suggest persona'}
                      </button>
                    )}
                    {triadError.missing.includes('description') && (
                      <button
                        type="button"
                        onClick={() => {
                          // Focus the description textarea below.
                          const el = document.querySelector<HTMLTextAreaElement>(
                            'textarea[placeholder="Add details..."]'
                          );
                          el?.focus();
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-gray-700 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-gray-800"
                      >
                        Add description
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setTriadError(null)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Title */}
          <div>
            <div className="mb-1 flex items-center gap-1">
              <label className="block text-sm font-medium text-gray-700">Title</label>
              <FieldHelp label="Title" text={TASK_FIELD_HELP.title} testId="title" />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
                className="flex-1 bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                placeholder="What needs to be done?"
              />
              <MicDictateButton
                label="Dictate title"
                disabled={isSubmitting}
                onTranscript={(text, isFinal) => {
                  setForm((prev) => {
                    // Strip the previous interim chunk (if any) from the end of
                    // the current value, then append the new text.
                    const base = titleInterimRef.current
                      ? prev.title.endsWith(titleInterimRef.current)
                        ? prev.title.slice(0, prev.title.length - titleInterimRef.current.length)
                        : prev.title
                      : prev.title;
                    const separator = base && !base.endsWith(' ') ? ' ' : '';
                    const next = base + separator + text;
                    if (isFinal) {
                      titleInterimRef.current = '';
                    } else {
                      titleInterimRef.current = text;
                    }
                    return { ...prev, title: next };
                  });
                }}
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1">
                <label className="block text-sm font-medium text-gray-700">Description</label>
                <FieldHelp label="Description" text={TASK_FIELD_HELP.description} testId="description" />
              </div>
              <MicDictateButton
                label="Dictate description"
                disabled={isSubmitting}
                onTranscript={(text, isFinal) => {
                  setForm((prev) => {
                    const base = descInterimRef.current
                      ? prev.description.endsWith(descInterimRef.current)
                        ? prev.description.slice(0, prev.description.length - descInterimRef.current.length)
                        : prev.description
                      : prev.description;
                    const separator = base && !base.endsWith(' ') && !base.endsWith('\n') ? ' ' : '';
                    const next = base + separator + text;
                    if (isFinal) {
                      descInterimRef.current = '';
                    } else {
                      descInterimRef.current = text;
                    }
                    return { ...prev, description: next };
                  });
                }}
              />
            </div>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
              placeholder="Add details..."
            />
          </div>

          {/* Planning Mode Toggle - only for new tasks */}
          {!task && (
            <div className="p-3 bg-indigo-50 rounded-lg border border-indigo-200">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={usePlanningMode}
                  onChange={(e) => setUsePlanningMode(e.target.checked)}
                  className="w-4 h-4 mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                <div>
                  <span className="font-medium text-sm text-gray-900 flex items-center gap-2">
                    <ClipboardList className="w-4 h-4 text-indigo-600" />
                    Enable Planning Mode
                  </span>
                  <p className="text-xs text-gray-600 mt-1">
                    Best for complex projects that need detailed requirements. 
                    You&apos;ll answer a few questions to define scope, goals, and constraints 
                    before work begins. Skip this for quick, straightforward tasks.
                  </p>
                </div>
              </label>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            {/* Status */}
            <div>
              <div className="mb-1 flex items-center gap-1">
                <label className="block text-sm font-medium text-gray-700">Status</label>
                <FieldHelp label="Status" text={TASK_FIELD_HELP.status} testId="status" />
              </div>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as TaskStatus })}
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {statusLabels[s]}
                  </option>
                ))}
              </select>
            </div>

            {/* Priority */}
            <div>
              <div className="mb-1 flex items-center gap-1">
                <label className="block text-sm font-medium text-gray-700">Priority</label>
                <FieldHelp label="Priority" text={TASK_FIELD_HELP.priority} testId="priority" />
              </div>
              <select
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              >
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {p.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Blocked details — PATCH /api/tasks/[id] 400s "Blocked requires a
              human-only reason" without these 3 fields whenever status is set
              to 'blocked'. Shown inline the moment the status select above is
              set to Blocked so the requirement is visible before submit,
              instead of only surfacing as a server error. */}
          {form.status === 'blocked' && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3">
              <p className="text-xs font-semibold text-red-800 uppercase tracking-wide">
                Blocked details (required)
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 flex items-center gap-1">
                    <label className="block text-sm font-medium text-gray-700">Reason</label>
                    <FieldHelp label="Reason" text={TASK_FIELD_HELP.blockedReason} testId="blocked-reason" />
                  </div>
                  <select
                    value={form.blocked_reason}
                    onChange={(e) => setForm({ ...form, blocked_reason: e.target.value })}
                    className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  >
                    <option value="">Select a reason...</option>
                    {BLOCKED_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-1">
                    <label className="block text-sm font-medium text-gray-700">Who is needed?</label>
                    <FieldHelp label="Who is needed?" text={TASK_FIELD_HELP.blockedOnHuman} testId="blocked-on-human" />
                  </div>
                  <select
                    value={form.blocked_on_human}
                    onChange={(e) => setForm({ ...form, blocked_on_human: e.target.value })}
                    className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  >
                    <option value="">Select...</option>
                    {BLOCKED_AUDIENCES.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <div className="mb-1 flex items-center gap-1">
                  <label className="block text-sm font-medium text-gray-700">What do you need?</label>
                  <FieldHelp label="What do you need?" text={TASK_FIELD_HELP.blockedAsk} testId="blocked-ask" />
                </div>
                <textarea
                  value={form.ask}
                  onChange={(e) => setForm({ ...form, ask: e.target.value })}
                  rows={2}
                  required
                  placeholder="One line stating exactly what the human must do"
                  className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
                />
              </div>
              {touchedBlocked &&
                (!form.blocked_reason || !form.blocked_on_human || !form.ask.trim()) && (
                  <p className="text-xs text-red-700">
                    Reason, audience, and ask are all required to save a task as Blocked.
                  </p>
                )}
            </div>
          )}

          {/* Assigned Agent */}
          <div>
            <div className="mb-1 flex items-center gap-1">
              <label className="block text-sm font-medium text-gray-700">Assign to</label>
              <FieldHelp label="Assign to" text={TASK_FIELD_HELP.assignedAgent} testId="assigned-agent" />
            </div>
            <select
              value={form.assigned_agent_id}
              onChange={(e) => {
                if (e.target.value === '__add_new__') {
                  setShowAgentModal(true);
                } else {
                  setForm({ ...form, assigned_agent_id: e.target.value });
                }
              }}
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            >
              <option value="">Unassigned</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.avatar_emoji} {agent.name} - {agent.role}
                </option>
              ))}
              <option value="__add_new__" className="text-indigo-600">
                + Add new agent...
              </option>
            </select>
          </div>

          {/* Due Date */}
          <div>
            <div className="mb-1 flex items-center gap-1">
              <label className="block text-sm font-medium text-gray-700">Due Date</label>
              <FieldHelp label="Due Date" text={TASK_FIELD_HELP.dueDate} testId="due-date" />
            </div>
            <input
              type="datetime-local"
              value={form.due_date}
              onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
            </form>
            </>
          )}

          {/* Planning Tab */}
          {activeTab === 'planning' && task && (
            <div className="space-y-4">
              {/* P2-02 step 3 — structured planning metadata (dependencies,
                  parallel candidates, sprint, source) with honest empty-states,
                  above the AI planning-session flow. */}
              <PlanningMetaPanel task={task} />
              <PlanningTab
                taskId={task.id}
                onSpecLocked={handleSpecLocked}
                // U104 (E4-7) — scoped to anthology specifically: it is the
                // one card family verified to run its OWN competing stage
                // machine (gate_engine.py / mc_board.py), the exact race
                // Planning-off closes. Other recognized producer sources
                // (funnel/survey/web-development) keep Planning available.
                engineNotice={isAnthologyTask(task) ? engineLabel : null}
              />
            </div>
          )}

          {/* Activity Tab */}
          {activeTab === 'activity' && task && (
            <ActivityLog taskId={task.id} engineLabel={engineLabel} />
          )}

          {/* Deliverables Tab */}
          {activeTab === 'deliverables' && task && (
            <DeliverablesList taskId={task.id} engineLabel={engineLabel} />
          )}

          {/* Sessions Tab */}
          {activeTab === 'sessions' && task && (
            <SessionsList taskId={task.id} engineLabel={engineLabel} />
          )}
        </div>

        {/* Footer - only show on overview tab */}
        {activeTab === 'overview' && (
          <div className="flex items-center justify-between p-4 border-t border-gray-200 flex-shrink-0 bg-gray-50">
            <div className="flex gap-2">
              {task && (
                <>
                  {/* B8: archives (off the board, row preserved) — labelled honestly. */}
                  <button
                    type="button"
                    onClick={handleDelete}
                    title="Archive this task — hidden from the board, but preserved and recoverable"
                    className="flex items-center gap-2 px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg text-sm font-medium transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                    Archive
                  </button>
                </>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                <Save className="w-4 h-4" />
                {isSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Nested Agent Modal for inline agent creation */}
      {showAgentModal && (
        <AgentModal
          workspaceId={workspaceId}
          onClose={() => setShowAgentModal(false)}
          onAgentCreated={(agentId) => {
            // Auto-select the newly created agent
            setForm({ ...form, assigned_agent_id: agentId });
            setShowAgentModal(false);
          }}
        />
      )}
    </div>
  );
}
