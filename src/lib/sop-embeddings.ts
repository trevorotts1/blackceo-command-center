/**
 * SOP / Task Embedding Utilities — Provider-Flexible Module
 *
 * This module serves TWO consumers:
 *
 * 1. department-router.ts (intelligent routing):
 *    - getEmbeddingApiKey()     — key or null (first available across providers)
 *    - fetchEmbeddings(texts[]) — batch embed up to 100 texts → EmbeddingResult[]
 *    - cosineSimilarity(a, b)   — pure math util (accepts any ArrayLike<number>)
 *    - EmbeddingVector          — type alias for number[]
 *
 * 2. sops.ts / SOP routes / backfill script (semantic SOP search + storage):
 *    - isEmbeddingAvailable()   — boolean, true when any embedding provider key present
 *    - resolveEmbeddingProvider() — picks provider (openai | google | none)
 *    - buildSOPEmbedText(sop)   — build canonical embed text for a SOP
 *    - fetchEmbedding(text)     — single text → Float32Array (1536 or 3072 dims)
 *    - float32ToBuffer(arr)     — serialize for SQLite BLOB storage
 *    - bufferToFloat32(buf)     — deserialize from SQLite BLOB
 *    - storeEmbeddingForSOP(sop) — compute + persist embedding (fire-and-forget)
 *    - rankSOPsBySemantic(query) — bulk cosine ranking over sop_embeddings table
 *    - getStoredEmbedding(id)   — retrieve stored embedding for a SOP
 *    - countStaleGoogleEmbeddings() — count rows computed with a retired Google model
 *    - EMBEDDING_MODEL          — active model name (reflects resolved provider)
 *    - EMBEDDING_DIMS           — active dimension count (reflects resolved provider)
 *    - PINNED_GOOGLE_MODEL      — the ONE canonical Google embedding model (gemini-embedding-2)
 *    - PINNED_GOOGLE_DIMS       — the canonical output dim (3072)
 *
 * PROVIDER CONTRACT — SOP_EMBEDDING_PROVIDER=google is the SINGLE CONTRACT.
 *   It must be set in .env.local. OpenAI is an EXPLICIT OPTIONAL FALLBACK only —
 *   it must never be auto-selected when a Google key is present. The QC cross-store
 *   validate gate (qc-cc.sh section 12) enforces this at every deploy.
 *
 * PROVIDER RESOLUTION ORDER (configurable via SOP_EMBEDDING_PROVIDER env):
 *   1. SOP_EMBEDDING_PROVIDER=google  → force Google (gemini-embedding-2 @3072-dim) [CONTRACT]
 *   2. SOP_EMBEDDING_PROVIDER=openai  → force OpenAI (text-embedding-3-small, 1536-dim) [EXPLICIT OPTIONAL FALLBACK]
 *   3. SOP_EMBEDDING_PROVIDER absent → auto-detect:
 *        Google key present       → google (gemini-embedding-2) [PRIMARY]
 *        ELSE OPENAI_API_KEY present → openai [OPTIONAL FALLBACK]
 *        ELSE                     → none (keyword fallback)
 *
 * PINNED GOOGLE MODEL — gemini-embedding-2 (GA as of 2025; output_dimensionality=3072):
 *   POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=<KEY>
 *   Body: { "content": { "parts": [{ "text": "<text>" }] },
 *           "output_dimensionality": 3072 }
 *   Response: { "embedding": { "values": [...3072 floats...] } }
 *   ⚠️  HARD SHUTDOWN: gemini-embedding-001 retires 2026-07-14. Any stored vectors
 *   computed with that model are STALE and must be re-embedded with gemini-embedding-2
 *   before the shutdown. Use countStaleGoogleEmbeddings() to detect them; run the
 *   backfill script with a Google key to recompute. The PRD 1.8c migration guard in
 *   rankSOPsBySemantic() refuses to cross-compare retired-model vectors against
 *   gemini-embedding-2 query vectors (different model → different vector space, even
 *   at the same dimensionality; silent corrupt similarity must not happen).
 *
 * DIMENSION CONSISTENCY GUARD:
 *   Each row in sop_embeddings stores embedding_model + embedding_dims.
 *   rankSOPsBySemantic() reads the active model (both name AND dims) and skips rows
 *   whose model != active provider model (prevents cross-model cosine comparisons).
 *   When no rows match the active model, falls back to keyword mode with a LOUD
 *   warning — never silently returns garbage cosine scores.
 *
 * ENV REQUIREMENTS:
 *   OPENAI_API_KEY            — enables OpenAI embeddings (text-embedding-3-small, 1536-dim)
 *   GOOGLE_API_KEY            — enables Google embeddings (gemini-embedding-2, 3072-dim)
 *   GOOGLE_AI_STUDIO_API_KEY  — alternate Google key name
 *   GEMINI_API_KEY            — alternate Google key name
 *   SOP_EMBEDDING_PROVIDER    — PINNED to "google" (single contract); "openai" is explicit optional fallback only
 *   When absent: auto-detect selects Google first, OpenAI as optional fallback, then keyword-only.
 */

import { queryAll, queryOne, run, getDb } from '@/lib/db';
import type { SOP } from '@/lib/sops';

// ---------------------------------------------------------------------------
// Provider types + constants
// ---------------------------------------------------------------------------

export type EmbeddingProviderName = 'openai' | 'google' | 'none';

export interface EmbeddingProvider {
  name: EmbeddingProviderName;
  apiKey: string | null;
  model: string;
  dims: number;
}

/** OpenAI provider constants */
const OPENAI_MODEL = 'text-embedding-3-small';
const OPENAI_DIMS = 1536;

/**
 * Google Gemini — PINNED to GA model gemini-embedding-2 (PRD 1.8c).
 *
 * Rationale: gemini-embedding-001 HARD SHUTDOWN 2026-07-14. This is the ONE
 * canonical constant for Google embeddings in this codebase. Any stored row
 * with embedding_model != GOOGLE_MODEL is stale and must be re-embedded.
 *
 * output_dimensionality=3072 is passed explicitly on every API call so the
 * dimension is deterministic regardless of model defaults.
 */
export const PINNED_GOOGLE_MODEL = 'gemini-embedding-2';
export const PINNED_GOOGLE_DIMS = 3072;

/** @internal — use PINNED_GOOGLE_MODEL / PINNED_GOOGLE_DIMS externally */
const GOOGLE_MODEL = PINNED_GOOGLE_MODEL;
const GOOGLE_DIMS = PINNED_GOOGLE_DIMS;
const GOOGLE_OUTPUT_DIMENSIONALITY = 3072; // passed to API explicitly

/** The retired model slug — used ONLY to detect stale rows in the DB. */
const GOOGLE_RETIRED_MODEL = 'gemini-embedding-001';

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Maximum batch size for OpenAI /v1/embeddings. */
const BATCH_LIMIT = 100;

/**
 * Google free-tier quota pacing:
 *   - GOOGLE_EMBED_DELAY_MS  between sequential calls (default 250ms)
 *   - GOOGLE_EMBED_MAX_RETRIES  on 429 before giving up on a call
 *   - GOOGLE_EMBED_BACKOFF_MS  initial backoff on 429 (doubles each retry)
 */
const GOOGLE_EMBED_DELAY_MS = 250;
const GOOGLE_EMBED_MAX_RETRIES = 3;
const GOOGLE_EMBED_BACKOFF_MS = 1000;

/**
 * True when a 429 response body indicates a BILLING WALL (prepayment
 * credits / account quota permanently exhausted) rather than a transient
 * per-second/per-minute rate limit. A billing wall cannot succeed on retry —
 * backing off and retrying wastes up to GOOGLE_EMBED_MAX_RETRIES calls and
 * up to ~7s of latency for an error that will look identical on attempt 4 as
 * it did on attempt 1. A genuine rate-limit 429 (no billing marker in the
 * body) is unaffected — it keeps the existing exponential-backoff retry.
 *
 * KNOWN STALENESS RISK — read before touching this function or its wording:
 * this is a literal substring match against Google's CURRENT billing-wall
 * error text ("prepayment credits are depleted" / "credits are depleted" /
 * "insufficient credits"), verified against real captured 429 bodies from a
 * live account, not a guess. It is not a generic-word collision risk (it
 * only ever runs against a 429 response body from Google's own embedding
 * endpoint, never arbitrary content) — the real risk is DRIFT: if Google
 * ever rewords this message, every branch below that calls this function
 * (fetchEmbeddingGoogle's fail-fast-on-429 check, and
 * isNonRetryableEmbeddingError's breaker-trip check further down) silently
 * stops matching. The failure mode is SILENT REVERSION TO THE OLD,
 * WASTEFUL-BUT-SAFE BEHAVIOUR — the 4x retry-with-backoff comes back, the
 * circuit breaker stops tripping — never data corruption or a wrong answer.
 * That makes it easy to miss for a long time: nothing errors, nothing
 * crashes, latency/API-call-volume on a depleted account just quietly climbs
 * back to pre-fix levels. If Google's wording ever changes, this needs a
 * matching update; the fix in tests/unit/google-embed-billing-wall.test.ts's
 * "genuine rate-limit 429 still retries" case is the regression guard that
 * would need a NEW case added for the new wording to catch the silent gap.
 */
function isNonRetryableBillingExhaustion(body: string): boolean {
  return /prepayment credits are depleted/i.test(body)
    || /credits are depleted/i.test(body)
    || /insufficient credits/i.test(body);
}

// ---------------------------------------------------------------------------
// Types (used by department-router.ts)
// ---------------------------------------------------------------------------

export type EmbeddingVector = number[];

export interface EmbeddingResult {
  index: number;
  embedding: EmbeddingVector;
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which embedding provider to use.
 *
 * Priority:
 *   1. SOP_EMBEDDING_PROVIDER env override (forces openai or google)
 *   2. Auto-detect: OPENAI_API_KEY → openai
 *   3. Auto-detect: Google key (any of GOOGLE_API_KEY / GOOGLE_AI_STUDIO_API_KEY
 *      / GEMINI_API_KEY) → google
 *   4. No key → none (keyword fallback, no error)
 *
 * This function is cheap (env reads only, no I/O). Safe to call per-request.
 */
export function resolveEmbeddingProvider(): EmbeddingProvider {
  const override = process.env.SOP_EMBEDDING_PROVIDER?.toLowerCase().trim();

  // ── Forced override ────────────────────────────────────────────────────────
  // CONTRACT: SOP_EMBEDDING_PROVIDER=google is the pinned single contract.
  // google is checked first so the contract path is unambiguous.
  if (override === 'google') {
    const key = resolveGoogleKey();
    return { name: 'google', apiKey: key, model: GOOGLE_MODEL, dims: GOOGLE_DIMS };
  }
  // EXPLICIT OPTIONAL FALLBACK: openai is only reached when operator explicitly
  // sets SOP_EMBEDDING_PROVIDER=openai. Never auto-selected when Google key present.
  if (override === 'openai') {
    const key = process.env.OPENAI_API_KEY?.trim() || null;
    return { name: 'openai', apiKey: key, model: OPENAI_MODEL, dims: OPENAI_DIMS };
  }

  // ── Auto-detect (no SOP_EMBEDDING_PROVIDER set) ────────────────────────────
  // PRIMARY: Google (gemini-embedding-2 @3072-dim) — the pinned single contract.
  // In production SOP_EMBEDDING_PROVIDER=google is always set; this path is a
  // safety net only.
  const googleKey = resolveGoogleKey();
  if (googleKey) {
    return { name: 'google', apiKey: googleKey, model: GOOGLE_MODEL, dims: GOOGLE_DIMS };
  }

  // OPTIONAL FALLBACK: OpenAI — only reached when no Google key is present.
  // This is an explicit optional fallback, not the default path.
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiKey && openaiKey.length > 10) {
    return { name: 'openai', apiKey: openaiKey, model: OPENAI_MODEL, dims: OPENAI_DIMS };
  }

  // 3. No key → keyword-only fallback
  return { name: 'none', apiKey: null, model: '', dims: 0 };
}

/**
 * Return the first present Google API key, or null.
 * Checks GOOGLE_API_KEY, GOOGLE_AI_STUDIO_API_KEY, GEMINI_API_KEY in that order.
 * Each key must be non-trivially long (> 10 chars) to count as set.
 */
export function resolveGoogleKey(): string | null {
  const candidates = [
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_AI_STUDIO_API_KEY,
    process.env.GEMINI_API_KEY,
  ];
  for (const k of candidates) {
    if (k && k.trim().length > 10) return k.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Legacy key / availability helpers (preserved for department-router.ts + sops.ts)
// ---------------------------------------------------------------------------

/**
 * Return the first available embedding API key or null.
 * Used by department-router.ts to decide whether to run semantic routing.
 *
 * Returns the OpenAI key if present, otherwise the first Google key.
 * The check is cheap — no I/O, env-var reads only.
 */
export function getEmbeddingApiKey(): string | null {
  const provider = resolveEmbeddingProvider();
  return provider.name !== 'none' ? provider.apiKey : null;
}

/**
 * True when any embedding provider key is set and non-trivially long.
 * Used by sops.ts / SOP routes to decide whether semantic search is active.
 */
export function isEmbeddingAvailable(): boolean {
  const provider = resolveEmbeddingProvider();
  return provider.name !== 'none' && Boolean(provider.apiKey);
}

// ---------------------------------------------------------------------------
// Convenience constants (reflect resolved provider — for callers that need a
// single value, e.g. the backfill script's display output).
// These are DYNAMIC properties of the resolved provider, not hardcoded.
// ---------------------------------------------------------------------------

/**
 * The active embedding model name. Reflects resolveEmbeddingProvider().
 * Exported as a runtime value (not a const) because it depends on env.
 *
 * NOTE: Callers that store per-row model info should use
 * resolveEmbeddingProvider().model directly rather than this export.
 * This is kept for backfill script compatibility.
 */
export const EMBEDDING_MODEL: string = (() => {
  try {
    return resolveEmbeddingProvider().model || OPENAI_MODEL;
  } catch {
    return OPENAI_MODEL;
  }
})();

/**
 * The active embedding dimension count. Reflects resolveEmbeddingProvider().
 * See note on EMBEDDING_MODEL above.
 */
export const EMBEDDING_DIMS: number = (() => {
  try {
    const p = resolveEmbeddingProvider();
    return p.dims > 0 ? p.dims : OPENAI_DIMS;
  } catch {
    return OPENAI_DIMS;
  }
})();

// ---------------------------------------------------------------------------
// SOP embed-text construction
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
 */
async function fetchEmbeddingOpenAI(text: string, apiKey: string): Promise<Float32Array> {
  // TICKET 4a: this single-text call is the one on the hot dispatch path
  // (rankSOPsBySemantic → resolveSopForTask → autoDispatchTask) and previously
  // had no bound at all — unlike its own batched sibling (fetchEmbeddingsOpenAI,
  // below) and the Google single-text equivalent (fetchEmbeddingGoogle), both of
  // which already pass an AbortSignal.timeout. A stalled OpenAI response here
  // hung forever: the caller's try/catch (rankSOPsBySemantic) only catches a
  // throw, never an unsettled promise, so nothing downstream (including the
  // outer catch in autoDispatchTask) ever saw it. Matches the confirmed
  // "resolution log line, then nothing" dispatch-silent-stall symptom.
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: text,
      encoding_format: 'float',
    }),
    signal: AbortSignal.timeout(10_000),
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
 * Fetch embeddings for an ARRAY of texts in one batched OpenAI API call.
 * Returns EmbeddingResult[] in the SAME ORDER as `texts`.
 * Throws on error so callers can fall back to keyword scoring.
 */
async function fetchEmbeddingsOpenAI(texts: string[], apiKey: string): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];
  if (texts.length > BATCH_LIMIT) {
    throw new Error(`fetchEmbeddings: batch limit is ${BATCH_LIMIT}, got ${texts.length}`);
  }

  const truncated = texts.map((t) => (t.length > 8_000 ? t.slice(0, 8_000) : t));

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: truncated,
    }),
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

  return json.data
    .map((d) => ({ index: d.index, embedding: d.embedding }))
    .sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Google Gemini embedContent API calls
// ---------------------------------------------------------------------------

/**
 * Sleep for ms milliseconds. Used for quota pacing.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a SINGLE text embedding from Google Gemini (gemini-embedding-2).
 *
 * API shape (PRD 1.8c — GA model, output_dimensionality explicit):
 *   POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=<KEY>
 *   Body: { "content": { "parts": [{ "text": "<text>" }] },
 *           "output_dimensionality": 3072 }
 *   Response: { "embedding": { "values": [...3072 floats...] } }
 *
 * output_dimensionality is always passed explicitly so the dimension is
 * deterministic and does not depend on model-version defaults.
 *
 * Retries on 429 (quota) with exponential backoff. After max retries, throws
 * with a "quota exceeded" message so the caller can fall back to keyword search.
 */
async function fetchEmbeddingGoogle(text: string, apiKey: string): Promise<Float32Array> {
  const url = `${GOOGLE_API_BASE}/${GOOGLE_MODEL}:embedContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    content: { parts: [{ text: text }] },
    output_dimensionality: GOOGLE_OUTPUT_DIMENSIONALITY,
  });

  let backoffMs = GOOGLE_EMBED_BACKOFF_MS;
  for (let attempt = 0; attempt <= GOOGLE_EMBED_MAX_RETRIES; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (resp.status === 429) {
      const errBody = await resp.text().catch(() => '');

      if (isNonRetryableBillingExhaustion(errBody)) {
        throw new Error(
          `Google embeddings billing wall (429): ${errBody.slice(0, 200)} — ` +
          `not retrying (credits exhausted; retrying cannot succeed). Falling back to keyword search.`
        );
      }

      if (attempt >= GOOGLE_EMBED_MAX_RETRIES) {
        throw new Error(
          `Google embeddings quota exceeded (429) after ${GOOGLE_EMBED_MAX_RETRIES} retries — ` +
          `falling back to keyword search. Re-run the backfill later.`
        );
      }
      console.warn(
        `[sop-embeddings] Google 429 on attempt ${attempt + 1}/${GOOGLE_EMBED_MAX_RETRIES + 1} — ` +
        `backing off ${backoffMs}ms`
      );
      await sleep(backoffMs);
      backoffMs *= 2;
      continue;
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`Google embeddings API error ${resp.status}: ${errBody.slice(0, 200)}`);
    }

    const json = (await resp.json()) as { embedding?: { values?: number[] } };
    const values = json?.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('Unexpected Google embedContent response shape');
    }
    return new Float32Array(values);
  }

  // Should not reach here, but TypeScript requires it.
  throw new Error('Google embedding: unexpected loop exit');
}

/**
 * Fetch embeddings for an ARRAY of texts using Google Gemini (gemini-embedding-2).
 *
 * Google's embedContent API is ONE-TEXT-PER-CALL (no batch endpoint).
 * We process sequentially with pacing (GOOGLE_EMBED_DELAY_MS between calls)
 * to respect the free-tier quota. On sustained 429, we stop and return partial
 * results so the caller can fall back to keyword scoring for remaining items.
 *
 * Returns EmbeddingResult[] in the SAME ORDER as `texts`.
 * If a 429 quota error is hit, throws after the first occurrence so the batch
 * caller (fetchEmbeddings) can fall back cleanly.
 */
async function fetchEmbeddingsGoogle(texts: string[], apiKey: string): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];

  const results: EmbeddingResult[] = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i].length > 8_000 ? texts[i].slice(0, 8_000) : texts[i];
    const vec = await fetchEmbeddingGoogle(text, apiKey);
    results.push({ index: i, embedding: Array.from(vec) });

    // Pace sequential calls to stay within free-tier quota limits.
    // Skip delay after the last item.
    if (i < texts.length - 1) {
      await sleep(GOOGLE_EMBED_DELAY_MS);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Circuit breaker — short-cooldown "embeddings known-unavailable" gate
// ---------------------------------------------------------------------------
//
// PRE-FIX: a depleted/exhausted embedding account got REDISCOVERED on every
// call site — storeEmbeddingForSOP, rankSOPsBySemantic, and
// department-router's semanticRankDepartments (via fetchEmbeddings) — each
// one independently hitting the API, throwing, and falling back, for as
// long as the account stayed exhausted. Wired into fetchEmbedding /
// fetchEmbeddings (the ONE provider-agnostic choke point both providers and
// all three call sites already funnel through), this breaker makes that
// discovery happen ONCE per cooldown window: the first non-retryable
// failure (billing wall / bad credentials — see isNonRetryableEmbeddingError
// below) opens the breaker; every call for the rest of the cooldown fails
// FAST with NO network call at all, throwing the SAME kind of Error callers
// already catch-and-fall-back on today, so this requires zero caller changes.
//
// Self-heals with no restart: once Date.now() clears the cooldown, the very
// next call attempts a REAL network call again. Success closes the breaker;
// another non-retryable failure reopens it for a fresh cooldown — so a
// topped-up account recovers on its own the next time anything calls in.
//
// A genuine transient failure (network blip, 5xx, a rate-limit 429 that
// isn't a billing wall) does NOT trip the breaker — see
// isNonRetryableEmbeddingError. Those keep today's per-call retry/fallback
// behaviour untouched; the breaker only ever engages for the "will not
// clear on its own within the cooldown" class of failure.

const DEFAULT_EMBEDDING_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function breakerCooldownMs(): number {
  const raw = process.env.EMBEDDING_BREAKER_COOLDOWN_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EMBEDDING_BREAKER_COOLDOWN_MS;
}

interface EmbeddingBreakerState {
  /** epoch ms until which the breaker is open; 0 or past = closed. */
  openUntil: number;
  reason: string;
}

const _embeddingBreaker: EmbeddingBreakerState = { openUntil: 0, reason: '' };

function isBreakerOpen(): boolean {
  return Date.now() < _embeddingBreaker.openUntil;
}

function tripBreaker(reason: string): void {
  _embeddingBreaker.openUntil = Date.now() + breakerCooldownMs();
  _embeddingBreaker.reason = reason;
  console.warn(
    `[sop-embeddings] circuit breaker OPEN for ${breakerCooldownMs()}ms — embeddings will fail fast ` +
    `(no network calls) until it self-heals: ${reason}`
  );
}

function closeBreaker(): void {
  if (_embeddingBreaker.openUntil !== 0) {
    console.warn('[sop-embeddings] circuit breaker CLOSED — embeddings recovered.');
  }
  _embeddingBreaker.openUntil = 0;
  _embeddingBreaker.reason = '';
}

function breakerOpenError(): Error {
  return new Error(
    `Embeddings circuit breaker open (${_embeddingBreaker.reason}) — failing fast without a network ` +
    `call. Retries automatically once the cooldown expires.`
  );
}

/**
 * True when an embedding-call failure looks unrecoverable-within-cooldown
 * (billing wall / quota exhaustion / bad credentials) rather than a
 * transient blip (network hiccup, 5xx, a single rate-limit tick that
 * fetchEmbeddingGoogle's own backoff already handles). Trips the breaker
 * ONLY for the former — a transient failure must not disable embeddings for
 * every OTHER in-flight/queued call for the next 5-10 minutes.
 *
 * Covers both providers: the Google billing-wall phrasing
 * (isNonRetryableBillingExhaustion, also used by fetchEmbeddingGoogle's
 * fail-fast-on-429 check above) plus OpenAI's insufficient_quota error code
 * and both providers' 401/403 auth-rejection shapes.
 *
 * SAME STALENESS RISK AS isNonRetryableBillingExhaustion ABOVE (this
 * function is a superset check built on top of it): every branch here is a
 * literal substring match on provider error text. If any provider reworks
 * its wording, this silently stops tripping the breaker — the failure mode
 * is SILENT REVERSION TO WASTEFUL-BUT-SAFE, not corruption: a depleted
 * account just goes back to paying one real network call per dispatch
 * forever (the pre-Fix-C state), with nothing crashing or erroring to flag
 * it. See the fuller note on isNonRetryableBillingExhaustion above before
 * changing either function.
 */
function isNonRetryableEmbeddingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (isNonRetryableBillingExhaustion(msg)) return true;
  const lower = msg.toLowerCase();
  return (
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient credits') ||
    lower.includes(' 401') || lower.startsWith('401') ||
    lower.includes(' 403') || lower.startsWith('403') ||
    lower.includes('permission_denied') ||
    lower.includes('api key not valid') ||
    lower.includes('unauthorized') ||
    lower.includes('unauthenticated')
  );
}

/** Test-only: force the breaker open (fixed reason) — see tests/unit. */
export function _tripEmbeddingBreakerForTests(reason = 'test'): void {
  tripBreaker(reason);
}
/** Test-only: force the breaker closed. */
export function _closeEmbeddingBreakerForTests(): void {
  closeBreaker();
}
/** Test-only: read whether the breaker is currently open. */
export function _isEmbeddingBreakerOpenForTests(): boolean {
  return isBreakerOpen();
}
/** Test-only: set openUntil directly (e.g. Date.now() - 1 to simulate an
 * expired cooldown deterministically, with no real waiting). */
export function _setEmbeddingBreakerOpenUntilForTests(ts: number): void {
  _embeddingBreaker.openUntil = ts;
}

// ---------------------------------------------------------------------------
// Public API: fetchEmbedding / fetchEmbeddings (provider-agnostic)
// ---------------------------------------------------------------------------

/**
 * Fetch a SINGLE text embedding using the resolved provider.
 * Returns Float32Array (1536 dims for OpenAI, 3072 dims for Google).
 * Throws on error or when no provider is configured.
 *
 * Used by: storeEmbeddingForSOP, rankSOPsBySemantic, backfill script.
 */
export async function fetchEmbedding(text: string): Promise<Float32Array> {
  const provider = resolveEmbeddingProvider();
  if (provider.name === 'none' || !provider.apiKey) {
    throw new Error('No embedding provider configured (no OPENAI_API_KEY or Google key found)');
  }
  if (isBreakerOpen()) {
    throw breakerOpenError();
  }
  try {
    const result = provider.name === 'google'
      ? await fetchEmbeddingGoogle(text, provider.apiKey)
      : await fetchEmbeddingOpenAI(text, provider.apiKey);
    closeBreaker();
    return result;
  } catch (err) {
    if (isNonRetryableEmbeddingError(err)) {
      tripBreaker(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

/**
 * Fetch embeddings for an ARRAY of texts.
 * Returns EmbeddingResult[] in the SAME ORDER as `texts`.
 * Throws on error so callers can fall back to keyword scoring.
 *
 * OpenAI: one batched API call (up to BATCH_LIMIT texts).
 * Google: sequential calls with pacing (free-tier quota compliance).
 *
 * Used by: department-router.ts (semantic routing).
 */
export async function fetchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
  const provider = resolveEmbeddingProvider();
  if (provider.name === 'none' || !provider.apiKey) {
    throw new Error('No embedding API key configured');
  }
  if (texts.length === 0) return [];
  if (isBreakerOpen()) {
    throw breakerOpenError();
  }

  try {
    const result = provider.name === 'google'
      ? await fetchEmbeddingsGoogle(texts, provider.apiKey)
      : await fetchEmbeddingsOpenAI(texts, provider.apiKey);
    closeBreaker();
    return result;
  } catch (err) {
    if (isNonRetryableEmbeddingError(err)) {
      tripBreaker(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
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
 * Dimension-agnostic: works for both 1536-dim (OpenAI) and 3072-dim (Google).
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

/**
 * Count SOP embeddings stored with a model other than the currently pinned
 * Google model (gemini-embedding-2). Used by the backfill script and health checks
 * to detect rows that need re-embedding before the 2026-07-14 shutdown.
 *
 * Returns an object with:
 *   stale: number of rows with embedding_model == GOOGLE_RETIRED_MODEL
 *   total: total rows in sop_embeddings
 *   pinnedModel: the currently pinned Google model name
 *   retiredModel: the retired model name (gemini-embedding-001)
 */
export function countStaleGoogleEmbeddings(): {
  stale: number;
  total: number;
  pinnedModel: string;
  retiredModel: string;
} {
  const db = getDb();
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sop_embeddings'")
    .get();
  if (!tableExists) {
    return { stale: 0, total: 0, pinnedModel: GOOGLE_MODEL, retiredModel: GOOGLE_RETIRED_MODEL };
  }

  const totalRow = queryOne<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM sop_embeddings',
    []
  );
  const staleRow = queryOne<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM sop_embeddings WHERE embedding_model = ?',
    [GOOGLE_RETIRED_MODEL]
  );

  return {
    stale: staleRow?.cnt ?? 0,
    total: totalRow?.cnt ?? 0,
    pinnedModel: GOOGLE_MODEL,
    retiredModel: GOOGLE_RETIRED_MODEL,
  };
}

/**
 * Health snapshot of the SOP / routing embedding store (F2.3 / DEP-11).
 *
 * This is the TypeScript-side half of the dual-store embedding health surface.
 * It reports the SOP store's active provider, per-row model histogram, stale
 * count and semantic-readiness so the CC `/api/health` endpoint can present it
 * side-by-side with the persona index (reported by shared-utils/embedding_health.py).
 *
 * FAIL-CLOSED / DEGRADE-LOUDLY: this function NEVER throws. A missing table,
 * empty store, or DB error is reported as `available:false` + `degraded:true`
 * with a human note — never an exception that would 500 the health route. It is
 * also the last-resort fallback the health route uses when the Python probe is
 * unavailable (no python3, timeout), so it must stand on its own.
 */
export interface SOPEmbeddingHealth {
  store: 'sop_index';
  available: boolean;
  provider: EmbeddingProviderName;
  activeModel: string;
  activeDims: number;
  totalRows: number;
  modelHistogram: Record<string, number>;
  staleRows: number;
  semanticReady: boolean;
  degraded: boolean;
  notes: string[];
}

export function getSOPEmbeddingHealth(): SOPEmbeddingHealth {
  const notes: string[] = [];
  let provider: EmbeddingProvider;
  try {
    provider = resolveEmbeddingProvider();
  } catch {
    provider = { name: 'none', apiKey: null, model: '', dims: 0 };
  }

  const health: SOPEmbeddingHealth = {
    store: 'sop_index',
    available: false,
    provider: provider.name,
    activeModel: provider.model,
    activeDims: provider.dims,
    totalRows: 0,
    modelHistogram: {},
    staleRows: 0,
    semanticReady: false,
    degraded: true,
    notes,
  };

  try {
    const db = getDb();
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sop_embeddings'")
      .get();
    if (!tableExists) {
      notes.push('sop_index: table sop_embeddings missing (migration 057 not run) — keyword-only fallback.');
      return health;
    }

    health.available = true;

    const hist: Record<string, number> = {};
    const rows = queryAll<{ model: string | null; cnt: number }>(
      `SELECT COALESCE(NULLIF(embedding_model, ''), '(unknown)') AS model, COUNT(*) AS cnt
         FROM sop_embeddings GROUP BY model`,
      []
    );
    for (const r of rows) hist[r.model ?? '(unknown)'] = r.cnt;
    health.modelHistogram = hist;
    health.totalRows = Object.values(hist).reduce((a, b) => a + b, 0);

    // Stale rows = the retired Google model (gemini-embedding-001), reused from
    // the single source of truth so the two paths never drift.
    health.staleRows = countStaleGoogleEmbeddings().stale;

    if (provider.name === 'none') {
      health.semanticReady = false;
      notes.push('sop_index: no embedding provider key configured — SOP routing is keyword-only.');
    } else {
      const canonicalRows = hist[provider.model] ?? 0;
      health.semanticReady = canonicalRows > 0;
      if (canonicalRows === 0 && health.totalRows > 0) {
        notes.push(
          `sop_index: ZERO rows match the active model ${provider.model} ` +
          `(stored: [${Object.keys(hist).join(', ')}]) — semantic routing DISABLED (keyword-only).`
        );
      }
    }

    if (health.totalRows === 0) {
      notes.push('sop_index: table present but EMPTY — run the backfill to build the SOP index.');
    }
    if (health.staleRows > 0) {
      notes.push(
        `sop_index: ${health.staleRows} row(s) on retired gemini-embedding-001 — ` +
        `re-embed with ${PINNED_GOOGLE_MODEL} before the 2026-07-14 shutdown.`
      );
    }

    // degraded when no usable semantic rows OR any stale rows poison the space.
    health.degraded = !health.semanticReady || health.staleRows > 0;
    return health;
  } catch (err) {
    health.available = false;
    health.degraded = true;
    notes.push(
      `sop_index: could not read store (${(err as Error).message}) — treating as degraded/keyword-only.`
    );
    return health;
  }
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
 *
 * Stores the model name + dims used so the query path can detect provider
 * mismatches (prevents comparing 1536-dim vs 3072-dim vectors).
 */
export async function storeEmbeddingForSOP(sop: SOP): Promise<void> {
  if (!isEmbeddingAvailable()) return;
  try {
    const provider = resolveEmbeddingProvider();
    if (provider.name === 'none' || !provider.apiKey) return;

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
      [sop.id, blob, provider.model, provider.dims, now]
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
 * DIMENSION CONSISTENCY GUARD:
 *   The active provider's model + dims are determined first. Rows stored with
 *   a DIFFERENT model (i.e. different dims) are SKIPPED — we never compare
 *   a 1536-dim OpenAI vector against a 3072-dim Google vector. This prevents
 *   nonsensical cosine comparisons when a client switches providers.
 *
 *   If no rows match the active provider's model, returns an empty array so
 *   the caller falls back to keyword search. The operator must re-run the
 *   backfill with the new provider key to rebuild embeddings in the new space.
 *
 * Returns an empty array if:
 *   - sop_embeddings table is missing (migration 057 not yet run)
 *   - No embedding provider is configured
 *   - No rows match the active provider's model
 *   - API error during query embedding
 */
export async function rankSOPsBySemantic(queryText: string): Promise<SemanticHit[]> {
  if (!isEmbeddingAvailable()) return [];

  // Check that the table exists (migration 057 may not have run yet on this DB)
  const db = getDb();
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sop_embeddings'")
    .get();
  if (!tableExists) return [];

  // Determine active provider model for the dimension consistency guard.
  const activeProvider = resolveEmbeddingProvider();
  if (activeProvider.name === 'none') return [];

  const rows = queryAll<{ sop_id: string; embedding: Buffer | null; embedding_dims: number; embedding_model: string }>(
    'SELECT sop_id, embedding, embedding_dims, embedding_model FROM sop_embeddings WHERE embedding IS NOT NULL',
    []
  );
  if (rows.length === 0) return [];

  // ── Model-drift guard (PRD 1.8c) ───────────────────────────────────────────
  // Match on BOTH model name AND dims. gemini-embedding-001 and gemini-embedding-2
  // produce vectors in DIFFERENT spaces even at the same 3072-dim — a pure slug
  // change without re-embedding silently corrupts similarity scores. We refuse to
  // cross-compare them. Only rows stored with the EXACT active model are used.
  const matchingRows = rows.filter(
    (r) => r.embedding_model === activeProvider.model && r.embedding_dims === activeProvider.dims
  );

  if (matchingRows.length === 0) {
    // Check how many rows exist for the retired Google model specifically.
    const retiredRows = rows.filter((r) => r.embedding_model === GOOGLE_RETIRED_MODEL);

    if (retiredRows.length > 0) {
      // Stale rows from the retired gemini-embedding-001 model detected.
      // LOUD warning — operator must re-run the backfill with a Google key.
      console.warn(
        `[sop-embeddings] ⚠️  MODEL-DRIFT DETECTED: ${retiredRows.length} SOP embedding(s) were computed ` +
        `with retired model "${GOOGLE_RETIRED_MODEL}" (hard shutdown 2026-07-14). ` +
        `Active model is "${activeProvider.model}". These vectors are in a DIFFERENT space — ` +
        `cross-model cosine comparison is DISABLED. Falling back to keyword search. ` +
        `ACTION REQUIRED: re-run the backfill script with a Google key (GOOGLE_API_KEY / ` +
        `GEMINI_API_KEY) to re-embed all ${retiredRows.length} stale rows with ${activeProvider.model}.`
      );
    } else {
      const distinctModels = Array.from(new Set(rows.map((r) => r.embedding_model))).join(', ');
      console.warn(
        `[sop-embeddings] rankSOPsBySemantic: no stored embeddings match active model "${activeProvider.model}" ` +
        `(dims=${activeProvider.dims}). Stored models: [${distinctModels || 'none'}]. ` +
        `Falling back to keyword search. Run the backfill script with the current provider key ` +
        `to build embeddings for model ${activeProvider.model}.`
      );
    }
    return [];
  }

  let queryVec: Float32Array;
  try {
    queryVec = await fetchEmbedding(queryText);
  } catch (err) {
    console.warn('[sop-embeddings] rankSOPsBySemantic: embed query failed:', (err as Error).message);
    return [];
  }

  const hits: SemanticHit[] = [];
  for (const row of matchingRows) {
    const vec = bufferToFloat32(row.embedding);
    if (!vec) continue;
    hits.push({ sopId: row.sop_id, similarity: cosineSimilarity(queryVec, vec) });
  }

  hits.sort((a, b) => b.similarity - a.similarity);
  return hits;
}
