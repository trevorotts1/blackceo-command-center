/**
 * U37 (C-06, master spec v2 §C+I.2) acceptance — REAL render-level proof that
 * the class-b "routed but not runnable" hold is visible ON THE CARD and in
 * the task-detail modal, not only in events.
 *
 * Renders the REAL components (react-dom via @testing-library/react + jsdom
 * — see vitest.component.config.ts), never a hand-rolled restatement.
 *
 *   npx vitest run --config vitest.component.config.ts
 *
 * Covers the C-06 binary-acceptance items:
 *   (a) a fixture task held by a missing runtime renders the chip in the
 *       board (component test asserting on data-testid), and the modal
 *       (DispatchHoldPanel) shows the hold text.
 *   (b) the same task after the runtime dir is created and one dispatch
 *       succeeds (dispatch_hold absent — the read-path already proved this
 *       is latest-activity-derived in the contract test) shows NO chip.
 *   (c) no chip ever renders for a task without such an activity row.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TaskCard } from '../../src/components/MissionQueue';
import { DispatchHoldPanel } from '../../src/components/TaskOverviewPanels';
import type { Task } from '../../src/lib/types';

afterEach(() => cleanup());

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Fixture task',
    status: 'assigned',
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

const HOLD_MESSAGE =
  '[routed_but_not_dispatched] Task "Fixture task" (task-1) routed to "Dept Agent" but NO ' +
  'per-department OpenClaw runtime exists (~/.openclaw/agents/<dept-slug>/ missing; ' +
  'workspace_id=ws-1, role=none). Dispatch HELD to avoid the agent:main re-ingest loop. ' +
  'Wire the department runtime to release.';

function renderTaskCard(task: Task) {
  return render(
    <TaskCard
      task={task}
      onDragStart={vi.fn()}
      onClick={vi.fn()}
      isDragging={false}
      columns={[{ id: 'assigned', label: 'To-Do' }]}
      currentColumnId="assigned"
      onMove={vi.fn()}
    />,
  );
}

// ── (a) held task -> chip on the card, text in the modal ───────────────────

describe('TaskCard — class-b dispatch-hold chip (C-06 acceptance a)', () => {
  it('renders the "Agent not wired on this box" chip when the task carries dispatch_hold', () => {
    renderTaskCard(
      baseTask({
        dispatch_hold: {
          message: HOLD_MESSAGE,
          reason: 'no_specialist_runtime',
          workspace_id: 'ws-1',
          role: null,
          created_at: '2026-07-15T10:00:00.000Z',
        },
      }),
    );
    const chip = screen.getByTestId('dispatch-hold-chip');
    expect(chip).toBeTruthy();
    expect(chip.textContent).toMatch(/Agent not wired on this box/);
    expect(chip.getAttribute('title')).toBe(HOLD_MESSAGE);
  });
});

describe('DispatchHoldPanel — modal shows the hold text verbatim (C-06 acceptance a)', () => {
  it('renders the hold message VERBATIM, including the fix instruction', () => {
    render(
      <DispatchHoldPanel
        task={baseTask({
          dispatch_hold: {
            message: HOLD_MESSAGE,
            reason: 'no_specialist_runtime',
            workspace_id: 'ws-1',
            role: null,
            created_at: '2026-07-15T10:00:00.000Z',
          },
        })}
      />,
    );
    const panel = screen.getByTestId('dispatch-hold-panel');
    expect(panel).toBeTruthy();
    const message = screen.getByTestId('dispatch-hold-message');
    // Verbatim — not re-derived/paraphrased.
    expect(message.textContent).toBe(HOLD_MESSAGE);
    expect(message.textContent).toMatch(/Wire the department runtime to release/);
  });
});

// ── (b) the runtime is wired + dispatch succeeds -> chip/panel gone ───────
// (the read-path's latest-activity derivation is proven in the contract
// test; here we prove the DISPLAY layer honors a null dispatch_hold exactly
// like "never held" — no chip, no stale banner.)

describe('C-06 acceptance (b) — after the hold clears, neither surface renders anything', () => {
  it('TaskCard renders NO chip once dispatch_hold is absent (post-heal state)', () => {
    renderTaskCard(baseTask({ dispatch_hold: null }));
    expect(screen.queryByTestId('dispatch-hold-chip')).toBeNull();
  });

  it('DispatchHoldPanel renders nothing once dispatch_hold is absent (post-heal state)', () => {
    const { container } = render(<DispatchHoldPanel task={baseTask({ dispatch_hold: null })} />);
    expect(container.firstChild).toBeNull();
  });
});

// ── (c) no chip ever renders for a task without such an activity row ──────

describe('C-06 acceptance (c) — a task that was never held renders nothing', () => {
  it('TaskCard renders no chip for a task with no dispatch_hold field at all (never held)', () => {
    renderTaskCard(baseTask({ dispatch_hold: undefined }));
    expect(screen.queryByTestId('dispatch-hold-chip')).toBeNull();
  });

  it('DispatchHoldPanel renders nothing for a task with no dispatch_hold field at all', () => {
    const { container } = render(<DispatchHoldPanel task={baseTask({ dispatch_hold: undefined })} />);
    expect(container.firstChild).toBeNull();
  });

  it('a normal healthy assigned+agent task (no hold ever) renders no chip alongside its normal pills', () => {
    renderTaskCard(
      baseTask({
        assigned_agent: { id: 'agent-1', name: 'Real Agent' } as Task['assigned_agent'],
        dispatch_hold: undefined,
      }),
    );
    expect(screen.getByText('Real Agent')).toBeTruthy();
    expect(screen.queryByTestId('dispatch-hold-chip')).toBeNull();
  });
});
