/**
 * fix/gemini-error-label — accurate failure labels in src/lib/gemini.ts.
 *
 * THE DEFECT (live-proven on a real box): the fail-loud error wrapped EVERY
 * generation failure in "(model '<id>' retired or unavailable?)". A 429
 * billing wall ("Your prepayment credits are depleted") against a healthy
 * model id got that suffix — the model is fine, the account is empty.
 *
 * THE FIX: classify before labelling. Model-problem (404 / "not found for
 * API version" / "unknown model" / "does not exist" / "not supported") keeps
 * the retired-model suffix. Billing/quota (429 / prepayment / credits /
 * quota / billing) gets billing wording with NO model suffix. Anything else
 * gets neutral wording. Fail-loud stays: all three branches throw, single
 * attempt, no silent fallback. Mirrors the billing-vs-transient
 * classification in src/lib/sop-embeddings.ts
 * (isNonRetryableBillingExhaustion).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * fetch is stubbed per-test; no network, no key needed.
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

const ENV_KEYS = ['GEMINI_SYNTHESIS_MODEL', 'GEMINI_MODEL', 'GEMINI_FIXTURE_JSON_PATH'] as const;
function clearEnv(): Record<string, undefined> {
  const out: Record<string, undefined> = {};
  for (const k of ENV_KEYS) out[k] = undefined;
  return out;
}

function stubFetch(status: number, body: string): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
  }) as any;
  return () => { globalThis.fetch = orig; };
}

const BILLING_BODY = 'Your prepayment credits are depleted. Add funds to continue.';

test('429 billing wall says billing/quota — NO retired-model suffix', async () => {
  const restore = stubFetch(429, BILLING_BODY);
  try {
    const { geminiGenerate } = await import('../../src/lib/gemini');
    await assert.rejects(
      withEnvAsync(
        { ...clearEnv(), GOOGLE_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-flash-latest' },
        () => geminiGenerate('hello'),
      ),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /429/);
        assert.match(msg, /billing\/quota/i);
        assert.doesNotMatch(msg, /retired or unavailable/);
        assert.match(msg, /prepayment credits are depleted/);
        return true;
      },
    );
  } finally { restore(); }
});

test('404 unknown model DOES carry the retired-model suffix (regression guard)', async () => {
  const restore = stubFetch(404, 'models/gemini-1.5-flash is not found for API version v1beta');
  try {
    const { geminiGenerate } = await import('../../src/lib/gemini');
    await assert.rejects(
      withEnvAsync(
        { ...clearEnv(), GOOGLE_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-1.5-flash' },
        () => geminiGenerate('hello'),
      ),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /404/);
        assert.match(msg, /model 'gemini-1\.5-flash' retired or unavailable/);
        return true;
      },
    );
  } finally { restore(); }
});

test('400 unknown-model body DOES carry the suffix', async () => {
  const restore = stubFetch(400, 'unknown model: models/gemini-9-fictional');
  try {
    const { geminiGenerate } = await import('../../src/lib/gemini');
    await assert.rejects(
      withEnvAsync(
        { ...clearEnv(), GOOGLE_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-9-fictional' },
        () => geminiGenerate('hello'),
      ),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /model 'gemini-9-fictional' retired or unavailable/);
        return true;
      },
    );
  } finally { restore(); }
});

test('neutral 500 gets neither suffix (fail-loud, accurately labelled)', async () => {
  const restore = stubFetch(500, 'internal error: backend unavailable');
  try {
    const { geminiGenerate } = await import('../../src/lib/gemini');
    await assert.rejects(
      withEnvAsync(
        { ...clearEnv(), GOOGLE_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-flash-latest' },
        () => geminiGenerate('hello'),
      ),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /500/);
        assert.doesNotMatch(msg, /retired or unavailable/);
        assert.doesNotMatch(msg, /billing\/quota/i);
        assert.match(msg, /backend unavailable/);
        return true;
      },
    );
  } finally { restore(); }
});
