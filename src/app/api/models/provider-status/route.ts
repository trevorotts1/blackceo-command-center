/**
 * GET /api/models/provider-status
 *
 * Returns the key-detection status for every AI model provider AND every
 * registered integration (e.g. Notion), scanning ALL available env stores —
 * not just process.env. This powers the "Provider catalog" panel on the
 * Intelligence Settings page so it correctly reports providers/integrations
 * the client HAS as configured, even when the key lives in a secondary env
 * store (OpenClaw .env, openclaw.json env.vars, etc.).
 *
 * Response shape:
 * {
 *   providers: ProviderStatusEntry[],
 *   integrations: IntegrationStatusEntry[],
 *   generated_at: string,
 * }
 */

import { NextResponse } from 'next/server';
import { ALL_PROVIDERS } from '@/lib/model-providers';
import { envCandidatesForProvider, lookupKeyInOpenClawAuthStore } from '@/lib/provider-key-detection';
import { INTEGRATION_CATALOG } from '@/lib/integration-catalog';
import {
  candidateEnvFiles,
  parseDotEnv,
  extractOpenclawEnv,
  extractOpenclawProviderKeys,
} from '@/lib/studio/provider-discovery';
import { openclawConfigPath } from '@/lib/platform';
import { getCachedAuthProof, isProofFresh } from '@/lib/provider-auth-proof';
import fs from 'fs';

export const dynamic = 'force-dynamic';

/**
 * P2-04 (c) step 3 — the honest, three-state auth-proof summary for a tile.
 * This is a READ-ONLY reflection of `provider_auth_proof_cache` — it NEVER
 * makes a live network call (that only happens from POST
 * /api/models/provider-status/prove or the weekly cron). `proven` is true
 * ONLY when a cached authenticated call succeeded within the last 24h; it is
 * deliberately never derived from `configured` or from the refresh log's
 * fetchModels() success — see provider-auth-proof.ts for why a listed catalog
 * is not proof of auth (the mirage).
 */
export interface AuthProofSummary {
  /** True only when a cached authenticated call succeeded within the TTL. */
  proven: boolean;
  /** True when a proof attempt (success or failure) exists but is stale. */
  stale: boolean;
  method: string | null;
  provenAt: string | null;
}

export interface ProviderStatusEntry {
  slug: string;
  displayName: string;
  /** 'api_key' | 'local_endpoint' | 'oauth' */
  authType: string;
  /** true when the provider is configured (key found in any store, or local_endpoint). */
  configured: boolean;
  /** The env-var name the key was found under. null for local_endpoint or not found. */
  foundEnvVar: string | null;
  /** Where the key was found. null when not found or local_endpoint. */
  foundInStore: 'process.env' | 'env_file' | 'openclaw_json' | 'openclaw_auth_store' | null;
  /** For local_endpoint providers: the base URL being used. */
  localEndpointUrl?: string;
  /** All candidate env-var names checked (for tooltip). */
  envCandidates: string[];
  /** Cache-only auth-proof summary. null for local_endpoint (no key to prove). */
  authProof: AuthProofSummary | null;
}

export interface IntegrationStatusEntry {
  slug: string;
  displayName: string;
  section: string;
  description: string;
  configured: boolean;
  foundEnvVar: string | null;
  foundInStore: 'process.env' | 'env_file' | 'openclaw_json' | 'openclaw_auth_store' | null;
  envCandidates: string[];
}

function safeReadFile(p: string): string | null {
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Detect whether any of `candidates` is present in any key store.
 * Returns the found env-var name and the source; or null if absent.
 *
 * `providerSlug` (model providers only) additionally enables source (4): OpenClaw's
 * SQLite auth-profile store — the store the GATEWAY resolves keys from at runtime.
 * For Ollama Cloud the key lives ONLY there, so without it this endpoint reported
 * `configured=false` for a key that demonstrably exists and works. Integrations
 * (Notion, etc.) pass no slug and are unaffected.
 *
 * NEVER returns or logs the key VALUE — only the env-var name and the source label.
 */
function detectKey(candidates: readonly string[], providerSlug?: string): {
  envVar: string;
  source: 'process.env' | 'env_file' | 'openclaw_json' | 'openclaw_auth_store';
} | null {
  // 1. process.env
  for (const c of candidates) {
    if (process.env[c]?.trim()) return { envVar: c, source: 'process.env' };
  }

  // 2. .env files
  for (const file of candidateEnvFiles()) {
    const content = safeReadFile(file);
    if (!content) continue;
    const parsed = parseDotEnv(content);
    for (const c of candidates) {
      if (parsed[c]?.trim()) {
        process.env[c] = parsed[c].trim(); // hydrate for future calls
        return { envVar: c, source: 'env_file' };
      }
    }
  }

  // 3. openclaw.json
  const cfgContent = safeReadFile(openclawConfigPath());
  if (cfgContent) {
    let json: unknown = null;
    try { json = JSON.parse(cfgContent); } catch { /* ignore */ }
    if (json) {
      const merged = { ...extractOpenclawEnv(json), ...extractOpenclawProviderKeys(json) };
      for (const c of candidates) {
        if (merged[c]?.trim()) {
          process.env[c] = merged[c].trim();
          return { envVar: c, source: 'openclaw_json' };
        }
      }
    }
  }

  // 4. OpenClaw's SQLite auth-profile store (model providers only). Deliberately
  //    LAST so every env source still wins — no regression for boxes that carry
  //    the key in env. Read-only; the value is hydrated but NEVER logged.
  if (providerSlug) {
    const storeKey = lookupKeyInOpenClawAuthStore(providerSlug);
    if (storeKey) {
      const envVar = candidates[0];
      if (envVar) process.env[envVar] = storeKey;
      return { envVar: envVar ?? providerSlug, source: 'openclaw_auth_store' };
    }
  }

  return null;
}

export async function GET() {
  try {
    // --- AI model providers ---
    const providers: ProviderStatusEntry[] = ALL_PROVIDERS.map((p) => {
      const authType = p.authType ?? 'api_key';
      if (authType === 'local_endpoint') {
        // Local endpoint: always "configured" (no key needed). Surface the
        // endpoint URL so the operator can see what it's pointed at.
        const localUrl =
          process.env.OLLAMA_LOCAL_HOST ||
          (p.slug === 'ollama-local' ? 'http://localhost:11434' : undefined);
        return {
          slug: p.slug,
          displayName: p.displayName,
          authType,
          configured: true,
          foundEnvVar: null,
          foundInStore: null,
          localEndpointUrl: localUrl,
          envCandidates: [],
          authProof: null, // local_endpoint has no key to prove
        };
      }

      const candidates = envCandidatesForProvider(p);
      // Pass the slug so source (4) — OpenClaw's SQLite auth store — is consulted.
      const found = detectKey(candidates, p.slug);

      // Cache-only read (no network call) — see AuthProofSummary docstring.
      const cachedProof = getCachedAuthProof(p.slug);
      const fresh = isProofFresh(cachedProof);
      const authProof: AuthProofSummary = {
        proven: fresh && cachedProof!.ok === 1,
        stale: cachedProof !== null && !fresh,
        method: cachedProof?.method ?? null,
        provenAt: cachedProof?.proven_at ?? null,
      };

      return {
        slug: p.slug,
        displayName: p.displayName,
        authType,
        configured: found !== null,
        foundEnvVar: found?.envVar ?? null,
        foundInStore: found?.source ?? null,
        envCandidates: candidates,
        authProof,
      };
    });

    // --- Integrations (Notion, etc.) ---
    const integrations: IntegrationStatusEntry[] = INTEGRATION_CATALOG.map((entry) => {
      const found = detectKey(entry.envCandidates);
      return {
        slug: entry.slug,
        displayName: entry.displayName,
        section: entry.section,
        description: entry.description,
        configured: found !== null,
        foundEnvVar: found?.envVar ?? null,
        foundInStore: found?.source ?? null,
        envCandidates: Array.from(entry.envCandidates),
      };
    });

    return NextResponse.json({
      providers,
      integrations,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/models/provider-status] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load provider status', message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
