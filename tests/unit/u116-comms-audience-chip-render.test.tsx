/**
 * U116 (E6-2; master spec v2 Section E6-2, implements ADD-2, closes G8)
 * Command Center leg — BINARY acceptance (e), verbatim: "the board card
 * renders the chosen audience (standard vs specific) alongside the
 * persona-blend chips (snapshot) — PASS/FAIL."
 *
 * Real render-level proof that `CommsAudienceChip` renders the
 * standard-vs-specific U116 audience choice as a chip, reusing the
 * `PersonaSlotChips` / `PersonaScopeChips` visual pattern verbatim — modeled
 * directly on the A-U5 companion
 * (tests/unit/a-u5-persona-scope-chips-render.test.tsx).
 *
 * Renders the REAL component (react-dom via @testing-library/react + jsdom
 * — see vitest.component.config.ts), never a hand-rolled restatement.
 *
 * TWO layers are proven, deliberately, not one — a unit that wires a new
 * chip component but never actually calls it from the board card would
 * leave a component-only test suite green (the exact "revert the wiring,
 * every test stays green" failure mode called out for this campaign):
 *   1. `CommsAudienceChip` in isolation — its own visibility/label logic.
 *   2. The REAL exported `TaskCard` from `MissionQueue.tsx` (the file that
 *      actually renders the board card, modeled on the C-06
 *      `u37-c-06-dispatch-hold-render.test.tsx` pattern) — proves the chip
 *      is actually reachable from a real card render, not just importable.
 *
 *   npx vitest run --config vitest.component.config.ts tests/unit/u116-comms-audience-chip-render.test.tsx
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CommsAudienceChip } from '../../src/components/kanban/TaskCard';
import { TaskCard } from '../../src/components/MissionQueue';
import type { Task } from '../../src/lib/types';

afterEach(() => cleanup());

function task(overrides: Partial<Task> = {}): Pick<Task, 'comms_audience_source' | 'comms_type'> {
  return {
    comms_audience_source: null,
    comms_type: null,
    ...overrides,
  };
}

describe('CommsAudienceChip', () => {
  it('renders empty-state (nothing) when comms_audience_source is absent — the U116 revert clause', () => {
    const { container } = render(<CommsAudienceChip task={task({ comms_audience_source: undefined })} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders empty-state when comms_audience_source is explicitly null (pre-106 row / non-comms task)', () => {
    const { container } = render(<CommsAudienceChip task={task({ comms_audience_source: null })} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders empty-state on an unrecognized value — never fabricates a chip from garbage data', () => {
    const { container } = render(
      // @ts-expect-error deliberately malformed to prove the guard, not the happy path
      <CommsAudienceChip task={task({ comms_audience_source: 'onboarding_icp' })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the STANDARD audience chip when comms_audience_source="standard"', () => {
    render(<CommsAudienceChip task={task({ comms_audience_source: 'standard', comms_type: 'email' })} />);
    const chip = screen.getByTestId('comms-audience-chip');
    expect(chip).toBeTruthy();
    expect(screen.getByText('Standard audience')).toBeTruthy();
  });

  it('renders the SPECIFIC audience chip when comms_audience_source="specific"', () => {
    render(<CommsAudienceChip task={task({ comms_audience_source: 'specific', comms_type: 'sms' })} />);
    const chip = screen.getByTestId('comms-audience-chip');
    expect(chip).toBeTruthy();
    expect(screen.getByText('Specific audience')).toBeTruthy();
  });

  it('standard and specific render visually distinct chips (different ring/text classes)', () => {
    const { container: standardContainer } = render(
      <CommsAudienceChip task={task({ comms_audience_source: 'standard' })} />,
    );
    cleanup();
    const { container: specificContainer } = render(
      <CommsAudienceChip task={task({ comms_audience_source: 'specific' })} />,
    );
    const standardSpan = standardContainer.querySelector('[data-testid="comms-audience-chip"] span span');
    const specificSpan = specificContainer.querySelector('[data-testid="comms-audience-chip"] span span');
    expect(standardSpan?.parentElement?.className).not.toEqual(specificSpan?.parentElement?.className);
  });

  it('never reads task.audience_source (the migration-090 resolved_audience.source mirror) — the name-collision trap', () => {
    // A task carrying the OTHER audience_source field (onboarding_icp |
    // operator_confirmed | asked, migration 090) but NO comms_audience_source
    // must still render empty-state. A builder who wired the chip to the
    // wrong column would make this test fail (it would render "onboarding_icp"
    // or similar garbage instead of nothing).
    const { container } = render(
      <CommsAudienceChip
        task={{
          comms_audience_source: null,
          comms_type: null,
          // @ts-expect-error — audience_source is not part of this component's
          // prop type; injected here only to prove it is never read.
          audience_source: 'operator_confirmed',
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// ── (e) integration: the REAL board card actually reaches the chip ─────────
// Proves the wiring point (MissionQueue.tsx's TaskCard renders
// <CommsAudienceChip task={task} /> alongside PersonaSlotChips/
// PersonaScopeChips), not merely that the extracted component works when
// hand-imported. Modeled directly on the C-06 dispatch-hold card-integration
// test (tests/unit/u37-c-06-dispatch-hold-render.test.tsx).

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-u116-1',
    title: 'Write the spring sale email',
    status: 'in_progress',
    priority: 'medium',
    assigned_agent_id: null,
    created_by_agent_id: null,
    workspace_id: 'ws-1',
    business_id: 'biz-1',
    created_at: '2026-07-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
    dependencies: [],
    parallel_candidates: [],
    ...over,
  };
}

function renderBoardCard(t: Task) {
  return render(
    <TaskCard
      task={t}
      onDragStart={vi.fn()}
      onClick={vi.fn()}
      isDragging={false}
      columns={[{ id: 'in_progress', label: 'In Progress' }]}
      currentColumnId="in_progress"
      onMove={vi.fn()}
    />,
  );
}

describe('TaskCard (MissionQueue.tsx) — U116 acceptance (e): the REAL board card renders the comms-audience chip', () => {
  it('a comms task carrying comms_audience_source="specific" shows the chip on the real board card', () => {
    renderBoardCard(baseTask({ comms_audience_source: 'specific', comms_type: 'sms' }));
    const chip = screen.getByTestId('comms-audience-chip');
    expect(chip).toBeTruthy();
    expect(screen.getByText('Specific audience')).toBeTruthy();
  });

  it('a comms task carrying comms_audience_source="standard" shows the chip on the real board card', () => {
    renderBoardCard(baseTask({ comms_audience_source: 'standard', comms_type: 'email' }));
    expect(screen.getByTestId('comms-audience-chip')).toBeTruthy();
    expect(screen.getByText('Standard audience')).toBeTruthy();
  });

  it('an ordinary (non-comms) task renders NO comms-audience chip on the real board card', () => {
    renderBoardCard(baseTask({ comms_audience_source: null }));
    expect(screen.queryByTestId('comms-audience-chip')).toBeNull();
  });
});
