/**
 * POST /api/operator/research/search
 *
 * Run a live, grounded research query through whichever search provider the
 * box has a key for. Provider-agnostic as of v4.1.5 (was hard-wired to xAI).
 *
 * Request body:  { query: string, depth?: 'shallow' | 'deep' }
 * Response (live):
 *   { search_id, markdown_result, model, provider, created_at, search_metadata }
 * Response (no provider key — HONEST empty-state, HTTP 200, NOT an error):
 *   { empty_state: true, available: false, message, enable_env_vars }
 *
 * PROVIDER SELECTION (see src/lib/research/provider-discovery.ts):
 *   Auto-discovered from the environment (incl. OpenClaw secret files), in the
 *   fixed preference order  PERPLEXITY > OPENAI > OLLAMA (cloud) > XAI.
 *   When no provider key exists we return an honest empty-state so the UI can
 *   render "add a key to enable Research" instead of a dead box or a 502.
 *
 * The model is resolved from `model_registry` when the selected provider has an
 * active row; otherwise the provider's documented default is used. Results are
 * mirrored to the operator vault at `<vault>/research/YYYY/MM/...md` so the
 * Memory full-text index and the All Searches bucket pick them up.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { createResearchSearch, slugifyQuery } from '@/lib/research-store';
import { listModels } from '@/lib/model-registry';
import { vaultRoot } from '@/lib/platform';
import {
  selectResearchProvider,
  researchAvailability,
  type ResearchProviderSlug,
} from '@/lib/research/provider-discovery';
import { runResearch, type ResearchCitation } from '@/lib/research/providers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const requestSchema = z.object({
  query: z.string().min(1).max(4000),
  depth: z.enum(['shallow', 'deep']).optional(),
});

/**
 * Resolve the model for the selected provider: prefer an active registry row
 * for that provider, else the provider's documented default. The registry is
 * often empty on fresh installs, so the default keeps the module live.
 */
function resolveModel(slug: ResearchProviderSlug, fallback: string): string {
  try {
    const active = listModels({ provider: slug, status: 'active' });
    const exact = active.find((m) => m.model_id === fallback || m.model_id.endsWith(`/${fallback}`));
    if (exact) return exact.model_id.includes('/') ? exact.model_id.split('/').slice(1).join('/') : exact.model_id;
    if (active.length > 0) {
      const id = active[0].model_id;
      return id.includes('/') ? id.split('/').slice(1).join('/') : id;
    }
  } catch {
    // registry may be empty on fresh installs; fall through to the default.
  }
  return fallback;
}

function formatMarkdown(query: string, answer: string, citations: ResearchCitation[]): string {
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
      if (c.url) lines.push(`- [${c.title || c.url}](${c.url})`);
    }
  }
  return lines.join('\n');
}

async function mirrorToVault(args: { query: string; markdown: string; id: string }): Promise<string | null> {
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

  // Provider auto-discovery. No key present => honest empty-state (HTTP 200),
  // never a dead box or a 502.
  const selected = selectResearchProvider();
  if (!selected) {
    const probe = researchAvailability({ hydrate: false });
    return NextResponse.json({
      empty_state: true,
      available: false,
      message:
        'Research is not enabled yet. Add a Perplexity, OpenAI, Ollama, or xAI key to your environment to enable it.',
      enable_env_vars: probe.enableHintEnvVars,
    });
  }

  const depth = parsed.depth || 'shallow';
  const slug = selected.entry.slug;
  const model = resolveModel(slug, selected.entry.defaultModel);
  const apiKey = process.env[selected.apiKeyEnv] as string;
  const started = Date.now();

  let result;
  try {
    result = await runResearch(slug, { query: parsed.query, depth, model, apiKey });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'provider_failed',
        detail: err instanceof Error ? err.message : 'unknown',
        provider: slug,
        model,
      },
      { status: 502 }
    );
  }

  const markdown = formatMarkdown(parsed.query, result.answer, result.citations);

  const metadata: Record<string, unknown> = {
    query: parsed.query,
    depth,
    elapsed_ms: Date.now() - started,
    provider: slug,
    provider_display_name: selected.entry.displayName,
    api_key_env: selected.apiKeyEnv,
    upstream_id: result.upstreamId,
    upstream_model: result.upstreamModel,
    usage: result.usage || null,
    citation_count: result.citations.length,
    source_urls: result.citations.map((c) => c.url).filter(Boolean),
  };

  const row = createResearchSearch({
    query: parsed.query,
    model,
    result_markdown: markdown,
    search_metadata: metadata,
  });

  const vaultPath = await mirrorToVault({ query: parsed.query, markdown, id: row.id });

  return NextResponse.json({
    search_id: row.id,
    markdown_result: markdown,
    model,
    provider: slug,
    created_at: row.created_at,
    search_metadata: { ...metadata, vault_path: vaultPath },
  });
}
