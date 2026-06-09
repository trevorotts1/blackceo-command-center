/**
 * SOP Semantic Embedding Helpers
 *
 * Thin wrapper around OpenAI text-embedding-3-small for computing and storing
 * SOP embeddings used by semantic search in suggestSOPsForTask().
 *
 * Key design decisions:
 *   - Provider: OpenAI text-embedding-3-small (1536 dims). Reliable, fast,
 *     cheap (~$0.02/1M tokens). Key read from OPENAI_API_KEY env var.
 *   - Storage: sop_embeddings table (separate from sops) — keeps the sops
 *     table clean, easier to re-embed without touching the SOP rows.
 *   - Cosine similarity in JS (brute-force over 2,578 rows is ~5ms; no
 *     sqlite-vec native extension dependency needed).
 *   - Graceful no-op when OPENAI_API_KEY is absent — all callers check
 *     isEmbeddingAvailable() first and fall back to keyword search.
 *   - Never crashes a write path: storeEmbeddingForSOP swallows errors and
 *     logs them so SOP create/update/import never fails due to a missing key
 *     or transient API error.
 *
 * ENV REQUIREMENT:
 *   OPENAI_API_KEY must be set in the Next.js process environment (i.e. in
 *   .env.local on a dev install, or injected via docker-compose / launchd on
 *   production). It is NOT a NEXT_PUBLIC_ variable — it is server-side only.
 *   See .env.example for the existing OPENAI_API_KEY entry. The key used here
 *   is the same one already present in the container env; just expose it to
 *   the Next.js process.
 */

import { queryAll, queryOne, run, getDb } from '@/lib/db';
import type { SOP } from '@/lib/sops';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

// ---------- availability ----------

/**
 * True if OPENAI_API_KEY is configured. When false, all semantic paths
 * gracefully degrade to keyword-only (no error thrown).
 */
export function isEmbeddingAvailable(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

// ---------- text construction ----------

/**
 * Build the text we embed for a SOP — title + keywords + first step names.
 * Deliberately short so we stay in a single token budget.
 */
export function buildSOPEmbedText(sop: Pick<SOP, 'name' | 'task_keywords' | 'steps' | 'description'>): string {
  const parts: string[] = [sop.name];

  if (sop.description) {
    parts.push(sop.description);
  }

  if (sop.task_keywords) {
    parts.push(sop.task_keywords);
  }

  // Include step names (not full details) for richer semantic signal
  try {
    const steps = typeof sop.steps === 'string' ? JSON.parse(sop.steps) : sop.steps;
    if (Array.isArray(steps)) {
      const stepNames = steps
        .slice(0, 8)
        .map((s: { name?: string }) => s?.name)
        .filter(Boolean);
      if (stepNames.length > 0) {
        parts.push(stepNames.join('; '));
      }
    }
  } catch {
    // ignore malformed steps
  }

  return parts.join(' | ');
}

// ---------- OpenAI API call ----------

/**
 * Fetch a single embedding from OpenAI. Returns Float32Array (1536 dims).
 * Throws on HTTP error; caller must handle / swallow.
 */
export async function fetchEmbedding(text: string): Promise<Float32Array> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      encoding_format: 'float',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI embeddings API error ${resp.status}: ${body}`);
  }

  const json = (await resp.json()) as { data: [{ embedding: number[] }] };
  const floats = json.data[0].embedding;
  return new Float32Array(floats);
}

// ---------- BLOB serialization ----------

/** Serialize Float32Array → Buffer (stored as BLOB in SQLite). */
export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer);
}

/** Deserialize BLOB → Float32Array. */
export function bufferToFloat32(buf: Buffer | null | undefined): Float32Array | null {
  if (!buf || buf.length < 4) return null;
  // better-sqlite3 returns Buffer for BLOB columns
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ---------- cosine similarity ----------

/**
 * Cosine similarity between two Float32Arrays of equal length.
 * Returns -1 to 1 (1 = identical direction).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ---------- DB helpers ----------

export interface SOPEmbeddingRow {
  sop_id: string;
  embedding: Buffer | null;
  embedding_model: string;
  embedding_dims: number;
  embedded_at: string;
}

/** Fetch the stored embedding for a SOP, or null if not embedded yet. */
export function getStoredEmbedding(sopId: string): Float32Array | null {
  const row = queryOne<SOPEmbeddingRow>(
    'SELECT embedding FROM sop_embeddings WHERE sop_id = ?',
    [sopId]
  );
  if (!row?.embedding) return null;
  return bufferToFloat32(row.embedding);
}

/**
 * Compute + persist the embedding for one SOP row.
 * Safe to call fire-and-forget — errors are logged but never re-thrown so the
 * caller's write path (create / update / import) never fails because of this.
 */
export async function storeEmbeddingForSOP(sop: SOP): Promise<void> {
  if (!isEmbeddingAvailable()) return;
  try {
    const text = buildSOPEmbedText(sop);
    const embedding = await fetchEmbedding(text);
    const blob = float32ToBuffer(embedding);
    const now = new Date().toISOString();
    run(
      `INSERT INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims, embedded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sop_id) DO UPDATE SET
         embedding = excluded.embedding,
         embedding_model = excluded.embedding_model,
         embedding_dims = excluded.embedding_dims,
         embedded_at = excluded.embedded_at`,
      [sop.id, blob, EMBEDDING_MODEL, EMBEDDING_DIMS, now]
    );
  } catch (err) {
    // Graceful no-op — write path must never fail because of a missing key
    // or transient API error.
    console.warn('[sop-embeddings] storeEmbeddingForSOP failed (non-fatal):', (err as Error).message);
  }
}

// ---------- bulk semantic ranking ----------

export interface SemanticHit {
  sopId: string;
  similarity: number;
}

/**
 * Rank all embedded SOPs by cosine similarity to a query text.
 * Fetches all embeddings from DB in one shot (2,578 rows × 6KB ≈ 15MB RAM —
 * acceptable for a CLI/server process). Returns sorted descending.
 *
 * Returns an empty array if embeddings table is missing or empty.
 */
export async function rankSOPsBySemantic(queryText: string): Promise<SemanticHit[]> {
  if (!isEmbeddingAvailable()) return [];

  // Check that the table exists (migration may not have run yet on this DB)
  const db = getDb();
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sop_embeddings'")
    .get();
  if (!tableExists) return [];

  const rows = queryAll<{ sop_id: string; embedding: Buffer | null }>(
    'SELECT sop_id, embedding FROM sop_embeddings WHERE embedding IS NOT NULL',
    []
  );
  if (rows.length === 0) return [];

  let queryVec: Float32Array;
  try {
    queryVec = await fetchEmbedding(queryText);
  } catch (err) {
    console.warn('[sop-embeddings] rankSOPsBySemantic: embed query failed:', (err as Error).message);
    return [];
  }

  const hits: SemanticHit[] = [];
  for (const row of rows) {
    const vec = bufferToFloat32(row.embedding);
    if (!vec) continue;
    hits.push({ sopId: row.sop_id, similarity: cosineSimilarity(queryVec, vec) });
  }

  hits.sort((a, b) => b.similarity - a.similarity);
  return hits;
}
