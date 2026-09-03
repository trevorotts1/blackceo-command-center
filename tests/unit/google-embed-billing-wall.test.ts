/**
 * Unit tests — Google embeddings: fail-fast on a non-retryable 429 (Fix B)
 *
 * A 429 whose body indicates a BILLING WALL ("prepayment credits are
 * depleted" / "credits are depleted" / "insufficient credits") is a
 * permanent-for-this-account failure, not a transient rate limit — it
 * cannot succeed on retry. fetchEmbeddingGoogle() (private; exercised here
 * through the public fetchEmbedding()) must fail on the FIRST such response
 * with zero retries and zero backoff delay, instead of the previous 4x
 * retry / up to ~7s-of-backoff waste on an error that looks identical on
 * attempt 4 as it did on attempt 1.
 *
 * A genuine rate-limit 429 (no billing marker in the body) must keep the
 * EXISTING exponential-backoff retry behaviour unchanged — this is the
 * fleet-safety regression guard for this file.
 *
 * global.fetch is monkey-patched (matches this repo's existing idiom, e.g.
 * tests/unit/dept-router-embed-cache.test.ts) so this suite makes ZERO real
 * network calls and needs no real API key.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function restoreFetch(): void {
  global.fetch = ORIGINAL_FETCH;
}

function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function setGoogleEnv(): void {
  process.env.SOP_EMBEDDING_PROVIDER = 'google';
  process.env.GOOGLE_API_KEY = 'test-fake-google-key-not-real-0123456789';
  delete process.env.OPENAI_API_KEY;
  delete process.env.EMBEDDING_BREAKER_COOLDOWN_MS;
}

function embedResponse(): Response {
  const values = new Array(3072).fill(0);
  values[0] = 1;
  return new Response(JSON.stringify({ embedding: { values } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rateLimited429(body: string): Response {
  return new Response(body, { status: 429, headers: { 'Content-Type': 'application/json' } });
}

test('fetchEmbedding: Google 429 billing wall ("prepayment credits are depleted") fails on the FIRST attempt — no retries', async (t) => {
  setGoogleEnv();
  const { _closeEmbeddingBreakerForTests } = await import('../../src/lib/sop-embeddings');
  _closeEmbeddingBreakerForTests(); // isolate from any breaker state a prior test in this file left behind

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return rateLimited429(
      JSON.stringify({ error: { message: 'RESOURCE_EXHAUSTED: prepayment credits are depleted for this project' } })
    );
  };
  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const { fetchEmbedding } = await import('../../src/lib/sop-embeddings');

  const start = Date.now();
  await assert.rejects(() => fetchEmbedding('some SOP text'), /prepayment|billing/i);
  const elapsedMs = Date.now() - start;

  assert.equal(calls, 1, `billing wall must fail on the FIRST 429 — no retries (fetch called ${calls}x, want 1)`);
  assert.ok(elapsedMs < 500, `billing wall must fail FAST — no backoff delay (took ${elapsedMs}ms)`);
});

test('fetchEmbedding: a genuine rate-limit 429 (no billing marker) still retries with backoff — fleet-safety regression guard', async (t) => {
  setGoogleEnv();
  const { _closeEmbeddingBreakerForTests } = await import('../../src/lib/sop-embeddings');
  _closeEmbeddingBreakerForTests();

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return rateLimited429(
        JSON.stringify({ error: { message: 'RESOURCE_EXHAUSTED: rate limit exceeded, try again shortly' } })
      );
    }
    return embedResponse();
  };
  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const { fetchEmbedding } = await import('../../src/lib/sop-embeddings');

  const vec = await fetchEmbedding('some SOP text');
  assert.equal(calls, 2, `a transient rate-limit 429 must still retry (fetch called ${calls}x, want 2)`);
  assert.equal(vec.length, 3072);
});

test('fetchEmbedding: a plain 500 (not a 429 at all) is unaffected by the billing-wall check', async (t) => {
  setGoogleEnv();
  const { _closeEmbeddingBreakerForTests } = await import('../../src/lib/sop-embeddings');
  _closeEmbeddingBreakerForTests();

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response('internal error', { status: 500 });
  };
  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const { fetchEmbedding } = await import('../../src/lib/sop-embeddings');

  await assert.rejects(() => fetchEmbedding('some SOP text'), /500/);
  assert.equal(calls, 1, 'a 500 throws immediately today (no retry loop for non-429 errors) — unchanged by this fix');
});
