/**
 * sop-research.ts — the ONE web search the SOP authoring paths make.
 *
 * WHY THIS EXISTS
 * ---------------
 * `sop-authoring.ts` and `sop-auto-replace.ts` both called `tavilySearch()`
 * directly and documented it as a "Tier-1 mandate", which made Tavily a hard
 * requirement for authoring a SOP at all: a box with no Tavily key threw, and
 * (before v7.6.28) left its "Author SOP" card parked in_progress. Meanwhile
 * `src/lib/research/` already had a provider layer — discovery by whichever
 * key resolves, plus adapters for Perplexity, OpenAI, Ollama Cloud and xAI —
 * that these two callers never used.
 *
 * Operator decision: Tavily is never REQUIRED anywhere. It stays a provider,
 * behind this layer, and no longer the only one.
 *
 * PREFERENCE ORDER (operator-set):
 *
 *   perplexity → ollama-cloud → brave → exa → serper → serpapi → tavily → marginalia
 *
 * overridable per box with `RESEARCH_PROVIDER_ORDER` (comma-separated slugs).
 * Perplexity leads because it is purpose-built grounded search; Ollama Cloud is
 * second because it is the operator's subscription and costs nothing per call;
 * then whatever search product the box actually has. Detection is automatic —
 * a provider is used ONLY when its key resolves on that box, and skipped
 * silently otherwise.
 *
 * MARGINALIA is the final rung and needs NO key, so the chain always ends
 * somewhere rather than in the no-research path. Its results are CC-BY-NC-SA
 * 4.0, so a SOP it served carries `MARGINALIA_ATTRIBUTION`. Disable it with
 * `RESEARCH_ALLOW_MARGINALIA=0`.
 *
 * NO PROVIDER IS NOT A FAILURE. When no key resolves this returns an empty
 * result with `provider: null` and logs ONE warning. The callers synthesize
 * without web sources and say so in the SOP's Research Sources section, which
 * is honest and still useful. An unexpected THROW from a provider is a
 * different thing and still propagates — v7.6.28 made that block the card
 * visibly, and it must keep doing so.
 */

import {
  hydrateResearchEnv,
  providerAvailable,
  RESEARCH_PROVIDERS,
  resolveApiKeyEnv,
} from '@/lib/research/provider-discovery';
import { MARGINALIA_ATTRIBUTION, runResearch } from '@/lib/research/providers';
import { resolveResearchModel } from '@/lib/research/model-resolver';
import { resolveTavilyApiKey, tavilySearch } from '@/lib/tavily';

/** One web source, in the shape both SOP callers consume. */
export interface ResearchResultItem {
  title: string;
  url: string;
  /** Extract used for prompt grounding; may be absent for citation-only providers. */
  snippet?: string;
}

export interface SopResearchResult {
  results: ResearchResultItem[];
  answer?: string;
  /**
   * Which provider answered, or NULL when no provider had a key on this box.
   * `null` is the signal to author without web sources — never an error.
   */
  provider: string | null;
}

/** The line a SOP carries instead of sources when no provider was available. */
export const NO_RESEARCH_SOURCE_LINE = 'Research: none available on this box';

/** Re-exported so SOP callers attribute Marginalia without importing providers.ts. */
export { MARGINALIA_ATTRIBUTION };

/** The attribution line a SOP must carry for this provider, if any. */
export function researchAttribution(provider: string | null): string | null {
  return provider === 'marginalia' ? MARGINALIA_ATTRIBUTION : null;
}

const DEFAULT_ORDER = [
  'perplexity', 'ollama-cloud', 'brave', 'exa', 'serper', 'serpapi', 'tavily', 'marginalia',
];

/**
 * Operator-facing spellings that are not the internal slug. `ollama-cloud` is
 * what the product is called; `ollama` is what the adapter table keys on.
 */
const SLUG_ALIASES: Record<string, string> = {
  'ollama-cloud': 'ollama',
  ollamacloud: 'ollama',
  pplx: 'perplexity',
  'serp-api': 'serpapi',
  'brave-search': 'brave',
};

function canonicalSlug(slug: string): string {
  return SLUG_ALIASES[slug] || slug;
}

/**
 * The `*_FIXTURE_JSON_PATH` var that stands in for each provider's key.
 *
 * A fixture makes a provider answerable WITHOUT a key — that is the whole
 * point of the stub-during-tests policy, and `tavilySearch()` has always
 * short-circuited on its fixture BEFORE looking at the key. Selection has to
 * agree, or a fixture-driven test would be skipped here for "no key" and never
 * reach the stub it installed. `assertNoFixtureEnvInProduction()` (inside each
 * adapter) is what keeps this from being a production hole.
 */
const FIXTURE_ENV: Record<string, string> = {
  ollama: 'OLLAMA_FIXTURE_JSON_PATH',
  perplexity: 'PERPLEXITY_FIXTURE_JSON_PATH',
  openai: 'OPENAI_FIXTURE_JSON_PATH',
  xai: 'XAI_FIXTURE_JSON_PATH',
  tavily: 'TAVILY_FIXTURE_JSON_PATH',
  brave: 'BRAVE_FIXTURE_JSON_PATH',
  exa: 'EXA_FIXTURE_JSON_PATH',
  serper: 'SERPER_FIXTURE_JSON_PATH',
  serpapi: 'SERPAPI_FIXTURE_JSON_PATH',
  marginalia: 'MARGINALIA_FIXTURE_JSON_PATH',
};

function hasFixture(slug: string): boolean {
  const envVar = FIXTURE_ENV[slug];
  return Boolean(envVar && process.env[envVar]);
}

/**
 * Preference order for this box, in CANONICAL slugs: `RESEARCH_PROVIDER_ORDER`
 * when set, else the operator default. Both paths go through `canonicalSlug`,
 * because DEFAULT_ORDER is written in operator spelling (`ollama-cloud`) and
 * the adapter table keys on the internal slug (`ollama`) — returning the
 * operator spelling raw would silently skip that provider.
 */
export function researchProviderOrder(): string[] {
  const raw = (process.env.RESEARCH_PROVIDER_ORDER || '').trim();
  const parsed = raw
    ? raw.split(',').map((s) => canonicalSlug(s.trim().toLowerCase())).filter(Boolean)
    : [];
  const order = parsed.length > 0 ? parsed : DEFAULT_ORDER.map(canonicalSlug);
  return process.env.RESEARCH_ALLOW_MARGINALIA === '0'
    ? order.filter((s) => s !== 'marginalia')
    : order;
}

/**
 * Run the single SOP research query through the first provider in the
 * preference order that has a key on this box.
 *
 * Throws only on a provider ERROR (a reachable provider that refused or
 * failed). "No provider configured" returns `provider: null` instead.
 */
export async function researchForSop(
  query: string,
  opts: { maxResults?: number } = {},
): Promise<SopResearchResult> {
  const maxResults = opts.maxResults ?? 5;

  // Fill process.env from the OpenClaw secret stores first, so a key that
  // lives only in ~/.openclaw/secrets/.env counts as present (v7.6.28).
  try {
    hydrateResearchEnv();
  } catch {
    /* discovery must never throw into authoring */
  }

  // TWO PASSES, and the order matters. A `*_FIXTURE_JSON_PATH` is an explicit
  // instruction not to call out, so a fixture-backed provider outranks one that
  // merely has a key — otherwise a box with a real key would make a LIVE, billed
  // call while a test sat there holding the stub it installed. (That is exactly
  // what happened: the fast-loop test installs a Tavily fixture, this box has an
  // Ollama key, and the first cut of this function called Ollama for real.)
  const order = researchProviderOrder();
  for (const pass of ['fixture', 'key'] as const) {
    for (const slug of order) {
      if (pass === 'fixture' && !hasFixture(slug)) continue;

      if (slug === 'tavily') {
        if (pass === 'key' && !resolveTavilyApiKey()) continue;
        const tavily = await tavilySearch(query, { max_results: maxResults });
        console.log('[sop-research] provider: Tavily');
        return {
          provider: 'tavily',
          answer: tavily.answer,
          results: (tavily.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
        };
      }

      const entry = RESEARCH_PROVIDERS.find((p) => p.slug === slug);
      if (!entry) continue;
      const apiKeyEnv = resolveApiKeyEnv(entry);
      if (pass === 'key' && !providerAvailable(entry)) continue;

      const result = await runResearch(entry.slug, {
        query,
        depth: 'shallow',
        model: resolveResearchModel(entry.slug, entry.defaultModel),
        apiKey: apiKeyEnv ? (process.env[apiKeyEnv] as string) : '',
      });
      console.log(`[sop-research] provider: ${entry.displayName}`);
      return {
        provider: entry.slug,
        answer: result.answer,
        // These providers return citations, not extracts. The answer carries the
        // substance and is handed to synthesis separately.
        results: (result.citations || []).slice(0, maxResults).map((c) => ({
          title: c.title || c.url,
          url: c.url,
          snippet: c.snippet,
        })),
      };
    }
  }

  console.warn(
    `[sop-research] No research provider configured on this box (tried: ${order.join(' → ')}). ` +
      'Authoring will proceed WITHOUT web sources. Set one of OLLAMA_CLOUD_API_KEY, PERPLEXITY_API_KEY or TAVILY_API_KEY to enable research.',
  );
  return { provider: null, results: [] };
}
