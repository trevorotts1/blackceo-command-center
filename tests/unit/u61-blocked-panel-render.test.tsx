/**
 * U061 acceptance — REAL render proof that BlockedReasonPanel surfaces the heal
 * data (dispatch_attempts, next_dispatch_eligible_at) that existed in the DB and
 * was rendered by nothing before this unit.
 *
 * Runs via: npx vitest run --config vitest.component.config.ts tests/unit/u61-blocked-panel-render.test.tsx
 *
 * Covers:
 *   - renders nothing when not blocked
 *   - renders empty state when blocked with no fields
 *   - renders each of the content blocks when its field is present
 *   - renders NO attempt line when dispatch_attempts is undefined or 0
 *   - renders the malformed-block_gaps fallback
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BlockedReasonPanel } from '../../src/components/TaskOverviewPanels';
import type { Task } from '../../src/lib/types';

afterEach(() => cleanup());

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-blocked-1',
    title: 'Blocked fixture task',
    status: 'blocked',
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

// ── Silent when not blocked ──────────────────────────────────

describe('BlockedReasonPanel — not blocked', () => {
  it('renders nothing when status is not blocked', () => {
    const { container } = render(<BlockedReasonPanel task={baseTask({ status: 'backlog' })} />);
    expect(container.firstChild).toBeNull();
  });
});

// ── Empty state ──────────────────────────────────────────────

describe('BlockedReasonPanel — empty state', () => {
  it('renders the empty-state message when blocked with no block fields', () => {
    render(<BlockedReasonPanel task={baseTask()} />);
    expect(screen.getByTestId('blocked-reason-panel')).toBeTruthy();
    expect(screen.getByTestId('blocked-panel-empty')).toBeTruthy();
    expect(screen.getByTestId('blocked-panel-empty').textContent).toContain(
      'no machine-readable reason',
    );
  });
});

// ── Each content block renders when data present ─────────────

describe('BlockedReasonPanel — block_reason', () => {
  it('renders the failing gate reason', () => {
    render(<BlockedReasonPanel task={baseTask({ block_reason: 'QC score too low' })} />);
    const el = screen.getByTestId('blocked-panel-reason');
    expect(el.textContent).toContain('QC score too low');
  });
});

describe('BlockedReasonPanel — block_gaps (valid JSON)', () => {
  it('renders the gaps list when block_gaps is valid JSON array', () => {
    render(
      <BlockedReasonPanel
        task={baseTask({ block_gaps: JSON.stringify(['gap A', 'gap B', 'gap C']) })}
      />,
    );
    const el = screen.getByTestId('blocked-panel-gaps');
    expect(el.textContent).toContain('gap A');
    expect(el.textContent).toContain('gap B');
    expect(el.textContent).toContain('gap C');
  });
});

describe('BlockedReasonPanel — block_gaps (malformed JSON)', () => {
  it('renders the malformed fallback when block_gaps is not valid JSON', () => {
    render(<BlockedReasonPanel task={baseTask({ block_gaps: 'not json' })} />);
    const el = screen.getByTestId('blocked-panel-gaps');
    expect(el.textContent).toContain('could not be read');
  });
});

describe('BlockedReasonPanel — block_needs', () => {
  it('renders the next step when block_needs is present', () => {
    render(
      <BlockedReasonPanel task={baseTask({ block_needs: 'Provide the missing asset link' })} />,
    );
    const el = screen.getByTestId('blocked-panel-needs');
    expect(el.textContent).toContain('Provide the missing asset link');
  });
});

describe('BlockedReasonPanel — heal attempt data', () => {
  it('renders the attempt line when dispatch_attempts > 0', () => {
    render(
      <BlockedReasonPanel
        task={baseTask({
          dispatch_attempts: 2,
          next_dispatch_eligible_at: new Date(Date.now() + 40000).toISOString(),
        })}
      />,
    );
    const el = screen.getByTestId('blocked-panel-heal');
    expect(el.textContent).toContain('attempt 2');
  });

  it('renders the countdown when next_dispatch_eligible_at is in the future', () => {
    render(
      <BlockedReasonPanel
        task={baseTask({
          dispatch_attempts: 1,
          next_dispatch_eligible_at: new Date(Date.now() + 40000).toISOString(),
        })}
      />,
    );
    const countdown = screen.getByTestId('blocked-panel-countdown');
    expect(countdown.textContent).toMatch(/next retry/);
  });
});

// ── dispatch_attempts guards ─────────────────────────────────

describe('BlockedReasonPanel — dispatch_attempts absent', () => {
  it('renders no attempt line when dispatch_attempts is undefined', () => {
    render(<BlockedReasonPanel task={baseTask({ block_reason: 'Some reason' })} />);
    expect(screen.queryByTestId('blocked-panel-heal')).toBeNull();
  });

  it('renders no attempt line when dispatch_attempts is 0', () => {
    render(
      <BlockedReasonPanel
        task={baseTask({ block_reason: 'Some reason', dispatch_attempts: 0 })}
      />,
    );
    expect(screen.queryByTestId('blocked-panel-heal')).toBeNull();
  });

  it('renders no attempt line when dispatch_attempts is null', () => {
    render(
      <BlockedReasonPanel
        task={baseTask({ block_reason: 'Some reason', dispatch_attempts: null })}
      />,
    );
    expect(screen.queryByTestId('blocked-panel-heal')).toBeNull();
  });
});

// ── Panel root data-testid ───────────────────────────────────

describe('BlockedReasonPanel — data-testid convention', () => {
  it('has data-testid on the panel root matching DispatchHoldPanel convention', () => {
    render(<BlockedReasonPanel task={baseTask({ block_reason: 'test' })} />);
    expect(screen.getByTestId('blocked-reason-panel')).toBeTruthy();
  });
});
