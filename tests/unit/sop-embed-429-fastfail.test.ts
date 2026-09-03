/**
 * Unit tests — STAR-EMBED-01: fail fast on a billing-exhausted 429 instead
 * of retrying a call that cannot succeed.
 *
 * Background: on an account with zero Gemini prepay balance, EVERY embed
 * call 429s with a body containing "Your prepayment credits are depleted".
 * The pre-fix fetchEmbeddingGoogle() retried every 429 (this one included)
 * up to GOOGLE_EMBED_MAX_RETRIES times with exponential backoff — a 4x
 * amplifier on a call guaranteed to keep failing, plus ~7s of added latency
 * per dispatch. This suite proves:
 *   1. A billing-exhausted 429 fails on the FIRST fetch call (no retries).
 *   2. A generic 429 (no billing wording — a real transient rate limit)
 *      still retries GOOGLE_EMBED_MAX_RETRIES+1 times exactly as before —
 *      the fast-fail path must not swallow genuine transient failures.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

// C8 — DB isolation MUST happen in an IMPORTED module, and this MUST stay the
// first import (see sop-embedding-provider.test.ts for the full rationale;
// enforced by tests/unit/c8-db-isolation-guard.test.ts).
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';

async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  const allEmbeddingVars = ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_API_KEY', 'SOP_EMBEDDING_PROVIDER'];
  for (const k of allEmbeddingVars) {
    saved[k] = process.env[k];
    if (!(k in vars)) delete process.env[k];
  }
  for (const [key, val] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  try {
    await fn();
  } finally {
    for (const key of [...Object.keys(vars), ...allEmbeddingVars]) {
      const orig = saved[key];
      if (orig === undefined) delete process.env[key];
      else process.env[key] = orig;
    }
  }
}

const BILLING_EXHAUSTED_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing. Learn more at https://ai.google.dev/gemini-api/docs/billing#prepay. ',
    status: 'RESOURCE_EXHAUSTED',
  },
});

const GENERIC_RATE_LIMIT_BODY = JSON.stringify({
  error: {
    code: 429,
    message: 'Resource has been exhausted (e.g. check quota).',
    status: 'RESOURCE_EXHAUSTED',
  },
});

test('fetchEmbedding: billing-exhausted 429 fails on attempt 1 — zero retries', async () => {
  const { fetchEmbedding } = await import('../../src/lib/sop-embeddings');

  let callCount = 0;
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    callCount++;
    return new Response(BILLING_EXHAUSTED_BODY, { status: 429 });
  }) as typeof fetch;

  try {
    await withEnvAsync({ GOOGLE_API_KEY: 'AIza-fastfail-test-long-enough' }, async () => {
      await assert.rejects(
        () => fetchEmbedding('some task text'),
        /prepay balance depleted|not transient/i,
        'must throw a fast-fail error identifying the depleted-balance case',
      );
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(callCount, 1, `billing-exhausted 429 must fail on the FIRST call, got ${callCount} fetch call(s)`);
});

test('fetchEmbedding: generic (non-billing) 429 still retries GOOGLE_EMBED_MAX_RETRIES+1 times', async () => {
  const { fetchEmbedding } = await import('../../src/lib/sop-embeddings');

  let callCount = 0;
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    callCount++;
    return new Response(GENERIC_RATE_LIMIT_BODY, { status: 429 });
  }) as typeof fetch;

  try {
    await withEnvAsync({ GOOGLE_API_KEY: 'AIza-retry-preserved-test-long-enough' }, async () => {
      await assert.rejects(
        () => fetchEmbedding('some other task text'),
        /quota exceeded.*after \d+ retries/i,
        'a genuine transient 429 must still exhaust the existing retry budget, not fast-fail',
      );
    });
  } finally {
    global.fetch = originalFetch;
  }

  // GOOGLE_EMBED_MAX_RETRIES is 3 -> attempts 0..3 inclusive = 4 calls.
  assert.equal(callCount, 4, `a transient 429 must still retry the full budget, got ${callCount} fetch call(s)`);
});

test('fetchEmbedding: a successful call after the fast-fail path still works (feature not broken)', async () => {
  const { fetchEmbedding } = await import('../../src/lib/sop-embeddings');

  const originalFetch = global.fetch;
  global.fetch = (async () => {
    const values = new Array(3072).fill(0);
    values[0] = 1;
    return new Response(JSON.stringify({ embedding: { values } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await withEnvAsync({ GOOGLE_API_KEY: 'AIza-still-works-test-long-enough' }, async () => {
      const vec = await fetchEmbedding('a task once credits are restored');
      assert.equal(vec.length, 3072, 'a healthy account must still get a real embedding back');
      assert.equal(vec[0], 1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});
