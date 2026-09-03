/**
 * Smart web-research selector for SOP research.
 *
 * Callers: `sop-authoring.ts` §4 (dispatch-time "Author SOP" research) and
 * `sop-auto-replace.ts`'s Track S (auto-drafted SOP replacement after an
 * operator deletes one) both call `tavilySearch()` directly. Both run under
 * an explicit fire-and-forget/NEVER-throw contract.
 *
 * HISTORY: as of v3.6.0 this called Tavily's REST API directly and THREW
 * when `TAVILY_API_KEY` was unset — any box without that key had a
 * silently-dead SOP pipeline. A first fix made Tavily-when-present the
 * privileged path with a native-OpenClaw fallback when unset. THIS version
 * goes further, per Trevor: Tavily is no longer privileged. `tavilySearch()`
 * detects what web-research capability THIS box actually has, at runtime,
 * and uses the best available one:
 *
 *   1. Perplexity — attempted first, unconditionally, exactly like every
 *      other CLI-backed tier (see "TIER 1 HAS NO ENV GATE" below).
 *   2. Whatever THIS box's OpenClaw natively offers — discovered via
 *      `openclaw infer web providers` (`./native-web-search.ts`), not
 *      assumed. A box with Ollama Cloud has Ollama's own web search;
 *      another has Gemini's grounded search. Perplexity and duckduckgo are
 *      excluded from this discovered set — they are tiers 1 and 4.
 *   3. Tavily — if `TAVILY_API_KEY` is set AND usable. `tavilySearchViaTavily()`
 *      below is unchanged from the original implementation (same URL, same
 *      request body, same return shape); a box whose ONLY configured
 *      provider is Tavily still gets exactly the same research it always
 *      did — it is simply no longer preferred over a funded Perplexity key
 *      or a working native OpenClaw provider.
 *   4. DuckDuckGo — zero-credential floor. Works on every box, paid key or
 *      not, so it is the terminal tier before giving up.
 *
 * "CONFIGURED" IS A CLAIM, NOT A FACT — this is the crux of the whole
 * design. A key or provider can exist and report `configured: true` while
 * being unusable: an expired trial, a depleted prepaid balance (live-proven:
 * a Gemini call returning HTTP 429 "Your prepayment credits are depleted"),
 * an unauthenticated CLI session (live-proven: `openclaw infer web
 * providers` reported `ollama` configured while a real search returned
 * "Ollama web search authentication failed. Run 'ollama signin'."). Each
 * tier is therefore tried EMPIRICALLY — actually called, not just checked
 * for a key/flag — and `native-web-search.ts`'s
 * `looksLikeUnusableProviderOutput()` catches an auth/quota/billing failure
 * even when it arrives dressed up as a normal-looking answer. Any failure —
 * bad exit code, timeout, malformed output, an unusable-signature hit, an
 * HTTP 401/403/429 from Tavily — is treated as "this tier is not usable
 * right now," never as a reason to stop trying the rest.
 *
 * CACHING: probing a provider costs a real CLI/network round-trip, and nothing
 * here is on a hot path a human is staring at, but a repeatedly-broken
 * provider (e.g. a permanently depleted key) should not be re-probed on
 * every single SOP research call either. `providerUsabilityCache` remembers
 * each tier's last outcome (usable / unusable) for `PROVIDER_CACHE_TTL_MS`
 * (default 5 minutes, `WEB_SEARCH_PROVIDER_CACHE_TTL_MS` overrides — also
 * the test seam). A negative is NOT cached forever — credit gets topped up,
 * a key gets rotated — it simply expires and gets re-probed like everything
 * else once the TTL elapses. `discoverOpenClawProviders()`'s own result is
 * cached the same way so tier 2 doesn't shell out to `infer web providers`
 * on every call either.
 *
 * NEVER THROWS. If every tier is exhausted (no keys configured anywhere,
 * every provider erroring, the CLI itself absent), `tavilySearch()` resolves
 * an empty-but-well-shaped `TavilyResponse` —
 * `{ query, results: [], answer: undefined }` — instead of throwing, so the
 * fire-and-forget callers degrade gracefully instead of crashing. Both
 * callers ALSO run their draft through `groundDraftedSOP()` afterward, which
 * hard-blocks auto-filing whenever `results.length < 1` — so an all-tiers-
 * exhausted SOP never becomes silently authoritative; it is held as a
 * `[QC-UNGROUNDED]`/pending-review proposal instead. That gate lives in
 * sop-authoring.ts / sop-auto-replace.ts, not here — noted so the next
 * person doesn't go looking for it in this file.
 *
 * TIER 1 HAS NO ENV GATE. v6.1.0/v6.1.1 gated Perplexity on
 * `process.env.PERPLEXITY_API_KEY || process.env.OPENROUTER_API_KEY` — the
 * Next.js APP's own env. That was wrong: the credential Perplexity actually
 * needs lives at the OpenClaw CLI layer, which this app-level env check
 * cannot see. Live-verified: a box existed where NEITHER var was set in the
 * app's env, yet `searchViaOpenClawProvider(query, 'perplexity', {})` called
 * directly returned a real synthesized answer with citations through the
 * pinned CLI — the app-level gate was skipping the one tier that actually
 * worked. Tier 1 is now attempted unconditionally, exactly like tiers 2 and
 * 4, and `attemptTier()`'s TTL cache is what keeps a genuinely-unusable
 * Perplexity from being re-probed on every call — the same mechanism that
 * already protected every other tier. Tavily (tier 3) is the one tier that
 * KEEPS its env gate, because it is structurally required there: Tavily is a
 * direct `fetch()`, not a CLI shell-out, and the key has to be read
 * in-process to build the request body — there is no CLI layer to defer to.
 *
 * Per Trevor's "stub during tests" policy, callers in tests can inject a
 * fixture by setting `TAVILY_FIXTURE_JSON_PATH` to a JSON file that mirrors
 * the response shape — no live network/CLI calls fire when this env var is
 * set, regardless of which tier would otherwise have been selected.
 */

import fs from 'fs';
import { assertNoFixtureEnvInProduction } from '@/lib/fixture-guard';
import { discoverOpenClawProviders, searchViaOpenClawProvider } from './native-web-search';

export interface TavilyResult {
  title: string;
  url: string;
  content?: string;
  score?: number;
}

export interface TavilyResponse {
  query: string;
  results: TavilyResult[];
  answer?: string;
}

export interface TavilySearchOptions {
  max_results?: number; // default 5
  search_depth?: 'basic' | 'advanced'; // default 'basic'
  include_answer?: boolean; // default true
}

// ── per-provider usability cache ─────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Test seam: overrides the cache TTL (default 5 minutes) for both the
 *  per-provider usability cache and the discovered-providers cache. Read at
 *  call time so a test can shrink it after this module has already loaded. */
function getCacheTtlMs(): number {
  return Number(process.env.WEB_SEARCH_PROVIDER_CACHE_TTL_MS) || 5 * 60_000;
}

const providerUsabilityCache = new Map<string, CacheEntry<boolean>>();
let discoveredProvidersCache: CacheEntry<Awaited<ReturnType<typeof discoverOpenClawProviders>>> | null = null;

function getCachedUsability(providerKey: string): boolean | undefined {
  const entry = providerUsabilityCache.get(providerKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    providerUsabilityCache.delete(providerKey);
    return undefined;
  }
  return entry.value;
}

function setCachedUsability(providerKey: string, usable: boolean): void {
  providerUsabilityCache.set(providerKey, { value: usable, expiresAt: Date.now() + getCacheTtlMs() });
}

async function getDiscoveredProviders(): Promise<Awaited<ReturnType<typeof discoverOpenClawProviders>>> {
  if (discoveredProvidersCache && Date.now() <= discoveredProvidersCache.expiresAt) {
    return discoveredProvidersCache.value;
  }
  const providers = await discoverOpenClawProviders();
  discoveredProvidersCache = { value: providers, expiresAt: Date.now() + getCacheTtlMs() };
  return providers;
}

/**
 * Test-only reset for the provider usability cache and the discovered-
 * providers cache. Every test in the suite shares this module's cache
 * across cases (node:test runs a file's tests in one process), so tests
 * that care about tier selection call this first to start from a clean
 * slate.
 */
export function __resetWebSearchCachesForTests(): void {
  providerUsabilityCache.clear();
  discoveredProvidersCache = null;
}

/**
 * Try one tier. Returns the result on success (and caches it usable);
 * returns null on any failure (and caches it unusable), logging clearly.
 * Never throws — this is where every tier's own throw-on-failure contract
 * gets absorbed into the selector's overall never-throw guarantee.
 */
async function attemptTier(
  cacheKey: string,
  attempt: () => Promise<TavilyResponse>,
): Promise<TavilyResponse | null> {
  const cached = getCachedUsability(cacheKey);
  if (cached === false) {
    return null; // known-unusable within the TTL — skip the round-trip entirely
  }
  try {
    const result = await attempt();
    setCachedUsability(cacheKey, true);
    return result;
  } catch (err) {
    console.error(`[tavily] web-research provider "${cacheKey}" unusable: ${(err as Error).message}`);
    setCachedUsability(cacheKey, false);
    return null;
  }
}

// ── the selector ──────────────────────────────────────────────────────────

export async function tavilySearch(query: string, opts: TavilySearchOptions = {}): Promise<TavilyResponse> {
  // QC-11: never honor TAVILY_FIXTURE_JSON_PATH on a production box — fabricated
  // research would flow straight into SOP grounding. No-op in dev/test.
  assertNoFixtureEnvInProduction();

  // Fixture path for testing — no live cost, short-circuits every tier below.
  const fixturePath = process.env.TAVILY_FIXTURE_JSON_PATH;
  if (fixturePath) {
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const fixture = JSON.parse(raw) as TavilyResponse;
    return { ...fixture, query };
  }

  // Tier 1 — Perplexity, attempted unconditionally (see "TIER 1 HAS NO ENV
  // GATE" above — the credential lives at the OpenClaw CLI layer, which an
  // app-level env check cannot see; the TTL cache is what keeps a genuinely
  // unusable Perplexity from being re-probed every call).
  {
    const result = await attemptTier('perplexity', () => searchViaOpenClawProvider(query, 'perplexity', opts));
    if (result) return result;
  }

  // Tier 2 — whatever this box's OpenClaw natively offers, discovered rather
  // than assumed. Perplexity (tier 1) and duckduckgo (tier 4) are handled
  // separately, so skip them here even if the discovery listing includes
  // them.
  const discovered = await getDiscoveredProviders();
  for (const provider of discovered) {
    if (provider.id === 'perplexity' || provider.id === 'duckduckgo') continue;
    if (!provider.configured) continue; // a hard "false" is still worth skipping outright
    const result = await attemptTier(provider.id, () => searchViaOpenClawProvider(query, provider.id, opts));
    if (result) return result;
  }

  // Tier 3 — Tavily, if a key is present. tavilySearchViaTavily() itself is
  // unchanged from the original implementation; attemptTier() is what makes
  // its failure non-fatal to the overall selector now that it's one tier
  // among several rather than the terminal path.
  const tavilyApiKey = process.env.TAVILY_API_KEY;
  if (tavilyApiKey) {
    const result = await attemptTier('tavily', () => tavilySearchViaTavily(query, opts, tavilyApiKey));
    if (result) return result;
  }

  // Tier 4 — DuckDuckGo, the zero-credential floor. Works on every box.
  const floor = await attemptTier('duckduckgo', () => searchViaOpenClawProvider(query, 'duckduckgo', opts));
  if (floor) return floor;

  console.error(
    `[tavily] every web-research tier (perplexity, discovered native providers, tavily, duckduckgo) was ` +
      `unusable for query "${query}"; returning an empty result so the caller can proceed without research.`,
  );
  return { query, results: [], answer: undefined };
}

/**
 * The original Tavily REST call. Unchanged from the pre-selector
 * implementation — same URL, same request body, same return shape, same
 * throw-on-HTTP-error. A box whose only configured research provider is
 * Tavily gets exactly the research it always got once tier 3 is reached;
 * `attemptTier()` in the selector above is what now absorbs a thrown error
 * here into "try the next tier" instead of it propagating out of
 * `tavilySearch()`.
 */
async function tavilySearchViaTavily(
  query: string,
  opts: TavilySearchOptions,
  apiKey: string,
): Promise<TavilyResponse> {
  const body = {
    api_key: apiKey,
    query,
    search_depth: opts.search_depth || 'basic',
    include_answer: opts.include_answer !== false,
    max_results: opts.max_results || 5,
  };

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily search failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as TavilyResponse;
  return data;
}
