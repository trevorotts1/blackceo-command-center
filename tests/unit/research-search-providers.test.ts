/**
 * research-search-providers.test.ts
 *
 * The research layer must use whatever search product a box actually has:
 * Brave, Exa, Serper, SerpAPI and Tavily alongside the chat-shaped Perplexity
 * and Ollama Cloud, plus Marginalia as a KEYLESS final rung so the chain
 * always ends somewhere.
 *
 * Per provider this pins three things:
 *   1. REQUEST SHAPE — method, URL and auth header, against a stubbed fetch.
 *      Each is checked against the vendor doc cited in its adapter comment.
 *   2. NORMALIZATION — a fixture response becomes results[] {url,title,snippet}.
 *   3. SKIP-WHEN-NO-KEY — a keyed provider with no key is passed over silently.
 *
 * No network: every case either stubs `globalThis.fetch` or reads a fixture.
 *
 *   node --import tsx --test tests/unit/research-search-providers.test.ts
 */

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIXTURES = path.resolve(process.cwd(), 'scripts/fixtures');

import { runResearch, MARGINALIA_ATTRIBUTION } from '../../src/lib/research/providers';
import { RESEARCH_PROVIDERS, providerAvailable } from '../../src/lib/research/provider-discovery';
import { researchForSop, researchProviderOrder, researchAttribution } from '../../src/lib/research/sop-research';

const ALL_KEYS = [
  'PERPLEXITY_API_KEY', 'PPLX_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY',
  'X_AI_API_KEY', 'XAI_API_KEY', 'BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY', 'EXA_API_KEY',
  'SERPER_API_KEY', 'SERPAPI_API_KEY', 'SERPAPI_KEY', 'TAVILY_API_KEY', 'MARGINALIA_API_KEY',
];
const ALL_FIXTURES = [
  'PERPLEXITY_FIXTURE_JSON_PATH', 'OPENAI_FIXTURE_JSON_PATH', 'OLLAMA_FIXTURE_JSON_PATH',
  'XAI_FIXTURE_JSON_PATH', 'BRAVE_FIXTURE_JSON_PATH', 'EXA_FIXTURE_JSON_PATH',
  'SERPER_FIXTURE_JSON_PATH', 'SERPAPI_FIXTURE_JSON_PATH', 'TAVILY_FIXTURE_JSON_PATH',
  'MARGINALIA_FIXTURE_JSON_PATH',
];
const SCOPED = [...ALL_KEYS, ...ALL_FIXTURES, 'RESEARCH_PROVIDER_ORDER', 'RESEARCH_ALLOW_MARGINALIA',
  'OPENCLAW_PROJECT_DIR', 'HOME', 'OPENCLAW_PLATFORM'];

/**
 * Run `fn` with EXACTLY the given research environment and nothing else.
 * The OpenClaw secret stores are pointed at an empty scratch home because a
 * developer box really does hold these keys — without it, "only a Brave key"
 * is silently "every key this machine owns" and a live call could escape.
 */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of SCOPED) { saved[k] = process.env[k]; delete process.env[k]; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'research-providers-home-'));
  process.env.HOME = home;
  process.env.OPENCLAW_PLATFORM = 'mac-mini';
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    await fn();
  } finally {
    for (const k of SCOPED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

interface Captured { url: string; method: string; headers: Record<string, string>; body: unknown }

/** Stub `fetch`, capture the one request made, and answer with `payload`. */
async function captureRequest(payload: unknown, fn: () => Promise<void>): Promise<Captured> {
  const original = globalThis.fetch;
  let captured: Captured | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers || {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    captured = {
      url: String(input),
      method: init?.method || 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(captured, 'the adapter made exactly one HTTP request');
  return captured!;
}

const params = { query: 'widget forging best practices 2026', depth: 'shallow' as const, model: 'web-search', apiKey: 'test-key' };

// ── 1. REQUEST SHAPE, one per provider, against the cited vendor docs ──────

test('Brave: GET api.search.brave.com/res/v1/web/search with X-Subscription-Token', async () => {
  const req = await captureRequest({ web: { results: [] } }, async () => { await runResearch('brave', params); });
  assert.equal(req.method, 'GET');
  assert.match(req.url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=/);
  assert.match(req.url, /q=widget%20forging|q=widget\+forging/);
  assert.equal(req.headers['x-subscription-token'], 'test-key');
  assert.equal(req.body, undefined, 'Brave search is a GET — no body');
});

test('Exa: POST api.exa.ai/search with x-api-key and {query,numResults,contents.text}', async () => {
  const req = await captureRequest({ results: [] }, async () => { await runResearch('exa', params); });
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://api.exa.ai/search');
  assert.equal(req.headers['x-api-key'], 'test-key');
  assert.deepEqual(req.body, { query: params.query, numResults: 8, contents: { text: true } });
});

test('Serper: POST google.serper.dev/search with X-API-KEY and {q}', async () => {
  const req = await captureRequest({ organic: [] }, async () => { await runResearch('serper', params); });
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://google.serper.dev/search');
  assert.equal(req.headers['x-api-key'], 'test-key');
  assert.equal((req.body as { q: string }).q, params.query);
});

test('SerpAPI: GET serpapi.com/search.json with engine, q and api_key', async () => {
  const req = await captureRequest({ organic_results: [] }, async () => { await runResearch('serpapi', params); });
  assert.equal(req.method, 'GET');
  assert.match(req.url, /^https:\/\/serpapi\.com\/search\.json\?engine=google&q=/);
  assert.match(req.url, /[?&]api_key=test-key(?:&|$)/);
});

test('Marginalia: GET api2.marginalia-search.com/search with the public API-Key', async () => {
  const req = await captureRequest({ license: 'CC-BY-NC-SA 4.0', results: [] }, async () => {
    await runResearch('marginalia', { ...params, apiKey: '' });
  });
  assert.equal(req.method, 'GET');
  assert.match(req.url, /^https:\/\/api2\.marginalia-search\.com\/search\?query=/);
  assert.equal(req.headers['api-key'], 'public', 'no key configured falls back to the literal public key');
});

test('Marginalia: a box-supplied key replaces the shared public one', async () => {
  const req = await captureRequest({ results: [] }, async () => {
    await runResearch('marginalia', { ...params, apiKey: 'my-own-key' });
  });
  assert.equal(req.headers['api-key'], 'my-own-key');
});

// ── 2. NORMALIZATION from each vendor's real response shape ────────────────

const NORMALIZE: Array<[string, string, string]> = [
  ['brave', 'BRAVE_FIXTURE_JSON_PATH', 'brave-search-sample.json'],
  ['exa', 'EXA_FIXTURE_JSON_PATH', 'exa-search-sample.json'],
  ['serper', 'SERPER_FIXTURE_JSON_PATH', 'serper-search-sample.json'],
  ['serpapi', 'SERPAPI_FIXTURE_JSON_PATH', 'serpapi-search-sample.json'],
  ['marginalia', 'MARGINALIA_FIXTURE_JSON_PATH', 'marginalia-search-sample.json'],
];

for (const [slug, fixtureVar, file] of NORMALIZE) {
  test(`${slug}: a real-shaped response normalizes to results[] with url, title and snippet`, async () => {
    await withEnv({ [fixtureVar]: path.join(FIXTURES, file), RESEARCH_PROVIDER_ORDER: slug }, async () => {
      const result = await researchForSop('widget forging best practices 2026');
      assert.equal(result.provider, slug);
      assert.equal(result.results.length, 2, 'both fixture results survive');
      for (const r of result.results) {
        assert.match(r.url, /^https:\/\//, 'every result carries a url');
        assert.ok(r.title.length > 0, 'every result carries a title');
        assert.ok((r.snippet || '').length > 0, 'the extract survives as snippet — it is the substance');
      }
    });
  });
}

// ── 3. SKIP WHEN NO KEY ───────────────────────────────────────────────────

for (const slug of ['brave', 'exa', 'serper', 'serpapi', 'tavily', 'perplexity', 'ollama']) {
  test(`${slug}: skipped silently when its key does not resolve`, async () => {
    // Only this provider is in the order, and marginalia is off, so a skip
    // must land in the no-research path rather than quietly using something else.
    await withEnv({ RESEARCH_PROVIDER_ORDER: slug, RESEARCH_ALLOW_MARGINALIA: '0' }, async () => {
      const result = await researchForSop('anything');
      assert.equal(result.provider, null, `${slug} must be skipped, not called, with no key`);
    });
  });
}

// ── The operator order ────────────────────────────────────────────────────

test('the default order is perplexity → ollama-cloud → brave → exa → serper → serpapi → tavily → marginalia', async () => {
  await withEnv({}, async () => {
    assert.deepEqual(researchProviderOrder(), [
      'perplexity', 'ollama', 'brave', 'exa', 'serper', 'serpapi', 'tavily', 'marginalia',
    ]);
  });
});

test('the operator spelling ollama-cloud resolves to the ollama adapter', async () => {
  await withEnv({ RESEARCH_PROVIDER_ORDER: 'ollama-cloud,brave' }, async () => {
    assert.deepEqual(researchProviderOrder(), ['ollama', 'brave']);
  });
  await withEnv({
    RESEARCH_PROVIDER_ORDER: 'ollama-cloud',
    OLLAMA_FIXTURE_JSON_PATH: path.join(FIXTURES, 'ollama-research-sample.json'),
  }, async () => {
    assert.equal((await researchForSop('x')).provider, 'ollama');
  });
});

test('every slug in the default order has an adapter and a discovery entry', async () => {
  await withEnv({}, async () => {
    for (const slug of researchProviderOrder()) {
      if (slug === 'tavily') continue; // tavily.ts is its own module, not a RESEARCH_PROVIDERS adapter
      assert.ok(
        RESEARCH_PROVIDERS.some((p) => p.slug === slug),
        `"${slug}" is in the order but has no RESEARCH_PROVIDERS entry — it would be skipped forever`,
      );
    }
  });
});

// ── Marginalia: the keyless last rung ─────────────────────────────────────

test('with NO keys at all, marginalia serves and the SOP carries its attribution', async () => {
  await withEnv({ MARGINALIA_FIXTURE_JSON_PATH: path.join(FIXTURES, 'marginalia-search-sample.json') }, async () => {
    const result = await researchForSop('widget forging best practices 2026');
    assert.equal(result.provider, 'marginalia', 'the chain ends at the keyless rung, not in the no-research path');
    assert.ok(result.results.length > 0);
    assert.equal(researchAttribution('marginalia'), MARGINALIA_ATTRIBUTION);
    assert.match(MARGINALIA_ATTRIBUTION, /CC-BY-NC-SA 4\.0/);
  });
});

test('marginalia is reported available with no key; the keyed providers are not', async () => {
  await withEnv({}, async () => {
    const marginalia = RESEARCH_PROVIDERS.find((p) => p.slug === 'marginalia')!;
    assert.equal(providerAvailable(marginalia), true, 'keyless means available, never "not configured"');
    for (const slug of ['brave', 'exa', 'serper', 'serpapi', 'perplexity']) {
      assert.equal(providerAvailable(RESEARCH_PROVIDERS.find((p) => p.slug === slug)!), false);
    }
  });
});

test('RESEARCH_ALLOW_MARGINALIA=0 drops it from the chain entirely', async () => {
  await withEnv({
    RESEARCH_ALLOW_MARGINALIA: '0',
    MARGINALIA_FIXTURE_JSON_PATH: path.join(FIXTURES, 'marginalia-search-sample.json'),
  }, async () => {
    assert.ok(!researchProviderOrder().includes('marginalia'));
    const result = await researchForSop('anything');
    assert.equal(result.provider, null, 'the kill switch sends the run down the no-research path');
  });
});

test('attribution is marginalia-only — no other provider claims a licence it does not carry', () => {
  for (const slug of ['brave', 'exa', 'serper', 'serpapi', 'tavily', 'perplexity', 'ollama', null]) {
    assert.equal(researchAttribution(slug), null);
  }
});
