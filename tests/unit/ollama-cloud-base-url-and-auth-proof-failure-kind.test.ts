/**
 * Two provider defects, locked down.
 *
 * DEFECT 1 — the 404 default.
 *   `research/providers.ts` fell back to 'https://ollama.com/api' while its twin
 *   `model-providers/ollama-cloud.ts` fell back to 'https://ollama.com'. Both
 *   append '/v1/...', so the '/api' variant resolved to
 *   'https://ollama.com/api/v1/chat/completions'. Verified live 2026-07-16:
 *     GET https://ollama.com/api/v1/models -> HTTP 404
 *     GET https://ollama.com/v1/models     -> HTTP 200
 *   Two files reading ONE env var with TWO different defaults was the bug; both
 *   now resolve through ollama-cloud-base-url.ts.
 *   FAIL-FIRST: against the old tree the module doesn't exist -> import throws.
 *
 * DEFECT 2 — the health check that manufactured phantom auth failures.
 *   `proveProviderAuth` took inventory[0] from this box's catalog — whatever
 *   sorts first by label — and reported ANY failure as a bare ok:false. On the
 *   operator box inventory[0] is 'ollama-cloud/deepseek-v3.1:671b', a STALE row
 *   absent from both the live cloud catalog and the local daemon. So the route
 *   reported ok:false — indistinguishable from "your key was rejected" — while
 *   the key was perfectly good. Now: model-not-found is classified, skipped, and
 *   never reported as auth.
 *   FAIL-FIRST: against the old tree `classifyProofFailure` and `failureKind`
 *   don't exist, and proveProviderAuth returns ok:false on a stale inventory[0]
 *   instead of trying the next model.
 *
 * RECONCILIATION NOTE (2026-07-16): this PR was written against a `main` that
 * predated PR #192, which independently refactored `model-providers/
 * ollama-cloud.ts`'s base-URL resolution from a module-level `const` (frozen
 * at IMPORT time) to a call-time `getOllamaCloudBaseUrl()` function — because
 * a frozen snapshot is exactly what let a QC-judge misconfiguration go
 * undiagnosed for six days. This PR's own original diff reintroduced that
 * frozen-const shape (`const BASE_URL = resolveOllamaCloudBaseUrl();` at
 * module scope) while rebasing past #192. The [GUARD] test below composes
 * both fixes: it proves `getOllamaCloudBaseUrl()` / `getOllamaCloudChatEndpoint()`
 * still re-resolve on every call — including a SECOND, different override
 * made after the first read — while also proving DEFECT-1's normalization
 * (legacy `/api` suffix stripped, correct hosted default) runs on each of
 * those calls, not just once at import.
 *
 * Runs via the Node built-in test runner (`npm run test:unit`).
 */

// DB isolation — provider-auth-proof.ts pulls in '@/lib/db' transitively.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, run as dbRun } from '../../src/lib/db';
import { xiaomiProvider } from '../../src/lib/model-providers';
import { getOllamaCloudBaseUrl, getOllamaCloudChatEndpoint } from '../../src/lib/model-providers/ollama-cloud';
import type { ModelProvider, ChatCompletionResponse } from '../../src/lib/model-providers/types';
import {
  normalizeOllamaCloudBaseUrl,
  resolveOllamaCloudBaseUrl,
  OLLAMA_CLOUD_DEFAULT_BASE_URL,
} from '../../src/lib/model-providers/ollama-cloud-base-url';

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

function clearRegistry(provider: string) {
  db.prepare(`DELETE FROM model_registry WHERE provider = ?`).run(provider);
}

function clearCacheRow(slug: string) {
  dbRun(`DELETE FROM provider_auth_proof_cache WHERE provider_slug = ?`, [slug]);
}

function fakeProvider(overrides: Partial<ModelProvider> & Pick<ModelProvider, 'slug' | 'displayName'>): ModelProvider {
  return { authType: 'api_key', ...overrides };
}

const okCompletion: ChatCompletionResponse = {
  choices: [{ message: { role: 'assistant', content: 'hi' } }],
} as unknown as ChatCompletionResponse;

// ── DEFECT 1 — base URL resolution ────────────────────────────────────────

test('[DEFECT-1] the default base URL is the bare host — NEVER the /api path that returns 404', () => {
  assert.equal(resolveOllamaCloudBaseUrl(undefined), 'https://ollama.com');
  assert.equal(OLLAMA_CLOUD_DEFAULT_BASE_URL, 'https://ollama.com');
  // The exact regression: the old default composed a URL upstream 404s on.
  assert.notEqual(resolveOllamaCloudBaseUrl(undefined), 'https://ollama.com/api');
});

test('[DEFECT-1] the composed chat endpoint is /v1/chat/completions, never /api/v1/chat/completions', () => {
  const composed = `${resolveOllamaCloudBaseUrl(undefined)}/v1/chat/completions`;
  assert.equal(composed, 'https://ollama.com/v1/chat/completions');
  assert.ok(!composed.includes('/api/v1'), 'must not contain the 404-producing /api/v1 path');
});

test('[DEFECT-1] a legacy /api suffix is normalized away (self-heals boxes carrying the old value)', () => {
  // .env.example used to recommend exactly this value.
  assert.equal(normalizeOllamaCloudBaseUrl('https://ollama.com/api'), 'https://ollama.com');
  assert.equal(normalizeOllamaCloudBaseUrl('https://ollama.com/api/'), 'https://ollama.com');
  assert.equal(normalizeOllamaCloudBaseUrl('https://ollama.com/'), 'https://ollama.com');
});

test('[DEFECT-1] a local-daemon override is honored — the daemon is the authenticated conduit to Ollama Cloud', () => {
  // A signed-in daemon relays ':cloud'-tagged models cloud-side. Loopback here
  // does NOT mean on-device inference, and this override must keep working.
  assert.equal(normalizeOllamaCloudBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(resolveOllamaCloudBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  // The daemon's OpenAI-compatible surface is /v1; /api is its native surface.
  assert.equal(normalizeOllamaCloudBaseUrl('http://127.0.0.1:11434/api'), 'http://127.0.0.1:11434');
});

test('[DEFECT-1] blank/whitespace config falls back to the default rather than composing a broken URL', () => {
  assert.equal(normalizeOllamaCloudBaseUrl(''), 'https://ollama.com');
  assert.equal(normalizeOllamaCloudBaseUrl('   '), 'https://ollama.com');
  assert.equal(normalizeOllamaCloudBaseUrl(null), 'https://ollama.com');
  assert.equal(normalizeOllamaCloudBaseUrl(undefined), 'https://ollama.com');
});

test(
  '[GUARD] getOllamaCloudBaseUrl/getOllamaCloudChatEndpoint re-resolve at CALL time — ' +
    'a value observed once (including at module import) must not survive a LATER env change',
  () => {
    const original = process.env.OLLAMA_CLOUD_BASE_URL;
    try {
      // The module was almost certainly already imported (and any frozen
      // top-level const already evaluated) long before this test runs — other
      // fixtures in this suite import '@/lib/model-providers' first. That is
      // the point: a frozen-at-import const would have captured whatever the
      // env var was at THAT moment, and every call below would silently
      // return that stale value forever.
      delete process.env.OLLAMA_CLOUD_BASE_URL;
      assert.equal(
        getOllamaCloudBaseUrl(),
        'https://ollama.com',
        'unset must resolve to the hosted default on THIS call, not whatever import time saw',
      );

      process.env.OLLAMA_CLOUD_BASE_URL = 'http://127.0.0.1:11434';
      assert.equal(
        getOllamaCloudBaseUrl(),
        'http://127.0.0.1:11434',
        'must observe an env var set AFTER the module was already loaded — the whole point of call-time resolution',
      );
      assert.equal(getOllamaCloudChatEndpoint(), 'http://127.0.0.1:11434/v1/chat/completions');

      // A SECOND, DIFFERENT override. This is what a "memoize on first call"
      // disguise — still shaped like a function, still call-time-looking from
      // the outside — would get wrong even though the single-override case
      // above would pass. Two distinct values, two distinct reads, is the
      // actual guard.
      process.env.OLLAMA_CLOUD_BASE_URL = 'http://127.0.0.1:22222/api';
      assert.equal(
        getOllamaCloudBaseUrl(),
        'http://127.0.0.1:22222',
        'a second, different override must ALSO be observed and normalized (legacy /api stripped) on every call',
      );
      assert.equal(getOllamaCloudChatEndpoint(), 'http://127.0.0.1:22222/v1/chat/completions');
    } finally {
      if (original === undefined) delete process.env.OLLAMA_CLOUD_BASE_URL;
      else process.env.OLLAMA_CLOUD_BASE_URL = original;
    }
  },
);

// ── DEFECT 2 — failure classification ─────────────────────────────────────

test('[DEFECT-2] classifyProofFailure separates a rejected key from a missing model', () => {
  const c = mod.classifyProofFailure;
  // Real auth rejections.
  assert.equal(c(new Error('Request failed: 401 Unauthorized')), 'auth');
  assert.equal(c(new Error('403 Forbidden')), 'auth');
  assert.equal(c(new Error('Incorrect API key provided: invalid api key')), 'auth');
  // Model-not-found — the phantom-incident case. Auth is NOT disproven here.
  assert.equal(c(new Error('404 page not found')), 'model_not_found');
  assert.equal(c(new Error('model "deepseek-v3.1:671b" not found, try pulling it first')), 'model_not_found');
  assert.equal(c(new Error("The model 'deepseek-v3.1:671b' does not exist")), 'model_not_found');
  // Transport.
  assert.equal(c(new Error('connect ECONNREFUSED 127.0.0.1:11434')), 'network');
  assert.equal(c(new Error('fetch failed')), 'network');
});

test('[DEFECT-2] a 401 whose text also says "not found" is still classified auth, not model_not_found', () => {
  // Ordering guard: auth must win so a real rejection is never downgraded.
  assert.equal(mod.classifyProofFailure(new Error('401 Unauthorized: key not found')), 'auth');
});

// ── DEFECT 2 — proveProviderAuth behavior ─────────────────────────────────

test('[DEFECT-2] a STALE inventory[0] no longer sinks the proof — it tries the next catalogued model', async () => {
  const slug = 'test-stale-first-model';
  clearRegistry(slug);
  clearCacheRow(slug);
  // 'a-stale' sorts before 'b-real' by label — exactly the operator-box shape
  // where deepseek-v3.1:671b (retired upstream) sorts ahead of the live models.
  seedModelRegistryRow(`${slug}/a-stale-retired-model`, slug);
  seedModelRegistryRow(`${slug}/b-real-live-model`, slug);

  const tried: string[] = [];
  const provider = fakeProvider({
    slug,
    displayName: 'Stale First',
    chatCompletion: async (_key, req) => {
      tried.push(req.model);
      if (req.model === 'a-stale-retired-model') {
        throw new Error('model "a-stale-retired-model" not found, try pulling it first');
      }
      return okCompletion;
    },
  });

  const res = await mod.proveProviderAuth(provider, 'sk-good-key');
  assert.deepEqual(tried, ['a-stale-retired-model', 'b-real-live-model'], 'must skip the stale row and try the next');
  assert.equal(res.ok, true, 'a good key must prove OK despite a stale catalog row');
  assert.equal(res.failureKind, 'none');
  assert.equal(res.modelId, `${slug}/b-real-live-model`);
  clearRegistry(slug);
});

test('[DEFECT-2] every model missing + no verifyKey => model_not_found, NOT an auth failure', async () => {
  const slug = 'test-all-models-missing';
  clearRegistry(slug);
  clearCacheRow(slug);
  seedModelRegistryRow(`${slug}/gone-1`, slug);
  seedModelRegistryRow(`${slug}/gone-2`, slug);

  const provider = fakeProvider({
    slug,
    displayName: 'All Missing',
    chatCompletion: async (_key, req) => {
      throw new Error(`The model '${req.model}' does not exist`);
    },
  });

  const res = await mod.proveProviderAuth(provider, 'sk-good-key');
  assert.equal(res.ok, false);
  // THE POINT: this must NOT read as a rejected key.
  assert.equal(res.failureKind, 'model_not_found');
  assert.notEqual(res.failureKind, 'auth');
  assert.match(String(res.detail), /auth NOT disproven/i);
  assert.match(String(res.detail), /stale/i);
  clearRegistry(slug);
});

test('[DEFECT-2] every model missing BUT verifyKey exists => falls through and proves the key honestly', async () => {
  const slug = 'test-missing-then-verify';
  clearRegistry(slug);
  clearCacheRow(slug);
  seedModelRegistryRow(`${slug}/gone-1`, slug);

  let verifyCalled = false;
  const provider = fakeProvider({
    slug,
    displayName: 'Missing Then Verify',
    chatCompletion: async (_key, req) => {
      throw new Error(`model "${req.model}" not found, try pulling it first`);
    },
    verifyKey: async () => {
      verifyCalled = true;
      return { ok: true, message: 'key valid' };
    },
  });

  const res = await mod.proveProviderAuth(provider, 'sk-good-key');
  assert.equal(verifyCalled, true, 'must fall through to verifyKey rather than report a false auth failure');
  assert.equal(res.ok, true);
  assert.equal(res.method, 'verify_key');
  assert.equal(res.failureKind, 'none');
  clearRegistry(slug);
});

test('[DEFECT-2] a GENUINE auth rejection is still reported as auth — and stops immediately', async () => {
  const slug = 'test-real-auth-failure';
  clearRegistry(slug);
  clearCacheRow(slug);
  seedModelRegistryRow(`${slug}/model-a`, slug);
  seedModelRegistryRow(`${slug}/model-b`, slug);

  let calls = 0;
  const provider = fakeProvider({
    slug,
    displayName: 'Real Auth Failure',
    chatCompletion: async () => {
      calls += 1;
      throw new Error('401 Unauthorized');
    },
  });

  const res = await mod.proveProviderAuth(provider, 'sk-bad-key');
  assert.equal(res.ok, false);
  assert.equal(res.failureKind, 'auth', 'a real rejection must still be reported as auth');
  assert.equal(calls, 1, 'a rejected key must not be retried against every catalogued model');
  clearRegistry(slug);
});

test('[DEFECT-2] the bounded attempt cap stops a badly-stale catalog from spending many calls', async () => {
  const slug = 'test-attempt-cap';
  clearRegistry(slug);
  clearCacheRow(slug);
  for (let i = 0; i < 10; i += 1) seedModelRegistryRow(`${slug}/gone-${i}`, slug);

  let calls = 0;
  const provider = fakeProvider({
    slug,
    displayName: 'Attempt Cap',
    chatCompletion: async (_key, req) => {
      calls += 1;
      throw new Error(`model "${req.model}" not found`);
    },
  });

  await mod.proveProviderAuth(provider, 'sk-good-key');
  assert.equal(calls, mod.MAX_PROOF_MODEL_ATTEMPTS, 'must stop at the documented cap');
  clearRegistry(slug);
});

test('[DEFECT-2] failure_kind round-trips through the cache so the tile can tell the two apart', async () => {
  // getOrProveProviderAuth resolves the provider from the REGISTRY by slug, so
  // this must drive a really-registered provider (same spy pattern as
  // p2-04-provider-auth-proof.test.ts) rather than a local fake.
  const slug = xiaomiProvider.slug;
  clearRegistry(slug);
  clearCacheRow(slug);
  seedModelRegistryRow(`${slug}/gone-model`, slug);

  const originalChat = xiaomiProvider.chatCompletion;
  // Simulate this box's catalog carrying a model that no longer exists upstream
  // — the operator-box deepseek-v3.1:671b shape.
  (xiaomiProvider as { chatCompletion?: ModelProvider['chatCompletion'] }).chatCompletion = async (_key, req) => {
    throw new Error(`model "${req.model}" not found, try pulling it first`);
  };

  try {
    const first = await mod.getOrProveProviderAuth(slug, 'sk-good-key', { force: true });
    assert.equal(first.failureKind, 'model_not_found');
    assert.equal(first.ok, false);

    const cached = mod.getCachedAuthProof(slug);
    assert.equal(cached?.failure_kind, 'model_not_found', 'failure_kind must persist to the cache row');

    // A cache hit must preserve the distinction — otherwise the tile reverts to
    // a bare ok:false and paints a phantom auth failure on every page load.
    const second = await mod.getOrProveProviderAuth(slug, 'sk-good-key');
    assert.equal(second.failureKind, 'model_not_found', 'cache hit must preserve the distinction');
  } finally {
    (xiaomiProvider as { chatCompletion?: ModelProvider['chatCompletion'] }).chatCompletion = originalChat;
    clearRegistry(slug);
    clearCacheRow(slug);
  }
});
