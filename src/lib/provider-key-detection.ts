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
 *        d. OpenClaw's SQLite AUTH-PROFILE STORE (see below) — the authoritative
 *           store the gateway itself resolves keys from at runtime.
 *      First hit wins; the matched env-var name and source are returned for
 *      observability / error messages.
 *   4. If no candidate is found in any store → returns a structured "not found"
 *      result so the caller can log the right error message.
 *
 * SOURCE (d) — THE OPENCLAW AUTH-PROFILE STORE (v5.16.2)
 * ------------------------------------------------------
 * OpenClaw does NOT necessarily keep a provider key in any env file or in
 * `openclaw.json` — for Ollama Cloud it keeps it in its SQLite auth store:
 *
 *   <openclaw-dir>/agents/<agent>/agent/openclaw-agent.sqlite
 *     table  auth_profile_store
 *     row    store_key = 'primary'
 *     json   store_json.profiles["ollama:default"]
 *              = { type: "api_key", provider: "ollama", key: "<secret>" }
 *
 * The gateway resolves the key from THAT store at runtime (the `openclaw.json`
 * profile block carries only mode/provider — no inline key) and sends it as
 * `Authorization: Bearer`. Command Center previously scanned only env stores and
 * `openclaw.json`, so it reported `configured=false` for a provider whose key
 * demonstrably exists and works — every box with a sovereign Ollama Cloud key
 * registered ZERO models. Reading this store is what makes CC agree with the
 * gateway. Combined with the corrected `https://ollama.com` base URL, it is what
 * actually heals Ollama Cloud on those boxes.
 *
 * INVARIANTS for this source (non-negotiable):
 *   • READ-ONLY. The store is opened `readonly` and is NEVER written or mutated —
 *     Command Center consumes OpenClaw's key, it does not own it.
 *   • The key VALUE is NEVER printed, logged, or embedded in any message. Only
 *     the provider name / source label is ever emitted.
 *   • The agent directory is NOT hardcoded to `main` — every `agents/<agent>/`
 *     is scanned, and the `primary` store_key is preferred.
 *   • Never throws: a missing file / missing table / bad JSON simply yields no key.
 *
 * This module is SERVER-ONLY (it imports `fs`, `better-sqlite3` and the
 * `candidateEnvFiles` helper). Do NOT import from client components.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
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
      /** Which store the key was found in (for logging). NEVER log `value`. */
      source: 'process.env' | 'env_file' | 'openclaw_json' | 'openclaw_auth_store';
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
 * The OpenClaw provider name(s) an auth-profile row may carry for a Command
 * Center provider slug. CC calls it `ollama-cloud`; OpenClaw stores it under
 * provider `ollama` (profile key `ollama:default`). Stripping a trailing
 * `-cloud` covers that generically without a hardcoded per-provider table.
 */
export function openclawProviderNamesFor(slug: string): string[] {
  const names: string[] = [];
  const add = (v: string) => {
    const t = v.trim().toLowerCase();
    if (t && !names.includes(t)) names.push(t);
  };
  add(slug);
  add(slug.replace(/-cloud$/, ''));
  return names;
}

/**
 * Every OpenClaw agent auth store on this box:
 *   <openclaw-dir>/agents/<agent>/agent/openclaw-agent.sqlite
 * The agent dir is NOT hardcoded to `main` — a box may name its agent anything.
 * Derived from openclawConfigPath() so it is correct on BOTH the Mac layout
 * (~/.openclaw) and the VPS Docker layout (/data/.openclaw). Sorted for
 * determinism. Never throws.
 */
export function openclawAuthStorePaths(): string[] {
  try {
    const openclawDir = path.dirname(openclawConfigPath());
    const agentsDir = path.join(openclawDir, 'agents');
    if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) return [];
    return fs
      .readdirSync(agentsDir)
      .sort()
      .map((agent) => path.join(agentsDir, agent, 'agent', 'openclaw-agent.sqlite'))
      .filter((p) => {
        try {
          return fs.existsSync(p) && fs.statSync(p).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** One `profiles` entry in an OpenClaw auth-profile store. */
interface OpenClawAuthProfile {
  type?: string;
  provider?: string;
  key?: string;
}

/**
 * Pull a provider's API key out of ONE OpenClaw auth store (read-only).
 *
 * Shape: table `auth_profile_store`, row `store_key='primary'`, column
 * `store_json` = `{ profiles: { "<provider>:<name>": { type, provider, key } } }`.
 * `profiles` is matched by its `provider` field AND by the `<provider>:` prefix
 * of its key, so a renamed profile still resolves. Tolerates an array-shaped
 * `profiles`. Falls back to scanning every row when there is no `primary`.
 *
 * NEVER logs the key. NEVER writes. Returns null on any error.
 */
function readKeyFromAuthStore(storePath: string, providerNames: string[]): string | null {
  let db: Database.Database | null = null;
  try {
    // READ-ONLY: Command Center consumes OpenClaw's key; it must never mutate it.
    db = new Database(storePath, { readonly: true, fileMustExist: true });

    let rows: { store_json: string }[] = [];
    try {
      rows = db
        .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'")
        .all() as { store_json: string }[];
      if (rows.length === 0) {
        rows = db.prepare('SELECT store_json FROM auth_profile_store').all() as { store_json: string }[];
      }
    } catch {
      return null; // no such table/column on this box — not an error, just no key here
    }

    for (const row of rows) {
      if (!row?.store_json) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.store_json);
      } catch {
        continue;
      }
      const profiles = (parsed as { profiles?: unknown } | null)?.profiles;
      if (!profiles || typeof profiles !== 'object') continue;

      const entries: [string, OpenClawAuthProfile][] = Array.isArray(profiles)
        ? (profiles as OpenClawAuthProfile[]).map((p, i) => [String(i), p])
        : Object.entries(profiles as Record<string, OpenClawAuthProfile>);

      for (const [profileKey, profile] of entries) {
        if (!profile || typeof profile !== 'object') continue;
        const key = typeof profile.key === 'string' ? profile.key.trim() : '';
        if (!key) continue;
        // An api_key profile (tolerate a missing/other type that still carries a key).
        if (profile.type && profile.type !== 'api_key') continue;

        const declared = (profile.provider ?? '').trim().toLowerCase();
        const prefix = profileKey.split(':')[0].trim().toLowerCase();
        if (providerNames.includes(declared) || providerNames.includes(prefix)) {
          return key; // value returned to the caller — never logged here
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Scan every OpenClaw auth store on the box for this provider's key.
 * Read-only, never logs the value, never throws.
 */
export function lookupKeyInOpenClawAuthStore(slug: string): string | null {
  const providerNames = openclawProviderNamesFor(slug);
  for (const storePath of openclawAuthStorePaths()) {
    const key = readKeyFromAuthStore(storePath, providerNames);
    if (key) return key;
  }
  return null;
}

/**
 * Resolve the API key for a provider by scanning ALL available key stores.
 *
 * Returns `{ localEndpoint: true }` for local_endpoint providers (no key
 * check needed). Returns `KeyDetectionResult` for all API-key providers.
 *
 * Never throws. File reads fail silently; only present and non-empty values
 * are returned. The resolved value is NEVER logged by this module.
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

  // 4. Check OpenClaw's SQLite auth-profile store — the store the GATEWAY itself
  //    resolves keys from at runtime. For Ollama Cloud the key lives ONLY here
  //    (never in an env file or openclaw.json), which is why CC previously
  //    reported configured=false for a key that demonstrably exists and works.
  //    Deliberately LAST so every env source still wins (no regression for boxes
  //    that do carry the key in env). Read-only; the value is never logged.
  const storeKey = lookupKeyInOpenClawAuthStore(provider.slug);
  if (storeKey) {
    // Hydrate the conventional env var so later readers in this process resolve
    // it without re-opening the store — mirrors the env_file / openclaw_json
    // branches above. (Value assigned, never printed.)
    const envVar = candidates[0] ?? defaultEnvVarForSlug(provider.slug);
    process.env[envVar] = storeKey;
    return { found: true, envVar, source: 'openclaw_auth_store', value: storeKey };
  }

  return { found: false, checked: candidates };
}
