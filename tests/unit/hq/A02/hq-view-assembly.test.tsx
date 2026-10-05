/**
 * A02 — /hq view assembly real render proof.
 *
 * Proves the A02 seams (not the child units' own behavior, each proven by its
 * own judge): the composed page renders the REAL reviewed components against
 * the REAL `useHqState` hook shape, with a stubbed fetch — no server, no live
 * gateway — and:
 *  - renders the shell chrome (HeadquartersShell), the floor slot, the feed
 *    and the inspector from one authorized snapshot;
 *  - wires a validated scope (company/department/task) and carries an
 *    unrelated board filter through to the Board href (S4);
 *  - drops a malformed selector instead of forwarding it (S7);
 *  - preserves selection by ID and returns to the department with a notice
 *    when the entity is removed (S4);
 *  - clears private state (inspector selection + notice) on a company switch
 *    (S8 step 6);
 *  - renders an honest failure, never an empty office, when the snapshot fails
 *    (S8 step 7);
 *  - passes an empty handoff list to the floor (movement-truth carry: the
 *    public projection carries no validated walk fact, so nothing may draw).
 *
 * Runs via: npx vitest run --config vitest.a02-view.config.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

const push = vi.fn();
const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => searchParams,
}));

import HeadquartersPage from '../../../../src/app/hq/page';
import type { HqDepartment, HqSnapshotResponse } from '../../../../src/lib/hq/types';

/* ---------------- fixtures (shapes exactly as the frozen contract) ---------------- */

function agent(over: Partial<HqDepartment['agents'][number]> & { id: string }): HqDepartment['agents'][number] {
  return {
    workspaceId: 'dept-marketing',
    displayName: over.id,
    role: 'Specialist',
    isHead: false,
    staffing: 'permanent',
    runtimeBound: true,
    canTalk: true,
    runtimeAgentId: `rt-${over.id}`,
    bindingKind: 'explicit',
    sharedRoleIds: [],
    status: 'standby',
    observedAt: '2026-10-04T00:00:00.000Z',
    activeTaskIds: [],
    ...over,
  };
}

const MARKETING: HqDepartment = {
  id: 'dept-marketing',
  slug: 'marketing',
  name: 'Marketing',
  headAgentId: 'a-mkt-head',
  provisioning: 'ready',
  agents: [
    agent({ id: 'a-mkt-head', displayName: 'Dana', isHead: true, role: 'Marketing head', activeTaskIds: ['task-7'] }),
    agent({ id: 'a-mkt-1', displayName: 'Ravi', status: 'degraded' }),
  ],
};

const SALES: HqDepartment = {
  id: 'dept-sales',
  slug: 'sales',
  name: 'Sales',
  headAgentId: null,
  provisioning: 'incomplete',
  agents: [agent({ id: 'a-sales-1', workspaceId: 'dept-sales', staffing: 'on-call', status: 'unknown' })],
};

function snapshot(roster: HqDepartment[] = [MARKETING, SALES]): HqSnapshotResponse {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-04T00:00:00.000Z',
    companyId: 'co-1',
    roster,
    layout: { revision: 'rev-1', rooms: [] },
    captureHealth: null,
    taskLinks: null,
    activities: [],
    highSeq: 0,
    prunedThroughSeq: 0,
    layoutRevision: 'rev-1',
  };
}

const okFetch = (body: unknown) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

beforeEach(() => {
  push.mockClear();
  replace.mockClear();
  searchParams = new URLSearchParams();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubViewport(matchesPhone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matchesPhone,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe('A02 assembly — real components composed from one authorized snapshot', () => {
  it('renders shell chrome, the floor slot, the feed and the inspector (S4)', async () => {
    stubViewport(false);
    vi.stubGlobal('fetch', okFetch(snapshot()));
    render(<HeadquartersPage />);

    // HeadquartersShell chrome: company title, Board link, Floor/List tabs.
    await waitFor(() => expect(screen.getByTestId('hq-view-tabs')).toBeTruthy());
    expect(screen.getByText('co-1 Headquarters')).toBeTruthy();
    // Floor slot (B23) composed inside the shell with the real layout.
    expect(screen.getByTestId('hq-floor-slot')).toBeTruthy();
    // Feed (B26) and inspector (B27) present from the same snapshot.
    expect(screen.getByTestId('hq-activity-feed')).toBeTruthy();
    expect(screen.getByTestId('hq-inspector')).toBeTruthy();
  });

  it('wires validated scope and carries an unrelated board filter to the Board link (S4)', async () => {
    stubViewport(false);
    vi.stubGlobal('fetch', okFetch(snapshot()));
    searchParams = new URLSearchParams('company=co-1&department=dept-marketing&status=blocked');
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-picker-trigger')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-view-tab-list'));
    });
    // The URL-carried selection marks the department row as current.
    await waitFor(() => expect(screen.getByTestId('hq-list-department-dept-marketing')).toBeTruthy());
    const href = screen.getByTestId('hq-board-link').getAttribute('href') ?? '';
    expect(href.startsWith('/tasks/by-department?')).toBe(true);
    const query = new URLSearchParams(href.split('?')[1]);
    expect(query.get('company')).toBe('co-1');
    expect(query.get('department')).toBe('dept-marketing');
    expect(query.get('status')).toBe('blocked');
    expect(query.getAll('company')).toEqual(['co-1']);
  });

  it('drops a malformed selector instead of forwarding it (S7)', async () => {
    stubViewport(false);
    vi.stubGlobal('fetch', okFetch(snapshot()));
    searchParams = new URLSearchParams('company=co-1&department=dept%20x');
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-view-tabs')).toBeTruthy());
    // The malformed department never becomes a Board filter or a selection:
    // no department row is marked current and the inspector shows its empty
    // state (the shell's panel chrome itself always renders).
    await waitFor(() => expect(replace).toHaveBeenCalled());
    const last = replace.mock.calls[replace.mock.calls.length - 1][0] as string;
    expect(last).not.toContain('department=');
    expect(screen.queryByTestId('hq-inspector-agent')).toBeNull();
    expect(screen.queryByTestId('hq-inspector-department')).toBeNull();
    expect(screen.getByTestId('hq-inspector-empty')).toBeTruthy();
  });

  it('selects an agent, shows the inspector, and returns with a notice when removed (S4)', async () => {
    stubViewport(false);
    let rosterNow: HqDepartment[] = [MARKETING, SALES];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => snapshot(rosterNow) })));
    searchParams = new URLSearchParams('company=co-1&department=dept-marketing');
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-view-tabs')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-view-tab-list'));
    });
    await waitFor(() => expect(screen.getByTestId('hq-list-department-dept-marketing')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-list-department-dept-marketing'));
    });
    await waitFor(() => expect(screen.getByTestId('hq-list-agent-a-mkt-1')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-list-agent-a-mkt-1'));
    });
    // Inspector (B27) shows the selected agent.
    await waitFor(() => expect(screen.getByTestId('hq-inspector-agent')).toBeTruthy());

    // Roster change drops the selected agent, not the department: the shell's
    // Retry control re-runs the snapshot, and the reconcile raises the notice
    // and returns to the department.
    rosterNow = [{ ...MARKETING, agents: [MARKETING.agents[0]] }];
    await waitFor(() => expect(screen.getByText('Retry')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByText('Retry'));
    });
    await waitFor(() => expect(screen.getByTestId('hq-notice')).toBeTruthy());
    expect(screen.getByTestId('hq-notice').textContent).toContain('no longer in this department');
    expect(screen.queryByTestId('hq-inspector-agent')).toBeNull();
  });

  it('clears private selection state on a company switch (S8 step 6)', async () => {
    stubViewport(false);
    vi.stubGlobal('fetch', okFetch(snapshot()));
    searchParams = new URLSearchParams('company=co-1&department=dept-marketing');
    const view = render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-view-tabs')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-view-tab-list'));
    });
    await waitFor(() => expect(screen.getByTestId('hq-list-department-dept-marketing')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-list-department-dept-marketing'));
    });
    await waitFor(() => expect(screen.getByTestId('hq-list-agent-a-mkt-head')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-list-agent-a-mkt-head'));
    });
    await waitFor(() => expect(screen.getByTestId('hq-inspector-agent')).toBeTruthy());

    const second = snapshot();
    second.companyId = 'co-2';
    vi.stubGlobal('fetch', okFetch(second));
    searchParams = new URLSearchParams('company=co-2');
    act(() => {
      view.rerender(<HeadquartersPage />);
    });
    await waitFor(() => expect(screen.queryByTestId('hq-inspector-agent')).toBeNull());
  });

  it('renders an honest failure, not an empty office, when the snapshot fails (S8 step 7)', async () => {
    stubViewport(false);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    render(<HeadquartersPage />);
    // Honest failure: the shell never mounts (no connection line, no floor
    // slot, no feed) — the error surface is the whole story.
    await waitFor(() => expect(screen.getByTestId('hq-load-error')).toBeTruthy());
    expect(screen.queryByTestId('hq-connection')).toBeNull();
    expect(screen.queryByTestId('hq-floor-slot')).toBeNull();
    expect(screen.queryByTestId('hq-activity-feed')).toBeNull();
  });

  it('defaults a phone viewport to List with Floor still available (S11)', async () => {
    stubViewport(true);
    vi.stubGlobal('fetch', okFetch(snapshot()));
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-view-tabs')).toBeTruthy());
    expect(screen.getByTestId('hq-view-tab-list').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('hq-view-tab-floor').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('hq-list')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByTestId('hq-view-tab-floor'));
    });
    expect(screen.getByTestId('hq-view-tab-floor').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('hq-floor-slot')).toBeTruthy();
  });

  it('passes no invented walks to the floor (movement-truth carry)', async () => {
    stubViewport(false);
    const withActivity = snapshot();
    withActivity.activities = [
      {
        id: 'ev-1',
        seq: 1,
        kind: 'task',
        phase: 'created',
        taskId: null,
        actorLabel: 'Dana',
        recipientLabel: null,
        occurredAt: null,
        receivedAt: '2026-10-04T00:00:00.000Z',
        reference: 'activity:1',
        payload: { status: 'backlog', previousStatus: null },
      },
    ];
    withActivity.highSeq = 1;
    vi.stubGlobal('fetch', okFetch(withActivity));
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-floor-slot')).toBeTruthy());
    // A bare task creation without sender evidence draws no walk.
    expect(screen.queryByTestId('hq-handoff-overlays')).toBeNull();
    expect(screen.getByTestId('hq-activity-row')).toBeTruthy();
  });

  it('closes the open chat when selection leaves the opened head (A02-F2)', async () => {
    stubViewport(false);
    // Two headed departments: moving from Dana (Marketing head) to Eli
    // (Sales head) is the discriminating case — the unfixed page relabels
    // the open panel to Eli while sess-1 still belongs to Dana.
    const headedSales: HqDepartment = {
      id: 'dept-sales',
      slug: 'sales',
      name: 'Sales',
      headAgentId: 'a-sales-head',
      provisioning: 'ready',
      agents: [
        agent({
          id: 'a-sales-head',
          workspaceId: 'dept-sales',
          displayName: 'Eli',
          isHead: true,
          role: 'Sales head',
        }),
      ],
    };
    const body = snapshot([MARKETING, headedSales]);
    const routedFetch = async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url === '/api/hq/chat/sessions' && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ session: { id: 'sess-1' } }) };
      }
      if (url.startsWith('/api/hq/chat/sessions/sess-1')) {
        return { ok: true, status: 200, json: async () => ({ turns: [] }) };
      }
      return { ok: true, status: 200, json: async () => body };
    };
    vi.stubGlobal('fetch', vi.fn(routedFetch) as unknown as typeof fetch);
    searchParams = new URLSearchParams('company=co-1&department=dept-marketing');
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-view-tabs')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-view-tab-list'));
    });
    await waitFor(() => expect(screen.getByTestId('hq-list-department-dept-marketing')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-list-department-dept-marketing'));
    });
    await waitFor(() => expect(screen.getByTestId('hq-list-agent-a-mkt-head')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-list-agent-a-mkt-head'));
    });
    // The Talk button opens a session with Marketing head Dana.
    await waitFor(() => expect(screen.getByTestId('hq-talk-to-head')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-talk-to-head'));
    });
    await waitFor(() => expect(screen.getByTestId('hq-head-chat')).toBeTruthy());
    expect(screen.getByTestId('hq-head-chat').textContent).toContain('Dana');

    // Moving selection to another department closes the private panel: the
    // header must never relabel to a head the session does not belong to.
    act(() => {
      fireEvent.click(screen.getByTestId('hq-list-department-dept-sales'));
    });
    await waitFor(() => expect(screen.queryByTestId('hq-head-chat')).toBeNull());
  });
});
