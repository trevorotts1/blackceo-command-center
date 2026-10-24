/**
 * board-projection.ts — U45 / C-14 (Board-truth regression pack).
 *
 * The six-column bucketing rule — which underlying TaskStatus values map to
 * which synthetic board column, and the inverse (new-task-from-column
 * seeding) — used to live as two unexported functions inside
 * src/components/MissionQueue.tsx. Extracted verbatim (same logic, same
 * names) into this dependency-free module so the mapping is directly
 * importable and unit-testable (tests/unit/u45-c14-board-truth-regression.test.ts)
 * without pulling in MissionQueue.tsx's full 'use client' React/UI
 * dependency tree. MissionQueue.tsx now imports both functions from here;
 * behavior is unchanged.
 */

import type { LifecycleCard, Task, TaskStatus } from './types';

/**
 * The FOUR underlying statuses that bucket into the synthetic 'todo' board
 * column (groomed-but-not-started / routed-not-started). This is the single
 * source of truth for that bucket — both `taskToColumnId` and the board's
 * getTasksByStatus filtering key off it, so it is defined exactly once here.
 */
export const TODO_BUCKET_STATUSES: readonly TaskStatus[] = ['inbox', 'planning', 'assigned', 'pending_dispatch'];

/**
 * The TWO underlying statuses that bucket into the synthetic 'review' column
 * (dev/web-dev sub-state 'testing' plus 'review' itself).
 */
export const REVIEW_BUCKET_STATUSES: readonly TaskStatus[] = ['review', 'testing'];

/**
 * The attention column shared by STALE and UNKNOWN cards (PBB-073 / T-35).
 * A card whose source record vanished, whose event stream stalled past the
 * threshold, or whose newest event carries an unrecognised status is shown
 * HERE — never silently left in the column it used to occupy.
 */
export const STALE_COLUMN_ID = 'stale';

/**
 * Reverse of the six-column bucketing rule below (backlog / todo / review are
 * synthetic UI columns that aggregate several underlying TaskStatus values).
 * Single source of truth for "which column is this task visually in" — used
 * by both getTasksByStatus (filtering) and the per-card Move menu (so the
 * touch affordance's "current column" always agrees with where the card is
 * actually rendered).
 *
 * PBB-073 / T-35 — when the server attached a `lifecycle` projection, the
 * REAL event-derived placement wins over the `tasks.status` mirror. Only a
 * card with no lifecycle evidence falls back to the status map.
 */
export function taskToColumnId(
  task: Pick<Task, 'status'> & {
    lifecycle?: { state: 'live' | 'stale' | 'unknown'; column: string | null } | null;
  },
): string {
  const lifecycle = task.lifecycle;
  if (lifecycle) {
    if (lifecycle.state === 'stale' || lifecycle.state === 'unknown') return STALE_COLUMN_ID;
    if (lifecycle.column) return lifecycle.column;
  }
  if (task.status === 'backlog') return 'backlog';
  if ((TODO_BUCKET_STATUSES as readonly string[]).includes(task.status)) return 'todo';
  if ((REVIEW_BUCKET_STATUSES as readonly string[]).includes(task.status)) return 'review';
  return task.status; // in_progress, blocked, done map 1:1
}

/**
 * The inverse mapping, used when a NEW task is seeded from a column's "+"
 * button or the touch Move menu: 'todo' is synthetic (no such TaskStatus), so
 * it becomes 'assigned' — the same target handleDrop uses for a card dropped
 * on To-Do (groomed/queued but not started).
 */
export function columnIdToStatus(columnId: string): TaskStatus {
  if (columnId === 'todo') return 'assigned';
  // The stale/unknown lane is read-only: it has no lifecycle status of its
  // own. A card only leaves it by an explicit move to a real column, and a
  // create seeded from it starts at backlog (the honest no-evidence state).
  if (columnId === STALE_COLUMN_ID) return 'backlog';
  return columnId as TaskStatus; // backlog/in_progress/review/blocked/done map 1:1
}

/**
 * PBB-073 / T-35 — a DELETED source record must stay visible as STALE.
 *
 * `task_events` cascades with the `tasks` row, so once a card's source record
 * is gone the server can no longer report the last event time. The board
 * already observed it on the previous render — this carries those cards
 * forward, marks them `stale / source_missing`, and preserves the last event
 * stamp instead of letting the card silently vanish (or stay put looking
 * healthy). Bounded so a broken feed cannot grow the board without limit.
 */
export const MAX_CARRIED_STALE_CARDS = 200;

export function carryForwardStaleCards(
  previous: readonly Task[],
  current: readonly Task[],
): Task[] {
  if (!Array.isArray(previous) || previous.length === 0) return [];
  const live = new Set(current.map((task) => task.id));
  const carried: Task[] = [];

  for (const task of previous) {
    if (live.has(task.id)) continue;
    const prior: LifecycleCard | null = task.lifecycle ?? null;
    carried.push({
      ...task,
      lifecycle: {
        task_id: task.id,
        column: prior?.column ?? null,
        state: 'stale',
        stale_reason: 'source_missing',
        last_event_at: prior?.last_event_at ?? null,
        last_event_id: prior?.last_event_id ?? null,
        unknown_event_type: prior?.unknown_event_type ?? null,
      },
    });
    if (carried.length >= MAX_CARRIED_STALE_CARDS) break;
  }

  return carried;
}

/**
 * Statuses POST /api/tasks refuses on CREATE (see the completion-evidence gate
 * in src/app/api/tasks/route.ts): a new task has no registered deliverable, so
 * it cannot honestly claim completion or review yet. Mirrors the server list —
 * keep the two in step.
 */
export const CREATE_TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'review'];

export function isCreateTerminalStatus(status: TaskStatus): boolean {
  return (CREATE_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The create form's status choices: every status except the terminal two. */
export function createDropdownStatuses(statuses: readonly TaskStatus[]): TaskStatus[] {
  return statuses.filter((s) => !isCreateTerminalStatus(s));
}

/**
 * The status a create form should actually submit. Seeding a create from the
 * Done / Review column cannot be honoured (terminal statuses are refused at
 * create), so it DOWNGRADES to the closest honest work state instead of
 * letting the submit 403: Review -> assigned (queued, not yet written up),
 * Done -> in_progress (work claimed, evidence not yet registered). The task
 * still reaches the requested column by the normal route — register a
 * deliverable, then move it.
 */
export function createSubmitStatus(status: TaskStatus): TaskStatus {
  if (status === 'review') return 'assigned';
  if (status === 'done') return 'in_progress';
  return status; // every other status passes through 1:1
}
