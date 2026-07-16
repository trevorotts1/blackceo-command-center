/**
 * P2-04 (c) step 3 — KILL THE MIRAGE.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * -------------------------------
 * Root cause item 4 (P2-04(b)): the "/v1/models unauthenticated mirage" — a
 * provider's model-LIST endpoint can return 200 with a real catalog even when
 * the key used is garbage, revoked, or absent, because some providers don't
 * gate the list endpoint behind real auth the way they gate actual usage. The
 * weekly refresh job (`refresh-models.ts`) calls exactly that list endpoint
 * (`provider.fetchModels()`) and stamps `success:true` on any 200 — so a
 * bogus key can still show a green "OK" badge on the Model Settings tile. That
 * is the mirage: "models listed" was being read as "auth works".
 *
 * THE FIX
 * -------
 * A provider tile now has three honestly-distinct states, never conflated:
 *
 *   1. key found              — a key exists in some store. No authenticated
 *                                call has ever succeeded for it (or none has
 *                                been attempted).
 *   2. models listed, auth UNPROVEN — the refresh job's fetchModels() call
 *                                succeeded (so SOMETHING responded), but that
 *                                is NOT proof of auth (the mirage). Never
 *                                rendered as a green check.
 *   3. call PROVEN             — `proveProviderAuth` actually completed a
 *                                real authenticated call (a genuine chat
 *                                completion capped at 5 output tokens, or the
 *                                connector's own `verifyKey()` when no
 *                                `chatCompletion` exists) and it succeeded.
 *                                Cached 24h in `provider_auth_proof_cache` so
 *                                repeat page loads never re-spend the call.
 *
 * This is a DELIBERATE, narrow exception to the "no live probing in the status
 * route" rule documented in IntelligenceProviderList.tsx's HONESTY NOTE — that
 * rule stands for the passive GET (which only reads the cache, never calls a
 * provider); the actual authenticated call only happens from an explicit
 * "Prove" action or the weekly cron, and its result is cached 24h either way.
 */

import { queryOne, run } from '@/lib/db';
import { getProvider } from '@/lib/model-providers';
import type { ModelProvider, ChatCompletionResponse, SmokeTestResult } from '@/lib/model-providers/types';
import { listModels } from '@/lib/model-registry';

export const AUTH_PROOF_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export type AuthProofMethod = 'chat_completion' | 'verify_key' | 'unavailable';

/**
 * WHY THIS EXISTS — a failed proof is not one thing.
 *
 * The proof call needs a model id to attempt a completion, and it takes one
 * from this box's own catalog. When that catalog carries a STALE row (a model
 * upstream has since retired), the completion fails with "model not found" —
 * which says NOTHING about whether the key works. Reporting that as a bare
 * `ok:false` renders as a red "auth failed" tile: a phantom incident. A health
 * check that manufactures false failures is worse than no health check.
 *
 * Proven on the operator box 2026-07-16: `listModels({provider:'ollama-cloud'})`
 * ordered by `label ASC` returns `ollama-cloud/deepseek-v3.1:671b` at index 0.
 * That model is absent from the live Ollama Cloud catalog (18 models, all
 * current-gen) AND absent from the local daemon (16 models) — so every prove
 * for this provider failed model-not-found while the key was perfectly good.
 *
 *   - 'none'            — no failure (ok:true).
 *   - 'auth'            — the key was actually rejected (401/403). A REAL failure.
 *   - 'model_not_found' — the model id doesn't exist upstream (404 / "not found").
 *                         Auth was NOT disproven; the catalog is stale.
 *   - 'network'         — transport failed (DNS/ECONNREFUSED/timeout). Says
 *                         nothing about the key.
 *   - 'unknown'         — unclassifiable.
 */
export type AuthProofFailureKind = 'none' | 'auth' | 'model_not_found' | 'network' | 'unknown';

/**
 * How many catalogued models the proof will try before giving up. Bounded so a
 * badly-stale catalog can't turn one "Prove" click into dozens of paid calls.
 */
export const MAX_PROOF_MODEL_ATTEMPTS = 3;

export interface AuthProofResult {
  ok: boolean;
  method: AuthProofMethod;
  modelId: string | null;
  detail: string | null;
  provenAt: string;
  /** Why the proof failed, when it did. 'none' when ok. */
  failureKind: AuthProofFailureKind;
}

export interface AuthProofCacheRow {
  provider_slug: string;
  proven_at: string;
  ok: number;
  method: string;
  model_id: string | null;
  detail: string | null;
  /** Nullable: rows written before migration 106 have no failure_kind. */
  failure_kind: string | null;
}

/**
 * Classify a provider error. Providers report these differently, so match on
 * the HTTP status when present and fall back to the message text.
 */
export function classifyProofFailure(err: unknown): AuthProofFailureKind {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // Auth first: a 401/403 is unambiguous and must never be masked by a
  // "not found" substring appearing elsewhere in the same message.
  if (/\b(401|403)\b/.test(msg)) return 'auth';
  if (/unauthorized|forbidden|invalid api key|invalid_api_key|authentication|invalid token|permission denied/.test(msg)) {
    return 'auth';
  }

  // Model-not-found: a 404, or an explicit model-missing phrase. Ollama's
  // daemon says `model "x" not found, try pulling it first`; hosted
  // OpenAI-compatible APIs say `The model 'x' does not exist`.
  if (/\b404\b/.test(msg)) return 'model_not_found';
  if (/model .*(not found|does not exist|is not available)|not found, try pulling|unknown model|no such model/.test(msg)) {
    return 'model_not_found';
  }

  // Transport.
  if (/econnrefused|enotfound|etimedout|econnreset|network|fetch failed|socket hang up|timeout|abort/.test(msg)) {
    return 'network';
  }

  return 'unknown';
}

/** Read the cached proof for a provider, or null if none exists. Never calls the network. */
export function getCachedAuthProof(slug: string): AuthProofCacheRow | null {
  return (
    queryOne<AuthProofCacheRow>(`SELECT * FROM provider_auth_proof_cache WHERE provider_slug = ?`, [slug]) ?? null
  );
}

/** True when a cache row exists and is younger than the 24h TTL. */
export function isProofFresh(row: AuthProofCacheRow | null, nowMs: number = Date.now()): boolean {
  if (!row) return false;
  const provenAtMs = Date.parse(row.proven_at);
  if (Number.isNaN(provenAtMs)) return false;
  return nowMs - provenAtMs < AUTH_PROOF_TTL_MS;
}

function upsertAuthProofCache(slug: string, result: AuthProofResult): void {
  run(
    `INSERT INTO provider_auth_proof_cache (provider_slug, proven_at, ok, method, model_id, detail, failure_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_slug) DO UPDATE SET
       proven_at = excluded.proven_at,
       ok = excluded.ok,
       method = excluded.method,
       model_id = excluded.model_id,
       detail = excluded.detail,
       failure_kind = excluded.failure_kind`,
    [slug, result.provenAt, result.ok ? 1 : 0, result.method, result.modelId, result.detail, result.failureKind],
  );
}

/**
 * Perform ONE real authenticated call against a provider and report whether it
 * proved the key works. Prefers a genuine 5-output-token chat completion
 * (the strongest proof — forging a real completion requires real auth for
 * effectively every provider, unlike an unauthenticated model-list mirage);
 * falls back to the connector's own `verifyKey()` when no `chatCompletion` is
 * implemented (still a real authenticated call, just via a different
 * endpoint — labeled honestly as such, never claimed to be a completion).
 *
 * NEVER logs or returns the API key. NEVER treats a bare fetchModels() success
 * as proof — this function does not call fetchModels at all.
 */
export async function proveProviderAuth(provider: ModelProvider, apiKey: string): Promise<AuthProofResult> {
  const provenAt = new Date().toISOString();
  /** Model ids the catalog offered but upstream rejected as non-existent. */
  const staleModelIds: string[] = [];

  if (provider.chatCompletion) {
    // Need a real native model id to attempt a completion. Take candidates from
    // this box's own active catalog (never invent a model id) — but do NOT bet
    // the whole verdict on inventory[0]: that slot is just whatever sorts first
    // by label, and a stale row there used to sink every proof for the provider.
    const inventory = listModels({ provider: provider.slug });

    for (const entry of inventory.slice(0, MAX_PROOF_MODEL_ATTEMPTS)) {
      const candidate = entry.model_id;
      if (!candidate) continue;
      const nativeModelId = candidate.slice(candidate.indexOf('/') + 1);
      if (!nativeModelId) continue;

      try {
        const res: ChatCompletionResponse = await provider.chatCompletion(apiKey, {
          model: nativeModelId,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
        });
        const hasChoice = Array.isArray(res.choices) && res.choices.length > 0;
        return {
          ok: hasChoice,
          method: 'chat_completion',
          modelId: candidate,
          detail: hasChoice ? null : 'provider responded but returned no completion choices',
          provenAt,
          failureKind: hasChoice ? 'none' : 'unknown',
        };
      } catch (err) {
        const kind = classifyProofFailure(err);
        // A model that doesn't exist upstream disproves NOTHING about the key.
        // Record it and try the next catalogued model rather than reporting a
        // phantom auth failure.
        if (kind === 'model_not_found') {
          staleModelIds.push(candidate);
          continue;
        }
        return {
          ok: false,
          method: 'chat_completion',
          modelId: candidate,
          detail: err instanceof Error ? err.message : String(err),
          provenAt,
          failureKind: kind,
        };
      }
    }
    // Either the catalog was empty, or every model we tried was missing
    // upstream. Both mean "no usable model to prove with" — fall through to
    // verifyKey, which is a real authenticated call that needs no model id.
  }

  if (provider.verifyKey) {
    let smoke: SmokeTestResult;
    try {
      smoke = await provider.verifyKey(apiKey);
    } catch (err) {
      return {
        ok: false,
        method: 'verify_key',
        modelId: null,
        detail: err instanceof Error ? err.message : String(err),
        provenAt,
        failureKind: classifyProofFailure(err),
      };
    }
    return {
      ok: smoke.ok,
      method: 'verify_key',
      modelId: null,
      detail: smoke.message ?? null,
      provenAt,
      failureKind: smoke.ok ? 'none' : 'auth',
    };
  }

  // No verifyKey to fall back on. Report WHY we couldn't prove anything — and
  // never let a stale catalog masquerade as a rejected key.
  if (staleModelIds.length > 0) {
    return {
      ok: false,
      method: 'unavailable',
      modelId: staleModelIds[0],
      detail:
        `auth NOT disproven: every catalogued model tried (${staleModelIds.join(', ')}) was rejected upstream as ` +
        `not-found, and this provider exposes no verifyKey() to prove the key without a model. ` +
        `The local model catalog is stale — refresh it, then prove again.`,
      provenAt,
      failureKind: 'model_not_found',
    };
  }

  return {
    ok: false,
    method: 'unavailable',
    modelId: null,
    detail: 'no authenticated-call method available',
    provenAt,
    failureKind: 'unknown',
  };
}

export interface GetOrProveOptions {
  /** Force a fresh call even if a fresh cache entry exists. */
  force?: boolean;
}

/**
 * The cache-aware entry point every caller should use. Returns a fresh cache
 * hit without any network call; otherwise performs one real authenticated
 * call and persists the result before returning it.
 */
export async function getOrProveProviderAuth(
  slug: string,
  apiKey: string,
  opts: GetOrProveOptions = {},
): Promise<AuthProofResult> {
  if (!opts.force) {
    const cached = getCachedAuthProof(slug);
    if (isProofFresh(cached)) {
      return {
        ok: cached!.ok === 1,
        method: cached!.method as AuthProofMethod,
        modelId: cached!.model_id,
        detail: cached!.detail,
        provenAt: cached!.proven_at,
        // Rows written before migration 106 have no failure_kind: report the
        // honest 'unknown' rather than inventing a cause.
        failureKind: (cached!.failure_kind as AuthProofFailureKind | null) ?? (cached!.ok === 1 ? 'none' : 'unknown'),
      };
    }
  }

  const provider = getProvider(slug);
  if (!provider) {
    return {
      ok: false,
      method: 'unavailable',
      modelId: null,
      detail: `unknown provider slug: ${slug}`,
      provenAt: new Date().toISOString(),
      failureKind: 'unknown',
    };
  }

  const result = await proveProviderAuth(provider, apiKey);
  upsertAuthProofCache(slug, result);
  return result;
}
