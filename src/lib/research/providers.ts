/**
 * Research provider adapters (v4.1.5).
 *
 * One `runSearch()` per provider, each normalizing to the same
 * `ResearchProviderResult` so the route handler is provider-agnostic. Every
 * adapter:
 *   - reads its key from the env var the discovery module resolved,
 *   - honors a per-provider fixture env var so CI/tests run offline,
 *   - applies the shared depth → breadth mapping (shallow = fast/fewer
 *     sources, deep = more sources / longer timeout),
 *   - NEVER fabricates results: a provider error propagates so the route can
 *     surface it honestly.
 *
 * CC-resear-001 — FIXTURE MODE IS QUARANTINED, NOT SILENT.
 * A fixture env var supplies the `answer` AND the `citations` that become
 * `source_urls` / `citation_count` downstream. Left unguarded that is a
 * machine for manufacturing fabricated research and filing it as genuine
 * cited evidence. Fixture mode is still supported for offline UI/CI work,
 * but it is now:
 *   1. BLOCKED in production — `readFixture()` calls the shared
 *      `assertNoFixtureEnvInProduction()` (src/lib/fixture-guard.ts) before
 *      honoring the var, exactly as gemini.ts / qc-scorer.ts / tavily.ts do.
 *   2. LOUD — every honored fixture logs a warning naming the env var.
 *   3. LABELLED — the result carries `isFixtureDerived: true` +
 *      `fixtureEnvVar`, so the truth travels with the payload.
 *   4. NON-DURABLE — the search route REFUSES to write a fixture-derived
 *      result to `research_searches` or the vault, at EVERY NODE_ENV, and
 *      research-store.ts carries an independent tripwire.
 *
 * Server-only (uses `fetch` + `fs` for fixtures).
 *
 * ---------------------------------------------------------------------------
 * REQUEST SHAPE + SCOPE per provider
 * ---------------------------------------------------------------------------
 * PERPLEXITY  (https://docs.perplexity.ai)
 *   POST https://api.perplexity.ai/chat/completions  (OpenAI-compatible)
 *   Bearer PERPLEXITY_API_KEY. "sonar"/"sonar-pro" are online models that
 *   search the live web every call. Sources arrive in the top-level
 *   `citations: string[]` array. Scope: whole public web, real-time.
 *
 * OPENAI  (https://platform.openai.com/docs)
 *   POST https://api.openai.com/v1/chat/completions  with a web-search model
 *   (`gpt-4o-search-preview`). Bearer OPENAI_API_KEY. The model is grounded in
 *   live web results; source URLs come back in
 *   `choices[].message.annotations[]` of type `url_citation`. Scope: web.
 *
 * OLLAMA CLOUD  (https://ollama.com / OpenAI-compatible per the repo connector)
 *   POST https://ollama.com/v1/chat/completions  with the hosted
 *   `web_search` tool declared in `tools` and `tool_choice:"auto"`. Bearer
 *   OLLAMA_CLOUD_API_KEY. The model calls the tool, we surface tool-result
 *   URLs as citations. Scope: web search via Ollama's hosted tool.
 *
 * XAI GROK  (https://docs.x.ai/api)
 *   POST https://api.x.ai/v1/chat/completions  with
 *   `search_parameters.mode="on"` (Live Search). Bearer X_AI_API_KEY. Sources
 *   in the top-level `citations` array. Scope: X (Twitter) + the live web.
 */

import fs from 'fs/promises';

import { assertNoFixtureEnvInProduction } from '@/lib/fixture-guard';
import { resolveOllamaCloudBaseUrl } from '@/lib/model-providers/ollama-cloud-base-url';
import type { ResearchProviderSlug } from './provider-discovery';

export interface ResearchCitation {
  url: string;
  title?: string;
}

export interface ResearchProviderResult {
  answer: string;
  citations: ResearchCitation[];
  upstreamId?: string;
  upstreamModel?: string;
  usage?: Record<string, unknown> | null;
  /**
   * CC-resear-001 — TRUE when this result came from a `*_FIXTURE_JSON_PATH`
   * file instead of a live provider call. Its `answer`, `citations` (and
   * therefore any derived `source_urls` / `citation_count`) are CANNED, not
   * researched. Callers MUST NOT persist a result carrying this flag: see
   * the refusal in src/app/api/operator/research/search/route.ts and the
   * tripwire in src/lib/research-store.ts.
   *
   * The flag travels WITH the payload rather than being re-derived from
   * process.env by each caller, so a future caller cannot forget to check.
   */
  isFixtureDerived?: boolean;
  /** Name of the fixture env var that produced this result, when fixture-derived. */
  fixtureEnvVar?: string;
}

/** The fixture env var that produced the most recent fixture read, if any. */
interface FixtureRead<T> {
  data: T;
  envVar: string;
}

export interface RunSearchParams {
  query: string;
  depth: 'shallow' | 'deep';
  model: string;
  apiKey: string;
}

const SYSTEM_PROMPT =
  'You are a research assistant. Answer the user query using live web search. ' +
  'Cite sources inline and list the source URLs at the end. Respond in Markdown.';

/** shallow = fast/fewer sources; deep = more sources, allowed to run longer. */
function breadth(depth: 'shallow' | 'deep') {
  const isDeep = depth === 'deep';
  return { isDeep, maxResults: isDeep ? 20 : 8, timeoutMs: isDeep ? 90_000 : 30_000 };
}

/**
 * Read a canned provider response from `process.env[envVar]`, or null when
 * that var is unset.
 *
 * CC-resear-001 — two things happen here that did not before:
 *
 *  1. `assertNoFixtureEnvInProduction()` runs BEFORE the env var is honored,
 *     matching how src/lib/gemini.ts, src/lib/qc-scorer.ts and
 *     src/lib/tavily.ts already wire the shared guard. On a production box a
 *     fixture path now throws instead of serving fabricated citations.
 *  2. The read is LOUD. A fixture serving `source_urls` and `citation_count`
 *     that look researched but are not is the single most dangerous silent
 *     state this app can be in, so every honored fixture emits a warning
 *     naming the var. Silence was half the defect.
 *
 * The returned envelope is tagged with the var name so the caller can stamp
 * `isFixtureDerived` onto the result and the durable-write refusal can name
 * the exact var an operator has to unset.
 */
async function readFixture<T>(envVar: string): Promise<FixtureRead<T> | null> {
  const fixturePath = process.env[envVar];
  if (!fixturePath || fixturePath.trim() === '') return null;

  // QC-11 / CC-resear-001: never honor a research fixture on a production box.
  // A fixture here fabricates the `source_urls` + `citation_count` that the
  // Memory full-text index later ingests as genuine cited evidence.
  assertNoFixtureEnvInProduction();

  console.warn(
    `[CC-resear-001] ${envVar} is set — Operator Research is serving a CANNED ` +
      `answer and CANNED citations from "${fixturePath}" instead of calling the ` +
      `live provider. This result is NOT research and will NOT be persisted to ` +
      `research_searches or mirrored to the vault.`,
  );

  const raw = await fs.readFile(fixturePath, 'utf8');
  return { data: JSON.parse(raw) as T, envVar };
}

/**
 * Stamp the fixture provenance onto a provider result so it travels with the
 * payload. Returns the result unchanged when the call was live.
 */
function tagFixture(
  result: ResearchProviderResult,
  fixture: FixtureRead<ChatEnvelope> | null,
): ResearchProviderResult {
  if (!fixture) return result;
  return { ...result, isFixtureDerived: true, fixtureEnvVar: fixture.envVar };
}

async function postJson(url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${text.slice(0, 400)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Shared OpenAI-compatible response shapes (Perplexity / OpenAI / Ollama / xAI
// all return this envelope; the differences are WHERE the citations live).
// ---------------------------------------------------------------------------

interface ChatAnnotation {
  type?: string;
  url?: string;
  title?: string;
  url_citation?: { url?: string; title?: string };
}

interface ChatMessage {
  content?: string;
  annotations?: ChatAnnotation[];
}

interface ChatChoice {
  message?: ChatMessage;
}

interface ChatEnvelope {
  id?: string;
  model?: string;
  choices?: ChatChoice[];
  citations?: Array<string | { url?: string; title?: string }>;
  usage?: Record<string, unknown>;
}

function answerOf(env: ChatEnvelope): string {
  return env.choices?.[0]?.message?.content || '';
}

/** Citations from the top-level `citations` array (Perplexity, xAI). */
function citationsFromArray(env: ChatEnvelope): ResearchCitation[] {
  const raw = env.citations;
  if (!Array.isArray(raw)) return [];
  const out: ResearchCitation[] = [];
  for (const c of raw) {
    if (typeof c === 'string') {
      if (c) out.push({ url: c, title: c });
    } else if (c && typeof c === 'object' && c.url) {
      out.push({ url: c.url, title: c.title || c.url });
    }
  }
  return out;
}

/** Citations from `message.annotations[].url_citation` (OpenAI web search). */
function citationsFromAnnotations(env: ChatEnvelope): ResearchCitation[] {
  const anns = env.choices?.[0]?.message?.annotations;
  if (!Array.isArray(anns)) return [];
  const out: ResearchCitation[] = [];
  for (const a of anns) {
    const url = a.url_citation?.url || a.url;
    const title = a.url_citation?.title || a.title || url;
    if (url) out.push({ url, title });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-provider adapters.
// ---------------------------------------------------------------------------

async function runPerplexity(p: RunSearchParams): Promise<ResearchProviderResult> {
  const fixture = await readFixture<ChatEnvelope>('PERPLEXITY_FIXTURE_JSON_PATH');
  const { timeoutMs } = breadth(p.depth);
  const body = {
    model: p.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: p.query },
    ],
    return_citations: true,
    temperature: 0.2,
  };
  const env = (fixture?.data ?? (await postJson('https://api.perplexity.ai/chat/completions', p.apiKey, body, timeoutMs))) as ChatEnvelope;
  return tagFixture(
    {
      answer: answerOf(env),
      citations: citationsFromArray(env),
      upstreamId: env.id,
      upstreamModel: env.model,
      usage: env.usage || null,
    },
    fixture,
  );
}

async function runOpenAI(p: RunSearchParams): Promise<ResearchProviderResult> {
  const fixture = await readFixture<ChatEnvelope>('OPENAI_FIXTURE_JSON_PATH');
  const { isDeep, maxResults, timeoutMs } = breadth(p.depth);
  const body = {
    model: p.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: p.query },
    ],
    // The *-search-preview models accept web_search_options; deep asks for a
    // higher search-context size for broader grounding.
    web_search_options: { search_context_size: isDeep ? 'high' : 'medium' },
    max_completion_tokens: maxResults * 256,
  };
  const env = (fixture?.data ?? (await postJson('https://api.openai.com/v1/chat/completions', p.apiKey, body, timeoutMs))) as ChatEnvelope;
  // OpenAI returns sources in annotations; some compatible deployments also
  // populate `citations` — merge both, preferring annotations.
  const ann = citationsFromAnnotations(env);
  const citations = ann.length > 0 ? ann : citationsFromArray(env);
  return tagFixture(
    {
      answer: answerOf(env),
      citations,
      upstreamId: env.id,
      upstreamModel: env.model,
      usage: env.usage || null,
    },
    fixture,
  );
}

async function runOllama(p: RunSearchParams): Promise<ResearchProviderResult> {
  const fixture = await readFixture<ChatEnvelope>('OLLAMA_FIXTURE_JSON_PATH');
  const { timeoutMs } = breadth(p.depth);
  // Resolved through the shared resolver so this can never drift from the
  // ollama-cloud connector again. The old inline default ('https://ollama.com/api')
  // produced `/api/v1/chat/completions` -> HTTP 404 on every box that had no
  // OLLAMA_CLOUD_BASE_URL override. See ollama-cloud-base-url.ts.
  const baseUrl = resolveOllamaCloudBaseUrl();
  const body = {
    model: p.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: p.query },
    ],
    // Ollama Cloud's hosted web_search tool. The model decides when to call it;
    // tool results carry the source URLs we surface as citations.
    tools: [{ type: 'web_search' }],
    tool_choice: 'auto',
    stream: false,
  };
  const env = (fixture?.data ?? (await postJson(`${baseUrl}/v1/chat/completions`, p.apiKey, body, timeoutMs))) as ChatEnvelope;
  // Ollama surfaces sources in `citations` when the web_search tool ran.
  return tagFixture(
    {
      answer: answerOf(env),
      citations: citationsFromArray(env),
      upstreamId: env.id,
      upstreamModel: env.model,
      usage: env.usage || null,
    },
    fixture,
  );
}

async function runXai(p: RunSearchParams): Promise<ResearchProviderResult> {
  // Honor the historical fixture var so existing xAI test fixtures still work.
  const fixture =
    (await readFixture<ChatEnvelope>('XAI_FIXTURE_JSON_PATH')) ??
    (await readFixture<ChatEnvelope>('X_AI_FIXTURE_JSON_PATH'));
  const { isDeep, maxResults, timeoutMs } = breadth(p.depth);
  const body = {
    model: p.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: p.query },
    ],
    search_parameters: { mode: 'on', max_search_results: maxResults, return_citations: true },
    temperature: 0.2,
    ...(isDeep ? {} : {}),
  };
  const env = (fixture?.data ?? (await postJson('https://api.x.ai/v1/chat/completions', p.apiKey, body, timeoutMs))) as ChatEnvelope;
  return tagFixture(
    {
      answer: answerOf(env),
      citations: citationsFromArray(env),
      upstreamId: env.id,
      upstreamModel: env.model,
      usage: env.usage || null,
    },
    fixture,
  );
}

const ADAPTERS: Record<ResearchProviderSlug, (p: RunSearchParams) => Promise<ResearchProviderResult>> = {
  perplexity: runPerplexity,
  openai: runOpenAI,
  ollama: runOllama,
  xai: runXai,
};

/** Run the live search for the given provider slug. Throws on provider error. */
export function runResearch(slug: ResearchProviderSlug, params: RunSearchParams): Promise<ResearchProviderResult> {
  const adapter = ADAPTERS[slug];
  if (!adapter) throw new Error(`No research adapter for provider "${slug}"`);
  return adapter(params);
}
