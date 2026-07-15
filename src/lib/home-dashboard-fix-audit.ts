/**
 * Fleet version/build audit field for the home-dashboard "missing cards" fix
 * (C-12 / U43 part (b) of the Skill 6 blended-persona-kanban v2 spec).
 *
 * P1-03 (`src/lib/dashboard-workspaces.ts`) is VERIFIED shipped in-repo with
 * its own unit-test suite (`tests/unit/p1-03-dashboard-workspaces.test.ts`).
 * What is UNVERIFIED per box is deployment reality: the recorded fleet trap
 * (operator-memory incident) is that a converge/update run can `git pull` a
 * box onto a release containing the fix WITHOUT actually re-running
 * `next build` — the box then serves a STALE pre-fix `.next` bundle while its
 * version stamp claims it has the fix. Per the standing content-manifest
 * doctrine ("verify content manifests, never a version stamp alone" — the
 * same doctrine U84 and U53 apply to their own fleet audits), a version
 * number alone is NEVER sufficient proof; this module intentionally requires
 * TWO independent signals before it will call the fix "present":
 *
 *   1. `versionOk`  — the box's deployed `version` file is >= the release
 *      that FIRST contained `src/lib/dashboard-workspaces.ts` (proves the
 *      SOURCE has the fix).
 *   2. `buildFresh` — the box's built `.next/BUILD_ID` mtime is >= the
 *      box's own deploy/pull timestamp (proves the BUNDLE was actually
 *      rebuilt from that source, not carried over stale from before the
 *      pull — the exact "converge skipped next build" defect class).
 *
 * `home_dashboard_fix_present` is true only when BOTH hold. Pure decision
 * logic only (no fs/git I/O) so it is unit-testable without a real box or a
 * git checkout — mirrors the `dashboard-workspaces.ts` extraction pattern in
 * this same file's neighborhood. The I/O gathering (reading `version`,
 * `.next/BUILD_ID` mtime, and the deploy-timestamp proxy) lives in
 * `scripts/audit-home-dashboard-fix.ts`, a thin, read-only, per-box wrapper
 * designed to plug into the future C-05 fleet sweep/ledger as its "one extra
 * field" (per U43's stated dependency on C-05's shared sweep) without this
 * unit needing C-05 to exist yet.
 *
 * NEVER throws — every function here degrades to a safe `false` + an
 * explanatory `detail` string rather than raising, so a malformed or partial
 * per-box read can never crash the audit sweep that calls it.
 */

/**
 * The release that FIRST contains `src/lib/dashboard-workspaces.ts` (commit
 * `b2bf968d`, "fix(dashboard): P1-03 — producer-card fail-LOUD-but-graceful,
 * version stamp, interview-lock copy", 2026-07-11). Verified via
 * `git log --diff-filter=A --follow -- src/lib/dashboard-workspaces.ts` and
 * `git tag --contains b2bf968d` (earliest containing tag: v5.17.0). A box on
 * this version or later has the fix in its SOURCE tree.
 */
export const MIN_FIXED_VERSION = 'v5.17.0';

/**
 * Parse a `vMAJOR.MINOR.PATCH`-shaped version string (the `v` prefix is
 * optional and stripped; the CC repo's own `/version` file always carries
 * it — see `scripts/bump-version.sh`). Non-numeric or missing segments parse
 * as `0`. Returns `null` (never throws) for a string with no digits at all.
 */
export function parseVersionTuple(version: string | null | undefined): [number, number, number] | null {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * Compares two version tuples. Returns >0 if `a` > `b`, <0 if `a` < `b`, 0 if
 * equal. Pure numeric [major, minor, patch] comparison — no pre-release/build
 * metadata handling, matching this repo's own `vMAJOR.MINOR.PATCH`-only
 * versioning (see `scripts/bump-version.sh`'s header comment).
 */
export function compareVersionTuples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * `true` iff `deployedVersion` is parseable AND >= `MIN_FIXED_VERSION`.
 * `false` (never throws) for an unparseable/missing version — an audit can
 * never treat "I don't know the version" as "the fix is present."
 */
export function isVersionAtLeastFix(
  deployedVersion: string | null | undefined,
  minFixedVersion: string = MIN_FIXED_VERSION,
): boolean {
  const deployed = parseVersionTuple(deployedVersion);
  const min = parseVersionTuple(minFixedVersion);
  if (!deployed || !min) return false;
  return compareVersionTuples(deployed, min) >= 0;
}

/**
 * `true` iff the built `.next/BUILD_ID` mtime is >= the box's deploy/pull
 * timestamp — i.e. the bundle was actually rebuilt AT OR AFTER the pull that
 * brought the fixed source in, not carried over from before it (the
 * converge-missed-`next build` defect class this unit exists to catch).
 * Both timestamps are epoch seconds. `false` (never throws) when either is
 * missing/non-finite — an audit can never treat "I don't know" as "fresh."
 */
export function isBuildFreshRelativeToDeploy(
  buildIdMtimeEpochSec: number | null | undefined,
  deployTimestampEpochSec: number | null | undefined,
): boolean {
  if (
    typeof buildIdMtimeEpochSec !== 'number' ||
    typeof deployTimestampEpochSec !== 'number' ||
    !Number.isFinite(buildIdMtimeEpochSec) ||
    !Number.isFinite(deployTimestampEpochSec)
  ) {
    return false;
  }
  return buildIdMtimeEpochSec >= deployTimestampEpochSec;
}

export interface HomeDashboardFixAuditInput {
  /** This box's `version` file contents (e.g. `"v6.0.33"`), or `null` if unreadable. */
  deployedVersion: string | null;
  /** `.next/BUILD_ID` mtime, epoch seconds, or `null` if the file is absent/unreadable. */
  buildIdMtimeEpochSec: number | null;
  /** This box's deploy/pull-timestamp proxy, epoch seconds, or `null` if undeterminable. */
  deployTimestampEpochSec: number | null;
  /** Where `deployTimestampEpochSec` came from (audit transparency — never a silent guess). */
  deployTimestampSource: 'git-fetch-head' | 'git-head' | 'git-log-head-commit' | 'unavailable';
}

export interface HomeDashboardFixAuditResult {
  /** BINARY acceptance (b)'s exact field name — `true` only when BOTH signals hold. */
  home_dashboard_fix_present: boolean;
  version_ok: boolean;
  build_fresh: boolean;
  deploy_timestamp_source: HomeDashboardFixAuditInput['deployTimestampSource'];
  detail: string;
}

/**
 * Combine the two independent per-box signals into the single
 * `home_dashboard_fix_present` field the C-05 ledger's per-box row carries
 * (BINARY acceptance (b)). Requires BOTH `version_ok` and `build_fresh` —
 * either alone is exactly the "stamp without content" failure mode this
 * doctrine forbids.
 */
export function computeHomeDashboardFixAudit(
  input: HomeDashboardFixAuditInput,
): HomeDashboardFixAuditResult {
  const version_ok = isVersionAtLeastFix(input.deployedVersion);
  const build_fresh = isBuildFreshRelativeToDeploy(
    input.buildIdMtimeEpochSec,
    input.deployTimestampEpochSec,
  );
  const home_dashboard_fix_present = version_ok && build_fresh;

  const reasons: string[] = [];
  if (!version_ok) {
    reasons.push(
      `deployed version ${JSON.stringify(input.deployedVersion)} is below ${MIN_FIXED_VERSION} (the release that first contains dashboard-workspaces.ts) or unparseable`,
    );
  }
  if (!build_fresh) {
    if (input.deployTimestampSource === 'unavailable') {
      reasons.push('deploy timestamp undeterminable on this box (no .git/FETCH_HEAD, .git/HEAD, or HEAD commit readable)');
    } else if (input.buildIdMtimeEpochSec === null) {
      reasons.push('.next/BUILD_ID is absent or unreadable on this box (never built, or the build output was removed)');
    } else {
      reasons.push(
        `.next/BUILD_ID mtime (${String(input.buildIdMtimeEpochSec)}) predates the deploy timestamp (${String(input.deployTimestampEpochSec)}, source: ${input.deployTimestampSource}) — converge likely skipped "next build"`,
      );
    }
  }
  const detail = home_dashboard_fix_present
    ? `fix present: version ${input.deployedVersion} >= ${MIN_FIXED_VERSION} AND .next build is fresh relative to deploy (source: ${input.deployTimestampSource})`
    : `fix NOT confirmed present: ${reasons.join('; ')}`;

  return { home_dashboard_fix_present, version_ok, build_fresh, deploy_timestamp_source: input.deployTimestampSource, detail };
}
