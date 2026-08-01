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
 *   - renders the Resume button
 *   - renders artifact count from deliverables API
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { BlockedReasonPanel } from '../../src/components/TaskOverviewPanels';
import type { Task } from '../../src/lib/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);
  });

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
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);
  });

  it('renders the failing gate reason', () => {
    render(<BlockedReasonPanel task={baseTask({ block_reason: 'QC score too low' })} />);
    const el = screen.getByTestId('blocked-panel-reason');
    expect(el.textContent).toContain('QC score too low');
  });
});

describe('BlockedReasonPanel — block_gaps (valid JSON)', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);
  });

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
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);
  });

  it('renders the malformed fallback when block_gaps is not valid JSON', () => {
    render(<BlockedReasonPanel task={baseTask({ block_gaps: 'not json' })} />);
    const el = screen.getByTestId('blocked-panel-gaps');
    expect(el.textContent).toContain('could not be read');
  });
});

describe('BlockedReasonPanel — block_needs', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);
  });

  it('renders the next step when block_needs is present', () => {
    render(
      <BlockedReasonPanel task={baseTask({ block_needs: 'Provide the missing asset link' })} />,
    );
    const el = screen.getByTestId('blocked-panel-needs');
    expect(el.textContent).toContain('Provide the missing asset link');
  });
});

describe('BlockedReasonPanel — heal attempt data', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);
  });

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
    // Countdown may not appear immediately in waitFor timing, but the data-testid should be there
    // after the useEffect tick fires
    const countdown = screen.queryByTestId('blocked-panel-countdown');
    // For the countdown to render, we need the useEffect to fire.
    // In jsdom, useEffect fires synchronously after render.
    expect(countdown).toBeTruthy();
    expect(countdown!.textContent).toMatch(/next retry/);
  });
});

// ── dispatch_attempts guards ─────────────────────────────────

describe('BlockedReasonPanel — dispatch_attempts absent', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);
  });

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

// ── Artifacts count ──────────────────────────────────────────

describe('BlockedReasonPanel — artifacts count', () => {
  it('fetches and renders the artifact count from deliverables API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }],
    } as Response);
    render(
      <BlockedReasonPanel
        task={baseTask({ dispatch_attempts: 1, next_dispatch_eligible_at: new Date(Date.now() + 5000).toISOString() })}
      />,
    );
    await waitFor(() => {
      const el = screen.getByTestId('blocked-panel-artifacts');
      expect(el.textContent).toContain('3 deliverables');
    });
  });
});

// ── Resume button ────────────────────────────────────────────

describe('BlockedReasonPanel — Resume button', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);
  });

  it('renders the Resume button', () => {
    render(<BlockedReasonPanel task={baseTask()} />);
    expect(screen.getByTestId('blocked-panel-resume-btn')).toBeTruthy();
  });

  it('the Resume button has descriptive text', () => {
    render(<BlockedReasonPanel task={baseTask()} />);
    const btn = screen.getByTestId('blocked-panel-resume-btn');
    expect(btn.textContent).toMatch(/Re-enter dispatch queue|re-enter dispatch queue/i);
  });
});

// ── Panel root data-testid ───────────────────────────────────

describe('BlockedReasonPanel — data-testid convention', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);
  });

  it('has data-testid on the panel root matching DispatchHoldPanel convention', () => {
    render(<BlockedReasonPanel task={baseTask({ block_reason: 'test' })} />);
    expect(screen.getByTestId('blocked-reason-panel')).toBeTruthy();
  });

  it('heading, reason, needs, and resume button are all addressable by data-testid', () => {
    render(
      <BlockedReasonPanel
        task={baseTask({
          block_reason: 'test reason',
          block_gaps: JSON.stringify(['gap1']),
          block_needs: 'fix it',
          dispatch_attempts: 1,
          next_dispatch_eligible_at: new Date(Date.now() + 5000).toISOString(),
        })}
      />,
    );
    expect(screen.getByTestId('blocked-reason-panel')).toBeTruthy();
    expect(screen.getByTestId('blocked-panel-heading')).toBeTruthy();
    expect(screen.getByTestId('blocked-panel-reason')).toBeTruthy();
    expect(screen.getByTestId('blocked-panel-gaps')).toBeTruthy();
    expect(screen.getByTestId('blocked-panel-needs')).toBeTruthy();
    expect(screen.getByTestId('blocked-panel-heal')).toBeTruthy();
    expect(screen.getByTestId('blocked-panel-countdown')).toBeTruthy();
    expect(screen.getByTestId('blocked-panel-resume-btn')).toBeTruthy();
  });

  it('every state carries a text label — colour alone is never the signal', () => {
    render(
      <BlockedReasonPanel
        task={baseTask({
          block_reason: 'test reason',
          dispatch_attempts: 2,
          next_dispatch_eligible_at: new Date(Date.now() + 5000).toISOString(),
        })}
      />,
    );
    // The heal section must have text content, not just a coloured icon
    const heal = screen.getByTestId('blocked-panel-heal');
    expect(heal.textContent!.trim().length).toBeGreaterThan(0);
    // The reason must be readable text beyond just the label
    const reason = screen.getByTestId('blocked-panel-reason');
    expect(reason.textContent).toContain('test reason');
    // The heading must be text
    const heading = screen.getByTestId('blocked-panel-heading');
    expect(heading.textContent!.trim().length).toBeGreaterThan(0);
  });
});

// ── MR-30 — block history on an UNBLOCKED card ───────────────
// The block_* columns are cleared when a card leaves blocked, so the grey
// "Previously blocked" panel reads from last_block_event (task_block_events
// row surfaced by the GET routes). These tests prove the panel renders on a
// non-blocked card with history, stays silent without it, and never replaces
// the live red/amber panel on a currently-blocked card.

describe('BlockedReasonPanel — MR-30 previously-blocked history', () => {
  it('renders nothing when not blocked and no block history', () => {
    const { container } = render(
      <BlockedReasonPanel task={baseTask({ status: 'in_progress', last_block_event: null })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when history exists but carries no reason or needs', () => {
    const { container } = render(
      <BlockedReasonPanel
        task={baseTask({
          status: 'in_progress',
          last_block_event: {
            id: 'be-1',
            task_id: 'task-blocked-1',
            block_reason: null,
            block_needs: null,
            created_at: '2026-07-30T10:00:00.000Z',
          },
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the grey "Previously blocked" panel for an unblocked card with history', () => {
    render(
      <BlockedReasonPanel
        task={baseTask({
          status: 'in_progress',
          last_block_event: {
            id: 'be-2',
            task_id: 'task-blocked-1',
            block_reason: 'Failed QC 3x, last score 4.2/10',
            block_needs: 'Owner action required: tighten the brief',
            block_audience: 'OWNER',
            created_at: '2026-07-30T10:00:00.000Z',
          },
        })}
      />,
    );
    const panel = screen.getByTestId('blocked-reason-panel');
    expect(panel).toBeTruthy();
    const heading = screen.getByTestId('blocked-panel-heading');
    expect(heading.textContent).toContain('Previously blocked');
    expect(screen.getByTestId('blocked-panel-reason').textContent).toContain(
      'Failed QC 3x, last score 4.2/10',
    );
    expect(screen.getByTestId('blocked-panel-needs').textContent).toContain(
      'Owner action required: tighten the brief',
    );
    // Audience line renders the OWNER label
    expect(panel.textContent).toContain('Owner (client)');
    // The live-panel Resume button must NOT appear on a historical panel
    expect(screen.queryByTestId('blocked-panel-resume-btn')).toBeNull();
  });

  it('renders the snapshotted gaps as "What was missing"', () => {
    render(
      <BlockedReasonPanel
        task={baseTask({
          status: 'backlog',
          last_block_event: {
            id: 'be-3',
            task_id: 'task-blocked-1',
            block_reason: 'Failed QC 2x',
            block_gaps: JSON.stringify(['missing deliverable', 'wrong department']),
            created_at: '2026-07-30T10:00:00.000Z',
          },
        })}
      />,
    );
    const panel = screen.getByTestId('blocked-reason-panel');
    expect(panel.textContent).toContain('What was missing');
    expect(panel.textContent).toContain('missing deliverable, wrong department');
  });

  it('ignores malformed gaps JSON without crashing', () => {
    render(
      <BlockedReasonPanel
        task={baseTask({
          status: 'backlog',
          last_block_event: {
            id: 'be-4',
            task_id: 'task-blocked-1',
            block_reason: 'Failed QC 2x',
            block_gaps: '{not json',
            created_at: '2026-07-30T10:00:00.000Z',
          },
        })}
      />,
    );
    expect(screen.getByTestId('blocked-panel-reason').textContent).toContain('Failed QC 2x');
  });

  it('a CURRENTLY blocked card still renders the live panel, never the history panel', () => {
    render(
      <BlockedReasonPanel
        task={baseTask({
          status: 'blocked',
          block_reason: 'live reason',
          last_block_event: {
            id: 'be-5',
            task_id: 'task-blocked-1',
            block_reason: 'old reason',
            created_at: '2026-07-30T10:00:00.000Z',
          },
        })}
      />,
    );
    const heading = screen.getByTestId('blocked-panel-heading');
    expect(heading.textContent).not.toContain('Previously blocked');
    expect(screen.getByTestId('blocked-panel-reason').textContent).toContain('live reason');
  });
});
