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
 *   "pass": boolean,          // true only when ALL checks pass
 *   "indeterminate": boolean, // true when any check is UNKNOWN (transient)
 *   "timestamp": "ISO-8601",
 *   "checks": {
 *     "asset_manifest":   { "pass": bool, "detail": string },
 *     "company_branding": { "pass": bool, "detail": string, "indeterminate"?: bool },
 *     "database_path":    { "pass": bool, "detail": string },
 *     "migrations":       { "pass": bool, "detail": string },
 *     "disk_headroom":    { "pass": bool, "detail": string }
 *   }
 * }
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
  checkDatabasePath,
  checkMigrations,
  checkDiskHeadroom,
} from '@/lib/health/deep-checks';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const [assetManifest, companyBranding, databasePath, migrations, diskHeadroom] =
      await Promise.all([
        Promise.resolve(checkAssetManifest()),
        Promise.resolve(checkCompanyBranding()),
        Promise.resolve(checkDatabasePath()),
        Promise.resolve(checkMigrations()),
        checkDiskHeadroom(),
      ]);

    const checks = {
      asset_manifest: assetManifest,
      company_branding: companyBranding,
      database_path: databasePath,
      migrations: migrations,
      disk_headroom: diskHeadroom,
    };

    const allChecks = Object.values(checks);

    // Any indeterminate check → overall indeterminate (UNKNOWN)
    const anyIndeterminate = allChecks.some((c) => c.indeterminate === true);

    // pass = ALL checks pass (indeterminate checks are treated as non-passing)
    const pass = allChecks.every((c) => c.pass === true);

    return NextResponse.json({
      pass,
      indeterminate: anyIndeterminate,
      timestamp: new Date().toISOString(),
      checks,
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
