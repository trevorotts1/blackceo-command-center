/**
 * CC-resear-002 — empty provider response treated as failure, not completed search.
 *
 * THE DEFECT (U087)
 * When runResearch() returns HTTP 200 with an empty answer, the route persisted
 * it as a completed search. The rendered markdown showed "(no answer returned)"
 * but the record counted as real.
 *
 * Tests: empty->502, whitespace->502, ungrounded flag for 0-citation answers.
 * Runs via Node built-in test runner (npm run test:unit).
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';

async function withEnvAsync<T>(
  patch: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const k of Object.keys(patch)) saved.set(k, process.env[k]);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAR: Record<string, undefined> = {};
for (const n of ['PERPLEXITY_FIXTURE_JSON_PATH','OPENAI_FIXTURE_JSON_PATH','OLLAMA_FIXTURE_JSON_PATH','XAI_FIXTURE_JSON_PATH','X_AI_FIXTURE_JSON_PATH']) {
  CLEAR[n] = undefined;
}

function fakeFetch(content: string | null, citations: string[] = []) {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    id: 'f', model: 's',
    choices: [{ message: { content } }],
    citations, usage: { total_tokens: 10 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
}

test('A1: empty answer returns 502', async () => {
  const orig = globalThis.fetch;
  try {
    fakeFetch('');
    const mod = await import('../../src/app/api/operator/research/search/route');
    const req = new Request('http://localhost/api/operator/research/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `e-${Date.now()}`, depth: 'shallow' }),
    }) as any;
    const res = await withEnvAsync({ ...CLEAR, NODE_ENV: 'test', PERPLEXITY_API_KEY: 'k' }, () => (mod as any).POST(req));
    assert.equal(res.status, 502);
    const b = await res.json() as any;
    assert.equal(b.error, 'provider_failed');
    assert.match(b.detail as string, /empty answer/);
  } finally { globalThis.fetch = orig; }
});

test('A2: whitespace-only answer returns 502', async () => {
  const orig = globalThis.fetch;
  try {
    fakeFetch('  \n\t  ');
    const mod = await import('../../src/app/api/operator/research/search/route');
    const req = new Request('http://localhost/api/operator/research/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `w-${Date.now()}`, depth: 'shallow' }),
    }) as any;
    const res = await withEnvAsync({ ...CLEAR, NODE_ENV: 'test', PERPLEXITY_API_KEY: 'k' }, () => (mod as any).POST(req));
    assert.equal(res.status, 502);
    const b = await res.json() as any;
    assert.equal(b.error, 'provider_failed');
  } finally { globalThis.fetch = orig; }
});

test('B1: ungrounded flag on 0-citation answer', async () => {
  const orig = globalThis.fetch;
  try {
    fakeFetch('Valid, no sources.');
    const mod = await import('../../src/app/api/operator/research/search/route');
    const req = new Request('http://localhost/api/operator/research/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `u-${Date.now()}`, depth: 'shallow' }),
    }) as any;
    const res = await withEnvAsync({ ...CLEAR, NODE_ENV: 'test', PERPLEXITY_API_KEY: 'k' }, () => (mod as any).POST(req));
    assert.equal(res.status, 200);
    const b = await res.json() as any;
    assert.ok(b.search_id);
    assert.equal(b.search_metadata.ungrounded, true);
    assert.equal(b.search_metadata.citation_count, 0);
  } finally { globalThis.fetch = orig; }
});

test('C1: normal persistence with citations', async () => {
  const orig = globalThis.fetch;
  try {
    fakeFetch('With sources.', ['https://x.com']);
    const mod = await import('../../src/app/api/operator/research/search/route');
    const req = new Request('http://localhost/api/operator/research/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `c-${Date.now()}`, depth: 'shallow' }),
    }) as any;
    const res = await withEnvAsync({ ...CLEAR, NODE_ENV: 'test', PERPLEXITY_API_KEY: 'k' }, () => (mod as any).POST(req));
    assert.equal(res.status, 200);
    const b = await res.json() as any;
    assert.ok(b.search_id);
    assert.equal(b.search_metadata.citation_count, 1);
    assert.equal(b.search_metadata.ungrounded, undefined);
  } finally { globalThis.fetch = orig; }
});

test('D1: null answer returns 502', async () => {
  const orig = globalThis.fetch;
  try {
    fakeFetch(null);
    const mod = await import('../../src/app/api/operator/research/search/route');
    const req = new Request('http://localhost/api/operator/research/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `n-${Date.now()}`, depth: 'shallow' }),
    }) as any;
    const res = await withEnvAsync({ ...CLEAR, NODE_ENV: 'test', PERPLEXITY_API_KEY: 'k' }, () => (mod as any).POST(req));
    assert.equal(res.status, 502);
    const b = await res.json() as any;
    assert.equal(b.error, 'provider_failed');
  } finally { globalThis.fetch = orig; }
});

test('F1: live regression — normal flow works', async () => {
  const orig = globalThis.fetch;
  try {
    fakeFetch('Real research.', ['https://a.com']);
    const mod = await import('../../src/app/api/operator/research/search/route');
    const req = new Request('http://localhost/api/operator/research/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `l-${Date.now()}`, depth: 'shallow' }),
    }) as any;
    const res = await withEnvAsync({ ...CLEAR, NODE_ENV: 'test', PERPLEXITY_API_KEY: 'k' }, () => (mod as any).POST(req));
    assert.equal(res.status, 200);
    const b = await res.json() as any;
    assert.ok(b.search_id);
    assert.equal(b.provider, 'perplexity');
  } finally { globalThis.fetch = orig; }
});
