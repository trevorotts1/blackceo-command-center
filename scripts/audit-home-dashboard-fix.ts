#!/usr/bin/env tsx
/**
 * audit-home-dashboard-fix.ts — C-12 / U43 part (b): the "fleet version/build
 * audit field" for the home-dashboard "missing cards" fix.
 *
 * READ-ONLY. Makes zero writes, zero deploys, zero restarts. Prints one JSON
 * line to stdout: `{ home_dashboard_fix_present, version_ok, build_fresh,
 * deploy_timestamp_source, detail, ... }` — the exact ledger field BINARY
 * acceptance (b) names, for THIS box's checkout.
 *
 * Designed to be called by the future C-05 fleet sweep/ledger script as its
 * "one extra field" per box (U43's dependency: "shares the sweep/ledger").
 * Until C-05 exists, this script is fully self-contained and can be run
 * standalone against any box's CC checkout:
 *
 *   npx tsx scripts/audit-home-dashboard-fix.ts [--repo-root <path>]
 *
 * All the branching logic lives in the pure, unit-tested
 * `src/lib/home-dashboard-fix-audit.ts` — this file only gathers the three
 * real-world inputs (deployed version string, `.next/BUILD_ID` mtime, and a
 * deploy-timestamp proxy) and hands them to that module. Mirrors this repo's
 * established I/O-vs-pure-logic split (see `scripts/cc-health-check.sh` +
 * `scripts/pm2-analyze-cc.py`, and `src/app/page.tsx` +
 * `src/lib/dashboard-workspaces.ts`).
 *
 * Deploy-timestamp proxy: per `DEPLOYMENT.md`'s own documented detector
 * ("`.next/BUILD_ID` mtime newer than the pull timestamp"), this reads
 * `.git/FETCH_HEAD` mtime (updated by every `git pull`/`fetch`) as the
 * canonical in-checkout proxy for "when was this box's source last updated,"
 * falling back to `.git/HEAD` mtime, then to the HEAD commit's own timestamp,
 * so the audit degrades gracefully rather than crashing on an unusual
 * checkout layout — never a silent guess (the source actually used is always
 * reported in `deploy_timestamp_source`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  computeHomeDashboardFixAudit,
  type HomeDashboardFixAuditInput,
} from '../src/lib/home-dashboard-fix-audit';

function readRepoRoot(): string {
  const idx = process.argv.indexOf('--repo-root');
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  return process.cwd();
}

function readDeployedVersion(repoRoot: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'version'), 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function readMtimeEpochSec(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    return Math.floor(stat.mtimeMs / 1000);
  } catch {
    return null;
  }
}

function readDeployTimestamp(
  repoRoot: string,
): { epochSec: number | null; source: HomeDashboardFixAuditInput['deployTimestampSource'] } {
  const fetchHead = readMtimeEpochSec(path.join(repoRoot, '.git', 'FETCH_HEAD'));
  if (fetchHead !== null) return { epochSec: fetchHead, source: 'git-fetch-head' };

  const gitHead = readMtimeEpochSec(path.join(repoRoot, '.git', 'HEAD'));
  if (gitHead !== null) return { epochSec: gitHead, source: 'git-head' };

  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    const parsed = Number(out);
    if (Number.isFinite(parsed) && out) return { epochSec: parsed, source: 'git-log-head-commit' };
  } catch {
    // fall through to unavailable
  }
  return { epochSec: null, source: 'unavailable' };
}

function main(): void {
  const repoRoot = readRepoRoot();
  const deployedVersion = readDeployedVersion(repoRoot);
  const buildIdMtimeEpochSec = readMtimeEpochSec(path.join(repoRoot, '.next', 'BUILD_ID'));
  const { epochSec: deployTimestampEpochSec, source: deployTimestampSource } =
    readDeployTimestamp(repoRoot);

  const result = computeHomeDashboardFixAudit({
    deployedVersion,
    buildIdMtimeEpochSec,
    deployTimestampEpochSec,
    deployTimestampSource,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        check: 'home_dashboard_fix_present',
        repo_root: repoRoot,
        deployed_version: deployedVersion,
        build_id_mtime_epoch_sec: buildIdMtimeEpochSec,
        deploy_timestamp_epoch_sec: deployTimestampEpochSec,
        ...result,
      },
      null,
      2,
    )}\n`,
  );
  // Read-only diagnostic: never a non-zero exit for "fix absent" (that's a
  // ledger row, not a script failure) — mirrors /api/version's "never throws,
  // never fails the caller" convention. A hard I/O error would already have
  // surfaced as `false` fields above, not an exception.
  process.exit(0);
}

main();
