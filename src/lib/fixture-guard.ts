/**
 * QC-11 — production fixture / simulate bypass guard.
 *
 * The QC scorer, Gemini synthesis, Tavily research and the Operator Research
 * provider adapters each honor a fixture / simulate env var so tests can run
 * deterministically at $0 cost:
 *   - QC_FIXTURE_JSON_PATH          (qc-scorer)          — canned QC verdict
 *   - QC_SIMULATE_PROVIDER_DOWN     (qc-scorer)          — provider-down branch
 *   - GEMINI_FIXTURE_JSON_PATH      (gemini)             — canned SOP JSON
 *   - TAVILY_FIXTURE_JSON_PATH      (tavily)             — canned search results
 *   - PERPLEXITY_FIXTURE_JSON_PATH  (research/providers) — canned answer+citations
 *   - OPENAI_FIXTURE_JSON_PATH      (research/providers) — canned answer+citations
 *   - OLLAMA_FIXTURE_JSON_PATH      (research/providers) — canned answer+citations
 *   - XAI_FIXTURE_JSON_PATH         (research/providers) — canned answer+citations
 *   - X_AI_FIXTURE_JSON_PATH        (research/providers) — historical alias of XAI
 *
 * On a PRODUCTION box these must NEVER be set. A fixture path lets a
 * forged/canned "pass" verdict, a hallucinated SOP, or fabricated research
 * silently bypass real scoring — the entire QC/grounding chain becomes
 * theatre. This module hard-fails when any is present under
 * NODE_ENV === 'production'.
 *
 * CC-resear-001 — why the research vars matter most. The five research vars
 * feed `answer`, `source_urls` and `citation_count` that the search route
 * previously wrote to a DURABLE `research_searches` row AND mirrored to
 * `<vault>/research/YYYY/MM/*.md`, where the Memory full-text index ingests
 * them as genuine cited evidence. Fabricated citations then become the
 * citable ground truth later work builds on. Two separate defects were
 * closed together:
 *   (a) the adapters never called this guard at all, and
 *   (b) FIXTURE_ENV_VARS did not name the research vars, so a diagnostic
 *       sweep reported a box "clean" while fixtures were live.
 * Both halves are fixed here: the vars are named below (detection), and
 * `readFixture()` in src/lib/research/providers.ts now calls
 * assertNoFixtureEnvInProduction() before honoring one (prevention).
 *
 * NODE_ENV is NOT the whole defence. `assertNoFixtureEnvInProduction()` is a
 * no-op outside production by design, but a `next dev` box writes to the SAME
 * mission-control.db and the SAME vault as a production box. So the research
 * path additionally REFUSES the durable write whenever a result is
 * fixture-derived, at every NODE_ENV — see `isFixtureDerived` on
 * ResearchProviderResult and the tripwire in src/lib/research-store.ts.
 *
 * Wiring: each fixture-reading function calls assertNoFixtureEnvInProduction()
 * BEFORE honoring its env var, so the bypass is blocked at point-of-use even
 * if boot-time wiring is missing. For a fail-fast boot assertion, the app's
 * startup hook (src/instrumentation.ts `register()`) should also call this —
 * see the L13 / integrator note in the PR description.
 */

/**
 * Fixture env vars read by the Operator Research provider adapters
 * (src/lib/research/providers.ts). Broken out as its own list because these
 * are the ones whose output carries `source_urls` / `citation_count` into a
 * durable store, so the research path needs to ask "am I serving canned
 * citations right now?" independently of the QC/SOP vars.
 */
export const RESEARCH_FIXTURE_ENV_VARS = [
  'PERPLEXITY_FIXTURE_JSON_PATH',
  'OPENAI_FIXTURE_JSON_PATH',
  'OLLAMA_FIXTURE_JSON_PATH',
  'XAI_FIXTURE_JSON_PATH',
  'X_AI_FIXTURE_JSON_PATH',
] as const;

/** Fixture / simulate env vars that must be unset on a production box. */
export const FIXTURE_ENV_VARS = [
  'QC_FIXTURE_JSON_PATH',
  'QC_SIMULATE_PROVIDER_DOWN',
  'GEMINI_FIXTURE_JSON_PATH',
  'TAVILY_FIXTURE_JSON_PATH',
  ...RESEARCH_FIXTURE_ENV_VARS,
] as const;

/** True when `name` holds a non-empty value in the current environment. */
function isSet(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '';
}

/** Names of any fixture/simulate env vars currently set to a non-empty value. */
export function activeFixtureEnvVars(): string[] {
  return FIXTURE_ENV_VARS.filter(isSet);
}

/**
 * Names of the RESEARCH fixture env vars currently set to a non-empty value.
 * Non-empty means the Operator Research path is serving canned answers and
 * canned `source_urls`, and its output must never reach a durable store.
 */
export function activeResearchFixtureEnvVars(): string[] {
  return RESEARCH_FIXTURE_ENV_VARS.filter(isSet);
}

/**
 * Throw when any fixture/simulate bypass env var is set on a production box.
 * No-op when NODE_ENV !== 'production', so fixtures keep working in dev/test.
 */
export function assertNoFixtureEnvInProduction(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const active = activeFixtureEnvVars();
  if (active.length === 0) return;
  throw new Error(
    `[QC-11] Fixture/simulate bypass env var(s) set in production: ` +
      `${active.join(', ')}. These force canned QC verdicts / SOP drafts / ` +
      `search results and MUST be unset on a live box. Refusing to run the ` +
      `affected path.`,
  );
}
