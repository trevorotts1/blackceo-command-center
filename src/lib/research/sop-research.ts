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
 * PREFERENCE ORDER: ollama → perplexity → tavily, overridable per box with
 * `RESEARCH_PROVIDER_ORDER` (comma-separated slugs). Ollama Cloud leads
 * because it is the operator's subscription and costs nothing per call.
 *
 * NO PROVIDER IS NOT A FAILURE. When no key resolves this returns an empty
 * result with `provider: null` and logs ONE warning. The callers synthesize
 * without web sources and say so in the SOP's Research Sources section, which
 * is honest and still useful. An unexpected THROW from a provider is a
 * different thing and still propagates — v7.6.28 made that block the card
 * visibly, and it must keep doing so.
 */

import { hydrateResearchEnv, RESEARCH_PROVIDERS, resolveApiKeyEnv } from '@/lib/research/provider-discovery';
import { runResearch } from '@/lib/research/providers';
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

const DEFAULT_ORDER = ['ollama', 'perplexity', 'tavily'];

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
};

function hasFixture(slug: string): boolean {
  const envVar = FIXTURE_ENV[slug];
  return Boolean(envVar && process.env[envVar]);
}

/** Preference order for this box: `RESEARCH_PROVIDER_ORDER`, else the default. */
export function researchProviderOrder(): string[] {
  const raw = (process.env.RESEARCH_PROVIDER_ORDER || '').trim();
  if (!raw) return DEFAULT_ORDER;
  const parsed = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_ORDER;
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
        return {
          provider: 'tavily',
          answer: tavily.answer,
          results: (tavily.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
        };
      }

      const entry = RESEARCH_PROVIDERS.find((p) => p.slug === slug);
      if (!entry) continue;
      const apiKeyEnv = resolveApiKeyEnv(entry);
      if (pass === 'key' && !apiKeyEnv) continue;

      const result = await runResearch(entry.slug, {
        query,
        depth: 'shallow',
        model: resolveResearchModel(entry.slug, entry.defaultModel),
        apiKey: apiKeyEnv ? (process.env[apiKeyEnv] as string) : '',
      });
      return {
        provider: entry.slug,
        answer: result.answer,
        // These providers return citations, not extracts. The answer carries the
        // substance and is handed to synthesis separately.
        results: (result.citations || []).slice(0, maxResults).map((c) => ({
          title: c.title || c.url,
          url: c.url,
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
