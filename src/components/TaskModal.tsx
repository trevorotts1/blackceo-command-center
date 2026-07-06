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
        workspace_id: workspaceId || task?.workspace_id || 'default',
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

      if (!res.ok && res.status === 400) {
        try {
          const errBody = await res.json();
          if (errBody?.error === 'Triad incomplete' && Array.isArray(errBody.missing)) {
            setTriadError({ missing: errBody.missing });
            setIsSubmitting(false);
            return;
          }
        } catch {
          // not a Triad error — fall through to generic handling
        }
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
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!task || !confirm(`Delete "${task.title}"?`)) return;

    try {
      const res = await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
      if (res.ok) {
        useMissionControl.setState((state) => ({
          tasks: state.tasks.filter((t) => t.id !== task.id),
        }));
        onClose();
      }
    } catch (error) {
      console.error('Failed to delete task:', error);
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white border border-gray-200 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl">
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
            <form onSubmit={handleSubmit} className="space-y-4">
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
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
              <label className="block text-sm font-medium text-gray-700">Description</label>
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reason</label>
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Who is needed?</label>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">What do you need?</label>
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Assign to</label>
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
            <input
              type="datetime-local"
              value={form.due_date}
              onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
            </form>
          )}

          {/* Planning Tab */}
          {activeTab === 'planning' && task && (
            <PlanningTab
              taskId={task.id}
              onSpecLocked={handleSpecLocked}
            />
          )}

          {/* Activity Tab */}
          {activeTab === 'activity' && task && (
            <ActivityLog taskId={task.id} />
          )}

          {/* Deliverables Tab */}
          {activeTab === 'deliverables' && task && (
            <DeliverablesList taskId={task.id} />
          )}

          {/* Sessions Tab */}
          {activeTab === 'sessions' && task && (
            <SessionsList taskId={task.id} />
          )}
        </div>

        {/* Footer - only show on overview tab */}
        {activeTab === 'overview' && (
          <div className="flex items-center justify-between p-4 border-t border-gray-200 flex-shrink-0 bg-gray-50">
            <div className="flex gap-2">
              {task && (
                <>
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="flex items-center gap-2 px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg text-sm font-medium transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
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
