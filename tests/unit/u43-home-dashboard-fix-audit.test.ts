/**
 * U43 (C/C-12) part (b) — fleet version/build audit field.
 *
 * Proves the two-signal `home_dashboard_fix_present` decision logic in
 * `src/lib/home-dashboard-fix-audit.ts`: a box is only credited with having
 * the P1-03 home-dashboard fix when BOTH its deployed version is >=
 * MIN_FIXED_VERSION AND its `.next` bundle was built AT OR AFTER its deploy
 * timestamp — never a version stamp alone (the standing content-manifest
 * doctrine U43/U53/U84 all apply to their own fleet audits).
 *
 * Node built-in test runner under tsx (`npm run test:unit`). No DB, no fs,
 * no git required — pure logic only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_FIXED_VERSION,
  parseVersionTuple,
  compareVersionTuples,
  isVersionAtLeastFix,
  isBuildFreshRelativeToDeploy,
  computeHomeDashboardFixAudit,
} from '../../src/lib/home-dashboard-fix-audit';

// ── parseVersionTuple ────────────────────────────────────────────────────────

test('[U43] parseVersionTuple: parses a "v"-prefixed MAJOR.MINOR.PATCH string', () => {
  assert.deepEqual(parseVersionTuple('v6.0.33'), [6, 0, 33]);
});

test('[U43] parseVersionTuple: the "v" prefix is optional', () => {
  assert.deepEqual(parseVersionTuple('5.17.0'), [5, 17, 0]);
});

test('[U43] parseVersionTuple: missing minor/patch segments default to 0', () => {
  assert.deepEqual(parseVersionTuple('v6'), [6, 0, 0]);
  assert.deepEqual(parseVersionTuple('v6.2'), [6, 2, 0]);
});

test('[U43] parseVersionTuple: null/undefined/empty/non-numeric input returns null, never throws', () => {
  assert.equal(parseVersionTuple(null), null);
  assert.equal(parseVersionTuple(undefined), null);
  assert.equal(parseVersionTuple(''), null);
  assert.equal(parseVersionTuple('   '), null);
  assert.equal(parseVersionTuple('not-a-version'), null);
});

// ── compareVersionTuples ─────────────────────────────────────────────────────

test('[U43] compareVersionTuples: equal tuples compare to 0', () => {
  assert.equal(compareVersionTuples([6, 0, 33], [6, 0, 33]), 0);
});

test('[U43] compareVersionTuples: major/minor/patch precedence, in that order', () => {
  assert.ok(compareVersionTuples([6, 0, 0], [5, 99, 99]) > 0, 'major wins over minor/patch');
  assert.ok(compareVersionTuples([6, 1, 0], [6, 0, 99]) > 0, 'minor wins over patch');
  assert.ok(compareVersionTuples([6, 0, 1], [6, 0, 0]) > 0, 'patch decides when major/minor tie');
  assert.ok(compareVersionTuples([5, 17, 0], [6, 0, 0]) < 0);
});

// ── isVersionAtLeastFix ──────────────────────────────────────────────────────

test(`[U43] isVersionAtLeastFix: MIN_FIXED_VERSION is the documented release (${MIN_FIXED_VERSION}) that first ships dashboard-workspaces.ts`, () => {
  assert.equal(MIN_FIXED_VERSION, 'v5.17.0');
});

test('[U43] isVersionAtLeastFix: exactly MIN_FIXED_VERSION is sufficient (>=, not >)', () => {
  assert.equal(isVersionAtLeastFix('v5.17.0'), true);
});

test('[U43] isVersionAtLeastFix: any release after MIN_FIXED_VERSION passes, including a major bump (v6.x)', () => {
  assert.equal(isVersionAtLeastFix('v5.17.1'), true);
  assert.equal(isVersionAtLeastFix('v5.18.0'), true);
  assert.equal(isVersionAtLeastFix('v6.0.33'), true);
});

test('[U43] isVersionAtLeastFix: any release before MIN_FIXED_VERSION fails', () => {
  assert.equal(isVersionAtLeastFix('v5.16.9'), false);
  assert.equal(isVersionAtLeastFix('v5.0.0'), false);
  assert.equal(isVersionAtLeastFix('v4.99.99'), false);
});

test('[U43] isVersionAtLeastFix: unreadable/unparseable/missing deployed version is FALSE, never assumed present', () => {
  assert.equal(isVersionAtLeastFix(null), false);
  assert.equal(isVersionAtLeastFix(undefined), false);
  assert.equal(isVersionAtLeastFix(''), false);
  assert.equal(isVersionAtLeastFix('garbage'), false);
});

// ── isBuildFreshRelativeToDeploy — the converge-missed-`next build` detector ─

test('[U43] isBuildFreshRelativeToDeploy: BUILD_ID mtime AT the deploy timestamp is fresh (>=, not >)', () => {
  assert.equal(isBuildFreshRelativeToDeploy(1_000, 1_000), true);
});

test('[U43] isBuildFreshRelativeToDeploy: BUILD_ID mtime AFTER the deploy timestamp is fresh', () => {
  assert.equal(isBuildFreshRelativeToDeploy(2_000, 1_000), true);
});

test('[U43] isBuildFreshRelativeToDeploy: BUILD_ID mtime BEFORE the deploy timestamp is STALE — the exact converge-skipped-next-build defect class', () => {
  assert.equal(isBuildFreshRelativeToDeploy(500, 1_000), false);
});

test('[U43] isBuildFreshRelativeToDeploy: missing/non-finite inputs are FALSE, never treated as fresh', () => {
  assert.equal(isBuildFreshRelativeToDeploy(null, 1_000), false);
  assert.equal(isBuildFreshRelativeToDeploy(1_000, null), false);
  assert.equal(isBuildFreshRelativeToDeploy(undefined, undefined), false);
  assert.equal(isBuildFreshRelativeToDeploy(Number.NaN, 1_000), false);
  assert.equal(isBuildFreshRelativeToDeploy(1_000, Number.POSITIVE_INFINITY), false);
});

// ── computeHomeDashboardFixAudit — the combined ledger field ────────────────

test('[U43] computeHomeDashboardFixAudit: TRUE only when version_ok AND build_fresh both hold', () => {
  const result = computeHomeDashboardFixAudit({
    deployedVersion: 'v6.0.33',
    buildIdMtimeEpochSec: 2_000,
    deployTimestampEpochSec: 1_000,
    deployTimestampSource: 'git-fetch-head',
  });
  assert.equal(result.home_dashboard_fix_present, true);
  assert.equal(result.version_ok, true);
  assert.equal(result.build_fresh, true);
  assert.equal(result.deploy_timestamp_source, 'git-fetch-head');
});

test('[U43] computeHomeDashboardFixAudit: FALSE when version is new enough but the build is stale (version stamp WITHOUT content — the exact case this doctrine forbids)', () => {
  const result = computeHomeDashboardFixAudit({
    deployedVersion: 'v6.0.33',
    buildIdMtimeEpochSec: 500,
    deployTimestampEpochSec: 1_000,
    deployTimestampSource: 'git-fetch-head',
  });
  assert.equal(result.home_dashboard_fix_present, false);
  assert.equal(result.version_ok, true);
  assert.equal(result.build_fresh, false);
  assert.match(result.detail, /converge likely skipped "next build"/);
});

test('[U43] computeHomeDashboardFixAudit: FALSE when the build is fresh but the version predates the fix (a fresh build of OLD source)', () => {
  const result = computeHomeDashboardFixAudit({
    deployedVersion: 'v5.10.0',
    buildIdMtimeEpochSec: 5_000,
    deployTimestampEpochSec: 1_000,
    deployTimestampSource: 'git-head',
  });
  assert.equal(result.home_dashboard_fix_present, false);
  assert.equal(result.version_ok, false);
  assert.equal(result.build_fresh, true);
});

test('[U43] computeHomeDashboardFixAudit: FALSE when both signals fail', () => {
  const result = computeHomeDashboardFixAudit({
    deployedVersion: 'v4.0.0',
    buildIdMtimeEpochSec: null,
    deployTimestampEpochSec: null,
    deployTimestampSource: 'unavailable',
  });
  assert.equal(result.home_dashboard_fix_present, false);
  assert.equal(result.version_ok, false);
  assert.equal(result.build_fresh, false);
  assert.match(result.detail, /deploy timestamp undeterminable/);
});

test('[U43] computeHomeDashboardFixAudit: result always carries the exact BINARY-acceptance field name `home_dashboard_fix_present`', () => {
  const result = computeHomeDashboardFixAudit({
    deployedVersion: 'v6.0.33',
    buildIdMtimeEpochSec: 2_000,
    deployTimestampEpochSec: 1_000,
    deployTimestampSource: 'git-log-head-commit',
  });
  assert.ok('home_dashboard_fix_present' in result);
  assert.equal(typeof result.home_dashboard_fix_present, 'boolean');
});
