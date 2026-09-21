/**
 * Thin Tavily search wrapper.
 *
 * Track S calls this for "best practices {dept} {topic}" research when an
 * operator deletes an SOP and we want to auto-draft a replacement.
 *
 * If the project already has a Skill 21 helper or shared OpenClaw tool that
 * exposes Tavily, prefer that path. As of v3.6.0 the dashboard repo has no
 * such helper, so we call Tavily's REST API directly.
 *
 * Per Trevor's "stub during tests" policy, callers in tests can inject a
 * fixture by setting `TAVILY_FIXTURE_JSON_PATH` to a JSON file that mirrors
 * the response shape — no live network calls fire when this env var is set.
 */

import fs from 'fs';
import { assertNoFixtureEnvInProduction } from '@/lib/fixture-guard';
import { hydrateEnvVarsFromOpenClaw } from '@/lib/studio/provider-discovery';

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

/**
 * Resolve the Tavily key the way the rest of the Command Center resolves every
 * other provider key.
 *
 * THE DEFECT THIS FIXES: this module read `process.env.TAVILY_API_KEY` and
 * nothing else. On a box where the key lives in an OpenClaw secret store
 * (`~/.openclaw/secrets/.env` on a Mac, `/data/.openclaw/.env` on a Docker VPS,
 * `openclaw.json` `env`) and NOT in the Command Center's own `.env.local`, the
 * key is present on the box but invisible here — so the dispatch-time SOP
 * authoring loop died with "TAVILY_API_KEY is not set" on every pass and left
 * its "Author SOP" card parked in_progress forever. Boot hydration
 * (`instrumentation.ts`) did not cover it either: that pass only hydrates the
 * MODEL-provider key set, which Tavily is not part of.
 *
 * `process.env` stays authoritative; the stores are consulted only when it is
 * empty. Discovery is best-effort and never throws — an unreadable store must
 * surface as the honest "not set" error below, not as a mystery exception.
 */
export function resolveTavilyApiKey(): string | null {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
  try {
    hydrateEnvVarsFromOpenClaw(['TAVILY_API_KEY']);
  } catch {
    /* never let secret-store discovery throw into a caller */
  }
  return process.env.TAVILY_API_KEY || null;
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

  const apiKey = resolveTavilyApiKey();
  if (!apiKey) {
    throw new Error(
      'TAVILY_API_KEY is not set. Set it in .env.local, in an OpenClaw secret store ' +
        '(~/.openclaw/.env, ~/.openclaw/secrets/.env, /data/.openclaw/.env on Docker) or in ' +
        'openclaw.json env — or pass TAVILY_FIXTURE_JSON_PATH for testing.',
    );
  }

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
