/**
 * Native web-search fallback for `tavily.ts`.
 *
 * THE DEFECT this closes: `tavilySearch()` used to throw when
 * `TAVILY_API_KEY` was unset, with no other path to a search result. Every
 * box in the fleet without a Tavily key therefore had a silently-dead SOP
 * pipeline — `sop-authoring.ts`'s dispatch-time "Author SOP" loop and
 * `sop-auto-replace.ts`'s Track S both call `tavilySearch()` directly and
 * neither can proceed without it, and the SOP gate that depends on their
 * output can then never clear.
 *
 * THE FIX: when no `TAVILY_API_KEY` is configured, `tavilySearch()` falls
 * back to `nativeWebSearchFallback()` below, which shells out to OpenClaw's
 * own web-search command:
 *
 *   openclaw infer web search --query "<q>" --provider <p> --json
 *
 * — using the same `execFile(bin, args, { timeout, maxBuffer, windowsHide })`
 *   promise-wrapped, never-throws pattern already established by
 *   `runOpenClawCli()` in `src/lib/openclaw/client.ts` and the CLI detection
 *   helpers in `src/lib/bridge/cli-manager.ts`. `OPENCLAW_CLI_BIN` (already
 *   used by client.ts) overrides the binary path — also the test seam here.
 *
 * PROVIDER SELECTION — verified live 2026-09-03 against `openclaw infer web
 * providers`:
 *   - `perplexity` — rides `OPENROUTER_API_KEY` as an accepted alias; real
 *     sonar-pro answer + citations.
 *   - `gemini` — grounded answer + citations.
 *   - `duckduckgo` — needs ZERO credentials; the guaranteed floor so this
 *     works even on a box with no paid key configured at all.
 *   - `ollama` is listed by `openclaw infer web providers` but FAILS AUTH in
 *     practice, so the providers listing is not a trustworthy source of
 *     "will this actually work" on its own — REJECTED as the selection
 *     mechanism for that reason. Instead this module tries providers
 *     EMPIRICALLY in a fixed preference order and treats any failure (bad
 *     exit code, timeout, empty/malformed output) as "move to the next
 *     provider," so a provider that lies about being configured just gets
 *     skipped rather than taken as fleet-wide truth. `ollama` is excluded
 *     from the order entirely.
 *
 * NEVER THROWS. Both call sites (`sop-authoring.ts` §4 and
 * `sop-auto-replace.ts`'s Track S) run under an explicit
 * "fire-and-forget — NEVER throw" contract. If every provider fails (CLI
 * missing, all providers erroring), this resolves an empty-but-well-shaped
 * `TavilyResponse` — `{ query, results: [], answer: undefined }` — so
 * downstream synthesis/grounding code degrades gracefully instead of
 * crashing the calling path.
 */

import { execFile } from 'child_process';
import type { TavilyResponse, TavilyResult, TavilySearchOptions } from './tavily';

/** Test seam: `OPENCLAW_WEB_SEARCH_TIMEOUT_MS` overrides the per-provider
 *  execFile timeout (default 25s — generous relative to the ~6-12s observed
 *  live for perplexity/gemini). Read at call time (not cached at module
 *  scope) so a test can set it after this module has already loaded. */
function getTimeoutMs(): number {
  return Number(process.env.OPENCLAW_WEB_SEARCH_TIMEOUT_MS) || 25_000;
}
const NATIVE_SEARCH_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Fixed empirical preference order — see header comment for why this is not
 * driven by `openclaw infer web providers` output. `duckduckgo` is last and
 * needs no credential, so it is the floor every box can reach.
 */
const PROVIDER_PREFERENCE = ['perplexity', 'gemini', 'duckduckgo'] as const;

interface OpenClawSearchCitation {
  title?: string;
  url?: string;
  link?: string;
  source?: string;
  name?: string;
}

interface OpenClawSearchResult {
  content?: string;
  citations?: Array<string | OpenClawSearchCitation>;
}

interface OpenClawSearchEnvelope {
  outputs?: Array<{ result?: OpenClawSearchResult }>;
}

/** Run the `openclaw` CLI and return raw stdout, or null on any failure
 *  (non-zero exit, timeout, spawn error). Never throws — mirrors
 *  `runOpenClawCli()` in src/lib/openclaw/client.ts. */
function runOpenClawCli(args: string[]): Promise<string | null> {
  const bin = process.env.OPENCLAW_CLI_BIN || 'openclaw';
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: getTimeoutMs(), maxBuffer: NATIVE_SEARCH_MAX_BUFFER, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(stdout?.toString() ?? '');
      },
    );
  });
}

/** Map one `outputs[0].result.citations[]` entry to a TavilyResult. The CLI's
 *  citation shape isn't formally documented, so this accepts either a bare
 *  URL string or an object carrying a url/link under a title/name/source —
 *  falling back to the URL itself as the title when none is present. */
function citationToResult(citation: string | OpenClawSearchCitation): TavilyResult | null {
  if (typeof citation === 'string') {
    const url = citation.trim();
    return url ? { title: url, url } : null;
  }
  const url = (citation.url || citation.link || '').trim();
  if (!url) return null;
  const title = (citation.title || citation.name || citation.source || url).trim();
  return { title, url };
}

/** Query one provider. Resolves null (never throws) on any failure so the
 *  caller can try the next provider in PROVIDER_PREFERENCE. */
async function searchWithProvider(
  query: string,
  provider: string,
  opts: TavilySearchOptions,
): Promise<TavilyResponse | null> {
  const stdout = await runOpenClawCli(['infer', 'web', 'search', '--query', query, '--provider', provider, '--json']);
  if (stdout === null) return null;

  let parsed: OpenClawSearchEnvelope;
  try {
    parsed = JSON.parse(stdout) as OpenClawSearchEnvelope;
  } catch {
    return null;
  }

  const result = parsed.outputs?.[0]?.result;
  if (!result) return null;

  const rawCitations = Array.isArray(result.citations) ? result.citations : [];
  const results = rawCitations
    .map(citationToResult)
    .filter((r): r is TavilyResult => r !== null)
    .slice(0, opts.max_results || 5);
  const answer = typeof result.content === 'string' && result.content.trim() ? result.content : undefined;

  // A provider that returned neither an answer nor any results is treated as
  // a failure so the next provider in line gets a chance.
  if (results.length === 0 && !answer) return null;

  return { query, results, answer };
}

/**
 * Fall back to OpenClaw's native web search when no `TAVILY_API_KEY` is
 * configured. Tries `PROVIDER_PREFERENCE` in order; the first provider that
 * returns a usable result wins. Never throws — see header comment.
 */
export async function nativeWebSearchFallback(
  query: string,
  opts: TavilySearchOptions = {},
): Promise<TavilyResponse> {
  for (const provider of PROVIDER_PREFERENCE) {
    try {
      const result = await searchWithProvider(query, provider, opts);
      if (result) return result;
    } catch (err) {
      console.error(`[native-web-search] provider "${provider}" threw for query "${query}": ${(err as Error).message}`);
      // Fall through to the next provider in PROVIDER_PREFERENCE.
    }
  }
  console.error(
    `[native-web-search] all providers (${PROVIDER_PREFERENCE.join(', ')}) failed for query "${query}"; ` +
      `returning an empty result so the caller can proceed without research.`,
  );
  return { query, results: [], answer: undefined };
}
