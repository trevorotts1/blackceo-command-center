/**
 * Unit tests — getSOPEmbeddingHealth() (F2.3 / DEP-11)
 *
 * The TypeScript half of the dual-store embedding health surface. These tests
 * exercise the SOP-store snapshot the CC `/api/health` route uses as its
 * fail-closed fallback when the Python probe (shared-utils/embedding_health.py)
 * is unavailable.
 *
 * Covers:
 *   1. Empty store            -> available, totalRows 0, semanticReady false, degraded
 *   2. Healthy gemini store    -> semanticReady true, degraded false, exact histogram
 *   3. Retired (stale) rows    -> staleRows>0, degraded true (loud), histogram both models
 *   4. No provider key (none)  -> semanticReady false, degraded true, keyword-only note
 *   5. Provider/model mismatch -> active=openai but only gemini rows -> semanticReady false
 *   6. Never throws            -> returns a value on every path
 *
 * One shared DB per file (node:test isolates each file in its own process);
 * inserts are monotonic so assertions do not depend on cross-test teardown.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-emb-health-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'mission-control.test.db');

const EMBEDDING_ENV_KEYS = [
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_AI_STUDIO_API_KEY',
  'GEMINI_API_KEY',
  'SOP_EMBEDDING_PROVIDER',
];

/** Run fn with a clean-slate embedding env, then restore. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of EMBEDDING_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of EMBEDDING_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const GOOGLE = { GOOGLE_API_KEY: 'AIza-test-key-long-enough-1234567890', SOP_EMBEDDING_PROVIDER: 'google' };

async function insertSopRow(model: string, dims: number, idx: number): Promise<void> {
  const db = await import('../../src/lib/db');
  const { run } = db;
  const { float32ToBuffer } = await import('../../src/lib/sop-embeddings');
  const now = new Date().toISOString();
  const id = `emb-health-sop-${model}-${idx}-${Date.now()}`;
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, description, version, department, task_keywords, steps, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 1, 'test-dept', 'test', ?, ?, ?)`,
    [id, `Emb Health ${idx}`, `emb-health-slug-${idx}-${Date.now()}`, JSON.stringify([{ name: 'step1' }]), now, now]
  );
  run(
    `INSERT OR REPLACE INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, float32ToBuffer(new Float32Array(dims).fill(0.1)), model, dims, now]
  );
}

// 1. Empty store ------------------------------------------------------------
test('getSOPEmbeddingHealth: empty store is available but not semantic-ready (degraded)', async () => {
  const db = await import('../../src/lib/db');
  db.getDb(); // run migrations (sop_embeddings table exists, no rows)
  const { getSOPEmbeddingHealth } = await import('../../src/lib/sop-embeddings');

  withEnv(GOOGLE, () => {
    const h = getSOPEmbeddingHealth();
    assert.equal(h.store, 'sop_index');
    assert.equal(h.available, true, 'table exists → available');
    assert.equal(h.totalRows, 0);
    assert.equal(h.semanticReady, false, 'no rows → not semantic-ready');
    assert.equal(h.degraded, true);
    assert.equal(h.provider, 'google');
    assert.ok(h.notes.some((n) => n.includes('EMPTY')), 'must note the empty store');
  });
});

// 2. Healthy gemini store ---------------------------------------------------
test('getSOPEmbeddingHealth: gemini-embedding-2 rows are semantic-ready and NOT degraded', async () => {
  await insertSopRow('gemini-embedding-2', 3072, 1);
  await insertSopRow('gemini-embedding-2', 3072, 2);
  const { getSOPEmbeddingHealth } = await import('../../src/lib/sop-embeddings');

  withEnv(GOOGLE, () => {
    const h = getSOPEmbeddingHealth();
    assert.equal(h.provider, 'google');
    assert.equal(h.activeModel, 'gemini-embedding-2');
    assert.equal(h.semanticReady, true);
    assert.equal(h.staleRows, 0);
    assert.equal(h.degraded, false);
    assert.equal(h.modelHistogram['gemini-embedding-2'], 2);
    assert.equal(h.totalRows, 2);
  });
});

// 3. Retired / stale rows ---------------------------------------------------
test('getSOPEmbeddingHealth: retired gemini-embedding-001 rows are stale and degrade LOUDLY', async () => {
  await insertSopRow('gemini-embedding-001', 3072, 10);
  await insertSopRow('gemini-embedding-001', 3072, 11);
  const { getSOPEmbeddingHealth } = await import('../../src/lib/sop-embeddings');

  withEnv(GOOGLE, () => {
    const h = getSOPEmbeddingHealth();
    assert.equal(h.staleRows, 2, 'two gemini-embedding-001 rows are stale');
    assert.equal(h.degraded, true, 'stale rows must degrade the store even though semantic rows exist');
    assert.equal(h.modelHistogram['gemini-embedding-2'], 2);
    assert.equal(h.modelHistogram['gemini-embedding-001'], 2);
    assert.ok(h.notes.some((n) => n.includes('gemini-embedding-001')), 'must name the retired model');
  });
});

// 4. No provider key --------------------------------------------------------
test('getSOPEmbeddingHealth: no provider key → keyword-only, degraded, never throws', async () => {
  const { getSOPEmbeddingHealth } = await import('../../src/lib/sop-embeddings');
  withEnv({}, () => {
    const h = getSOPEmbeddingHealth();
    assert.equal(h.provider, 'none');
    assert.equal(h.semanticReady, false);
    assert.equal(h.degraded, true);
    assert.ok(h.notes.some((n) => n.toLowerCase().includes('keyword-only')));
  });
});

// 5. Provider/model mismatch ------------------------------------------------
test('getSOPEmbeddingHealth: active=openai but only gemini rows stored → not semantic-ready', async () => {
  const { getSOPEmbeddingHealth } = await import('../../src/lib/sop-embeddings');
  withEnv({ OPENAI_API_KEY: 'sk-test-key-long-enough-1234567890', SOP_EMBEDDING_PROVIDER: 'openai' }, () => {
    const h = getSOPEmbeddingHealth();
    assert.equal(h.provider, 'openai');
    assert.equal(h.activeModel, 'text-embedding-3-small');
    assert.equal(h.semanticReady, false, 'no text-embedding-3-small rows → keyword-only');
    assert.equal(h.degraded, true);
    assert.ok(
      h.notes.some((n) => n.includes('ZERO rows match the active model')),
      'must warn that no rows match the active model'
    );
  });
});
