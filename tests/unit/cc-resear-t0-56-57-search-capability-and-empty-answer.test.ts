/**
 * T0-56 + T0-57 — Operator Research must not silently answer a grounded query
 * with a model that cannot search, and must not store an empty answer as a
 * completed research search.
 *
 * THE TWO DEFECTS (both reproduced against the pre-fix route)
 * ----------------------------------------------------------
 *  T0-56  `resolveModel()` preferred an active `model_registry` row for the
 *         selected provider, and when no row matched the documented default by
 *         id it fell through to `active[0]` — the FIRST ACTIVE ROW, whatever it
 *         was. Live web search is a property of PARTICULAR MODELS, not of a
 *         provider. A row promoted to active for an unrelated reason silently
 *         became the research model, and the route kept presenting its output
 *         as grounded research. The response shape was identical, minus the
 *         grounding.
 *  T0-57  The route's try/catch only sees a THROWN error. A 200 response with
 *         an empty answer is not an error, so it flowed onward, was persisted
 *         through `createResearchSearch()` and mirrored to the vault, where the
 *         Memory full-text index ingests it as completed research on that
 *         question. The only signal was the string "(no answer returned)"
 *         rendered inside the markdown body.
 *
 * WHAT THIS FILE LOCKS DOWN — BOTH DIRECTIONS FOR EVERY PREDICATE
 * ---------------------------------------------------------------
 *  A. The capability recogniser accepts every documented search family and
 *     rejects a plain chat model under the same provider key.
 *  B. A non-search registry row is NOT substituted: the route uses the
 *     provider's documented default and RECORDS which model answered.
 *  C. ANTI-FALSE-FAIL — a search-capable registry row IS still substituted,
 *     and an empty registry still resolves to the documented default.
 *  D. An empty provider answer returns an upstream error and persists NOTHING.
 *  E. ANTI-FALSE-FAIL — a non-empty answer with ZERO citations is still stored,
 *     stamped explicitly as ungrounded rather than reading as cited research.
 *
 * NO SYNTHETIC FIXTURES. Every row seeded here uses the real `model_registry`
 * columns (`model_id`, `provider`, `status`) that exist on every box — no
 * capability column is invented, which is exactly why the fix is an allowlist
 * derived from the documented provider families rather than a schema addition.
 *
 * Isolation: `_isolated-db` is imported FIRST (C8 guard) so every durable-write
 * assertion runs against a throwaway DATABASE_PATH, never mission-control.db.
 * The provider call is stubbed at `globalThis.fetch`, so this is the LIVE route
 * path (not fixture mode) with no network.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';

import { isSearchCapableModel, bareModelId } from '../../src/lib/research/search-capable-models';
import { listResearchSearches } from '../../src/lib/research-store';
import { getDb } from '../../src/lib/db';

// ── helpers ─────────────────────────────────────────────────────────────────

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
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every fixture var this route family honours, cleared so the LIVE path runs. */
const CLEAR_FIXTURES: Record<string, undefined> = {
  PERPLEXITY_FIXTURE_JSON_PATH: undefined,
  OPENAI_FIXTURE_JSON_PATH: undefined,
  OLLAMA_FIXTURE_JSON_PATH: undefined,
  XAI_FIXTURE_JSON_PATH: undefined,
  X_AI_FIXTURE_JSON_PATH: undefined,
};

/** Only Perplexity may be discovered, so the test drives one known adapter. */
const ONLY_PERPLEXITY: Record<string, string | undefined> = {
  PERPLEXITY_API_KEY: 'test-key-never-sent-fetch-is-stubbed',
  PPLX_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OLLAMA_CLOUD_API_KEY: undefined,
  OLLAMA_API_KEY: undefined,
  X_AI_API_KEY: undefined,
  XAI_API_KEY: undefined,
};

/** Stub `fetch` with one canned OpenAI-compatible envelope. Returns a restorer. */
function stubFetch(envelope: unknown): { restore: () => void; lastBody: () => unknown } {
  const original = globalThis.fetch;
  let body: unknown = null;
  globalThis.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
    body = init.body ? JSON.parse(init.body) : null;
    return {
      ok: true,
      status: 200,
      json: async () => envelope,
      text: async () => JSON.stringify(envelope),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { restore: () => { globalThis.fetch = original; }, lastBody: () => body };
}

/**
 * Seed one row using the REAL `model_registry` columns declared by migration
 * 031 (`model_id`, `label`, `provider`, `capabilities`, `status`). No column is
 * invented for this test — that is the point: the fix is an allowlist derived
 * from the documented provider families, not a schema addition no box has.
 */
function seedRegistryRow(modelId: string, provider: string, status: string) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO model_registry (model_id, label, provider, capabilities, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(modelId, bareModelId(modelId), provider, '["text"]', status);
}

function clearRegistry(provider: string) {
  getDb().prepare('DELETE FROM model_registry WHERE provider = ?').run(provider);
}

async function callRoute(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import('../../src/app/api/operator/research/search/route');
  const req = new Request('http://localhost/api/operator/research/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, depth: 'shallow' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ANSWERED = {
  id: 'upstream-id-1',
  model: 'server-side-model-label',
  choices: [{ message: { content: 'A real answer with substance.' } }],
  citations: ['https://example.invalid/source-one'],
  usage: { total_tokens: 10 },
};

// ── A. the capability recogniser, both directions ───────────────────────────

test('T0-56 A1: every documented search family is recognised', () => {
  // Derived from the "REQUEST SHAPE + SCOPE per provider" contract in
  // src/lib/research/providers.ts — the same source the adapters are written to.
  const capable: Array<[Parameters<typeof isSearchCapableModel>[0], string]> = [
    ['perplexity', 'sonar'],
    ['perplexity', 'sonar-pro'],
    ['perplexity', 'sonar-reasoning-pro'],
    ['perplexity', 'sonar-deep-research'],
    ['perplexity', 'perplexity/sonar-pro'],
    ['openai', 'gpt-4o-search-preview'],
    ['openai', 'gpt-4o-mini-search-preview'],
    ['openai', 'openai/gpt-4o-search-preview'],
    ['ollama', 'gpt-oss:120b'],
    ['xai', 'grok-4-fast'],
  ];
  for (const [slug, id] of capable) {
    assert.equal(isSearchCapableModel(slug, id), true, `${slug}/${id} must be recognised`);
  }
});

test('T0-56 A2: a plain chat model under the same provider key is NOT recognised', () => {
  // This is the substitution the defect made invisible.
  const incapable: Array<[Parameters<typeof isSearchCapableModel>[0], string]> = [
    ['perplexity', 'mistral-7b-instruct'],
    ['perplexity', 'llama-3.1-70b'],
    ['openai', 'gpt-4o'],
    ['openai', 'gpt-4.1-mini'],
    ['openai', 'o3'],
    ['ollama', 'llama3.2:3b'],
    ['xai', 'some-embedding-model'],
    ['perplexity', ''],
    ['perplexity', '   '],
  ];
  for (const [slug, id] of incapable) {
    assert.equal(isSearchCapableModel(slug, id), false, `${slug}/${id} must NOT be recognised`);
  }
});

test('T0-56 A3: bareModelId strips a provider namespace and leaves a bare id alone', () => {
  assert.equal(bareModelId('perplexity/sonar-pro'), 'sonar-pro');
  assert.equal(bareModelId('sonar-pro'), 'sonar-pro');
  assert.equal(bareModelId('a/b/c'), 'b/c');
});

// ── B. the route does not substitute a non-search model ─────────────────────

test('T0-56 B1: the only active model is not search-capable => the documented default answers', async () => {
  clearRegistry('perplexity');
  // A real row shape: model_id + provider + status. Nothing synthetic.
  seedRegistryRow('perplexity/mistral-7b-instruct', 'perplexity', 'active');

  const stub = stubFetch(ANSWERED);
  try {
    const { status, body } = await withEnvAsync(
      { ...CLEAR_FIXTURES, ...ONLY_PERPLEXITY, NODE_ENV: 'test' },
      () => callRoute(`t0-56 capability probe ${Date.now()}`),
    );
    assert.equal(status, 200);
    assert.equal(
      body.model,
      'sonar-pro',
      'a non-search registry row must NOT be substituted for a grounded research query',
    );
    const meta = body.search_metadata as Record<string, unknown>;
    assert.equal(meta.answering_model, 'sonar-pro', 'the answering model must be recorded');
    assert.equal(meta.model_source, 'provider-default');
    assert.equal(meta.model_search_capable, true);
    assert.deepEqual(
      meta.non_search_models_rejected,
      ['perplexity/mistral-7b-instruct'],
      'the rejected row must be named, so the condition is visible rather than silent',
    );
    // The stubbed request really carried the default, not the registry row.
    const sent = stub.lastBody() as { model?: string };
    assert.equal(sent.model, 'sonar-pro', 'the request body must carry the model that was resolved');
  } finally {
    stub.restore();
    clearRegistry('perplexity');
  }
});

// ── C. ANTI-FALSE-FAIL: capable rows still substitute; empty registry works ──

test('T0-56 C1: a search-capable registry row IS still substituted', async () => {
  clearRegistry('perplexity');
  seedRegistryRow('perplexity/sonar-deep-research', 'perplexity', 'active');

  const stub = stubFetch(ANSWERED);
  try {
    const { status, body } = await withEnvAsync(
      { ...CLEAR_FIXTURES, ...ONLY_PERPLEXITY, NODE_ENV: 'test' },
      () => callRoute(`t0-56 capable substitution ${Date.now()}`),
    );
    assert.equal(status, 200);
    assert.equal(body.model, 'sonar-deep-research', 'a documented search model must still be used');
    const meta = body.search_metadata as Record<string, unknown>;
    assert.equal(meta.model_source, 'registry-search-capable');
    assert.deepEqual(meta.non_search_models_rejected, []);
  } finally {
    stub.restore();
    clearRegistry('perplexity');
  }
});

test('T0-56 C2: an empty registry resolves to the documented default (fresh install)', async () => {
  clearRegistry('perplexity');
  const stub = stubFetch(ANSWERED);
  try {
    const { status, body } = await withEnvAsync(
      { ...CLEAR_FIXTURES, ...ONLY_PERPLEXITY, NODE_ENV: 'test' },
      () => callRoute(`t0-56 empty registry ${Date.now()}`),
    );
    assert.equal(status, 200);
    assert.equal(body.model, 'sonar-pro');
    const meta = body.search_metadata as Record<string, unknown>;
    assert.equal(meta.model_source, 'provider-default');
  } finally {
    stub.restore();
  }
});

// ── D. an empty answer is an upstream failure, and is not stored ────────────

test('T0-57 D1: an empty answer returns an upstream error and persists NOTHING', async () => {
  clearRegistry('perplexity');
  const before = listResearchSearches({ limit: 1 }).total;
  const query = `t0-57 empty answer probe ${Date.now()}`;

  const stub = stubFetch({
    id: 'upstream-id-empty',
    model: 'sonar-pro',
    choices: [{ message: { content: '' } }],
    citations: [],
  });
  try {
    const { status, body } = await withEnvAsync(
      { ...CLEAR_FIXTURES, ...ONLY_PERPLEXITY, NODE_ENV: 'test' },
      () => callRoute(query),
    );
    assert.equal(status, 502, 'an empty answer must be surfaced as an upstream failure');
    assert.equal(body.error, 'provider_empty_answer');
    assert.equal(body.persisted, false);
    assert.equal(body.search_id, undefined, 'there must be no durable id to cite');
  } finally {
    stub.restore();
  }

  assert.equal(
    listResearchSearches({ limit: 1 }).total,
    before,
    'no research_searches row may be written for an empty answer',
  );
  const found = listResearchSearches({ limit: 200 }).items.some(
    (r: { query?: string }) => r.query === query,
  );
  assert.equal(found, false, 'the empty search must not appear in history');
});

test('T0-57 D2: a whitespace-only answer is treated the same as an empty one', async () => {
  clearRegistry('perplexity');
  const before = listResearchSearches({ limit: 1 }).total;
  const stub = stubFetch({
    id: 'upstream-id-ws',
    model: 'sonar-pro',
    choices: [{ message: { content: '   \n\t  ' } }],
    citations: ['https://example.invalid/a-source'],
  });
  try {
    const { status, body } = await withEnvAsync(
      { ...CLEAR_FIXTURES, ...ONLY_PERPLEXITY, NODE_ENV: 'test' },
      () => callRoute(`t0-57 whitespace answer ${Date.now()}`),
    );
    assert.equal(status, 502);
    assert.equal(body.error, 'provider_empty_answer');
  } finally {
    stub.restore();
  }
  assert.equal(listResearchSearches({ limit: 1 }).total, before);
});

// ── E. ANTI-FALSE-FAIL: a real answer with no citations is STILL stored ─────

test('T0-57 E1: a non-empty answer with zero citations is stored, stamped ungrounded', async () => {
  clearRegistry('perplexity');
  const before = listResearchSearches({ limit: 1 }).total;
  const query = `t0-57 ungrounded but real ${Date.now()}`;

  const stub = stubFetch({
    id: 'upstream-id-ungrounded',
    model: 'sonar-pro',
    choices: [{ message: { content: 'A real answer the provider did not cite.' } }],
    citations: [],
  });
  try {
    const { status, body } = await withEnvAsync(
      { ...CLEAR_FIXTURES, ...ONLY_PERPLEXITY, NODE_ENV: 'test' },
      () => callRoute(query),
    );
    assert.equal(status, 200, 'a zero-citation answer must NOT be rejected — only an empty one is');
    assert.ok(body.search_id, 'it must still be stored');
    const meta = body.search_metadata as Record<string, unknown>;
    assert.equal(meta.grounded, false, 'it must be stamped ungrounded');
    assert.equal(meta.citation_count, 0);
    assert.match(
      String(body.markdown_result || ''),
      /UNGROUNDED — no sources returned/,
      'the stored markdown must say so, because the vault mirror is what Memory ingests',
    );
  } finally {
    stub.restore();
  }

  assert.equal(
    listResearchSearches({ limit: 1 }).total,
    before + 1,
    'a real answer must still produce exactly one durable row',
  );
});

test('T0-57 E2: a normal cited answer is completely unaffected', async () => {
  clearRegistry('perplexity');
  const before = listResearchSearches({ limit: 1 }).total;
  const stub = stubFetch(ANSWERED);
  try {
    const { status, body } = await withEnvAsync(
      { ...CLEAR_FIXTURES, ...ONLY_PERPLEXITY, NODE_ENV: 'test' },
      () => callRoute(`t0-57 healthy control ${Date.now()}`),
    );
    assert.equal(status, 200);
    assert.ok(body.search_id);
    const meta = body.search_metadata as Record<string, unknown>;
    assert.equal(meta.grounded, true);
    assert.equal(meta.citation_count, 1);
    assert.doesNotMatch(String(body.markdown_result || ''), /UNGROUNDED/);
  } finally {
    stub.restore();
  }
  assert.equal(listResearchSearches({ limit: 1 }).total, before + 1);
});
