/**
 * U104 (E4-7, master spec v2 §E4/L2382) acceptance — REAL render-level proof
 * of engine-mirrored card honesty in the GatePanel-adjacent modal surfaces:
 *
 *   (a) GatePanel's Work zone no longer sends the producer to the
 *       Deliverables tab for artifacts that tab can never carry (VERIFIED:
 *       /api/tasks/[id]/deliverables reads ONLY `task_deliverables`, a table
 *       the Anthology Engine never writes to) — populated + honest-fallback.
 *   (b) "Start Planning" is gated off for an anthology-sourced card with an
 *       honest engine notice in its place; an ordinary task's Start Planning
 *       flow is unchanged (regression).
 *   (c) The Activity / Deliverables / Sessions tabs render a card-type-aware
 *       honest empty state for a recognized board-producer source instead of
 *       the generic copy, for every recognized family (anthology + the three
 *       Skill 6 sources) — never on a populated list (never hides real data),
 *       never on an ordinary task (regression, unchanged original copy).
 *
 * Renders the REAL components (react-dom via @testing-library/react + jsdom
 * — see vitest.component.config.ts), never a hand-rolled restatement.
 *
 *   npx vitest run --config vitest.component.config.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { GatePanel } from '../../src/components/anthology/GatePanel';
import { PlanningTab } from '../../src/components/PlanningTab';
import { ActivityLog } from '../../src/components/ActivityLog';
import { DeliverablesList } from '../../src/components/DeliverablesList';
import { SessionsList } from '../../src/components/SessionsList';
import type { TaskDeliverable, TaskActivity } from '../../src/lib/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// --------------------------------------------------------------------------- //
// Shared fetch router — every component under test here talks to a handful of
// GET endpoints; route by URL prefix and return canned JSON, exactly like a
// real fetch Response for the subset each component actually reads (.ok,
// .status, .json()).
// --------------------------------------------------------------------------- //

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function routedFetch(routes: Array<[string, unknown]>, fallback: unknown = []) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, body] of routes) {
      if (url.startsWith(prefix)) return jsonRes(body);
    }
    return jsonRes(fallback);
  });
}

// --------------------------------------------------------------------------- //
// (a) GatePanel — Work zone honesty
// --------------------------------------------------------------------------- //

const ANTHOLOGY_DESC_NO_ARTIFACTS =
  'Participant chapter card.\n\n' +
  '— Captured via task-ingest —\n' +
  'Source: anthology\n' +
  'Ref: anthology:card:contact_ABC123::anth_XYZ\n\n' +
  '[status → in_progress @ 2026-07-01T10:00:00Z] stage_cursor=s2_tone';

const ANTHOLOGY_DESC_WITH_ARTIFACTS =
  ANTHOLOGY_DESC_NO_ARTIFACTS +
  '\n\nDeliverables: https://drive.example.com/chapter.pdf and ' +
  'https://docs.google.com/document/d/abc/edit';

function anthologyTask(description: string) {
  return {
    id: 'task-1',
    title: 'Anthology chapter — Jordan Rivers · anth_XYZ',
    description,
    source: 'anthology',
    status: 'in_progress',
    updated_at: '2026-07-01T10:00:00Z',
    created_at: '2026-07-01T10:00:00Z',
  };
}

describe('GatePanel — Work zone honesty (U104 item a)', () => {
  it('honest-fallback: no artifacts renders the corrected copy — never sends the producer to the Deliverables tab', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch([
        ['/api/anthology/gate', { ok: false, reason: 'not_ready' }],
        ['/api/tasks/task-1/activities', []],
      ]),
    );
    render(<GatePanel task={anthologyTask(ANTHOLOGY_DESC_NO_ARTIFACTS)} />);

    const empty = await screen.findByText(/No deliverable is posted for this stage yet/);
    // The FALSE claim this unit fixes must be gone.
    expect(empty.textContent).not.toMatch(/full artifact list is on the Deliverables tab/);
    // The honest replacement: deliverables live in THIS zone, not that tab.
    expect(empty.textContent).toMatch(/this Work section is where/i);
    expect(empty.textContent).toMatch(/Deliverables tab/);
  });

  it('populated: artifact links still render exactly as before (regression)', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch([
        ['/api/anthology/gate', { ok: false, reason: 'not_ready' }],
        ['/api/tasks/task-1/activities', []],
      ]),
    );
    render(<GatePanel task={anthologyTask(ANTHOLOGY_DESC_WITH_ARTIFACTS)} />);

    expect(await screen.findByText('Open the PDF')).toBeTruthy();
    expect(screen.getByText('Open the editable Doc')).toBeTruthy();
    // The empty-state copy must not appear alongside real artifacts.
    expect(screen.queryByText(/No deliverable is posted/)).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// (b) PlanningTab — Start Planning gated off for an engine card
// --------------------------------------------------------------------------- //

describe('PlanningTab — Start Planning gating (U104 item b)', () => {
  it('an engine-notice card renders the honest notice, never the Start Planning button', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch([
        ['/api/tasks/task-1/planning', { isStarted: false, messages: [], isComplete: false }],
      ]),
    );
    render(<PlanningTab taskId="task-1" engineNotice="the Anthology Engine" />);

    const notice = await screen.findByTestId('planning-engine-notice');
    expect(notice.textContent).toMatch(/Driven by the Anthology Engine/);
    expect(notice.textContent).toMatch(/conflicting plan/i);
    expect(screen.queryByText('Start Planning')).toBeNull();
  });

  it('an ordinary task (no engineNotice) keeps the ORIGINAL Start Planning flow unchanged (regression)', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch([
        ['/api/tasks/task-2/planning', { isStarted: false, messages: [], isComplete: false }],
      ]),
    );
    render(<PlanningTab taskId="task-2" />);

    expect(await screen.findByRole('button', { name: 'Start Planning' })).toBeTruthy();
    expect(screen.queryByTestId('planning-engine-notice')).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// (c) Activity / Deliverables / Sessions tabs — card-type-aware empty states
// --------------------------------------------------------------------------- //

describe('ActivityLog — engine-card honesty (U104 item c)', () => {
  it('empty + engine label renders the honest copy, no blank/generic state', async () => {
    vi.stubGlobal('fetch', routedFetch([['/api/tasks/task-1/activities', []]]));
    render(<ActivityLog taskId="task-1" engineLabel="the Anthology Engine" />);
    const empty = await screen.findByTestId('engine-card-empty-activity');
    expect(empty.textContent).toMatch(/Captured via the Anthology Engine/);
  });

  it('empty + a DIFFERENT recognized family (Skill 6 funnel) renders ITS OWN honest copy', async () => {
    vi.stubGlobal('fetch', routedFetch([['/api/tasks/task-1/activities', []]]));
    render(<ActivityLog taskId="task-1" engineLabel="a Skill 6 funnel build" />);
    const empty = await screen.findByTestId('engine-card-empty-activity');
    expect(empty.textContent).toMatch(/Captured via a Skill 6 funnel build/);
  });

  it('empty + no engine label keeps the ORIGINAL generic copy (regression)', async () => {
    vi.stubGlobal('fetch', routedFetch([['/api/tasks/task-1/activities', []]]));
    render(<ActivityLog taskId="task-1" />);
    expect(await screen.findByText('No activity yet')).toBeTruthy();
    expect(screen.queryByTestId('engine-card-empty-activity')).toBeNull();
  });

  it('populated: real activity always renders, even on an engine card (never hidden)', async () => {
    const rows: TaskActivity[] = [
      {
        id: 'a1',
        task_id: 'task-1',
        activity_type: 'updated',
        message: 'Real activity row',
        created_at: '2026-07-01T10:00:00Z',
      },
    ];
    vi.stubGlobal('fetch', routedFetch([['/api/tasks/task-1/activities', rows]]));
    render(<ActivityLog taskId="task-1" engineLabel="the Anthology Engine" />);
    expect(await screen.findByText('Real activity row')).toBeTruthy();
    expect(screen.queryByTestId('engine-card-empty-activity')).toBeNull();
  });
});

describe('DeliverablesList — engine-card honesty (U104 item c)', () => {
  it('empty + engine label renders the honest copy', async () => {
    vi.stubGlobal('fetch', routedFetch([['/api/tasks/task-1/deliverables', []]]));
    render(<DeliverablesList taskId="task-1" engineLabel="the Anthology Engine" />);
    const empty = await screen.findByTestId('engine-card-empty-deliverables');
    expect(empty.textContent).toMatch(/Captured via the Anthology Engine/);
  });

  it('empty + no engine label keeps the ORIGINAL generic copy (regression)', async () => {
    vi.stubGlobal('fetch', routedFetch([['/api/tasks/task-1/deliverables', []]]));
    render(<DeliverablesList taskId="task-1" />);
    expect(await screen.findByText('No deliverables yet')).toBeTruthy();
    expect(screen.queryByTestId('engine-card-empty-deliverables')).toBeNull();
  });

  it('populated: real deliverables always render, even on an engine card (never hidden)', async () => {
    const rows: TaskDeliverable[] = [
      {
        id: 'd1',
        task_id: 'task-1',
        deliverable_type: 'url',
        title: 'Real deliverable',
        path: 'https://example.com/x',
        created_at: '2026-07-01T10:00:00Z',
      },
    ];
    vi.stubGlobal('fetch', routedFetch([['/api/tasks/task-1/deliverables', rows]]));
    render(<DeliverablesList taskId="task-1" engineLabel="the Anthology Engine" />);
    expect(await screen.findByText('Real deliverable')).toBeTruthy();
    expect(screen.queryByTestId('engine-card-empty-deliverables')).toBeNull();
  });
});

describe('SessionsList — engine-card honesty (U104 item c)', () => {
  it('empty + engine label renders the honest copy', async () => {
    vi.stubGlobal('fetch', routedFetch([['/api/tasks/task-1/subagent', []]]));
    render(<SessionsList taskId="task-1" engineLabel="the Anthology Engine" />);
    const empty = await screen.findByTestId('engine-card-empty-sessions');
    expect(empty.textContent).toMatch(/Captured via the Anthology Engine/);
  });

  it('empty + no engine label keeps the ORIGINAL generic copy (regression)', async () => {
    vi.stubGlobal('fetch', routedFetch([['/api/tasks/task-1/subagent', []]]));
    render(<SessionsList taskId="task-1" />);
    expect(await screen.findByText('No sub-agent sessions yet')).toBeTruthy();
    expect(screen.queryByTestId('engine-card-empty-sessions')).toBeNull();
  });
});
