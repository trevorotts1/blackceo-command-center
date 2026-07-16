/**
 * GET /api/health/deep
 *
 * PRD Addendum B.1 (P0) — the in-app deep health check.
 * Implements all app-checkable items from the B.1 truth table
 * (docs/B1-truth-table.md).  The two things the app CANNOT self-report
 * (pm2 topology, outside-in asset probe) are handled by scripts/cc-health-check.sh.
 *
 * Check functions live in src/lib/health/deep-checks.ts (unit-testable).
 * This file is ONLY the Next.js route handler — no additional exports here
 * to avoid conflicts with Next.js route type checking.
 *
 * Response shape:
 * {
 *   "pass": boolean,          // true only when ALL GATING checks pass
 *   "indeterminate": boolean, // true when any GATING check is UNKNOWN (transient)
 *   "timestamp": "ISO-8601",
 *   "checks": {               // GATING — these determine the green/red verdict
 *     "asset_manifest":   { "pass": bool, "detail": string },
 *     "company_branding": { "pass": bool, "detail": string, "indeterminate"?: bool },
 *     "database_path":    { "pass": bool, "detail": string },
 *     "migrations":       { "pass": bool, "detail": string },
 *     "disk_headroom":    { "pass": bool, "detail": string }
 *   },
 *   "advisory": {             // NON-GATING — reported side-by-side, never gates
 *     "anthology_board_projection": { "pass": bool, "detail": string, ... },
 *     "skill6_board_projection":    { "pass": bool, "detail": string, ... }, // U27 / B-U13
 *     "sweep_liveness":             { "pass": bool, "detail": string, ... },
 *     "trust_coverage":             { "pass": bool, "detail": string, ... }  // U94 / X.2.3
 *   }
 * }
 *
 * GATING vs ADVISORY (A7, extended to Skill 6 by U27 / B-U13):
 *   `checks`  feed the top-level pass/indeterminate verdict that
 *   cc-health-check.sh reads (it consumes ONLY d.pass / d.indeterminate) and
 *   that atomic-deploy.sh (auto-rollback) and standup-heartbeat.sh (task-work
 *   gate) act on. `advisory` entries are EXCLUDED from that aggregation — they
 *   mirror the dual-store embedding_health field in cc-health-check.sh, which
 *   "NEVER changes the green/red verdict or EXIT_CODE". A board-projection
 *   drift is an operational signal (the S0→board mirror needs reconciling), not
 *   a Command Center correctness fault, so it must NEVER trip auto-rollback or
 *   halt the heartbeat — the very thing A7 (and its Skill-6 clone, U27) exists
 *   to detect cannot be allowed to disable the box that detects it.
 *   `sweep_liveness` (C-09 / U40 — "watch the watchers") is the same posture:
 *   an advancer gone silent is an operational alert (routed separately,
 *   cooldown-guarded, via sweep-liveness.ts's own scheduler.ts cron entry),
 *   never a reason to auto-rollback a healthy deploy or halt the heartbeat.
 *
 * Exit / HTTP semantics:
 *   200 + pass=true              → green
 *   200 + pass=false             → definitive red
 *   200 + indeterminate=true     → UNKNOWN (DB locked, server starting, etc.)
 *   500                          → internal error (treat as indeterminate by caller)
 */

import { NextResponse } from 'next/server';
import {
  checkAssetManifest,
  checkCompanyBranding,
  checkHtmlTitle,
  checkDatabasePath,
  checkMigrations,
  checkDiskHeadroom,
  checkNextPublicAppUrl,
  checkAnthologyBoardProjection,
  checkSkill6BoardProjection,
  checkTrustCoverage,
} from '@/lib/health/deep-checks';
import { checkSweepLiveness } from '@/lib/jobs/sweep-liveness';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const [assetManifest, companyBranding, htmlTitle, databasePath, migrations, diskHeadroom, appUrl] =
      await Promise.all([
        Promise.resolve(checkAssetManifest()),
        Promise.resolve(checkCompanyBranding()),
        Promise.resolve(checkHtmlTitle()),
        Promise.resolve(checkDatabasePath()),
        Promise.resolve(checkMigrations()),
        checkDiskHeadroom(),
        Promise.resolve(checkNextPublicAppUrl()),
      ]);

    // GATING checks — these, and only these, feed the pass/indeterminate
    // verdict that the deploy + heartbeat automation acts on.
    const checks = {
      asset_manifest: assetManifest,
      company_branding: companyBranding,
      html_title: htmlTitle,
      database_path: databasePath,
      migrations: migrations,
      disk_headroom: diskHeadroom,
      next_public_app_url: appUrl,
    };

    const gatingChecks = Object.values(checks);

    // Any indeterminate GATING check → overall indeterminate (UNKNOWN)
    const anyIndeterminate = gatingChecks.some((c) => c.indeterminate === true);

    // pass = ALL GATING checks pass (indeterminate checks are treated as non-passing)
    const pass = gatingChecks.every((c) => c.pass === true);

    // NON-GATING ADVISORY (A7) — board-projection drift. Kept OUT of the
    // gatingChecks aggregation above so it can never flip pass/indeterminate,
    // and wrapped in its own try/catch so an unexpected throw here can NEVER
    // reach the outer catch (which would return 500 + pass:false and trip
    // auto-rollback). Any failure degrades the advisory to a self-describing
    // UNKNOWN with pass:true — the verdict stays whatever the gating checks say.
    const advisory: Record<string, unknown> = {};
    try {
      advisory.anthology_board_projection = checkAnthologyBoardProjection();
    } catch (advErr) {
      advisory.anthology_board_projection = {
        pass: true,
        indeterminate: true,
        detail: `anthology_board_projection: advisory probe unavailable — ${
          advErr instanceof Error ? advErr.message : String(advErr)
        } (UNKNOWN; non-gating)`,
      };
    }

    // U27 / B-U13 — Skill-6 board projection drift. Same isolation posture as
    // the Anthology advisory above: wrapped in its own try/catch so a throw
    // here can NEVER reach the outer catch (which would return 500 +
    // pass:false and trip auto-rollback). Kept OUT of gatingChecks — this is
    // a non-gating, read-only diagnostic signal (B-U13: "never flips a box
    // red"), never a Command Center correctness fault.
    try {
      advisory.skill6_board_projection = checkSkill6BoardProjection();
    } catch (advErr) {
      advisory.skill6_board_projection = {
        pass: true,
        indeterminate: true,
        detail: `skill6_board_projection: advisory probe unavailable — ${
          advErr instanceof Error ? advErr.message : String(advErr)
        } (UNKNOWN; non-gating)`,
      };
    }

    // C-09 / U40 — sweep-liveness advisory. Own try/catch for the same reason
    // as the block above: a throw here must NEVER reach the outer catch (which
    // would return 500 + pass:false and could trip auto-rollback/heartbeat-gate
    // consumers that only read d.pass / d.indeterminate).
    try {
      advisory.sweep_liveness = checkSweepLiveness();
    } catch (advErr) {
      advisory.sweep_liveness = {
        pass: true,
        indeterminate: true,
        detail: `sweep_liveness: advisory probe unavailable — ${
          advErr instanceof Error ? advErr.message : String(advErr)
        } (UNKNOWN; non-gating)`,
      };
    }

    // U94 (X.2.3) — trust-coverage advisory. Same isolation posture as the
    // three blocks above: a throw here must NEVER reach the outer catch. A
    // requester-stamping gap is an operational signal (some human-facing
    // door regressed), never a Command Center correctness fault, so it must
    // NEVER trip auto-rollback or halt the heartbeat.
    try {
      advisory.trust_coverage = checkTrustCoverage();
    } catch (advErr) {
      advisory.trust_coverage = {
        pass: true,
        indeterminate: true,
        detail: `trust_coverage: advisory probe unavailable — ${
          advErr instanceof Error ? advErr.message : String(advErr)
        } (UNKNOWN; non-gating)`,
      };
    }

    return NextResponse.json({
      pass,
      indeterminate: anyIndeterminate,
      timestamp: new Date().toISOString(),
      checks,
      advisory,
    });
  } catch (err) {
    return NextResponse.json(
      {
        pass: false,
        indeterminate: true,
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
        checks: {},
      },
      { status: 500 }
    );
  }
}
