/**
 * Department operational stats — blocked count + average velocity + blockers
 * list for the department detail page (U57 / JM-U53, part (c)).
 *
 * Field-name discipline (J.0.8 correction, carried here): the base spec
 * attributed these to "`/api/performance`'s `trend_series`" — there is no
 * per-department windowed series on that company-wide endpoint. This module
 * instead computes both stats directly from a department's own task list
 * (the same `/api/tasks?workspace_id=` shape `DepartmentPerformanceSection.tsx`
 * already reads), using the IDENTICAL velocity formula `KPIStatCards.tsx`
 * uses for its company-wide "Avg Velocity" card (completed-in-window ÷
 * windowDays × 7 = a real weekly rate, never a lifetime-total-divided-by-a-
 * constant) — just scoped to one department instead of the whole company.
 *
 * Pure, framework-free — no React, no fetch — unit-testable without a DOM
 * harness, same discipline as `src/lib/ceo-board/attention.ts`.
 */

export type TaskStatusLike = string;

/** Minimal shape this module needs from a task row (subset of `Task`). */
export interface OperationalTaskInput {
  id: string;
  title: string;
  status: TaskStatusLike;
  /** Set by the QC scorer when it caps the reroute loop (migration 073). */
  block_reason?: string | null;
  block_needs?: string | null;
  updated_at: string;
  /** Raw column from `tasks` — present in `/api/tasks`'s `t.*` select even
   *  though it is not on the typed `Task` interface; optional here so a
   *  pre-completed_at row still computes (falls back to updated_at). */
  completed_at?: string | null;
  created_at: string;
}

export interface BlockedTaskSummary {
  id: string;
  title: string;
  /** Human-readable reason, preferring the QC-scorer's structured field. */
  reason: string;
  updatedAt: string;
}

export interface DepartmentOperationalStats {
  /** Count of tasks currently status='blocked' for this department — always
   *  a real integer, 0 is an honest zero, never omitted. */
  blockedCount: number;
  /** The blocked tasks themselves, most-recently-updated first — length
   *  always equals blockedCount (same array, never independently derived). */
  blockedTasks: BlockedTaskSummary[];
  /** Completed-per-week rate averaged over `windowDays` (default 30) — the
   *  same formula as KPIStatCards.tsx's company-wide Avg Velocity, scoped to
   *  this department's own tasks. Null when the department has no tasks at
   *  all yet (never a fabricated 0 that looks like "definitely zero work"). */
  avgVelocity: number | null;
  windowDays: number;
}

function resolveCompletedAt(task: OperationalTaskInput): string {
  return task.completed_at || task.updated_at;
}

/**
 * Computes blocked count/list + average velocity for one department's tasks.
 * `tasks` should already be scoped to the department (e.g.
 * `/api/tasks?workspace_id=<id>`) — this function does not filter by
 * workspace itself, matching the pattern `DepartmentPerformanceSection.tsx`
 * uses (fetch scoped, compute locally).
 */
export function computeDepartmentOperationalStats(
  tasks: OperationalTaskInput[],
  windowDays = 30,
): DepartmentOperationalStats {
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const blockedTasks: BlockedTaskSummary[] = blocked
    .slice()
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .map((t) => ({
      id: t.id,
      title: t.title,
      reason: t.block_needs || t.block_reason || 'Blocked — no reason recorded',
      updatedAt: t.updated_at,
    }));

  if (tasks.length === 0) {
    return { blockedCount: blocked.length, blockedTasks, avgVelocity: null, windowDays };
  }

  const windowStartMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const completedInWindow = tasks.filter((t) => {
    if (t.status !== 'done') return false;
    const completedAt = new Date(resolveCompletedAt(t)).getTime();
    return !Number.isNaN(completedAt) && completedAt >= windowStartMs;
  }).length;

  // Same shape as KPIStatCards.tsx: completed-in-window ÷ windowDays × 7.
  const avgVelocity = Math.round((completedInWindow / windowDays) * 7 * 10) / 10;

  return { blockedCount: blocked.length, blockedTasks, avgVelocity, windowDays };
}
