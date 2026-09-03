/**
 * fix/gemini-synthesis-model-env — Gemini synthesis model default + env override.
 *
 * THE DEFECT: src/lib/gemini.ts hardcoded 'gemini-1.5-flash' as the default
 * model. That model id is EOL — Google returns 404
 * ("models/gemini-1.5-flash is not found for API version v1beta") — so every
 * SOP synthesis call (sop-authoring + sop-auto-replace, the wrapper's ONLY
 * callers) failed with sop_authoring_generation_failed and custom-department
 * SOP cards held at the Triad gate forever.
 *
 * THE FIX: GEMINI_SYNTHESIS_MODEL (synthesis-specific) wins, then
 * GEMINI_MODEL, then 'gemini-flash-latest' (an -latest alias, so the next EOL
 * needs no code change). Unset env = new sane default.
 *
 * DESIGN (fail loud on retired model): a 404 / model-not-found error is
 * rethrown with a clear message naming the model id — NEVER silently fallen
 * back to another model. Silent fallback is exactly what masked this EOL.
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

function geminiOkText(text: string) {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
}

/** Stub fetch, capture the URL, return a canned success body. */
function stubFetchOk(text = '{"ok":true}'): { urls: string[]; restore: () => void } {
  const orig = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input));
    return new Response(geminiOkText(text), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as any;
  return { urls, restore: () => { globalThis.fetch = orig; } };
}

test('default resolves to gemini-flash-latest, never the EOL gemini-1.5-flash', async () => {
  const { urls, restore } = stubFetchOk();
  try {
    const { geminiGenerate } = await import('../../src/lib/gemini');
    const out = await withEnvAsync(
      { ...clearEnv(), GOOGLE_API_KEY: 'test-key', GEMINI_API_KEY: undefined },
      () => geminiGenerate('hello'),
    );
    assert.equal(out, '{"ok":true}');
    assert.equal(urls.length, 1);
    assert.match(urls[0], /models\/gemini-flash-latest:generateContent/);
    assert.doesNotMatch(urls[0], /gemini-1\.5-flash/);
  } finally { restore(); }
});

test('GEMINI_MODEL env override is respected', async () => {
  const { urls, restore } = stubFetchOk();
  try {
    const { geminiGenerate } = await import('../../src/lib/gemini');
    await withEnvAsync(
      { ...clearEnv(), GOOGLE_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-3.1-flash-lite' },
      () => geminiGenerate('hello'),
    );
    assert.equal(urls.length, 1);
    assert.match(urls[0], /models\/gemini-3\.1-flash-lite:generateContent/);
  } finally { restore(); }
});

test('GEMINI_SYNTHESIS_MODEL wins over GEMINI_MODEL', async () => {
  const { urls, restore } = stubFetchOk();
  try {
    const { geminiGenerate } = await import('../../src/lib/gemini');
    await withEnvAsync(
      {
        ...clearEnv(), GOOGLE_API_KEY: 'test-key',
        GEMINI_MODEL: 'gemini-3.1-flash-lite',
        GEMINI_SYNTHESIS_MODEL: 'gemini-3.5-flash',
      },
      () => geminiGenerate('hello'),
    );
    assert.equal(urls.length, 1);
    assert.match(urls[0], /models\/gemini-3\.5-flash:generateContent/);
  } finally { restore(); }
});

test('explicit opts.model still wins over both env knobs', async () => {
  const { urls, restore } = stubFetchOk();
  try {
    const { geminiGenerate } = await import('../../src/lib/gemini');
    await withEnvAsync(
      {
        ...clearEnv(), GOOGLE_API_KEY: 'test-key',
        GEMINI_MODEL: 'gemini-3.1-flash-lite',
        GEMINI_SYNTHESIS_MODEL: 'gemini-3.5-flash',
      },
      () => geminiGenerate('hello', { model: 'custom-model-x' }),
    );
    assert.equal(urls.length, 1);
    assert.match(urls[0], /models\/custom-model-x:generateContent/);
  } finally { restore(); }
});

test('retired-model 404 fails LOUD, naming the model — no silent fallback', async () => {
  const orig = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input));
    return new Response('models/gemini-1.5-flash is not found for API version v1beta', {
      status: 404, headers: { 'content-type': 'text/plain' },
    });
  }) as any;
  try {
    const { geminiGenerate } = await import('../../src/lib/gemini');
    await assert.rejects(
      withEnvAsync(
        { ...clearEnv(), GOOGLE_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-1.5-flash' },
        () => geminiGenerate('hello'),
      ),
      (err: unknown) => {
        const msg = (err as Error).message;
        // Loud: status + body preserved, model id named, single attempt.
        assert.match(msg, /404/);
        assert.match(msg, /gemini-1\.5-flash is not found/);
        assert.match(msg, /model 'gemini-1\.5-flash' (retired|not found|unavailable)/);
        assert.equal(urls.length, 1, 'no silent retry against a different model');
        return true;
      },
    );
  } finally { globalThis.fetch = orig; }
});
