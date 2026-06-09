/**
 * Provider API key detection helper.
 *
 * THE PROBLEM
 * -----------
 * The refresh job's original `apiKeyFor(slug)` function derived exactly one
 * candidate env-var name (`<SLUG>_API_KEY`, uppercase + hyphens→underscores)
 * and read it exclusively from `process.env`. This caused two classes of bug:
 *
 *   1. **Phantom "key not set"** — providers whose keys exist under a *different*
 *      name than the derived convention (e.g. OLLAMA_API_KEY for ollama-cloud,
 *      FAL_KEY for fal, REPLICATE_API_TOKEN for replicate, GEMINI_API_KEY for
 *      google) were always reported as unconfigured even when the key was present.
 *
 *   2. **Multi-store blindness** — the CC process env may not include every key;
 *      keys can live in .env files that OpenClaw loads on the client box. The
 *      studio provider-discovery module already handles this correctly with
 *      `hydrateProviderEnvFromOpenClaw()` and `candidateEnvFiles()`. The refresh
 *      job was not using any of that.
 *
 * THE FIX (this module)
 * ---------------------
 * `resolveProviderApiKey(provider)` — the single function the refresh job now
 * calls. It:
 *
 *   1. Returns null immediately for `local_endpoint` providers (no key needed).
 *   2. Builds a deduped candidate list from:
 *        a. `provider.envCandidates` (connector-declared list — see types.ts)
 *        b. Fallback: the derived `<SLUG>_API_KEY` convention
 *   3. Checks each candidate against ALL env stores in priority order:
 *        a. `process.env`  (already aggregates the container/host env)
 *        b. Each `.env` file returned by `candidateEnvFiles()` (OpenClaw secret
 *           files on the box: host project .env, ~/.openclaw/.env, etc.)
 *        c. `openclaw.json` `env` / `env.vars` + `models.providers[slug].apiKey`
 *      First hit wins; the matched env-var name and source are returned for
 *      observability / error messages.
 *   4. If no candidate is found in any store → returns a structured "not found"
 *      result so the caller can log the right error message.
 *
 * This module is SERVER-ONLY (it imports `fs` and the `candidateEnvFiles`
 * helper). Do NOT import from client components.
 */

import fs from 'fs';
import {
  candidateEnvFiles,
  parseDotEnv,
  extractOpenclawEnv,
  extractOpenclawProviderKeys,
} from './studio/provider-discovery';
import { openclawConfigPath } from './platform';
import type { ModelProvider } from './model-providers/types';

/** Outcome of a key detection attempt. */
export type KeyDetectionResult =
  | {
      found: true;
      /** The env-var name the key was found under. */
      envVar: string;
      /** Which store the key was found in (for logging). */
      source: 'process.env' | 'env_file' | 'openclaw_json';
      /** The resolved key value. */
      value: string;
    }
  | {
      found: false;
      /** All candidate env-var names that were checked and found absent. */
      checked: string[];
    };

/** Outcome for a local-endpoint provider (auth_type = 'local_endpoint'). */
export interface LocalEndpointResult {
  localEndpoint: true;
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
 * Derive the conventional `<SLUG>_API_KEY` fallback for a provider slug,
 * matching the original `apiKeyFor()` logic.
 */
export function defaultEnvVarForSlug(slug: string): string {
  return slug.toUpperCase().replace(/-/g, '_') + '_API_KEY';
}

/**
 * Build the ordered list of env-var names to check for a provider.
 *
 * Uses the provider's own `envCandidates` list when present; falls back to
 * the conventional `<SLUG>_API_KEY` derivation. Deduplicates while preserving
 * order so connector-declared names take priority.
 */
export function envCandidatesForProvider(provider: ModelProvider): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (v: string) => {
    if (!seen.has(v)) { seen.add(v); candidates.push(v); }
  };

  if (provider.envCandidates && provider.envCandidates.length > 0) {
    for (const c of provider.envCandidates) add(c);
  }
  // Always include the conventional fallback — even when envCandidates is set —
  // so an operator who renamed the var to the conventional form is covered.
  add(defaultEnvVarForSlug(provider.slug));

  return candidates;
}

/**
 * Resolve the API key for a provider by scanning ALL available env stores.
 *
 * Returns `{ localEndpoint: true }` for local_endpoint providers (no key
 * check needed). Returns `KeyDetectionResult` for all API-key providers.
 *
 * Never throws. File reads fail silently; only present and non-empty values
 * are returned.
 */
export function resolveProviderApiKey(
  provider: ModelProvider
): KeyDetectionResult | LocalEndpointResult {
  // Local-endpoint providers authenticate via a daemon, not an API key.
  // Skip all key checks; the caller should call fetchModels('') directly
  // (or do its own reachability probe).
  if (provider.authType === 'local_endpoint') {
    return { localEndpoint: true };
  }

  const candidates = envCandidatesForProvider(provider);

  // 1. Check process.env (covers host/container env already aggregated from
  //    the Docker compose env_file, launchd plist, etc.).
  for (const candidate of candidates) {
    const value = process.env[candidate];
    if (value && value.trim()) {
      return { found: true, envVar: candidate, source: 'process.env', value: value.trim() };
    }
  }

  // 2. Check .env-style files (OpenClaw secret stores on the box).
  for (const file of candidateEnvFiles()) {
    const content = safeReadFile(file);
    if (!content) continue;
    const parsed = parseDotEnv(content);
    for (const candidate of candidates) {
      const value = parsed[candidate];
      if (value && value.trim()) {
        // Hydrate into process.env so subsequent calls in the same request
        // (e.g. the same provider called again) don't re-read the file.
        process.env[candidate] = value.trim();
        return { found: true, envVar: candidate, source: 'env_file', value: value.trim() };
      }
    }
  }

  // 3. Check openclaw.json: env / env.vars block AND models.providers[slug].apiKey.
  const cfgContent = safeReadFile(openclawConfigPath());
  if (cfgContent) {
    let json: unknown = null;
    try { json = JSON.parse(cfgContent); } catch { /* ignore */ }
    if (json) {
      // Merge env.vars first, then per-provider apiKey entries (latter takes
      // precedence since it's the most specific store).
      const fromEnv = extractOpenclawEnv(json);
      const fromProviders = extractOpenclawProviderKeys(json);
      const merged = { ...fromEnv, ...fromProviders };
      for (const candidate of candidates) {
        const value = merged[candidate];
        if (value && value.trim()) {
          process.env[candidate] = value.trim();
          return { found: true, envVar: candidate, source: 'openclaw_json', value: value.trim() };
        }
      }
    }
  }

  return { found: false, checked: candidates };
}
