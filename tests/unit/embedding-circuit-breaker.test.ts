/**
 * Unit tests — embeddings circuit breaker (Fix C)
 *
 * PRE-FIX: a depleted/exhausted embedding account got rediscovered on EVERY
 * call site — storeEmbeddingForSOP, rankSOPsBySemantic, and
 * department-router's semanticRankDepartments (via comDispatch) — each one
 * independently hitting the API, throwing, and falling back, for as long as
 * the account stayed exhausted.
 *
 * POST-FIX: fetchEmbedding()/fetchEmbeddings() (the ONE choke point all
 * three call sites funnel through) share a short-cooldown breaker. The
 * FIRST non-retryable failure (billing wall / bad credentials) opens it;
 * every call for the rest of the cooldown fails fast with ZERO network
 * calls. It self-heals with no restart once the cooldown clears.
 *
 * Proves:
 *   1. healthy path unchanged — breaker never engages, no extra calls.
 *   2. one non-retryable failure trips the breaker; a second call in the
 *      same cooldown makes ZERO network calls.
 *   3. a transient failure (plain 5xx / network error, no billing/auth
 *      marker) does NOT trip the breaker — regression guard.
 *   4. self-heals: once the cooldown clears (proven two ways — a
 *      deterministic test-only setter, and a real short env-tunable
 *      cooldown), the next call attempts a REAL network call again with NO
 *      restart, and succeeding closes the breaker.
 *   5. all three live-embedding call sites (storeEmbeddingForSOP,
 *      rankSOPsBySemantic, comDispatch's semantic step) respect an
 *      already-open breaker — zero network calls from any of them.
 *   6. a breaker tripped by ONE call site is respected by a DIFFERENT call
 *      site — proves the breaker is genuinely shared module state.
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

function billingWall429(): Response {
  return new Response(
    JSON.stringify({ error: { message: 'RESOURCE_EXHAUSTED: prepayment credits are depleted for this project' } }),
    { status: 429, headers: { 'Content-Type': 'application/json' } },
  );
}

function transientNetworkFailure(): Promise<Response> {
  return Promise.reject(new Error('ECONNRESET: socket hang up'));
}

function makeAgent(id: string, role: string) {
  return {
    id,
    name: id,
    role,
    status: 'active' as const,
    workspace_id: id,
    is_master: false,
    active_tasks: 0,
    department: role,
    description: '',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    model: 'test',
    persona: null,
  };
}

function makeDept(id: string, name: string, purpose: string, keywords: string[] = []) {
  return { id, name, purpose, keywords, agentRoles: [name + ' Specialist'], priority: 5 };
}

// ---------------------------------------------------------------------------
// 1) Healthy path unchanged — fleet-safety regression guard
// ---------------------------------------------------------------------------

test('breaker: healthy path — success never trips the breaker, behaviour unchanged', async (t) => {
  setGoogleEnv();
  const mod = await import('../../src/lib/sop-embeddings');
  mod._closeEmbeddingBreakerForTests();

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return embedResponse();
  };
  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const vec1 = await mod.fetchEmbedding('text one');
  const vec2 = await mod.fetchEmbedding('text two');

  assert.equal(calls, 2, 'two distinct successful calls must each hit the network exactly once');
  assert.equal(vec1.length, 3072);
  assert.equal(vec2.length, 3072);
  assert.equal(mod._isEmbeddingBreakerOpenForTests(), false, 'the breaker must never open on the healthy path');
});

// ---------------------------------------------------------------------------
// 2) One non-retryable failure trips the breaker — subsequent calls fail
//    fast with ZERO network calls for the rest of the cooldown.
// ---------------------------------------------------------------------------

test('breaker: one billing-wall failure trips it; the next call makes ZERO network calls', async (t) => {
  setGoogleEnv();
  const mod = await import('../../src/lib/sop-embeddings');
  mod._closeEmbeddingBreakerForTests();

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return billingWall429();
  };
  t.after(() => {
    restoreFetch();
    restoreEnv();
    mod._closeEmbeddingBreakerForTests();
  });

  await assert.rejects(() => mod.fetchEmbedding('text one'));
  assert.equal(calls, 1, 'the first call trips the breaker via one real (fake) network attempt');
  assert.equal(mod._isEmbeddingBreakerOpenForTests(), true, 'breaker must be open after a billing-wall failure');

  await assert.rejects(() => mod.fetchEmbedding('text two'), /circuit breaker/i);
  assert.equal(calls, 1, 'the SECOND call must make ZERO network calls — breaker fails fast');
});

// ---------------------------------------------------------------------------
// 3) A transient failure does NOT trip the breaker.
// ---------------------------------------------------------------------------

test('breaker: a transient network failure does NOT trip the breaker — regression guard', async (t) => {
  setGoogleEnv();
  const mod = await import('../../src/lib/sop-embeddings');
  mod._closeEmbeddingBreakerForTests();

  let calls = 0;
  global.fetch = () => {
    calls += 1;
    return transientNetworkFailure();
  };
  t.after(() => {
    restoreFetch();
    restoreEnv();
    mod._closeEmbeddingBreakerForTests();
  });

  await assert.rejects(() => mod.fetchEmbedding('text one'));
  assert.equal(mod._isEmbeddingBreakerOpenForTests(), false,
    'a transient network error (no billing/auth marker) must NOT open the breaker');

  await assert.rejects(() => mod.fetchEmbedding('text two'));
  assert.equal(calls, 2, 'each call must still attempt the network — a transient blip must not disable embeddings');
});

// ---------------------------------------------------------------------------
// 4) Self-heals with no restart.
// ---------------------------------------------------------------------------

test('breaker: self-heals once the cooldown clears (deterministic) — no restart needed', async (t) => {
  setGoogleEnv();
  const mod = await import('../../src/lib/sop-embeddings');
  mod._tripEmbeddingBreakerForTests('simulated billing wall');
  assert.equal(mod._isEmbeddingBreakerOpenForTests(), true);

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return embedResponse();
  };
  t.after(() => {
    restoreFetch();
    restoreEnv();
    mod._closeEmbeddingBreakerForTests();
  });

  // Simulate "the cooldown just expired" deterministically — no real waiting.
  mod._setEmbeddingBreakerOpenUntilForTests(Date.now() - 1);

  const vec = await mod.fetchEmbedding('text after cooldown');
  assert.equal(calls, 1, 'the very next call after cooldown expiry must attempt a REAL network call');
  assert.equal(vec.length, 3072);
  assert.equal(mod._isEmbeddingBreakerOpenForTests(), false, 'a successful call after cooldown must CLOSE the breaker');
});

test('breaker: self-heals via a real (env-tunable) short cooldown', async (t) => {
  setGoogleEnv();
  process.env.EMBEDDING_BREAKER_COOLDOWN_MS = '30';
  const mod = await import('../../src/lib/sop-embeddings');
  mod._closeEmbeddingBreakerForTests();

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return billingWall429();
    return embedResponse();
  };
  t.after(() => {
    restoreFetch();
    restoreEnv();
    mod._closeEmbeddingBreakerForTests();
  });

  await assert.rejects(() => mod.fetchEmbedding('trips it'));
  assert.equal(mod._isEmbeddingBreakerOpenForTests(), true);

  // Immediately after tripping, the cooldown (30ms) has not elapsed yet.
  await assert.rejects(() => mod.fetchEmbedding('still cooling down'), /circuit breaker/i);
  assert.equal(calls, 1, 'still within the 30ms cooldown — no second network call yet');

  await new Promise((resolve) => setTimeout(resolve, 60));

  const vec = await mod.fetchEmbedding('after real cooldown elapsed');
  assert.equal(calls, 2, 'once the env-tunable cooldown genuinely elapses, the next call reaches the network again');
  assert.equal(vec.length, 3072);
  assert.equal(mod._isEmbeddingBreakerOpenForTests(), false);
});

// ---------------------------------------------------------------------------
// 5) All three live-embedding call sites respect an already-open breaker.
// ---------------------------------------------------------------------------

test('breaker: storeEmbeddingForSOP, rankSOPsBySemantic, and comDispatch all make ZERO network calls while open', async (t) => {
  setGoogleEnv();

  const db = await import('../../src/lib/db');
  db.getDb();
  const { run } = db;

  const mod = await import('../../src/lib/sop-embeddings');
  const { PINNED_GOOGLE_MODEL, PINNED_GOOGLE_DIMS, float32ToBuffer } = mod;

  // A row whose model matches the active provider, so rankSOPsBySemantic
  // actually reaches its fetchEmbedding() call instead of returning [] early
  // on the "no matching rows" guard.
  const ts = Date.now();
  const sopId = `breaker-test-sop-${ts}`;
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, description, version, department, task_keywords, steps, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 1, 'test-dept', 'test', ?, ?, ?)`,
    [sopId, 'Breaker Test SOP', `breaker-sop-${ts}`, JSON.stringify([{ name: 'step1' }]), now, now],
  );
  run(
    `INSERT OR REPLACE INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [sopId, float32ToBuffer(new Float32Array(PINNED_GOOGLE_DIMS).fill(0.1)), PINNED_GOOGLE_MODEL, PINNED_GOOGLE_DIMS, now],
  );

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return embedResponse(); // would succeed if ever reached — it must never be reached
  };
  t.after(() => {
    restoreFetch();
    restoreEnv();
    mod._closeEmbeddingBreakerForTests();
  });

  mod._tripEmbeddingBreakerForTests('pre-tripped for this test');
  assert.equal(mod._isEmbeddingBreakerOpenForTests(), true);

  // storeEmbeddingForSOP: swallows errors internally (fire-and-forget), never throws.
  await mod.storeEmbeddingForSOP({
    id: sopId,
    name: 'Breaker Test SOP',
    slug: `breaker-sop-${ts}`,
    version: 1,
    steps: JSON.stringify([{ name: 'step1' }]),
    created_at: now,
    updated_at: now,
  });
  assert.equal(calls, 0, 'storeEmbeddingForSOP must make ZERO network calls while the breaker is open');

  // rankSOPsBySemantic: catches embed failures and returns [].
  const hits = await mod.rankSOPsBySemantic('breaker test query');
  assert.deepEqual(hits, []);
  assert.equal(calls, 0, 'rankSOPsBySemantic must make ZERO network calls while the breaker is open');

  // comDispatch (department-router): the semantic step is NOT wrapped in a
  // try/catch upstream of fetchEmbeddings today (pre-existing, unrelated to
  // this fix — ANY embedding failure already propagates uncaught through
  // comDispatch, not just a breaker-open one). We assert the REJECTION
  // carries the breaker's own message — proof this call site is wired to
  // the SAME breaker — and that it still made zero network calls.
  const { comDispatch, _resetDeptVectorCacheForTests } = await import('../../src/lib/routing/department-router');
  _resetDeptVectorCacheForTests();
  const departments = [makeDept('marketing', 'Marketing', 'Campaigns, brand, email.', ['marketing'])];
  const agents = [makeAgent('mkt-agent', 'Marketing Specialist')];

  await assert.rejects(
    () => comDispatch({ title: 'Launch a new campaign', description: '', priority: 'medium' }, agents, departments),
    /circuit breaker/i,
  );
  assert.equal(calls, 0, 'comDispatch\'s semantic step must make ZERO network calls while the breaker is open');
});

// ---------------------------------------------------------------------------
// 6) A breaker tripped by ONE call site is respected by a DIFFERENT call
//    site — proves genuinely shared module state, not per-caller state.
// ---------------------------------------------------------------------------

test('breaker: tripped by storeEmbeddingForSOP is respected by rankSOPsBySemantic', async (t) => {
  setGoogleEnv();

  const db = await import('../../src/lib/db');
  db.getDb();
  const { run } = db;

  const mod = await import('../../src/lib/sop-embeddings');
  mod._closeEmbeddingBreakerForTests();
  const { PINNED_GOOGLE_MODEL, PINNED_GOOGLE_DIMS, float32ToBuffer } = mod;

  const ts = Date.now();
  const sopId = `breaker-cross-site-sop-${ts}`;
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, description, version, department, task_keywords, steps, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 1, 'test-dept', 'test', ?, ?, ?)`,
    [sopId, 'Cross Site SOP', `cross-site-sop-${ts}`, JSON.stringify([{ name: 'step1' }]), now, now],
  );
  run(
    `INSERT OR REPLACE INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [sopId, float32ToBuffer(new Float32Array(PINNED_GOOGLE_DIMS).fill(0.1)), PINNED_GOOGLE_MODEL, PINNED_GOOGLE_DIMS, now],
  );

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return billingWall429();
  };
  t.after(() => {
    restoreFetch();
    restoreEnv();
    mod._closeEmbeddingBreakerForTests();
  });

  await mod.storeEmbeddingForSOP({
    id: sopId,
    name: 'Cross Site SOP',
    slug: `cross-site-sop-${ts}`,
    version: 1,
    steps: JSON.stringify([{ name: 'step1' }]),
    created_at: now,
    updated_at: now,
  });
  assert.equal(calls, 1, 'storeEmbeddingForSOP makes exactly one real (fake) network call, which trips the breaker');
  assert.equal(mod._isEmbeddingBreakerOpenForTests(), true);

  const hits = await mod.rankSOPsBySemantic('cross site query');
  assert.deepEqual(hits, [], 'rankSOPsBySemantic falls back to keyword mode (empty semantic hits) once the shared breaker is open');
  assert.equal(calls, 1, 'rankSOPsBySemantic — a DIFFERENT call site — must see the SAME open breaker and make no new network call');
});
