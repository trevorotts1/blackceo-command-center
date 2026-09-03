/**
 * OpenClaw CLI mechanics for the smart web-research selector in `tavily.ts`.
 *
 * THE DEFECT this closes: `tavilySearch()` used to throw when
 * `TAVILY_API_KEY` was unset, with no other path to a search result. Every
 * box in the fleet without a Tavily key therefore had a silently-dead SOP
 * pipeline — `sop-authoring.ts`'s dispatch-time "Author SOP" loop and
 * `sop-auto-replace.ts`'s Track S both call `tavilySearch()` directly and
 * neither can proceed without it.
 *
 * THE FIX (v2 — capability detection, not a static preference list): rather
 * than privileging Tavily, `tavilySearch()` in `./tavily.ts` now detects
 * what web-research capability a given box actually has, at runtime, and
 * uses the best available one. This module supplies the two OpenClaw-CLI
 * primitives that selector needs:
 *
 *   - `discoverOpenClawProviders()` — `openclaw infer web providers --json`,
 *     so the selector can find whatever this box's OpenClaw natively offers
 *     (a box with Ollama Cloud has Ollama's own web search; another box may
 *     have Gemini's grounded search) instead of assuming a fixed list.
 *   - `searchViaOpenClawProvider(query, provider, opts)` —
 *     `openclaw infer web search --query "<q>" --provider <p> --json` for
 *     ONE named provider (perplexity, duckduckgo, or anything discovered).
 *
 * Both shell out via the same `execFile(bin, args, { timeout, maxBuffer,
 * windowsHide })` promise-wrapped pattern already established by
 * `runOpenClawCli()` in `src/lib/openclaw/client.ts` and the CLI detection
 * helpers in `src/lib/bridge/cli-manager.ts`. `OPENCLAW_CLI_BIN` (already
 * used by client.ts) overrides the binary path — also the test seam here.
 *
 * "CONFIGURED" IS A CLAIM, NOT A FACT. `openclaw infer web providers` can
 * report a provider `configured: true` while a live call to it fails —
 * proven live: it reported `ollama` configured while a real search returned
 * `Error: Ollama web search authentication failed. Run 'ollama signin'.`,
 * and a Gemini-backed call can return HTTP 429 "Your prepayment credits are
 * depleted." Both failure shapes can arrive as a structurally normal-looking
 * response (exit 0, valid JSON, non-empty `content`) — an auth/billing error
 * dressed up as if it were a real research answer. So `searchViaOpenClawProvider`
 * does two things a naive "did it return something" check would miss:
 *   1. Scans the raw CLI output for known auth/quota/billing failure
 *      signatures (`looksLikeUnusableProviderOutput`) BEFORE trusting it as
 *      a real answer.
 *   2. THROWS on any failure (bad exit/timeout, malformed JSON, no
 *      result envelope, an unusable-signature hit, or no results/no answer)
 *      instead of silently returning null, so the caller in `tavily.ts` can
 *      catch it, log clearly, cache the provider as unusable for a short
 *      TTL, and move on to the next one — the same treatment it gives a
 *      failing Tavily call.
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

// ── auth/quota/billing failure detection ────────────────────────────────────

/**
 * Text signatures of a provider that is CONFIGURED but NOT USABLE — an
 * expired trial, a depleted prepaid balance, an unauthenticated CLI session,
 * a bad/rotated key. Two of these are reproduced verbatim from live failures
 * (Gemini billing, Ollama auth); the rest are generic HTTP auth/quota
 * vocabulary so a provider we haven't personally seen fail yet is still
 * caught by the same check.
 */
const UNUSABLE_OUTPUT_SIGNATURES: RegExp[] = [
  /prepayment credits/i,
  /credits?\s+(are|is)\s+depleted/i,
  /authentication failed/i,
  /run ['"]?ollama signin/i,
  /\bunauthorized\b/i,
  /invalid api key/i,
  /api key not valid/i,
  /insufficient (credits?|balance|quota)/i,
  /quota exceeded/i,
  /rate limit/i,
  /\bbilling\b/i,
  /payment required/i,
  /\b(401|403|429)\b/,
];

/**
 * True when `text` (raw CLI stdout, or just the extracted answer/content)
 * carries a known auth/quota/billing failure signature. Exported so
 * `tavily.ts` and tests can reuse the exact same check.
 */
export function looksLikeUnusableProviderOutput(text: string): boolean {
  if (!text) return false;
  return UNUSABLE_OUTPUT_SIGNATURES.some((re) => re.test(text));
}

// ── `openclaw infer web providers` discovery ────────────────────────────────

export interface DiscoveredProvider {
  id: string;
  /** From the CLI's own `configured`/`available`/`enabled` field — a CLAIM,
   *  not proof the provider will actually work (see header comment). */
  configured: boolean;
}

/**
 * Lenient parse of `openclaw infer web providers --json`. The shape isn't
 * formally documented the way `infer web search`'s is
 * (`outputs[0].result.{content,citations}`), so this accepts several
 * plausible shapes: a bare array, `{ providers: [...] }`, or the same
 * `outputs[0].result.providers` envelope the search command uses. Each
 * element may be a bare provider-name string (treated as configured) or an
 * object carrying an id/name/provider field plus a configured/available/
 * enabled flag.
 */
function parseProvidersListing(parsed: unknown): DiscoveredProvider[] {
  let candidates: unknown;
  if (Array.isArray(parsed)) {
    candidates = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const root = parsed as Record<string, unknown>;
    if (Array.isArray(root.providers)) {
      candidates = root.providers;
    } else {
      const outputs = root.outputs;
      const firstResult = Array.isArray(outputs)
        ? (outputs[0] as Record<string, unknown> | undefined)?.result
        : undefined;
      const nestedProviders = (firstResult as Record<string, unknown> | undefined)?.providers;
      if (Array.isArray(nestedProviders)) candidates = nestedProviders;
    }
  }

  const list = Array.isArray(candidates) ? candidates : [];
  const out: DiscoveredProvider[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ id: item.trim(), configured: true });
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const idRaw = obj.id ?? obj.name ?? obj.provider;
      if (typeof idRaw === 'string' && idRaw.trim()) {
        const configuredRaw = obj.configured ?? obj.available ?? obj.enabled;
        out.push({ id: idRaw.trim(), configured: configuredRaw !== false });
      }
    }
  }
  return out;
}

/**
 * Discover what web-research providers THIS box's OpenClaw natively offers.
 * Never throws — an absent/failing/malformed CLI just yields an empty list,
 * so the selector in tavily.ts falls through to its next tier.
 */
export async function discoverOpenClawProviders(): Promise<DiscoveredProvider[]> {
  const stdout = await runOpenClawCli(['infer', 'web', 'providers', '--json']);
  if (stdout === null) return [];
  try {
    return parseProvidersListing(JSON.parse(stdout));
  } catch {
    return [];
  }
}

// ── one provider search ──────────────────────────────────────────────────────

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

/**
 * Query ONE named provider via `openclaw infer web search`. THROWS (does not
 * swallow) on any failure — CLI absent/non-zero exit/timeout, malformed
 * JSON, a missing result envelope, a detected auth/quota/billing failure
 * signature, or an empty answer+no-results response — so the orchestrator in
 * `tavily.ts` can catch it, cache this provider as unusable for a short TTL,
 * log clearly, and move on to the next tier. This mirrors how
 * `tavilySearchViaTavily()` already throws on its own failures; the
 * "never throw" guarantee for the fire-and-forget SOP paths lives ONE level
 * up, in `tavilySearch()`'s tier loop, not here.
 */
export async function searchViaOpenClawProvider(
  query: string,
  provider: string,
  opts: TavilySearchOptions = {},
): Promise<TavilyResponse> {
  const stdout = await runOpenClawCli(['infer', 'web', 'search', '--query', query, '--provider', provider, '--json']);
  if (stdout === null) {
    throw new Error(`provider "${provider}" CLI call failed (absent, non-zero exit, or timeout)`);
  }
  if (looksLikeUnusableProviderOutput(stdout)) {
    throw new Error(`provider "${provider}" reported an auth/quota/billing failure: ${stdout.slice(0, 200)}`);
  }

  let parsed: OpenClawSearchEnvelope;
  try {
    parsed = JSON.parse(stdout) as OpenClawSearchEnvelope;
  } catch {
    throw new Error(`provider "${provider}" returned malformed JSON`);
  }

  const result = parsed.outputs?.[0]?.result;
  if (!result) {
    throw new Error(`provider "${provider}" returned no result envelope`);
  }

  const rawCitations = Array.isArray(result.citations) ? result.citations : [];
  const results = rawCitations
    .map(citationToResult)
    .filter((r): r is TavilyResult => r !== null)
    .slice(0, opts.max_results || 5);
  const answer = typeof result.content === 'string' && result.content.trim() ? result.content : undefined;

  if (answer && looksLikeUnusableProviderOutput(answer)) {
    throw new Error(`provider "${provider}" answer looks like an auth/quota/billing failure, not real content`);
  }
  if (results.length === 0 && !answer) {
    throw new Error(`provider "${provider}" returned no usable results`);
  }

  return { query, results, answer };
}
