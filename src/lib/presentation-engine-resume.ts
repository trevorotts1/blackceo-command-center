/**
 * presentation-engine-resume.ts — Item 19 (FIX-PLAN): resume a parked
 * presentation engine run from the board, truthfully.
 *
 * THE CONTRACT:
 *   * The action calls the SAME resume path the engine honors: the
 *     launcher dispatch the on-box poller uses for parked runs
 *     (presentation_job.launcher --resume), through
 *     presentation-engine-launcher.ts. No second resume mechanism is
 *     invented here, and this module never writes state.json and never
 *     moves the board task — a board-side status flip would be a
 *     fabricated state change (the board does not dispatch engine-owned
 *     cards; the engine owns this run).
 *   * The result is read back from the engine's resulting state: after a
 *     successful dispatch the run's state.json is re-read until the park
 *     the engine recorded is actually gone (or its resume history grew,
 *     or it re-parked at a new phase — a consumed resume), and THAT state
 *     is what the caller renders.
 *   * Every refusal is surfaced with its reason: unbound run, unavailable
 *     binding, no engine state, terminal run, not parked, launcher not
 *     found, and the launcher's own refusal output verbatim.
 *
 * SERVER-ONLY. Never import from a 'use client' module.
 */

import {
  engineStateIsParked,
  getTaskEngineView,
  type TaskEngineView,
} from '@/lib/presentation-engine-state';
import {
  launchEngineResume,
  resolveEngineScriptsDir,
} from '@/lib/presentation-engine-launcher';

export type ResumeOutcome =
  | {
      kind: 'resumed';
      detail: string;
      view: TaskEngineView;
    }
  | {
      kind: 'dispatched_pending';
      detail: string;
      view: TaskEngineView;
    }
  | {
      kind: 'refused';
      code:
        | 'run_unbound'
        | 'run_unavailable'
        | 'no_engine_state'
        | 'engine_terminal'
        | 'not_parked'
        | 'engine_launcher_not_found'
        | 'launcher_refused';
      refusal: string;
      view: TaskEngineView | null;
    };

const DEFAULT_SETTLE_MS = 15_000;
const SETTLE_POLL_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resume the parked engine run bound to a board task.
 *
 * `settleMs` bounds how long the call waits for the spawned engine's own
 * state write to land before answering `dispatched_pending` (the dispatch
 * succeeded; the state has not caught up — reported as exactly that,
 * never as a completed resume). Tests pass a small settle bound or a
 * launcher stub that settles the state synchronously.
 */
export async function resumeParkedEngineRun(
  taskId: string,
  opts?: { settleMs?: number },
): Promise<ResumeOutcome> {
  const view = getTaskEngineView(taskId);

  if (view.resolution.kind === 'unavailable') {
    return {
      kind: 'refused',
      code: 'run_unavailable',
      refusal: `${view.resolution.detail} ${view.resolution.remediation}`,
      view,
    };
  }
  if (!view.runDir) {
    return {
      kind: 'refused',
      code: 'run_unbound',
      refusal:
        view.resolution.kind === 'unbound'
          ? view.resolution.remediation
          : 'No presentation run directory is available for this task.',
      view,
    };
  }
  if (!view.state) {
    return {
      kind: 'refused',
      code: 'no_engine_state',
      refusal:
        'This job has no engine run state (state.json) in its run directory, so there is no parked engine run to resume. ' +
        'A job that failed before the engine started is recovered through the pre-engine recovery path, not this action.',
      view,
    };
  }
  if (view.state.terminal === 'DONE' || view.state.terminal === 'ABANDONED') {
    return {
      kind: 'refused',
      code: 'engine_terminal',
      refusal: `The engine records this run as ${view.state.terminal}; a terminal run cannot be resumed.`,
      view,
    };
  }
  if (!engineStateIsParked(view.state)) {
    return {
      kind: 'refused',
      code: 'not_parked',
      refusal:
        'The engine state for this run is not parked (no blocked record, terminal is ' +
        `${view.state.terminal ?? 'not set'}); there is nothing to resume.`,
      view,
    };
  }

  const scriptsDir = resolveEngineScriptsDir();
  if (!scriptsDir) {
    return {
      kind: 'refused',
      code: 'engine_launcher_not_found',
      refusal:
        'The presentation engine launcher was not found on this box (checked PRESENTATION_ENGINE_SCRIPTS_DIR and the Command Center directory for presentation_job/launcher.py); the resume cannot be dispatched.',
      view,
    };
  }

  const before = {
    blockedAt: view.state.blocked?.at ?? null,
    resumeHistoryCount: view.state.resumeHistoryCount,
    terminal: view.state.terminal,
  };

  const launch = await launchEngineResume(view.runDir, scriptsDir);
  if (launch.exitCode !== 0) {
    return {
      kind: 'refused',
      code: 'launcher_refused',
      refusal:
        launch.output ||
        `The engine launcher refused the resume (exit ${launch.exitCode ?? 'unknown'}) with no output.`,
      view: getTaskEngineView(taskId),
    };
  }

  // The launcher spawned the engine detached. The resume is REAL only when
  // the engine's own state shows it: the park cleared, a resume-history
  // entry appended, or a fresh park at a new stamp (a consumed resume that
  // re-parked further along). Poll the state file briefly; the engine's
  // startup writes land within its first seconds.
  const settleMs = opts?.settleMs ?? DEFAULT_SETTLE_MS;
  const deadline = Date.now() + settleMs;
  for (;;) {
    const fresh = getTaskEngineView(taskId);
    if (fresh.state) {
      const consumed =
        !engineStateIsParked(fresh.state) ||
        fresh.state.resumeHistoryCount > before.resumeHistoryCount ||
        (fresh.state.blocked?.at ?? null) !== before.blockedAt ||
        fresh.state.terminal !== before.terminal;
      if (consumed) {
        return {
          kind: 'resumed',
          detail: engineStateIsParked(fresh.state)
            ? 'The engine consumed the resume and re-parked; the card shows the new park from the engine state.'
            : 'The engine consumed the resume; the park is cleared in the engine state.',
          view: fresh,
        };
      }
    }
    if (Date.now() >= deadline) {
      return {
        kind: 'dispatched_pending',
        detail:
          'The engine launcher accepted the resume and spawned the engine, but the run state still shows the park. ' +
          'Nothing was changed on the board; the card updates from the engine state as it lands.',
        view: fresh,
      };
    }
    await sleep(SETTLE_POLL_MS);
  }
}
