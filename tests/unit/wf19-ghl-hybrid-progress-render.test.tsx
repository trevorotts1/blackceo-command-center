/**
 * WF19 — Command Center hybrid progress UI (Document 1 s14.7 / s14.8 / s14.11,
 * acceptance A23 display side; Document 2 s7.2 focused tests).
 *
 * Proves the display layer tells the truth, in real renders:
 *   - a malformed receipt payload fails LOUDLY and renders no counts/checks;
 *   - unknown_outcome dominates and can never read as verified;
 *   - a selected fallback shows its ACTUAL result, or "not recorded" — never
 *     the word "successful";
 *   - `scheduled` never renders as published;
 *   - no timestamp is synthesized (no "Eastern" text without a real event);
 *   - stale/unknown board lifecycle stays visible;
 *   - configuration / activation / functional proof / sync stay distinct per
 *     feature family, with missing dimensions shown as "Not reported";
 *   - implementation and tenant activation are two separate facts;
 *   - the board card reaches the chips, and an unreadable payload shows the
 *     loud chip instead of silence;
 *   - the receipt panel renders nothing on 404 but is loud on 5xx/garbage.
 *
 * npx vitest run --config vitest.component.config.ts tests/unit/wf19-ghl-hybrid-progress-render.test.tsx
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  buildGhlHybridView,
  parseGhlHybridSummary,
  GhlHybridChips,
  GhlHybridPanel,
  GhlHybridProgress,
} from '../../src/components/ghl/GhlHybridProgress';
import { GhlHybridCardChips } from '../../src/components/kanban/TaskCard';
import { TaskCard } from '../../src/components/MissionQueue';
import type { Task } from '../../src/lib/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Payload = { schema_version?: unknown; summary: Record<string, unknown> };

function payload(over: Record<string, unknown> = {}): Payload {
  return {
    schema_version: '1.0.0',
    summary: {
      phase: 'content',
      implementation_state: 'implemented',
      activation_state: 'not_activated',
      builder_id: 'builder-deepseek-chain',
      reviewer_id: 'reviewer-opus-chain',
      last_event_at: '2026-11-08T18:30:00.000Z',
      operations: [
        {
          operation_id: 'courses.lessons.create',
          rail: 'public_rest',
          outcome: 'verified',
          observed_at: '2026-11-08T18:00:00.000Z',
          readback: { state: 'matched', checked_fields: ['title'] },
        },
      ],
      ...over,
    },
  };
}

function viewOf(p: unknown, lifecycle?: Task['lifecycle']) {
  const parsed = parseGhlHybridSummary(p);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.reason}`);
  return buildGhlHybridView(parsed.summary, lifecycle ?? null);
}

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-wf19-1',
    title: 'Build the launch course',
    status: 'in_progress',
    priority: 'medium',
    assigned_agent_id: null,
    created_by_agent_id: null,
    workspace_id: 'ws-1',
    business_id: 'biz-1',
    created_at: '2026-11-08T00:00:00.000Z',
    updated_at: '2026-11-08T00:00:00.000Z',
    dependencies: [],
    parallel_candidates: [],
    ...over,
  };
}

// ── Hard parse failures (never a partial success) ───────────────────────────

describe('WF19 view model — malformed receipts fail loudly', () => {
  it('rejects a non-object payload with a named reason', () => {
    const parsed = parseGhlHybridSummary('not-json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/not a JSON object/i);
  });

  it('rejects an operation missing its rail and names the row and field', () => {
    const parsed = parseGhlHybridSummary(
      payload({
        operations: [{ operation_id: 'x', outcome: 'verified', observed_at: '2026-11-08T18:00:00.000Z' }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/operations\[0\] is missing rail/);
  });

  it('rejects a sub-result missing its dimension', () => {
    const parsed = parseGhlHybridSummary(
      payload({ sub_results: [{ family: 'meetings', state: 'verified' }] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/sub_results\[0\] is missing dimension/);
  });

  it('rejects a fallback with no reason', () => {
    const parsed = parseGhlHybridSummary(payload({ fallback: { result: 'ok' } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/fallback\.reason is missing/);
  });

  it('accepts the documented envelope and reports the schema version', () => {
    const v = viewOf(payload());
    expect(v.schemaVersion).toBe('1.0.0');
    expect(v.schemaWarning).toBeNull();
  });

  it('keeps a newer additive schema version visible instead of pretending it is 1.0.0', () => {
    const v = viewOf({ schema_version: '1.1.0', summary: { phase: 'content' } });
    expect(v.schemaWarning).toMatch(/1\.1\.0/);
  });
});

// ── Badges / counts / rails ────────────────────────────────────────────────

describe('WF19 view model — phase, rail, result, verified/required', () => {
  it('derives verified and required counts from the receipts (never from a claim)', () => {
    const v = viewOf(
      payload({
        operations: [
          { operation_id: 'a', rail: 'public_rest', outcome: 'verified', observed_at: '2026-11-08T18:00:00.000Z' },
          { operation_id: 'b', rail: 'public_rest', outcome: 'verified', observed_at: '2026-11-08T18:01:00.000Z' },
          { operation_id: 'c', rail: 'firebase_private', outcome: 'failed', observed_at: '2026-11-08T18:02:00.000Z' },
        ],
      }),
    );
    expect(v.verified).toBe(2);
    expect(v.required).toBe(3);
    expect(v.resultTone).toBe('danger');
    expect(v.resultLabel).toContain('2/3 verified');
  });

  it('unknown_outcome dominates even when other operations verified', () => {
    const v = viewOf(
      payload({
        operations: [
          { operation_id: 'a', rail: 'public_rest', outcome: 'verified', observed_at: '2026-11-08T18:00:00.000Z' },
          { operation_id: 'b', rail: 'public_rest', outcome: 'unknown_outcome', observed_at: '2026-11-08T18:01:00.000Z' },
        ],
      }),
    );
    expect(v.unknownOutcome).toBe(true);
    expect(v.resultTone).toBe('unknown');
    expect(v.resultLabel).toMatch(/Outcome unknown/);
    expect(v.resultLabel).not.toMatch(/verified$/);
  });

  it('shows an unrecognised rail as unrecognised — never maps it to a friendly name', () => {
    const v = viewOf(
      payload({
        operations: [{ operation_id: 'a', rail: 'carrier_pigeon', outcome: 'verified', observed_at: '2026-11-08T18:00:00.000Z' }],
      }),
    );
    expect(v.railRecognised).toBe(false);
    expect(v.railLabel).toBe('Unrecognised rail: carrier_pigeon');
  });

  it('uses the newest operation rail as the selected rail', () => {
    const v = viewOf(
      payload({
        operations: [
          { operation_id: 'old', rail: 'public_rest', outcome: 'failed', observed_at: '2026-11-08T17:00:00.000Z' },
          { operation_id: 'new', rail: 'managed_browser', outcome: 'verified', observed_at: '2026-11-08T18:00:00.000Z' },
        ],
      }),
    );
    expect(v.railLabel).toBe('Managed browser');
  });
});

// ── Fallback honesty ───────────────────────────────────────────────────────

describe('WF19 view model — fallback shows its actual result', () => {
  it('marks a fallback with no result as unrecorded (unknown), never successful', () => {
    const v = viewOf(payload({ fallback: { reason: 'public beta not enabled for this location', rail: 'firebase_private' } }));
    expect(v.fallback?.resultMissing).toBe(true);
    expect(v.fallback?.result).toBeNull();
    render(<GhlHybridProgress view={v} />);
    expect(screen.getByTestId('ghl-progress-fallback-result').textContent).toMatch(/not recorded/i);
    expect(screen.queryByText(/fallback successful/i)).toBeNull();
    expect(screen.getByText(/Fallback selected/)).toBeTruthy();
  });

  it('renders the actual fallback result verbatim when the receipt carries one', () => {
    const v = viewOf(
      payload({ fallback: { reason: 'beta_not_enabled', rail: 'firebase_private', result: 'workflow created and read back' } }),
    );
    render(<GhlHybridProgress view={v} />);
    expect(screen.getByTestId('ghl-progress-fallback-result').textContent).toContain('workflow created and read back');
  });
});

// ── Visibility / time honesty ──────────────────────────────────────────────

describe('WF19 view model — scheduled is not published, and no synthesized times', () => {
  it('renders a scheduled post as "scheduled — not published"', () => {
    const v = viewOf(
      payload({
        operations: [
          {
            operation_id: 'social.posts.create',
            rail: 'public_rest',
            outcome: 'submitted',
            observed_at: '2026-11-08T18:00:00.000Z',
            requested_visibility: 'scheduled',
            actual_visibility: 'scheduled',
          },
        ],
      }),
    );
    render(<GhlHybridProgress view={v} />);
    expect(screen.getByText(/scheduled — not published/)).toBeTruthy();
  });

  it('says "No event on record" and marks freshness UNKNOWN when nothing carries a time', () => {
    const v = viewOf({ summary: { phase: 'content', operations: [] } });
    expect(v.lastEventAt).toBeNull();
    expect(v.freshness).toBe('unknown');
    render(<GhlHybridProgress view={v} />);
    expect(screen.getByTestId('ghl-progress-last-event').textContent).toContain('No event on record');
    expect(screen.getByTestId('ghl-progress-freshness').textContent).toBe('UNKNOWN');
    // Nothing was invented to fill the gap.
    expect(screen.queryByText(/Eastern/)).toBeNull();
  });

  it('keeps a stale board lifecycle visible, carrying the real stale reason', () => {
    const v = viewOf(payload(), {
      task_id: 'task-wf19-1',
      column: 'in_progress',
      state: 'stale',
      stale_reason: 'stream_stalled',
      last_event_at: '2026-11-08T12:00:00.000Z',
      last_event_id: 'evt-1',
      unknown_event_type: null,
    });
    expect(v.freshness).toBe('stale');
    render(<GhlHybridProgress view={v} />);
    expect(screen.getByTestId('ghl-progress-freshness').textContent).toBe('STALE');
  });

  it('formats a real timestamp in US Eastern 12-hour time and says Eastern', () => {
    const v = viewOf(payload());
    expect(v.lastEventLabel).toMatch(/Eastern$/);
    expect(v.lastEventLabel).toMatch(/1:30 PM/); // 18:30Z on 2026-11-08 = 1:30 PM EST
  });
});

// ── Sub-results: four distinct dimensions per family ───────────────────────

describe('WF19 view model — configuration, activation, functional proof and sync stay distinct', () => {
  it('renders four separate cells per family and "Not reported" for absent dimensions', () => {
    const v = viewOf(
      payload({
        sub_results: [
          { family: 'meetings', dimension: 'configuration', state: 'verified' },
          { family: 'meetings', dimension: 'functional_proof', state: 'unknown' },
          { family: 'projects', dimension: 'sync', state: 'verified' },
        ],
      }),
    );
    render(<GhlHybridProgress view={v} />);
    expect(screen.getByTestId('ghl-family-meetings-configuration').textContent).toMatch(/Verified/);
    expect(screen.getByTestId('ghl-family-meetings-functional_proof').textContent).toMatch(/Unknown/);
    expect(screen.getByTestId('ghl-family-meetings-activation').textContent).toMatch(/Not reported/);
    expect(screen.getByTestId('ghl-family-meetings-sync').textContent).toMatch(/Not reported/);
    expect(screen.getByTestId('ghl-family-projects-sync').textContent).toMatch(/Verified/);
    expect(screen.getByTestId('ghl-family-projects-functional_proof').textContent).toMatch(/Not reported/);
    expect(screen.queryByText('Knowledge bases')).toBeNull();
  });

  it('shows implementation and tenant activation as two separate facts', () => {
    const v = viewOf(payload({ implementation_state: 'implemented', activation_state: 'not_activated' }));
    render(<GhlHybridProgress view={v} />);
    expect(screen.getByTestId('ghl-progress-implementation').textContent).toBe('Implemented');
    expect(screen.getByTestId('ghl-progress-activation').textContent).toBe('Not activated');
  });

  it('labels an unrecognised sub-result state as unrecognised, not verified', () => {
    const v = viewOf(
      payload({ sub_results: [{ family: 'kb', dimension: 'activation', state: 'probably_fine' }] }),
    );
    render(<GhlHybridProgress view={v} />);
    expect(screen.getByTestId('ghl-family-kb-activation').textContent).toMatch(/Unrecognised: probably_fine/);
  });
});

// ── Object links ───────────────────────────────────────────────────────────

describe('WF19 view model — useful object links are only links when they are http(s)', () => {
  it('renders an https object link as an anchor', () => {
    const v = viewOf(
      payload({ object_links: [{ label: 'Launch course', href: 'https://app.gohighlevel.com/v2/location/abc/courses' }] }),
    );
    const { container } = render(<GhlHybridProgress view={v} />);
    const anchor = container.querySelector('a[href="https://app.gohighlevel.com/v2/location/abc/courses"]');
    expect(anchor).not.toBeNull();
    expect(anchor?.textContent).toBe('Launch course');
  });

  it('never renders a non-http(s) href as a link', () => {
    const v = viewOf(payload({ object_links: [{ label: 'Course', href: 'javascript:alert(1)' }] }));
    const { container } = render(<GhlHybridProgress view={v} />);
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText(/link withheld/)).toBeTruthy();
  });
});

// ── Board card wiring ─────────────────────────────────────────────────────

describe('WF19 board card — compact chips', () => {
  it('renders nothing for a task with no hybrid summary (ordinary card unchanged)', () => {
    const { container } = render(<GhlHybridCardChips task={{ lifecycle: null }} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders phase, rail and result chips for a valid summary', () => {
    render(<GhlHybridCardChips task={{ lifecycle: null, ghl_hybrid: payload() }} />);
    expect(screen.getByTestId('ghl-chip-phase').textContent).toContain('content');
    expect(screen.getByTestId('ghl-chip-rail').textContent).toContain('Public REST');
    expect(screen.getByTestId('ghl-chip-result').textContent).toContain('1/1 verified');
    expect(screen.queryByTestId('ghl-hybrid-unreadable-chip')).toBeNull();
  });

  it('shows the loud unreadable chip — not silence, not a checkmark — on a malformed payload', () => {
    render(<GhlHybridCardChips task={{ lifecycle: null, ghl_hybrid: { operations: 'nope' } }} />);
    expect(screen.getByTestId('ghl-hybrid-unreadable-chip').textContent).toContain('unreadable');
    expect(screen.queryByTestId('ghl-chip-result')).toBeNull();
  });

  it('shows an UNKNOWN freshness chip when the summary carries no real event time', () => {
    render(
      <GhlHybridCardChips
        task={{ lifecycle: null, ghl_hybrid: { summary: { phase: 'content', operations: [] } } }}
      />,
    );
    expect(screen.getByTestId('ghl-chip-freshness').textContent).toBe('UNKNOWN');
  });

  it('the REAL board card (MissionQueue TaskCard) reaches the chips', () => {
    const withSummary = {
      ...baseTask(),
      ghl_hybrid: payload({ current_blocker: 'Video asset not yet uploaded' }),
    } as Task & { ghl_hybrid?: unknown };
    render(
      <TaskCard
        task={withSummary}
        onDragStart={vi.fn()}
        onClick={vi.fn()}
        isDragging={false}
        columns={[{ id: 'in_progress', label: 'In Progress' }]}
        currentColumnId="in_progress"
        onMove={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ghl-hybrid-chips')).toBeTruthy();
    expect(screen.getByTestId('ghl-chip-blocker').textContent).toContain('Video asset not yet uploaded');
  });

  it('the REAL board card shows the unreadable chip for a corrupt row summary', () => {
    const corrupt = {
      ...baseTask(),
      ghl_hybrid: { operations: [{ operation_id: 'x' }] },
    } as Task & { ghl_hybrid?: unknown };
    render(
      <TaskCard
        task={corrupt}
        onDragStart={vi.fn()}
        onClick={vi.fn()}
        isDragging={false}
        columns={[{ id: 'in_progress', label: 'In Progress' }]}
        currentColumnId="in_progress"
        onMove={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ghl-hybrid-unreadable-chip')).toBeTruthy();
  });
});

// ── Receipt panel fetch states ────────────────────────────────────────────

function stubFetch(response: Partial<Response> & { body?: unknown }) {
  const fn = vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.body,
  }) as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('WF19 receipt panel — absent, broken and valid reads', () => {
  it('renders nothing on 404 (no receipts / surface not deployed) — never a success claim', async () => {
    stubFetch({ ok: false, status: 404 });
    const { container } = render(<GhlHybridPanel taskId="task-1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="ghl-hybrid-progress"]')).toBeNull();
    expect(container.querySelector('[data-testid="ghl-hybrid-panel-error"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('is loud on a 5xx', async () => {
    stubFetch({ ok: false, status: 503, body: {} });
    render(<GhlHybridPanel taskId="task-1" />);
    const panel = await screen.findByTestId('ghl-hybrid-panel-error');
    expect(panel.textContent).toContain('HTTP 503');
  });

  it('is loud on an unparseable body', async () => {
    stubFetch({ ok: true, status: 200, body: { operations: 'nope' } });
    render(<GhlHybridPanel taskId="task-1" />);
    const panel = await screen.findByTestId('ghl-hybrid-panel-unreadable');
    expect(panel.textContent).toMatch(/operations was not an array/);
    expect(screen.queryByTestId('ghl-progress-counts')).toBeNull();
  });

  it('renders the full panel for a valid receipt payload, reading the documented URL', async () => {
    const fetchFn = stubFetch({ ok: true, status: 200, body: payload() });
    render(<GhlHybridPanel taskId="task 1/2" />);
    await screen.findByTestId('ghl-hybrid-progress');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/tasks/task%201%2F2/ghl-operations',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(screen.getByTestId('ghl-progress-counts').textContent).toContain('Verified');
  });
});

// ── Chips in isolation (used by the panel-adjacent surfaces) ───────────────

describe('WF19 chips component', () => {
  it('renders a blocker chip and truncates long text in the chip face', () => {
    const v = viewOf(payload({ current_blocker: 'x'.repeat(80) }));
    render(<GhlHybridChips view={v} />);
    const chip = screen.getByTestId('ghl-chip-blocker');
    expect(chip.textContent).toContain('…');
    expect(chip.getAttribute('title')).toBe('x'.repeat(80));
  });
});
