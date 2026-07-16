/**
 * U38 (C-07, master spec v2 §C+I.2) acceptance — REAL render-level proof for
 * the "Promote to Done (operator)" human-promote control.
 *
 * Renders the REAL component (react-dom via @testing-library/react + jsdom —
 * see vitest.component.config.ts), never a hand-rolled restatement.
 *
 *   npx vitest run --config vitest.component.config.ts
 *
 * Covers the C-07 binary-acceptance item (b) at the DISPLAY layer (the data
 * layer — qc_heuristic_park's scope to review + heuristic-marker-only — is
 * proven in the contract test):
 *   - the button renders ONLY when task.qc_heuristic_park is present AND
 *     status is 'review' — never for an LLM-scored review card (no
 *     qc_heuristic_park), never for any other status.
 *   - the panel shows the qc_review event message VERBATIM.
 *   - clicking the button POSTs /api/tasks/[id]/promote and reloads on
 *     success (asserted via the mocked fetch call + window.location.reload
 *     spy, matching the sibling AudienceConfirmPanel's onConfirmed wiring).
 *   - a 409 CAS_CONFLICT response surfaces an inline error, never a silent
 *     failure — acceptance item (c)'s UI-surfacing half (the route-level CAS
 *     guarantee itself is proven in the contract test).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QcPromotePanel } from '../../src/components/TaskOverviewPanels';
import type { Task } from '../../src/lib/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Fixture task',
    status: 'review',
    priority: 'medium',
    assigned_agent_id: null,
    created_by_agent_id: null,
    workspace_id: 'ws-1',
    business_id: 'biz-1',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    dependencies: [],
    parallel_candidates: [],
    ...over,
  };
}

const HEURISTIC_MESSAGE =
  '[QC-HEURISTIC] Score: 7.0/10 | QC ran in heuristic mode (no LLM key); human review required (pass 1/3).';

// ── (b) renders ONLY for a heuristic-parked review card ─────────────────────

describe('QcPromotePanel — renders ONLY for a review card the QC heuristic fallback parked (C-07 acceptance b)', () => {
  it('renders the "Promote to Done (operator)" button + the verbatim qc_review message', () => {
    render(
      renderPanel(
        baseTask({
          qc_heuristic_park: {
            marker: 'QC-HEURISTIC',
            message: HEURISTIC_MESSAGE,
            created_at: '2026-07-15T10:00:00.000Z',
          },
        }),
      ),
    );
    const panel = screen.getByTestId('qc-promote-panel');
    expect(panel).toBeTruthy();
    const button = screen.getByTestId('qc-promote-button');
    expect(button.textContent).toMatch(/Promote to Done \(operator\)/);
    const message = screen.getByTestId('qc-promote-message');
    expect(message.textContent).toBe(HEURISTIC_MESSAGE);
  });

  it('renders for a QC-HEURISTIC-FINAL park exactly the same as QC-HEURISTIC', () => {
    const finalMsg = '[QC-HEURISTIC-FINAL] Score: 7.0/10 | MANUAL REVIEW REQUIRED.';
    render(
      renderPanel(
        baseTask({
          qc_heuristic_park: { marker: 'QC-HEURISTIC-FINAL', message: finalMsg, created_at: '2026-07-15T10:00:00.000Z' },
        }),
      ),
    );
    expect(screen.getByTestId('qc-promote-button')).toBeTruthy();
    expect(screen.getByTestId('qc-promote-message').textContent).toBe(finalMsg);
  });
});

describe('QcPromotePanel — NEVER renders for an LLM-scored review card or any other status (C-07 acceptance b)', () => {
  it('renders nothing when qc_heuristic_park is absent (LLM-scored review card)', () => {
    const { container } = render(renderPanel(baseTask({ status: 'review', qc_heuristic_park: null })));
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('qc-promote-button')).toBeNull();
  });

  it('renders nothing when qc_heuristic_park is undefined (field never attached)', () => {
    const { container } = render(renderPanel(baseTask({ status: 'review', qc_heuristic_park: undefined })));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a non-review status EVEN IF qc_heuristic_park is somehow present (defense in depth)', () => {
    const { container } = render(
      renderPanel(
        baseTask({
          status: 'blocked',
          qc_heuristic_park: { marker: 'QC-HEURISTIC', message: HEURISTIC_MESSAGE, created_at: '2026-07-15T10:00:00.000Z' },
        }),
      ),
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('qc-promote-button')).toBeNull();
  });

  it('renders nothing for an in_progress task with no park data', () => {
    const { container } = render(renderPanel(baseTask({ status: 'in_progress', qc_heuristic_park: undefined })));
    expect(container.firstChild).toBeNull();
  });
});

// ── click behavior: success reloads, CAS_CONFLICT surfaces inline ──────────

describe('QcPromotePanel — clicking Promote (C-07 acceptance b/c)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadMock },
    });
  });

  it('on success (200): POSTs /api/tasks/{id}/promote and reloads the page', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'task-1', status: 'done' }),
    });

    render(
      renderPanel(
        baseTask({
          qc_heuristic_park: { marker: 'QC-HEURISTIC', message: HEURISTIC_MESSAGE, created_at: '2026-07-15T10:00:00.000Z' },
        }),
      ),
    );

    fireEvent.click(screen.getByTestId('qc-promote-button'));

    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/promote', { method: 'POST' });
    // No error banner on the success path.
    expect(screen.queryByTestId('qc-promote-error')).toBeNull();
  });

  it('on 409 CAS_CONFLICT: surfaces an inline error, never a silent failure, and does NOT reload', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        error: "Task task-1 expected in 'review' but was 'blocked'; transition to done aborted",
        code: 'CAS_CONFLICT',
      }),
    });

    render(
      renderPanel(
        baseTask({
          qc_heuristic_park: { marker: 'QC-HEURISTIC', message: HEURISTIC_MESSAGE, created_at: '2026-07-15T10:00:00.000Z' },
        }),
      ),
    );

    fireEvent.click(screen.getByTestId('qc-promote-button'));

    const error = await screen.findByTestId('qc-promote-error');
    expect(error.textContent).toMatch(/already moved this task/);
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('on a generic 403 (out-of-scope card raced from under it): surfaces the server error text inline', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Forbidden: task is 'done', not 'review'." }),
    });

    render(
      renderPanel(
        baseTask({
          qc_heuristic_park: { marker: 'QC-HEURISTIC', message: HEURISTIC_MESSAGE, created_at: '2026-07-15T10:00:00.000Z' },
        }),
      ),
    );

    fireEvent.click(screen.getByTestId('qc-promote-button'));

    const error = await screen.findByTestId('qc-promote-error');
    expect(error.textContent).toMatch(/Forbidden: task is 'done'/);
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('on a network failure: surfaces a connection error inline, never a silent swallow', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    render(
      renderPanel(
        baseTask({
          qc_heuristic_park: { marker: 'QC-HEURISTIC', message: HEURISTIC_MESSAGE, created_at: '2026-07-15T10:00:00.000Z' },
        }),
      ),
    );

    fireEvent.click(screen.getByTestId('qc-promote-button'));

    const error = await screen.findByTestId('qc-promote-error');
    expect(error.textContent).toMatch(/Could not reach the server/);
    expect(reloadMock).not.toHaveBeenCalled();
  });
});

// Small helper kept at the bottom (after usage — function declarations
// hoist) purely to avoid repeating the JSX wrapper.
function renderPanel(task: Task) {
  return <QcPromotePanel task={task} />;
}
