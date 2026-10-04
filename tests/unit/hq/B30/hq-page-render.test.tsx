/**
 * B30 — /hq route composition/controller real render proof (Q09/Q11 slice).
 *
 * Proves the controller this unit owns, against the frozen contracts
 * (`src/lib/hq/types.ts`) with a stubbed fetch — no server, no live gateway:
 *  - scope: validated search params in, Board link carrying company/department/task
 *    plus every unrelated supported board filter out (SPEC S4);
 *  - selection: preserved by ID, removed entity → notice + return to department
 *    (SPEC S4);
 *  - company switch: private state cleared before any new-scope bytes (SPEC S8
 *    step 6; Q11);
 *  - view mode: phone (<768 px) defaults to List, Floor stays available (S11);
 *  - honest load: a failed snapshot renders an error, never an empty office
 *    (SPEC S8 step 7).
 *
 * Runs via: npx vitest run --config vitest.b30-render.config.ts
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

/* ---------------- controller unit checks, driven through the page ---------------- */

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

describe('B30 controller — scope, selection, Board link, view mode', () => {
  it('accepts validated scope ids and drops a malformed selector instead of forwarding it (S7)', async () => {
    vi.stubGlobal('fetch', okFetch(snapshot()));
    searchParams = new URLSearchParams('company=co-1&department=dept%20x&task=ok-1');
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-floor-rooms')).toBeTruthy());
    // the malformed department selector is never used as a scope
    expect(screen.queryByTestId('hq-scope-department')).toBeNull();
    // and the rewrite states the scope the server actually authorized
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/hq?company=co-1&task=ok-1', { scroll: false }));
  });

  it('writes the authorized scope back to the URL and carries unrelated board filters to the Board link (S4)', async () => {
    vi.stubGlobal('fetch', okFetch(snapshot()));
    searchParams = new URLSearchParams('company=co-1&department=dept-marketing&status=blocked');
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-scope-department')).toBeTruthy());
    expect(screen.getByTestId('hq-scope-department').textContent).toContain('Marketing');

    const href = screen.getByTestId('hq-tab-board').getAttribute('href') ?? '';
    expect(href.startsWith('/tasks/by-department?')).toBe(true);
    const query = new URLSearchParams(href.split('?')[1]);
    expect(query.get('company')).toBe('co-1');
    expect(query.get('department')).toBe('dept-marketing');
    expect(query.get('task')).toBeNull();
    // unrelated supported filter survives the round trip, and the scoped key is not duplicated
    expect(query.get('status')).toBe('blocked');
    expect(query.getAll('company')).toEqual(['co-1']);
  });

  it('preserves selection by ID and returns to the department with a notice when the entity is removed (S4)', async () => {
    let rosterNow: HqDepartment[] = [MARKETING, SALES];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => snapshot(rosterNow) })));
    searchParams = new URLSearchParams('company=co-1&department=dept-marketing');
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-agent-a-mkt-1')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-agent-a-mkt-1'));
    });
    expect(screen.getByTestId('hq-agent-detail').textContent).toContain('Ravi');
    // roster change drops the selected agent, not the department
    rosterNow = [{ ...MARKETING, agents: [MARKETING.agents[0]] }];
    act(() => {
      fireEvent.click(screen.getByTestId('hq-refresh'));
    });

    await waitFor(() => expect(screen.getByTestId('hq-notice')).toBeTruthy());
    expect(screen.getByTestId('hq-notice').textContent).toContain('no longer in this department');
    expect(screen.queryByTestId('hq-agent-detail')).toBeNull();
    expect(screen.getByTestId('hq-agent-list')).toBeTruthy();
    // still the same department, selected by ID
    expect(screen.getByTestId('hq-room-dept-marketing').getAttribute('aria-pressed')).toBe('true');
  });

  it('defaults a phone viewport to List with Floor still available (S11)', async () => {
    stubViewport(true);
    vi.stubGlobal('fetch', okFetch(snapshot()));
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-view-control')).toBeTruthy());
    expect(screen.getByTestId('hq-view-list').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('hq-view-floor').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('hq-department-list')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByTestId('hq-view-floor'));
    });
    expect(screen.getByTestId('hq-floor-rooms')).toBeTruthy();
    expect(screen.getByTestId('hq-view-floor').getAttribute('aria-selected')).toBe('true');
  });

  it('defaults a desktop viewport to Floor (S11)', async () => {
    stubViewport(false);
    vi.stubGlobal('fetch', okFetch(snapshot()));
    render(<HeadquartersPage />);
    await waitFor(() => expect(screen.getByTestId('hq-view-control')).toBeTruthy());
    expect(screen.getByTestId('hq-view-floor').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('hq-floor-rooms')).toBeTruthy();
  });
});

/* ---------------- page transitions (Q09/Q11 fixture journey) ---------------- */

describe('B30 page — fixture transitions', () => {
  it('renders an honest failure, not an empty office, when the snapshot fails (S8 step 7)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    render(<HeadquartersPage />);
    await waitFor(() => expect(screen.getByTestId('hq-load-error')).toBeTruthy());
    expect(screen.getByTestId('hq-connection').textContent).toContain('Disconnected');
    expect(screen.queryByTestId('hq-floor-rooms')).toBeNull();
  });

  it('routes department selection and restores it from the URL on the next visit (S4 selection by ID)', async () => {
    vi.stubGlobal('fetch', okFetch(snapshot()));
    searchParams = new URLSearchParams('company=co-1&department=dept-sales&task=task-9&status=blocked');
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-room-dept-sales')).toBeTruthy());
    // the URL's department/task selection is restored on this visit (S4 by ID)
    expect(screen.getByTestId('hq-room-dept-sales').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('hq-room-dept-marketing').getAttribute('aria-pressed')).toBe('false');

    // the Board link carries that same scoped selection plus the unrelated filter
    const boardHrefBefore = screen.getByTestId('hq-tab-board').getAttribute('href') ?? '';
    expect(boardHrefBefore).toContain('department=dept-sales');
    expect(boardHrefBefore).toContain('task=task-9');
    expect(boardHrefBefore).toContain('status=blocked');

    act(() => {
      fireEvent.click(screen.getByTestId('hq-room-dept-marketing'));
    });
    // changing department drops the task selection that belonged to the old one
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/hq?company=co-1&department=dept-marketing', { scroll: false }),
    );
    const boardHref = screen.getByTestId('hq-tab-board').getAttribute('href') ?? '';
    expect(boardHref).toContain('department=dept-marketing');
    expect(boardHref).not.toContain('task=');
  });

  it('shows the honest notice and returns to the department when the roster drops the selection', async () => {
    let rosterNow: HqDepartment[] = [MARKETING, SALES];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => snapshot(rosterNow) })),
    );
    searchParams = new URLSearchParams('company=co-1&department=dept-marketing');
    render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-agent-a-mkt-1')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-agent-a-mkt-1'));
    });
    expect(screen.getByTestId('hq-agent-detail')).toBeTruthy();

    // roster change: the selected agent is gone on the next authorized snapshot
    rosterNow = [{ ...MARKETING, agents: [MARKETING.agents[0]] }];
    act(() => {
      fireEvent.click(screen.getByTestId('hq-refresh'));
    });
    await waitFor(() => expect(screen.getByTestId('hq-notice')).toBeTruthy());
    expect(screen.queryByTestId('hq-agent-detail')).toBeNull();
    expect(screen.getByTestId('hq-agent-list')).toBeTruthy();
  });

  it('clears private state before rendering a different company scope (S8 step 6; Q11)', async () => {
    vi.stubGlobal('fetch', okFetch(snapshot()));
    searchParams = new URLSearchParams('company=co-1&department=dept-marketing');
    const view = render(<HeadquartersPage />);

    await waitFor(() => expect(screen.getByTestId('hq-room-dept-marketing')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-agent-a-mkt-head'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('hq-talk-to-head'));
    });
    expect(screen.getByTestId('hq-chat-slot')).toBeTruthy();

    // scope switch: a new company comes back from the same endpoint
    const second = snapshot();
    second.companyId = 'co-2';
    vi.stubGlobal('fetch', okFetch(second));
    searchParams = new URLSearchParams('company=co-2');
    act(() => {
      view.rerender(<HeadquartersPage />);
    });
    act(() => {
      fireEvent.click(screen.getByTestId('hq-refresh'));
    });

    await waitFor(() => expect(screen.queryByTestId('hq-chat-slot')).toBeNull());
    expect(screen.queryByTestId('hq-agent-detail')).toBeNull();
    expect(screen.getByTestId('hq-room-dept-sales').getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps Floor reachable from the phone default and switches without losing selection (S11)', async () => {
    vi.stubGlobal('fetch', okFetch(snapshot()));
    render(<HeadquartersPage />);
    await waitFor(() => expect(screen.getByTestId('hq-view-control')).toBeTruthy());

    act(() => {
      fireEvent.click(screen.getByTestId('hq-view-list'));
    });
    expect(screen.getByTestId('hq-view-list').getAttribute('aria-selected')).toBe('true');
    act(() => {
      fireEvent.click(screen.getByTestId('hq-view-floor'));
    });
    expect(screen.getByTestId('hq-view-floor').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('hq-floor-rooms')).toBeTruthy();
  });

  it('states setup state for an incomplete company instead of fabricating a workforce', async () => {
    vi.stubGlobal('fetch', okFetch(snapshot([SALES])));
    render(<HeadquartersPage />);
    await waitFor(() => expect(screen.getByTestId('hq-room-dept-sales')).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId('hq-room-dept-sales'));
    });
    expect(screen.getByTestId('hq-agent-status-a-sales-1').textContent).toContain('Status not observed');
    expect(screen.getByTestId('hq-agent-a-sales-1').textContent).toContain('On call');
  });
});
