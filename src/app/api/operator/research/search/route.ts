/**
 * POST /api/operator/research/search
 *
 * Run a live X/Grok research query.
 *
 * Request body:  { query: string, depth?: 'shallow' | 'deep' }
 * Response:      { search_id, markdown_result, model, created_at, search_metadata }
 *
 * Track B7 (SCOPE-ADDITION Section 5).
 *
 * The xAI provider connector (Track C2, Wave 2) will eventually own the live
 * model selection. Until that lands we resolve the model in this order:
 *   1. The first `active` row in `model_registry` whose `provider` is xai (or
 *      `provider_metadata.provider_slug` matches) and whose model_id is
 *      `grok-4-fast`, then any active xai model.
 *   2. Fallback to `grok-4-fast` as the model id string.
 *
 * The request body for xAI follows the OpenAI-compatible chat completions
 * shape published at https://docs.x.ai/api. Live Search is requested via the
 * `search_parameters` field on the request body. We mirror the markdown
 * response to the operator vault so Memory and All Searches pick it up.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { createResearchSearch, slugifyQuery } from '@/lib/research-store';
import { listModels } from '@/lib/model-registry';
import { vaultRoot } from '@/lib/platform';

const requestSchema = z.object({
  query: z.string().min(1).max(4000),
  depth: z.enum(['shallow', 'deep']).optional(),
});

interface XaiChoice {
  message?: { content?: string };
  finish_reason?: string;
}

interface XaiCitation {
  url?: string;
  title?: string;
}

interface XaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface XaiResponse {
  id?: string;
  model?: string;
  choices?: XaiChoice[];
  citations?: XaiCitation[] | string[];
  usage?: XaiUsage;
}

function resolveModel(): string {
  // 1. Look for grok-4-fast specifically in the registry.
  try {
    const active = listModels({ provider: 'xai', status: 'active' });
    const preferred = active.find((m) => m.model_id === 'grok-4-fast');
    if (preferred) return preferred.model_id;
    if (active.length > 0) return active[0].model_id;
  } catch {
    // model_registry may be empty on fresh installs; fall through to default.
  }
  return 'grok-4-fast';
}

function formatMarkdown(query: string, answer: string, citations: XaiCitation[]): string {
  const now = new Date().toISOString();
  const lines: string[] = [];
  lines.push('# Research result');
  lines.push('');
  lines.push(`**Query:** ${query}`);
  lines.push(`**Generated:** ${now}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(answer.trim() || '(no answer returned)');
  if (citations.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Sources');
    lines.push('');
    for (const c of citations) {
      const url = typeof c === 'string' ? c : c?.url;
      const title = typeof c === 'string' ? c : c?.title || c?.url;
      if (url) {
        lines.push(`- [${title || url}](${url})`);
      }
    }
  }
  return lines.join('\n');
}

function normalizeCitations(raw: XaiResponse['citations']): XaiCitation[] {
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => {
      if (typeof c === 'string') return { url: c, title: c };
      if (c && typeof c === 'object') return c;
      return null;
    })
    .filter((c): c is XaiCitation => Boolean(c && c.url));
}

async function callXaiLiveSearch(params: {
  query: string;
  depth: 'shallow' | 'deep';
  model: string;
}): Promise<XaiResponse> {
  // Fixture path for testing — keeps CI/test runs offline.
  const fixturePath = process.env.X_AI_FIXTURE_JSON_PATH;
  if (fixturePath) {
    const raw = await fs.readFile(fixturePath, 'utf8');
    return JSON.parse(raw) as XaiResponse;
  }

  const apiKey = process.env.X_AI_API_KEY;
  if (!apiKey) {
    throw new Error('X_AI_API_KEY is not set');
  }

  const isDeep = params.depth === 'deep';
  const body = {
    model: params.model,
    messages: [
      {
        role: 'system',
        content:
          'You are a research assistant. Answer the user query using live web and X search. Cite sources inline and list URLs at the end. Use Markdown.',
      },
      { role: 'user', content: params.query },
    ],
    search_parameters: {
      mode: 'on',
      // Deep search returns more candidate sources, shallow caps for speed.
      max_search_results: isDeep ? 20 : 8,
      return_citations: true,
    },
    temperature: 0.2,
  };

  // 30s SLA target for shallow per the task spec. Deep allowed to run longer.
  const timeoutMs = isDeep ? 90_000 : 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`xAI search failed: ${res.status} ${text.slice(0, 400)}`);
    }
    return (await res.json()) as XaiResponse;
  } finally {
    clearTimeout(timer);
  }
}

async function mirrorToVault(args: {
  query: string;
  markdown: string;
  id: string;
}): Promise<string | null> {
  try {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const slug = slugifyQuery(args.query);
    const dir = path.join(vaultRoot(), 'research', yyyy, mm);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${yyyy}-${mm}-${dd}-${slug}.md`);
    const header = `<!-- research_id: ${args.id} -->\n`;
    await fs.writeFile(file, header + args.markdown, 'utf8');
    return file;
  } catch {
    // Vault mirror is best effort. A failure here must not break the API call.
    return null;
  }
}

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof requestSchema>;
  try {
    const json = await req.json();
    parsed = requestSchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_request', detail: err instanceof Error ? err.message : 'bad body' },
      { status: 400 }
    );
  }

  const depth = parsed.depth || 'shallow';
  const model = resolveModel();
  const started = Date.now();

  let xai: XaiResponse;
  try {
    xai = await callXaiLiveSearch({ query: parsed.query, depth, model });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'provider_failed',
        detail: err instanceof Error ? err.message : 'unknown',
        model,
      },
      { status: 502 }
    );
  }

  const answer = xai.choices?.[0]?.message?.content || '';
  const citations = normalizeCitations(xai.citations);
  const markdown = formatMarkdown(parsed.query, answer, citations);

  const metadata: Record<string, unknown> = {
    depth,
    elapsed_ms: Date.now() - started,
    provider: 'xai',
    upstream_id: xai.id,
    upstream_model: xai.model,
    usage: xai.usage || null,
    citation_count: citations.length,
    source_urls: citations.map((c) => c.url).filter(Boolean),
  };

  const row = createResearchSearch({
    query: parsed.query,
    model,
    result_markdown: markdown,
    search_metadata: metadata,
  });

  const vaultPath = await mirrorToVault({
    query: parsed.query,
    markdown,
    id: row.id,
  });

  return NextResponse.json({
    search_id: row.id,
    markdown_result: markdown,
    model,
    created_at: row.created_at,
    search_metadata: { ...metadata, vault_path: vaultPath },
  });
}
