import './_isolated-db';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOpenclawProviderKeys, envReferenceName } from '../../src/lib/studio/provider-discovery';
import { resolveGoogleKey } from '../../src/lib/sop-embeddings';

const cfg = (apiKey: string, env?: Record<string, string>) => ({ env, models: { providers: { google: { apiKey } } } });
const REAL = 'AIzaSyRealKeyValue1234567890';

test('envReferenceName recognises $NAME, ${NAME}, bare NAME; not real keys', () => {
  assert.equal(envReferenceName('$GOOGLE_API_KEY'), 'GOOGLE_API_KEY');
  assert.equal(envReferenceName('${GOOGLE_API_KEY}'), 'GOOGLE_API_KEY');
  assert.equal(envReferenceName('GEMINI_API_KEY'), 'GEMINI_API_KEY');
  assert.equal(envReferenceName(REAL), null);
});

test('placeholder apiKey is skipped when unresolvable, resolved when known', () => {
  const saved = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    for (const ref of ['GEMINI_API_KEY', '$GEMINI_API_KEY', '${GEMINI_API_KEY}']) {
      assert.deepEqual(extractOpenclawProviderKeys(cfg(ref)), {}, ref);
      assert.deepEqual(extractOpenclawProviderKeys(cfg(ref), (n) => (n === 'GEMINI_API_KEY' ? REAL : undefined)), { GOOGLE_API_KEY: REAL }, ref);
      assert.deepEqual(extractOpenclawProviderKeys(cfg(ref, { GEMINI_API_KEY: REAL })), { GOOGLE_API_KEY: REAL }, ref);
    }
    process.env.GEMINI_API_KEY = REAL;
    assert.deepEqual(extractOpenclawProviderKeys(cfg('$GEMINI_API_KEY')), { GOOGLE_API_KEY: REAL });
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
  }
});

test('real apiKey passes through untouched', () => {
  assert.deepEqual(extractOpenclawProviderKeys(cfg(REAL)), { GOOGLE_API_KEY: REAL });
});

test('resolveGoogleKey skips a placeholder GOOGLE_API_KEY and falls to GEMINI_API_KEY', () => {
  const s = { g: process.env.GOOGLE_API_KEY, a: process.env.GOOGLE_AI_STUDIO_API_KEY, m: process.env.GEMINI_API_KEY };
  try {
    process.env.GOOGLE_API_KEY = 'GEMINI_API_KEY';
    delete process.env.GOOGLE_AI_STUDIO_API_KEY;
    process.env.GEMINI_API_KEY = REAL;
    assert.equal(resolveGoogleKey(), REAL);
    process.env.GEMINI_API_KEY = 'GEMINI_API_KEY';
    assert.equal(resolveGoogleKey(), null);
  } finally {
    for (const [k, v] of [['GOOGLE_API_KEY', s.g], ['GOOGLE_AI_STUDIO_API_KEY', s.a], ['GEMINI_API_KEY', s.m]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
