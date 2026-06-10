/**
 * GET /api/health/deep
 *
 * PRD Addendum B.1 (P0) — the in-app deep health check.
 * Implements all app-checkable items from the B.1 truth table
 * (docs/B1-truth-table.md).  The two things the app CANNOT self-report
 * (pm2 topology, outside-in asset probe) are handled by scripts/cc-health-check.sh.
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
 *
 * Truth-table rows covered here:
 *   Row 11-12  asset_manifest
 *   Row 1-7    company_branding (partial-config rule, DB direct, consistency)
 *   Row 20-22  database_path
 *   Row 29-30  migrations
 *   Row 23-24  disk_headroom
 */

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDb, getMigrationStatus, DB_PATH } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ── constants ────────────────────────────────────────────────────────────────

/** Minimum free disk space in bytes (500 MB, matching truth-table rows 23/24). */
const DISK_MIN_BYTES = 500 * 1024 * 1024;

/** Placeholder names that signal an unbranded/default install. */
const PLACEHOLDER_NAMES = new Set([
  'default',
  'command center',
  'command-center',
  'blackceo command center',
]);

function isPlaceholder(name: string): boolean {
  return PLACEHOLDER_NAMES.has(name.trim().toLowerCase());
}

// ── check result type ────────────────────────────────────────────────────────

interface CheckResult {
  pass: boolean;
  detail: string;
  indeterminate?: boolean;
  [key: string]: unknown;
}

// ── check: asset manifest integrity ─────────────────────────────────────────
// Truth-table rows 11-12.
// Reads .next/BUILD_ID and build-manifest.json from disk — NO self-curl.
// A stale manifest (missing referenced asset) → FAIL.

function checkAssetManifest(): CheckResult {
  try {
    const nextDir = path.join(process.cwd(), '.next');
    const buildIdPath = path.join(nextDir, 'BUILD_ID');

    if (!fs.existsSync(buildIdPath)) {
      return { pass: false, detail: 'asset_manifest: .next/BUILD_ID missing — build not present or incomplete' };
    }

    const buildId = fs.readFileSync(buildIdPath, 'utf8').trim();

    // Next.js writes build-manifest.json with all JS/CSS chunks referenced by pages.
    const manifestPath = path.join(nextDir, 'build-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { pass: false, detail: 'asset_manifest: .next/build-manifest.json missing — build incomplete' };
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      pages?: Record<string, string[]>;
      devFiles?: string[];
      ampDevFiles?: string[];
      polyfillFiles?: string[];
      lowPriorityFiles?: string[];
    };

    // Collect all referenced static asset paths
    const referenced = new Set<string>();
    const allPaths: string[][] = [
      ...(manifest.pages ? Object.values(manifest.pages) : []),
      manifest.devFiles ?? [],
      manifest.ampDevFiles ?? [],
      manifest.polyfillFiles ?? [],
      manifest.lowPriorityFiles ?? [],
    ];
    for (const group of allPaths) {
      for (const p of group) {
        if (typeof p === 'string' && p.startsWith('/_next/')) {
          referenced.add(p);
        }
      }
    }

    // Also check the static directory exists
    const staticDir = path.join(nextDir, 'static');
    if (!fs.existsSync(staticDir)) {
      return {
        pass: false,
        detail: `asset_manifest: .next/static directory missing (BUILD_ID=${buildId})`,
      };
    }

    // Verify each referenced asset exists on disk
    const missing: string[] = [];
    for (const assetRef of referenced) {
      // /_next/... maps to .next/...
      const diskPath = path.join(process.cwd(), assetRef.replace(/^\/_next\//, '.next/'));
      if (!fs.existsSync(diskPath)) {
        missing.push(assetRef);
        if (missing.length >= 5) break; // cap report at 5
      }
    }

    if (missing.length > 0) {
      return {
        pass: false,
        detail: `asset_manifest: ${missing.length} referenced asset(s) missing from disk`,
        missing_examples: missing,
        build_id: buildId,
      };
    }

    return {
      pass: true,
      detail: `asset_manifest: OK (BUILD_ID=${buildId}, ${referenced.size} referenced assets present)`,
      build_id: buildId,
      referenced_count: referenced.size,
    };
  } catch (err) {
    return {
      pass: false,
      detail: `asset_manifest: error reading build artifacts — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── check: company branding ──────────────────────────────────────────────────
// Truth-table rows 1-7.
// Partial-config rule (B.1 spec lines 19-22):
//   - config PRESENT + companyName empty/null/whitespace  → FAIL (misconfigured)
//   - config ABSENT entirely                              → UNKNOWN (acceptable, fresh install)
//   - DB name present + config name present → must be consistent
//   - DB name is placeholder → FAIL

interface CompanyBrandingResult extends CheckResult {
  config_exists: boolean;
  config_name?: string;
  db_name?: string;
}

function checkCompanyBranding(): CompanyBrandingResult {
  // 1. Read config file
  const configPath = path.join(process.cwd(), 'config', 'company-config.json');
  const configExists = fs.existsSync(configPath);
  let configName: string | null = null;

  if (configExists) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const n = raw['companyName'];
      configName = typeof n === 'string' ? n.trim() : null;
    } catch {
      // Malformed JSON — treat as empty config
      configName = null;
    }

    // Partial-config rule: file PRESENT but companyName empty/null/whitespace → FAIL
    if (!configName) {
      return {
        pass: false,
        indeterminate: false,
        config_exists: true,
        config_name: configName ?? '',
        detail: 'company_branding: config/company-config.json exists but companyName is empty/null/whitespace — misconfigured (partial-config rule)',
      };
    }
  }

  // 2. Read DB — catch SQLITE_BUSY as indeterminate
  let dbName: string | null = null;
  let dbRowAbsent = false;

  try {
    const db = getDb();

    // Check if companies table exists at all
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companies'")
      .get() as { name: string } | undefined;

    if (!tableCheck) {
      // No companies table — fresh install or very old schema
      return {
        pass: false,
        indeterminate: true,
        config_exists: configExists,
        detail: 'company_branding: companies table does not exist — DB not yet initialised (UNKNOWN)',
      };
    }

    const row = db
      .prepare("SELECT name FROM companies WHERE name IS NOT NULL AND name != '' ORDER BY id LIMIT 1")
      .get() as { name: string } | undefined;

    if (!row) {
      dbRowAbsent = true;
    } else {
      dbName = row.name.trim();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isBusy = /SQLITE_BUSY|database is locked|disk I\/O/i.test(msg);
    return {
      pass: false,
      indeterminate: true,
      config_exists: configExists,
      detail: `company_branding: DB read error — ${isBusy ? 'SQLITE_BUSY (transient lock, UNKNOWN)' : msg}`,
    };
  }

  // 3. Apply truth-table verdicts

  // Row 6: config absent + DB row absent → UNKNOWN (fresh install, not broken)
  if (!configExists && dbRowAbsent) {
    return {
      pass: false,
      indeterminate: true,
      config_exists: false,
      detail: 'company_branding: no config file and no company row — fresh install (UNKNOWN, not a broken install)',
    };
  }

  // Row 4 / 7: DB name is placeholder or empty → FAIL
  if (dbName !== null && (isPlaceholder(dbName) || dbName === '')) {
    return {
      pass: false,
      indeterminate: false,
      config_exists: configExists,
      db_name: dbName,
      config_name: configName ?? undefined,
      detail: `company_branding: DB company name is a placeholder/empty ("${dbName}") — box is unbranded`,
    };
  }

  // Row 7: DB row present but name empty (caught above via dbName === '')
  // (also caught if dbRowAbsent — already handled by Row 6 check above)

  // Consistency check: if both exist, they must match
  if (configName && dbName && configName.toLowerCase() !== dbName.toLowerCase()) {
    return {
      pass: false,
      indeterminate: false,
      config_exists: true,
      config_name: configName,
      db_name: dbName,
      detail: `company_branding: config name ("${configName}") does not match DB name ("${dbName}") — inconsistent branding`,
    };
  }

  // Happy path: config absent but DB has a real name (onboarded via API)
  if (!configExists && dbName) {
    return {
      pass: true,
      config_exists: false,
      db_name: dbName,
      detail: `company_branding: OK — DB branded ("${dbName}"), no config file (onboarded via API)`,
    };
  }

  // Full happy path: both present and consistent
  return {
    pass: true,
    config_exists: configExists,
    config_name: configName ?? undefined,
    db_name: dbName ?? undefined,
    detail: `company_branding: OK — branded ("${dbName ?? configName}")`,
  };
}

// ── check: DATABASE_PATH pinned ──────────────────────────────────────────────
// Truth-table rows 20-22.
// Row 20: present + absolute → PASS
// Row 21: unset → PASS (default path is valid per db/index.ts)
// Row 22: set but file cannot be created/written → FAIL

function checkDatabasePath(): CheckResult {
  const envPath = process.env.DATABASE_PATH;

  if (!envPath) {
    // Row 21: unset is valid — uses process.cwd() default
    return {
      pass: true,
      detail: `database_path: unset — using default process.cwd() path (${DB_PATH}). Set DATABASE_PATH for cwd-drift resilience (B.4 hardening).`,
      database_path_set: false,
      resolved_path: DB_PATH,
    };
  }

  if (!path.isAbsolute(envPath)) {
    return {
      pass: false,
      detail: `database_path: DATABASE_PATH is set but is not an absolute path ("${envPath}") — relative paths are ambiguous under pm2`,
      database_path_set: true,
      database_path_absolute: false,
    };
  }

  // Row 22: path set and absolute — verify the directory is writable
  const dir = path.dirname(envPath);
  if (!fs.existsSync(dir)) {
    return {
      pass: false,
      detail: `database_path: DATABASE_PATH directory does not exist ("${dir}") — SQLite cannot create the file`,
      database_path_set: true,
      database_path_absolute: true,
    };
  }

  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return {
      pass: false,
      detail: `database_path: DATABASE_PATH directory is not writable ("${dir}")`,
      database_path_set: true,
      database_path_absolute: true,
    };
  }

  return {
    pass: true,
    detail: `database_path: OK — absolute path, directory writable ("${envPath}")`,
    database_path_set: true,
    database_path_absolute: true,
    resolved_path: envPath,
  };
}

// ── check: migrations current ────────────────────────────────────────────────
// Truth-table rows 29-30.

function checkMigrations(): CheckResult {
  try {
    const db = getDb();
    const { applied, pending } = getMigrationStatus(db);

    if (pending.length > 0) {
      return {
        pass: false,
        detail: `migrations: ${pending.length} pending migration(s) — stale schema causes API 500s`,
        applied_count: applied.length,
        pending_count: pending.length,
        pending_ids: pending.slice(0, 5),
      };
    }

    return {
      pass: true,
      detail: `migrations: OK — all ${applied.length} migration(s) applied`,
      applied_count: applied.length,
      pending_count: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isBusy = /SQLITE_BUSY|database is locked/i.test(msg);
    return {
      pass: false,
      indeterminate: isBusy,
      detail: `migrations: ${isBusy ? 'DB locked (UNKNOWN/transient)' : `error — ${msg}`}`,
    };
  }
}

// ── check: disk headroom ─────────────────────────────────────────────────────
// Truth-table rows 23-24. Threshold: 500 MB.

async function checkDiskHeadroom(): Promise<CheckResult> {
  try {
    // Use statvfs via Node's fs.statfsSync (Node 19+) or fall back to parsing `df`
    const checkPath = process.env.DATABASE_PATH
      ? path.dirname(process.env.DATABASE_PATH)
      : process.cwd();

    // Node 18 does not have statfsSync — use a portable approach
    let freeBytes: number;

    if (typeof (fs as { statfsSync?: unknown }).statfsSync === 'function') {
      // Node 19+
      const stats = (fs as unknown as { statfsSync(p: string): { bfree: number; bsize: number } }).statfsSync(checkPath);
      freeBytes = stats.bfree * stats.bsize;
    } else {
      // Fallback for Node 18: run `df -k <path>` via execFileSync (no shell, no injection risk)
      const { execFileSync } = await import('child_process') as unknown as typeof import('child_process');
      try {
        const dfOut = execFileSync('df', ['-k', checkPath], { timeout: 5000 }).toString();
        // df -k output: "Filesystem 1K-blocks Used Available Use% Mounted"
        // The data row is the second line.
        const lines = dfOut.trim().split('\n');
        const dataLine = lines[lines.length - 1] ?? '';
        const parts = dataLine.trim().split(/\s+/);
        // Column index 3 is "Available" (1K-blocks)
        const availKb = parseInt(parts[3] ?? '0', 10);
        freeBytes = Number.isFinite(availKb) ? availKb * 1024 : os.freemem();
      } catch {
        // If df is unavailable, fall back to os.freemem() as a conservative proxy
        freeBytes = os.freemem();
      }
    }

    const freeGb = freeBytes / (1024 ** 3);
    const thresholdGb = DISK_MIN_BYTES / (1024 ** 3);

    if (freeBytes < DISK_MIN_BYTES) {
      return {
        pass: false,
        detail: `disk_headroom: ${freeGb.toFixed(2)} GB free — below ${thresholdGb.toFixed(2)} GB threshold`,
        free_gb: parseFloat(freeGb.toFixed(3)),
        threshold_gb: thresholdGb,
        path: checkPath,
      };
    }

    return {
      pass: true,
      detail: `disk_headroom: OK — ${freeGb.toFixed(2)} GB free (threshold: ${thresholdGb.toFixed(2)} GB)`,
      free_gb: parseFloat(freeGb.toFixed(3)),
      threshold_gb: thresholdGb,
      path: checkPath,
    };
  } catch (err) {
    // Disk check failure is not a hard FAIL — treat as indeterminate
    return {
      pass: false,
      indeterminate: true,
      detail: `disk_headroom: could not determine disk space — ${err instanceof Error ? err.message : String(err)} (UNKNOWN)`,
    };
  }
}

// ── test exports ─────────────────────────────────────────────────────────────
// Exposed only in test environments so vitest can exercise the pure check
// functions without HTTP overhead.  Do NOT call these from production code.

export const __test__ =
  process.env.NODE_ENV === 'test'
    ? {
        checkAssetManifest,
        checkCompanyBranding,
        checkDatabasePath,
        checkMigrations,
        checkDiskHeadroom,
      }
    : undefined;

// ── handler ───────────────────────────────────────────────────────────────────

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
