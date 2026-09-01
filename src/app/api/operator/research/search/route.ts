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
 *
 * ---------------------------------------------------------------------------
 * CC-resear-001 — FIXTURE-DERIVED RESULTS ARE NEVER PERSISTED
 * ---------------------------------------------------------------------------
 * Because that vault mirror is ingested by the Memory full-text index as
 * genuine cited research, a canned `*_FIXTURE_JSON_PATH` response reaching
 * this route used to manufacture fabricated `source_urls` + `citation_count`
 * and file them as real evidence. This route now REFUSES the durable write
 * whenever `result.isFixtureDerived` is set: no `research_searches` row, no
 * vault file, at EVERY NODE_ENV.
 *
 * Why refuse rather than label: the Memory index ingests the vault by path
 * glob and has no way to honor a label, and a labelled DB row is one
 * unfiltered SELECT away from being read as genuine. Refusing means there is
 * no artifact to mislabel — the only shape with no residual failure mode.
 *
 * Legitimate offline testing is preserved: the route still returns the full
 * markdown, so the UI renders the complete result end-to-end with no key and
 * no network. Only the durable side effect is withheld, and the response says
 * so explicitly via `fixture: true` / `persisted: false`. A test that genuinely
 * needs a persisted row calls `createResearchSearch()` directly against a
 * throwaway DATABASE_PATH — the seam tests/unit/maria-pattern-harness.test.ts
 * already enforces.
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
import { bareModelId, isSearchCapableModel } from '@/lib/research/search-capable-models';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const requestSchema = z.object({
  query: z.string().min(1).max(4000),
  depth: z.enum(['shallow', 'deep']).optional(),
});

/** Where the answering model came from, recorded on every result. */
type ModelSource = 'registry-exact' | 'registry-search-capable' | 'provider-default';

interface ResolvedModel {
  model: string;
  source: ModelSource;
  /**
   * Registry model ids that were active for this provider but are NOT
   * documented as searching the live web, and were therefore NOT substituted.
   * Empty on a healthy box; non-empty is the T0-56 condition, made visible.
   */
  rejected: string[];
}

/**
 * Resolve the model for the selected provider.
 *
 * T0-56 — THE SUBSTITUTION IS NOW CAPABILITY-CHECKED. This used to be "prefer
 * an active registry row for that provider, else the documented default", and
 * when no row matched the default by id it fell through to `active[0]` — the
 * first active row for the provider, whatever it happened to be. Live web
 * search is a property of PARTICULAR MODELS, not of a provider, so a row
 * promoted to active for an unrelated reason silently became the research
 * model while the route kept presenting its output as grounded research.
 *
 * A candidate is now only substituted when `isSearchCapableModel()` recognises
 * it against the families documented in src/lib/research/providers.ts. Anything
 * else falls back to the provider's DOCUMENTED DEFAULT — which is search-capable
 * by construction — and the rejected ids are recorded on the result. Nothing
 * that worked before stops working; only the silent substitution stops.
 */
function resolveModel(slug: ResearchProviderSlug, fallback: string): ResolvedModel {
  const rejected: string[] = [];
  try {
    const active = listModels({ provider: slug, status: 'active' });
    const exact = active.find((m) => m.model_id === fallback || m.model_id.endsWith(`/${fallback}`));
    if (exact) return { model: bareModelId(exact.model_id), source: 'registry-exact', rejected };

    for (const row of active) {
      const bare = bareModelId(row.model_id);
      if (isSearchCapableModel(slug, bare)) {
        return { model: bare, source: 'registry-search-capable', rejected };
      }
      rejected.push(row.model_id);
    }

    if (rejected.length > 0) {
      console.warn(
        `[CC-resear-T0-56] ${rejected.length} active ${slug} registry model(s) are not documented ` +
          `as searching the live web (${rejected.join(', ')}). Using the provider default ` +
          `"${fallback}" instead of substituting one of them for a grounded research query.`,
      );
    }
  } catch {
    // registry may be empty on fresh installs; fall through to the default.
  }
  return { model: fallback, source: 'provider-default', rejected };
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
  } else {
    // T0-57: a zero-citation answer is still stored, but it must not read as
    // cited research once the vault mirror is ingested by the Memory index.
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(
      '> **UNGROUNDED — no sources returned.** The provider answered without citing any ' +
        'source, so nothing here is traceable to a retrieved document. Treat it as the ' +
        "model's own output, not as researched evidence.",
    );
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
  const resolved = resolveModel(slug, selected.entry.defaultModel);
  const model = resolved.model;
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

  // T0-57 — AN EMPTY ANSWER IS AN UPSTREAM FAILURE, NOT A COMPLETED SEARCH.
  // The catch above only sees a THROWN error. A 200 response whose answer is
  // empty is not an error to `fetch`, so it used to flow onward, be persisted
  // through createResearchSearch() and mirrored to the vault, where it reads
  // forever after as completed research on that question. The only signal was
  // the string "(no answer returned)" rendered inside the markdown body —
  // invisible to anything that counts completed searches or reuses stored
  // research. Nothing is persisted and nothing is mirrored on this path.
  if (!result.answer || result.answer.trim() === '') {
    console.warn(
      `[CC-resear-T0-57] ${selected.entry.displayName} returned a response with no answer for ` +
        `"${parsed.query.slice(0, 120)}" (model ${model}, ${result.citations.length} citation(s)). ` +
        `Refusing to store an empty research search.`,
    );
    return NextResponse.json(
      {
        error: 'provider_empty_answer',
        detail:
          'The provider returned a successful response with an empty answer. Nothing was stored ' +
          'or mirrored — an empty result is an upstream failure, not a completed search.',
        provider: slug,
        model,
        citation_count: result.citations.length,
        persisted: false,
      },
      { status: 502 },
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
    // T0-56 — record WHICH model answered and where it came from, so a reader of
    // a stored search can tell a documented search model from a substitution.
    answering_model: model,
    model_source: resolved.source,
    model_search_capable: isSearchCapableModel(slug, model),
    non_search_models_rejected: resolved.rejected,
    // T0-57 — a non-empty answer with zero citations is still stored, but it is
    // stamped UNGROUNDED rather than reading as cited research.
    grounded: result.citations.length > 0,
  };

  // CC-resear-001 — HARD STOP before any durable write. `citation_count` and
  // `source_urls` above are CANNED when the result is fixture-derived. They
  // must not reach `research_searches` (which the All Searches bucket reads)
  // or `<vault>/research/**` (which the Memory full-text index ingests as
  // genuine cited evidence). Return the rendered result so the offline UI
  // flow still works, and say plainly that nothing was stored.
  if (result.isFixtureDerived) {
    const envVar = result.fixtureEnvVar || 'a *_FIXTURE_JSON_PATH env var';
    console.warn(
      `[CC-resear-001] Refusing durable write for query "${parsed.query.slice(0, 120)}": ` +
        `result came from ${envVar}, not from provider "${slug}". No research_searches ` +
        `row and no vault file were created.`,
    );
    return NextResponse.json({
      search_id: null,
      fixture: true,
      persisted: false,
      fixture_env_var: envVar,
      markdown_result:
        `> **FIXTURE RESULT — NOT RESEARCH.** Served from \`${envVar}\`, not from a live ` +
        `${selected.entry.displayName} call. The sources below are canned test data. This ` +
        `result was NOT saved to history and NOT mirrored to the vault.\n\n` +
        markdown,
      model,
      provider: slug,
      created_at: new Date().toISOString(),
      search_metadata: {
        ...metadata,
        fixture: true,
        persisted: false,
        fixture_env_var: envVar,
        vault_path: null,
      },
    });
  }

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
