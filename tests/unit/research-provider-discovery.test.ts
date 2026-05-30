/**
 * Unit tests for the Research env -> provider selection (v4.1.5).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`,
 * which globs tests/unit/*.test.ts). No network, no DB.
 *
 * Core assertion (per the build brief): given a fake env, the right provider
 * is selected following the preference order PERPLEXITY > OPENAI > OLLAMA > XAI,
 * and an empty env yields no provider (honest empty-state, never fabricate).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectResearchProvider,
  researchAvailability,
  resolveApiKeyEnv,
  RESEARCH_PROVIDERS,
} from '../../src/lib/research/provider-discovery';

/** Run `fn` with a clean env containing only `vars`, then restore. */
function withEnv(vars: Record<string, string>, fn: () => void) {
  const keySet = new Set<string>();
  for (const p of RESEARCH_PROVIDERS) for (const e of p.envCandidates) keySet.add(e);
  // Also clear the fixture/base-url vars so they can't leak between tests.
  for (const k of ['OLLAMA_CLOUD_BASE_URL']) keySet.add(k);
  const KEYS = Array.from(keySet);
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// 1) Preference order: Perplexity wins over everything when its key is present.
test('PERPLEXITY wins when all keys present', () => {
  withEnv(
    {
      PERPLEXITY_API_KEY: 'pplx',
      OPENAI_API_KEY: 'oai',
      OLLAMA_CLOUD_API_KEY: 'oll',
      X_AI_API_KEY: 'xai',
    },
    () => {
      const sel = selectResearchProvider({ hydrate: false });
      assert.ok(sel, 'expected a provider to be selected');
      assert.equal(sel!.entry.slug, 'perplexity');
      assert.equal(sel!.apiKeyEnv, 'PERPLEXITY_API_KEY');
    }
  );
});

// 2) OpenAI is chosen when Perplexity is absent.
test('OPENAI wins over OLLAMA + XAI when Perplexity absent', () => {
  withEnv({ OPENAI_API_KEY: 'oai', OLLAMA_CLOUD_API_KEY: 'oll', X_AI_API_KEY: 'xai' }, () => {
    const sel = selectResearchProvider({ hydrate: false });
    assert.equal(sel!.entry.slug, 'openai');
  });
});

// 3) Ollama is chosen over xAI when both present but Perplexity/OpenAI absent.
test('OLLAMA wins over XAI when only those two present', () => {
  withEnv({ OLLAMA_CLOUD_API_KEY: 'oll', X_AI_API_KEY: 'xai' }, () => {
    const sel = selectResearchProvider({ hydrate: false });
    assert.equal(sel!.entry.slug, 'ollama');
    assert.equal(sel!.apiKeyEnv, 'OLLAMA_CLOUD_API_KEY');
  });
});

// 4) xAI is the final fallback (existing xAI boxes keep working).
test('XAI is the last-resort provider', () => {
  withEnv({ X_AI_API_KEY: 'xai' }, () => {
    const sel = selectResearchProvider({ hydrate: false });
    assert.equal(sel!.entry.slug, 'xai');
  });
});

// 5) No keys present => null selection + honest empty-state (never fabricate).
test('empty env yields no provider (honest empty-state)', () => {
  withEnv({}, () => {
    assert.equal(selectResearchProvider({ hydrate: false }), null);
    const a = researchAvailability({ hydrate: false });
    assert.equal(a.available, false);
    assert.equal(a.selected, null);
    // Still tells the operator which env vars would enable it.
    assert.deepEqual(a.enableHintEnvVars, [
      'PERPLEXITY_API_KEY',
      'OPENAI_API_KEY',
      'OLLAMA_CLOUD_API_KEY',
      'X_AI_API_KEY',
    ]);
  });
});

// 6) Alternate env-var spellings resolve.
test('alternate spellings resolve (PPLX_API_KEY, OLLAMA_API_KEY, XAI_API_KEY)', () => {
  withEnv({ PPLX_API_KEY: 'x' }, () => {
    const pplx = RESEARCH_PROVIDERS.find((p) => p.slug === 'perplexity')!;
    assert.equal(resolveApiKeyEnv(pplx), 'PPLX_API_KEY');
  });
  withEnv({ OLLAMA_API_KEY: 'x' }, () => {
    const sel = selectResearchProvider({ hydrate: false });
    assert.equal(sel!.entry.slug, 'ollama');
    assert.equal(sel!.apiKeyEnv, 'OLLAMA_API_KEY');
  });
  withEnv({ XAI_API_KEY: 'x' }, () => {
    const sel = selectResearchProvider({ hydrate: false });
    assert.equal(sel!.entry.slug, 'xai');
    assert.equal(sel!.apiKeyEnv, 'XAI_API_KEY');
  });
});

// 7) availability report marks present/absent per provider and names the model.
test('researchAvailability reports per-provider presence + selected provider', () => {
  withEnv({ OPENAI_API_KEY: 'oai', X_AI_API_KEY: 'xai' }, () => {
    const a = researchAvailability({ hydrate: false });
    assert.equal(a.available, true);
    assert.equal(a.selected, 'openai');
    assert.equal(a.selectedDisplayName, 'OpenAI');
    const byslug = Object.fromEntries(a.providers.map((p) => [p.slug, p]));
    assert.equal(byslug.perplexity.present, false);
    assert.equal(byslug.openai.present, true);
    assert.equal(byslug.ollama.present, false);
    assert.equal(byslug.xai.present, true);
    // Every provider advertises a default model + a call summary.
    for (const p of a.providers) {
      assert.ok(p.defaultModel.length > 0, `${p.slug} missing defaultModel`);
      assert.ok(p.callSummary.length > 0, `${p.slug} missing callSummary`);
    }
  });
});

// 8) The provider list is well-formed (4 providers, ordered, each with candidates).
test('RESEARCH_PROVIDERS is well-formed and in preference order', () => {
  assert.deepEqual(
    RESEARCH_PROVIDERS.map((p) => p.slug),
    ['perplexity', 'openai', 'ollama', 'xai']
  );
  for (const p of RESEARCH_PROVIDERS) {
    assert.ok(p.envCandidates.length > 0, `${p.slug} must have env candidates`);
    assert.ok(p.defaultModel.length > 0, `${p.slug} must have a default model`);
  }
});
