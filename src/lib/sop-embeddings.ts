/**
 * SOP / task embedding utilities.
 *
 * Thin, provider-agnostic wrapper around text embedding APIs used for
 * semantic task routing.  Currently backed by OpenAI text-embedding-3-small
 * (cheapest, 1536-dim).  The key is ALWAYS the client's own OPENAI_API_KEY
 * — never a shared key.
 *
 * The module is deliberately stateless: it does not cache vectors to disk.
 * The routing layer calls it at task-creation time (fast, low frequency) and
 * falls back to keyword scoring on any error or when no key is configured.
 *
 * Public surface used by department-router.ts:
 *   - getEmbeddingApiKey()   — returns the configured key or null
 *   - fetchEmbeddings(texts) — batches up to 100 texts in one API call
 *   - cosineSimilarity(a, b) — pure math utility
 *   - EmbeddingVector        — type alias for number[]
 */

export type EmbeddingVector = number[];

export interface EmbeddingResult {
  index: number;
  embedding: EmbeddingVector;
}

/** Maximum batch size for OpenAI /v1/embeddings. */
const BATCH_LIMIT = 100;

/** OpenAI embedding model — cheap, fast, good enough for routing. */
const EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Return the best available embedding API key from the running process env.
 *
 * Priority:
 *   1. OPENAI_API_KEY         — OpenAI embeddings
 *
 * Returns null if no key is configured. The caller (department-router) falls
 * back to keyword scoring in that case. The check is intentionally cheap so
 * it can be called once per routing decision without hitting any I/O.
 */
export function getEmbeddingApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY;
  if (key && key.trim().length > 10) return key.trim();
  return null;
}

/**
 * Fetch embeddings for an array of texts in a single API call.
 *
 * Returns an array of EmbeddingResult in the SAME ORDER as `texts`.
 * Throws on network/API errors so the caller can treat them as
 * "embeddings unavailable" and fall back to keyword scoring.
 *
 * @param texts  1–BATCH_LIMIT strings to embed.
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
    // 10-second timeout via AbortSignal so a slow API call never blocks task creation
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

/**
 * Cosine similarity between two equal-length vectors.
 * Returns a value in [−1, 1]; higher = more similar.
 *
 * Returns 0 if either vector is zero-length or vectors differ in length
 * (safe fallback rather than throwing).
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
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
