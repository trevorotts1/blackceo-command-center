/**
 * FLEET DEFECT — SOP-authoring hard-depended on TAVILY_API_KEY.
 *
 * `src/lib/tavily.ts::tavilySearch()` used to throw when `TAVILY_API_KEY` was
 * unset, with no other path to a research result. Both callers —
 * `sop-authoring.ts` §4 (dispatch-time "Author SOP") and
 * `sop-auto-replace.ts`'s Track S — run under an explicit
 * fire-and-forget/NEVER-throw contract, so on any box without that key the
 * SOP pipeline silently never succeeded.
 *
 * THE FIX: `tavilySearch()` now falls back to
 * `nativeWebSearchFallback()` (src/lib/native-web-search.ts, which shells out
 * to `openclaw infer web search --provider <p> --json`) when no
 * `TAVILY_API_KEY` is set, instead of throwing.
 *
 * THIS SUITE PROVES, IN ORDER:
 *   A. [MANDATORY REGRESSION GUARD] TAVILY_API_KEY set → the Tavily REST path
 *      is used, completely unchanged — same URL, same request body, same
 *      return shape. A box with a working key must not be able to tell this
 *      change happened.
 *   B. TAVILY_API_KEY unset → the native fallback is used, and its result is
 *      mapped into the TavilyResponse shape correctly (content → answer,
 *      citations → results, both string and object citation shapes).
 *   C. Provider preference order: a failing preferred provider is skipped and
 *      the next one in PROVIDER_PREFERENCE is tried.
 *   D. TAVILY_API_KEY unset + the CLI itself fails — absent, non-zero exit,
 *      malformed JSON, real wall-clock timeout — every provider fails →
 *      graceful EMPTY result, no throw.
 *   E. TAVILY_FIXTURE_JSON_PATH is still honored, both with and without
 *      TAVILY_API_KEY set — the fixture short-circuits before either path.
 *
 * Test seam: OPENCLAW_CLI_BIN (already used by src/lib/openclaw/client.ts)
 * points execFile at a throwaway Node script standing in for the real
 * `openclaw` binary, so no live CLI or network call is required. The script
 * reads `--provider` from argv and looks up its behavior in
 * FAKE_CLI_BEHAVIOR_JSON (inherited via process.env, since execFile does not
 * override `env`), so one script serves every scenario below.
 *
 *   node --import tsx --test tests/unit/tavily-native-search-fallback.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tavilySearch } from '../../src/lib/tavily';

// ── fake `openclaw` CLI ──────────────────────────────────────────────────────
//
// Reads `--provider <p>` from argv, looks up `FAKE_CLI_BEHAVIOR_JSON[p]`:
//   { exit?: number, stdout?: string, delayMs?: number }
// Missing provider key defaults to { exit: 1 } (a failure), so a test only
// needs to describe the providers it cares about.

const FAKE_CLI_PATH = path.join(os.tmpdir(), `fake-openclaw-cli-${process.pid}.js`);
fs.writeFileSync(
  FAKE_CLI_PATH,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const providerIdx = args.indexOf('--provider');
const provider = providerIdx >= 0 ? args[providerIdx + 1] : '';
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

/** Restore every env var this suite touches, whatever a test did to it. */
async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
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

const BASE_ENV = {
  TAVILY_API_KEY: undefined,
  TAVILY_FIXTURE_JSON_PATH: undefined,
  OPENCLAW_CLI_BIN: FAKE_CLI_PATH,
  OPENCLAW_WEB_SEARCH_TIMEOUT_MS: undefined,
  FAKE_CLI_BEHAVIOR_JSON: undefined,
};

// ── A. MANDATORY REGRESSION GUARD ────────────────────────────────────────────

test('A: TAVILY_API_KEY set -> Tavily REST path used, unchanged (regression guard)', async () => {
  await withEnv({ ...BASE_ENV, TAVILY_API_KEY: 'real-tavily-key' }, async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl: string | null = null;
    let calledBody: unknown = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          // Deliberately distinct from the input query, to prove the
          // pre-fallback behavior is preserved exactly: the live Tavily path
          // returns the upstream response VERBATIM (unlike the fixture path,
          // which does overwrite `query`) — no rewriting was introduced.
          query: 'tavily-echoed-query-untouched',
          results: [{ title: 'Real Tavily result', url: 'https://example.invalid/real', content: 'c' }],
          answer: 'A real Tavily answer.',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    try {
      const result = await tavilySearch('best practices sales 2026', { max_results: 3 });

      // Same URL, same request shape as the pre-fallback implementation.
      assert.equal(calledUrl, 'https://api.tavily.com/search');
      assert.deepEqual(calledBody, {
        api_key: 'real-tavily-key',
        query: 'best practices sales 2026',
        search_depth: 'basic',
        include_answer: true,
        max_results: 3,
      });

      // Same return shape — the native fallback was never touched, and the
      // upstream response is passed through unmodified (query included).
      assert.deepEqual(result, {
        query: 'tavily-echoed-query-untouched',
        results: [{ title: 'Real Tavily result', url: 'https://example.invalid/real', content: 'c' }],
        answer: 'A real Tavily answer.',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('A2: TAVILY_API_KEY set -> a Tavily HTTP error still throws exactly as before', async () => {
  await withEnv({ ...BASE_ENV, TAVILY_API_KEY: 'real-tavily-key' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('bad request', { status: 400 })) as unknown as typeof fetch;
    try {
      await assert.rejects(
        () => tavilySearch('anything'),
        /Tavily search failed: 400/,
        'a Tavily API error must still propagate as a throw when a key IS configured',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── B. native fallback used + mapped correctly ───────────────────────────────

test('B1: TAVILY_API_KEY unset -> native fallback used, string citations mapped', async () => {
  const cliOutput = JSON.stringify({
    outputs: [
      {
        result: {
          content: 'A grounded native-search answer.',
          citations: ['https://example.invalid/one', 'https://example.invalid/two'],
        },
      },
    ],
  });
  await withEnv(
    { ...BASE_ENV, FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({ perplexity: { exit: 0, stdout: cliOutput } }) },
    async () => {
      const result = await tavilySearch('dept research query');
      assert.equal(result.query, 'dept research query');
      assert.equal(result.answer, 'A grounded native-search answer.');
      assert.deepEqual(result.results, [
        { title: 'https://example.invalid/one', url: 'https://example.invalid/one' },
        { title: 'https://example.invalid/two', url: 'https://example.invalid/two' },
      ]);
    },
  );
});

test('B2: object citations {title,url} mapped correctly, max_results honored', async () => {
  const cliOutput = JSON.stringify({
    outputs: [
      {
        result: {
          content: 'Answer with object citations.',
          citations: [
            { title: 'First Source', url: 'https://example.invalid/a' },
            { title: 'Second Source', url: 'https://example.invalid/b' },
            { title: 'Third Source', url: 'https://example.invalid/c' },
          ],
        },
      },
    ],
  });
  await withEnv(
    { ...BASE_ENV, FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({ perplexity: { exit: 0, stdout: cliOutput } }) },
    async () => {
      const result = await tavilySearch('query', { max_results: 2 });
      assert.equal(result.results.length, 2, 'max_results must be honored against the mapped citations');
      assert.deepEqual(result.results, [
        { title: 'First Source', url: 'https://example.invalid/a' },
        { title: 'Second Source', url: 'https://example.invalid/b' },
      ]);
    },
  );
});

// ── C. provider preference order ─────────────────────────────────────────────

test('C1: a failing preferred provider is skipped in favor of the next one', async () => {
  const geminiOutput = JSON.stringify({
    outputs: [{ result: { content: 'Answer from gemini.', citations: ['https://example.invalid/gemini'] } }],
  });
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 1 }, // fails — not configured
        gemini: { exit: 0, stdout: geminiOutput },
        duckduckgo: { exit: 0, stdout: JSON.stringify({ outputs: [{ result: { content: 'should not be reached' } }] }) },
      }),
    },
    async () => {
      const result = await tavilySearch('provider preference query');
      assert.equal(result.answer, 'Answer from gemini.', 'perplexity failed, so gemini (next in order) must win');
    },
  );
});

test('C2: duckduckgo is the zero-credential floor when both paid providers fail', async () => {
  const ddgOutput = JSON.stringify({
    outputs: [{ result: { content: 'Answer from duckduckgo.', citations: ['https://example.invalid/ddg'] } }],
  });
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 1 },
        gemini: { exit: 1 },
        duckduckgo: { exit: 0, stdout: ddgOutput },
      }),
    },
    async () => {
      const result = await tavilySearch('floor provider query');
      assert.equal(result.answer, 'Answer from duckduckgo.');
    },
  );
});

// ── D. total failure -> graceful empty, NEVER throw ──────────────────────────

test('D1: CLI binary absent -> graceful empty result, no throw', async () => {
  await withEnv({ ...BASE_ENV, OPENCLAW_CLI_BIN: '/nonexistent/openclaw-cli-that-does-not-exist' }, async () => {
    const result = await tavilySearch('absent cli query');
    assert.deepEqual(result, { query: 'absent cli query', results: [], answer: undefined });
  });
});

test('D2: every provider exits non-zero -> graceful empty result, no throw', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 1 },
        gemini: { exit: 1 },
        duckduckgo: { exit: 1 },
      }),
    },
    async () => {
      const result = await tavilySearch('all fail query');
      assert.deepEqual(result, { query: 'all fail query', results: [], answer: undefined });
    },
  );
});

test('D3: malformed JSON from every provider -> graceful empty result, no throw', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 0, stdout: 'not valid json{{{' },
        gemini: { exit: 0, stdout: 'also not json' },
        duckduckgo: { exit: 0, stdout: '' },
      }),
    },
    async () => {
      const result = await tavilySearch('malformed json query');
      assert.deepEqual(result, { query: 'malformed json query', results: [], answer: undefined });
    },
  );
});

test('D4: a real wall-clock timeout on every provider -> graceful empty result, no throw', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      OPENCLAW_WEB_SEARCH_TIMEOUT_MS: '300',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { delayMs: 2000, exit: 0, stdout: '{}' },
        gemini: { delayMs: 2000, exit: 0, stdout: '{}' },
        duckduckgo: { delayMs: 2000, exit: 0, stdout: '{}' },
      }),
    },
    async () => {
      const start = Date.now();
      const result = await tavilySearch('timeout query');
      const elapsed = Date.now() - start;
      assert.deepEqual(result, { query: 'timeout query', results: [], answer: undefined });
      // Each provider's execFile is killed at ~300ms; 3 providers serially
      // should finish well under the 2000ms per-provider delay that would
      // prove the timeout did NOT fire.
      assert.ok(elapsed < 5000, `expected the 300ms timeout to cut each provider short, took ${elapsed}ms`);
    },
  );
});

// ── E. TAVILY_FIXTURE_JSON_PATH still honored ────────────────────────────────

test('E1: fixture short-circuits both paths when TAVILY_API_KEY is unset', async () => {
  const fixtureFile = path.join(os.tmpdir(), `tavily-fixture-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(
    fixtureFile,
    JSON.stringify({ query: 'ignored', results: [{ title: 'Fixture result', url: 'https://example.invalid/fx' }], answer: 'Fixture answer.' }),
  );
  await withEnv({ ...BASE_ENV, TAVILY_FIXTURE_JSON_PATH: fixtureFile }, async () => {
    const result = await tavilySearch('fixture query');
    assert.equal(result.query, 'fixture query', 'the query arg overwrites the fixture query field');
    assert.equal(result.answer, 'Fixture answer.');
    assert.deepEqual(result.results, [{ title: 'Fixture result', url: 'https://example.invalid/fx' }]);
  });
});

test('E2: fixture takes priority even when TAVILY_API_KEY IS set (no live Tavily call, no CLI call)', async () => {
  const fixtureFile = path.join(os.tmpdir(), `tavily-fixture-withkey-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(
    fixtureFile,
    JSON.stringify({ query: 'ignored', results: [], answer: 'Fixture answer with key set.' }),
  );
  await withEnv({ ...BASE_ENV, TAVILY_API_KEY: 'real-key', TAVILY_FIXTURE_JSON_PATH: fixtureFile }, async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('fetch must not be called when a fixture is set');
    }) as unknown as typeof fetch;
    try {
      const result = await tavilySearch('fixture with key query');
      assert.equal(result.answer, 'Fixture answer with key set.');
      assert.equal(fetchCalled, false, 'the fixture must short-circuit before the Tavily REST call');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
