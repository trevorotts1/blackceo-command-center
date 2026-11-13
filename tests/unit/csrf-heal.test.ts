/**
 * csrf-heal.test.ts — BU-24 (WF-032) acceptance.
 *
 * Proves src/lib/interview/browser-recovery.ts `fetchWithCsrfHeal`:
 *   1. a POST answered 401 gets exactly ONE GET to /api/interview/gate-status
 *      and exactly ONE retry carrying the same body and headers; the 200 wins;
 *   2. a POST answered 401 TWICE yields that second 401 and no third try;
 *   3. any non-401 response is returned untouched, with no heal ping.
 *
 * Global fetch is stubbed; no network, no server, no DB.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { fetchWithCsrfHeal } from '../../src/lib/interview/browser-recovery';

interface Call {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
  headers: HeadersInit | undefined;
}

/** Stub global fetch; POSTs take the next status, GETs always answer 200. */
function installFetch(t: TestContext, postStatuses: number[]): Call[] {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body, headers: init?.headers });
    if (method === 'GET') return new Response('{}', { status: 200 });
    const status = postStatuses.shift() ?? 200;
    return new Response('{}', { status });
  }) as typeof fetch;
  return calls;
}

test('one heal GET and one identical retry after a 401', async (t) => {
  const calls = installFetch(t, [401, 200]);
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' },
    body: JSON.stringify({ questionId: 'company_name', answer: 'Acme' }),
  };

  const res = await fetchWithCsrfHeal('/api/interview/answer', init);
  assert.equal(res.status, 200);

  const posts = calls.filter((c) => c.method === 'POST');
  const heals = calls.filter((c) => c.method === 'GET');
  assert.equal(posts.length, 2, 'exactly two POSTs');
  assert.equal(heals.length, 1, 'exactly one heal GET');
  assert.equal(heals[0].url, '/api/interview/gate-status');
  assert.equal(posts[1].body, posts[0].body, 'retry body is identical');
  assert.equal(
    JSON.stringify(posts[1].headers),
    JSON.stringify(posts[0].headers),
    'retry headers are identical',
  );
});

test('a second 401 is returned and never retried a third time', async (t) => {
  const calls = installFetch(t, [401, 401]);
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  };

  const res = await fetchWithCsrfHeal('/api/interview/complete', init);
  assert.equal(res.status, 401);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 2);
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1);
});

test('a non-401 response is returned untouched with no heal ping', async (t) => {
  const calls = installFetch(t, [200]);

  const res = await fetchWithCsrfHeal('/api/interview/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dept: 'sales', decision: 'yes' }),
  });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1, 'no heal GET, no retry');
});
