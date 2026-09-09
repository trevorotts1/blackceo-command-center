/**
 * PRES-021 — PhaseStepper stale/offline REAL render proof.
 *
 * Old behavior: non-OK responses silently returned and network exceptions
 * were swallowed without ever setting the error state, so a dropped stream
 * read as no-progress with no retry.
 *
 * New behavior (proved here against the REAL component):
 *   1. failed refresh after live data shows a timestamped stale banner
 *      (data-testid="phase-stepper-stale") with a working Retry, retains the
 *      last-known bars (never resets to not_started);
 *   2. a slow fetch for a previous task cannot overwrite the current task
 *      (AbortController + drop-late-response);
 *   3. a foreign-task SSE pulse causes zero fetches; an own-task pulse
 *      refetches exactly once (debounced).
 *
 * Store mocked the same way mission-queue-board-states.test.tsx mocks it.
 * Real timers throughout (debounce is 400ms).
 *
 * Runs via: npx vitest run --config vitest.pres021-render.config.ts
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const { mockStore } = vi.hoisted(() => ({
  mockStore: vi.fn(),
}));
vi.mock('@/lib/store', () => ({
  useMissionControl: (sel: (s: unknown) => unknown) => {
    const st = mockStore();
    return sel ? sel(st) : st;
  },
}));

import PhaseStepper from '../../src/components/PhaseStepper';

function baseStore(over: Record<string, unknown> = {}) {
  return {
    activityPulse: 0,
    lastActivityScope: null,
    ...over,
  };
}

function phasesWith(scriptUnits: number, scriptStatus: string) {
  return [
    { label: 'Intake', status: 'done', started_at: null, elapsed_s: 3, artifacts: [], percent: 100, units_completed: 9, units_total: 9 },
    { label: 'Script', status: scriptStatus, started_at: null, elapsed_s: null, artifacts: [], percent: 20, units_completed: scriptUnits, units_total: 5 },
    { label: 'Prompts', status: 'not_started', started_at: null, elapsed_s: null, artifacts: [], percent: 0, units_completed: 0, units_total: 4 },
    { label: 'Images', status: 'not_started', started_at: null, elapsed_s: null, artifacts: [], percent: 0, units_completed: 0, units_total: 3 },
    { label: 'Teleprompter', status: 'not_started', started_at: null, elapsed_s: null, artifacts: [], percent: 0 },
    { label: 'QC', status: 'not_started', started_at: null, elapsed_s: null, artifacts: [], percent: 0, units_completed: 0, units_total: 2 },
    { label: 'Delivered', status: 'not_started', started_at: null, elapsed_s: null, artifacts: [], percent: 0, units_completed: 0, units_total: 3 },
  ];
}

const T1 = { job_id: 't1', terminal: false, current_phase: 'Script', phases: phasesWith(1, 'in_progress') };

function okJson(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}

beforeEach(() => {
  mockStore.mockReturnValue(baseStore());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PRES-021 — PhaseStepper stale/offline render', () => {
  it('failed refresh after live data shows timestamped stale banner, retains bars, Retry recovers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(T1));
    const { rerender } = render(<PhaseStepper taskId="t1" initialData={T1} />);
    await waitFor(() => {
      expect(screen.getByTestId('phase-step-script')).toBeTruthy();
    });
    expect(screen.getByTestId('phase-stepper').textContent).toContain('1/5');
    fetchSpy.mockClear();

    // Switch tasks; the new task's fetch fails. initialData is NOT
    // re-passed: the board keeps handing the previous task's snapshot, and
    // the component must fetch t2 (fail) rather than display t1's props.
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);
    rerender(<PhaseStepper taskId="t2" initialData={undefined} />);
    await waitFor(() => {
      expect(screen.queryByTestId('phase-stepper-stale')).toBeTruthy();
    });
    // Last-known bars retained — Script still partial, never blanked.
    expect(screen.getByTestId('phase-step-script')).toBeTruthy();
    expect(screen.getByTestId('phase-stepper').textContent).toContain('1/5');
    expect(screen.getByTestId('phase-stepper-stale').textContent).toMatch(/last updated/i);

    // Retry recovers with the new task's data.
    const T2 = { job_id: 't2', terminal: false, current_phase: 'Script', phases: phasesWith(5, 'done') };
    fetchSpy.mockResolvedValueOnce(okJson(T2));
    fireEvent.click(screen.getByTestId('phase-stepper-retry'));
    await waitFor(() => {
      expect(screen.queryByTestId('phase-stepper-stale')).toBeNull();
    });
    expect(screen.getByTestId('phase-stepper').textContent).toContain('5/5');
  });

  it('slow previous-task fetch cannot overwrite the current task', async () => {
    let resolveSlow!: (v: Response) => void;
    const slow = new Promise<Response>((r) => { resolveSlow = r; });
    const FAST_DONE = { job_id: 't-fast', terminal: false, current_phase: 'Script', phases: phasesWith(5, 'done') };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes('/t-slow/')) return slow;
      if (u.includes('/t-fast/')) return Promise.resolve(okJson(FAST_DONE));
      return Promise.resolve(okJson(T1));
    });
    const { rerender } = render(<PhaseStepper taskId="t1" initialData={T1} />);
    await waitFor(() => {
      expect(screen.getByTestId('phase-step-script')).toBeTruthy();
    });
    fetchSpy.mockClear();

    rerender(<PhaseStepper taskId="t-slow" />);
    rerender(<PhaseStepper taskId="t-fast" />);
    await waitFor(() => {
      expect(screen.getByTestId('phase-stepper').textContent).toContain('5/5');
    });
    // The slow previous-task response lands late: must be dropped. Its
    // Script row reads in_progress 0/5 — distinct from t-fast's done 5/5.
    resolveSlow(okJson({ job_id: 't-slow', terminal: false, current_phase: 'Script', phases: phasesWith(0, 'in_progress') }));
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByTestId('phase-stepper').textContent).toContain('5/5');
    expect(screen.getByTestId('phase-stepper').textContent).not.toContain('0/5');
  });

  it('foreign-task pulse causes zero fetches; own-task pulse refetches once', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(T1));
    const { rerender } = render(<PhaseStepper taskId="t1" initialData={T1} />);
    await waitFor(() => {
      expect(screen.getByTestId('phase-step-script')).toBeTruthy();
    });
    const callsAfterMount = fetchSpy.mock.calls.length;

    // Foreign-task burst: no fetch.
    mockStore.mockReturnValue(
      baseStore({ activityPulse: 1, lastActivityScope: { taskId: 'some-other-task', runId: null, attemptId: null } }),
    );
    rerender(<PhaseStepper taskId="t1" initialData={T1} />);
    await new Promise((r) => setTimeout(r, 800));
    expect(fetchSpy.mock.calls.length).toBe(callsAfterMount);

    // Own-task pulse: exactly one debounced fetch.
    mockStore.mockReturnValue(
      baseStore({ activityPulse: 2, lastActivityScope: { taskId: 't1', runId: 'run-1', attemptId: '2' } }),
    );
    rerender(<PhaseStepper taskId="t1" initialData={T1} />);
    await waitFor(() => {
      expect(fetchSpy.mock.calls.length).toBe(callsAfterMount + 1);
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(fetchSpy.mock.calls.length).toBe(callsAfterMount + 1);
  });
});
