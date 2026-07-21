/**
 * CC-resear-001 — fabricated research must never become durable cited evidence.
 *
 * THE DEFECT (all four halves reproduced against the pre-fix code)
 * ---------------------------------------------------------------
 *  1. src/lib/research/providers.ts `readFixture()` honored five
 *     `*_FIXTURE_JSON_PATH` env vars and served a local JSON file in place of
 *     the live provider call — WITHOUT calling the repo's own
 *     `assertNoFixtureEnvInProduction()` guard, which gemini.ts, qc-scorer.ts
 *     and tavily.ts all wire in for exactly this reason.
 *  2. The canned answer — including fabricated `source_urls` and
 *     `citation_count` — was written to a durable `research_searches` row AND
 *     mirrored to `<vault>/research/YYYY/MM/*.md`, where the Memory full-text
 *     index ingests it as genuine cited research.
 *  3. `FIXTURE_ENV_VARS` did not name the research vars, so `activeFixtureEnvVars()`
 *     reported a box CLEAN while fixtures were live.
 *  4. .env.example documented the vars in a pastable block.
 *
 * WHAT THIS FILE LOCKS DOWN
 * -------------------------
 *  A. DETECTION — FIXTURE_ENV_VARS names all five research vars, so a
 *     diagnostic sweep can see them; `checkFixtureEnvVars()` reports them.
 *  B. PREVENTION (production) — the shared guard fires from inside the
 *     research adapters, matching gemini/qc-scorer/tavily.
 *  C. PREVENTION (every NODE_ENV) — a fixture-derived result is REFUSED a
 *     durable write: no research_searches row, no vault file. NODE_ENV is not
 *     the whole defence because a `next dev` box writes to the same DB and the
 *     same vault as a production one.
 *  D. NO REGRESSION — with no fixture var set the live path is untouched.
 *  E. TESTING STILL WORKS — fixture mode still returns a fully rendered
 *     result so an offline UI flow runs end-to-end; only the durable side
 *     effect is withheld, and the response says so.
 *
 * Isolation: `_isolated-db` is imported FIRST (C8 guard) so the durable-write
 * assertions run against a throwaway DATABASE_PATH, never mission-control.db.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  FIXTURE_ENV_VARS,
  RESEARCH_FIXTURE_ENV_VARS,
  activeFixtureEnvVars,
  activeResearchFixtureEnvVars,
  assertNoFixtureEnvInProduction,
} from '../../src/lib/fixture-guard';
import { runResearch } from '../../src/lib/research/providers';
import { createResearchSearch, listResearchSearches, slugifyQuery } from '../../src/lib/research-store';
import { checkFixtureEnvVars } from '../../src/lib/health/deep-checks';
import { vaultRoot } from '../../src/lib/platform';

// ── fixture file: a canned "researched" answer with FABRICATED citations ─────
// This is the exact shape the defect weaponised — a plausible answer plus
// source URLs that were never visited by anything.

const FABRICATED_ENVELOPE = {
  id: 'fixture-upstream-id',
  model: 'sonar-pro',
  choices: [{ message: { content: 'Fabricated answer that was never researched.' } }],
  citations: [
    'https://example.invalid/fabricated-source-one',
    'https://example.invalid/fabricated-source-two',
  ],
  usage: { total_tokens: 0 },
};

const FIXTURE_FILE = path.join(
  os.tmpdir(),
  `cc-resear-001-fixture-${process.pid}-${Date.now()}.json`,
);
fs.writeFileSync(FIXTURE_FILE, JSON.stringify(FABRICATED_ENVELOPE), 'utf8');

/** Restore every env var this suite touches, whatever a test did to it. */
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const k of Object.keys(patch)) saved.set(k, process.env[k]);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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

/** Clear every fixture var so a test starts from a genuinely clean box. */
const CLEAR_ALL_FIXTURES: Record<string, undefined> = Object.fromEntries(
  FIXTURE_ENV_VARS.map((n) => [n, undefined]),
) as Record<string, undefined>;

// ── A. DETECTION ────────────────────────────────────────────────────────────

test('CC-resear-001 A1: FIXTURE_ENV_VARS names every research fixture var', () => {
  // Pre-fix this list held only the QC/Gemini/Tavily vars, so a sweep could
  // not even NAME the vars that fabricate research citations.
  for (const name of [
    'PERPLEXITY_FIXTURE_JSON_PATH',
    'OPENAI_FIXTURE_JSON_PATH',
    'OLLAMA_FIXTURE_JSON_PATH',
    'XAI_FIXTURE_JSON_PATH',
    'X_AI_FIXTURE_JSON_PATH',
  ]) {
    assert.ok(
      (FIXTURE_ENV_VARS as readonly string[]).includes(name),
      `${name} must be in FIXTURE_ENV_VARS — a sweep cannot report what it does not know about`,
    );
    assert.ok(
      (RESEARCH_FIXTURE_ENV_VARS as readonly string[]).includes(name),
      `${name} must be in RESEARCH_FIXTURE_ENV_VARS`,
    );
  }
  // The original four must not have been dropped.
  for (const name of [
    'QC_FIXTURE_JSON_PATH',
    'QC_SIMULATE_PROVIDER_DOWN',
    'GEMINI_FIXTURE_JSON_PATH',
    'TAVILY_FIXTURE_JSON_PATH',
  ]) {
    assert.ok((FIXTURE_ENV_VARS as readonly string[]).includes(name), `${name} must still be listed`);
  }
});

test('CC-resear-001 A2: a live research fixture is REPORTED, not reported clean', () => {
  withEnv({ ...CLEAR_ALL_FIXTURES }, () => {
    // Clean box first — this is the only state that may report clean.
    assert.deepEqual(activeFixtureEnvVars(), [], 'no fixture vars set => empty');
    assert.deepEqual(activeResearchFixtureEnvVars(), []);
    const clean = checkFixtureEnvVars();
    assert.equal(clean.pass, true);
    assert.deepEqual(clean.active_fixture_env_vars, []);

    // Now turn on a research fixture. Pre-fix, BOTH of these still said "clean".
    process.env.PERPLEXITY_FIXTURE_JSON_PATH = FIXTURE_FILE;

    assert.deepEqual(
      activeFixtureEnvVars(),
      ['PERPLEXITY_FIXTURE_JSON_PATH'],
      'activeFixtureEnvVars() must surface the live research fixture',
    );
    assert.deepEqual(activeResearchFixtureEnvVars(), ['PERPLEXITY_FIXTURE_JSON_PATH']);

    const dirty = checkFixtureEnvVars();
    assert.equal(dirty.pass, false, 'the sweep must NOT report a box with live fixtures as passing');
    assert.deepEqual(dirty.active_fixture_env_vars, ['PERPLEXITY_FIXTURE_JSON_PATH']);
    assert.deepEqual(dirty.active_research_fixture_env_vars, ['PERPLEXITY_FIXTURE_JSON_PATH']);
    assert.match(dirty.detail, /PERPLEXITY_FIXTURE_JSON_PATH/);
    assert.match(dirty.detail, /ACTIVE/);
    // The sweep names the var but must never echo the path value.
    assert.ok(
      !dirty.detail.includes(FIXTURE_FILE),
      'the sweep must report NAMES only, never the fixture path value',
    );
  });
});

test('CC-resear-001 A3: an empty-string fixture var is not treated as active', () => {
  withEnv({ ...CLEAR_ALL_FIXTURES, XAI_FIXTURE_JSON_PATH: '   ' }, () => {
    assert.deepEqual(activeFixtureEnvVars(), [], 'whitespace-only is unset, not active');
    assert.equal(checkFixtureEnvVars().pass, true);
  });
});

// ── B. PREVENTION in production ─────────────────────────────────────────────

test('CC-resear-001 B1: the shared guard fires from INSIDE the research adapters', async () => {
  await withEnvAsync(
    {
      ...CLEAR_ALL_FIXTURES,
      NODE_ENV: 'production',
      PERPLEXITY_FIXTURE_JSON_PATH: FIXTURE_FILE,
    },
    async () => {
      // Sanity: the guard itself agrees the box is in the forbidden state.
      assert.throws(() => assertNoFixtureEnvInProduction(), /QC-11/);

      // Pre-fix this call RESOLVED with the fabricated citations. It must throw.
      await assert.rejects(
        () =>
          runResearch('perplexity', {
            query: 'anything',
            depth: 'shallow',
            model: 'sonar-pro',
            apiKey: 'unused-because-the-fixture-short-circuits',
          }),
        /QC-11/,
        'a production box must refuse to serve a canned research answer',
      );
    },
  );
});

// ── C. PREVENTION at every NODE_ENV — no durable contamination ──────────────

test('CC-resear-001 C1: a fixture-derived result is LABELLED so the truth travels with it', async () => {
  await withEnvAsync(
    { ...CLEAR_ALL_FIXTURES, NODE_ENV: 'test', PERPLEXITY_FIXTURE_JSON_PATH: FIXTURE_FILE },
    async () => {
      const result = await runResearch('perplexity', {
        query: 'anything',
        depth: 'shallow',
        model: 'sonar-pro',
        apiKey: 'unused',
      });
      assert.equal(result.isFixtureDerived, true, 'fixture provenance must ride on the payload');
      assert.equal(result.fixtureEnvVar, 'PERPLEXITY_FIXTURE_JSON_PATH');
      // It really did serve the canned citations — that is what makes the
      // label load-bearing rather than decorative.
      assert.equal(result.citations.length, 2);
    },
  );
});

test('CC-resear-001 C2: research-store REFUSES a fixture-derived row at every NODE_ENV', () => {
  const before = listResearchSearches({ limit: 1 }).total;

  // The exact metadata shape the search route builds, plus the fixture marker.
  assert.throws(
    () =>
      createResearchSearch({
        query: 'fabricated query',
        model: 'sonar-pro',
        result_markdown: '# Research result\n\nFabricated.',
        search_metadata: {
          provider: 'perplexity',
          citation_count: 2,
          source_urls: [
            'https://example.invalid/fabricated-source-one',
            'https://example.invalid/fabricated-source-two',
          ],
          fixture: true,
          fixture_env_var: 'PERPLEXITY_FIXTURE_JSON_PATH',
        },
      }),
    /CC-resear-001/,
    'fabricated source_urls/citation_count must never reach research_searches',
  );

  const after = listResearchSearches({ limit: 1 }).total;
  assert.equal(after, before, 'the refused write must not have inserted anything');
});

test('CC-resear-001 C3: NODE_ENV=production is NOT what stops the durable write', () => {
  // A `next dev` box writes to the SAME mission-control.db and the SAME vault
  // as a production box, so a NODE_ENV-gated defence would leave the real hole
  // open. The store tripwire must fire in development too.
  withEnv({ NODE_ENV: 'development' }, () => {
    assert.throws(
      () =>
        createResearchSearch({
          query: 'fabricated query in dev',
          model: 'sonar-pro',
          result_markdown: '# Research result',
          search_metadata: { fixture: true, fixture_env_var: 'XAI_FIXTURE_JSON_PATH' },
        }),
      /CC-resear-001/,
    );
  });
});

test('CC-resear-001 C4: the search route writes NO row and NO vault file in fixture mode', async () => {
  const query = `cc-resear-001 durable write probe ${Date.now()}`;
  const beforeTotal = listResearchSearches({ limit: 1 }).total;

  const res = await withEnvAsync(
    {
      ...CLEAR_ALL_FIXTURES,
      NODE_ENV: 'test',
      PERPLEXITY_FIXTURE_JSON_PATH: FIXTURE_FILE,
      // Make Perplexity the discovered provider so the route reaches the adapter.
      PERPLEXITY_API_KEY: 'test-key-not-used-fixture-short-circuits',
    },
    async () => {
      const { POST } = await import('../../src/app/api/operator/research/search/route');
      const req = new Request('http://localhost/api/operator/research/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, depth: 'shallow' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
      const response = await POST(req);
      return (await response.json()) as Record<string, unknown>;
    },
  );

  // The response is HONEST about what happened.
  assert.equal(res.fixture, true, 'the response must declare fixture mode');
  assert.equal(res.persisted, false, 'the response must declare that nothing was stored');
  assert.equal(res.search_id, null, 'there must be no durable id to cite');
  assert.equal(res.fixture_env_var, 'PERPLEXITY_FIXTURE_JSON_PATH');

  // Requirement E — the offline UI flow still gets a fully rendered result.
  const markdown = String(res.markdown_result || '');
  assert.match(markdown, /FIXTURE RESULT — NOT RESEARCH/, 'the markdown must be stamped, loudly');
  assert.match(markdown, /Fabricated answer that was never researched/, 'the body still renders');

  // THE HARM, ASSERTED DIRECTLY: nothing durable was created.
  assert.equal(
    listResearchSearches({ limit: 1 }).total,
    beforeTotal,
    'no research_searches row may be written for a fixture-derived result',
  );

  // ...and no vault file, which is what the Memory full-text index ingests.
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const expected = path.join(
    vaultRoot(),
    'research',
    yyyy,
    mm,
    `${yyyy}-${mm}-${dd}-${slugifyQuery(query)}.md`,
  );
  assert.equal(
    fs.existsSync(expected),
    false,
    `no vault file may be mirrored for a fixture-derived result (checked ${expected})`,
  );
});

// ── D. NO REGRESSION on the live path ───────────────────────────────────────

test('CC-resear-001 D1: with no fixture var set the adapter calls the live provider', async () => {
  await withEnvAsync({ ...CLEAR_ALL_FIXTURES, NODE_ENV: 'test' }, async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl: string | null = null;
    globalThis.fetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return new Response(
        JSON.stringify({
          id: 'live-id',
          model: 'sonar-pro',
          choices: [{ message: { content: 'A genuinely researched answer.' } }],
          citations: ['https://example.invalid/real-source'],
          usage: { total_tokens: 42 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    try {
      const result = await runResearch('perplexity', {
        query: 'live path',
        depth: 'shallow',
        model: 'sonar-pro',
        apiKey: 'k',
      });
      assert.equal(calledUrl, 'https://api.perplexity.ai/chat/completions', 'the live URL was called');
      assert.equal(result.answer, 'A genuinely researched answer.');
      assert.equal(result.citations.length, 1);
      assert.equal(result.isFixtureDerived, undefined, 'a live result must NOT be flagged fixture-derived');
      assert.equal(result.fixtureEnvVar, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('CC-resear-001 D2: a genuine (unflagged) research row still persists normally', () => {
  const before = listResearchSearches({ limit: 1 }).total;
  const row = createResearchSearch({
    query: `cc-resear-001 genuine row ${Date.now()}`,
    model: 'sonar-pro',
    result_markdown: '# Research result\n\nReal.',
    search_metadata: {
      provider: 'perplexity',
      citation_count: 1,
      source_urls: ['https://example.invalid/real-source'],
    },
  });
  assert.ok(row.id, 'a genuine research row must still be writable');
  assert.equal(
    listResearchSearches({ limit: 1 }).total,
    before + 1,
    'the tripwire must not block legitimate writes',
  );
});

test('CC-resear-001 D3: the guard is a no-op outside production, so fixtures still work in tests', async () => {
  await withEnvAsync(
    { ...CLEAR_ALL_FIXTURES, NODE_ENV: 'test', XAI_FIXTURE_JSON_PATH: FIXTURE_FILE },
    async () => {
      assert.doesNotThrow(() => assertNoFixtureEnvInProduction());
      const result = await runResearch('xai', {
        query: 'offline',
        depth: 'shallow',
        model: 'grok-4-fast',
        apiKey: 'unused',
      });
      assert.equal(result.answer, 'Fabricated answer that was never researched.');
      assert.equal(result.isFixtureDerived, true);
      assert.equal(result.fixtureEnvVar, 'XAI_FIXTURE_JSON_PATH');
    },
  );
});

// ── F. the documentation half — .env.example cannot be pasted live ──────────

test('CC-resear-001 F1: .env.example cannot silently enable fabrication when copied', () => {
  const envExample = fs.readFileSync(
    path.join(process.cwd(), '.env.example'),
    'utf8',
  );
  // Every fixture var must appear ONLY inside a comment, and never in the
  // `# VAR=` shape an operator can enable by deleting one character.
  for (const name of FIXTURE_ENV_VARS) {
    const pastable = new RegExp(`^\\s*#?\\s*${name}\\s*=`, 'm');
    assert.ok(
      !pastable.test(envExample),
      `.env.example must not contain a pastable "${name}=" line — uncommenting it enables fabrication`,
    );
  }
  assert.match(envExample, /TEST BYPASSES/, '.env.example must carry a stark warning');
  assert.match(envExample, /CC-resear-001/, '.env.example must point at the finding');
});
