/**
 * Thin Tavily search wrapper.
 *
 * Callers: `sop-authoring.ts` §4 (dispatch-time "Author SOP" research) and
 * `sop-auto-replace.ts`'s Track S (auto-drafted SOP replacement after an
 * operator deletes one) both call `tavilySearch()` directly.
 *
 * As of v3.6.0 the dashboard repo had no shared OpenClaw research helper, so
 * this called Tavily's REST API directly and THREW when `TAVILY_API_KEY` was
 * unset — which meant any box without that key had a silently-dead SOP
 * pipeline. A shared helper exists now: when `TAVILY_API_KEY` is unset,
 * `tavilySearch()` falls back to OpenClaw's own native web search
 * (`nativeWebSearchFallback()` in `./native-web-search.ts`, which shells out
 * to `openclaw infer web search`) instead of throwing. Boxes with a working
 * `TAVILY_API_KEY` are completely unaffected — see `tavilySearchViaTavily()`
 * below, which is byte-identical to the pre-fallback implementation.
 *
 * Per Trevor's "stub during tests" policy, callers in tests can inject a
 * fixture by setting `TAVILY_FIXTURE_JSON_PATH` to a JSON file that mirrors
 * the response shape — no live network calls fire when this env var is set,
 * regardless of which path (Tavily or the native fallback) would otherwise
 * have been taken.
 */

import fs from 'fs';
import { assertNoFixtureEnvInProduction } from '@/lib/fixture-guard';
import { nativeWebSearchFallback } from './native-web-search';

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

export async function tavilySearch(query: string, opts: TavilySearchOptions = {}): Promise<TavilyResponse> {
  // QC-11: never honor TAVILY_FIXTURE_JSON_PATH on a production box — fabricated
  // research would flow straight into SOP grounding. No-op in dev/test.
  assertNoFixtureEnvInProduction();

  // Fixture path for testing — no live cost.
  const fixturePath = process.env.TAVILY_FIXTURE_JSON_PATH;
  if (fixturePath) {
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const fixture = JSON.parse(raw) as TavilyResponse;
    return { ...fixture, query };
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    // FLEET DEFECT FIX: this used to throw here, which silently killed SOP
    // research (and therefore SOP authoring) on any box without a Tavily
    // key. Fall back to OpenClaw's native web search instead. Both callers
    // run under an explicit fire-and-forget/NEVER-throw contract, and
    // nativeWebSearchFallback() honors that — it never throws and degrades
    // to an empty (but well-shaped) result if every provider fails.
    return nativeWebSearchFallback(query, opts);
  }

  return tavilySearchViaTavily(query, opts, apiKey);
}

/**
 * The original Tavily REST call. Unchanged from the pre-fallback
 * implementation — boxes with a working `TAVILY_API_KEY` see byte-identical
 * behavior, same return shape, same options.
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
