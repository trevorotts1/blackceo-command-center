/**
 * U55 — CEO hero single-data-source contract test (acceptance (f)), PURE
 * FUNCTION half.
 *
 * `loadCompanyHeroData` (src/lib/ceo-board/company-health-client.ts) is the
 * ONLY fetch `CompanyHeroCard.tsx` and `NeedsAttentionSection.tsx` perform
 * for headline / attention data. This file proves, at the pure-function
 * level (no React, no DOM):
 *
 *   1. It calls fetch exactly ONCE.
 *   2. It calls fetch against exactly `/api/company-health` — nothing else.
 *   3. It returns the parsed JSON body unmodified.
 *   4. A non-ok response throws (no silent fabrication of a health object).
 *
 * The REAL "fails when a second headline fetch is introduced" mutation
 * proof (acceptance (f)/(4)) lives in
 * tests/unit/u55-company-health-render.test.tsx: it renders the ACTUAL
 * `CompanyHeroCard` / `NeedsAttentionSection` components with a stubbed
 * `global.fetch` and asserts each calls fetch exactly once — a prior
 * version of this file carried a same-named "mutation proof" test here that
 * only exercised its own private fetch-stub function, never the production
 * components; that self-test was removed (QC finding: proves the harness
 * rejects a bad URL, proves nothing about whether the components ever call
 * a second endpoint) in favor of the render-level suite.
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
