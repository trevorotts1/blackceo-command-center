/**
 * B.1 deep health check functions — extracted from /api/health/deep/route.ts
 * so they can be imported and unit-tested without Next.js route constraints.
 *
 * The route file (src/app/api/health/deep/route.ts) re-exports these via
 * a named re-export so callers can do:
 *   import { checkAssetManifest, ... } from '@/lib/health/deep-checks';
 *
 * Truth-table rows covered:
 *   Rows 11-12  asset_manifest
 *   Rows 1-7    company_branding (partial-config rule, DB direct, consistency)
 *   Rows 20-22  database_path
 *   Rows 29-30  migrations
 *   Rows 23-24  disk_headroom
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDb, getMigrationStatus, DB_PATH } from '@/lib/db';

// ── constants ────────────────────────────────────────────────────────────────

/** Minimum free disk space in bytes (500 MB, matching truth-table rows 23/24). */
export const DISK_MIN_BYTES = 500 * 1024 * 1024;

/** Placeholder names that signal an unbranded/default install. */
const PLACEHOLDER_NAMES = new Set([
  'default',
  'command center',
  'command-center',
  'blackceo command center',
]);

export function isPlaceholder(name: string): boolean {
  return PLACEHOLDER_NAMES.has(name.trim().toLowerCase());
}

// ── check result type ────────────────────────────────────────────────────────

export interface CheckResult {
  pass: boolean;
  detail: string;
  indeterminate?: boolean;
  [key: string]: unknown;
}

// ── injectable disk reader ───────────────────────────────────────────────────
// Wrapped in a mutable object so tests can override it despite ES module
// live-binding read-only restrictions:
//   import { diskReader } from '@/lib/health/deep-checks';
//   diskReader.readFreeBytes = () => 100 * 1024 * 1024; // 100 MB
//
// DESIGN: never resolve disk path from /data presence alone.
// Use process.cwd() (or DATABASE_PATH dir) so the check runs against the
// filesystem where the build actually executes, not a separate mount.

export const diskReader: { readFreeBytes: (checkPath: string) => number } = {
  readFreeBytes: (checkPath: string): number => {
    const fsAny = fs as { statfsSync?: (p: string) => { bfree: number; bsize: number } };
    if (typeof fsAny.statfsSync === 'function') {
      const stats = fsAny.statfsSync(checkPath);
      return stats.bfree * stats.bsize;
    }
    // Node 18 fallback — os.freemem() is mockable in tests
    return os.freemem();
  },
};

// ── check: asset manifest integrity ─────────────────────────────────────────
// Truth-table rows 11-12.
// Reads .next/BUILD_ID and build-manifest.json from disk — NO self-curl.
//
// CRITICAL: build-manifest.json uses RELATIVE paths like 'static/chunks/main.js'
// (no leading /_next/).  The previous filter `startsWith('/_next/')` matched
// 0 real paths, making stale-manifest detection non-functional in production.
// Fix: normalise all path forms to 'static/...' relative to .next/.

export function checkAssetManifest(): CheckResult {
  try {
    const nextDir = path.join(process.cwd(), '.next');
    const buildIdPath = path.join(nextDir, 'BUILD_ID');

    if (!fs.existsSync(buildIdPath)) {
      return { pass: false, detail: 'asset_manifest: .next/BUILD_ID missing — build not present or incomplete' };
    }

    const buildId = fs.readFileSync(buildIdPath, 'utf8').trim();

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

    // Collect all referenced static asset paths, normalised to relative form
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
        if (typeof p !== 'string' || !p) continue;
        // Normalise all forms to a path relative to .next/
        let rel = p;
        if (rel.startsWith('/_next/')) {
          rel = rel.slice('/_next/'.length);
        } else if (rel.startsWith('_next/')) {
          rel = rel.slice('_next/'.length);
        }
        // rel is now e.g. 'static/chunks/main-abc123.js'
        referenced.add(rel);
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
    const referencedArr = Array.from(referenced); // avoid TS2802 (Set iteration requires es2015+)
    for (const rel of referencedArr) {
      const diskPath = path.join(nextDir, rel);
      if (!fs.existsSync(diskPath)) {
        missing.push('/_next/' + rel); // human-readable form in error
        if (missing.length >= 5) break;
      }
    }

    if (missing.length > 0) {
      return {
        pass: false,
        detail: `asset_manifest: ${missing.length} referenced asset(s) missing from disk`,
        missing_examples: missing,
        build_id: buildId,
        referenced_count: referenced.size,
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

export interface CompanyBrandingResult extends CheckResult {
  config_exists: boolean;
  config_name?: string;
  db_name?: string;
}

export function checkCompanyBranding(): CompanyBrandingResult {
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

export function checkDatabasePath(): CheckResult {
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

export function checkMigrations(): CheckResult {
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

export async function checkDiskHeadroom(): Promise<CheckResult> {
  try {
    // Resolve check path from DATABASE_PATH or process.cwd() — NEVER from /data
    // presence alone (Sheila-class false-green: /data is a separate large mount
    // but CC install filesystem has < 500 MB free).
    const checkPath = process.env.DATABASE_PATH
      ? path.dirname(process.env.DATABASE_PATH)
      : process.cwd();

    let freeBytes: number;
    try {
      freeBytes = diskReader.readFreeBytes(checkPath);
    } catch {
      freeBytes = os.freemem();
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
    return {
      pass: false,
      indeterminate: true,
      detail: `disk_headroom: could not determine disk space — ${err instanceof Error ? err.message : String(err)} (UNKNOWN)`,
    };
  }
}
