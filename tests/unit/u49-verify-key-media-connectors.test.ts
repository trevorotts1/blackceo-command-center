/**
 * U49 / U61 (H+L.7) — verifyKey() on the five media connectors.
 *
 * THE BUG THIS UNIT FIXES: `replicate`, `elevenlabs`, `fal`, `fish-audio`,
 * and `kie` export NEITHER `chatCompletion` NOR `verifyKey`, so
 * `proveProviderAuth()` (src/lib/provider-auth-proof.ts) can structurally
 * never succeed for them — the "Prove" button in Intelligence Settings was
 * a dead affordance for these five (falls through to
 * `{ ok:false, method:'unavailable' }` no matter how valid the key is).
 * This suite locks down that each connector now implements a genuine
 * `verifyKey()` that:
 *   1. hits a REAL authenticated endpoint distinct from the model-LIST
 *      endpoint fetchModels() calls (never re-uses/re-triggers the mirage
 *      the module docstring in provider-auth-proof.ts warns about);
 *   2. reports `{ ok: true }` when the provider's authenticated endpoint
 *      accepts the key (verify-PASS);
 *   3. reports `{ ok: false, ... }` — never throws, never silently
 *      succeeds — when the provider rejects the key (verify-FAIL);
 *   4. fails CLOSED (ok:false) on a transport-level error (network throw,
 *      timeout/AbortError) rather than defaulting to proven.
 *
 * All five providers are wired end-to-end through `proveProviderAuth()`
 * (which has no `chatCompletion` to prefer for any of them — none of the
 * five are chat providers, per each file's own doc comment), so it must
 * reach `verifyKey()` via the `verify_key` fallback branch every time.
 *
 * Runs via the Node built-in test runner (`npm run test:unit`). No network,
 * no DB — `fetch` is stubbed for every case; nothing here makes a live call.
 */

// C8 — DB isolation. provider-auth-proof.ts pulls in '@/lib/db' transitively
// (via model-registry.ts's listModels()), and this suite imports it for the
// end-to-end proveProviderAuth() wiring checks below.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const orig = (globalThis as Record<string, unknown>).fetch;
  (globalThis as Record<string, unknown>).fetch = impl;
  return () => {
    if (orig === undefined) delete (globalThis as Record<string, unknown>).fetch;
    else (globalThis as Record<string, unknown>).fetch = orig;
  };
}

function abortingFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return async (_url, init) => {
    if (init?.signal) {
      await new Promise((_, reject) =>
        (init.signal as AbortSignal).addEventListener('abort', () =>
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
        ),
      );
    }
    throw Object.assign(new Error('abort'), { name: 'AbortError' });
  };
}

// ── Replicate ────────────────────────────────────────────────────────────

test('[U49] Replicate verifyKey: 200 on /v1/account (not /v1/models) -> ok:true', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/replicate');
  let calledUrl = '';
  const restore = stubFetch(async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ type: 'user', username: 'trevor' }), { status: 200 });
  });
  try {
    const result = await verifyKey('sk-good');
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.match(calledUrl, /\/account$/, 'must hit /account, not /models');
    assert.doesNotMatch(calledUrl, /\/models/, 'must never hit the model-list endpoint');
  } finally {
    restore();
  }
});

test('[U49] Replicate verifyKey: 401 -> ok:false, never throws', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/replicate');
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ title: 'Unauthenticated', detail: 'You did not pass a valid authentication token' }), {
      status: 401,
      statusText: 'Unauthorized',
    }),
  );
  try {
    const result = await verifyKey('sk-bad');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.ok(result.message);
  } finally {
    restore();
  }
});

test('[U49] Replicate verifyKey: network throw -> fail-closed ok:false', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/replicate');
  const restore = stubFetch(abortingFetch());
  try {
    const result = await verifyKey('sk-timeout');
    assert.equal(result.ok, false);
    assert.ok(result.message && /timeout|abort/i.test(result.message));
  } finally {
    restore();
  }
});

// ── ElevenLabs ───────────────────────────────────────────────────────────

test('[U49] ElevenLabs verifyKey: 200 on /v1/user (not /v1/models) -> ok:true', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/elevenlabs');
  let calledUrl = '';
  const restore = stubFetch(async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ subscription: { tier: 'creator' } }), { status: 200 });
  });
  try {
    const result = await verifyKey('key-good');
    assert.equal(result.ok, true);
    assert.match(calledUrl, /\/user$/, 'must hit /user, not /models');
    assert.doesNotMatch(calledUrl, /\/models/, 'must never hit the model-list endpoint');
  } finally {
    restore();
  }
});

test('[U49] ElevenLabs verifyKey: 401 -> ok:false, never throws', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/elevenlabs');
  const restore = stubFetch(async () =>
    new Response(
      JSON.stringify({ detail: { type: 'authentication_error', code: 'unauthorized', message: 'Invalid API key' } }),
      { status: 401, statusText: 'Unauthorized' },
    ),
  );
  try {
    const result = await verifyKey('key-bad');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  } finally {
    restore();
  }
});

test('[U49] ElevenLabs verifyKey: network throw -> fail-closed ok:false', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/elevenlabs');
  const restore = stubFetch(abortingFetch());
  try {
    const result = await verifyKey('key-timeout');
    assert.equal(result.ok, false);
    assert.ok(result.message && /timeout|abort/i.test(result.message));
  } finally {
    restore();
  }
});

// ── Fal.ai ───────────────────────────────────────────────────────────────

test('[U49] Fal verifyKey: 404 (not-found request id, auth gate passed) -> ok:true', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/fal');
  let calledUrl = '';
  const restore = stubFetch(async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ detail: 'Request not found' }), { status: 404 });
  });
  try {
    const result = await verifyKey('fal-good');
    assert.equal(result.ok, true, 'a 404 (not 401/403) proves auth passed the gate');
    assert.match(calledUrl, /queue\.fal\.run\/fal-ai\/fast-sdxl\/requests\/.+\/status/);
  } finally {
    restore();
  }
});

test('[U49] Fal verifyKey: 401 "Authentication is required" -> ok:false, never throws', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/fal');
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ detail: 'Authentication is required' }), { status: 401, statusText: 'Unauthorized' }),
  );
  try {
    const result = await verifyKey('fal-bad');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  } finally {
    restore();
  }
});

test('[U49] Fal verifyKey: 403 is also treated as an auth rejection -> ok:false', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/fal');
  const restore = stubFetch(async () => new Response(JSON.stringify({ detail: 'Forbidden' }), { status: 403 }));
  try {
    const result = await verifyKey('fal-forbidden');
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  } finally {
    restore();
  }
});

test('[U49] Fal verifyKey: network throw -> fail-closed ok:false', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/fal');
  const restore = stubFetch(abortingFetch());
  try {
    const result = await verifyKey('fal-timeout');
    assert.equal(result.ok, false);
    assert.ok(result.message && /timeout|abort/i.test(result.message));
  } finally {
    restore();
  }
});

// ── Fish Audio ───────────────────────────────────────────────────────────

test('[U49] Fish Audio verifyKey: 200 on /wallet/self/api-credit (not /v1/models) -> ok:true', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/fish-audio');
  let calledUrl = '';
  const restore = stubFetch(async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ _id: 'x', user_id: 'u1', credit: '10.00' }), { status: 200 });
  });
  try {
    const result = await verifyKey('fish-good');
    assert.equal(result.ok, true);
    assert.match(calledUrl, /\/wallet\/self\/api-credit$/, 'must hit the wallet endpoint, not /v1/models');
    assert.doesNotMatch(calledUrl, /\/v1\/models/, 'must never hit the model-list endpoint');
  } finally {
    restore();
  }
});

test('[U49] Fish Audio verifyKey: 401 -> ok:false, never throws (and never falls back to FALLBACK_MODELS-style silence)', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/fish-audio');
  const restore = stubFetch(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));
  try {
    const result = await verifyKey('fish-bad');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  } finally {
    restore();
  }
});

test('[U49] Fish Audio verifyKey: network throw -> fail-closed ok:false', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/fish-audio');
  const restore = stubFetch(abortingFetch());
  try {
    const result = await verifyKey('fish-timeout');
    assert.equal(result.ok, false);
    assert.ok(result.message && /timeout|abort/i.test(result.message));
  } finally {
    restore();
  }
});

// ── Kie.ai (special case: HTTP is ALWAYS 200; real outcome is body.code) ──

test('[U49] Kie verifyKey: HTTP 200 + body {code:200} -> ok:true', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/kie');
  let calledUrl = '';
  const restore = stubFetch(async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ code: 200, data: { credit: 100 } }), { status: 200 });
  });
  try {
    const result = await verifyKey('kie-good');
    assert.equal(result.ok, true);
    assert.match(calledUrl, /\/chat\/credit$/, 'must hit /chat/credit, not /models');
    assert.doesNotMatch(calledUrl, /\/models/, 'must never hit the model-list endpoint');
  } finally {
    restore();
  }
});

test('[U49] Kie verifyKey: HTTP 200 + body {code:401} -> ok:false (res.ok alone would be WRONG here)', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/kie');
  const restore = stubFetch(async () =>
    new Response(
      JSON.stringify({ code: 401, msg: 'Unauthorized – Authentication failed. Please check that your Authorization and Content-Type headers are correctly set.' }),
      { status: 200 }, // Kie's real gateway behavior: HTTP 200 even on auth failure.
    ),
  );
  try {
    const result = await verifyKey('kie-bad');
    assert.equal(result.ok, false, 'a body.code of 401 must fail the proof even though HTTP status is 200');
    assert.match(result.message ?? '', /401/);
  } finally {
    restore();
  }
});

test('[U49] Kie verifyKey: a real non-2xx HTTP status is also honored as failure (defensive)', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/kie');
  const restore = stubFetch(async () => new Response(JSON.stringify({ code: 500, msg: 'server error' }), { status: 500 }));
  try {
    const result = await verifyKey('kie-servererror');
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
  } finally {
    restore();
  }
});

test('[U49] Kie verifyKey: unparseable body -> fail-closed ok:false, never fabricated proven', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/kie');
  const restore = stubFetch(async () => new Response('not json', { status: 200 }));
  try {
    const result = await verifyKey('kie-badbody');
    assert.equal(result.ok, false);
  } finally {
    restore();
  }
});

test('[U49] Kie verifyKey: network throw -> fail-closed ok:false', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/kie');
  const restore = stubFetch(abortingFetch());
  try {
    const result = await verifyKey('kie-timeout');
    assert.equal(result.ok, false);
    assert.ok(result.message && /timeout|abort/i.test(result.message));
  } finally {
    restore();
  }
});

// ── End-to-end wiring through proveProviderAuth() ─────────────────────────
// None of the five media connectors implement chatCompletion (all are
// non-chat providers per their own file-top doc comments), so
// proveProviderAuth() MUST reach each one's new verifyKey() via the
// verify_key fallback branch — never report `unavailable` for any of them
// anymore, and never silently invent a proof from fetchModels().

test('[U49] proveProviderAuth reaches verify_key for all five media connectors (none report "unavailable" anymore)', async () => {
  const { proveProviderAuth } = await import('../../src/lib/provider-auth-proof');
  const { replicateProvider, elevenlabsProvider, falProvider, fishAudioProvider, kieProvider } = await import(
    '../../src/lib/model-providers'
  );

  const restore = stubFetch(async (url) => {
    const u = String(url);
    // Kie's success shape differs (HTTP 200 + body.code); everyone else: 200.
    if (u.includes('kie.ai')) {
      return new Response(JSON.stringify({ code: 200, data: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  try {
    for (const provider of [replicateProvider, elevenlabsProvider, falProvider, fishAudioProvider, kieProvider]) {
      assert.equal(provider.chatCompletion, undefined, `${provider.slug} must not have chatCompletion (non-chat provider)`);
      assert.equal(typeof provider.verifyKey, 'function', `${provider.slug} must implement verifyKey`);
      const result = await proveProviderAuth(provider, 'fake-key-for-test');
      assert.equal(result.method, 'verify_key', `${provider.slug} must be proven via verify_key, not fall through to unavailable`);
      assert.equal(result.ok, true, `${provider.slug} should report ok:true for a 200/success stub`);
    }
  } finally {
    restore();
  }
});

test('[U49] proveProviderAuth: a rejected key across all five media connectors is honestly ok:false, never proven', async () => {
  const { proveProviderAuth } = await import('../../src/lib/provider-auth-proof');
  const { replicateProvider, elevenlabsProvider, falProvider, fishAudioProvider, kieProvider } = await import(
    '../../src/lib/model-providers'
  );

  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('kie.ai')) {
      return new Response(JSON.stringify({ code: 401, msg: 'Unauthorized' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, statusText: 'Unauthorized' });
  });

  try {
    for (const provider of [replicateProvider, elevenlabsProvider, falProvider, fishAudioProvider, kieProvider]) {
      const result = await proveProviderAuth(provider, 'bad-key-for-test');
      assert.equal(result.method, 'verify_key', `${provider.slug} must still be attempted via verify_key`);
      assert.equal(result.ok, false, `${provider.slug} must report ok:false for a rejected key — fail-closed`);
    }
  } finally {
    restore();
  }
});
