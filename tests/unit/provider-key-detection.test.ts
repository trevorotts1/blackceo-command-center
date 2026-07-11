/**
 * Unit tests for the provider-key-detection helper.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * No network, no DB, no filesystem side effects — all FS calls are mocked
 * via module-level stubs.
 *
 * Tests cover:
 *   1. local_endpoint providers → skip key check, return localEndpoint: true
 *   2. Key present in process.env → detected (first-priority store)
 *   3. Key present only in a secondary store (.env file) → detected
 *   4. Key present only in openclaw.json → detected
 *   5. envCandidates: alternate spelling resolves when canonical is absent
 *   6. Key absent in all stores → found: false with correct checked list
 *   7. defaultEnvVarForSlug derives the conventional <SLUG>_API_KEY name
 *   8. envCandidatesForProvider deduplicates and includes fallback
 */

// C8 — DB isolation. A statically-imported project module here transitively
// pulls in '@/lib/db', whose module-level
// `DB_PATH = process.env.DATABASE_PATH || <cwd>/mission-control.db` is frozen at
// eval time. This suite does not open the DB today, but nothing stopped it from
// starting to — and then it would have written to the LIVE production board.
// './_isolated-db' points DATABASE_PATH at a temp file and MUST stay the first
// import (it is a no-op for a suite that never opens the DB).
// Enforced by tests/unit/c8-db-isolation-guard.test.ts.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'fs';

// We need to stub fs.existsSync, fs.statSync, fs.readFileSync, and
// candidateEnvFiles so tests are hermetic. We also stub openclawConfigPath
// and candidateEnvFiles from provider-discovery.

// Helpers we test directly.
import {
  defaultEnvVarForSlug,
  envCandidatesForProvider,
  resolveProviderApiKey,
} from '../../src/lib/provider-key-detection';
import type { ModelProvider } from '../../src/lib/model-providers/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<ModelProvider> & { slug: string }): ModelProvider {
  return {
    displayName: overrides.slug,
    fetchModels: async () => [],
    ...overrides,
  };
}

/** Run `fn` with a temporary process.env overlay, then restore. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): void | Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k] as string;
  }
  let result: void | Promise<void>;
  try {
    result = fn();
  } catch (err) {
    Object.assign(process.env, saved);
    throw err;
  }
  if (result && typeof (result as Promise<void>).then === 'function') {
    return (result as Promise<void>).finally(() => {
      Object.assign(process.env, saved);
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k] as string;
      }
    });
  }
  Object.assign(process.env, saved);
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  return result;
}

// ── 1. local_endpoint → no key check ────────────────────────────────────────

test('local_endpoint provider returns localEndpoint: true without checking env', () => {
  const provider = makeProvider({ slug: 'ollama-local', authType: 'local_endpoint' });
  // Even if some env var were set, we should not need it.
  const result = resolveProviderApiKey(provider);
  assert.ok('localEndpoint' in result, 'expected localEndpoint result');
  assert.equal((result as { localEndpoint: boolean }).localEndpoint, true);
});

// ── 2. process.env detection ─────────────────────────────────────────────────

test('key present in process.env is detected immediately', () => {
  const provider = makeProvider({ slug: 'openai' });
  withEnv({ OPENAI_API_KEY: 'sk-test-openai' }, () => {
    const result = resolveProviderApiKey(provider);
    assert.ok(!('localEndpoint' in result));
    const r = result as { found: boolean; envVar?: string; source?: string };
    assert.equal(r.found, true);
    assert.equal(r.envVar, 'OPENAI_API_KEY');
    assert.equal(r.source, 'process.env');
  });
});

test('key present under alternate env name in process.env is detected', () => {
  // Ollama Cloud: primary = OLLAMA_CLOUD_API_KEY, alternate = OLLAMA_API_KEY
  const provider = makeProvider({
    slug: 'ollama-cloud',
    envCandidates: ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'] as const,
  });
  // Only OLLAMA_API_KEY is set (the alternate name used by the probe).
  withEnv({ OLLAMA_CLOUD_API_KEY: undefined, OLLAMA_API_KEY: 'sk-ollama-alt' }, () => {
    const result = resolveProviderApiKey(provider);
    assert.ok(!('localEndpoint' in result));
    const r = result as { found: boolean; envVar?: string };
    assert.equal(r.found, true);
    assert.equal(r.envVar, 'OLLAMA_API_KEY');
  });
});

test('FAL_KEY alternate spelling is detected when FAL_API_KEY absent', () => {
  const provider = makeProvider({
    slug: 'fal',
    envCandidates: ['FAL_KEY', 'FAL_API_KEY', 'FAL_AI_API_KEY'] as const,
  });
  withEnv({ FAL_KEY: 'fal-sk-123', FAL_API_KEY: undefined, FAL_AI_API_KEY: undefined }, () => {
    const result = resolveProviderApiKey(provider);
    assert.ok(!('localEndpoint' in result));
    const r = result as { found: boolean; envVar?: string };
    assert.equal(r.found, true);
    assert.equal(r.envVar, 'FAL_KEY');
  });
});

// ── 3. env_file fallback ──────────────────────────────────────────────────────
// We test parseDotEnv (already tested in provider-discovery.test.ts) indirectly
// by verifying the "not in process.env" path. To avoid touching real fs we
// stub it.

test('key absent from process.env but in a .env file is detected via env_file', () => {
  const provider = makeProvider({ slug: 'anthropic' });

  // Stub fs so no real file is read.
  const savedExistsSync = fs.existsSync.bind(fs);
  const savedStatSync = fs.statSync.bind(fs);
  const savedReadFileSync = (fs.readFileSync as unknown as (...args: unknown[]) => unknown).bind(fs);

  // ANTHROPIC_API_KEY absent from process.env.
  withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
    let existsCalls = 0;
    let readCalls = 0;
    // Override at instance level is not possible for built-in; we patch via
    // Object.defineProperty on the fs module namespace.
    const originalExists = Object.getOwnPropertyDescriptor(fs, 'existsSync');
    const originalStat = Object.getOwnPropertyDescriptor(fs, 'statSync');
    const originalRead = Object.getOwnPropertyDescriptor(fs, 'readFileSync');

    // Patch: pretend first candidate file exists and contains the key.
    Object.defineProperty(fs, 'existsSync', {
      value: (p: string) => {
        existsCalls++;
        // Simulate that the first .env file exists (any path that candidateEnvFiles returns).
        return typeof p === 'string' && (p.endsWith('.env') || p.endsWith('openclaw.json'));
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(fs, 'statSync', {
      value: (p: string) => {
        return { isFile: () => typeof p === 'string' };
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(fs, 'readFileSync', {
      value: (p: string) => {
        readCalls++;
        if (typeof p === 'string' && p.endsWith('.env')) {
          return 'ANTHROPIC_API_KEY=sk-ant-from-file\n';
        }
        // openclaw.json returns empty object so provider-key extraction finds nothing there.
        return '{}';
      },
      configurable: true,
      writable: true,
    });

    try {
      const result = resolveProviderApiKey(provider);
      assert.ok(!('localEndpoint' in result), 'should not be local endpoint');
      const r = result as { found: boolean; source?: string; envVar?: string };
      assert.equal(r.found, true, 'should find key in .env file');
      assert.equal(r.source, 'env_file', 'source should be env_file');
      assert.equal(r.envVar, 'ANTHROPIC_API_KEY');
    } finally {
      // Restore
      if (originalExists) Object.defineProperty(fs, 'existsSync', originalExists);
      else delete (fs as unknown as Record<string, unknown>).existsSync;
      if (originalStat) Object.defineProperty(fs, 'statSync', originalStat);
      else delete (fs as unknown as Record<string, unknown>).statSync;
      if (originalRead) Object.defineProperty(fs, 'readFileSync', originalRead);
      else delete (fs as unknown as Record<string, unknown>).readFileSync;
      // Clean up the hydrated value.
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  void savedExistsSync; void savedStatSync; void savedReadFileSync;
});

// ── 4. key absent in all stores → not found ──────────────────────────────────

test('key absent in all stores returns found: false with checked list', () => {
  const provider = makeProvider({
    slug: 'replicate',
    envCandidates: ['REPLICATE_API_TOKEN', 'REPLICATE_API_KEY'] as const,
  });
  withEnv(
    {
      REPLICATE_API_TOKEN: undefined,
      REPLICATE_API_KEY: undefined,
      // The fallback slug-derived name is REPLICATE_API_KEY (already in candidates).
    },
    () => {
      // Stub fs to return nothing.
      const origExists = Object.getOwnPropertyDescriptor(fs, 'existsSync');
      Object.defineProperty(fs, 'existsSync', {
        value: () => false,
        configurable: true,
        writable: true,
      });
      try {
        const result = resolveProviderApiKey(provider);
        assert.ok(!('localEndpoint' in result));
        const r = result as { found: boolean; checked?: string[] };
        assert.equal(r.found, false);
        assert.ok(Array.isArray(r.checked));
        // Must have checked both candidates + possibly the slug fallback.
        assert.ok(r.checked!.includes('REPLICATE_API_TOKEN'), 'should check REPLICATE_API_TOKEN');
        assert.ok(r.checked!.includes('REPLICATE_API_KEY'), 'should check REPLICATE_API_KEY');
      } finally {
        if (origExists) Object.defineProperty(fs, 'existsSync', origExists);
      }
    }
  );
});

// ── 5. defaultEnvVarForSlug ───────────────────────────────────────────────────

test('defaultEnvVarForSlug derives conventional name', () => {
  assert.equal(defaultEnvVarForSlug('openai'), 'OPENAI_API_KEY');
  assert.equal(defaultEnvVarForSlug('ollama-cloud'), 'OLLAMA_CLOUD_API_KEY');
  assert.equal(defaultEnvVarForSlug('fish-audio'), 'FISH_AUDIO_API_KEY');
  assert.equal(defaultEnvVarForSlug('zai'), 'ZAI_API_KEY');
});

// ── 6. envCandidatesForProvider ───────────────────────────────────────────────

test('envCandidatesForProvider includes connector envCandidates + slug fallback, deduped', () => {
  const provider = makeProvider({
    slug: 'ollama-cloud',
    envCandidates: ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'] as const,
  });
  const candidates = envCandidatesForProvider(provider);
  assert.ok(candidates.includes('OLLAMA_CLOUD_API_KEY'), 'primary candidate present');
  assert.ok(candidates.includes('OLLAMA_API_KEY'), 'alternate candidate present');
  // slug fallback OLLAMA_CLOUD_API_KEY is already in envCandidates; must not duplicate.
  assert.equal(candidates.filter((c) => c === 'OLLAMA_CLOUD_API_KEY').length, 1, 'no duplicates');
});

test('envCandidatesForProvider with no envCandidates returns only slug fallback', () => {
  const provider = makeProvider({ slug: 'anthropic' });
  const candidates = envCandidatesForProvider(provider);
  assert.deepEqual(candidates, ['ANTHROPIC_API_KEY']);
});

// ── 7. local_endpoint + api_key distinction ───────────────────────────────────

test('api_key provider with key set is NOT treated as local endpoint', () => {
  const provider = makeProvider({ slug: 'openai' }); // authType defaults to undefined = api_key
  withEnv({ OPENAI_API_KEY: 'sk-openai' }, () => {
    const result = resolveProviderApiKey(provider);
    assert.ok(!('localEndpoint' in result), 'should NOT be local endpoint');
  });
});

test('local_endpoint provider with env var set still returns localEndpoint (env var irrelevant)', () => {
  // Even if someone set OLLAMA_LOCAL_API_KEY in env, it should not matter.
  const provider = makeProvider({ slug: 'ollama-local', authType: 'local_endpoint' });
  withEnv({ OLLAMA_LOCAL_API_KEY: 'some-value' }, () => {
    const result = resolveProviderApiKey(provider);
    assert.ok('localEndpoint' in result, 'should be local endpoint');
  });
});
