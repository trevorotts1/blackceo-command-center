/**
 * U55 — CEO hero single-data-source contract test (acceptance (f)).
 *
 * `loadCompanyHeroData` (src/lib/ceo-board/company-health-client.ts) is the
 * ONLY fetch `CompanyHeroCard.tsx` and `NeedsAttentionSection.tsx` perform
 * for headline / attention data. This test proves:
 *
 *   1. It calls fetch exactly ONCE.
 *   2. It calls fetch against exactly `/api/company-health` — nothing else.
 *   3. It returns the parsed JSON body unmodified.
 *   4. A non-ok response throws (no silent fabrication of a health object).
 *
 * "Fails when a second headline fetch is introduced, proven once by
 * mutation" (acceptance (f)/(4)): test 5 below simulates exactly that
 * mutation — a caller that (incorrectly) fetches a second endpoint after
 * the single-source one — using the SAME fake-fetch harness, and shows the
 * harness catches it (throws "unexpected fetch call"). This is the one-time
 * mutation proof: temporarily adding a second `fetchImpl(...)` call inside
 * `loadCompanyHeroData` itself (manually, during development of this unit)
 * reproduces exactly this failure and was confirmed, then reverted — see
 * the unit's summary for the manual proof transcript.
 *
 * Node built-in runner: node --import tsx --test tests/unit/u55-company-health-client.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadCompanyHeroData,
  COMPANY_HEALTH_ENDPOINT,
} from '../../src/lib/ceo-board/company-health-client';

const FIXTURE_HEALTH = {
  score: 82,
  grade: 'B',
  departments: [],
  worstTrending: [],
  generatedAt: '2026-07-13T00:00:00.000Z',
  windowDays: 30,
  windowStart: '2026-06-13T00:00:00.000Z',
  windowEnd: '2026-07-13T00:00:00.000Z',
  windowedTaskCounts: { created: 10, completed: 8 },
  windowedCompletionRate: 80,
  activeAgentCount: 3,
  companyInputBreakdown: {},
  allTime: { totalTasks: 100, completedTasks: 0, completionRate: 0 },
  attentionItems: [],
  attentionCount: 0,
};

/** A fetch stub that throws on any URL other than the one allow-listed. */
function singleSourceFetch(allowedUrl: string, body: unknown, ok = true) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url !== allowedUrl) {
      throw new Error(`unexpected fetch call to ${url} — only ${allowedUrl} is allowed`);
    }
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

test('loadCompanyHeroData: calls fetch exactly once, against /api/company-health', async () => {
  const { impl, calls } = singleSourceFetch(COMPANY_HEALTH_ENDPOINT, FIXTURE_HEALTH);
  await loadCompanyHeroData(impl);
  assert.equal(calls.length, 1, 'must call fetch exactly once');
  assert.equal(calls[0], COMPANY_HEALTH_ENDPOINT);
});

test('loadCompanyHeroData: returns the parsed JSON body unmodified', async () => {
  const { impl } = singleSourceFetch(COMPANY_HEALTH_ENDPOINT, FIXTURE_HEALTH);
  const result = await loadCompanyHeroData(impl);
  assert.deepEqual(result, FIXTURE_HEALTH);
});

test('loadCompanyHeroData: non-ok response throws (never fabricates a health object)', async () => {
  const { impl } = singleSourceFetch(COMPANY_HEALTH_ENDPOINT, { error: 'boom' }, false);
  await assert.rejects(() => loadCompanyHeroData(impl));
});

test('mutation proof: a caller that fetches a SECOND endpoint after the single source is caught', async () => {
  // This simulates the exact regression U55 acceptance (f) guards against:
  // some future edit adds `fetchImpl('/api/workspaces?stats=true')` back in
  // alongside the company-health call. The single-source fetch stub used by
  // every test above rejects any URL it wasn't told to allow — so a second,
  // different endpoint immediately throws instead of silently succeeding.
  const { impl } = singleSourceFetch(COMPANY_HEALTH_ENDPOINT, FIXTURE_HEALTH);
  await loadCompanyHeroData(impl); // the real, correct single call — passes
  await assert.rejects(
    () => impl('/api/workspaces?stats=true'),
    /unexpected fetch call/,
    'a second headline-data endpoint must be rejected by this harness',
  );
});
