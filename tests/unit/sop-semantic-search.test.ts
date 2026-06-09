/**
 * Unit tests for semantic SOP search (feat/semantic-sop-search).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Strategy:
 *   - Spin up a throwaway SQLite DB.
 *   - Insert SOPs with pre-computed Float32Array embeddings stored as BLOBs so
 *     there's no network I/O for the ranking step.
 *   - For the one test that needs to exercise the full async path (including the
 *     query embedding), we override global.fetch with a stub that returns a known
 *     vector.  global.fetch IS writable in Node 25 even in ES modules.
 *   - Verify suggestSOPsForTask surfaces the semantically close SOP even when
 *     the query shares ZERO keywords with the target SOP.
 *   - Verify cosineSimilarity math (pure functions, no I/O).
 *   - Verify the keyword fallback path is intact when embeddings are absent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sem-sop-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
type SopsModule = typeof import('../../src/lib/sops');
type EmbModule = typeof import('../../src/lib/sop-embeddings');

let queryAll: DbModule['queryAll'];
let queryOne: DbModule['queryOne'];
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

let suggestSOPsForTask: SopsModule['suggestSOPsForTask'];
let suggestSOPsForTaskKeyword: SopsModule['suggestSOPsForTaskKeyword'];

let cosineSimilarity: EmbModule['cosineSimilarity'];
let buildSOPEmbedText: EmbModule['buildSOPEmbedText'];
let float32ToBuffer: EmbModule['float32ToBuffer'];
let EMBEDDING_DIMS: number;
let EMBEDDING_MODEL: string;

test.before(async () => {
  const db = await import('../../src/lib/db');
  queryAll = db.queryAll;
  queryOne = db.queryOne;
  run = db.run;
  closeDb = db.closeDb;
  // Run migrations (including 055 sop_embeddings table)
  db.getDb();

  const emb = await import('../../src/lib/sop-embeddings');
  cosineSimilarity = emb.cosineSimilarity;
  buildSOPEmbedText = emb.buildSOPEmbedText;
  float32ToBuffer = emb.float32ToBuffer;
  EMBEDDING_DIMS = emb.EMBEDDING_DIMS;
  EMBEDDING_MODEL = emb.EMBEDDING_MODEL;

  const sops = await import('../../src/lib/sops');
  suggestSOPsForTask = sops.suggestSOPsForTask;
  suggestSOPsForTaskKeyword = sops.suggestSOPsForTaskKeyword;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------- helpers ----------

/** Make a unit vector hot at specified dimensions. */
function makeVec(hotDims: number[]): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMS);
  for (const d of hotDims) v[d] = 1;
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMS; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < EMBEDDING_DIMS; i++) v[i] /= norm;
  return v;
}

/** Build a mock OpenAI embeddings API response body for a given Float32Array. */
function mockEmbeddingResponse(vec: Float32Array): string {
  return JSON.stringify({
    data: [{ embedding: Array.from(vec) }],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 8, total_tokens: 8 },
  });
}

/** Insert a SOP + its pre-computed embedding into the test DB. */
function insertSOPWithEmbedding(
  id: string,
  name: string,
  slug: string,
  department: string,
  taskKeywords: string,
  vec: Float32Array
): void {
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO sops
       (id, name, slug, description, version, department, task_keywords, steps, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?, ?)`,
    [id, name, slug, department, taskKeywords, JSON.stringify([{ name: `step-${slug}` }]), now, now]
  );
  const blob = float32ToBuffer(vec);
  run(
    `INSERT OR REPLACE INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, blob, EMBEDDING_MODEL, EMBEDDING_DIMS, now]
  );
}

// ---------- 1. cosineSimilarity math ----------

test('cosineSimilarity: identical vectors = 1.0', () => {
  const a = makeVec([0, 1, 2]);
  assert.ok(Math.abs(cosineSimilarity(a, a) - 1.0) < 1e-6, 'identical vectors should have similarity 1.0');
});

test('cosineSimilarity: orthogonal vectors = 0', () => {
  const a = makeVec([0]);
  const b = makeVec([1]);
  assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-6, 'orthogonal vectors should have similarity ≈ 0');
});

test('cosineSimilarity: opposite vectors ≈ -1', () => {
  const a = makeVec([0]);
  const b = new Float32Array(EMBEDDING_DIMS);
  b[0] = -1;
  assert.ok(cosineSimilarity(a, b) < -0.99, 'opposite vectors should have similarity ≈ -1');
});

test('cosineSimilarity: mismatched length = 0 (safe)', () => {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([1, 0, 0]);
  assert.strictEqual(cosineSimilarity(a, b), 0, 'mismatched-length vectors must return 0 safely');
});

// ---------- 2. buildSOPEmbedText ----------

test('buildSOPEmbedText: includes name + keywords + step names', () => {
  const text = buildSOPEmbedText({
    name: 'Handle Refund Request',
    description: 'Process customer refund',
    task_keywords: 'refund, billing, chargeback',
    steps: JSON.stringify([{ name: 'Verify order' }, { name: 'Issue credit' }]),
  });
  assert.ok(text.includes('Handle Refund Request'), 'must include name');
  assert.ok(text.includes('refund, billing, chargeback'), 'must include keywords');
  assert.ok(text.includes('Verify order'), 'must include step names');
  assert.ok(text.includes('Issue credit'), 'must include step names');
});

test('buildSOPEmbedText: handles null fields gracefully', () => {
  const text = buildSOPEmbedText({
    name: 'Minimal SOP',
    description: undefined,
    task_keywords: null,
    steps: '[]',
  });
  assert.ok(text.includes('Minimal SOP'), 'must include name even with null optional fields');
});

// ---------- 3. suggestSOPsForTaskKeyword (sync, pure keyword) ----------

test('suggestSOPsForTaskKeyword: nonsense query returns no results (no false positives)', () => {
  const results = suggestSOPsForTaskKeyword(
    { title: 'xyzzy quux frobnicator blargh', description: undefined },
    5
  );
  assert.strictEqual(results.length, 0, 'pure-keyword path must not produce false positives');
});

test('suggestSOPsForTaskKeyword: returns array (never throws)', () => {
  const results = suggestSOPsForTaskKeyword(
    { title: 'billing invoice payment', description: 'process accounts payable', department: 'billing-finance' },
    5
  );
  assert.ok(Array.isArray(results), 'should return an array');
});

// ---------- 4. CORE SEMANTIC TEST ----------

test('suggestSOPsForTask: semantic query with ZERO keyword overlap surfaces the right SOP', async () => {
  /**
   * THE KEY TEST: a query whose text shares NO keywords with the target SOP
   * must still surface that SOP through cosine similarity.
   *
   * Setup:
   *   SOP A — "Process Invoice Payment" — keywords: invoice, payment, accounts-payable
   *            Embedding vector: hot dims [0, 1, 2]  (billing cluster)
   *
   *   SOP B — "Social Media Post Scheduling" — keywords: social, posts, schedule
   *            Embedding vector: hot dims [100, 101, 102]  (completely different)
   *
   * Query text: "pay the vendor bill for last month"
   *   — NO words match "invoice", "payment", "accounts-payable", "social", "posts", "schedule"
   *   — Mock query embedding vector: hot dims [0, 1, 2]  → cosine(query, sopA) ≈ 1.0
   *                                                        cosine(query, sopB) ≈ 0
   *
   * Expected:
   *   - SOP A appears in results (semantic match)
   *   - SOP A ranks above SOP B
   *   - Keyword path alone does NOT find either SOP for this query
   */

  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-unit-test'; // make isEmbeddingAvailable() = true

  const vecA = makeVec([0, 1, 2]);      // billing cluster
  const vecB = makeVec([100, 101, 102]); // unrelated cluster
  const queryVec = makeVec([0, 1, 2]);  // same as vecA → high similarity

  const ts = Date.now();
  const sopAId = `sem-sopa-${ts}`;
  const sopBId = `sem-sopb-${ts}`;

  insertSOPWithEmbedding(sopAId, 'Process Invoice Payment', `process-invoice-${ts}`, 'billing-finance', 'invoice,payment,accounts-payable', vecA);
  insertSOPWithEmbedding(sopBId, 'Social Media Post Scheduling', `social-media-sched-${ts}`, 'social-media', 'social,posts,schedule', vecB);

  // Override global.fetch to intercept the OpenAI embeddings API call and
  // return our known queryVec without hitting the network.
  const originalFetch = global.fetch;
  global.fetch = async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const body = mockEmbeddingResponse(queryVec);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const results = await suggestSOPsForTask(
      {
        title: 'pay the vendor bill for last month',
        description: undefined,
        // No department — eliminates department matching as a confounder
      },
      10
    );

    // 4a: SOP A must appear in results
    const sopAResult = results.find((r) => r.sop.id === sopAId);
    assert.ok(
      sopAResult !== undefined,
      `SOP A ("Process Invoice Payment") must appear in semantic results even with zero keyword overlap.\nGot: ${JSON.stringify(results.map((r) => ({ id: r.sop.id, name: r.sop.name, score: r.score.toFixed(4), reasons: r.reasons })))}`
    );

    // 4b: SOP A must rank above SOP B (if B appears at all)
    const aIdx = results.findIndex((r) => r.sop.id === sopAId);
    const bIdx = results.findIndex((r) => r.sop.id === sopBId);
    if (bIdx !== -1) {
      assert.ok(
        aIdx < bIdx,
        `SOP A (cosine≈1.0) must rank above SOP B (cosine≈0). aIdx=${aIdx}, bIdx=${bIdx}`
      );
    }

    // 4c: Verify that the keyword path alone would NOT find SOP A for this query.
    // This is the critical "keyword can't do this" proof.
    const kwResults = suggestSOPsForTaskKeyword(
      { title: 'pay the vendor bill for last month', description: undefined },
      10
    );
    const kwHasSopA = kwResults.some((r) => r.sop.id === sopAId);
    assert.ok(
      !kwHasSopA,
      'REGRESSION: keyword path must NOT find SOP A — it has no keywords matching "pay the vendor bill for last month"'
    );

  } finally {
    global.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }
});

// ---------- 5. Keyword fallback ----------
// NOTE: Clear ALL embedding provider keys so that no provider (OpenAI or Google)
// is active during these fallback tests. This prevents false activation if the
// test runner environment happens to have a Google key set (e.g. GEMINI_API_KEY).

test('suggestSOPsForTask: falls back to keyword path when no embedding key present', async () => {
  const savedKeys = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    GOOGLE_AI_STUDIO_API_KEY: process.env.GOOGLE_AI_STUDIO_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    SOP_EMBEDDING_PROVIDER: process.env.SOP_EMBEDDING_PROVIDER,
  };
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_AI_STUDIO_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.SOP_EMBEDDING_PROVIDER;

  const ts = Date.now();
  const sopId = `kw-fb-${ts}`;
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, description, version, department, task_keywords, steps, created_at, updated_at)
     VALUES (?, 'New Client Onboarding KW', ?, NULL, 1, 'customer-support', 'onboarding,welcome,setup', ?, ?, ?)`,
    [sopId, `kw-fallback-${ts}`, JSON.stringify([{ name: 'step1' }]), now, now]
  );

  const results = await suggestSOPsForTask(
    { title: 'onboarding new customer', description: 'welcome setup process', department: 'customer-support' },
    5
  );

  const found = results.some((r) => r.sop.id === sopId);
  assert.ok(found, 'keyword fallback must find the SOP when no embedding key is present');

  // Restore
  for (const [k, v] of Object.entries(savedKeys)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('suggestSOPsForTask: keyword fallback has zero false positives on nonsense query', async () => {
  const savedKeys = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    GOOGLE_AI_STUDIO_API_KEY: process.env.GOOGLE_AI_STUDIO_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    SOP_EMBEDDING_PROVIDER: process.env.SOP_EMBEDDING_PROVIDER,
  };
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_AI_STUDIO_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.SOP_EMBEDDING_PROVIDER;

  const results = await suggestSOPsForTask(
    { title: 'xyzzy quux frobnicator blargh', description: undefined },
    5
  );
  assert.strictEqual(results.length, 0, 'keyword fallback must return 0 results for a nonsense query');

  // Restore
  for (const [k, v] of Object.entries(savedKeys)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
