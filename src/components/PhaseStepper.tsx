'use client';

/**
 * PhaseStepper (U060 / MR-38) — always-visible lifecycle stepper showing live
 * phase progress for a task in ANY department.
 *
 * Originally, the stepper only rendered for presentations and used the
 * presentation-specific /api/presentations/[taskId]/phases endpoint. MR-38
 * generalizes it: the stepper now accepts an optional `preferGeneric` flag
 * that switches to /api/tasks/[id]/phases, a generic 6-step lifecycle
 * endpoint driven by task_events + task status fallback.
 *
 * For presentations, the component uses the specialist 7-step route by
 * default; for every other department, it uses the generic route.
 *
 * Accessibility shape copied from ProgressRail.tsx:
 *   - role="progressbar" with aria-valuemin/max/now on the root
 *   - aria-current="step" on the active step
 *   - data-testid on the root and on each step (house convention)
 *   - every step carries a text label, never colour alone
 *
 * The wide variant wraps in its own overflow-x: auto container so the
 * stepper scrolls inside itself and never scrolls the page body.
 *
 * U060 / MR-39: Reacts to the `activityPulse` counter from the SSE feed
 * instead of running an independent poll. When an activity_logged event
 * arrives on the SSE stream, useSSE increments the pulse, and this component
 * re-fetches phase data. A long-interval fallback poll (120 s) keeps the
 * stepper alive if the SSE stream drops silently.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { PHASE_LABELS } from '@/lib/presentation-phases';
import type { PhaseStepStatus } from '@/lib/presentation-phases';
import { useMissionControl } from '@/lib/store';

export interface PhaseStepData {
  label: string;
  status: PhaseStepStatus;
  started_at: string | null;
  elapsed_s: number | null;
  artifacts: string[];
  percent: number;
}

export interface PhaseProgressData {
  job_id: string;
  terminal: boolean;
  current_phase: string;
  phases: PhaseStepData[];
  unmapped?: string[];
}

export interface PhaseStepperProps {
  taskId: string;
  /** Optional pre-fetched data. When absent the stepper fetches on mount. */
  initialData?: PhaseProgressData | null;
  /**
   * MR-38: when true, the stepper uses the generic /api/tasks/[id]/phases
   * endpoint instead of the presentation-specific route. Set this for
   * non-presentation tasks so they get the generic 6-step lifecycle bar.
   */
  preferGeneric?: boolean;
}

/** Long-interval fallback poll in case the SSE stream drops silently. */
const FALLBACK_POLL_MS = 120_000;

/**
 * Build the fallback placeholder array from a label list — called when data
 * is absent and we need the generic defaults (for generic mode without
 * pre-importing presentation labels).
 */
function placeholderPhases(
  labels: readonly string[],
): PhaseStepData[] {
  return labels.map((label) => ({
    label,
    status: 'not_started' as PhaseStepStatus,
    started_at: null,
    elapsed_s: null,
    artifacts: [] as string[],
    percent: 0,
  }));
}

export default function PhaseStepper({
  taskId,
  initialData,
  preferGeneric,
}: PhaseStepperProps) {
  const [data, setData] = useState<PhaseProgressData | null>(
    initialData ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const fallbackPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // U060 — subscribe to the SSE-driven pulse so we re-fetch on every
  // activity_logged event instead of running an independent poll.
  const activityPulse = useMissionControl((s) => s.activityPulse);

  // Determine the API endpoint based on mode.
  const apiUrl = preferGeneric
    ? `/api/tasks/${taskId}/phases`
    : `/api/presentations/${taskId}/phases`;

  const fetchPhases = useCallback(async () => {
    try {
      const res = await fetch(apiUrl, { cache: 'no-store' });
      if (!res.ok) {
        // Non-200: leave last-known state; the poll keeps trying
        return;
      }
      const json: PhaseProgressData = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      // Network drop or error — leave last-known state
    }
  }, [apiUrl]);

  // Fetch on mount if no initialData; start fallback poll.
  useEffect(() => {
    if (!initialData) {
      fetchPhases();
    }
    fallbackPollRef.current = setInterval(fetchPhases, FALLBACK_POLL_MS);
    return () => {
      if (fallbackPollRef.current) clearInterval(fallbackPollRef.current);
    };
  }, [fetchPhases, initialData]);

  // Refresh when taskId changes.
  useEffect(() => {
    fetchPhases();
  }, [taskId, fetchPhases]);

  // U060 — re-fetch whenever the SSE activityPulse ticks (activity_logged event).
  useEffect(() => {
    if (activityPulse > 0) {
      fetchPhases();
    }
  }, [activityPulse, fetchPhases]);

  // If we receive new initialData, update.
  useEffect(() => {
    if (initialData) {
      setData(initialData);
    }
  }, [initialData]);

  if (error && !data) {
    return (
      <div
        className="text-xs text-red-500 py-2"
        data-testid="phase-stepper-error"
      >
        {error}
      </div>
    );
  }

  const phases =
    data?.phases ??
    (preferGeneric
      ? placeholderPhases([
          'Intake',
          'Planning',
          'Dispatch',
          'Execution',
          'Review',
          'Done',
        ])
      : placeholderPhases(PHASE_LABELS));

  // Find the active step: the first phase whose status ends in "_progress" or
  // the first not_started after a done/in_progress. Simpler: the first
  // in_progress, or the last done if all are done.
  const activeLabel =
    data?.current_phase ??
    phases.find((p) => p.status === 'in_progress')?.label ??
    null;
  const doneCount = phases.filter(
    (p) => p.status === 'done' || p.status === 'in_progress',
  ).length;
  const totalCount = phases.length;

  return (
    <div
      className="overflow-x-auto"
      style={{ WebkitOverflowScrolling: 'touch' }}
      data-testid="phase-stepper"
    >
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={totalCount}
        aria-valuenow={doneCount}
        aria-label={
          preferGeneric
            ? 'Task lifecycle progress'
            : 'Presentation progress'
        }
        className="flex items-center gap-1 min-w-max py-2"
      >
        {phases.map((step, idx) => {
          const isActive = step.label === activeLabel;
          const isDone = step.status === 'done';
          const isInProgress = step.status === 'in_progress';

          let dotClass = 'bg-gray-200';
          let lineClass = 'bg-gray-200';
          let textClass = 'text-gray-400';
          if (isDone) {
            dotClass = 'bg-green-500';
            lineClass = 'bg-green-500';
            textClass = 'text-green-700';
          } else if (isInProgress) {
            dotClass = 'bg-blue-500';
            lineClass = 'bg-gray-200';
            textClass = 'text-blue-700';
          }

          return (
            <div
              key={step.label}
              className="flex items-center gap-1 flex-1 min-w-0"
              data-testid={`phase-step-${step.label.toLowerCase()}`}
              aria-current={isActive ? 'step' : undefined}
            >
              <span
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotClass}`}
                aria-hidden="true"
              />
              <span
                className={`text-[10px] font-medium truncate ${textClass}`}
              >
                {step.label}
              </span>
              {idx < totalCount - 1 && (
                <span
                  className={`flex-1 h-px ${lineClass} min-w-[8px]`}
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
