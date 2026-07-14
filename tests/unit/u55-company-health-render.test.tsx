/**
 * U55 acceptance (f) — REAL render-level proof (not a fake-fetch self-test).
 *
 * QC finding this file fixes: the previous "mutation proof" in
 * u55-company-health-client.test.ts (test 4, now removed) never touched
 * production code — it built a duplicate `singleSourceFetch` stub, called
 * `loadCompanyHeroData(impl)` once (the correct call, which passed), then
 * separately called `impl('/api/workspaces?stats=true')` directly against
 * its OWN stub. That proves the test's private stub rejects an unlisted URL;
 * it proves nothing about whether `CompanyHeroCard.tsx` or
 * `NeedsAttentionSection.tsx` themselves ever issue a second fetch.
 *
 * This suite instead:
 *   1. Renders the REAL `CompanyHeroCard` and `NeedsAttentionSection`
 *      components (react-dom via @testing-library/react + jsdom — see
 *      vitest.component.config.ts) with `global.fetch` stubbed.
 *   2. Asserts each component calls `fetch` exactly once, against exactly
 *      `/api/company-health` — any other URL throws inside the stub, so a
 *      regression that adds a second endpoint call is caught by the ACTUAL
 *      component's actual effect, not a parallel harness.
 *   3. Asserts the rendered DOM contains the real windowed numbers from the
 *      fixture response (grade, window-days badge, active-agent count,
 *      tasks-created count, completion rate, attention count) — proving the
 *      component renders from that one response, not a hand-computed value.
 *   4. Cross-checks acceptance (2): the hero's rendered attention count
 *      equals NeedsAttentionSection's rendered item count for the same
 *      fixture (both read `health.attentionItems`/`attentionCount` from the
 *      one response).
 *
 * MUTATION PROOF (acceptance (f)/(4), "proven once by mutation", done
 * against the real component this time): during development of this fix,
 * `src/components/ceo-board/redesign/CompanyHeroCard.tsx`'s `load()` was
 * temporarily edited to add `await fetch('/api/workspaces?stats=true');`
 * immediately after the real `loadCompanyHeroData()` call. Running this
 * suite (`npx vitest run --config vitest.component.config.ts`) against that
 * mutation turned RED on exactly the two tests that render `CompanyHeroCard`
 * through the single-source stub ("fetches /api/company-health exactly
 * once..." and the acceptance-(2) cross-check) — the stubbed fetch threw on
 * the disallowed second URL, the component's existing try/catch swallowed
 * it (same as the "not-ok" path), health stayed null, and the tests' own
 * `waitFor(() => screen.getByText('B'))` then failed with "Unable to find an
 * element with the text: B" (a real timeout on real rendered DOM, not the
 * harness's own throw). The `NeedsAttentionSection` render test, which does
 * not touch the mutated file, stayed green — confirming the failure was
 * scoped to the mutated component, not a suite-wide false positive. The edit
 * was then reverted and this suite re-run to confirm GREEN (4/4). No
 * mutated code shipped; this comment is the record.
 *
 * Vitest (jsdom): npx vitest run --config vitest.component.config.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { CompanyHeroCard } from '../../src/components/ceo-board/redesign/CompanyHeroCard';
import { NeedsAttentionSection } from '../../src/components/ceo-board/redesign/NeedsAttentionSection';
import { COMPANY_HEALTH_ENDPOINT } from '../../src/lib/ceo-board/company-health-client';

const FIXTURE_HEALTH = {
  score: 82,
  grade: 'B',
  departments: [],
  worstTrending: [],
  generatedAt: '2026-07-13T00:00:00.000Z',
  windowDays: 30,
  windowStart: '2026-06-13T00:00:00.000Z',
  windowEnd: '2026-07-13T00:00:00.000Z',
  windowedTaskCounts: { created: 17, completed: 8 },
  windowedCompletionRate: 47,
  activeAgentCount: 5,
  companyInputBreakdown: {},
  allTime: { totalTasks: 100, completedTasks: 40, completionRate: 40 },
  attentionItems: [
    { id: 'att-1', name: 'Sales', slug: 'sales', issue: 'Grade F', severity: 'urgent', grade: 'F', timeContext: 'today' },
    { id: 'att-2', name: 'Support', slug: 'support', issue: '2 blocked tasks', severity: 'warning', grade: 'C', timeContext: 'today' },
  ],
  attentionCount: 2,
};

/**
 * The same discipline as the (removed) old harness's `singleSourceFetch`,
 * but wired to `global.fetch` so the REAL `loadCompanyHeroData` (default
 * `fetchImpl = fetch`) — and therefore the real component — goes through it.
 */
function stubSingleSourceFetch() {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url !== COMPANY_HEALTH_ENDPOINT) {
      throw new Error(`unexpected fetch call to ${url} — only ${COMPANY_HEALTH_ENDPOINT} is allowed`);
    }
    return { ok: true, status: 200, json: async () => FIXTURE_HEALTH } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

function renderComp(el: ReactElement) {
  return render(el);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CompanyHeroCard — real render, single-source proof', () => {
  it('fetches /api/company-health exactly once and renders the real windowed numbers', async () => {
    const { fetchMock, calls } = stubSingleSourceFetch();

    renderComp(<CompanyHeroCard />);

    // Wait for the loading skeleton to resolve into the real card.
    await waitFor(() => expect(screen.getByText('B')).toBeTruthy());

    // Single-source contract, proven against the REAL component's real effect.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([COMPANY_HEALTH_ENDPOINT]);

    // Window badge — proves the component renders the server's window echo,
    // not a hardcoded/guessed value.
    expect(screen.getByText('Last 30 days')).toBeTruthy();

    // Bottom stat pills — real windowed numbers from the fixture.
    expect(screen.getByText('17')).toBeTruthy(); // windowedTaskCounts.created
    expect(screen.getByText('5')).toBeTruthy(); // activeAgentCount
    expect(screen.getByText('47%')).toBeTruthy(); // windowedCompletionRate

    // All-time secondary stat — present, sourced from the same response.
    expect(screen.getByText(/All time: 40% completion \(40 of 100 tasks\)/)).toBeTruthy();

    // Click-through attention count (acceptance (d)/(2)).
    const attentionButton = screen.getByRole('button', { name: /2 items? need attention/i });
    expect(attentionButton).toBeTruthy();
    expect(attentionButton.textContent).toContain('2 items need attention.');
  });

  it('never fabricates a grade when the response is not-ok (never-72 doctrine)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as Response));
    vi.stubGlobal('fetch', fetchMock);

    renderComp(<CompanyHeroCard />);

    await waitFor(() => expect(screen.getAllByText('Insufficient data').length).toBeGreaterThan(0));
    expect(screen.queryByText('B')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('NeedsAttentionSection — real render, single-source proof', () => {
  it('fetches /api/company-health exactly once and renders exactly health.attentionItems', async () => {
    const { fetchMock, calls } = stubSingleSourceFetch();

    renderComp(<NeedsAttentionSection />);

    await waitFor(() => expect(screen.getByText('Needs Attention')).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([COMPANY_HEALTH_ENDPOINT]);

    // Header badge count == list length == FIXTURE_HEALTH.attentionCount.
    const section = screen.getByText('Needs Attention').closest('div')!.parentElement!;
    const badge = within(section).getByText('2');
    expect(badge).toBeTruthy();

    expect(screen.getByText('Grade F')).toBeTruthy();
    expect(screen.getByText('2 blocked tasks')).toBeTruthy();
  });
});

describe('acceptance (2) cross-check: hero attention count == Needs Attention list length', () => {
  it('renders the same count on both surfaces for the same fixture (N=2)', async () => {
    stubSingleSourceFetch();
    renderComp(<CompanyHeroCard />);
    await waitFor(() => expect(screen.getByText('B')).toBeTruthy());
    const heroCount = screen.getByRole('button', { name: /items? need attention/i }).textContent;
    cleanup();

    stubSingleSourceFetch();
    renderComp(<NeedsAttentionSection />);
    await waitFor(() => expect(screen.getByText('Needs Attention')).toBeTruthy());
    const listLength = screen.getAllByText(/Grade F|blocked tasks/).length;

    expect(heroCount).toContain('2 items need attention.');
    expect(listLength).toBe(2);
    expect(FIXTURE_HEALTH.attentionCount).toBe(FIXTURE_HEALTH.attentionItems.length);
  });
});
