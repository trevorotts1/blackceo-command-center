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

export interface AuthProofResult {
  ok: boolean;
  method: AuthProofMethod;
  modelId: string | null;
  detail: string | null;
  provenAt: string;
}

export interface AuthProofCacheRow {
  provider_slug: string;
  proven_at: string;
  ok: number;
  method: string;
  model_id: string | null;
  detail: string | null;
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
    `INSERT INTO provider_auth_proof_cache (provider_slug, proven_at, ok, method, model_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_slug) DO UPDATE SET
       proven_at = excluded.proven_at,
       ok = excluded.ok,
       method = excluded.method,
       model_id = excluded.model_id,
       detail = excluded.detail`,
    [slug, result.provenAt, result.ok ? 1 : 0, result.method, result.modelId, result.detail],
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

  if (provider.chatCompletion) {
    // Need a real native model id for this provider to attempt a completion.
    // Prefer whatever is already in this box's own active catalog for the
    // provider (never inventing a model id).
    const inventory = listModels({ provider: provider.slug });
    const candidate = inventory[0]?.model_id;
    const nativeModelId = candidate ? candidate.slice(candidate.indexOf('/') + 1) : null;

    if (nativeModelId) {
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
          modelId: candidate ?? null,
          detail: hasChoice ? null : 'provider responded but returned no completion choices',
          provenAt,
        };
      } catch (err) {
        return {
          ok: false,
          method: 'chat_completion',
          modelId: candidate ?? null,
          detail: err instanceof Error ? err.message : String(err),
          provenAt,
        };
      }
    }
    // No catalog entry to attempt a completion against — fall through to verifyKey.
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
      };
    }
    return {
      ok: smoke.ok,
      method: 'verify_key',
      modelId: null,
      detail: smoke.message ?? null,
      provenAt,
    };
  }

  return { ok: false, method: 'unavailable', modelId: null, detail: 'no authenticated-call method available', provenAt };
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
      };
    }
  }

  const provider = getProvider(slug);
  if (!provider) {
    return { ok: false, method: 'unavailable', modelId: null, detail: `unknown provider slug: ${slug}`, provenAt: new Date().toISOString() };
  }

  const result = await proveProviderAuth(provider, apiKey);
  upsertAuthProofCache(slug, result);
  return result;
}
