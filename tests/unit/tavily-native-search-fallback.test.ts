/**
 * FLEET DEFECT — SOP-authoring hard-depended on TAVILY_API_KEY.
 *
 * v1 fix (superseded): Tavily stayed the privileged path, native OpenClaw
 * search was only a fallback when TAVILY_API_KEY was unset.
 *
 * v2 (THIS suite): per Trevor, Tavily is no longer privileged. `tavilySearch()`
 * (src/lib/tavily.ts) now detects what web-research capability a box
 * actually has, at runtime, and uses the best available one, in order:
 *   1. Perplexity — if PERPLEXITY_API_KEY or OPENROUTER_API_KEY is set AND
 *      the provider is actually usable.
 *   2. Whatever this box's OpenClaw natively offers — discovered via
 *      `openclaw infer web providers`, not assumed (e.g. Ollama's own web
 *      search, Gemini's grounded search).
 *   3. Tavily — if TAVILY_API_KEY is set AND usable.
 *   4. DuckDuckGo — zero-credential floor.
 *
 * "CONFIGURED" IS A CLAIM, NOT A FACT: a provider can report itself
 * configured while being unusable (depleted billing, unauthenticated CLI
 * session). Every tier is tried EMPIRICALLY, and an auth/quota/billing
 * failure — even one dressed up as a normal-looking answer — is treated as
 * "try the next tier," never as a reason to stop or throw.
 *
 * THIS SUITE PROVES, IN ORDER:
 *   A. Perplexity available+funded -> selected first, even with other tiers
 *      also configured.
 *   B. Perplexity key present but the provider is unusable (429/depleted
 *      credits, or an auth failure dressed as a normal answer) -> falls
 *      over to the next provider, does not fail.
 *   C. No perplexity -> a discovered native OpenClaw provider (e.g. Ollama's
 *      own web search) is selected.
 *   D. A provider reports itself `configured: true` in the discovery
 *      listing but errors live -> skipped, the next one is used.
 *   E. Nothing but duckduckgo works -> duckduckgo used, real shape returned.
 *   F. Every tier exhausted -> graceful EMPTY result, no throw.
 *   G. [MANDATORY] Tavily present and funded, with nothing higher-priority
 *      configured -> still usable, same shape as always.
 *   H. TAVILY_FIXTURE_JSON_PATH still honored, short-circuits every tier.
 *   I. Citation -> results mapping (string and object citation shapes).
 *   J. Per-provider usability caching: a known-unusable provider is not
 *      re-probed within the TTL, and IS re-probed once the TTL elapses.
 *
 * Test seam: OPENCLAW_CLI_BIN points execFile at a throwaway Node script
 * standing in for the real `openclaw` binary — no live CLI or network call
 * required. It handles BOTH `infer web search --provider <p>` and
 * `infer web providers`, driven by FAKE_CLI_BEHAVIOR_JSON /
 * FAKE_CLI_PROVIDERS_JSON (inherited via process.env, since execFile does
 * not override `env`), and appends one line per invocation to
 * FAKE_CLI_CALL_LOG so tests can assert how many times (and for which
 * provider) the CLI was actually invoked — the caching proof.
 *
 *   node --import tsx --test tests/unit/tavily-native-search-fallback.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tavilySearch, __resetWebSearchCachesForTests } from '../../src/lib/tavily';

// ── fake `openclaw` CLI ──────────────────────────────────────────────────────
//
// `infer web search --provider <p> --json`: looks up
// FAKE_CLI_BEHAVIOR_JSON[p] -> { exit?, stdout?, delayMs? }, default { exit: 1 }.
// `infer web providers --json`: prints FAKE_CLI_PROVIDERS_JSON verbatim
// (a full `{outputs:[{result:{providers:[...]}}]}` envelope), default
// prints an empty providers list.
// Every invocation appends "<subcommand> <provider-or-blank>" to
// FAKE_CLI_CALL_LOG when that env var is set, so tests can prove how many
// times (and for what) the CLI was actually called.

const FAKE_CLI_PATH = path.join(os.tmpdir(), `fake-openclaw-cli-${process.pid}.js`);
fs.writeFileSync(
  FAKE_CLI_PATH,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const isProviders = args[0] === 'infer' && args[1] === 'web' && args[2] === 'providers';
const providerIdx = args.indexOf('--provider');
const provider = providerIdx >= 0 ? args[providerIdx + 1] : '';

if (process.env.FAKE_CLI_CALL_LOG) {
  fs.appendFileSync(process.env.FAKE_CLI_CALL_LOG, (isProviders ? 'providers' : 'search') + ' ' + provider + '\\n');
}

if (isProviders) {
  const out = process.env.FAKE_CLI_PROVIDERS_JSON || JSON.stringify({ outputs: [{ result: { providers: [] } }] });
  process.stdout.write(out);
  process.exit(0);
}

let behaviorMap = {};
try { behaviorMap = JSON.parse(process.env.FAKE_CLI_BEHAVIOR_JSON || '{}'); } catch {}
const behavior = behaviorMap[provider] || { exit: 1 };
if (behavior.delayMs) {
  const start = Date.now();
  while (Date.now() - start < behavior.delayMs) { /* busy-wait: simulate a hung CLI */ }
}
if (typeof behavior.stdout === 'string') process.stdout.write(behavior.stdout);
process.exit(typeof behavior.exit === 'number' ? behavior.exit : 0);
`,
  { mode: 0o755 },
);

/** Restore every env var this suite touches, whatever a test did to it.
 *  Always resets the provider-usability/discovery caches on entry — node:test
 *  runs a file's tests serially in ONE process, so those module-level caches
 *  would otherwise leak an outcome (e.g. an earlier test's "duckduckgo is
 *  unusable") into a later, unrelated test. */
async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  __resetWebSearchCachesForTests();
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

const BASE_ENV: Record<string, string | undefined> = {
  TAVILY_API_KEY: undefined,
  TAVILY_FIXTURE_JSON_PATH: undefined,
  PERPLEXITY_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  OPENCLAW_CLI_BIN: FAKE_CLI_PATH,
  OPENCLAW_WEB_SEARCH_TIMEOUT_MS: undefined,
  WEB_SEARCH_PROVIDER_CACHE_TTL_MS: undefined,
  FAKE_CLI_BEHAVIOR_JSON: undefined,
  FAKE_CLI_PROVIDERS_JSON: undefined,
  FAKE_CLI_CALL_LOG: undefined,
};

function providersEnvelope(providers: Array<{ id: string; configured?: boolean }>): string {
  return JSON.stringify({ outputs: [{ result: { providers } }] });
}

function searchEnvelope(content: string, citations: Array<string | { title: string; url: string }>): string {
  return JSON.stringify({ outputs: [{ result: { content, citations } }] });
}

/** Fresh call-log file per test, and the caches reset — node:test runs a
 *  file's tests serially in one process, so state does not leak. */
function freshCallLog(): string {
  __resetWebSearchCachesForTests();
  const p = path.join(os.tmpdir(), `fake-cli-call-log-${process.pid}-${Date.now()}-${Math.random()}.log`);
  fs.writeFileSync(p, '');
  return p;
}

function readCallLog(p: string): string[] {
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// ── A. Perplexity available+funded -> selected first ────────────────────────

test('A: perplexity available+funded is selected first, even with tavily also configured', async () => {
  const callLog = freshCallLog();
  await withEnv(
    {
      ...BASE_ENV,
      PERPLEXITY_API_KEY: 'real-perplexity-key',
      TAVILY_API_KEY: 'real-tavily-key', // configured too, but must NOT win
      FAKE_CLI_CALL_LOG: callLog,
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 0, stdout: searchEnvelope('Perplexity answer.', ['https://example.invalid/px']) },
      }),
    },
    async () => {
      const result = await tavilySearch('sales best practices');
      assert.equal(result.answer, 'Perplexity answer.');
      assert.deepEqual(result.results, [{ title: 'https://example.invalid/px', url: 'https://example.invalid/px' }]);
    },
  );
  // Tavily's REST endpoint / CLI must never have been reached.
  const calls = readCallLog(callLog);
  assert.deepEqual(calls, ['search perplexity'], 'only perplexity should have been called');
});

test('A2: OPENROUTER_API_KEY alone is enough to try the perplexity tier', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      OPENROUTER_API_KEY: 'real-openrouter-key',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 0, stdout: searchEnvelope('Answer via OpenRouter alias.', []) },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.equal(result.answer, 'Answer via OpenRouter alias.');
    },
  );
});

// ── B. perplexity present but unusable -> falls over ─────────────────────────

test('B1: perplexity 429/depleted-credits -> falls over to the next provider, does not fail', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      PERPLEXITY_API_KEY: 'real-key-but-broke',
      TAVILY_API_KEY: 'real-tavily-key',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 0, stdout: 'HTTP 429: Your prepayment credits are depleted' },
        duckduckgo: { exit: 0, stdout: searchEnvelope('duckduckgo fallback answer', []) },
      }),
    },
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ query: 'q', results: [], answer: 'Real Tavily answer.' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch;
      try {
        const result = await tavilySearch('query');
        // perplexity failed -> next configured tier (tavily, since nothing
        // native was discovered) must have been used instead.
        assert.equal(result.answer, 'Real Tavily answer.');
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test('B2: perplexity exit 0 with an auth-failure-shaped answer is NOT treated as real content', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      PERPLEXITY_API_KEY: 'real-key',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 0, stdout: searchEnvelope('Error: authentication failed. Please sign in again.', []) },
        duckduckgo: { exit: 0, stdout: searchEnvelope('Real duckduckgo answer.', []) },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.equal(
        result.answer,
        'Real duckduckgo answer.',
        'an auth-failure string dressed as an "answer" must not be trusted as real content',
      );
    },
  );
});

// ── C. no perplexity, a discovered native provider is used ──────────────────

test('C1: no perplexity, ollama web search discovered+available -> selected', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_PROVIDERS_JSON: providersEnvelope([{ id: 'ollama', configured: true }]),
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        ollama: { exit: 0, stdout: searchEnvelope('Answer via Ollama Cloud web search.', ['https://example.invalid/o']) },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.equal(result.answer, 'Answer via Ollama Cloud web search.');
    },
  );
});

test('C2: gemini discovered+available -> selected over tavily', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      TAVILY_API_KEY: 'real-tavily-key',
      FAKE_CLI_PROVIDERS_JSON: providersEnvelope([{ id: 'gemini', configured: true }]),
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        gemini: { exit: 0, stdout: searchEnvelope('Grounded gemini answer.', []) },
      }),
    },
    async () => {
      const originalFetch = globalThis.fetch;
      let tavilyCalled = false;
      globalThis.fetch = (async () => {
        tavilyCalled = true;
        throw new Error('Tavily must not be called when gemini is available');
      }) as unknown as typeof fetch;
      try {
        const result = await tavilySearch('query');
        assert.equal(result.answer, 'Grounded gemini answer.');
        assert.equal(tavilyCalled, false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

// ── D. configured:true but errors live -> skipped ────────────────────────────

test('D1: discovery says ollama configured:true, live call fails auth -> skipped, next used', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_PROVIDERS_JSON: providersEnvelope([
        { id: 'ollama', configured: true },
        { id: 'gemini', configured: true },
      ]),
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        ollama: { exit: 1, stdout: "Error: Ollama web search authentication failed. Run 'ollama signin'." },
        gemini: { exit: 0, stdout: searchEnvelope('Real gemini answer.', []) },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.equal(result.answer, 'Real gemini answer.', 'ollama reported configured but failed, gemini must win');
    },
  );
});

test('D2: discovery says configured:false -> skipped without even being called', async () => {
  const callLog = freshCallLog();
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_CALL_LOG: callLog,
      FAKE_CLI_PROVIDERS_JSON: providersEnvelope([
        { id: 'ollama', configured: false },
        { id: 'gemini', configured: true },
      ]),
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        gemini: { exit: 0, stdout: searchEnvelope('Real gemini answer.', []) },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.equal(result.answer, 'Real gemini answer.');
    },
  );
  const calls = readCallLog(callLog);
  assert.ok(!calls.includes('search ollama'), 'a provider reported configured:false must never be called at all');
});

// ── E. nothing but duckduckgo works ──────────────────────────────────────────

test('E1: nothing configured but duckduckgo -> duckduckgo used, real shape returned', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        duckduckgo: {
          exit: 0,
          stdout: searchEnvelope('DuckDuckGo answer, zero credential.', [
            { title: 'DDG Source', url: 'https://example.invalid/ddg' },
          ]),
        },
      }),
    },
    async () => {
      const result = await tavilySearch('floor query', { max_results: 5 });
      assert.equal(result.query, 'floor query');
      assert.equal(result.answer, 'DuckDuckGo answer, zero credential.');
      assert.deepEqual(result.results, [{ title: 'DDG Source', url: 'https://example.invalid/ddg' }]);
    },
  );
});

// ── F. every tier exhausted -> graceful empty, never throw ──────────────────

test('F1: every tier fails (no keys, no discovery, duckduckgo also fails) -> graceful empty, no throw', async () => {
  await withEnv({ ...BASE_ENV }, async () => {
    const result = await tavilySearch('all fail query');
    assert.deepEqual(result, { query: 'all fail query', results: [], answer: undefined });
  });
});

test('F2: CLI binary entirely absent -> graceful empty result, no throw', async () => {
  await withEnv(
    { ...BASE_ENV, PERPLEXITY_API_KEY: 'k', TAVILY_API_KEY: 'k2', OPENCLAW_CLI_BIN: '/nonexistent/openclaw-xyz' },
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response('bad', { status: 500 })) as unknown as typeof fetch;
      try {
        const result = await tavilySearch('absent cli query');
        assert.deepEqual(result, { query: 'absent cli query', results: [], answer: undefined });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test('F3: a real wall-clock timeout on every reachable provider -> graceful empty, no throw', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      PERPLEXITY_API_KEY: 'k',
      OPENCLAW_WEB_SEARCH_TIMEOUT_MS: '300',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { delayMs: 2000, exit: 0, stdout: '{}' },
        duckduckgo: { delayMs: 2000, exit: 0, stdout: '{}' },
      }),
    },
    async () => {
      const start = Date.now();
      const result = await tavilySearch('timeout query');
      const elapsed = Date.now() - start;
      assert.deepEqual(result, { query: 'timeout query', results: [], answer: undefined });
      assert.ok(elapsed < 5000, `expected the 300ms timeout to cut each provider short, took ${elapsed}ms`);
    },
  );
});

// ── G. [MANDATORY] Tavily present and funded -> still usable ────────────────

test('G1: Tavily present and funded, nothing higher-priority configured -> still usable', async () => {
  await withEnv({ ...BASE_ENV, TAVILY_API_KEY: 'real-tavily-key' }, async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl: string | null = null;
    let calledBody: unknown = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          query: 'tavily-echoed-query',
          results: [{ title: 'Real Tavily result', url: 'https://example.invalid/real', content: 'c' }],
          answer: 'A real Tavily answer.',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    try {
      const result = await tavilySearch('best practices sales 2026', { max_results: 3 });
      assert.equal(calledUrl, 'https://api.tavily.com/search');
      assert.deepEqual(calledBody, {
        api_key: 'real-tavily-key',
        query: 'best practices sales 2026',
        search_depth: 'basic',
        include_answer: true,
        max_results: 3,
      });
      assert.deepEqual(result, {
        query: 'tavily-echoed-query',
        results: [{ title: 'Real Tavily result', url: 'https://example.invalid/real', content: 'c' }],
        answer: 'A real Tavily answer.',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('G2: Tavily HTTP 429 -> falls over to duckduckgo instead of throwing', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      TAVILY_API_KEY: 'real-tavily-key',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        duckduckgo: { exit: 0, stdout: searchEnvelope('DuckDuckGo answer reached after Tavily was rejected.', []) },
      }),
    },
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response('{"detail":"quota exceeded"}', { status: 429 })) as unknown as typeof fetch;
      try {
        const result = await tavilySearch('query');
        assert.equal(result.answer, 'DuckDuckGo answer reached after Tavily was rejected.');
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

// ── H. TAVILY_FIXTURE_JSON_PATH still honored ────────────────────────────────

test('H1: fixture short-circuits every tier, key or no key', async () => {
  const fixtureFile = path.join(os.tmpdir(), `tavily-fixture-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(
    fixtureFile,
    JSON.stringify({ query: 'ignored', results: [{ title: 'Fixture result', url: 'https://example.invalid/fx' }], answer: 'Fixture answer.' }),
  );
  await withEnv(
    { ...BASE_ENV, PERPLEXITY_API_KEY: 'k', TAVILY_API_KEY: 'k2', TAVILY_FIXTURE_JSON_PATH: fixtureFile },
    async () => {
      const originalFetch = globalThis.fetch;
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        throw new Error('must not be called when a fixture is set');
      }) as unknown as typeof fetch;
      try {
        const result = await tavilySearch('fixture query');
        assert.equal(result.query, 'fixture query');
        assert.equal(result.answer, 'Fixture answer.');
        assert.equal(fetchCalled, false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

// ── I. citation mapping ──────────────────────────────────────────────────────

test('I1: string and object citation shapes both map correctly, max_results honored', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        duckduckgo: {
          exit: 0,
          stdout: searchEnvelope('mixed citations', [
            'https://example.invalid/bare-string',
            { title: 'Object Citation', url: 'https://example.invalid/object' },
            { title: 'Third', url: 'https://example.invalid/third' },
          ]),
        },
      }),
    },
    async () => {
      const result = await tavilySearch('query', { max_results: 2 });
      assert.equal(result.results.length, 2, 'max_results must be honored');
      assert.deepEqual(result.results, [
        { title: 'https://example.invalid/bare-string', url: 'https://example.invalid/bare-string' },
        { title: 'Object Citation', url: 'https://example.invalid/object' },
      ]);
    },
  );
});

// ── J. caching ────────────────────────────────────────────────────────────

test('J1: a known-unusable provider is not re-probed within the TTL', async () => {
  const callLog = freshCallLog();
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_CALL_LOG: callLog,
      PERPLEXITY_API_KEY: 'broke-key',
      WEB_SEARCH_PROVIDER_CACHE_TTL_MS: '60000',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 1 },
        duckduckgo: { exit: 0, stdout: searchEnvelope('duckduckgo answer', []) },
      }),
    },
    async () => {
      const r1 = await tavilySearch('query one');
      assert.equal(r1.answer, 'duckduckgo answer');
      const r2 = await tavilySearch('query two');
      assert.equal(r2.answer, 'duckduckgo answer');

      const calls = readCallLog(callLog);
      const perplexityCalls = calls.filter((c) => c === 'search perplexity').length;
      assert.equal(perplexityCalls, 1, 'perplexity should only have been actually invoked once; the 2nd call must hit the cache');
    },
  );
});

test('J2: a cached-unusable provider IS re-probed once the TTL elapses', async () => {
  const callLog = freshCallLog();
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_CALL_LOG: callLog,
      PERPLEXITY_API_KEY: 'broke-key',
      WEB_SEARCH_PROVIDER_CACHE_TTL_MS: '50',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 1 },
        duckduckgo: { exit: 0, stdout: searchEnvelope('duckduckgo answer', []) },
      }),
    },
    async () => {
      await tavilySearch('query one');
      await new Promise((resolve) => setTimeout(resolve, 120));
      await tavilySearch('query two');

      const calls = readCallLog(callLog);
      const perplexityCalls = calls.filter((c) => c === 'search perplexity').length;
      assert.equal(perplexityCalls, 2, 'once the TTL elapses the provider must be re-probed, not left cached forever');
    },
  );
});
