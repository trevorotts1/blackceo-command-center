/**
 * Which models can actually search the live web (T0-56).
 *
 * THE DEFECT this exists to close. `POST /api/operator/research/search`
 * resolved its model with "prefer an active `model_registry` row for that
 * provider, else the provider's documented default". When no row matched the
 * default by id it fell through to `active[0]` — the FIRST ACTIVE ROW FOR THAT
 * PROVIDER, whatever it was. Live web search is a property of PARTICULAR
 * MODELS, not of a provider: `sonar-pro` searches every call, `mistral-7b`
 * under the same key does not. A registry row promoted to active for an
 * unrelated reason therefore silently became the research model and the route
 * kept presenting its output as grounded research. The substitution was
 * invisible — identical response shape, minus the grounding.
 *
 * WHY AN ALLOWLIST AND NOT A CAPABILITY COLUMN. A `search_capable` column would
 * be a schema addition that no box in the fleet currently has, so every real
 * row would read false (or null) and every substitution would be filtered — a
 * check whose fixture corresponds to nothing in production. The families below
 * are instead derived from the provider contracts documented in
 * `src/lib/research/providers.ts` (the "REQUEST SHAPE + SCOPE per provider"
 * header), which is the same source the adapters are written against.
 *
 * FAIL-SAFE DIRECTION. A model that is not recognised as search-capable is not
 * an error: the route uses the provider's DOCUMENTED DEFAULT, which is
 * search-capable by construction, and records which model actually answered.
 * Nothing that works today stops working; only the silent substitution stops.
 */

import type { ResearchProviderSlug } from './provider-discovery';

/**
 * Per-provider recognisers for models documented as grounding their answers in
 * live web results. Matched against the BARE model id (registry ids may be
 * namespaced as `provider/model`; the caller strips the namespace first).
 */
const SEARCH_CAPABLE: Record<ResearchProviderSlug, RegExp[]> = {
  // Perplexity: the online "sonar" family searches the live web every call.
  // https://docs.perplexity.ai — sonar, sonar-pro, sonar-reasoning,
  // sonar-reasoning-pro, sonar-deep-research.
  perplexity: [/^sonar(?:$|[-:])/i],

  // OpenAI: only the web-search models are grounded in live results and return
  // `message.annotations[].url_citation`. A plain gpt-4o is NOT one of them.
  // https://platform.openai.com/docs — gpt-4o-search-preview,
  // gpt-4o-mini-search-preview.
  openai: [/-search(?:-preview)?$/i, /^gpt-4o(?:-mini)?-search/i],

  // Ollama Cloud: the grounding comes from the hosted `web_search` TOOL, which
  // requires a tool-calling model. The connector documents the gpt-oss family
  // for this path; anything else falls back to the documented default rather
  // than being assumed tool-capable.
  ollama: [/^gpt-oss(?:$|[-:])/i],

  // xAI: Live Search is enabled per request via `search_parameters.mode="on"`
  // on the grok chat models. https://docs.x.ai/api
  xai: [/^grok(?:$|[-:])/i],
};

/** Strip a `provider/` namespace from a registry model id. */
export function bareModelId(modelId: string): string {
  return modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
}

/**
 * True when `modelId` is documented as searching the live web for this provider.
 * The id may be namespaced (`perplexity/sonar-pro`) or bare (`sonar-pro`).
 */
export function isSearchCapableModel(slug: ResearchProviderSlug, modelId: string): boolean {
  const patterns = SEARCH_CAPABLE[slug];
  if (!patterns) return false;
  const bare = bareModelId(String(modelId || '').trim());
  if (!bare) return false;
  return patterns.some((re) => re.test(bare));
}

/** The recognisers, exposed so a test can assert the documented families are covered. */
export const SEARCH_CAPABLE_PATTERNS: Readonly<Record<ResearchProviderSlug, readonly RegExp[]>> =
  SEARCH_CAPABLE;
