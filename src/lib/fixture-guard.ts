/**
 * QC-11 — production fixture / simulate bypass guard.
 *
 * The QC scorer, Gemini synthesis, and Tavily research paths each honor a
 * fixture / simulate env var so tests can run deterministically at $0 cost:
 *   - QC_FIXTURE_JSON_PATH       (qc-scorer) — forces a canned QC verdict
 *   - QC_SIMULATE_PROVIDER_DOWN  (qc-scorer) — forces the provider-down branch
 *   - GEMINI_FIXTURE_JSON_PATH   (gemini)    — returns canned SOP JSON
 *   - TAVILY_FIXTURE_JSON_PATH   (tavily)    — returns canned search results
 *
 * On a PRODUCTION box these must NEVER be set. A fixture path lets a
 * forged/canned "pass" verdict, a hallucinated SOP, or fabricated research
 * silently bypass real scoring — the entire QC/grounding chain becomes
 * theatre. This module hard-fails when any is present under
 * NODE_ENV === 'production'.
 *
 * Wiring: each fixture-reading function calls assertNoFixtureEnvInProduction()
 * BEFORE honoring its env var, so the bypass is blocked at point-of-use even
 * if boot-time wiring is missing. For a fail-fast boot assertion, the app's
 * startup hook (src/instrumentation.ts `register()`) should also call this —
 * see the L13 / integrator note in the PR description.
 */

/** Fixture / simulate env vars that must be unset on a production box. */
export const FIXTURE_ENV_VARS = [
  'QC_FIXTURE_JSON_PATH',
  'QC_SIMULATE_PROVIDER_DOWN',
  'GEMINI_FIXTURE_JSON_PATH',
  'TAVILY_FIXTURE_JSON_PATH',
] as const;

/** Names of any fixture/simulate env vars currently set to a non-empty value. */
export function activeFixtureEnvVars(): string[] {
  return FIXTURE_ENV_VARS.filter((name) => {
    const v = process.env[name];
    return typeof v === 'string' && v.trim() !== '';
  });
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
