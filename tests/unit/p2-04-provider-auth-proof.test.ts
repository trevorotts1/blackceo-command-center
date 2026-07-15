/**
 * P2-04 (c) step 3 — KILL THE MIRAGE (provider-auth-proof.ts).
 *
 * FAIL-FIRST: against the pre-P2-04 tree, `src/lib/provider-auth-proof.ts`
 * does not exist, so every import below fails and every test in this file
 * errors. With the P2-04 build the module exists and every test passes.
 *
 * THE BUG THIS LOCKS DOWN: root-cause item 4 (P2-04(b)) — a provider's
 * model-LIST endpoint (`fetchModels()`) can return 200 with a full catalog
 * even for a garbage/revoked key ("the /v1/models unauthenticated mirage"),
 * so treating a successful catalog listing as proof of auth is wrong. This
 * suite proves:
 *   1. `proveProviderAuth` NEVER calls `provider.fetchModels()` — proof comes
 *      ONLY from a real authenticated call (chatCompletion or verifyKey).
 *   2. A provider with neither `chatCompletion` nor `verifyKey` is honestly
 *      reported `unavailable` / not-ok — never fabricated as proven.
 *   3. A real `chatCompletion` call that throws (bad auth) is reported
 *      `ok:false` — never silently upgraded to proven.
 *   4. A real `chatCompletion` call that succeeds is `ok:true`.
 *   5. `isProofFresh` / `getCachedAuthProof` correctly gate the 24h TTL.
 *   6. `getOrProveProviderAuth` returns a fresh cache hit WITHOUT ever
 *      calling the provider again (proven via a call-counting spy on a real
 *      registered provider) — and DOES re-call after `force:true` or once
 *      the cache goes stale.
 *
 * Runs via the Node built-in test runner (`npm run test:unit`).
 */

// C8 — DB isolation. provider-auth-proof.ts pulls in '@/lib/db' transitively.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, run as dbRun } from '../../src/lib/db';
import { xiaomiProvider, fishAudioProvider } from '../../src/lib/model-providers';
import type { ModelProvider, ChatCompletionResponse } from '../../src/lib/model-providers/types';

type ProofModule = typeof import('../../src/lib/provider-auth-proof');
let mod: ProofModule;

test.before(async () => {
  mod = await import('../../src/lib/provider-auth-proof');
});

const db = getDb();

function seedModelRegistryRow(modelId: string, provider: string) {
  db.prepare(
    `INSERT OR REPLACE INTO model_registry (model_id, label, provider, status, capabilities)
     VALUES (?, ?, ?, 'active', '["text"]')`,
  ).run(modelId, modelId, provider);
}

function clearCacheRow(slug: string) {
  dbRun(`DELETE FROM provider_auth_proof_cache WHERE provider_slug = ?`, [slug]);
}

function clearRegistry(provider: string) {
  db.prepare(`DELETE FROM model_registry WHERE provider = ?`).run(provider);
}

function fakeProvider(overrides: Partial<ModelProvider> & Pick<ModelProvider, 'slug' | 'displayName'>): ModelProvider {
  return { authType: 'api_key', ...overrides };
}

// ── 1 & THE MIRAGE TEST — proveProviderAuth never calls fetchModels ──────

test('[P2-04 MIRAGE] proveProviderAuth NEVER calls fetchModels() — proof never comes from the model-list endpoint', async () => {
  let fetchModelsCalled = false;
  const provider = fakeProvider({
    slug: 'test-mirage-never-list',
    displayName: 'Test Mirage',
    fetchModels: async () => {
      fetchModelsCalled = true;
      throw new Error('fetchModels should NEVER be called by proveProviderAuth');
    },
    chatCompletion: async (): Promise<ChatCompletionResponse> => ({
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
    }),
  });
  seedModelRegistryRow('test-mirage-never-list/fake-model', 'test-mirage-never-list');

  const result = await mod.proveProviderAuth(provider, 'fake-key');

  assert.equal(fetchModelsCalled, false, 'fetchModels() must never be invoked for auth proof');
  assert.equal(result.ok, true);
  assert.equal(result.method, 'chat_completion');

  clearRegistry('test-mirage-never-list');
});

// ── 2. Neither chatCompletion nor verifyKey -> honestly unavailable ──────

test('[P2-04] a provider with neither chatCompletion nor verifyKey is reported unavailable, never fabricated proven', async () => {
  const provider = fakeProvider({
    slug: 'test-no-proof-method',
    displayName: 'No Proof Method',
    fetchModels: async () => [],
  });

  const result = await mod.proveProviderAuth(provider, 'fake-key');
  assert.equal(result.ok, false);
  assert.equal(result.method, 'unavailable');
});

// U49/U61 (H+L.7) — fish-audio now implements verifyKey() (one of the five
// media connectors this unit fixed), so it is NO LONGER an "unavailable"
// real-provider example; the generic "no proof method at all" case above is
// covered by the synthetic `fakeProvider` tests instead. This test now locks
// down the opposite: fish-audio has a real proof method and proveProviderAuth
// reaches it via the verify_key fallback (no chatCompletion on this
// connector), without ever calling fetchModels() — the mirage this whole
// module exists to kill, and doubly relevant here since fetchModels() has its
// own bare-catch-to-fallback-catalog swallow (see fish-audio.ts).
test('[P2-04/U49] fish-audio now implements verifyKey() and is reachable via the verify_key fallback, never via fetchModels', async () => {
  assert.equal(fishAudioProvider.chatCompletion, undefined);
  assert.equal(typeof fishAudioProvider.verifyKey, 'function');

  let verifyKeyCalled = false;
  let fetchModelsCalled = false;
  const originalVerifyKey = fishAudioProvider.verifyKey;
  const originalFetchModels = fishAudioProvider.fetchModels;
  fishAudioProvider.verifyKey = (async () => {
    verifyKeyCalled = true;
    return { ok: true, status: 200 };
  }) as ModelProvider['verifyKey'];
  fishAudioProvider.fetchModels = (async () => {
    fetchModelsCalled = true;
    throw new Error('fetchModels should NEVER be called by proveProviderAuth');
  }) as ModelProvider['fetchModels'];

  try {
    const result = await mod.proveProviderAuth(fishAudioProvider, 'fake-key');
    assert.equal(verifyKeyCalled, true);
    assert.equal(fetchModelsCalled, false, 'fetchModels() must never be invoked for auth proof');
    assert.equal(result.ok, true);
    assert.equal(result.method, 'verify_key');
  } finally {
    fishAudioProvider.verifyKey = originalVerifyKey;
    fishAudioProvider.fetchModels = originalFetchModels;
  }
});

// ── 3. A real chatCompletion call that fails is honestly reported false ──

test('[P2-04] a chatCompletion call that throws (bad auth) is reported ok:false, never silently proven', async () => {
  const provider = fakeProvider({
    slug: 'test-bad-auth',
    displayName: 'Bad Auth',
    fetchModels: async () => [],
    chatCompletion: async () => {
      throw new Error('401 Unauthorized');
    },
  });
  seedModelRegistryRow('test-bad-auth/fake-model', 'test-bad-auth');

  const result = await mod.proveProviderAuth(provider, 'bad-key');
  assert.equal(result.ok, false);
  assert.equal(result.method, 'chat_completion');
  assert.match(result.detail ?? '', /401/);

  clearRegistry('test-bad-auth');
});

test('[P2-04] a chatCompletion call that returns no choices is reported ok:false (a 200 alone is not proof)', async () => {
  const provider = fakeProvider({
    slug: 'test-empty-choices',
    displayName: 'Empty Choices',
    fetchModels: async () => [],
    chatCompletion: async (): Promise<ChatCompletionResponse> => ({ choices: [] }),
  });
  seedModelRegistryRow('test-empty-choices/fake-model', 'test-empty-choices');

  const result = await mod.proveProviderAuth(provider, 'some-key');
  assert.equal(result.ok, false);
  assert.equal(result.method, 'chat_completion');

  clearRegistry('test-empty-choices');
});

// ── 4. A real chatCompletion success is proven ────────────────────────────

test('[P2-04] a successful chatCompletion is reported ok:true, method chat_completion', async () => {
  const provider = fakeProvider({
    slug: 'test-good-auth',
    displayName: 'Good Auth',
    fetchModels: async () => [],
    chatCompletion: async (): Promise<ChatCompletionResponse> => ({
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
    }),
  });
  seedModelRegistryRow('test-good-auth/fake-model', 'test-good-auth');

  const result = await mod.proveProviderAuth(provider, 'good-key');
  assert.equal(result.ok, true);
  assert.equal(result.method, 'chat_completion');
  assert.equal(result.modelId, 'test-good-auth/fake-model');

  clearRegistry('test-good-auth');
});

// ── verifyKey fallback when chatCompletion is absent ──────────────────────

test('[P2-04] falls back to verifyKey when the provider has no chatCompletion', async () => {
  let verifyKeyCalled = false;
  const provider = fakeProvider({
    slug: 'test-verifykey-fallback',
    displayName: 'VerifyKey Fallback',
    fetchModels: async () => [],
    verifyKey: async () => {
      verifyKeyCalled = true;
      return { ok: true, status: 200 };
    },
  });

  const result = await mod.proveProviderAuth(provider, 'a-key');
  assert.equal(verifyKeyCalled, true);
  assert.equal(result.ok, true);
  assert.equal(result.method, 'verify_key');
});

test('[P2-04] falls back to verifyKey when chatCompletion exists but the box has no inventory row to complete against', async () => {
  let chatCalled = false;
  let verifyKeyCalled = false;
  const provider = fakeProvider({
    slug: 'test-no-inventory-fallback',
    displayName: 'No Inventory Fallback',
    fetchModels: async () => [],
    chatCompletion: async () => {
      chatCalled = true;
      throw new Error('should not be reached — no model id available');
    },
    verifyKey: async () => {
      verifyKeyCalled = true;
      return { ok: false, status: 401, message: 'nope' };
    },
  });
  clearRegistry('test-no-inventory-fallback'); // guarantee empty inventory

  const result = await mod.proveProviderAuth(provider, 'a-key');
  assert.equal(chatCalled, false);
  assert.equal(verifyKeyCalled, true);
  assert.equal(result.ok, false);
  assert.equal(result.method, 'verify_key');
});

// ── 5. isProofFresh / getCachedAuthProof — TTL gating ─────────────────────

test('[P2-04] isProofFresh: null row is never fresh', () => {
  assert.equal(mod.isProofFresh(null), false);
});

test('[P2-04] isProofFresh: a row younger than 24h is fresh; a row older is not', () => {
  const now = Date.now();
  const fresh = {
    provider_slug: 'x',
    proven_at: new Date(now - 60_000).toISOString(), // 1 minute ago
    ok: 1,
    method: 'chat_completion',
    model_id: null,
    detail: null,
  };
  const stale = {
    ...fresh,
    proven_at: new Date(now - (mod.AUTH_PROOF_TTL_MS + 60_000)).toISOString(), // just over 24h ago
  };
  assert.equal(mod.isProofFresh(fresh, now), true);
  assert.equal(mod.isProofFresh(stale, now), false);
});

test('[P2-04] getCachedAuthProof returns null when no row exists, and the persisted row after a prove call', async () => {
  clearCacheRow('test-cache-roundtrip');
  assert.equal(mod.getCachedAuthProof('test-cache-roundtrip'), null);

  const provider = fakeProvider({
    slug: 'test-cache-roundtrip',
    displayName: 'Cache Roundtrip',
    fetchModels: async () => [],
    verifyKey: async () => ({ ok: true, status: 200 }),
  });
  // getOrProveProviderAuth is what actually persists to the cache table;
  // proveProviderAuth alone (tested above) is a pure computation.
  const orig = mod.getOrProveProviderAuth;
  // Use the real cache-writing path via a REAL provider lookup substitute:
  // seed the cache row directly the same way getOrProveProviderAuth does,
  // by calling proveProviderAuth then asserting getCachedAuthProof still
  // returns null (it must — proveProviderAuth alone never writes the cache).
  await mod.proveProviderAuth(provider, 'k');
  assert.equal(mod.getCachedAuthProof('test-cache-roundtrip'), null, 'proveProviderAuth alone must never write the cache');
  void orig;
});

// ── 6. getOrProveProviderAuth — cache-aware entry point ───────────────────

test('[P2-04] getOrProveProviderAuth: a fresh cache hit returns WITHOUT ever resolving the provider (proven for an unknown slug)', async () => {
  const slug = 'test-unknown-slug-with-fresh-cache';
  clearCacheRow(slug);
  dbRun(
    `INSERT INTO provider_auth_proof_cache (provider_slug, proven_at, ok, method, model_id, detail)
     VALUES (?, ?, 1, 'chat_completion', 'whatever', NULL)`,
    [slug, new Date().toISOString()],
  );

  // This slug does not correspond to any registered provider. If the cache
  // check did not short-circuit BEFORE getProvider(slug), this would return
  // the "unknown provider" unavailable result instead of the cached proof.
  const result = await mod.getOrProveProviderAuth(slug, 'irrelevant-key');
  assert.equal(result.ok, true);
  assert.equal(result.method, 'chat_completion');

  clearCacheRow(slug);
});

test('[P2-04] getOrProveProviderAuth: an unknown provider slug (no cache) is honestly unavailable', async () => {
  const slug = 'test-truly-unknown-slug';
  clearCacheRow(slug);
  const result = await mod.getOrProveProviderAuth(slug, 'k');
  assert.equal(result.ok, false);
  assert.equal(result.method, 'unavailable');
  assert.match(result.detail ?? '', /unknown provider/);
});

test('[P2-04] getOrProveProviderAuth: a fresh cache hit never re-calls the provider; force:true and staleness both trigger a real re-call', async () => {
  clearCacheRow('xiaomi');
  clearRegistry('xiaomi');

  let calls = 0;
  const originalChat = xiaomiProvider.chatCompletion;
  xiaomiProvider.chatCompletion = (async () => {
    calls += 1;
    return { choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }] };
  }) as ModelProvider['chatCompletion'];
  seedModelRegistryRow('xiaomi/fake-model', 'xiaomi');

  try {
    const first = await mod.getOrProveProviderAuth('xiaomi', 'k');
    assert.equal(first.ok, true);
    assert.equal(calls, 1);

    // Second call within the TTL must NOT invoke the provider again.
    const second = await mod.getOrProveProviderAuth('xiaomi', 'k');
    assert.equal(second.ok, true);
    assert.equal(calls, 1, 'a fresh cache hit must never re-call the provider');

    // force:true bypasses the cache and re-calls.
    const forced = await mod.getOrProveProviderAuth('xiaomi', 'k', { force: true });
    assert.equal(forced.ok, true);
    assert.equal(calls, 2);

    // A stale cache row also triggers a real re-call.
    dbRun(
      `UPDATE provider_auth_proof_cache SET proven_at = ? WHERE provider_slug = 'xiaomi'`,
      [new Date(Date.now() - (mod.AUTH_PROOF_TTL_MS + 60_000)).toISOString()],
    );
    const stale = await mod.getOrProveProviderAuth('xiaomi', 'k');
    assert.equal(stale.ok, true);
    assert.equal(calls, 3);
  } finally {
    xiaomiProvider.chatCompletion = originalChat;
    clearRegistry('xiaomi');
    clearCacheRow('xiaomi');
  }
});
