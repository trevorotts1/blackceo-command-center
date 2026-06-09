/**
 * SOP / Task Embedding Utilities — Superset Module
 *
 * This module serves TWO consumers:
 *
 * 1. department-router.ts (intelligent routing):
 *    - getEmbeddingApiKey()     — key or null
 *    - fetchEmbeddings(texts[]) — batch embed up to 100 texts → EmbeddingResult[]
 *    - cosineSimilarity(a, b)   — pure math util (accepts any ArrayLike<number>)
 *    - EmbeddingVector          — type alias for number[]
 *
 * 2. sops.ts / SOP routes / backfill script (semantic SOP search + storage):
 *    - isEmbeddingAvailable()   — boolean, true when OPENAI_API_KEY present
 *    - buildSOPEmbedText(sop)   — build canonical embed text for a SOP
 *    - fetchEmbedding(text)     — single text → Float32Array (1536 dims)
 *    - float32ToBuffer(arr)     — serialize for SQLite BLOB storage
 *    - bufferToFloat32(buf)     — deserialize from SQLite BLOB
 *    - storeEmbeddingForSOP(sop) — compute + persist embedding (fire-and-forget)
 *    - rankSOPsBySemantic(query) — bulk cosine ranking over sop_embeddings table
 *    - getStoredEmbedding(id)   — retrieve stored embedding for a SOP
 *    - EMBEDDING_MODEL          — model name constant
 *    - EMBEDDING_DIMS           — dimension count constant
 *
 * Key design decisions:
 *   - Provider: OpenAI text-embedding-3-small (1536 dims). Cheap, fast, reliable.
 *   - The key is ALWAYS the client's own OPENAI_API_KEY — never a shared key.
 *   - DB storage in sop_embeddings table (migration 057, separate from sops).
 *   - Cosine similarity in JS (brute-force ~5ms over 2,578 rows; no native ext).
 *   - Graceful no-op on missing key — callers fall back to keyword search.
 *   - Never crashes write paths: storeEmbeddingForSOP swallows all errors.
 *
 * ENV REQUIREMENT:
 *   OPENAI_API_KEY in the Next.js server process env (NOT NEXT_PUBLIC_).
 *   When absent: all semantic paths degrade gracefully to keyword-only.
 */

import { queryAll, queryOne, run, getDb } from '@/lib/db';
import type { SOP } from '@/lib/sops';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

/** Maximum batch size for OpenAI /v1/embeddings. */
const BATCH_LIMIT = 100;

// ---------------------------------------------------------------------------
// Types (used by department-router.ts)
// ---------------------------------------------------------------------------

export type EmbeddingVector = number[];

export interface EmbeddingResult {
  index: number;
  embedding: EmbeddingVector;
}

// ---------------------------------------------------------------------------
// Key / availability helpers
// ---------------------------------------------------------------------------

/**
 * Return the configured OPENAI_API_KEY or null.
 * Used by department-router.ts to decide whether to run semantic routing.
 * The check is cheap — no I/O, one env-var read per call.
 */
export function getEmbeddingApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY;
  if (key && key.trim().length > 10) return key.trim();
  return null;
}

/**
 * True when OPENAI_API_KEY is set and non-trivially long.
 * Used by sops.ts / SOP routes to decide whether semantic search is active.
 */
export function isEmbeddingAvailable(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

// ---------------------------------------------------------------------------
// SOP embed-text construction (PR #39 — semantic SOP search)
// ---------------------------------------------------------------------------

/**
 * Build the canonical text to embed for a SOP — title + description + keywords
 * + first 8 step names. Deliberately short to stay within one token budget.
 */
export function buildSOPEmbedText(sop: Pick<SOP, 'name' | 'task_keywords' | 'steps' | 'description'>): string {
  const parts: string[] = [sop.name];

  if (sop.description) {
    parts.push(sop.description);
  }

  if (sop.task_keywords) {
    parts.push(sop.task_keywords);
  }

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

// ---------------------------------------------------------------------------
// OpenAI API calls
// ---------------------------------------------------------------------------

/**
 * Fetch a SINGLE text embedding from OpenAI.
 * Returns Float32Array (1536 dims). Throws on error.
 *
 * Used by: storeEmbeddingForSOP, rankSOPsBySemantic, backfill script.
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

/**
 * Fetch embeddings for an ARRAY of texts in one batched API call.
 * Returns EmbeddingResult[] in the SAME ORDER as `texts`.
 * Throws on error so callers can fall back to keyword scoring.
 *
 * Used by: department-router.ts (semantic routing).
 */
export async function fetchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
  const apiKey = getEmbeddingApiKey();
  if (!apiKey) throw new Error('No embedding API key configured');
  if (texts.length === 0) return [];
  if (texts.length > BATCH_LIMIT) {
    throw new Error(`fetchEmbeddings: batch limit is ${BATCH_LIMIT}, got ${texts.length}`);
  }

  // Truncate individual texts to avoid token-limit errors on very long inputs.
  const truncated = texts.map((t) => (t.length > 8_000 ? t.slice(0, 8_000) : t));

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: truncated,
    }),
    // 10-second timeout so a slow API call never blocks task creation
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI embeddings API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as {
    data: Array<{ index: number; embedding: EmbeddingVector }>;
  };

  if (!Array.isArray(json.data)) {
    throw new Error('Unexpected OpenAI embeddings response shape');
  }

  // Sort by index so caller gets same-order results regardless of API return order.
  return json.data
    .map((d) => ({ index: d.index, embedding: d.embedding }))
    .sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// BLOB serialization (for SQLite sop_embeddings table)
// ---------------------------------------------------------------------------

/** Serialize Float32Array → Buffer (stored as BLOB in SQLite). */
export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer);
}

/** Deserialize SQLite BLOB → Float32Array. */
export function bufferToFloat32(buf: Buffer | null | undefined): Float32Array | null {
  if (!buf || buf.length < 4) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Cosine similarity — accepts any ArrayLike<number> (Float32Array OR number[])
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two vectors of equal length.
 * Returns [-1, 1]; higher = more similar.
 * Returns 0 for zero-length, mismatched-length, or zero-magnitude vectors.
 *
 * Accepts both Float32Array (semantic SOP search) and number[] (routing).
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

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

// ---------------------------------------------------------------------------
// DB helpers (sop_embeddings table — migration 057)
// ---------------------------------------------------------------------------

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
 * Compute + persist the embedding for one SOP.
 * Safe to call fire-and-forget — errors are logged but never re-thrown so the
 * caller's write path (SOP create / update / import) never fails.
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
    console.warn('[sop-embeddings] storeEmbeddingForSOP failed (non-fatal):', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Bulk semantic ranking (used by sops.ts → suggestSOPsForTask)
// ---------------------------------------------------------------------------

export interface SemanticHit {
  sopId: string;
  similarity: number;
}

/**
 * Rank all embedded SOPs by cosine similarity to a query text.
 * Fetches all embeddings from DB in one shot (~15MB RAM for 2,578 rows).
 * Returns sorted descending by similarity.
 *
 * Returns an empty array if the sop_embeddings table is missing or empty,
 * or if OPENAI_API_KEY is not configured.
 */
export async function rankSOPsBySemantic(queryText: string): Promise<SemanticHit[]> {
  if (!isEmbeddingAvailable()) return [];

  // Check that the table exists (migration 057 may not have run yet on this DB)
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
