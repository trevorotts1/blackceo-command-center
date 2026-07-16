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

async function readFixture<T>(envVar: string): Promise<T | null> {
  const fixturePath = process.env[envVar];
  if (!fixturePath) return null;
  const raw = await fs.readFile(fixturePath, 'utf8');
  return JSON.parse(raw) as T;
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
  const env = (fixture ?? (await postJson('https://api.perplexity.ai/chat/completions', p.apiKey, body, timeoutMs))) as ChatEnvelope;
  return {
    answer: answerOf(env),
    citations: citationsFromArray(env),
    upstreamId: env.id,
    upstreamModel: env.model,
    usage: env.usage || null,
  };
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
  const env = (fixture ?? (await postJson('https://api.openai.com/v1/chat/completions', p.apiKey, body, timeoutMs))) as ChatEnvelope;
  // OpenAI returns sources in annotations; some compatible deployments also
  // populate `citations` — merge both, preferring annotations.
  const ann = citationsFromAnnotations(env);
  const citations = ann.length > 0 ? ann : citationsFromArray(env);
  return {
    answer: answerOf(env),
    citations,
    upstreamId: env.id,
    upstreamModel: env.model,
    usage: env.usage || null,
  };
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
  const env = (fixture ?? (await postJson(`${baseUrl}/v1/chat/completions`, p.apiKey, body, timeoutMs))) as ChatEnvelope;
  // Ollama surfaces sources in `citations` when the web_search tool ran.
  return {
    answer: answerOf(env),
    citations: citationsFromArray(env),
    upstreamId: env.id,
    upstreamModel: env.model,
    usage: env.usage || null,
  };
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
  const env = (fixture ?? (await postJson('https://api.x.ai/v1/chat/completions', p.apiKey, body, timeoutMs))) as ChatEnvelope;
  return {
    answer: answerOf(env),
    citations: citationsFromArray(env),
    upstreamId: env.id,
    upstreamModel: env.model,
    usage: env.usage || null,
  };
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
