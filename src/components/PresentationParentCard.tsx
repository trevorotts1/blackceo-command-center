/**
 * PresentationParentCard — WI-15b (D1 Option B — NESTED subtasks)
 *
 * Renders a parent card for a presentation deck run on the CC board, with
 * NESTED child cards for each of the 7 phase labels underneath. Replaces the
 * flat single-card rendering for the presentations department.
 *
 * Contract:
 *   - The parent card shows the deck run title, status, aggregate X-of-N
 *     progress, and the 7-label stepper inline.
 *   - Each child card is a compact row showing its phase label, status dot,
 *     and a click-through to its own modal.
 *   - When data is loading, shows a skeleton. When children are absent (no
 *     child tasks created yet), shows a designed empty-state naming the actual
 *     mechanism: a child card appears once a phase task is posted to
 *     /api/tasks/ingest with this run's id as parent_task_id (WI-15b write
 *     path — see src/app/api/tasks/ingest/route.ts).
 *   - The component is self-fetching (fetches /api/presentations/children
 *     on mount) but also accepts pre-fetched initialData from the board.
 */

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

/**
 * PRES-021 — trailing-edge debounce for SSE/task-triggered child refreshes.
 * Matches PhaseStepper's coalescing so a burst of worker events collapses to
 * one children fetch per card instead of one request per event.
 */
const PRES21_PARENT_DEBOUNCE_MS = 400;
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CheckCircle2,
  CheckSquare,
  PlayCircle,
  AlertCircle,
  Clock,
  Square,
} from 'lucide-react';
import PhaseStepper from '@/components/PhaseStepper';
import { PHASE_LABELS } from '@/lib/presentation-phases';
import type { PhaseStepStatus } from '@/lib/presentation-phases';
import { useMissionControl } from '@/lib/store';
// FIX 51a/51b (master Part 8) — shared card-face pieces extracted from
// MissionQueue.tsx; the presentation parent card renders the SAME status
// pill and block-transparency panel as every flat card on the board.
import { StatusPill } from './kanban/StatusPill';
import { BlockedPanel } from './kanban/BlockedPanel';
import { MoveTaskMenu } from './kanban/MoveTaskMenu';
import { taskToColumnId } from '@/lib/board-projection';
import type { Task, TaskStatus } from '@/lib/types';

/**
 * FIX 51b — the shape BlockedPanel reads off a task. ParentData carries the
 * same fields (block_reason/block_gaps/block_needs/block_audience +
 * dispatch_attempts), so a parent row satisfies this structural subset
 * without pretending to be a full Task.
 */
type TaskLike = Pick<
  Task,
  'status' | 'block_reason' | 'block_gaps' | 'block_needs' | 'block_audience' | 'dispatch_attempts'
>;

/**
 * FIX 51b — narrowed face row. Task.block_reason is `string | undefined`
 * (never null) while the children-route payload can carry null, so the
 * canonicalizer maps nulls to undefined to satisfy the TaskLike shape.
 */
function toFaceTask(
  status: string,
  blockFields: Pick<ParentData, 'block_reason' | 'block_gaps' | 'block_needs' | 'block_audience' | 'dispatch_attempts'> | undefined,
): TaskLike {
  return {
    status: status as TaskStatus,
    block_reason: blockFields?.block_reason ?? undefined,
    block_gaps: blockFields?.block_gaps ?? undefined,
    block_needs: blockFields?.block_needs ?? undefined,
    block_audience: blockFields?.block_audience ?? undefined,
    dispatch_attempts: blockFields?.dispatch_attempts ?? undefined,
  };
}

// ── Types ────────────────────────────────────────────────────────────────

interface ChildTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  phases: Array<{ label: string; status: PhaseStepStatus }>;
  unmapped: string[];
}

interface ParentData {
  id: string;
  title: string;
  status: string;
  priority: string;
  department: string;
  process_certificate_sha?: string | unknown;
  created_at: string;
  // FIX 51b (master Part 8) — block-transparency fields so the shared
  // BlockedPanel/StatusPill card face (kanban/BlockedPanel.tsx,
  // kanban/StatusPill.tsx) renders real block state on the parent card,
  // not just for flat TaskCards. Served by /api/presentations/children.
  block_reason?: string | null;
  block_gaps?: string | null;
  block_needs?: string | null;
  block_audience?: 'OWNER' | 'SYSTEM' | null;
  dispatch_attempts?: number | null;
}

interface AggregateData {
  total: number;
  done: number;
  in_progress: number;
  not_started: number;
  current_phase: string;
}

interface ChildrenResponse {
  parent: ParentData;
  children: ChildTask[];
  aggregate: AggregateData;
}

export interface PresentationParentCardProps {
  taskId: string;
  /** Pre-fetched data from the board's initial load. When absent the
   *  component fetches on mount. */
  initialData?: ChildrenResponse | null;
  /** Called when the operator clicks on a child card to open its detail modal. */
  onOpenChild?: (childTaskId: string) => void;
  /** Called when the operator clicks on the parent to open its modal. */
  onOpenParent?: () => void;
  /** Whether this parent card is currently being dragged. */
  isDragging?: boolean;
  /** Whether the parent run is complete (status === 'done'). */
  isCompleted?: boolean;
  // ── FIX 51b (master Part 8) — card face: drag + move + bulk checkbox ────
  /** Native drag-start handler — MissionQueue's handleDragStart so dropping
   *  the parent on a column runs the SAME shared status-change path as flat
   *  TaskCards (including the Blocked confirmation modal). Optional so the
   *  standalone children preview keeps working without the board. */
  onDragStart?: (e: React.DragEvent) => void;
  /** Shared column-move entry point (same one drag-drop and the Move menu
   *  use for flat cards) — receives this parent's task. */
  onMove?: (taskId: string, targetColumnId: string) => void;
  /** Board columns, for the touch-friendly MoveTaskMenu. */
  columns?: { id: string; label: string; maxWip?: number }[];
  /** Which board column this parent card is currently rendered under. */
  currentColumnId?: string;
  /** Current task count per column id, for WIP limit enforcement in the Move menu. */
  columnTaskCounts?: Record<string, number>;
  /** The parent's full Task row from the board's task store (the tasks list
   *  SELECT is `t.*`, so it already carries block_reason / block_gaps /
   *  block_needs / block_audience / dispatch_attempts). The card face prefers
   *  it over the narrower /api/presentations/children parent payload so the
   *  shared BlockedPanel shows real block state. Optional — the standalone
   *  children preview renders without it. */
  parentTask?: Task | null;
}

// ── Status helpers ───────────────────────────────────────────────────────

function childStatusIcon(status: string) {
  switch (status) {
    case 'done':
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />;
    case 'in_progress':
      return <PlayCircle className="w-3.5 h-3.5 text-blue-500" />;
    case 'blocked':
      return <AlertCircle className="w-3.5 h-3.5 text-red-500" />;
    case 'review':
      return <Clock className="w-3.5 h-3.5 text-amber-500" />;
    default:
      return <Circle className="w-3.5 h-3.5 text-gray-300" />;
  }
}

function childStatusLabel(status: string): string {
  switch (status) {
    case 'done':       return 'Done';
    case 'in_progress': return 'In Progress';
    case 'blocked':     return 'Blocked';
    case 'review':      return 'In Review';
    case 'backlog':     return 'Not Started';
    case 'todo':        return 'Queued';
    default:            return status.replace(/_/g, ' ');
  }
}

// ── Component ────────────────────────────────────────────────────────────

export default function PresentationParentCard({
  taskId,
  initialData,
  onOpenChild,
  onOpenParent,
  isDragging,
  isCompleted,
  onDragStart,
  onMove,
  columns,
  currentColumnId,
  columnTaskCounts,
  parentTask,
}: PresentationParentCardProps) {
  const [data, setData] = useState<ChildrenResponse | null>(
    initialData ?? null,
  );
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);
  // PRES-021 — timestamped stale/offline state. Last-known children are
  // RETAINED (never reset to not_started); the banner below names the last
  // successful refresh so a dropped stream reads as stale, not no-progress.
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(
    initialData ? new Date().toISOString() : null,
  );
  const [stale, setStale] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  // Collapsed state — children are visible by default
  const [collapsed, setCollapsed] = useState(false);

  // FIX 51b — MR-45 bulk-select parity: the parent card participates in the
  // SAME selection set flat TaskCards use, so bulk move/archive/assign and
  // the header "N selected" bar cover presentation runs too.
  const isSelected = useMissionControl((s) => s.selectedTaskIds.has(taskId));
  const toggleSelection = useMissionControl((s) => s.toggleTaskSelection);

  // FIX 51b — the column this parent is visually sitting in (drives the Move
  // menu's "current column" checkmark). Falls back to the task's own status
  // projection when the board doesn't pass currentColumnId.
  const effectiveCurrentColumnId =
    currentColumnId ??
    taskToColumnId({ status: (data?.parent.status ?? 'backlog') as TaskStatus });

  // FIX 51b — drag is only enabled when the board wired the shared handlers
  // (the standalone children preview renders the card non-draggable).
  const dragEnabled = typeof onDragStart === 'function' && typeof onMove === 'function';

  // PRES-021 — task/run-scoped live refresh. Subscribes to the SSE
  // activity scope (useSSE stamps every activity_logged payload) plus the
  // board task store (task_created/task_updated land there): a child created
  // or completed after mount refreshes THIS parent's counts without reload.
  // Debounced + coalesced, AbortController-cancelled, and guarded against
  // late previous-task responses — see queueParentRefresh below.
  const activityPulse = useMissionControl((s) => s.activityPulse);
  const lastActivityScope = useMissionControl((s) => s.lastActivityScope);
  const storeTasks = useMissionControl((s) => s.tasks);

  const fetchData = useCallback(async () => {
    const mine = taskIdRef.current;
    // Cancel the in-flight request: a slow fetch for a PREVIOUS task must
    // never overwrite this task's state after a taskId change.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(
        `/api/presentations/children?parent_id=${encodeURIComponent(mine)}`,
        { cache: 'no-store', signal: controller.signal },
      );
      // Late response after a taskId change: drop it, keep current data.
      if (taskIdRef.current !== mine) return;
      if (!res.ok) {
        setError(`Failed to load phases (HTTP ${res.status})`);
        setStale(true);
        return;
      }
      const json = (await res.json()) as ChildrenResponse;
      if (taskIdRef.current !== mine) return;
      setData(json);
      setError(null);
      setStale(false);
      setLastUpdatedAt(new Date().toISOString());
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      if (taskIdRef.current !== mine) return;
      // Network drop: visible stale state, last-known data retained.
      setError((err as Error)?.message ? `Phases offline: ${(err as Error).message}` : 'Phases offline');
      setStale(true);
    } finally {
      if (taskIdRef.current === mine) setLoading(false);
    }
  }, []);

  // PRES-021 — debounced coalescing: burst of events collapses to one fetch.
  const queueParentRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void fetchData();
    }, PRES21_PARENT_DEBOUNCE_MS);
  }, [fetchData]);

  useEffect(() => {
    if (!initialData) {
      fetchData();
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, [fetchData, initialData]);

  // Update when initialData changes on re-render (SSE refresh from board)
  useEffect(() => {
    if (initialData) {
      setData(initialData);
      setError(null);
      setStale(false);
      setLastUpdatedAt(new Date().toISOString());
    }
  }, [initialData]);

  // PRES-021 — refresh on SSE activity for THIS parent (or its children):
  // the event's task scope names either the parent or a child row. Scopeless
  // (legacy) events still refresh — an unknown scope is never evidence of
  // irrelevance. task_updated/task_created for a child also arrive via the
  // board store (parentTask prop updates), which the next effect covers.
  useEffect(() => {
    if (activityPulse > 0) {
      const scopeTask = lastActivityScope?.taskId ?? null;
      if (scopeTask == null) {
        queueParentRefresh();
      } else if (scopeTask === taskIdRef.current) {
        queueParentRefresh();
      } else {
        // Maybe a child of this parent changed: check current data first;
        // when children are unknown yet, refresh once rather than miss it.
        const known = data?.children?.some((c) => c.id === scopeTask) ?? null;
        if (known !== false) queueParentRefresh();
      }
    }
    // data?.children intentionally read live, not as a dep: listing it would
    // re-arm this effect on every refresh and loop under a worker burst.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityPulse, lastActivityScope, queueParentRefresh]);

  // PRES-021 — refresh when the board store shows a new/changed child of
  // this parent (task_created/task_updated land in the store via useSSE even
  // when the activity event itself is missed). Compares against rendered
  // children so unrelated board churn causes zero requests.
  const childrenSignature = (data?.children ?? [])
    .map((c) => `${c.id}:${c.status}:${c.updated_at}`)
    .join('|');
  const signatureRef = useRef(childrenSignature);
  useEffect(() => {
    const mine = taskIdRef.current;
    const mineChildren = storeTasks.filter(
      (t) => (t.parent_task_id ?? null) === mine,
    );
    if (mineChildren.length === 0) return;
    const storeSig = mineChildren
      .map((t) => `${t.id}:${t.status}:${t.updated_at}`)
      .sort()
      .join('|');
    const renderedSig = signatureRef.current.split('|').slice().sort().join('|');
    if (storeSig !== renderedSig) {
      queueParentRefresh();
    }
  }, [storeTasks, queueParentRefresh]);
  useEffect(() => {
    signatureRef.current = childrenSignature;
  }, [childrenSignature]);

  // ── Loading skeleton ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div
        className="bg-white rounded-xl lg:rounded-2xl p-4 lg:p-5 card-shadow border border-gray-50 animate-pulse"
        data-testid="presentation-parent-card-loading"
      >
        <div className="h-5 bg-gray-200 rounded w-3/4 mb-3" />
        <div className="flex gap-2 mb-3">
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="h-2 w-2 rounded-full bg-gray-200" />
          ))}
        </div>
        <div className="space-y-1.5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-4 bg-gray-100 rounded w-full" />
          ))}
        </div>
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────
  if (error && !data) {
    return (
      <div
        className="bg-white rounded-xl lg:rounded-2xl p-4 lg:p-5 card-shadow border border-red-200"
        data-testid="presentation-parent-card-error"
      >
        <p className="text-xs text-red-600">{error}</p>
        <button
          type="button"
          className="mt-2 text-xs font-semibold text-red-700 underline underline-offset-2 hover:text-red-900"
          onClick={() => { setLoading(true); void fetchData(); }}
          data-testid="presentation-parent-retry"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  // PRES-021 — stale/offline banner over RETAINED last-known data. Names the
  // last successful refresh; retry refetches immediately. Never blanks the
  // counts back to not_started on a dropped stream.
  const staleBanner = (stale || error) ? (
    <div
      className="mx-4 lg:mx-5 mt-3 flex items-center gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1"
      data-testid="presentation-parent-stale"
    >
      <span>
        {error ?? 'Child data may be stale'}
        {lastUpdatedAt ? ` — last updated ${new Date(lastUpdatedAt).toLocaleTimeString()}` : ''}
      </span>
      <button
        type="button"
        className="font-semibold underline underline-offset-2 hover:text-amber-900"
        onClick={() => { void fetchData(); }}
        data-testid="presentation-parent-stale-retry"
      >
        Retry
      </button>
    </div>
  ) : null;

  const { parent, children, aggregate } = data;

  // FIX 51b — face data: prefer the board's full Task row (block fields +
  // dispatch_attempts) when the board passed one; fall back to the narrower
  // children-route payload so the standalone preview still renders.
  const faceTask: TaskLike = toFaceTask(
    parentTask?.status ?? parent.status,
    {
      block_reason: parentTask?.block_reason ?? parent.block_reason ?? undefined,
      block_gaps: parentTask?.block_gaps ?? parent.block_gaps ?? undefined,
      block_needs: parentTask?.block_needs ?? parent.block_needs ?? undefined,
      block_audience: parentTask?.block_audience ?? parent.block_audience ?? undefined,
      dispatch_attempts: parentTask?.dispatch_attempts ?? parent.dispatch_attempts ?? undefined,
    },
  );
  const faceStatus = faceTask.status;

  // ── Parent card render ────────────────────────────────────────────────
  // FIX 51b — the root is draggable like a flat TaskCard (native HTML5 DnD,
  // MissionQueue's handleDragStart; the column's onDrop runs the shared
  // handleColumnMove). All interactive children stopPropagation so drag and
  // open-modal stay separate gestures.
  return (
    <div
      draggable={dragEnabled}
      onDragStart={dragEnabled ? (e) => onDragStart?.(e) : undefined}
      className={`bg-white rounded-xl lg:rounded-2xl card-shadow border w-full ${
        isDragging ? 'opacity-50 scale-95' : ''
      } ${isCompleted ? 'opacity-75' : ''} ${
        isSelected
          ? 'border-brand-500 ring-2 ring-brand-200'
          : faceStatus === 'blocked'
            ? 'border-red-300'
            : faceStatus === 'done'
              ? 'border-emerald-200'
              : 'border-gray-50'
      }`}
      data-testid="presentation-parent-card"
    >
      {staleBanner}
      {/* ── Parent header ──────────────────────────────────────────────── */}
      <div
        className="px-4 lg:px-5 pt-4 lg:pt-5 pb-3 cursor-pointer"
        onClick={onOpenParent}
      >
        {/* Title + collapse toggle */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            {/* FIX 51b — MR-45 bulk-select checkbox, same affordance and
                same store selection set as flat TaskCards. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleSelection(taskId);
              }}
              className="mt-0.5 shrink-0 text-gray-300 hover:text-brand-600 transition-colors"
              title={isSelected ? 'Deselect this task' : 'Select this task'}
              aria-label={isSelected ? `Deselect "${parent.title}"` : `Select "${parent.title}"`}
              data-testid="presentation-parent-select-checkbox"
            >
              {isSelected ? (
                <CheckSquare className="w-5 h-5 text-brand-600" />
              ) : (
                <Square className="w-5 h-5" />
              )}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed(!collapsed);
              }}
              className="shrink-0 p-0.5 rounded hover:bg-gray-100 transition-colors"
              aria-label={collapsed ? 'Expand phases' : 'Collapse phases'}
              data-testid="presentation-parent-toggle"
            >
              {collapsed ? (
                <ChevronRight className="w-4 h-4 text-gray-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-gray-400" />
              )}
            </button>
            <h3
              className={`text-base font-semibold text-gray-900 leading-snug min-w-0 ${
                isCompleted ? 'line-through text-gray-400' : ''
              }`}
            >
              {parent.title}
            </h3>
          </div>
          {/* FIX 51b — touch-friendly Move menu, same shared component flat
              TaskCards render; selecting a column fires the SAME shared
              status-change path (including the Blocked confirmation modal). */}
          {columns && onMove && (
            <div onClick={(e) => e.stopPropagation()}>
              <MoveTaskMenu
                columns={columns}
                currentColumnId={effectiveCurrentColumnId}
                taskTitle={parent.title}
                onSelect={(columnId) => onMove(taskId, columnId)}
                columnTaskCounts={columnTaskCounts}
              />
            </div>
          )}
        </div>

        {/* Aggregate progress: X of N phases done */}
        <div className="flex items-center gap-3 text-xs text-gray-500 mb-3">
          {/* FIX 51a/51b — shared status pill: identical to every flat card. */}
          <StatusPill status={faceStatus} />
          <span className="flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            <span>
              {aggregate.done} of {aggregate.total} phases done
            </span>
          </span>
          {aggregate.in_progress > 0 && (
            <span className="flex items-center gap-1">
              <PlayCircle className="w-3.5 h-3.5 text-blue-500" />
              <span>{aggregate.in_progress} in progress</span>
            </span>
          )}
          {!!parent.process_certificate_sha && (
            <span className="text-emerald-600 font-medium">Certified</span>
          )}
        </div>

        {/* FIX 51a/51b — shared block-transparency panel: the SAME face a
            blocked flat card renders (audience badge, reason, gaps, next
            step, heal attempts). Gated + styled inside BlockedPanel. */}
        <BlockedPanel task={faceTask} />

        {/* 7-label stepper — always visible, even when children are collapsed */}
        <PhaseStepper
          taskId={taskId}
          preferGeneric={false}
        />
      </div>

      {/* ── Children rows ──────────────────────────────────────────────── */}
      {!collapsed && (
        <div
          className="border-t border-gray-100 divide-y divide-gray-50"
          data-testid="presentation-children-rows"
        >
          {children.length === 0 ? (
            <div className="px-4 lg:px-5 py-4 text-center" data-testid="presentation-children-empty">
              <p className="text-xs text-gray-400 italic">
                No phase cards yet — a child card appears here once the
                presentation engine posts a phase task with this run as its
                parent_task_id.
              </p>
            </div>
          ) : (
            children.map((child) => {
              // Map child to a phase label for display
              const phaseLabel =
                PHASE_LABELS.find(
                  (l) =>
                    typeof child.title === 'string' &&
                    child.title.toLowerCase().includes(l.toLowerCase()),
                ) ?? child.title;

              return (
                <div
                  key={child.id}
                  className={`px-4 lg:px-5 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-gray-50 transition-colors ${
                    child.status === 'blocked' ? 'bg-red-50/50' : ''
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenChild?.(child.id);
                  }}
                  data-testid={`presentation-child-${child.id}`}
                >
                  {/* Status dot */}
                  <span className="shrink-0">
                    {childStatusIcon(child.status)}
                  </span>

                  {/* Phase label */}
                  <span className="flex-1 text-sm font-medium text-gray-800 min-w-0 truncate">
                    {phaseLabel}
                  </span>

                  {/* Status pill */}
                  <span
                    className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      child.status === 'done'
                        ? 'bg-emerald-100 text-emerald-700'
                        : child.status === 'in_progress'
                          ? 'bg-blue-100 text-blue-700'
                          : child.status === 'blocked'
                            ? 'bg-red-100 text-red-700'
                            : child.status === 'review'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {childStatusLabel(child.status)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
