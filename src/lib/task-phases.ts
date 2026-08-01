/**
 * task-phases.ts — generic lifecycle milestone derivation for ANY department.
 *
 * MR-38 (PhaseStepper generalization): previously, the PhaseStepper component
 * was hard-wired to the presentation-specific phase manifest
 * (src/lib/presentation-phases.ts) and rendered ONLY for the presentations
 * department. The problem: task_events (written by transition(), the
 * structured audit trail) already records every lifecycle transition
 * universally, so the stepper CAN work for all departments — it just was never
 * wired to.
 *
 * This module provides a pure function that derives a generic 6-step lifecycle
 * progress bar (Intake → Planning → Dispatch → Execution → Review → Done)
 * from task_events rows plus the task's current status as a fallback for the
 * sparse period before all raw status writers are converted to transition().
 *
 * The 6 generic lifecycle steps:
 *   Intake    — arrived in the system (backlog, inbox)
 *   Planning  — being scoped (planning)
 *   Dispatch  — routed to an agent (assigned, pending_dispatch)
 *   Execution — agent is working (in_progress)
 *   Review    — QC / testing gate (review, testing)
 *   Done      — terminal (done)
 *
 * The "blocked" status is NOT a lifecycle step — it is a safety valve that
 * can interrupt any non-terminal step. When a task is blocked, we show the
 * progress up to the step where it was interrupted.
 *
 * Design:
 *  - Pure function (no DB access) — the API route queries the rows.
 *  - Falls back to current status when task_events are sparse (the task might
 *    have been created before migration 070 or had status changes through raw
 *    writers).
 *  - Every label is always present (always 6 steps), in fixed order.
 *  - Unmapped statuses (future additions) are recorded as `unmapped` for
 *    observability — never silently dropped.
 */

// Canonical set of generic lifecycle step labels, always in fixed order.
export const GENERIC_PHASE_LABELS = [
  'Intake',
  'Planning',
  'Dispatch',
  'Execution',
  'Review',
  'Done',
] as const;

export type GenericPhaseLabel = (typeof GENERIC_PHASE_LABELS)[number];

/** Status-to-label mapping — every TaskStatus maps to exactly one generic step. */
export const STATUS_TO_GENERIC_LABEL: Record<string, GenericPhaseLabel> = {
  backlog: 'Intake',
  inbox: 'Intake',
  planning: 'Planning',
  assigned: 'Dispatch',
  pending_dispatch: 'Dispatch',
  in_progress: 'Execution',
  review: 'Review',
  testing: 'Review',
  done: 'Done',
  blocked: 'Execution', // blocked interrupts but we show progress through prior steps
};

export type PhaseStepStatus = 'not_started' | 'in_progress' | 'done';

export interface GenericPhaseStep {
  label: GenericPhaseLabel;
  status: PhaseStepStatus;
}

export interface GenericPhaseProgress {
  phases: GenericPhaseStep[]; // always 6, in GENERIC_PHASE_LABELS order
  current_label: GenericPhaseLabel | null;
  unmapped: string[]; // statuses seen that STATUS_TO_GENERIC_LABEL does not know
}

/** Row shape expected from the route's task_events query. */
export interface TaskEventRow {
  from_status: string;
  to_status: string;
  created_at: string;
  reason?: string | null;
}

/**
 * Pure function — derive generic lifecycle progress from task_events rows
 * plus the task's current status (used as a fallback when events are scarce).
 *
 * @param events  task_events rows for the task, ordered by created_at ASC
 * @param currentStatus  the task's current status from the tasks row
 */
export function computeTaskProgress(
  events: TaskEventRow[],
  currentStatus: string | null,
): GenericPhaseProgress {
  // Labels that have been reached — we track via the `to_status` of each event.
  const seenLabels = new Set<GenericPhaseLabel>();
  const unmapped: string[] = [];

  // Walk events: any `to_status` that maps to a label marks that label as
  // reached. For phase computation, reaching a label means all previous labels
  // were also passed (we compute the "max reached" label ordered by phase).
  for (const ev of events) {
    const label = STATUS_TO_GENERIC_LABEL[ev.to_status];
    if (label) {
      seenLabels.add(label);
    } else if (!unmapped.includes(ev.to_status)) {
      unmapped.push(ev.to_status);
    }
  }

  // Fallback: if task_events are sparse (common before full transition()
  // adoption), use the current status as the floor — the task MUST have
  // reached at least this label to be in its current status.
  if (currentStatus) {
    const currentLabel = STATUS_TO_GENERIC_LABEL[currentStatus];
    if (currentLabel) {
      seenLabels.add(currentLabel);
    } else if (!unmapped.includes(currentStatus)) {
      unmapped.push(currentStatus);
    }
  }

  // Determine the "furthest reached" label by finding the max index in
  // GENERIC_PHASE_LABELS order.
  let maxReachedIndex = -1;
  seenLabels.forEach((label) => {
    const idx = GENERIC_PHASE_LABELS.indexOf(label);
    if (idx > maxReachedIndex) maxReachedIndex = idx;
  });

  // Derive current_label: the latest reached label, or null if nothing reached.
  const currentLabel =
    maxReachedIndex >= 0 ? GENERIC_PHASE_LABELS[maxReachedIndex] : null;

  const phases: GenericPhaseStep[] = GENERIC_PHASE_LABELS.map((label, i) => {
    if (i < maxReachedIndex) {
      return { label, status: 'done' as PhaseStepStatus };
    }
    if (i === maxReachedIndex) {
      return {
        label,
        status:
          currentStatus === 'done' && label === 'Done'
            ? ('done' as PhaseStepStatus)
            : ('in_progress' as PhaseStepStatus),
      };
    }
    return { label, status: 'not_started' as PhaseStepStatus };
  });

  return { phases, current_label: currentLabel, unmapped };
}
