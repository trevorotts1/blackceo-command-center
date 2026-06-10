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
  // Fixture path for testing — no live cost.
  const fixturePath = process.env.TAVILY_FIXTURE_JSON_PATH;
  if (fixturePath) {
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const fixture = JSON.parse(raw) as TavilyResponse;
    return { ...fixture, query };
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not set. Set it in .env.local or pass TAVILY_FIXTURE_JSON_PATH for testing.');
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
