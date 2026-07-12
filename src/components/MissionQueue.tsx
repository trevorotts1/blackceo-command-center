'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, GripVertical, Eye, AlertTriangle, ChevronLeft, ChevronRight, Search, Inbox as InboxIcon } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { X } from 'lucide-react';
import { triggerAutoDispatch, shouldTriggerAutoDispatch } from '@/lib/auto-dispatch';
import type { Task, TaskStatus, BugTicket, BugStatus } from '@/lib/types';
import { TaskModal } from './TaskModal';
import { MarketingPublishButton } from './MarketingPublishButton';
import { PersonaSlotChips } from './kanban/TaskCard';
import { AnthologyCardFace } from './anthology/AnthologyCardFace';
import { isAnthologyTask } from './anthology/anthology-card';
import { BoardToastStack, type BoardToastMessage } from './kanban/BoardToast';
import { BlockTaskModal, type BlockTaskDetails } from './kanban/BlockTaskModal';
import { MoveTaskMenu } from './kanban/MoveTaskMenu';
import { formatDistanceToNow } from 'date-fns';
import {
  BACKLOG_COLUMN_LABEL,
  TODO_COLUMN_LABEL,
  BACKLOG_COLUMN_SUBTITLE,
  triadMissingFields,
  triadMissingPillText,
} from '@/lib/board-labels';

// Board kind: 'task' renders the existing 6-column task board (unchanged);
// 'bug' renders the 7-lane Bugs Department board backed by /api/bugs.
type BoardKind = 'task' | 'bug';

interface MissionQueueProps {
  workspaceId?: string;
  departmentFilter?: string | null;
  /** Selects the column preset. Defaults to 'task' so all existing workspaces are unaffected. */
  boardKind?: BoardKind;
}

// ── Lean Kanban board model (Trevor-approved) ──────────────────────────────
//
// Columns:  Backlog -> To-Do -> In Progress -> Review / QC -> Done
// Side-state: Blocked (not a stage in the flow -- a transient exception)
//
// Internal pipeline statuses that are NOT separate board columns:
//   assigned, pending_dispatch  -> bucket into To-Do (routed-not-started)
//   inbox, planning             -> bucket into To-Do (groomed-but-not-started)
//   testing                     -> bucket into Review/QC (dev/web-dev sub-state)
//
// Gate rules:
//   Backlog -> To-Do: Triad Rule (description + SOP + persona required)
//   Review / QC:     QC-agent auto-scorer fires on entry (src/lib/qc-scorer.ts)
//                    >=8.5 -> auto-approve to Done; <8.5 -> kick back to In Progress
//
// TaskStatus enum still has all underlying statuses (inbox, planning, assigned,
// pending_dispatch, testing) -- they're just not visible as separate board columns.
// This is intentionally a UI/column-mapping change, not a schema change.
//
// BOARD_PRESETS drives the config-driven column set (T3-001).
// The 'task' preset is the original 6 columns verbatim.
// The 'bug' preset renders the 7-lane Bugs Department board.
// All existing task board code paths are gated behind boardKind === 'task' (the default).

type ColumnDef = { id: string; label: string; gradient: string; tooltip?: string };

// ── Column tooltips (v4.44.0) ─────────────────────────────────────────────
// Each column carries a tooltip string (rendered via the `title` attribute on
// the column-header pill) that explains what the column means, what gate
// controls entry, and what the owner should do when work piles up there.
// P2-01 — labels renamed (client confusion was the naming, not the
// mechanism — both columns stay, each still encodes the real server-enforced
// Triad Rule gate). BACKLOG_COLUMN_SUBTITLE is the operator's verbatim
// hover copy for "Being Prepared"; see src/lib/board-labels.ts.
const COLUMN_TOOLTIPS: Record<string, string> = {
  backlog: BACKLOG_COLUMN_SUBTITLE,
  todo:
    'Groomed & ready — has description + SOP + persona and is assigned to an agent; queued but not started.',
  in_progress: 'An agent is actively working this.',
  review:      'Finished — being QC-checked before Done.',
  blocked:
    'Stuck, needs attention (a system fix or your input); should escalate to get fixed, not sit here.',
  done: 'Completed and approved.',
};

const BOARD_PRESETS: Record<BoardKind, ColumnDef[]> = {
  task: [
    { id: 'backlog',     label: BACKLOG_COLUMN_LABEL, gradient: 'column-pill-backlog',  tooltip: COLUMN_TOOLTIPS.backlog },
    { id: 'todo',        label: TODO_COLUMN_LABEL,    gradient: 'column-pill-backlog',  tooltip: COLUMN_TOOLTIPS.todo },
    { id: 'in_progress', label: 'In Progress', gradient: 'column-pill-progress', tooltip: COLUMN_TOOLTIPS.in_progress },
    { id: 'review',      label: 'Review / QC', gradient: 'column-pill-review',   tooltip: COLUMN_TOOLTIPS.review },
    { id: 'blocked',     label: 'Blocked',     gradient: 'column-pill-blocked',  tooltip: COLUMN_TOOLTIPS.blocked },
    { id: 'done',        label: 'Done',        gradient: 'column-pill-done',     tooltip: COLUMN_TOOLTIPS.done },
  ],
  bug: [
    { id: 'REPORTED',         label: 'Reported',         gradient: 'column-pill-backlog' },
    { id: 'TRIAGED',          label: 'Triaged',          gradient: 'column-pill-backlog' },
    { id: 'HEALING',          label: 'Healing',          gradient: 'column-pill-progress' },
    { id: 'VERIFYING',        label: 'Verifying',        gradient: 'column-pill-review' },
    { id: 'HEALED',           label: 'Healed',           gradient: 'column-pill-done' },
    { id: 'REGRESSION WATCH', label: 'Regression Watch', gradient: 'column-pill-review' },
    { id: 'CLOSED',           label: 'Closed',           gradient: 'column-pill-done' },
  ],
};

/**
 * Reverse of the six-column bucketing rule below (backlog / todo / review are
 * synthetic UI columns that aggregate several underlying TaskStatus values).
 * Single source of truth for "which column is this task visually in" — used
 * by both getTasksByStatus (filtering) and the per-card Move menu (so the
 * touch affordance's "current column" always agrees with where the card is
 * actually rendered).
 */
function taskToColumnId(task: Pick<Task, 'status'>): string {
  if (task.status === 'backlog') return 'backlog';
  if (['inbox', 'planning', 'assigned', 'pending_dispatch'].includes(task.status)) return 'todo';
  if (['review', 'testing'].includes(task.status)) return 'review';
  return task.status; // in_progress, blocked, done map 1:1
}

/**
 * The inverse mapping, used when a NEW task is seeded from a column's "+"
 * button or the touch Move menu: 'todo' is synthetic (no such TaskStatus), so
 * it becomes 'assigned' — the same target handleDrop uses for a card dropped
 * on To-Do (groomed/queued but not started).
 */
function columnIdToStatus(columnId: string): TaskStatus {
  if (columnId === 'todo') return 'assigned';
  return columnId as TaskStatus; // backlog/in_progress/review/blocked/done map 1:1
}

const departmentEmojis: Record<string, string> = {
  'ceo-com': '👔', 'ceo': '👔',
  'marketing': '📢',
  'sales': '💰',
  'billing': '💳',
  'customer-support': '🎧', 'support': '🎧',
  'legal-compliance': '⚖️', 'legal': '⚖️',
  'web-development': '🌐', 'webdev': '🌐',
  'app-development': '📱', 'appdev': '📱',
  'graphics': '🎨',
  'video-production': '🎬', 'video': '🎬',
  'audio-production': '🎙️', 'audio': '🎙️',
  'research': '🔬',
  'communications': '📣', 'comms': '📣',
  'crm': '📇',
  'openclaw-maintenance': '🦾', 'openclaw': '🦾',
  'social-media': '📱', 'social': '📱',
  'paid-advertisement': '🎯', 'paid-ads': '🎯',
  'general-task': '🗂️', 'general': '🗂️',
};

const departmentNames: Record<string, string> = {
  'ceo-com': 'CEO / COM',
  'marketing': 'Marketing',
  'sales': 'Sales',
  'billing': 'Billing',
  'customer-support': 'Customer Support',
  'legal-compliance': 'Legal / Compliance',
  'web-development': 'Web Development',
  'app-development': 'App Development',
  'graphics': 'Graphics',
  'video-production': 'Video Production',
  'audio-production': 'Audio Production',
  'research': 'Research',
  'communications': 'Communications',
  'crm': 'CRM',
  'openclaw-maintenance': 'OpenClaw Maintenance',
  'social-media': 'Social Media',
  'paid-advertisement': 'Paid Advertisement',
  'general-task': 'General Task',
};

export function MissionQueue({ workspaceId, departmentFilter, boardKind = 'task' }: MissionQueueProps) {
  const { tasks, updateTaskStatus, addEvent, selectedDepartment, setSelectedDepartment } = useMissionControl();
  const effectiveDepartment = departmentFilter !== undefined ? departmentFilter : selectedDepartment;
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [activeFilter, setActiveFilter] = useState('total');
  // Free-text board search (title/description substring, case-insensitive),
  // applied alongside whichever filter chip is active.
  const [searchQuery, setSearchQuery] = useState('');
  // Which column's "+" button opened the create modal — seeds the new task's
  // status instead of always defaulting to backlog. Null = the header-level
  // "New Task" button, which keeps the original backlog default.
  const [createColumnId, setCreateColumnId] = useState<string | null>(null);
  // Non-blocking error/info toasts for the board (drag-drop + Move-menu status
  // changes that the server rejected). See kanban/BoardToast.tsx.
  const [toasts, setToasts] = useState<BoardToastMessage[]>([]);
  // The task currently in the Blocked confirmation modal (dropped/moved onto
  // Blocked but not yet confirmed with the required human-only fields).
  const [blockingTask, setBlockingTask] = useState<Task | null>(null);

  const pushToast = useCallback((toast: Omit<BoardToastMessage, 'id'>) => {
    setToasts((prev) => [...prev, { id: crypto.randomUUID(), ...toast }]);
  }, []);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── Bug board state (boardKind === 'bug') ─────────────────────────────────
  // Bug tickets live in their own table (/api/bugs), not in tasks.
  // All bug board code paths are gated behind boardKind === 'bug'.
  const [bugTickets, setBugTickets] = useState<BugTicket[]>([]);
  const [bugLoading, setBugLoading] = useState(false);

  useEffect(() => {
    if (boardKind !== 'bug') return;
    setBugLoading(true);
    const qs = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : '?workspace_id=bugs';
    fetch(`/api/bugs${qs}`)
      .then((r) => r.json())
      .then((d) => setBugTickets(d.bugs ?? []))
      .catch((e) => console.error('[MissionQueue] bug fetch error', e))
      .finally(() => setBugLoading(false));
  }, [boardKind, workspaceId]);

  // ── Horizontal scroll affordance state ────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 8);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener('scroll', updateScrollState, { passive: true });
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateScrollState);
      ro.disconnect();
    };
  }, [updateScrollState]);

  const scrollBy = (delta: number) => {
    scrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  // Focus View (single department) scopes by the workspace_id FK — the ONLY
  // relationship the schema enforces (tasks.workspace_id REFERENCES
  // workspaces.id). The free-text tasks.department column is unreliable: the
  // task-create flow only ever writes workspace_id (TaskModal sends no
  // department), the router stamps display NAMES, and seed scripts use short
  // slugs — so a slug-vs-name-vs-null mismatch silently empties the board.
  // When a workspaceId is passed (Focus View) we scope by it. The cross-
  // department /tasks/all view passes no workspaceId, so the legacy
  // department-slug selection (sidebar pill) still drives that board.
  const scopeByWorkspace = !!workspaceId && effectiveDepartment !== null && effectiveDepartment !== undefined;

  const matchesScope = (task: Task): boolean => {
    if (scopeByWorkspace) return task.workspace_id === workspaceId;
    if (effectiveDepartment) return task.department === effectiveDepartment;
    return true;
  };

  // ── Bug board helpers (only used when boardKind === 'bug') ─────────────────
  const getBugsByStatus = (statusId: string): BugTicket[] => {
    return bugTickets.filter((bug) => bug.status === (statusId as BugStatus));
  };

  const getTasksByStatus = (statusId: string) => {
    const filteredByDept = tasks.filter(matchesScope);
    // Six-column mapping (backlog / todo / review are synthetic UI columns
    // that aggregate several underlying statuses) — see taskToColumnId.
    const byColumn = filteredByDept.filter((task) => taskToColumnId(task) === statusId);

    // Apply the board search box (title/description substring match).
    const searchLower = searchQuery.trim().toLowerCase();
    const bySearch = !searchLower
      ? byColumn
      : byColumn.filter(
          (task) =>
            task.title.toLowerCase().includes(searchLower) ||
            (task.description || '').toLowerCase().includes(searchLower)
        );

    // Apply the active filter chip (was previously decorative).
    return bySearch.filter((task) => {
      switch (activeFilter) {
        case 'due':
          // Only tasks with a due date in the next 7 days OR overdue
          if (!task.due_date) return false;
          const due = new Date(task.due_date).getTime();
          const sevenDays = 7 * 24 * 60 * 60 * 1000;
          return due - Date.now() <= sevenDays;
        case 'agent':
          // Only tasks that have an assigned agent
          return !!task.assigned_agent_id;
        case 'completed':
          return task.status === 'done';
        case 'total':
        default:
          return true;
      }
    });
  };

  const handleDragStart = (e: React.DragEvent, task: Task) => {
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  /**
   * Shared status-change path used by drag-drop, the touch "Move to..." menu
   * (item 9), and the Blocked-confirmation modal (item 2). Optimistically
   * updates the store, then PATCHes the server.
   *
   * Previously only `res.status === 400` was handled at all — any 403/422/500
   * left the optimistic move in place with no explanation, silently
   * desyncing the board from the server. Now ANY non-ok response reverts the
   * optimistic move and surfaces the server's {error, message/remediation/
   * hint} via a toast. The 'Triad incomplete' 400 keeps its existing special
   * case (open the edit modal instead of a toast).
   */
  const applyStatusChange = async (
    task: Task,
    targetStatus: TaskStatus,
    blockedDetails?: BlockTaskDetails,
  ) => {
    const previousStatus = task.status;
    updateTaskStatus(task.id, targetStatus);

    try {
      const body: Record<string, unknown> = { status: targetStatus };
      if (blockedDetails) {
        body.blocked_reason = blockedDetails.blocked_reason;
        body.blocked_on_human = blockedDetails.blocked_on_human;
        body.ask = blockedDetails.ask;
      }

      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        addEvent({
          id: crypto.randomUUID(),
          type: targetStatus === 'done' ? 'task_completed' : 'task_status_changed',
          task_id: task.id,
          message: `Task "${task.title}" moved to ${targetStatus}`,
          created_at: new Date().toISOString(),
        });

        if (shouldTriggerAutoDispatch(previousStatus, targetStatus, task.assigned_agent_id)) {
          const result = await triggerAutoDispatch({
            taskId: task.id,
            taskTitle: task.title,
            agentId: task.assigned_agent_id,
            agentName: task.assigned_agent?.name || 'Unknown Agent',
            workspaceId: task.workspace_id,
          });

          if (!result.success) {
            console.error('Auto-dispatch failed:', result.error);
          }
        }
        return;
      }

      // Non-ok response: revert the optimistic move and surface why.
      updateTaskStatus(task.id, previousStatus);

      let errBody: { error?: string; message?: string; missing?: string[]; remediation?: string; hint?: string } | null = null;
      try {
        errBody = await res.json();
      } catch {
        // non-JSON body — fall through to a generic toast below
      }

      if (res.status === 400 && errBody?.error === 'Triad incomplete' && Array.isArray(errBody.missing)) {
        // Unchanged behavior: open the task modal so the user can resolve the Triad inline.
        setEditingTask(task);
        return;
      }

      pushToast({
        tone: 'error',
        title: errBody?.error || `Couldn't move "${task.title}" (HTTP ${res.status})`,
        detail: errBody?.message || errBody?.remediation || errBody?.hint,
      });
    } catch (error) {
      console.error('Failed to update task status:', error);
      updateTaskStatus(task.id, previousStatus);
      pushToast({
        tone: 'error',
        title: `Couldn't move "${task.title}"`,
        detail: 'Network error — the board move was reverted. Please retry.',
      });
    }
  };

  /**
   * Column-level move entry point shared by drag-drop (handleDrop below) and
   * the touch-friendly Move menu on each card (item 9). The Blocked column is
   * never PATCHed directly here — PATCH /api/tasks/[id] requires 3 human-only
   * fields (blocked_reason, blocked_on_human, ask) that a drag/tap alone
   * can't supply, so this opens BlockTaskModal instead and only PATCHes on
   * confirm (item 2). This is also what makes Blocked reachable at all: before
   * this, dropping on Blocked always 400'd and silently snapped back.
   */
  const handleColumnMove = (task: Task, targetColumnId: string) => {
    const targetStatus = columnIdToStatus(targetColumnId);
    if (task.status === targetStatus) return;

    if (targetStatus === 'blocked') {
      // Move the card into Blocked immediately, matching the feedback of
      // every other column; the modal collects the required fields before
      // the PATCH actually persists it. Cancelling reverts this.
      updateTaskStatus(task.id, 'blocked');
      setBlockingTask(task); // snapshot still carries the ORIGINAL status for revert-on-cancel
      return;
    }

    void applyStatusChange(task, targetStatus);
  };

  const handleDrop = (e: React.DragEvent, targetColumnId: TaskStatus | 'todo') => {
    e.preventDefault();
    if (!draggedTask) return;
    const task = draggedTask;
    setDraggedTask(null);
    handleColumnMove(task, targetColumnId);
  };

  const cancelBlockedMove = () => {
    if (blockingTask) updateTaskStatus(blockingTask.id, blockingTask.status);
    setBlockingTask(null);
  };

  const confirmBlockedMove = (details: BlockTaskDetails) => {
    if (!blockingTask) return;
    const task = blockingTask;
    setBlockingTask(null);
    void applyStatusChange(task, 'blocked', details);
  };

  // Filter tasks by selected department/workspace for accurate counts.
  // Mirrors the scoping used by getTasksByStatus so the "By Total Tasks"
  // chip count matches what the columns actually render.
  const filteredTasks = tasks.filter(matchesScope);

  // Select the active column set from BOARD_PRESETS; default is 'task' (6 columns, unchanged).
  const COLUMNS = BOARD_PRESETS[boardKind];

  const filters = [
    {
      id: 'total',
      label: 'By Total Tasks',
      count: boardKind === 'bug' ? bugTickets.length : filteredTasks.length,
    },
    { id: 'due', label: 'Tasks Due' },
    { id: 'agent', label: 'By Agent' },
    { id: 'completed', label: 'Completed' },
  ];

  return (
    /* min-w-0 + min-h-0 (v4.66.0): flex items default to min-size:auto, which
       let this region silently grow past the dvh shell and clip the bottom
       card row with no scroll affordance — the reported bottom-cutoff bug. */
    <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-bcc-bg">
      {/* Header */}
      <header className="bg-white h-auto lg:h-20 px-4 lg:px-8 py-3 lg:py-0 flex flex-col lg:flex-row items-start lg:items-center justify-between border-b border-gray-100 shrink-0 gap-3 lg:gap-0">
        <div className="flex items-center gap-3 w-full lg:w-auto">
          <h1 className="text-xl lg:text-2xl font-bold text-gray-900 tracking-tight">
            {boardKind === 'bug' ? 'Bug Board' : 'Task Board'}
          </h1>
          {effectiveDepartment && (
            <>
              <span className="hidden sm:block text-gray-300 mx-1">|</span>
              <div className="flex items-center gap-2 bg-brand-50 text-brand-700 px-2 lg:px-3 py-1 lg:py-1.5 rounded-lg border border-brand-100 ml-auto lg:ml-0">
                <span className="text-base lg:text-lg leading-none">{departmentEmojis[effectiveDepartment] || '📋'}</span>
                <span className="font-semibold text-sm hidden sm:inline">{departmentNames[effectiveDepartment] || effectiveDepartment}</span>
                <button 
                  onClick={() => setSelectedDepartment(null)}
                  className="ml-1 p-0.5 rounded-md hover:bg-brand-100 text-brand-400 hover:text-brand-900 transition-colors"
                  title="Clear filter"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 lg:gap-3 w-full lg:w-auto justify-end">
          <button
            data-walkthrough="new-task"
            onClick={() => {
              // Header-level create has no column context — falls back to
              // TaskModal's own default (backlog).
              setCreateColumnId(null);
              setShowCreateModal(true);
            }}
            className="flex items-center gap-1.5 lg:gap-2 px-3 lg:px-5 py-2 lg:py-2.5 rounded-xl bg-brand-600 text-white font-semibold text-sm hover:bg-brand-700 transition-all shadow-md shadow-brand-200"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">New Task</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </header>

      {/* Filter Tabs */}
      <div data-walkthrough="filters" className="bg-white px-4 lg:px-8 py-3 lg:py-3.5 border-b border-gray-100 flex flex-col sm:flex-row items-start sm:items-center justify-between shrink-0 gap-3 sm:gap-0">
        <div className="flex items-center gap-1 lg:gap-2 overflow-x-auto w-full sm:w-auto pb-2 sm:pb-0 -mx-4 sm:mx-0 px-4 sm:px-0">
          {filters.map((filter) => (
            <button
              key={filter.id}
              onClick={() => setActiveFilter(filter.id)}
              className={`px-3 lg:px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 lg:gap-2 whitespace-nowrap ${
                activeFilter === filter.id
                  ? 'text-gray-900 bg-gray-100 font-semibold'
                  : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              <span className="hidden sm:inline">{filter.label}</span>
              <span className="sm:hidden">{filter.label.replace('By ', '').replace('Tasks ', '')}</span>
              {filter.count !== undefined && (
                <span className="px-1.5 lg:px-2 py-0.5 rounded-full bg-gray-200 text-badge font-bold text-gray-600">
                  {filter.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Board search — title/description substring, case-insensitive,
            applied alongside whichever filter chip is active (see
            getTasksByStatus). Bug board has no search per its own scope. */}
        {boardKind === 'task' && (
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" aria-hidden="true" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tasks..."
              aria-label="Search tasks by title or description"
              className="w-full bg-gray-50 border border-gray-200 rounded-lg pl-9 pr-8 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Kanban Columns — scroll wrapper with always-visible scrollbar + affordances */}
      {/*
        Layout:
          • outer div: flex-1, relative, overflow-hidden — anchors the fade/button overlays
          • scrollRef div: kanban-scroll class (always-visible scrollbar), actual scroll container
          • left/right fade + chevron overlays: shown when scroll is possible in that direction
        The fade overlays use pointer-events:none so they never block card drag+drop.
        Chevron buttons have pointer-events:all and sit centred within each fade zone.
      */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {/* Left scroll affordance — fade + chevron */}
        {canScrollLeft && (
          <div className="kanban-fade-left hidden lg:block" aria-hidden="true">
            <button
              className="kanban-scroll-btn"
              style={{ left: 16 }}
              onClick={() => scrollBy(-320)}
              tabIndex={0}
              aria-label="Scroll board left"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Right scroll affordance — fade + chevron */}
        {canScrollRight && (
          <div className="kanban-fade-right hidden lg:block" aria-hidden="true">
            <button
              className="kanban-scroll-btn"
              style={{ right: 16 }}
              onClick={() => scrollBy(320)}
              tabIndex={0}
              aria-label="Scroll board right"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Actual scrollable column strip */}
        <div
          ref={scrollRef}
          className="kanban-scroll overflow-x-auto overflow-y-auto lg:overflow-y-hidden overscroll-contain h-full p-4 lg:p-6"
          role="region"
          aria-label="Task board columns — scroll left or right to see more"
          tabIndex={0}
        >
          <div className="flex flex-col lg:flex-row gap-6 h-full min-w-0 lg:min-w-max pb-4">
            {boardKind === 'bug' ? (
              /* Bug Board -- 7 lifecycle lanes, read from /api/bugs */
              bugLoading ? (
                <div className="flex items-center justify-center w-full py-12 text-gray-400 text-sm">Loading bug tickets...</div>
              ) : (
                COLUMNS.map((column) => {
                  const columnBugs = getBugsByStatus(column.id);
                  return (
                    <div
                      key={column.id}
                      data-walkthrough={`bug-column-${column.id}`}
                      className="w-full lg:w-80 flex flex-col gap-4 lg:min-h-0"
                    >
                      {/* Column Header */}
                      <div className="flex items-center justify-between shrink-0">
                        <div className={`flex items-center gap-2 px-3 lg:px-4 py-2 lg:py-2.5 rounded-full text-white shadow-md ${column.gradient}`}>
                          <span className="text-badge font-bold bg-white/20 px-2 py-0.5 rounded-full">
                            {columnBugs.length}
                          </span>
                          <span className="text-sm font-bold">{column.label}</span>
                        </div>
                      </div>

                      {/* Bug Cards — lg:min-h-0 keeps the list constrained so
                          it scrolls internally instead of clipping; lg:pb-6
                          gives the last card breathing room at the shell edge. */}
                      <div className="flex flex-col gap-3 lg:gap-4 overflow-visible lg:overflow-y-auto lg:min-h-0 lg:pb-6 overscroll-contain pr-0 lg:pr-2">
                        {columnBugs.map((bug) => (
                          <BugCard key={bug.id} bug={bug} />
                        ))}
                      </div>
                    </div>
                  );
                })
              )
            ) : (
              /* Task Board -- original 6 columns, unchanged */
              COLUMNS.map((column) => {
                const columnTasks = getTasksByStatus(column.id);
                return (
                  <div
                    key={column.id}
                    data-walkthrough={`column-${column.id}`}
                    className="w-full lg:w-80 flex flex-col gap-4 lg:min-h-0"
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDrop(e, column.id as TaskStatus | 'todo')}
                  >
                    {/* Column Header */}
                    <div className="flex items-center justify-between shrink-0">
                      <div
                        className={`flex items-center gap-2 px-3 lg:px-4 py-2 lg:py-2.5 rounded-full text-white shadow-md cursor-help ${column.gradient}`}
                        title={column.tooltip}
                      >
                        <span className="text-badge font-bold bg-white/20 px-2 py-0.5 rounded-full">
                          {columnTasks.length}
                        </span>
                        <span className="text-sm font-bold">{column.label}</span>
                      </div>
                      {/* No "+" on the Blocked column: a task can only ENTER
                          Blocked by being moved there (it needs a reason +
                          audience + ask), never created there — the API rejects
                          create-as-blocked. Hiding the button keeps it from
                          being a control that always errors. */}
                      {column.id !== 'blocked' && (
                        <button
                          type="button"
                          onClick={() => {
                            // Seed the create form's status from this column
                            // instead of always defaulting to backlog.
                            setCreateColumnId(column.id);
                            setShowCreateModal(true);
                          }}
                          title={`Add a task to ${column.label}`}
                          aria-label={`Add a task to ${column.label}`}
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-white border border-gray-100 text-gray-400 hover:text-gray-900 hover:shadow-sm transition-all"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    {/* Tasks — lg:min-h-0 keeps the list constrained so it
                        scrolls internally instead of clipping; lg:pb-6 gives
                        the last card breathing room at the shell edge. */}
                    <div className="flex flex-col gap-3 lg:gap-4 overflow-visible lg:overflow-y-auto lg:min-h-0 lg:pb-6 overscroll-contain pr-0 lg:pr-2">
                      {columnTasks.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-10 text-gray-300 select-none">
                          <InboxIcon className="w-7 h-7 mb-2" aria-hidden="true" />
                          <span className="text-xs font-medium text-gray-400">No tasks</span>
                        </div>
                      ) : (
                        columnTasks.map((task) => (
                          <TaskCard
                            key={task.id}
                            task={task}
                            onDragStart={handleDragStart}
                            onClick={() => setEditingTask(task)}
                            isDragging={draggedTask?.id === task.id}
                            isCompleted={column.id === 'done'}
                            columns={COLUMNS}
                            currentColumnId={column.id}
                            onMove={handleColumnMove}
                          />
                        ))
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Modals */}
      {showCreateModal && (
        <TaskModal
          onClose={() => {
            setShowCreateModal(false);
            setCreateColumnId(null);
          }}
          workspaceId={workspaceId}
          initialStatus={createColumnId ? columnIdToStatus(createColumnId) : undefined}
        />
      )}
      {editingTask && (
        <TaskModal task={editingTask} onClose={() => setEditingTask(null)} workspaceId={workspaceId} />
      )}
      {/* Blocked-column confirmation (item 2) — collects the human-only
          fields PATCH /api/tasks/[id] requires before the move is persisted. */}
      {blockingTask && (
        <BlockTaskModal
          taskTitle={blockingTask.title}
          onConfirm={confirmBlockedMove}
          onCancel={cancelBlockedMove}
        />
      )}

      {/* Non-blocking error/info toasts (item 1) */}
      <BoardToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  onDragStart: (e: React.DragEvent, task: Task) => void;
  onClick: () => void;
  isDragging: boolean;
  isCompleted?: boolean;
  /** Board columns, for the touch-friendly Move menu (item 9). */
  columns: { id: string; label: string }[];
  /** Which column this card is currently rendered under (from the parent's render loop). */
  currentColumnId: string;
  /** Fires the shared status-change path (same one drag-drop uses, including the Blocked modal). */
  onMove: (task: Task, targetColumnId: string) => void;
}

function TaskCard({ task, onDragStart, onClick, isDragging, isCompleted, columns, currentColumnId, onMove }: TaskCardProps) {
  // Status pill styles
  const statusPillStyles: Record<string, string> = {
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

  const statusLabels: Record<string, string> = {
    // P2-01: matches the renamed "Being Prepared" column so a card's own
    // status pill never contradicts the column it's sitting in.
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

  // Priority pill styles (for new pill tags)
  const priorityPillStyles: Record<string, string> = {
    critical: 'bg-red-100 text-red-700',
    high: 'bg-amber-100 text-amber-700',
    medium: 'bg-gray-100 text-gray-600',
    low: 'bg-blue-50 text-blue-500',
  };

  const priorityLabels: Record<string, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  };

  // Department emoji mapping
  // Get avatar gradient based on agent or task id
  const getAvatarGradient = (index: number) => {
    const gradients = [
      'avatar-gradient-1',
      'avatar-gradient-2',
      'avatar-gradient-3',
      'avatar-gradient-4',
      'avatar-gradient-5',
    ];
    return gradients[index % gradients.length];
  };

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task)}
      onClick={onClick}
      className={`bg-white rounded-xl lg:rounded-2xl p-4 lg:p-5 card-shadow card-hover cursor-pointer border border-gray-50 w-full ${
        isDragging ? 'opacity-50 scale-95' : ''
      } ${isCompleted ? 'opacity-75' : ''}`}
    >
      {/* Title + touch-friendly Move affordance — native HTML5 drag-and-drop
          (used elsewhere on this card) doesn't fire on touch devices, so this
          real button + real menu is the only way to change columns on
          mobile/tablet (item 9). */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <h3 className={`text-base font-semibold text-gray-900 leading-snug flex-1 min-w-0 ${isCompleted ? 'line-through text-gray-400' : ''}`}>
          {task.title}
        </h3>
        <MoveTaskMenu
          columns={columns}
          currentColumnId={currentColumnId}
          taskTitle={task.title}
          onSelect={(columnId) => onMove(task, columnId)}
        />
      </div>

      {/* Anthology card face (SPEC B11 / U12) — participant name, book chip,
          9-segment S0→S9 bar, stage badge, "waiting on you" age. Renders ONLY
          for source==='anthology' cards; every other card is unaffected. */}
      {isAnthologyTask(task) && <AnthologyCardFace task={task} />}

      {/* Pill Tags Row */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {/* Status Pill */}
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          statusPillStyles[task.status] || 'bg-gray-100 text-gray-600'
        }`}>
          {statusLabels[task.status] || task.status}
        </span>

        {/* P2-01 step 2 — "why is this here?" affordance: on a Being-Prepared
            (backlog) card, shows WHICH triad element(s) are still missing.
            Client-safe presence mirror of the server's Triad Rule gate — see
            src/lib/board-labels.ts for why this can't just import checkTriad
            directly (that module reads the DB and this is a 'use client'
            component). */}
        {task.status === 'backlog' && (() => {
          const missingTriad = triadMissingFields(task);
          if (missingTriad.length === 0) return null;
          return (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200"
              title={`Why is this here? "${BACKLOG_COLUMN_LABEL}" means it's still missing part of the Triad (description + SOP + persona) it needs before it can start.`}
            >
              🧩 {triadMissingPillText(missingTriad)}
            </span>
          );
        })()}

        {/* Persona Pill — typed fields from Task interface (Hop 10) */}
        {task.persona_name && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-brand-700"
            title={task.persona_mode ? `${task.persona_name} (${task.persona_mode})` : task.persona_name ?? undefined}
          >
            🧠 {task.persona_name}
            {task.persona_mode && task.persona_mode !== 'leadership' && (
              <span className="text-[10px] opacity-70">· {task.persona_mode}</span>
            )}
          </span>
        )}

        {/* Awaiting-audience-confirm chip (P4-02 step 5) — the audience/topic
            duality was previously invisible on the card: a content task's voice
            blend silently held for confirmation and, unconfirmed, released under
            a neutral house voice after 30 min. This chip surfaces the pending
            confirm gate on the card face so the operator sees it without opening
            the modal. */}
        {task.blend_confirm_state === 'pending' && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-300"
            title="This content task's audience voice is awaiting your confirmation. Open the task to confirm the audience — unconfirmed, it releases under a neutral house voice after the deadline."
          >
            ⏳ Awaiting audience confirm
          </span>
        )}
        {task.blend_confirm_state === 'deadline_fallback' && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800 border border-orange-300"
            title="The audience was never confirmed in time — this task released under the neutral house voice. Confirm the audience to re-voice future work."
          >
            ⚠️ Released on house voice
          </span>
        )}

        {/* Model Pill (v4.0.1 P0-7) — shows the model resolved at dispatch.
            If model_id is null, renders a dimmed "no model" placeholder. */}
        <ModelPill task={task} />


        {/* Priority Pill */}
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          priorityPillStyles[task.priority] || 'bg-gray-100 text-gray-600'
        }`}>
          {priorityLabels[task.priority] || task.priority}
        </span>

        {/* Department Pill */}
        {task.department && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
            {departmentEmojis[task.department.toLowerCase()] || '🏢'} {departmentNames[task.department.toLowerCase()] || task.department}
          </span>
        )}

        {/* Agent Pill — guard against a null/empty agent name (belt-and-suspenders;
            the API now drops null-name agent objects at the source). */}
        {task.assigned_agent && (task.assigned_agent as { name: string | null }).name && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-700">
            {(task.assigned_agent as { name: string }).name}
          </span>
        )}

        {/* Skill 35 — Marketing-dept Publish button (no-op for non-marketing) */}
        <MarketingPublishButton task={task} />
      </div>

      {/* DEP-5 / F3.7 + F3.9 — per-sub-task persona slot chips (multi-persona tasks only) */}
      <PersonaSlotChips task={task} />

      {/* Sprint and Due Date */}
      {(task.sprint || task.due_date) && (
        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs text-gray-400">
          {task.sprint && (
            <span className="flex items-center gap-1">
              <span>🏃</span> {task.sprint}
            </span>
          )}
          {task.sprint && task.due_date && (
            <span className="text-gray-300">|</span>
          )}
          {task.due_date && (
            <span className="flex items-center gap-1">
              <span>📅</span> {new Date(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          )}
        </div>
      )}

      {/* Description */}
      {task.description && (
        <p className={`text-sm line-clamp-2 leading-relaxed mb-4 ${isCompleted ? 'text-gray-400' : 'text-gray-500'}`}>
          {task.description}
        </p>
      )}

      {/* Block transparency panel — only rendered when the task is blocked and has block fields */}
      {task.status === 'blocked' && (task.block_reason || task.block_needs || task.block_audience) && (
        <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs space-y-1">
          {/* Audience badge */}
          {task.block_audience && (
            <div className="flex items-center gap-1.5">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${
                  task.block_audience === 'SYSTEM'
                    ? 'bg-purple-100 text-purple-700'
                    : 'bg-red-100 text-red-700'
                }`}
              >
                {task.block_audience === 'SYSTEM' ? 'System fix needed' : 'Owner action needed'}
              </span>
            </div>
          )}
          {/* Block reason */}
          {task.block_reason && (
            <p className="text-red-700 font-medium leading-snug line-clamp-2">
              {task.block_reason}
            </p>
          )}
          {/* Gaps */}
          {task.block_gaps && (() => {
            try {
              const gaps: string[] = JSON.parse(task.block_gaps as string);
              if (gaps.length > 0) {
                return (
                  <ul className="list-disc list-inside text-red-600 space-y-0.5 pl-0.5">
                    {gaps.slice(0, 3).map((g, i) => (
                      <li key={i} className="line-clamp-1">{g}</li>
                    ))}
                  </ul>
                );
              }
            } catch { /* malformed JSON — skip */ }
            return null;
          })()}
          {/* Needs / resolution action */}
          {task.block_needs && (
            <p className="text-red-600 italic leading-snug line-clamp-2">
              Next step: {task.block_needs}
            </p>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-4 border-t border-gray-50">
        {/* Avatar Stack */}
        <div className="flex -space-x-2">
          {task.assigned_agent ? (
            <>
              <div className={`w-8 h-8 rounded-full border-2 border-white ${getAvatarGradient(0)} flex items-center justify-center text-white text-xs font-bold`}>
                {((task.assigned_agent as { name: string | null }).name ?? '?').charAt(0).toUpperCase()}
              </div>
            </>
          ) : ['backlog', 'inbox', 'planning'].includes(task.status) ? (
            <div className="w-8 h-8 rounded-full border-2 border-white bg-gray-200 flex items-center justify-center text-gray-400 text-xs font-bold">?</div>
          ) : (
            <div
              className="w-8 h-8 rounded-full border-2 border-white bg-orange-100 flex items-center justify-center text-orange-600"
              title="This task is in a working state but has no assigned agent"
              aria-label="Unassigned task warning"
            >
              <AlertTriangle className="w-4 h-4" />
            </div>
          )}
        </div>

        {/* Metrics */}
        <div className="flex items-center gap-3 text-gray-400 text-xs font-medium">
          <div className="flex items-center gap-1">
            <Eye className="w-3.5 h-3.5" />
            <span>{formatDistanceToNow(new Date(task.created_at), { addSuffix: false })}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Model pill (v4.0.1 P0-7).
 *
 * Sibling to the 🧠 persona pill. Renders 🤖 plus the model_registry label
 * (falls back to raw model_id, then to a dimmed "no model" placeholder when
 * the task has not been dispatched yet).
 *
 * IMPORTANT (B1): this shows the model the Command Center RESOLVED/INTENDED for
 * the dispatch, NOT a gateway-confirmed runtime model. The OpenClaw gateway
 * (verified against 2026.5.28) selects the agent's own configured model and
 * exposes no per-dispatch model override to the operator client, so the pill is
 * labeled "intended" to stay honest about what actually ran.
 *
 * Click navigates to /settings/intelligence?focus={model_id} so the operator
 * can drill into pricing/capabilities. Hover shows full name, provider, and
 * cost-per-million if those fields are joined in from model_registry.
 */
function ModelPill({ task }: { task: Task }) {
  const stop = (e: React.MouseEvent) => {
    // Don't let the click bubble up to the card click handler (which opens
    // the TaskModal). The pill is its own affordance.
    e.stopPropagation();
  };

  if (!task.model_id) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-400 italic"
        title="No intended model resolved yet. Dispatch the task to pin the model the Command Center will request."
      >
        🤖 no model
      </span>
    );
  }

  const label = task.model_label || task.model_id;

  const tooltipParts: string[] = [];
  tooltipParts.push('Intended model (CC-resolved; gateway runs the agent\'s configured model)');
  tooltipParts.push(task.model_label ? `${task.model_label} (${task.model_id})` : task.model_id);
  if (task.model_provider) tooltipParts.push(`Provider: ${task.model_provider}`);
  if (typeof task.model_input_cost_per_million === 'number') {
    tooltipParts.push(`Input: $${task.model_input_cost_per_million.toFixed(2)} / 1M tok`);
  }
  if (typeof task.model_output_cost_per_million === 'number') {
    tooltipParts.push(`Output: $${task.model_output_cost_per_million.toFixed(2)} / 1M tok`);
  }
  const tooltip = tooltipParts.join('\n');

  return (
    <a
      href={`/settings/intelligence?focus=${encodeURIComponent(task.model_id)}`}
      onClick={stop}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-violet-50 text-violet-700 hover:bg-violet-100 transition-colors no-underline"
      title={tooltip}
    >
      🤖 {label}
    </a>
  );
}

// ---------------------------------------------------------------------------
// BugCard -- minimal read-only card for Bug Board lanes (T3-001)
// ---------------------------------------------------------------------------

interface BugCardProps {
  bug: BugTicket;
}

function BugCard({ bug }: BugCardProps) {
  const severityPillStyles: Record<string, string> = {
    'P0 run-dead':             'bg-red-100 text-red-700',
    'P1 degraded':             'bg-amber-100 text-amber-700',
    'P2 cosmetic or latent':   'bg-yellow-50 text-yellow-700',
    'P3 improvement':          'bg-blue-50 text-blue-600',
  };

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-3 lg:p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start gap-2 mb-2">
        <span className="text-xs font-mono text-gray-400 shrink-0">{bug.id}</span>
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${severityPillStyles[bug.severity] ?? 'bg-gray-100 text-gray-600'}`}
        >
          {bug.severity}
        </span>
      </div>
      <p className="text-sm font-medium text-gray-800 leading-snug mb-2 line-clamp-3">{bug.symptom}</p>
      <div className="flex flex-wrap gap-1.5 text-xs text-gray-500">
        <span className="bg-gray-50 px-2 py-0.5 rounded-md">{bug.reporter_department}</span>
        {bug.client_slug && (
          <span className="bg-gray-50 px-2 py-0.5 rounded-md">{bug.client_slug}</span>
        )}
      </div>
      {bug.recurrence_count > 0 && (
        <div className="mt-2 text-xs text-amber-600 font-medium">
          Recurrence #{bug.recurrence_count}
        </div>
      )}
    </div>
  );
}
