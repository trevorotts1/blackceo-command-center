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

import { useEffect, useState, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CheckCircle2,
  PlayCircle,
  AlertCircle,
  Clock,
} from 'lucide-react';
import PhaseStepper from '@/components/PhaseStepper';
import { PHASE_LABELS } from '@/lib/presentation-phases';
import type { PhaseStepStatus } from '@/lib/presentation-phases';

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
}: PresentationParentCardProps) {
  const [data, setData] = useState<ChildrenResponse | null>(
    initialData ?? null,
  );
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);
  // Collapsed state — children are visible by default
  const [collapsed, setCollapsed] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/presentations/children?parent_id=${encodeURIComponent(taskId)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        setError(`Failed to load phases (HTTP ${res.status})`);
        return;
      }
      const json = (await res.json()) as ChildrenResponse;
      setData(json);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (!initialData) {
      fetchData();
    }
  }, [fetchData, initialData]);

  // Update when initialData changes on re-render (SSE refresh from board)
  useEffect(() => {
    if (initialData) {
      setData(initialData);
    }
  }, [initialData]);

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
      </div>
    );
  }

  if (!data) return null;

  const { parent, children, aggregate } = data;

  // ── Parent card render ────────────────────────────────────────────────
  return (
    <div
      className={`bg-white rounded-xl lg:rounded-2xl card-shadow border w-full ${
        isDragging ? 'opacity-50 scale-95' : ''
      } ${isCompleted ? 'opacity-75' : ''} ${
        parent.status === 'blocked'
          ? 'border-red-300'
          : parent.status === 'done'
            ? 'border-emerald-200'
            : 'border-gray-50'
      }`}
      data-testid="presentation-parent-card"
    >
      {/* ── Parent header ──────────────────────────────────────────────── */}
      <div
        className="px-4 lg:px-5 pt-4 lg:pt-5 pb-3 cursor-pointer"
        onClick={onOpenParent}
      >
        {/* Title + collapse toggle */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
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
        </div>

        {/* Aggregate progress: X of N phases done */}
        <div className="flex items-center gap-3 text-xs text-gray-500 mb-3">
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
