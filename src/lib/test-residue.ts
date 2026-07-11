/**
 * Test / fixture residue — shared source of truth (C8).
 *
 * A QC/smoke-test harness once wrote directly against the LIVE Command Center
 * DB (no DATABASE_PATH isolation) and left behind synthetic SOPs, workspaces,
 * and a company that must never surface on a real client's board or API:
 *   - 30 `sops` rows keyed to department `test-dept` ("Dims Test SOP A/B",
 *     "Stale Embed SOP", "Model Drift Test SOP", ...).
 *   - `workspaces` rows `smoke-test-dept` / `no-script-dept` (7 fixture agents
 *     each).
 *   - a `testco` company (role-library-import ingest root candidate).
 *
 * THREE layers are built on this module, deliberately kept separate so a real
 * client department can never be nuked by accident:
 *
 *   1. INGEST GUARD — never CREATE residue. `TEST_RESIDUE_INGEST_SKIP_SLUGS`
 *      (exact match only) makes reseedWorkspacesFromConfig / discoverRoleHowTos
 *      refuse to re-seed a fixture workspace from a stale departments.json, or
 *      re-ingest a leftover `departments/<slug>/` directory back into `sops`.
 *
 *   2. CLEANUP — DELETE residue already in the DB. The EXACT allowlists below
 *      (`TEST_RESIDUE_*`) are the ONLY values ever eligible for (a) silent
 *      exclusion from a client-facing API response and (b) automated DELETION
 *      by a cleanup migration (rekeyAndPurgeGhostSops / purgeTestResidue-
 *      Workspaces / purgeTestResidueCompanies in lib/db/migrations.ts). A
 *      literal client department named "testing-lab" or "contest-dept" is NEVER
 *      on this list and must never collide with it.
 *
 *   3. DETECTION — FAIL LOUD on whatever is left. `isTestResidueSlug` matches
 *      `TEST_RESIDUE_DETECT_PATTERN` OR the exact allowlist, and drives the
 *      converge assertion + QC. It is broader than the delete allowlists on
 *      purpose, so a NEW leak shape gets triaged by a human. It must never
 *      drive an automated delete — a "testing-lab" dept legitimately matching
 *      the pattern should surface for review, not vanish.
 *
 * Layer 1 is what makes layer 3 SATISFIABLE: without it, converge re-creates
 * the very residue it then fails on, and the gate becomes a permanent 500 that
 * no migration can clear.
 */

/** Exact SOP `department` values that are pure test-harness residue. */
export const TEST_RESIDUE_SOP_DEPARTMENTS = ['test-dept'] as const;

/** Exact `workspaces.slug` values that are pure test-harness residue. */
export const TEST_RESIDUE_WORKSPACE_SLUGS = ['smoke-test-dept', 'no-script-dept'] as const;

/** Exact `companies.slug` values that are pure test-harness residue. */
export const TEST_RESIDUE_COMPANY_SLUGS = ['testco'] as const;

/**
 * DETECTION-ONLY regex: a slug is "test/fixture-shaped" when `test`, `smoke`,
 * `dims`, or `fixture` appears as its OWN hyphen/underscore-delimited token —
 * a bare substring match would false-positive on a legitimate department like
 * "testing-lab" or "contest-dept" (the exact risk this codebase has hit
 * before); this token-boundary form does NOT flag either of those. It exists
 * purely to surface a NEW, not-yet-allowlisted leak shape (e.g. "test-foo",
 * "smoke-bar") for an operator to triage — it is intentionally NARROWER than
 * a delete-safe check would need to be, so it can be used for FAILING LOUD
 * without also being safe to wire into a delete path (never do that — use the
 * exact allowlists above for any deletion).
 */
export const TEST_RESIDUE_DETECT_PATTERN = /(^|[-_])(test|smoke|dims|fixture)([-_]|$)/i;

/**
 * Is `slug` test/fixture residue for the given EXACT allowlist?
 *
 * pattern OR exact-allowlist — and BOTH halves are load-bearing:
 *
 *   - The pattern alone is BLIND to an allowlisted slug that doesn't happen to
 *     contain a test-shaped token. `no-script-dept` is the live proof: it IS on
 *     TEST_RESIDUE_WORKSPACE_SLUGS and IS hard-deleted by migration 093, yet
 *     TEST_RESIDUE_DETECT_PATTERN does NOT match it ("no", "script", "dept" are
 *     none of test/smoke/dims/fixture). A pattern-only detector therefore lets
 *     known, already-allowlisted residue ride onto a client board whenever the
 *     cleanup migration is deferred or skipped — exactly the leak this gate
 *     exists to catch.
 *
 *   - The exact allowlist alone would only ever see residue somebody already
 *     knew about, so a NEW leak shape ("test-foo", "smoke-bar") would ship
 *     silently.
 *
 * Detection stays STRICTLY separate from deletion: this function may FAIL LOUD
 * on a hit, but only the exact `TEST_RESIDUE_*` allowlists ever authorize a
 * delete. A client dept legitimately named "testing-lab" matches neither.
 */
export function isTestResidueSlug(
  slug: string | null | undefined,
  exactAllowlist: readonly string[],
): boolean {
  if (!slug) return false;
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return false;
  return (
    TEST_RESIDUE_DETECT_PATTERN.test(normalized) || exactAllowlist.includes(normalized)
  );
}

/**
 * Every EXACT residue slug across all three tables, as one set.
 *
 * Used by the INGEST guards (reseedWorkspacesFromConfig, discoverRoleHowTos) to
 * refuse to (re-)create residue from a stale on-disk departments.json / a
 * leftover `departments/<slug>/` directory. This is the third layer of the C8
 * design and the one that makes the fail-loud converge gate SATISFIABLE:
 *
 *   ingest guard (this set)  — never CREATE residue        (exact match only)
 *   migrations 091/093/094   — DELETE residue already there (exact match only)
 *   detect + converge gate   — FAIL LOUD on what's left     (pattern OR exact)
 *
 * Without the ingest layer, converge Step 1 re-seeds `smoke-test-dept` from a
 * stale departments.json and Step 2 re-ingests `departments/smoke-test-dept/`
 * back into `sops` — so Step 2.5 would detect residue that converge ITSELF just
 * recreated and 500 forever, with no migration able to fix it. A gate that
 * fails on state its own run regenerates is a brick, not a gate.
 */
export const TEST_RESIDUE_INGEST_SKIP_SLUGS: readonly string[] = [
  ...TEST_RESIDUE_SOP_DEPARTMENTS,
  ...TEST_RESIDUE_WORKSPACE_SLUGS,
];

/** Should the ingest path refuse to (re-)create a department/workspace with this slug? */
export function isTestResidueIngestSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return TEST_RESIDUE_INGEST_SKIP_SLUGS.includes(slug.trim().toLowerCase());
}
