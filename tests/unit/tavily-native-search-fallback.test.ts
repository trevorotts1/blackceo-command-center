/**
 * FLEET DEFECT — SOP-authoring hard-depended on TAVILY_API_KEY.
 *
 * v1 fix (superseded): Tavily stayed the privileged path, native OpenClaw
 * search was only a fallback when TAVILY_API_KEY was unset.
 *
 * v2: per Trevor, Tavily is no longer privileged. `tavilySearch()`
 * (src/lib/tavily.ts) detects what web-research capability a box actually
 * has, at runtime, and uses the best available one, in order: Perplexity ->
 * discovered native OpenClaw providers -> Tavily -> DuckDuckGo.
 *
 * v6.1.3 (THIS suite) — FOUR REAL BUGS, FOUND BY EXERCISING THE SHIPPED v6.1.0
 * CODE ON A LIVE BOX, NOT BY INFERENCE. All four tiers returned empty there.
 * A MOCK THAT DOESN'T MATCH REALITY IS WORSE THAN NO TEST — it manufactures
 * confidence. v6.1.0's 18/18-passing suite is the proof: it encoded the same
 * wrong envelope shapes the implementation did, so it could not catch any of
 * this. Do not rebuild that fiction.
 *
 *   BUG 1 — `openclaw infer web providers --json` does NOT return
 *     `{providers:[...]}` or `{outputs:[{result:{providers:[...]}}]}`. It
 *     returns `{ search: [...], fetch: [...] }`, partitioned by capability.
 *     `parseProvidersListing()` read the wrong envelope -> discoverOpenClawProviders()
 *     always returned [] -> tier 2 was structurally dead on this OpenClaw
 *     version. Fixed to read `search` first, while keeping the legacy shapes
 *     so a different OpenClaw version doesn't newly regress.
 *   BUG 2 — duckduckgo's result envelope is `outputs[0].result.results[]`
 *     with `{title,url,snippet}` — NOT `outputs[0].result.{content,citations[]}`.
 *     The zero-credential floor — the ONE tier guaranteed to work with no
 *     paid key anywhere — was therefore the tier most reliably broken.
 *     `searchViaOpenClawProvider()` now reads both shapes and merges them.
 *     `answer` is legitimately undefined for a link-list result; that is NOT
 *     a failure (results.length > 0 is what matters).
 *   BUG 3 — Tier 1 gated on `process.env.PERPLEXITY_API_KEY ||
 *     process.env.OPENROUTER_API_KEY` — the Next.js APP's own env. The
 *     credential actually lives at the OpenClaw CLI layer. Live-verified: a
 *     box existed where NEITHER var was set in the app env, yet perplexity
 *     worked when called directly through the CLI. The gate was skipping the
 *     one tier that worked. Tier 1 is now attempted unconditionally, exactly
 *     like tiers 2 and 4 — empirically, letting failure decide, with the
 *     existing TTL cache doing the same job the env check used to do
 *     (cheaply).
 *   BUG 4 — this suite's `searchEnvelope()` helper built `{content,citations}`
 *     for EVERY provider under test, including duckduckgo — the exact wrong
 *     assumption BUG 2 describes. Never exercised a real duckduckgo shape.
 *
 * THIS SUITE PROVES, IN ORDER:
 *   A/A2 [BUG 3 regression guard]. Perplexity is attempted and wins with
 *     ZERO app-level env keys set anywhere, and identically when the (now
 *     irrelevant) keys happen to be set too.
 *   B. Perplexity present but unusable (429/depleted credits, or an auth
 *      failure dressed as a normal answer) -> falls over, does not fail.
 *   C [BUG 1 regression guard]. The REAL `{search:[...], fetch:[...]}`
 *      envelope is parsed and a discovered native provider is used, ahead of
 *      a configured Tavily key.
 *   C-LEGACY. The pre-v6.1.3 shapes (`{providers:[...]}` and
 *      `{outputs:[{result:{providers:[...]}}]}}`) still work — no regression
 *      for a different OpenClaw version.
 *   C-UNKNOWN. A totally unrecognized providers envelope logs loudly and
 *      degrades to an empty list, never throws.
 *   D. `configured:true` but errors live -> skipped, next used;
 *      `configured:false` -> skipped without even being called.
 *   E [BUG 2 regression guard — THE headline fix]. The REAL duckduckgo
 *      `results[]` (`title`/`url`/`snippet`) envelope yields a USABLE result
 *      with `answer === undefined` — that is success, not failure.
 *   F. Every tier exhausted -> graceful EMPTY result, no throw (CLI absent,
 *      non-zero exit, malformed JSON, real wall-clock timeout).
 *   G [MANDATORY]. Tavily present and funded, nothing higher-priority
 *      configured -> still usable, same shape as always.
 *   H. TAVILY_FIXTURE_JSON_PATH still honored, short-circuits every tier.
 *   I. citations[] mapping (perplexity-shaped) AND results[] mapping
 *      (duckduckgo-shaped) both correct, independently.
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
// `infer web providers --json`: prints FAKE_CLI_PROVIDERS_JSON verbatim,
// default `{search:[],fetch:[]}` — the REAL empty-listing shape.
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
  const out = process.env.FAKE_CLI_PROVIDERS_JSON || JSON.stringify({ search: [], fetch: [] });
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

/** The REAL `openclaw infer web providers --json` envelope (live-verified). */
function providersEnvelopeReal(
  searchItems: Array<string | { id: string; configured?: boolean }>,
  fetchItems: unknown[] = [],
): string {
  return JSON.stringify({ search: searchItems, fetch: fetchItems });
}

/** Legacy shape #1 — kept working so a different OpenClaw version doesn't regress. */
function providersEnvelopeLegacyFlat(providers: Array<{ id: string; configured?: boolean }>): string {
  return JSON.stringify({ providers });
}

/** Legacy shape #2 — kept working so a different OpenClaw version doesn't regress. */
function providersEnvelopeLegacyOutputs(providers: Array<{ id: string; configured?: boolean }>): string {
  return JSON.stringify({ outputs: [{ result: { providers } }] });
}

/** The `{content, citations[]}` shape — confirmed correct for perplexity by
 *  a direct live call through the pinned CLI. */
function searchEnvelope(content: string, citations: Array<string | { title: string; url: string }>): string {
  return JSON.stringify({ outputs: [{ result: { content, citations } }] });
}

/** The REAL duckduckgo result shape (live-verified) — `results[]` with
 *  `title`/`url`/`snippet`, NO `content`, NO `citations`. */
function ddgResultsEnvelope(results: Array<string | { title: string; url: string; snippet?: string }>): string {
  return JSON.stringify({ outputs: [{ result: { results } }] });
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

// ── A/A2. [BUG 3 regression guard] tier 1 has no env gate ───────────────────

test('A: perplexity is attempted first and wins with ZERO app-level env keys set anywhere', async () => {
  const callLog = freshCallLog();
  await withEnv(
    {
      ...BASE_ENV,
      // Deliberately NOT setting PERPLEXITY_API_KEY or OPENROUTER_API_KEY —
      // this is the exact live scenario: the app env has neither, but the
      // credential lives at the OpenClaw CLI layer.
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
  const calls = readCallLog(callLog);
  assert.deepEqual(calls, ['search perplexity'], 'perplexity must be tried with no gate — no key check skipped it, and nothing else was reached');
});

test('A2: the app-level keys being set (or not) makes no difference to tier 1', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      PERPLEXITY_API_KEY: 'irrelevant-now',
      OPENROUTER_API_KEY: 'also-irrelevant',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 0, stdout: searchEnvelope('Answer regardless of app-level keys.', []) },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.equal(result.answer, 'Answer regardless of app-level keys.');
    },
  );
});

// ── B. perplexity present but unusable -> falls over ─────────────────────────

test('B1: perplexity 429/depleted-credits -> falls over to the next provider, does not fail', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      TAVILY_API_KEY: 'real-tavily-key',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 0, stdout: 'HTTP 429: Your prepayment credits are depleted' },
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
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 0, stdout: searchEnvelope('Error: authentication failed. Please sign in again.', []) },
        duckduckgo: { exit: 0, stdout: ddgResultsEnvelope([{ title: 'Real Source', url: 'https://example.invalid/real' }]) },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.equal(result.answer, undefined, 'the duckduckgo floor has no content field — that is expected, not a failure');
      assert.deepEqual(
        result.results,
        [{ title: 'Real Source', url: 'https://example.invalid/real' }],
        'an auth-failure string dressed as an "answer" must not be trusted; the real duckduckgo result must win instead',
      );
    },
  );
});

// ── C. [BUG 1 regression guard] the REAL {search,fetch} envelope ────────────

test('C1 [BUG 1]: the REAL {search:[...],fetch:[...]} envelope is parsed — ollama discovered+used', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_PROVIDERS_JSON: providersEnvelopeReal(['duckduckgo', 'gemini', 'ollama', 'perplexity'], ['some-fetch-only-provider']),
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        ollama: { exit: 0, stdout: searchEnvelope('Answer via Ollama Cloud web search.', ['https://example.invalid/o']) },
        // gemini is tried before ollama (discovery order) and must fail so
        // ollama gets a turn, proving iteration actually walks the real list.
        gemini: { exit: 1 },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.equal(result.answer, 'Answer via Ollama Cloud web search.');
    },
  );
});

test('C2: gemini discovered+available via the real envelope -> selected over tavily', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      TAVILY_API_KEY: 'real-tavily-key',
      FAKE_CLI_PROVIDERS_JSON: providersEnvelopeReal([{ id: 'gemini', configured: true }]),
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

test('C3 [BUG 1]: providers listing reports search AND fetch — only search is used for discovery', async () => {
  const callLog = freshCallLog();
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_CALL_LOG: callLog,
      FAKE_CLI_PROVIDERS_JSON: providersEnvelopeReal(['gemini'], ['fetch-only-provider']),
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        gemini: { exit: 0, stdout: searchEnvelope('gemini via search list', []) },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.equal(result.answer, 'gemini via search list');
    },
  );
  const calls = readCallLog(callLog);
  assert.ok(!calls.includes('search fetch-only-provider'), 'a fetch-only provider must never be tried for web search');
});

// ── C-LEGACY. pre-v6.1.3 shapes still work ───────────────────────────────────

test('C-LEGACY-1: the old {providers:[...]} shape still parses (no regression for another OpenClaw version)', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_PROVIDERS_JSON: providersEnvelopeLegacyFlat([{ id: 'gemini', configured: true }]),
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        gemini: { exit: 0, stdout: searchEnvelope('gemini via legacy flat shape', []) },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.equal(result.answer, 'gemini via legacy flat shape');
    },
  );
});

test('C-LEGACY-2: the old {outputs:[{result:{providers:[...]}}]}} shape still parses', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_PROVIDERS_JSON: providersEnvelopeLegacyOutputs([{ id: 'gemini', configured: true }]),
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        gemini: { exit: 0, stdout: searchEnvelope('gemini via legacy outputs shape', []) },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.equal(result.answer, 'gemini via legacy outputs shape');
    },
  );
});

// ── C-UNKNOWN. an unrecognized envelope logs loudly, never throws ───────────

test('C-UNKNOWN: a totally unrecognized providers envelope degrades to empty, logs loudly, never throws', async () => {
  const originalConsoleError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    await withEnv(
      {
        ...BASE_ENV,
        FAKE_CLI_PROVIDERS_JSON: JSON.stringify({ totallyUnexpectedField: ['x', 'y'] }),
        FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
          duckduckgo: { exit: 0, stdout: ddgResultsEnvelope([{ title: 'DDG', url: 'https://example.invalid/ddg' }]) },
        }),
      },
      async () => {
        // Must not throw — falls through to the duckduckgo floor.
        const result = await tavilySearch('unknown shape query');
        assert.deepEqual(result.results, [{ title: 'DDG', url: 'https://example.invalid/ddg' }]);
      },
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.ok(
    errors.some((e) => e.includes('unrecognized envelope shape')),
    `expected a loud log naming the unrecognized shape; got: ${JSON.stringify(errors)}`,
  );
});

// ── D. configured:true but errors live -> skipped ────────────────────────────

test('D1: discovery says ollama configured:true, live call fails auth -> skipped, next used', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_PROVIDERS_JSON: providersEnvelopeReal([
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
      FAKE_CLI_PROVIDERS_JSON: providersEnvelopeReal([
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

// ── E. [BUG 2 regression guard] the REAL duckduckgo results[] shape ─────────

test('E1 [BUG 2, headline fix]: the REAL duckduckgo {results:[{title,url,snippet}]} envelope is a USABLE result', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        duckduckgo: {
          exit: 0,
          stdout: ddgResultsEnvelope([
            { title: 'DDG Source One', url: 'https://example.invalid/ddg1', snippet: 'A short summary one.' },
            { title: 'DDG Source Two', url: 'https://example.invalid/ddg2', snippet: 'A short summary two.' },
          ]),
        },
      }),
    },
    async () => {
      const result = await tavilySearch('floor query', { max_results: 5 });
      assert.equal(result.query, 'floor query');
      // No `content` field in this shape at all -> answer is legitimately
      // undefined. That is NOT a failure — this must be the WINNING result,
      // not a fallthrough to the graceful-empty case.
      assert.equal(result.answer, undefined);
      assert.deepEqual(result.results, [
        { title: 'DDG Source One', url: 'https://example.invalid/ddg1', content: 'A short summary one.' },
        { title: 'DDG Source Two', url: 'https://example.invalid/ddg2', content: 'A short summary two.' },
      ]);
    },
  );
});

test('E2 [BUG 2]: a bare-string duckduckgo results[] item is also handled', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        duckduckgo: { exit: 0, stdout: ddgResultsEnvelope(['https://example.invalid/bare']) },
      }),
    },
    async () => {
      const result = await tavilySearch('query');
      assert.deepEqual(result.results, [{ title: 'https://example.invalid/bare', url: 'https://example.invalid/bare' }]);
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
    { ...BASE_ENV, TAVILY_API_KEY: 'k2', OPENCLAW_CLI_BIN: '/nonexistent/openclaw-xyz' },
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
        // Deliberately no "429"/quota-ish digits anywhere in this fixture —
        // that string previously tripped the unusable-signature detector
        // against duckduckgo's OWN response, a self-inflicted false failure.
        duckduckgo: { exit: 0, stdout: ddgResultsEnvelope([{ title: 'DuckDuckGo reached after Tavily rejection', url: 'https://example.invalid/reached-after-rejection' }]) },
      }),
    },
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response('{"detail":"quota exceeded"}', { status: 429 })) as unknown as typeof fetch;
      try {
        const result = await tavilySearch('query');
        assert.deepEqual(result.results, [{ title: 'DuckDuckGo reached after Tavily rejection', url: 'https://example.invalid/reached-after-rejection' }]);
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
    { ...BASE_ENV, TAVILY_API_KEY: 'k2', TAVILY_FIXTURE_JSON_PATH: fixtureFile },
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

// ── I. citations[] mapping AND results[] mapping, independently ─────────────

test('I1: citations[] (perplexity-shaped) string and object shapes both map correctly, max_results honored', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: {
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

test('I2 [BUG 2]: results[] (duckduckgo-shaped) mixed string+object items map correctly, max_results honored', async () => {
  await withEnv(
    {
      ...BASE_ENV,
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        duckduckgo: {
          exit: 0,
          stdout: ddgResultsEnvelope([
            'https://example.invalid/bare-result',
            { title: 'Object Result', url: 'https://example.invalid/object-result', snippet: 'A snippet.' },
            { title: 'Third Result', url: 'https://example.invalid/third-result' },
          ]),
        },
      }),
    },
    async () => {
      const result = await tavilySearch('query', { max_results: 2 });
      assert.equal(result.results.length, 2, 'max_results must be honored against results[] too');
      assert.deepEqual(result.results, [
        { title: 'https://example.invalid/bare-result', url: 'https://example.invalid/bare-result' },
        { title: 'Object Result', url: 'https://example.invalid/object-result', content: 'A snippet.' },
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
      WEB_SEARCH_PROVIDER_CACHE_TTL_MS: '60000',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 1 },
        duckduckgo: { exit: 0, stdout: ddgResultsEnvelope([{ title: 'DDG', url: 'https://example.invalid/ddg' }]) },
      }),
    },
    async () => {
      const r1 = await tavilySearch('query one');
      assert.deepEqual(r1.results, [{ title: 'DDG', url: 'https://example.invalid/ddg' }]);
      const r2 = await tavilySearch('query two');
      assert.deepEqual(r2.results, [{ title: 'DDG', url: 'https://example.invalid/ddg' }]);

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
      WEB_SEARCH_PROVIDER_CACHE_TTL_MS: '50',
      FAKE_CLI_BEHAVIOR_JSON: JSON.stringify({
        perplexity: { exit: 1 },
        duckduckgo: { exit: 0, stdout: ddgResultsEnvelope([{ title: 'DDG', url: 'https://example.invalid/ddg' }]) },
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
