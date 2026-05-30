/**
 * Research provider auto-discovery (v4.1.5).
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The Operator Console **Research** sub-module was hard-wired to a single
 * provider — xAI Grok Live Search — via `X_AI_API_KEY`. On any client box that
 * did not have an xAI key the module was dead: the nav tile said "Soon", the
 * page copy promised "xAI Grok", and a query 502'd with "X_AI_API_KEY is not
 * set". That made Research effectively un-shippable for most clients even
 * though they had a perfectly good search-capable key (OpenAI, Ollama Cloud,
 * Perplexity) sitting in their environment.
 *
 * THE FIX (this module)
 * ---------------------
 * A single, data-driven discovery surface — the Research analogue of
 * `src/lib/studio/provider-discovery.ts`. It auto-discovers which search
 * provider a box has a key for and selects ONE, in a fixed preference order:
 *
 *     PERPLEXITY  >  OPENAI  >  OLLAMA (cloud)  >  XAI
 *
 * Rationale for the order: Perplexity is a purpose-built grounded-search API
 * (best citations); OpenAI's Responses `web_search` tool is a strong generalist
 * second; Ollama Cloud's hosted web-search is the operator's daily driver and a
 * good no-extra-cost third; xAI Grok Live Search is the original and stays as
 * the final fallback so existing xAI boxes keep working unchanged.
 *
 * Env hydration is DELEGATED to the Studio discovery module's
 * `hydrateProviderEnvFromOpenClaw()` so there is exactly one OpenClaw secret
 * reader in the codebase (host `/docker/<proj>/.env`, `~/.openclaw/.env`,
 * `~/.openclaw/secrets/.env`, `openclaw.json` env/env.vars). We extend the set
 * of env vars it knows about by registering the Research search keys through
 * the same `parseDotEnv`/`extractOpenclawEnv` primitives — see
 * `hydrateResearchEnv()` below.
 *
 * We NEVER fabricate a key: a provider is only "available" when one of its
 * candidate env vars is actually present in the (hydrated) environment.
 *
 * This module is SERVER-ONLY (it transitively imports `fs`/`os`/`path` through
 * the Studio hydrator). Import it only from server code (the search route, the
 * availability probe), never from a `'use client'` component.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { openclawConfigPath } from '@/lib/platform';
import { parseDotEnv, extractOpenclawEnv } from '@/lib/studio/provider-discovery';

/** The Research search providers, highest preference first. */
export type ResearchProviderSlug = 'perplexity' | 'openai' | 'ollama' | 'xai';

/** One Research provider's discovery rule. */
export interface ResearchProviderEntry {
  slug: ResearchProviderSlug;
  displayName: string;
  /**
   * Candidate env-var names, checked in order; the FIRST present env var wins
   * and is recorded as the resolved `apiKeyEnv`. A provider is available ONLY
   * when one of these is present in `process.env`.
   */
  envCandidates: string[];
  /** Default model id used when the registry has no explicit row. */
  defaultModel: string;
  /** One-line description of how this provider is called (for the report/UI). */
  callSummary: string;
}

/**
 * THE PROVIDER PREFERENCE LIST — order IS the preference (index 0 wins).
 *
 *     PERPLEXITY  >  OPENAI  >  OLLAMA (cloud)  >  XAI
 *
 * Add a new search provider by inserting an entry at the right precedence.
 * Env-var names match the connector/env contract already used elsewhere in the
 * repo: OpenAI → OPENAI_API_KEY (env.example), Ollama Cloud → OLLAMA_CLOUD_API_KEY
 * (env.example) with the probe's OLLAMA_API_KEY accepted as an alias, xAI →
 * X_AI_API_KEY (env.example). PERPLEXITY_API_KEY is the canonical Perplexity
 * env-var name (per docs.perplexity.ai); PPLX_API_KEY is accepted as an alias.
 */
export const RESEARCH_PROVIDERS: ResearchProviderEntry[] = [
  {
    slug: 'perplexity',
    displayName: 'Perplexity',
    envCandidates: ['PERPLEXITY_API_KEY', 'PPLX_API_KEY'],
    defaultModel: 'sonar-pro',
    callSummary:
      'POST https://api.perplexity.ai/chat/completions (OpenAI-compatible). Online "sonar" models search the live web; citations returned in the `citations` array.',
  },
  {
    slug: 'openai',
    displayName: 'OpenAI',
    // Only the OpenAI API key is a search provider here. A Codex/ChatGPT OAuth
    // session is NOT an API key — do not treat an OAuth login as one.
    envCandidates: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-4o-search-preview',
    callSummary:
      'POST https://api.openai.com/v1/chat/completions with the web-search-capable model. Inline source URLs come back in `message.annotations[].url_citation`.',
  },
  {
    slug: 'ollama',
    displayName: 'Ollama Cloud',
    // env.example documents OLLAMA_CLOUD_API_KEY; the System Status probe uses
    // OLLAMA_API_KEY. Accept both so the row appears no matter which the box set.
    envCandidates: ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'],
    defaultModel: 'gpt-oss:120b',
    callSummary:
      'POST https://ollama.com/api/v1/chat/completions (OpenAI-compatible) with the hosted web_search tool enabled. Tool-call results carry the source URLs.',
  },
  {
    slug: 'xai',
    displayName: 'xAI Grok',
    envCandidates: ['X_AI_API_KEY', 'XAI_API_KEY'],
    defaultModel: 'grok-4-fast',
    callSummary:
      'POST https://api.x.ai/v1/chat/completions with `search_parameters.mode=on` (Live Search over X + the web). Sources returned in `citations`.',
  },
];

/** All env-var names any Research provider cares about (deduped). */
function allResearchEnvVars(): string[] {
  const set = new Set<string>();
  for (const p of RESEARCH_PROVIDERS) for (const e of p.envCandidates) set.add(e);
  return Array.from(set);
}

// ---------------------------------------------------------------------------
// Env hydration. Reuses the Studio module's parse primitives so there is one
// OpenClaw secret-reader contract, but applied to the Research key set.
// ---------------------------------------------------------------------------

function safeReadFile(p: string): string | null {
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Candidate OpenClaw secret-file locations to probe for Research keys NOT
 * already in `process.env`. Identical precedence to the Studio hydrator
 * (first hit wins per key): an explicit `OPENCLAW_PROJECT_DIR` host `.env`
 * first, then the Mac `~/.openclaw` files.
 */
export function candidateEnvFiles(): string[] {
  const files: string[] = [];
  const projectDir = process.env.OPENCLAW_PROJECT_DIR;
  if (projectDir) files.push(path.join(projectDir, '.env'));
  const home = os.homedir();
  files.push(path.join(home, '.openclaw', '.env'));
  files.push(path.join(home, '.openclaw', 'secrets', '.env'));
  return files;
}

/**
 * Best-effort hydrate `process.env` with any Research provider keys discovered
 * in the OpenClaw secret files. NEVER overwrites a value already set in
 * `process.env` (the container/host env is authoritative). NEVER throws.
 *
 * Returns the list of env-var names newly hydrated from a file, for
 * logging/observability. Idempotent.
 */
export function hydrateResearchEnv(): string[] {
  const wanted = allResearchEnvVars();
  const hydrated: string[] = [];

  const missing = () => wanted.filter((k) => !process.env[k]);
  if (missing().length === 0) return hydrated;

  // 1) .env-style files, in precedence order.
  for (const file of candidateEnvFiles()) {
    if (missing().length === 0) break;
    const content = safeReadFile(file);
    if (!content) continue;
    const parsed = parseDotEnv(content);
    for (const key of missing()) {
      if (parsed[key]) {
        process.env[key] = parsed[key];
        hydrated.push(key);
      }
    }
  }

  // 2) openclaw.json env / env.vars.
  if (missing().length > 0) {
    const content = safeReadFile(openclawConfigPath());
    if (content) {
      let json: unknown = null;
      try {
        json = JSON.parse(content);
      } catch {
        json = null;
      }
      const envVars = extractOpenclawEnv(json);
      for (const key of missing()) {
        if (envVars[key]) {
          process.env[key] = envVars[key];
          hydrated.push(key);
        }
      }
    }
  }

  return hydrated;
}

// ---------------------------------------------------------------------------
// Provider selection.
// ---------------------------------------------------------------------------

/**
 * The first present env-var name for a provider entry, or null if none are set.
 * Reads `process.env` only — call `hydrateResearchEnv()` first if you want
 * file-sourced keys considered.
 */
export function resolveApiKeyEnv(entry: ResearchProviderEntry): string | null {
  for (const candidate of entry.envCandidates) {
    if (process.env[candidate]) return candidate;
  }
  return null;
}

/** The selected provider plus the env var its key was resolved from. */
export interface SelectedResearchProvider {
  entry: ResearchProviderEntry;
  apiKeyEnv: string;
}

/**
 * Pick the highest-preference Research provider whose key is present in the
 * (already-hydrated) environment, in the order PERPLEXITY > OPENAI > OLLAMA >
 * XAI. Returns null when NO provider has a key — the caller renders the honest
 * empty-state rather than failing.
 *
 * Pass `hydrate: false` to skip file-hydration (the caller already ran it).
 * Default hydrates so a single call "just works".
 */
export function selectResearchProvider(opts: { hydrate?: boolean } = {}): SelectedResearchProvider | null {
  if (opts.hydrate !== false) {
    try {
      hydrateResearchEnv();
    } catch {
      // never let discovery crash a render
    }
  }
  for (const entry of RESEARCH_PROVIDERS) {
    const apiKeyEnv = resolveApiKeyEnv(entry);
    if (apiKeyEnv) return { entry, apiKeyEnv };
  }
  return null;
}

/**
 * Diagnostic: which Research providers are currently available given the
 * present environment, and which one would be selected. Backs the availability
 * probe the UI calls so it can show "live" vs the honest empty-state, and is
 * used by the unit tests.
 */
export interface ResearchAvailability {
  available: boolean;
  selected: ResearchProviderSlug | null;
  selectedDisplayName: string | null;
  providers: Array<{
    slug: ResearchProviderSlug;
    displayName: string;
    apiKeyEnv: string | null;
    present: boolean;
    defaultModel: string;
    callSummary: string;
  }>;
  /** Every env var that, if set, would enable Research (for the empty-state hint). */
  enableHintEnvVars: string[];
}

export function researchAvailability(opts: { hydrate?: boolean } = {}): ResearchAvailability {
  if (opts.hydrate !== false) {
    try {
      hydrateResearchEnv();
    } catch {
      /* ignore */
    }
  }
  const providers = RESEARCH_PROVIDERS.map((entry) => {
    const apiKeyEnv = resolveApiKeyEnv(entry);
    return {
      slug: entry.slug,
      displayName: entry.displayName,
      apiKeyEnv,
      present: Boolean(apiKeyEnv),
      defaultModel: entry.defaultModel,
      callSummary: entry.callSummary,
    };
  });
  const selected = providers.find((p) => p.present) || null;
  return {
    available: Boolean(selected),
    selected: selected ? selected.slug : null,
    selectedDisplayName: selected ? selected.displayName : null,
    providers,
    // First-listed env var per provider — the canonical name to suggest.
    enableHintEnvVars: RESEARCH_PROVIDERS.map((p) => p.envCandidates[0]),
  };
}
