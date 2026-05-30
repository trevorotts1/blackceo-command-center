/**
 * Unit tests for the Studio env -> provider discovery + capability map (v4.1.4).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`,
 * which globs tests/unit/*.test.ts). No network, no DB.
 *
 * Core assertion (per the build brief): given a fake env with
 * KIE_API_KEY + OPENAI_API_KEY, image + video + audio rows all appear.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverRegistryRows,
  discoveryReport,
  parseDotEnv,
  extractOpenclawEnv,
  resolveApiKeyEnv,
  PROVIDER_DISCOVERY,
} from '../../src/lib/studio/provider-discovery';

/** Run `fn` with a clean env containing only `vars`, then restore. */
function withEnv(vars: Record<string, string>, fn: () => void) {
  const keySet = new Set<string>();
  for (const p of PROVIDER_DISCOVERY) for (const e of p.envCandidates) keySet.add(e);
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

// 1) THE CORE ASSERTION: KIE_API_KEY + OPENAI_API_KEY => image + video + audio.
test('KIE_API_KEY + OPENAI_API_KEY yields image + video + audio rows', () => {
  withEnv({ KIE_API_KEY: 'sk-kie-fake', OPENAI_API_KEY: 'sk-oai-fake' }, () => {
    const rows = discoverRegistryRows({ hydrate: false });
    const caps = new Set(rows.flatMap((r) => r.capabilities ?? []));
    assert.ok(caps.has('image_generation'), 'expected an image_generation row');
    assert.ok(caps.has('video_generation'), 'expected a video_generation row (KIE Veo/Runway)');
    assert.ok(caps.has('audio_generation'), 'expected an audio_generation row (OpenAI TTS)');

    // KIE contributes image AND video; OpenAI contributes image AND audio.
    const kieCaps = new Set(rows.filter((r) => r.provider === 'kie').flatMap((r) => r.capabilities ?? []));
    assert.ok(kieCaps.has('image_generation') && kieCaps.has('video_generation'), 'KIE must cover image + video');
    const oaiCaps = new Set(rows.filter((r) => r.provider === 'openai').flatMap((r) => r.capabilities ?? []));
    assert.ok(oaiCaps.has('image_generation') && oaiCaps.has('audio_generation'), 'OpenAI must cover image + audio');

    // Every row records the resolved api_key_env and never fabricates a key.
    for (const r of rows) {
      const env = (r.raw_metadata as Record<string, unknown>).api_key_env;
      assert.ok(env === 'KIE_API_KEY' || env === 'OPENAI_API_KEY', `unexpected api_key_env: ${String(env)}`);
      assert.equal(r.pricing_source, 'discovered');
      assert.equal(r.status, 'active');
    }
  });
});

// 2) No keys present => zero rows (never fabricate).
test('empty env yields zero discovered rows', () => {
  withEnv({}, () => {
    assert.equal(discoverRegistryRows({ hydrate: false }).length, 0);
  });
});

// 3) Evelyn's real env shape (KIE/OPENAI/FISH/GEMINI/GOOGLE) lights up all three.
test('Evelyn env (KIE/OPENAI/FISH/GEMINI/GOOGLE) covers all three tabs', () => {
  withEnv(
    {
      KIE_API_KEY: 'x',
      OPENAI_API_KEY: 'x',
      FISH_AUDIO_API_KEY: 'x',
      GEMINI_API_KEY: 'x',
      GOOGLE_API_KEY: 'x',
    },
    () => {
      const caps = new Set(discoverRegistryRows({ hydrate: false }).flatMap((r) => r.capabilities ?? []));
      assert.ok(caps.has('image_generation'));
      assert.ok(caps.has('video_generation'));
      assert.ok(caps.has('audio_generation'));
      const report = discoveryReport({ hydrate: false }).filter((r) => r.present).map((r) => r.slug);
      assert.ok(report.includes('kie'));
      assert.ok(report.includes('openai'));
      assert.ok(report.includes('fish-audio'));
      assert.ok(report.includes('google'));
    }
  );
});

// 4) FAL_KEY alone covers image + video + audio (single-provider all-three).
test('FAL_KEY alone covers image + video + audio', () => {
  withEnv({ FAL_KEY: 'x' }, () => {
    const caps = new Set(discoverRegistryRows({ hydrate: false }).flatMap((r) => r.capabilities ?? []));
    assert.ok(caps.has('image_generation'));
    assert.ok(caps.has('video_generation'));
    assert.ok(caps.has('audio_generation'));
  });
});

// 5) Alternate env-var spellings still resolve.
test('alternate env-var spellings resolve (KIEAI_API_KEY, FAL_API_KEY)', () => {
  withEnv({ KIEAI_API_KEY: 'x' }, () => {
    const kie = PROVIDER_DISCOVERY.find((p) => p.slug === 'kie')!;
    assert.equal(resolveApiKeyEnv(kie), 'KIEAI_API_KEY');
  });
  withEnv({ FAL_API_KEY: 'x' }, () => {
    const fal = PROVIDER_DISCOVERY.find((p) => p.slug === 'fal')!;
    assert.equal(resolveApiKeyEnv(fal), 'FAL_API_KEY');
  });
});

// 6) parseDotEnv tolerates comments, export, quotes, inline comments.
test('parseDotEnv handles export/quotes/comments', () => {
  const parsed = parseDotEnv(
    [
      '# a comment',
      'export KIE_API_KEY=abc123',
      'OPENAI_API_KEY="quoted value"',
      "FISH_AUDIO_API_KEY='single'",
      'UNQUOTED=val # trailing comment',
      'malformed line with no equals',
    ].join('\n')
  );
  assert.equal(parsed.KIE_API_KEY, 'abc123');
  assert.equal(parsed.OPENAI_API_KEY, 'quoted value');
  assert.equal(parsed.FISH_AUDIO_API_KEY, 'single');
  assert.equal(parsed.UNQUOTED, 'val');
});

// 7) extractOpenclawEnv handles both env and env.vars shapes.
test('extractOpenclawEnv reads env and env.vars', () => {
  const flat = extractOpenclawEnv({ env: { KIE_API_KEY: 'a' } });
  assert.equal(flat.KIE_API_KEY, 'a');
  const nested = extractOpenclawEnv({ env: { vars: { OPENAI_API_KEY: 'b' } } });
  assert.equal(nested.OPENAI_API_KEY, 'b');
  assert.deepEqual(extractOpenclawEnv(null), {});
  assert.deepEqual(extractOpenclawEnv({ env: 'not-an-object' }), {});
});

// 8) Every discovery model has a known media capability + a generates flag.
test('discovery map is well-formed (capabilities + generates)', () => {
  const valid = new Set(['image_generation', 'video_generation', 'audio_generation']);
  for (const p of PROVIDER_DISCOVERY) {
    assert.ok(p.envCandidates.length > 0, `${p.slug} must have env candidates`);
    for (const m of p.models) {
      assert.ok(valid.has(m.capability), `${m.model_id} has invalid capability ${m.capability}`);
      assert.equal(typeof m.generates, 'boolean', `${m.model_id} missing generates flag`);
    }
  }
});
