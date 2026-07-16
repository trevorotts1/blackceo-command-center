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

import type { Task, TaskStatus } from './types';

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
 * Reverse of the six-column bucketing rule below (backlog / todo / review are
 * synthetic UI columns that aggregate several underlying TaskStatus values).
 * Single source of truth for "which column is this task visually in" — used
 * by both getTasksByStatus (filtering) and the per-card Move menu (so the
 * touch affordance's "current column" always agrees with where the card is
 * actually rendered).
 */
export function taskToColumnId(task: Pick<Task, 'status'>): string {
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
  return columnId as TaskStatus; // backlog/in_progress/review/blocked/done map 1:1
}
