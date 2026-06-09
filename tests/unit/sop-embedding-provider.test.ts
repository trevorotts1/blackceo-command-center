/**
 * Unit tests — SOP embedding provider resolution + dims-mismatch guard
 *
 * Tests:
 *   1. resolveEmbeddingProvider() — openai-present → openai
 *   2. resolveEmbeddingProvider() — google-only (no OPENAI key) → google
 *      Tests all 3 Google key names: GOOGLE_API_KEY, GOOGLE_AI_STUDIO_API_KEY,
 *      GEMINI_API_KEY
 *   3. resolveEmbeddingProvider() — no keys → none (keyword fallback)
 *   4. resolveEmbeddingProvider() — SOP_EMBEDDING_PROVIDER=google forces google
 *      even when OPENAI_API_KEY is also set
 *   5. resolveEmbeddingProvider() — SOP_EMBEDDING_PROVIDER=openai forces openai
 *      even when Google key is also set
 *   6. isEmbeddingAvailable() returns true only when a key is present
 *   7. getEmbeddingApiKey() returns the resolved key or null
 *   8. Dims-mismatch guard: rankSOPsBySemantic skips rows with mismatched dims
 *   9. EMBEDDING_MODEL / EMBEDDING_DIMS constants are set to sensible defaults
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * No network calls are made — provider resolution is pure env-var logic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set up an isolated test DB so DB imports don't collide with other test files.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-emb-prov-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Snapshot + restore a set of env vars around a callback. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  // Save current values
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
  }
  // Delete ALL embedding-related vars first (clean slate for each test)
  const allEmbeddingVars = [
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_AI_STUDIO_API_KEY',
    'GEMINI_API_KEY',
    'SOP_EMBEDDING_PROVIDER',
  ];
  for (const k of allEmbeddingVars) {
    if (!(k in vars)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  // Apply requested vars
  for (const [key, val] of Object.entries(vars)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  try {
    fn();
  } finally {
    // Restore ALL touched vars
    for (const key of [...Object.keys(vars), ...allEmbeddingVars]) {
      const orig = saved[key];
      if (orig === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = orig;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

// Note: resolveEmbeddingProvider() reads env vars at call time (not at import
// time), so we can call it multiple times with different env configs.
import {
  resolveEmbeddingProvider,
  resolveGoogleKey,
  isEmbeddingAvailable,
  getEmbeddingApiKey,
  cosineSimilarity,
  float32ToBuffer,
  bufferToFloat32,
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
} from '../../src/lib/sop-embeddings';

// ---------------------------------------------------------------------------
// 1. OpenAI present → openai provider
// ---------------------------------------------------------------------------

test('resolveEmbeddingProvider: OPENAI_API_KEY present → openai', () => {
  withEnv({ OPENAI_API_KEY: 'sk-test-openai-key-long-enough' }, () => {
    const provider = resolveEmbeddingProvider();
    assert.equal(provider.name, 'openai', 'Should resolve to openai when OPENAI_API_KEY is set');
    assert.equal(provider.model, 'text-embedding-3-small');
    assert.equal(provider.dims, 1536);
    assert.ok(provider.apiKey !== null, 'apiKey should be non-null');
  });
});

// ---------------------------------------------------------------------------
// 2. Google-only (no OPENAI key) → google provider
//    Test all 3 Google key env var names
// ---------------------------------------------------------------------------

test('resolveEmbeddingProvider: GOOGLE_API_KEY only (no OpenAI) → google', () => {
  withEnv({ GOOGLE_API_KEY: 'AIza-test-google-key-long-enough' }, () => {
    const provider = resolveEmbeddingProvider();
    assert.equal(provider.name, 'google', 'Should resolve to google when only GOOGLE_API_KEY is set');
    assert.equal(provider.model, 'gemini-embedding-001');
    assert.equal(provider.dims, 3072);
    assert.equal(provider.apiKey, 'AIza-test-google-key-long-enough');
  });
});

test('resolveEmbeddingProvider: GOOGLE_AI_STUDIO_API_KEY only → google', () => {
  withEnv({ GOOGLE_AI_STUDIO_API_KEY: 'AIza-studio-key-long-enough' }, () => {
    const provider = resolveEmbeddingProvider();
    assert.equal(provider.name, 'google', 'GOOGLE_AI_STUDIO_API_KEY should activate google provider');
    assert.equal(provider.dims, 3072);
  });
});

test('resolveEmbeddingProvider: GEMINI_API_KEY only → google', () => {
  withEnv({ GEMINI_API_KEY: 'AIza-gemini-key-long-enough' }, () => {
    const provider = resolveEmbeddingProvider();
    assert.equal(provider.name, 'google', 'GEMINI_API_KEY should activate google provider');
    assert.equal(provider.dims, 3072);
  });
});

// ---------------------------------------------------------------------------
// 3. No keys → none (keyword fallback)
// ---------------------------------------------------------------------------

test('resolveEmbeddingProvider: no keys → none (keyword fallback)', () => {
  withEnv({}, () => {
    // withEnv with empty vars clears all embedding keys
    const provider = resolveEmbeddingProvider();
    assert.equal(provider.name, 'none', 'Should resolve to none when no keys are set');
    assert.equal(provider.apiKey, null);
    assert.equal(provider.dims, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. SOP_EMBEDDING_PROVIDER=google forces google even when OpenAI key present
// ---------------------------------------------------------------------------

test('resolveEmbeddingProvider: SOP_EMBEDDING_PROVIDER=google overrides openai preference', () => {
  withEnv({
    OPENAI_API_KEY: 'sk-test-openai-key-long-enough',
    GOOGLE_API_KEY: 'AIza-test-google-key-long-enough',
    SOP_EMBEDDING_PROVIDER: 'google',
  }, () => {
    const provider = resolveEmbeddingProvider();
    assert.equal(provider.name, 'google', 'SOP_EMBEDDING_PROVIDER=google must override auto-detection');
    assert.equal(provider.model, 'gemini-embedding-001');
    assert.equal(provider.dims, 3072);
  });
});

// ---------------------------------------------------------------------------
// 5. SOP_EMBEDDING_PROVIDER=openai forces openai even when only Google key present
// ---------------------------------------------------------------------------

test('resolveEmbeddingProvider: SOP_EMBEDDING_PROVIDER=openai forces openai provider', () => {
  withEnv({
    OPENAI_API_KEY: 'sk-forced-openai-key-long-enough',
    GOOGLE_API_KEY: 'AIza-test-google-key-long-enough',
    SOP_EMBEDDING_PROVIDER: 'openai',
  }, () => {
    const provider = resolveEmbeddingProvider();
    assert.equal(provider.name, 'openai', 'SOP_EMBEDDING_PROVIDER=openai must force openai');
    assert.equal(provider.model, 'text-embedding-3-small');
    assert.equal(provider.dims, 1536);
  });
});

// ---------------------------------------------------------------------------
// 6. isEmbeddingAvailable() returns true iff a key is configured
// ---------------------------------------------------------------------------

test('isEmbeddingAvailable: true when OPENAI_API_KEY set', () => {
  withEnv({ OPENAI_API_KEY: 'sk-test-available-long-enough' }, () => {
    assert.equal(isEmbeddingAvailable(), true);
  });
});

test('isEmbeddingAvailable: true when Google key set (no OpenAI)', () => {
  withEnv({ GOOGLE_API_KEY: 'AIza-test-available-long-enough' }, () => {
    assert.equal(isEmbeddingAvailable(), true);
  });
});

test('isEmbeddingAvailable: false when no keys set', () => {
  withEnv({}, () => {
    assert.equal(isEmbeddingAvailable(), false);
  });
});

// ---------------------------------------------------------------------------
// 7. getEmbeddingApiKey() returns the key or null
// ---------------------------------------------------------------------------

test('getEmbeddingApiKey: returns OpenAI key when set', () => {
  withEnv({ OPENAI_API_KEY: 'sk-test-key-returned-long-enough' }, () => {
    const key = getEmbeddingApiKey();
    assert.equal(key, 'sk-test-key-returned-long-enough');
  });
});

test('getEmbeddingApiKey: returns Google key when only Google key set', () => {
  withEnv({ GOOGLE_API_KEY: 'AIza-returned-google-key-long-enough' }, () => {
    const key = getEmbeddingApiKey();
    assert.equal(key, 'AIza-returned-google-key-long-enough');
  });
});

test('getEmbeddingApiKey: returns null when no keys set', () => {
  withEnv({}, () => {
    assert.equal(getEmbeddingApiKey(), null);
  });
});

// ---------------------------------------------------------------------------
// 8. Dims-mismatch guard: rankSOPsBySemantic skips rows with mismatched dims
//
// This test verifies the core dimension-consistency contract:
//   - Insert rows with 1536-dim embeddings (OpenAI-sized)
//   - Configure a Google provider (expects 3072-dim)
//   - rankSOPsBySemantic must return [] (not throw, not compare)
//   - Then: configure OpenAI provider (1536-dim), query must find those rows
// ---------------------------------------------------------------------------

test('rankSOPsBySemantic: skips rows whose dims != active provider dims (no cross-provider comparison)', async () => {
  // This test uses a real (throwaway) SQLite DB spun up in the test process.
  const db = await import('../../src/lib/db');
  db.getDb(); // run migrations

  const { run, queryAll } = db;
  const { rankSOPsBySemantic } = await import('../../src/lib/sop-embeddings');

  // Insert two SOPs + their embeddings at 1536-dim (OpenAI-sized)
  const ts = Date.now();
  const sopAId = `dims-test-a-${ts}`;
  const sopBId = `dims-test-b-${ts}`;
  const now = new Date().toISOString();

  const dims1536 = 1536;
  const openaiModel = 'text-embedding-3-small';

  // Insert SOPs
  for (const [id, name, slug] of [[sopAId, 'Dims Test SOP A', `dims-a-${ts}`], [sopBId, 'Dims Test SOP B', `dims-b-${ts}`]] as [string, string, string][]) {
    run(
      `INSERT OR IGNORE INTO sops (id, name, slug, description, version, department, task_keywords, steps, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 1, 'test-dept', 'test', ?, ?, ?)`,
      [id, name, slug, JSON.stringify([{ name: 'step1' }]), now, now]
    );
  }

  // Insert embeddings at 1536-dim (OpenAI-sized)
  const makeVec1536 = (hotDim: number): Float32Array => {
    const v = new Float32Array(dims1536);
    v[hotDim] = 1;
    return v;
  };

  const vecA = makeVec1536(0);
  const vecB = makeVec1536(1);

  const { float32ToBuffer: f2b } = await import('../../src/lib/sop-embeddings');

  run(
    `INSERT OR REPLACE INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [sopAId, f2b(vecA), openaiModel, dims1536, now]
  );
  run(
    `INSERT OR REPLACE INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [sopBId, f2b(vecB), openaiModel, dims1536, now]
  );

  // --- Part A: active provider = Google (3072-dim) → MUST skip 1536-dim rows ---
  // We stub fetch to return a 3072-dim vector (so the embedding call itself works)
  const originalFetch = global.fetch;
  global.fetch = async (): Promise<Response> => {
    const values = new Array(3072).fill(0);
    values[0] = 1;
    const body = JSON.stringify({ embedding: { values } });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await withEnvAsync({ GOOGLE_API_KEY: 'AIza-dims-guard-test-long-enough' }, async () => {
      const hits = await rankSOPsBySemantic('test query for dims guard');
      // The Google provider expects 3072-dim, stored rows are 1536-dim.
      // The dims guard must filter them all out → empty results.
      const foundA = hits.some((h) => h.sopId === sopAId);
      const foundB = hits.some((h) => h.sopId === sopBId);
      assert.equal(foundA, false, 'DIMS GUARD: 1536-dim row must be skipped when active provider expects 3072-dim');
      assert.equal(foundB, false, 'DIMS GUARD: 1536-dim row must be skipped when active provider expects 3072-dim');
    });
  } finally {
    global.fetch = originalFetch;
  }

  // --- Part B: active provider = OpenAI (1536-dim) → MUST find the rows ---
  // Stub fetch to return a 1536-dim vector (OpenAI response shape)
  const savedFetch = global.fetch;
  global.fetch = async (): Promise<Response> => {
    const floats = new Array(dims1536).fill(0);
    floats[0] = 1; // matches vecA
    const body = JSON.stringify({ data: [{ embedding: floats }] });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await withEnvAsync({ OPENAI_API_KEY: 'sk-dims-guard-openai-key-long-enough' }, async () => {
      const hits = await rankSOPsBySemantic('test query for dims guard');
      // OpenAI provider expects 1536-dim, stored rows are 1536-dim → should find them
      const foundA = hits.some((h) => h.sopId === sopAId);
      assert.equal(foundA, true, 'DIMS GUARD: 1536-dim row must be FOUND when active provider expects 1536-dim');
    });
  } finally {
    global.fetch = savedFetch;
  }
});

// ---------------------------------------------------------------------------
// 9. EMBEDDING_MODEL / EMBEDDING_DIMS constants are sensible defaults
// ---------------------------------------------------------------------------

test('EMBEDDING_MODEL constant is a non-empty string', () => {
  assert.ok(typeof EMBEDDING_MODEL === 'string' && EMBEDDING_MODEL.length > 0, 'EMBEDDING_MODEL must be non-empty');
});

test('EMBEDDING_DIMS constant is a positive integer', () => {
  assert.ok(typeof EMBEDDING_DIMS === 'number' && EMBEDDING_DIMS > 0, 'EMBEDDING_DIMS must be > 0');
});

// ---------------------------------------------------------------------------
// 10. resolveGoogleKey: picks first present key in priority order
// ---------------------------------------------------------------------------

test('resolveGoogleKey: picks GOOGLE_API_KEY first', () => {
  withEnv({
    GOOGLE_API_KEY: 'AIza-first-key-long-enough',
    GOOGLE_AI_STUDIO_API_KEY: 'AIza-studio-long-enough',
    GEMINI_API_KEY: 'AIza-gemini-long-enough',
  }, () => {
    assert.equal(resolveGoogleKey(), 'AIza-first-key-long-enough');
  });
});

test('resolveGoogleKey: returns null when all Google keys absent', () => {
  withEnv({}, () => {
    assert.equal(resolveGoogleKey(), null);
  });
});

// ---------------------------------------------------------------------------
// 11. cosineSimilarity: dimension-agnostic for 3072-dim vectors
// ---------------------------------------------------------------------------

test('cosineSimilarity: works correctly with 3072-dim vectors (Google dims)', () => {
  const a = new Float32Array(3072);
  const b = new Float32Array(3072);
  a[0] = 1; // unit vector in dim 0
  b[0] = 1; // identical to a
  assert.ok(Math.abs(cosineSimilarity(a, a) - 1.0) < 1e-6, '3072-dim identical vectors should have similarity 1.0');

  const c = new Float32Array(3072);
  c[1] = 1; // orthogonal to a
  assert.ok(Math.abs(cosineSimilarity(a, c)) < 1e-6, '3072-dim orthogonal vectors should have similarity ≈ 0');
});

test('cosineSimilarity: mismatched dims (1536 vs 3072) returns 0 safely', () => {
  const a = new Float32Array(1536);
  const b = new Float32Array(3072);
  a[0] = 1;
  b[0] = 1;
  assert.equal(cosineSimilarity(a, b), 0, 'Mismatched 1536 vs 3072 dims must return 0 (safe)');
});

// ---------------------------------------------------------------------------
// Async env helper (for the async dims-guard test)
// ---------------------------------------------------------------------------

async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  const allEmbeddingVars = [
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_AI_STUDIO_API_KEY',
    'GEMINI_API_KEY',
    'SOP_EMBEDDING_PROVIDER',
  ];
  for (const k of allEmbeddingVars) {
    saved[k] = process.env[k];
    if (!(k in vars)) delete process.env[k];
  }
  for (const [key, val] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  try {
    await fn();
  } finally {
    for (const key of [...Object.keys(vars), ...allEmbeddingVars]) {
      const orig = saved[key];
      if (orig === undefined) delete process.env[key];
      else process.env[key] = orig;
    }
  }
}
