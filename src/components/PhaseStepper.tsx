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
  /** PRES-020 — honest per-label units (done/total required ids). */
  units_completed?: number;
  units_total?: number;
  /** PRES-020 — verified QC receipts backing this label's completions. */
  receipts?: PhaseStepReceipt[];
}

export interface PhaseProgressData {
  job_id: string;
  terminal: boolean;
  current_phase: string;
  phases: PhaseStepData[];
  unmapped?: string[];
}

export interface PhaseStepReceipt {
  phase_id: string;
  verified: true;
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
 * PRES-021 — trailing-edge debounce for SSE-triggered refreshes. A burst of
 * worker events collapses to one fetch; the value stays small enough that a
 * genuine single update still lands promptly.
 */
const PRES21_DEBOUNCE_MS = 400;

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
  // PRES-021 — timestamped stale/offline state. Last-known data is RETAINED
  // (never reset to not_started); the banner below names the last successful
  // refresh so a dropped stream reads as stale, not as no-progress.
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(
    initialData ? new Date().toISOString() : null,
  );
  const [stale, setStale] = useState(false);
  const fallbackPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // PRES-021 — true while a fetch for the CURRENT task is in flight. Guards
  // the initialData effect below: board-provided snapshots lag behind taskId
  // changes and must not clobber freshly fetched live data.
  const fetchingRef = useRef(false);
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;

  // U060 — subscribe to the SSE-driven pulse so we re-fetch on every
  // activity_logged event instead of running an independent poll.
  // PRES-021 — also read the event's task scope: only THIS card's task
  // refetches. A burst of 100 worker events for other tasks coalesces to
  // zero requests here instead of one fetch per event per mounted stepper.
  const activityPulse = useMissionControl((s) => s.activityPulse);
  const lastActivityScope = useMissionControl((s) => s.lastActivityScope);

  // Determine the API endpoint based on mode.
  const apiUrl = preferGeneric
    ? `/api/tasks/${taskId}/phases`
    : `/api/presentations/${taskId}/phases`;

  const fetchPhases = useCallback(async () => {
    const mine = taskIdRef.current;
    // PRES-021 — cancel the in-flight request before starting a new one so
    // a slow fetch for a PREVIOUS task cannot overwrite this task's state.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetchingRef.current = true;
    try {
      const res = await fetch(apiUrl, { cache: 'no-store', signal: controller.signal });
      // Late response for a task we already navigated away from: drop it.
      if (taskIdRef.current !== mine) return;
      if (!res.ok) {
        // PRES-021 — non-OK is a VISIBLE stale state with retained data,
        // not a silent return. The fallback poll keeps trying.
        setError(`Phase progress unavailable (HTTP ${res.status})`);
        setStale(true);
        return;
      }
      const json: PhaseProgressData = await res.json();
      if (taskIdRef.current !== mine) return;
      setData(json);
      setError(null);
      setStale(false);
      setLastUpdatedAt(new Date().toISOString());
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      if (taskIdRef.current !== mine) return;
      // PRES-021 — network drop is a VISIBLE stale state with retained
      // last-known data, never a silent swallow and never a reset.
      setError((err as Error)?.message ? `Phase progress offline: ${(err as Error).message}` : 'Phase progress offline');
      setStale(true);
    } finally {
      if (taskIdRef.current === mine) fetchingRef.current = false;
    }
  }, [apiUrl]);

  // PRES-021 — debounced coalescing: a burst of in-scope events collapses to
  // one fetch (trailing edge), bounding the request rate under load.
  const queueRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void fetchPhases();
    }, PRES21_DEBOUNCE_MS);
  }, [fetchPhases]);

  // Fetch on mount if no initialData; start fallback poll. The mount fetch
  // is skipped when initialData is present (props already carry live data);
  // the taskId effect below covers task changes. Without this guard, mount
  // fires a redundant fetch AND the initialData effect clears the error the
  // task-change fetch just set — a stale state that can never display.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      if (!initialData) {
        fetchPhases();
      }
    }
    fallbackPollRef.current = setInterval(fetchPhases, FALLBACK_POLL_MS);
    return () => {
      if (fallbackPollRef.current) clearInterval(fallbackPollRef.current);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
    // initialData read once on mount only (see the dedicated effect below
    // for updates); listing it would re-arm the interval per prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPhases]);

  // Refresh when taskId changes (skipped on mount — the block above owns it).
  const prevTaskIdRef = useRef(taskId);
  useEffect(() => {
    if (prevTaskIdRef.current !== taskId) {
      prevTaskIdRef.current = taskId;
      fetchPhases();
    }
  }, [taskId, fetchPhases]);

  // U060 — re-fetch whenever the SSE activityPulse ticks (activity_logged event).
  // PRES-021 — scoped: only when the event names THIS task (or carries no
  // task scope at all, e.g. legacy producers), queued through the debounce.
  useEffect(() => {
    if (activityPulse > 0) {
      const scopeTask = lastActivityScope?.taskId ?? null;
      if (scopeTask == null || scopeTask === taskIdRef.current) {
        queueRefresh();
      }
    }
  }, [activityPulse, lastActivityScope, queueRefresh]);

  // If we receive new initialData, update. Skipped while a fetch for the
  // CURRENT task is in flight: initialData lags behind taskId changes (the
  // board keeps passing the previous task's snapshot), and applying it after
  // the fresh fetch landed would clobber live data with stale props.
  // Declared above fetchPhases (which sets it), not here, so the ref exists
  // before the first fetch runs.
  useEffect(() => {
    if (initialData && !fetchingRef.current) {
      setData(initialData);
      setError(null);
      setStale(false);
      setLastUpdatedAt(new Date().toISOString());
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

  // PRES-021 — stale/offline banner. Renders ABOVE the bar whenever a fetch
  // failed after last-known data existed: timestamped, with a retry that
  // refetches immediately. Data underneath is retained, never blanked.
  const staleBanner = (stale || error) && data ? (
    <div
      className="flex items-center gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-1"
      data-testid="phase-stepper-stale"
    >
      <span>
        {error ?? 'Progress may be stale'}
        {lastUpdatedAt ? ` — last updated ${new Date(lastUpdatedAt).toLocaleTimeString()}` : ''}
      </span>
      <button
        type="button"
        className="font-semibold underline underline-offset-2 hover:text-amber-900"
        onClick={() => { void fetchPhases(); }}
        data-testid="phase-stepper-retry"
      >
        Retry
      </button>
    </div>
  ) : null;

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
      {staleBanner}
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
                title={
                  // PRES-020 — honest units on hover: "Script 1/5" instead of
                  // a bare label that hides partial progress.
                  typeof step.units_completed === 'number' && typeof step.units_total === 'number' && step.units_total > 0
                    ? `${step.label} ${step.units_completed}/${step.units_total}`
                    : step.label
                }
              >
                {step.label}
                {/* PRES-020 — honest units next to the label (1/5, not 50%). */}
                {typeof step.units_completed === 'number' && typeof step.units_total === 'number' && step.units_total > 0 && (
                  <span className="ml-1 text-[9px] opacity-70 tabular-nums">
                    {step.units_completed}/{step.units_total}
                  </span>
                )}
                {/* FIX 53 — wall-clock seconds from the stage-timings stream,
                    shown only when a timing row exists for this label so a
                    started-but-untimed phase never reads as "0s". */}
                {step.elapsed_s != null && (
                  <span className="ml-1 text-[9px] opacity-70 tabular-nums">
                    {step.elapsed_s < 1
                      ? `${Math.round(step.elapsed_s * 1000)}ms`
                      : step.elapsed_s < 60
                        ? `${step.elapsed_s % 1 === 0 ? step.elapsed_s : step.elapsed_s.toFixed(1)}s`
                        : `${Math.floor(step.elapsed_s / 60)}m${Math.round(step.elapsed_s % 60)}s`}
                  </span>
                )}
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
