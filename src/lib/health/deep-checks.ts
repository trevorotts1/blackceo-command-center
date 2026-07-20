/**
 * B.1 deep health check functions — extracted from /api/health/deep/route.ts
 * so they can be imported and unit-tested without Next.js route constraints.
 *
 * The route file (src/app/api/health/deep/route.ts) re-exports these via
 * a named re-export so callers can do:
 *   import { checkAssetManifest, ... } from '@/lib/health/deep-checks';
 *
 * Truth-table rows covered:
 *   Rows 11-13, 39  asset_manifest (incl. Round-4: empty manifest guard)
 *   Rows 1-9, 9b   company_branding (partial-config rule, DB direct, consistency,
 *                   HTML title branding rows 8-9, 9b REDO-REDO compound-form fix)
 *   Rows 20-22      database_path
 *   Rows 29-30      migrations
 *   Rows 23-24, 35, 35b  disk_headroom (incl. REDO #1 wrong-mount DATABASE_PATH
 *                         variant, REDO-REDO wrong-mount CWD variant)
 *   Rows 31-32, 40  next_public_app_url (incl. Round-4: IPv6 [::1] false-fail fix)
 *   (new)           anthology_board_projection (A7 — empty-vs-idle board drift)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
// Bare specifiers (not the 'node:child_process' URI scheme src/app/api/health/
// route.ts uses) — this module is reachable from src/instrumentation.ts's
// dynamic `await import('@/lib/jobs/scheduler')` (register cron jobs), which
// Next.js also bundles for the edge runtime target even though a runtime
// guard skips execution there. The edge webpack config errors on the
// 'node:' URI scheme (UnhandledSchemeError) but tolerates the bare
// specifier — the same pattern src/lib/notify.ts (already reachable from
// this exact import chain) already relies on.
import { execFile } from 'child_process';
import { promisify } from 'util';
import BetterSqlite3 from 'better-sqlite3';
import { getDb, getMigrationStatus, getDbPath } from '@/lib/db';
import { getNotificationFailuresLogStats } from '@/lib/notify';
import { ensureRuntimeConfigFile } from '@/lib/runtime-config';

const execFileAsync = promisify(execFile);

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

// REDO #1 FIX (Node 18 disk_headroom false-green):
// fs.statfsSync was added in Node 19.  On Node 18 the old fallback returned
// os.freemem() (available RAM) — a completely different metric.  Any machine
// with >500 MB free RAM would pass the disk check regardless of actual disk
// space (confirmed false-green).
// Fix: when statfsSync is absent, throw an error so checkDiskHeadroom() catches
// it as indeterminate (UNKNOWN) rather than silently substituting RAM bytes.
// The caller's outer try/catch returns indeterminate=true, which correctly
// means "cannot determine" rather than a wrong metric being reported as a pass.
export const diskReader: { readFreeBytes: (checkPath: string) => number } = {
  readFreeBytes: (checkPath: string): number => {
    const fsAny = fs as { statfsSync?: (p: string) => { bfree: number; bsize: number } };
    if (typeof fsAny.statfsSync === 'function') {
      const stats = fsAny.statfsSync(checkPath);
      return stats.bfree * stats.bsize;
    }
    // Node 18: statfsSync absent — cannot determine disk free bytes.
    // Throwing here causes checkDiskHeadroom() to return indeterminate=true
    // (UNKNOWN) rather than substituting os.freemem() (RAM bytes — wrong metric).
    throw new Error('fs.statfsSync is not available on this Node.js version (requires Node >=19); disk free space check is UNKNOWN (indeterminate)');
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

    // Round-4 fix (Item 8): empty manifest vacuous PASS.
    // When build-manifest.json has pages:{} (and all other arrays are empty),
    // referenced.size === 0.  The missing-assets loop runs zero iterations and
    // the function falls through to pass=true — a false-green.  An interrupted
    // build can write BUILD_ID + build-manifest.json and then fail before
    // compiling any chunks, leaving a manifest with 0 referenced assets.  The
    // running server will 404 every /_next/static route even though this check
    // previously said OK.
    // Guard: if referenced.size === 0, the build is empty or incomplete → FAIL.
    if (referenced.size === 0) {
      return {
        pass: false,
        detail: `asset_manifest: manifest has 0 referenced assets — build is empty or incomplete (BUILD_ID=${buildId})`,
        build_id: buildId,
        referenced_count: 0,
      };
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
  const configPath = ensureRuntimeConfigFile('company-config.json');
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

    // ROW 7 FIX: query ALL rows including empty-string name.
    // The old filter `WHERE name != ''` caused empty-string rows to be excluded,
    // making the function fall into the dbRowAbsent=true branch (UNKNOWN) instead
    // of the correct FAIL path.  "Empty string is as bad as absent" (truth-table row 7).
    const row = db
      .prepare("SELECT name FROM companies ORDER BY id LIMIT 1")
      .get() as { name: string | null } | undefined;

    if (!row) {
      dbRowAbsent = true;
    } else {
      // Store the raw value (may be null, empty string, or a real name)
      const rawName = row.name;
      if (rawName === null || rawName === undefined) {
        // ROW 7 NULL-NAME FIX: a SQL NULL in name column is treated the same as
        // an empty string — the row exists but carries no branding information.
        // "NULL name is as bad as empty string" (mirrors the empty-string rule).
        // Do NOT set dbRowAbsent — the row exists, it's just null (→ FAIL via
        // the placeholder/empty guard in step 3, same path as empty string '').
        dbName = '';
        // Do NOT set dbRowAbsent here.
      } else {
        dbName = rawName.trim();
        // Empty string after trim → treat as absent for the row-exists check,
        // but we handle empty string as FAIL in step 3 below (row 7 spec).
        if (dbName === '') {
          // Mark as a special empty-string case: row exists but name is empty
          dbName = '';
          // Do NOT set dbRowAbsent — the row exists, it's just empty (→ FAIL)
        }
      }
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

  // Round-3 fix: Row 4 false-green — config PRESENT with placeholder companyName + DB row ABSENT.
  // Previously: isPlaceholder(dbName) was only evaluated when dbName !== null.
  // When dbName is null (DB row absent), the guard never fired and the function
  // fell through to the full happy-path return (pass=true) — false-green.
  // FIX: when config exists and DB row is absent, check if configName itself is
  // a placeholder; if so FAIL immediately (a placeholder config is never valid).
  if (configExists && dbRowAbsent && configName && isPlaceholder(configName)) {
    return {
      pass: false,
      indeterminate: false,
      config_exists: true,
      config_name: configName,
      detail: `company_branding: config/company-config.json has placeholder companyName ("${configName}") and no DB company row exists — box is unbranded (Round-3 fix: config placeholder + DB absent)`,
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

// ── check: HTML title branding ───────────────────────────────────────────────
// Truth-table rows 8-9.
// Row 8: HTML <title> contains client brand name → PASS (branding check component)
// Row 9: HTML <title> is generic placeholder ("Command Center" etc.) → FAIL
//
// This check reads the served HTML from the app's own _document or a pre-built
// static HTML file inside .next/server/pages/.  It does NOT perform a self-curl
// (that would require the server to be running), so it reads the on-disk output.
// If no pre-rendered HTML is found, the check is skipped (indeterminate) — the
// outside-in probe in cc-health-check.sh covers the running-server title case.

/** Generic/placeholder page titles that indicate an unbranded install.
 *
 * REDO-REDO FIX (SECONDARY FALSE-GREEN):
 * The original set covered bare placeholders but missed compound forms that
 * layout.tsx generates when COMPANY_NAME env is set to a generic word at
 * build time.  layout.tsx line 26 produces `${COMPANY_NAME} Command Center`.
 * Examples:
 *   - COMPANY_NAME='Default'         → 'Default Command Center'
 *   - COMPANY_NAME='Black CEO'       → 'Black CEO Command Center'
 *     (vs 'blackceo command center' with no space — old entry missed the space variant)
 *
 * Fix: add 'default command center' and 'black ceo command center' (with space).
 * Also add pattern-style entries: any title whose suffix is a known placeholder
 * suffix ('command center', 'mission control') and whose prefix is a known
 * placeholder word is covered by explicit entries below.
 */
const PLACEHOLDER_TITLES = new Set([
  'command center',
  'blackceo command center',
  'black ceo command center',       // REDO-REDO: space-variant of 'blackceo command center'
  'default command center',         // REDO-REDO: COMPANY_NAME='Default' at build time
  'mission control',
  'next.js app',
  'create next app',
  'untitled',
]);

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(title.trim().toLowerCase());
}

export interface HtmlTitleResult extends CheckResult {
  title?: string;
  source?: string;
}

export function checkHtmlTitle(): HtmlTitleResult {
  try {
    // Look for a pre-rendered index HTML from the Next.js build output.
    // Next.js writes server-side HTML to .next/server/pages/index.html (pages router)
    // or .next/server/app/page.html (app router) for static pages.
    const nextDir = path.join(process.cwd(), '.next');
    const candidates = [
      path.join(nextDir, 'server', 'pages', 'index.html'),
      path.join(nextDir, 'server', 'app', 'page.html'),
      path.join(nextDir, 'server', 'app', 'index.html'),
      // Also check the export output (next export)
      path.join(process.cwd(), 'out', 'index.html'),
    ];

    let html = '';
    let source = '';
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        html = fs.readFileSync(p, 'utf8');
        source = p;
        break;
      }
    }

    if (!html) {
      // No pre-rendered HTML found — skip (indeterminate, not fail).
      // The cc-health-check.sh outside-in probe covers the running-server case.
      return {
        pass: false,
        indeterminate: true,
        detail: 'html_title: no pre-rendered HTML found in .next/server — check skipped (indeterminate); use cc-health-check.sh outside-in probe for live-server title verification',
      };
    }

    // Extract <title> tag content
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (!match) {
      return {
        pass: false,
        indeterminate: true,
        detail: `html_title: no <title> tag found in ${source} (indeterminate)`,
        source,
      };
    }

    const title = match[1].trim();

    // Row 9: placeholder title → FAIL
    if (!title || isPlaceholderTitle(title)) {
      return {
        pass: false,
        indeterminate: false,
        title,
        source,
        detail: `html_title: page title is a placeholder ("${title}") — box is unbranded (row 9: FAIL)`,
      };
    }

    // Row 8: real brand title → PASS
    return {
      pass: true,
      title,
      source,
      detail: `html_title: OK — page title is branded ("${title}") (row 8: PASS)`,
    };
  } catch (err) {
    return {
      pass: false,
      indeterminate: true,
      detail: `html_title: error reading build output — ${err instanceof Error ? err.message : String(err)} (UNKNOWN)`,
    };
  }
}

// ── check: NEXT_PUBLIC_APP_URL consistency ────────────────────────────────────
// Truth-table rows 31-32.
// Row 31: NEXT_PUBLIC_APP_URL set and consistent → PASS
// Row 32: NEXT_PUBLIC_APP_URL set to a different host than actual serving URL → FAIL
//
// Implementation: we check whether NEXT_PUBLIC_APP_URL is set and whether it
// appears plausibly consistent.  Without an actual running server to probe,
// we verify the env var is set and is a valid absolute URL.  Mismatch detection
// (row 32) is enforced by comparing NEXT_PUBLIC_APP_URL against the DATABASE_PATH
// directory host hint or a CC_PUBLIC_URL override if provided.

export interface AppUrlResult extends CheckResult {
  app_url?: string;
  expected_host?: string;
}

export function checkNextPublicAppUrl(): AppUrlResult {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (!appUrl) {
    // Row 32 variant: if NEXT_PUBLIC_APP_URL is unset, SSE and webhooks use
    // relative URLs which may break in cross-origin deployments.  However, an
    // unset value is ambiguous — it could be a localhost deploy where relative
    // URLs are fine.  Return PASS with a note rather than FAIL.
    return {
      pass: true,
      detail: 'next_public_app_url: not set — relative URLs used; acceptable for localhost deploys. Set NEXT_PUBLIC_APP_URL for cross-origin CF tunnel installs.',
      app_url: undefined,
    };
  }

  // Validate it is an absolute URL
  try {
    const parsed = new URL(appUrl);
    const host = parsed.hostname;

    // Row 32: check for localhost mismatch when a public URL is configured.
    // A NEXT_PUBLIC_APP_URL pointing to localhost/127.0.0.1 on a box that has a
    // public hostname configured is a misconfiguration (SSE/webhooks break).
    //
    // Round-4 fix (Item 9): IPv6 false-fail.
    // URL.hostname returns '[::1]' (with brackets) for IPv6 loopback literals,
    // e.g. 'http://[::1]:3000' → hostname='[::1]'.  The old regex matched only
    // '::1' (without brackets), so '[::1]' failed the isLocalhost test and the
    // URL was treated as a non-localhost remote URL → FAIL (false-fail).
    // Fix: add '\[::1\]' (the bracketed form) to the regex so both '::1' and
    // '[::1]' are recognised as IPv6 loopback.
    const isLocalhost = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/.test(host);
    const publicUrlHint = process.env.CC_PUBLIC_URL || '';

    if (isLocalhost && publicUrlHint) {
      try {
        const pubParsed = new URL(publicUrlHint);
        if (!/^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/.test(pubParsed.hostname)) {
          return {
            pass: false,
            indeterminate: false,
            app_url: appUrl,
            expected_host: pubParsed.hostname,
            detail: `next_public_app_url: NEXT_PUBLIC_APP_URL points to localhost ("${appUrl}") but CC_PUBLIC_URL is "${publicUrlHint}" — SSE and webhooks will fail for remote clients (row 32: FAIL)`,
          };
        }
      } catch {
        // CC_PUBLIC_URL not a valid URL — skip the comparison
      }
    }

    // REDO #1 FIX (Row 32 false-green — non-localhost wrong domain):
    // If NEXT_PUBLIC_APP_URL is set to a non-localhost absolute URL but
    // CC_PUBLIC_URL is NOT set, the old code returned pass=true unconditionally.
    // A non-localhost URL (e.g. https://wrong-client.tunnel.com) is suspicious:
    // the endpoint cannot verify the hostname is correct without CC_PUBLIC_URL,
    // but it CAN verify it is NOT localhost (which would be an obvious mismatch on
    // a public-URL deploy).
    //
    // Truth-table Row 32 says FAIL when NEXT_PUBLIC_APP_URL is set to a different
    // host than the actual CF tunnel URL — no precondition requiring CC_PUBLIC_URL
    // to be set.  We cannot detect the WRONG non-localhost hostname without a hint,
    // but we MUST NOT silently pass it.  The correct verdict when CC_PUBLIC_URL is
    // unset and NEXT_PUBLIC_APP_URL is non-localhost is UNKNOWN (indeterminate):
    // the endpoint cannot confirm whether this URL is correct or wrong.
    //
    // Rationale for UNKNOWN not FAIL:
    //   - FAIL would block deploys on boxes where CC_PUBLIC_URL is intentionally
    //     not configured (e.g. a direct-IP install where the tunnel URL is stable
    //     and the operator hasn't set the optional hint variable).
    //   - UNKNOWN surfaces the gap without false rollbacks.
    //   - The truth-table Row 32 vitest MUST assert pass=false (which indeterminate
    //     gives, since indeterminate → overall pass=false) and must NOT assert
    //     pass=true — both are satisfied.
    //
    // If CC_PUBLIC_URL IS set and doesn't match NEXT_PUBLIC_APP_URL, that is a
    // confirmed mismatch → FAIL (the localhost branch above handles this when
    // the URL is localhost; the block below handles the non-localhost case).
    // REDO #2 FIX (Row 32 false-green — truthy-but-invalid CC_PUBLIC_URL):
    // Track whether CC_PUBLIC_URL is set but cannot be parsed as a valid URL.
    // This flag is checked below alongside the "unset" guard so that both cases
    // (CC_PUBLIC_URL unset AND CC_PUBLIC_URL truthy-but-invalid) trigger FAIL.
    let publicUrlHintInvalid = false;

    if (!isLocalhost && publicUrlHint) {
      try {
        const pubParsed = new URL(publicUrlHint);
        if (pubParsed.hostname !== host) {
          return {
            pass: false,
            indeterminate: false,
            app_url: appUrl,
            expected_host: pubParsed.hostname,
            detail: `next_public_app_url: NEXT_PUBLIC_APP_URL host ("${host}") does not match CC_PUBLIC_URL host ("${pubParsed.hostname}") — SSE and webhooks will fail for remote clients (row 32: FAIL)`,
          };
        }
      } catch {
        // CC_PUBLIC_URL is set but is not a valid URL (e.g. 'not-a-valid-url',
        // '   ', 'http://', 'ftp://', '://nodomain').
        // REDO #2: set the flag so the guard below can trigger FAIL.
        // The old code silently skipped the comparison, letting the function fall
        // through to pass=true — a false-green (Row 32: FAIL expected).
        publicUrlHintInvalid = true;
      }
    }

    // REDO #1 FIX (Row 32 false-green — CC_PUBLIC_URL unset):
    // REDO #2 FIX (Row 32 false-green — CC_PUBLIC_URL truthy-but-invalid):
    // Non-localhost NEXT_PUBLIC_APP_URL with CC_PUBLIC_URL absent OR unparseable
    // means the hostname cannot be verified — silently passing is a false-green.
    //
    // Verdict: FAIL.
    //   - A non-localhost NEXT_PUBLIC_APP_URL on a CF tunnel deploy REQUIRES a
    //     valid CC_PUBLIC_URL so the health check can verify the hostname.
    //   - Without it (unset or invalid), the check is unverifiable and must FAIL.
    //   - Operators who want Row 31 PASS must set CC_PUBLIC_URL to a valid URL
    //     matching the actual CF tunnel hostname.
    if (!isLocalhost && (!publicUrlHint || publicUrlHintInvalid)) {
      const reason = publicUrlHintInvalid
        ? `CC_PUBLIC_URL is set but is not a valid URL ("${publicUrlHint}") — cannot verify hostname`
        : 'CC_PUBLIC_URL is not configured — cannot verify hostname is correct';
      return {
        pass: false,
        indeterminate: false,
        app_url: appUrl,
        detail: `next_public_app_url: NEXT_PUBLIC_APP_URL is set to a non-localhost URL ("${appUrl}") but ${reason}; set CC_PUBLIC_URL to a valid URL matching the actual CF tunnel URL to enable mismatch detection (row 32: FAIL)`,
      };
    }

    return {
      pass: true,
      app_url: appUrl,
      detail: `next_public_app_url: OK — "${appUrl}" (row 31: PASS)`,
    };
  } catch {
    return {
      pass: false,
      indeterminate: false,
      app_url: appUrl,
      detail: `next_public_app_url: NEXT_PUBLIC_APP_URL is not a valid absolute URL ("${appUrl}") — SSE and webhooks will fail (row 32: FAIL)`,
    };
  }
}

// ── check: DATABASE_PATH pinned ──────────────────────────────────────────────
// Truth-table rows 20-22.

export function checkDatabasePath(): CheckResult {
  const envPath = process.env.DATABASE_PATH;

  if (!envPath) {
    // Row 21: unset is valid — uses process.cwd() default.
    // Resolve at USE time (C8 lazy resolution): on the real server the
    // __CC_SERVER_ENTRYPOINT__ marker is set, so this returns the historic
    // cwd default. Anywhere else the C8 guard throws rather than name a live
    // path — which is the correct answer for a health probe that has no
    // business resolving one.
    const resolved = getDbPath();
    return {
      pass: true,
      detail: `database_path: unset — using default process.cwd() path (${resolved}). Set DATABASE_PATH for cwd-drift resilience (B.4 hardening).`,
      database_path_set: false,
      resolved_path: resolved,
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

// Well-known large bind-mount paths that must NOT be used as the disk check
// target (wrong-mount-class false-green: /data is a separate large
// mount; probing it returns 80 GB free while the CC partition has <500 MB).
// When DATABASE_PATH resolves into one of these mounts, fall back to
// process.cwd() instead.
const WRONG_MOUNT_PREFIXES = ['/data'];

/**
 * Resolve the filesystem path that checkDiskHeadroom() should probe.
 *
 * Returns the chosen path, or null when the resolved path falls under a
 * known wrong-mount prefix (WRONG_MOUNT_PREFIXES).  checkDiskHeadroom()
 * treats null as an immediate FAIL (wrong-mount false-green guard).
 *
 * REDO #1 FIX (Row 35 DATABASE_PATH=/data/... variant):
 * The original fix guarded the DATABASE_PATH branch but NOT process.cwd().
 *
 * REDO-REDO FIX (Row 35 CWD=/data/... variant — the remaining gap):
 * When DATABASE_PATH is unset and process.cwd() is itself under /data
 * (e.g. a Docker install where the app root is /data/app), the previous code
 * returned process.cwd() without any mount check, causing diskReader to probe
 * the large Docker volume (~80 GB free) and return pass:true — a false-green.
 *
 * Fix: evaluate WRONG_MOUNT_PREFIXES against the resolved candidate regardless
 * of whether it came from DATABASE_PATH dir or process.cwd().  Return null when
 * on a wrong mount so checkDiskHeadroom() can emit a named FAIL.
 */
export function resolveCheckPath(): string | null {
  const envPath = process.env.DATABASE_PATH;
  // Choose candidate: DATABASE_PATH dir (if set) else process.cwd().
  const candidate = envPath ? path.dirname(envPath) : process.cwd();

  // P1 FIX: exact-match only — subdirectories of /data (e.g. /data/mission-control)
  // are real app dirs whose own filesystem is checked normally.  The old
  // `startsWith(prefix + '/')` form also rejected VPS canonical paths under /data,
  // causing every VPS deploy to disk-FAIL deterministically.
  const isWrongMount = WRONG_MOUNT_PREFIXES.some(
    (prefix) => candidate === prefix
  );
  if (isWrongMount) {
    // Candidate is on a known large bind-mount — return null to signal FAIL.
    return null;
  }

  return candidate;
}

export async function checkDiskHeadroom(): Promise<CheckResult> {
  try {
    // Resolve check path — NEVER from /data presence alone.
    // resolveCheckPath() returns null when both DATABASE_PATH dir and
    // process.cwd() resolve into a WRONG_MOUNT_PREFIXES path (wrong-mount-class
    // false-green, truth-table Row 35, incl. CWD variant from REDO-REDO fix).
    const checkPath = resolveCheckPath();
    if (checkPath === null) {
      // Both DATABASE_PATH dir and process.cwd() are on a known large bind-mount
      // (e.g. /data in Docker).  Probing that mount would return its large free
      // space (~80 GB) not the host partition's free space — false-green.
      // Return FAIL immediately rather than probing the wrong mount.
      return {
        pass: false,
        detail: 'disk_headroom: check path resolves to a known large bind-mount — wrong-mount false-green guard (Row 35 CWD variant)',
        path: process.env.DATABASE_PATH ? String(process.env.DATABASE_PATH) : process.cwd(),
      };
    }

    // diskReader.readFreeBytes throws on Node 18 (statfsSync absent).
    // We let that propagate to the outer catch, which returns indeterminate=true
    // (UNKNOWN) — the correct verdict when the metric cannot be obtained.
    // DO NOT fall back to os.freemem() here: it measures RAM, not disk space,
    // and would cause a false-green on any machine with >500 MB free RAM
    // (confirmed REDO #1 false-green on Node 18).
    const freeBytes = diskReader.readFreeBytes(checkPath);

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

// ── check: Anthology board projection drift (A7) ────────────────────────────
//
// PROBLEM: an empty Kanban board (0 anthology cards) is visually IDENTICAL
// whether (a) there is genuinely no anthology work queued right now, or
// (b) the S0→mc_board mirror silently dropped every card while the engine's
// own ledger kept accumulating participants. Case (b) went unnoticed for 3
// days (5 ledger participants, 0 cards, no alert — see A7 evidence). This
// check makes the two cases DISTINGUISHABLE by comparing counts on both
// sides of the mirror:
//   - the Anthology Engine's own read-only ledger mirror (participants +
//     anthologies rows in ~/.anthology-engine/state/anthology_state.db, or
//     wherever ANTHOLOGY_STATE_DIR / OPENCLAW_DATA_DIR points — the SAME
//     resolution order mc_board.py itself uses, see resolve_state_dir()), vs
//   - this box's own card count (tasks.source = 'anthology', with a legacy
//     description-marker fallback for pre-migration rows — mirrors
//     resolveBoardSource() in api/tasks/[id]/status/route.ts).
//
// DESIGN NOTE — unlike the universal checks above (branding, migrations),
// the Anthology Engine is OPTIONAL per-box tooling: most Command Center
// installs never run it. So "no ledger mirror on disk at all" is a
// legitimate PASS (not applicable to this box), never UNKNOWN/FAIL — this
// check must never turn a healthy non-anthology box red. Only a ledger that
// EXISTS with rows in it, sitting next to zero board cards, is drift.

export interface BoardProjectionResult extends CheckResult {
  ledger_participants?: number;
  ledger_anthologies?: number;
  board_cards?: number;
  /**
   * U79 / GK-17 — the converging-repair signal the ONB leg (merge b62455b1)
   * now emits: `true` = the last daily-tick reconcile fully converged (zero
   * deferred/error subjects); `false` = it ran but did NOT converge — the
   * ONLY condition the drift banner (AnthologyBoardDriftBanner) may escalate
   * on; `null` = unknown (no report, unparseable, stale, or a legacy runner
   * that never captured stdout) and must NEVER escalate. See
   * readLatestBoardReconcileSignal().
   */
  board_reconcile_converged?: boolean | null;
  /** The report's own `board_reconcile.status` string, when available
   *  ("reconciled" | "unconverged" | "error" | "skipped"), for diagnostics. */
  board_reconcile_status?: string;
  /** Age of the newest report in whole seconds, when its `utc` field parsed. */
  board_reconcile_age_seconds?: number;
  /** True when the newest report is older than BOARD_RECONCILE_REPORT_STALE_MS
   *  (or its age could not be determined) — staleness forces `converged` to
   *  null regardless of what the report payload says. */
  board_reconcile_stale?: boolean;
}

/**
 * Resolve the Anthology Engine's ledger mirror DB path. Mirrors
 * resolve_state_dir() in 59-anthology-engine/scripts/mc_board.py exactly
 * (ANTHOLOGY_STATE_DIR > OPENCLAW_DATA_DIR/anthology-engine/state >
 * ~/.anthology-engine/state) so this check reads the SAME file the engine
 * itself projects from — never a second, possibly-stale, guess.
 */
export function resolveAnthologyStateDbPath(): string {
  const explicit = (process.env.ANTHOLOGY_STATE_DIR || '').trim();
  if (explicit) return path.join(explicit, 'anthology_state.db');

  const dataDir = (process.env.OPENCLAW_DATA_DIR || '').trim();
  if (dataDir) return path.join(dataDir, 'anthology-engine', 'state', 'anthology_state.db');

  const home = process.env.HOME || os.homedir();
  return path.join(home, '.anthology-engine', 'state', 'anthology_state.db');
}

/**
 * U79 / GK-17 — resolve the daily tick's report directory: the SAME state
 * dir resolveAnthologyStateDbPath() already uses (ANTHOLOGY_STATE_DIR >
 * OPENCLAW_DATA_DIR/anthology-engine/state > ~/.anthology-engine/state),
 * with a `reports` subdirectory appended — mirroring report_dir() /
 * default_state_dir() in 59-anthology-engine/scripts/anthology-smoke-test.py
 * exactly (report_dir() = default_state_dir() / "reports"). No new
 * configuration surface: this is read-only reuse of an existing resolver.
 */
export function resolveAnthologyReportsDir(): string {
  return path.join(path.dirname(resolveAnthologyStateDbPath()), 'reports');
}

/**
 * The newest `smoke-test-*.json` filename stamp is
 * `%Y%m%dT%H%M%SZ` (fixed-width UTC), so lexicographic sort ==
 * chronological order — no fs.stat() mtime read needed.
 */
const SMOKE_TEST_REPORT_RE = /^smoke-test-\d{8}T\d{6}Z\.json$/;

/**
 * Staleness window for a `board_reconcile` report: guard-cron-inventory.py
 * enforces exactly ONE recurring daily-tick cron entry (no heartbeat / sub-
 * daily trigger), so a healthy box produces one fresh report roughly every
 * 24h. 48h (2x cadence) tolerates a single missed/delayed run without
 * treating the install as abandoned, while still aging out a report from an
 * install whose daily tick has genuinely stopped running — a stale report's
 * `converged` value describes a repair attempt from a stale point in time
 * and must never drive today's banner.
 */
const BOARD_RECONCILE_REPORT_STALE_MS = 48 * 60 * 60 * 1000;

export interface BoardReconcileSignal {
  converged: boolean | null;
  status?: string;
  ageSeconds?: number;
  stale: boolean;
}

/**
 * U79 / GK-17 — read the newest daily-tick report and extract the
 * `board_reconcile.converged` signal the ONB leg (merge b62455b1) now emits
 * (mc_board.py:768 `_reconcile_sweep()`, persisted by
 * anthology-smoke-test.py's persist_report() to
 * `<state_dir>/reports/smoke-test-<UTC-stamp>.json`, contract
 * "anthology-smoke-test-report" schema_version 1). Fully fail-soft: a
 * missing reports dir, no matching files, unparseable JSON, an unexpected
 * shape, or a STALE report all resolve to `converged: null` — "unknown",
 * never a false escalation. This is a pure filesystem read; it never shells
 * out to mc_board.py (that would let an unauthenticated caller of
 * /api/health/deep trigger a board-writing subprocess — see
 * findMcBoardScript()'s doc comment).
 */
export function readLatestBoardReconcileSignal(): BoardReconcileSignal {
  const unknown: BoardReconcileSignal = { converged: null, stale: false };
  try {
    const reportsDir = resolveAnthologyReportsDir();
    if (!fs.existsSync(reportsDir)) return unknown;

    const entries = fs.readdirSync(reportsDir).filter((f) => SMOKE_TEST_REPORT_RE.test(f));
    if (entries.length === 0) return unknown;
    entries.sort();
    const newest = entries[entries.length - 1];

    const raw = fs.readFileSync(path.join(reportsDir, newest), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return unknown;
    const report = parsed as Record<string, unknown>;

    const utcMs = typeof report.utc === 'string' ? Date.parse(report.utc) : NaN;
    const hasAge = Number.isFinite(utcMs);
    const ageSeconds = hasAge ? Math.max(0, Math.round((Date.now() - utcMs) / 1000)) : undefined;
    // No parseable timestamp at all is treated as stale — never trust an
    // undated report's converged value.
    const stale = hasAge ? ageSeconds! * 1000 > BOARD_RECONCILE_REPORT_STALE_MS : true;

    const br = report.board_reconcile;
    const status =
      br && typeof br === 'object' && typeof (br as Record<string, unknown>).status === 'string'
        ? ((br as Record<string, unknown>).status as string)
        : undefined;

    if (stale) {
      // Missing/stale/unparseable = unknown, never escalate — even if the
      // stale payload itself says converged:false.
      return { converged: null, status, ageSeconds, stale: true };
    }

    if (!br || typeof br !== 'object') return { converged: null, status, ageSeconds, stale: false };
    const rawConverged = (br as Record<string, unknown>).converged;
    const converged = rawConverged === true ? true : rawConverged === false ? false : null;
    return { converged, status, ageSeconds, stale: false };
  } catch {
    // Fail-soft: an unreadable/corrupt report is UNKNOWN, never a drift signal.
    return unknown;
  }
}

/**
 * Locate mc_board.py so an AUTHENTICATED caller (a CLI/diagnostic surface, not
 * the unauthenticated /api/health/deep endpoint) can render a copy-pasteable
 * reconcile command with the resolved absolute path. Mirrors the candidate-list
 * convention in src/app/participant/_lib/gate-engine.ts (findGateEngineScript)
 * — same skill, same house pattern, own script name. Returns null (fail-soft)
 * when not found.
 *
 * NOTE: checkAnthologyBoardProjection() intentionally does NOT call this for its
 * `detail` string — that detail is exposed through the unauthenticated endpoint
 * bypass, so it uses a generic, path-free command form instead (see the drift
 * branch). This function is retained and unit-tested for the authenticated
 * callers that legitimately want the real path.
 */
export function findMcBoardScript(): string | null {
  const candidates = [
    process.env.ANTHOLOGY_MC_BOARD_SCRIPT,
    '/data/.openclaw/skills/59-anthology-engine/scripts/mc_board.py',
    `${process.env.HOME || os.homedir()}/.openclaw/skills/59-anthology-engine/scripts/mc_board.py`,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* ignore and try the next candidate */
    }
  }
  return null;
}

export function checkAnthologyBoardProjection(): BoardProjectionResult {
  // resolveAnthologyStateDbPath() returns an absolute path under $HOME (or a
  // configured data dir). This result is surfaced through /api/health/deep,
  // which middleware.ts bypasses (unauthenticated subtree). Keep that absolute
  // path — and the resolved mc_board.py script path — OUT of the `detail`
  // string (see the drift branch below): the endpoint must not leak filesystem
  // layout beyond the posture the other checks already set. Small integer row
  // counts are surfaced (as migrations/asset_manifest already surface counts)
  // because the operator banner needs them to distinguish drift from idle.
  const ledgerDbPath = resolveAnthologyStateDbPath();

  // U79 / GK-17 — always attempt to read the daily tick's converged signal,
  // independent of whether THIS box's ledger mirror exists: the report file
  // and the ledger DB share a resolver but are read separately, so reading
  // one never depends on the other being present. Fully fail-soft (see
  // readLatestBoardReconcileSignal()) — this call can never throw or block.
  const reconcileSignal = readLatestBoardReconcileSignal();
  const reconcileFields: Pick<
    BoardProjectionResult,
    'board_reconcile_converged' | 'board_reconcile_status' | 'board_reconcile_age_seconds' | 'board_reconcile_stale'
  > = {
    board_reconcile_converged: reconcileSignal.converged,
    board_reconcile_status: reconcileSignal.status,
    board_reconcile_age_seconds: reconcileSignal.ageSeconds,
    board_reconcile_stale: reconcileSignal.stale,
  };

  if (!fs.existsSync(ledgerDbPath)) {
    // Not provisioned on this box at all — legitimate PASS, not UNKNOWN.
    return {
      pass: true,
      detail: 'anthology_board_projection: OK — Anthology Engine not provisioned on this box; not applicable',
      ...reconcileFields,
    };
  }

  // 1. Read the engine's OWN ledger, read-only. Fail-soft: a present-but-
  //    unreadable ledger (locked, mid-write, corrupt) IS worth flagging —
  //    it exists, so this box does run the engine — but as UNKNOWN, not a
  //    confirmed drift (we cannot compare against a count we couldn't read).
  let ledgerParticipants: number;
  let ledgerAnthologies: number;
  try {
    const ledgerDb = new BetterSqlite3(ledgerDbPath, { readonly: true, fileMustExist: true });
    try {
      ledgerDb.pragma('busy_timeout = 5000');
      const p = ledgerDb.prepare('SELECT COUNT(*) AS n FROM participants').get() as
        | { n: number }
        | undefined;
      const a = ledgerDb.prepare('SELECT COUNT(*) AS n FROM anthologies').get() as
        | { n: number }
        | undefined;
      ledgerParticipants = p?.n ?? 0;
      ledgerAnthologies = a?.n ?? 0;
    } finally {
      ledgerDb.close();
    }
  } catch {
    // Do NOT echo the raw driver error or ledgerDbPath: on a corrupt/locked
    // file better-sqlite3 embeds the absolute path in its message, which would
    // leak through the unauthenticated endpoint.
    return {
      pass: false,
      indeterminate: true,
      detail: 'anthology_board_projection: ledger mirror present but could not be read (locked, mid-write, or corrupt) — UNKNOWN',
      ...reconcileFields,
    };
  }

  // 2. Count this box's own anthology cards. Prefer the immutable
  //    tasks.source column; fall back to the legacy description marker for
  //    pre-migration rows (same precedence as resolveBoardSource() in
  //    api/tasks/[id]/status/route.ts). The LIKE pre-filter is a coarse
  //    superset of ANTHOLOGY_DESCRIPTION_MARKER — acceptable here because
  //    this check only ever reports a count, it never gates a write.
  let boardCards: number;
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE lower(source) = 'anthology'
            OR ((source IS NULL OR source = '') AND description LIKE '%Source: anthology%')`
      )
      .get() as { n: number } | undefined;
    boardCards = row?.n ?? 0;
  } catch {
    // Generic message — the raw driver error can embed the DB file path.
    return {
      pass: false,
      indeterminate: true,
      ledger_participants: ledgerParticipants,
      ledger_anthologies: ledgerAnthologies,
      detail: "anthology_board_projection: could not read this box's task board (locked or unavailable) — UNKNOWN",
      ...reconcileFields,
    };
  }

  const ledgerTotal = ledgerParticipants + ledgerAnthologies;

  if (ledgerTotal === 0) {
    return {
      pass: true,
      ledger_participants: ledgerParticipants,
      ledger_anthologies: ledgerAnthologies,
      board_cards: boardCards,
      detail: 'anthology_board_projection: OK — ledger is empty, no anthology work queued (healthy-idle, not drift)',
      ...reconcileFields,
    };
  }

  if (boardCards === 0) {
    // Generic, path-free reconcile command. We deliberately do NOT embed the
    // resolved absolute mc_board.py path (findMcBoardScript()) here — that path
    // reveals the skill install layout and $HOME, and this detail is exposed
    // through the unauthenticated /api/health/deep bypass. The operator viewing
    // the board banner runs mc_board.py from their own known install location;
    // findMcBoardScript() is retained (exported, unit-tested) for authenticated
    // CLI/diagnostic callers that are not this endpoint.
    //
    // NOTE (U79/GK-17): this raw-count comparison remains the coarse,
    // zero-vs-nonzero heuristic it always was — it is NOT the authoritative
    // signal any longer. `board_reconcile_converged` above (from mc_board.py's
    // own per-subject reconcile sweep) is what AnthologyBoardDriftBanner
    // actually keys off; this `pass`/`detail` pair stays informational.
    return {
      pass: false,
      indeterminate: false,
      ledger_participants: ledgerParticipants,
      ledger_anthologies: ledgerAnthologies,
      board_cards: 0,
      detail: `anthology_board_projection: DRIFT — ledger holds ${ledgerParticipants} participant(s) + ${ledgerAnthologies} anthology row(s) but the board shows 0 anthology card(s) (dead board, not idle). Run: mc_board.py reconcile --json`,
      ...reconcileFields,
    };
  }

  return {
    pass: true,
    ledger_participants: ledgerParticipants,
    ledger_anthologies: ledgerAnthologies,
    board_cards: boardCards,
    detail: `anthology_board_projection: OK — ledger holds ${ledgerTotal} row(s), board shows ${boardCards} anthology card(s) (projecting)`,
    ...reconcileFields,
  };
}

// ── check: Skill-6 board projection drift (U27 / B-U13) ────────────────────
//
// PROBLEM (SKILL.md:607-608, verbatim): "cc_board.py fail-softs (the card
// just never lands / never moves) and the build continues unregistered."
// Skill 6's producer (06-ghl-install-pages/tools/cc_board.py) posts a board
// card on `ingest_task()`, but until U27, a build could run all the way
// through intake with the board unconfigured/unreachable and leave ZERO trace
// that the card never landed — the exact A7 shape (a producer's local
// ledger accumulates evidence while the board mirror silently drops it),
// applied to Skill 6 instead of the Anthology Engine.
//
// U27's ONB half instruments `ingest_task(evidence_root=...)` to ALWAYS write
// `routing/board-ingest-receipt.json` under the run's evidence root — whatever
// the outcome — recording whether MISSION_CONTROL_URL was even set and
// whether the card landed. This check is the Command Center half: it reads
// those SAME on-disk receipts (co-located with this box, same convention as
// `checkAnthologyBoardProjection()` reading the Anthology ledger directly off
// disk rather than over HTTP) and reports DRIFT for any run that completed
// intake (`routing/intake-receipt.json` present — "the run-evidence ledger
// roots" B-U13 names) but whose board-ingest receipt shows the card never
// landed. A run with NO board-ingest receipt at all (pre-U27, or a caller
// that has not threaded `evidence_root=` through yet) is EXCLUDED from the
// drift count — informational only — so shipping this check never turns a
// quiet pre-existing box red.
//
// Also cross-checks the OPPOSITE failure mode the local receipt alone cannot
// see: a card that DID land at ingest time (`ok: true`, a `task_id` was
// returned) but no longer exists in this box's own `tasks` table (deleted /
// archived / never actually persisted server-side despite a 200/201). Same
// same-box assumption as the Anthology check, same DB the gating checks
// already read via `getDb()`.
//
// DESIGN NOTE — mirrors the Anthology check's posture exactly: Skill 6 is
// OPTIONAL per-box tooling. "No evidence-root base directory on this box at
// all" is a legitimate PASS (not applicable), never UNKNOWN/FAIL.

export interface Skill6BoardProjectionResult extends CheckResult {
  ledger_runs?: number;
  board_landed?: number;
  drift_count?: number;
  unwired_count?: number;
}

interface Skill6BoardIngestReceipt {
  mission_control_url_set?: boolean;
  ok?: boolean;
  task_id?: string | null;
  reason?: string;
}

const SKILL6_EVIDENCE_RUN_PREFIX = 'v2-';
const SKILL6_ROUTING_SUBDIR = 'routing';
const SKILL6_INTAKE_RECEIPT_FILENAME = 'intake-receipt.json';
const SKILL6_BOARD_INGEST_RECEIPT_FILENAME = 'board-ingest-receipt.json';

/**
 * Resolve the Skill-6 evidence-root base directory. Mirrors
 * `resolve_evidence_base()` in `06-ghl-install-pages/tools/cc_board.py`
 * EXACTLY (same precedence) so both sides of the reconcile agree on where
 * the evidence lives:
 *   1. `SKILL6_EVIDENCE_BASE_DIR` env override.
 *   2. `$HOME/clawd/skill6-fix` (the operator-box convention documented in
 *      `v2-autonomous-build-sop.md`).
 *   3. `''` — not applicable (no HOME resolvable).
 */
export function resolveSkill6EvidenceBaseDir(): string {
  const explicit = (process.env.SKILL6_EVIDENCE_BASE_DIR || '').trim();
  if (explicit) return explicit;
  const home = process.env.HOME || os.homedir();
  if (home) return path.join(home, 'clawd', 'skill6-fix');
  return '';
}

function readJsonFile<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Every immediate `v2-*` subdirectory of `baseDir` that carries an intake
 *  receipt — mirrors `list_evidence_runs()` in `cc_board.py`. Read-only;
 *  never throws (an unreadable baseDir yields an empty list). */
function listSkill6EvidenceRuns(baseDir: string): string[] {
  try {
    if (!baseDir || !fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) return [];
    return fs
      .readdirSync(baseDir)
      .filter((name) => name.startsWith(SKILL6_EVIDENCE_RUN_PREFIX))
      .map((name) => path.join(baseDir, name))
      .filter((runDir) => {
        try {
          return fs.statSync(runDir).isDirectory() &&
            fs.existsSync(path.join(runDir, SKILL6_ROUTING_SUBDIR, SKILL6_INTAKE_RECEIPT_FILENAME));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

export function checkSkill6BoardProjection(): Skill6BoardProjectionResult {
  const baseDir = resolveSkill6EvidenceBaseDir();

  if (!baseDir || !fs.existsSync(baseDir)) {
    // Not provisioned on this box at all — legitimate PASS, not UNKNOWN.
    return {
      pass: true,
      detail: 'skill6_board_projection: OK — no Skill-6 evidence-root base directory on this box; not applicable',
    };
  }

  let runDirs: string[];
  try {
    runDirs = listSkill6EvidenceRuns(baseDir);
  } catch {
    return {
      pass: false,
      indeterminate: true,
      detail: 'skill6_board_projection: evidence-root base present but could not be listed (locked or unreadable) — UNKNOWN',
    };
  }

  if (runDirs.length === 0) {
    return {
      pass: true,
      ledger_runs: 0,
      detail: 'skill6_board_projection: OK — evidence-root base exists but holds no completed-intake runs (healthy-idle, not drift)',
    };
  }

  const driftRuns: string[] = [];
  const landedTaskIds: string[] = [];
  let unwiredCount = 0;

  for (const runDir of runDirs) {
    const receiptPath = path.join(runDir, SKILL6_ROUTING_SUBDIR, SKILL6_BOARD_INGEST_RECEIPT_FILENAME);
    if (!fs.existsSync(receiptPath)) {
      // No board-ingest receipt: pre-U27 run, or a caller that has not
      // threaded evidence_root= through to ingest_task() yet. Informational
      // only — never counted as drift (see module note above).
      unwiredCount += 1;
      continue;
    }
    const receipt = readJsonFile<Skill6BoardIngestReceipt>(receiptPath);
    if (!receipt) {
      unwiredCount += 1; // unreadable receipt — treat like unwired, not a confirmed drift
      continue;
    }
    if (receipt.mission_control_url_set === false) {
      driftRuns.push(path.basename(runDir));
      continue;
    }
    if (!receipt.ok || !receipt.task_id) {
      driftRuns.push(path.basename(runDir));
      continue;
    }
    landedTaskIds.push(receipt.task_id);
  }

  // Cross-check: a card that landed at ingest time but no longer exists in
  // this box's own tasks table (deleted / archived / never actually
  // persisted despite a 200/201 response) — the opposite failure mode the
  // local receipt alone cannot see. Best-effort: a DB read failure degrades
  // to UNKNOWN, never fabricates a verdict.
  let orphanedCount = 0;
  if (landedTaskIds.length > 0) {
    try {
      const db = getDb();
      for (const taskId of landedTaskIds) {
        const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId) as { id: string } | undefined;
        if (!row) orphanedCount += 1;
      }
    } catch {
      return {
        pass: false,
        indeterminate: true,
        ledger_runs: runDirs.length,
        unwired_count: unwiredCount,
        detail: "skill6_board_projection: could not read this box's task board to confirm landed cards (locked or unavailable) — UNKNOWN",
      };
    }
  }

  const driftCount = driftRuns.length + orphanedCount;

  if (driftCount > 0) {
    return {
      pass: false,
      indeterminate: false,
      ledger_runs: runDirs.length,
      board_landed: landedTaskIds.length - orphanedCount,
      drift_count: driftCount,
      unwired_count: unwiredCount,
      detail: `skill6_board_projection: DRIFT — ${runDirs.length} run(s) completed intake, ${driftCount} card(s) never landed or vanished from the board (${driftRuns.length} never-landed, ${orphanedCount} orphaned). Run: cc_board.py reconcile --json`,
    };
  }

  return {
    pass: true,
    ledger_runs: runDirs.length,
    board_landed: landedTaskIds.length,
    drift_count: 0,
    unwired_count: unwiredCount,
    detail: `skill6_board_projection: OK — ${runDirs.length} run(s) completed intake, ${landedTaskIds.length} card(s) landed and confirmed on the board (projecting)`,
  };
}

// ── check: the "mc_board six" + Skill 35's cycle-manifest variant (U100) ───
//
// U100 generalizes the producer-reconcile pattern B-U13/U27 shipped for
// Skill 6 (checkSkill6BoardProjection above) and U79 shipped for the
// Anthology Engine (checkAnthologyBoardProjection, and
// 59-anthology-engine/scripts/mc_board.py's own `cmd_reconcile`) to the
// remaining fail-soft productized-skill producers:
//   * the "mc_board six" — 49-signature-funnel, 50-email-engine,
//     53-book-writer, 55-product-bio, 56-sales-page-assets,
//     57-social-media-in-a-box — each vendoring the SAME shared,
//     byte-for-byte-identical mc_board.py client (see that file's own
//     docstring), which gained a `reconcile --json` verb + an opt-in
//     `evidence_root` receipt (`<evidence_root>/routing/board-ingest-
//     receipt.json`, `{mc_url_set, ok, task_id}`).
//   * Skill 35's cycle-manifest variant — run-publishing-cycle.sh, which
//     stamps `cc_board_attempt: {mc_token_resolved, ok, task_id}` onto its
//     own `cycle-manifest.json` per publishing cycle (see
//     35-social-media-planner/scripts/cycle_manifest_reconcile.py).
//
// Non-gating, per B-U13: a board-ingest drift here is an operational signal
// (an evidence_root caller has not been wired, or the board was down for a
// run), never a Command Center correctness fault — it must never flip the
// top-level pass/indeterminate verdict. route.ts keeps every field below
// OUT of the `checks` aggregation, exactly like its skill6/anthology
// siblings.

export interface ProducerBoardProjectionResult extends CheckResult {
  ledger_runs?: number;
  board_landed?: number;
  drift_count?: number;
  unwired_count?: number;
}

interface McBoardSixProducer {
  /** Advisory field key on /api/health/deep's `advisory` object. */
  key: string;
  /** The productized-skill directory this producer's mc_board.py vendors
   *  into — mirrors mc_board.py's own `resolve_state_dir()`, which derives
   *  its default evidence base from `Path(__file__).resolve().parents[1].name`
   *  (this same directory name), so both sides resolve the SAME default path
   *  without either side hardcoding the other's absolute location. */
  skillDirName: string;
  /** Human-readable reconcile hint surfaced in the DRIFT detail string. */
  reconcileHint: string;
}

/** The "mc_board six" (U100 spec, verbatim) — the shared, byte-for-byte-
 *  identical mc_board.py client's own docstring names these six skills. */
export const MC_BOARD_SIX_PRODUCERS: McBoardSixProducer[] = [
  {
    key: 'mc_board_49_signature_funnel_projection',
    skillDirName: '49-signature-funnel',
    reconcileHint: '49-signature-funnel/scripts/mc_board.py reconcile --json',
  },
  {
    key: 'mc_board_50_email_engine_projection',
    skillDirName: '50-email-engine',
    reconcileHint: '50-email-engine/mc_board.py reconcile --json',
  },
  {
    key: 'mc_board_53_book_writer_projection',
    skillDirName: '53-book-writer',
    reconcileHint: '53-book-writer/scripts/mc_board.py reconcile --json',
  },
  {
    key: 'mc_board_55_product_bio_projection',
    skillDirName: '55-product-bio',
    reconcileHint: '55-product-bio/scripts/mc_board.py reconcile --json',
  },
  {
    key: 'mc_board_56_sales_page_assets_projection',
    skillDirName: '56-sales-page-assets',
    reconcileHint: '56-sales-page-assets/scripts/mc_board.py reconcile --json',
  },
  {
    key: 'mc_board_57_social_media_in_a_box_projection',
    skillDirName: '57-social-media-in-a-box',
    reconcileHint: '57-social-media-in-a-box/scripts/mc_board.py reconcile --json',
  },
];

interface McBoardIngestReceipt {
  mc_url_set?: boolean;
  ok?: boolean;
  task_id?: string | null;
}

/** Resolve a "mc_board six" producer's run-evidence base directory.
 *  `MC_BOARD_EVIDENCE_BASE_DIR` is a SHARED override (mirrors mc_board.py's
 *  own env var of the same name) — set it and every producer below resolves
 *  the SAME explicit directory; leave it unset and each producer defaults to
 *  its own `$HOME/.openclaw/data/<skillDirName>/runs`. */
function resolveMcBoardSixEvidenceBaseDir(skillDirName: string): string {
  const explicit = (process.env.MC_BOARD_EVIDENCE_BASE_DIR || '').trim();
  if (explicit) return explicit;
  const home = process.env.HOME || os.homedir();
  if (!home) return '';
  return path.join(home, '.openclaw', 'data', skillDirName, 'runs');
}

function listMcBoardSixEvidenceRuns(baseDir: string): string[] {
  try {
    if (!baseDir || !fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) return [];
    return fs
      .readdirSync(baseDir)
      .map((name) => path.join(baseDir, name))
      .filter((runDir) => {
        try {
          return fs.statSync(runDir).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** One producer's advisory board-projection check (U100). Cloned from
 *  `checkSkill6BoardProjection` above, adapted to the mc_board six's flat
 *  `<run>/routing/board-ingest-receipt.json` receipt (no separate intake
 *  receipt — every run dir is a candidate, unfiltered). */
export function checkMcBoardSixProducerProjection(
  producer: McBoardSixProducer
): ProducerBoardProjectionResult {
  const baseDir = resolveMcBoardSixEvidenceBaseDir(producer.skillDirName);

  if (!baseDir || !fs.existsSync(baseDir)) {
    return {
      pass: true,
      detail: `${producer.key}: OK — no run-evidence base directory on this box; not applicable`,
    };
  }

  let runDirs: string[];
  try {
    runDirs = listMcBoardSixEvidenceRuns(baseDir);
  } catch {
    return {
      pass: false,
      indeterminate: true,
      detail: `${producer.key}: evidence-root base present but could not be listed (locked or unreadable) — UNKNOWN`,
    };
  }

  if (runDirs.length === 0) {
    return {
      pass: true,
      ledger_runs: 0,
      detail: `${producer.key}: OK — evidence-root base exists but holds no runs yet (healthy-idle, not drift)`,
    };
  }

  const driftRuns: string[] = [];
  const landedTaskIds: string[] = [];
  let unwiredCount = 0;

  for (const runDir of runDirs) {
    const receiptPath = path.join(runDir, 'routing', 'board-ingest-receipt.json');
    if (!fs.existsSync(receiptPath)) {
      // No board-ingest receipt: a caller that has not threaded evidence_root=
      // through to card_open()/begin_run() yet. Informational only — never
      // counted as drift (mirrors checkSkill6BoardProjection's own module note).
      unwiredCount += 1;
      continue;
    }
    const receipt = readJsonFile<McBoardIngestReceipt>(receiptPath);
    if (!receipt) {
      unwiredCount += 1; // unreadable receipt — treat like unwired, not confirmed drift
      continue;
    }
    if (receipt.mc_url_set === false) {
      driftRuns.push(path.basename(runDir));
      continue;
    }
    if (!receipt.ok || !receipt.task_id) {
      driftRuns.push(path.basename(runDir));
      continue;
    }
    landedTaskIds.push(receipt.task_id);
  }

  // Cross-check: a card that landed at ingest time but no longer exists in
  // this box's own tasks table — the opposite failure mode a local receipt
  // alone cannot see. Best-effort: a DB read failure degrades to UNKNOWN,
  // never fabricates a verdict.
  let orphanedCount = 0;
  if (landedTaskIds.length > 0) {
    try {
      const db = getDb();
      for (const taskId of landedTaskIds) {
        const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId) as { id: string } | undefined;
        if (!row) orphanedCount += 1;
      }
    } catch {
      return {
        pass: false,
        indeterminate: true,
        ledger_runs: runDirs.length,
        unwired_count: unwiredCount,
        detail: `${producer.key}: could not read this box's task board to confirm landed cards (locked or unavailable) — UNKNOWN`,
      };
    }
  }

  const driftCount = driftRuns.length + orphanedCount;

  if (driftCount > 0) {
    return {
      pass: false,
      indeterminate: false,
      ledger_runs: runDirs.length,
      board_landed: landedTaskIds.length - orphanedCount,
      drift_count: driftCount,
      unwired_count: unwiredCount,
      detail: `${producer.key}: DRIFT — ${runDirs.length} run(s), ${driftCount} card(s) never landed or vanished from the board (${driftRuns.length} never-landed, ${orphanedCount} orphaned). Run: ${producer.reconcileHint}`,
    };
  }

  return {
    pass: true,
    ledger_runs: runDirs.length,
    board_landed: landedTaskIds.length,
    drift_count: 0,
    unwired_count: unwiredCount,
    detail: `${producer.key}: OK — ${runDirs.length} run(s), ${landedTaskIds.length} card(s) landed and confirmed on the board (projecting)`,
  };
}

interface Skill35CycleBoardAttempt {
  mc_token_resolved?: boolean;
  ok?: boolean;
  task_id?: string | null;
}

interface Skill35CycleManifest {
  cc_board_attempt?: Skill35CycleBoardAttempt;
}

function resolveSkill35EvidenceBaseDir(): string {
  const explicit = (process.env.SKILL35_EVIDENCE_BASE_DIR || '').trim();
  if (explicit) return explicit;
  const home = process.env.HOME || os.homedir();
  if (!home) return '';
  return path.join(home, '.openclaw', 'data', 'skill-35', 'runs');
}

function listSkill35EvidenceRuns(baseDir: string): string[] {
  try {
    if (!baseDir || !fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) return [];
    return fs
      .readdirSync(baseDir)
      .map((name) => path.join(baseDir, name))
      .filter((runDir) => {
        try {
          return fs.statSync(runDir).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Skill 35's cycle-manifest variant of the producer-reconcile pattern
 *  (U100). Same shape as `checkMcBoardSixProducerProjection`, adapted to
 *  `run-publishing-cycle.sh`'s own `cycle-manifest.json` +
 *  `cc_board_attempt` field (see cycle_manifest_reconcile.py). */
export function checkSkill35CycleProjection(): ProducerBoardProjectionResult {
  const key = 'skill35_cycle_projection';
  const baseDir = resolveSkill35EvidenceBaseDir();

  if (!baseDir || !fs.existsSync(baseDir)) {
    return {
      pass: true,
      detail: `${key}: OK — no Skill-35 runs-root on this box; not applicable`,
    };
  }

  let runDirs: string[];
  try {
    runDirs = listSkill35EvidenceRuns(baseDir);
  } catch {
    return {
      pass: false,
      indeterminate: true,
      detail: `${key}: runs-root present but could not be listed (locked or unreadable) — UNKNOWN`,
    };
  }

  if (runDirs.length === 0) {
    return {
      pass: true,
      ledger_runs: 0,
      detail: `${key}: OK — runs-root exists but holds no publishing cycles yet (healthy-idle, not drift)`,
    };
  }

  const driftRuns: string[] = [];
  const landedTaskIds: string[] = [];
  let unwiredCount = 0;

  for (const runDir of runDirs) {
    const manifestPath = path.join(runDir, 'cycle-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      unwiredCount += 1;
      continue;
    }
    const manifest = readJsonFile<Skill35CycleManifest>(manifestPath);
    const attempt = manifest?.cc_board_attempt;
    if (!attempt) {
      // A pre-U100 manifest (run-publishing-cycle.sh ran before this unit
      // shipped) — informational only, never drift.
      unwiredCount += 1;
      continue;
    }
    if (attempt.mc_token_resolved === false) {
      driftRuns.push(path.basename(runDir));
      continue;
    }
    if (!attempt.ok || !attempt.task_id) {
      driftRuns.push(path.basename(runDir));
      continue;
    }
    landedTaskIds.push(attempt.task_id);
  }

  let orphanedCount = 0;
  if (landedTaskIds.length > 0) {
    try {
      const db = getDb();
      for (const taskId of landedTaskIds) {
        const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId) as { id: string } | undefined;
        if (!row) orphanedCount += 1;
      }
    } catch {
      return {
        pass: false,
        indeterminate: true,
        ledger_runs: runDirs.length,
        unwired_count: unwiredCount,
        detail: `${key}: could not read this box's task board to confirm landed cards (locked or unavailable) — UNKNOWN`,
      };
    }
  }

  const driftCount = driftRuns.length + orphanedCount;

  if (driftCount > 0) {
    return {
      pass: false,
      indeterminate: false,
      ledger_runs: runDirs.length,
      board_landed: landedTaskIds.length - orphanedCount,
      drift_count: driftCount,
      unwired_count: unwiredCount,
      detail: `${key}: DRIFT — ${runDirs.length} cycle(s), ${driftCount} card(s) never landed or vanished from the board (${driftRuns.length} never-landed, ${orphanedCount} orphaned). Run: 35-social-media-planner/scripts/cycle_manifest_reconcile.py reconcile --json`,
    };
  }

  return {
    pass: true,
    ledger_runs: runDirs.length,
    board_landed: landedTaskIds.length,
    drift_count: 0,
    unwired_count: unwiredCount,
    detail: `${key}: OK — ${runDirs.length} cycle(s), ${landedTaskIds.length} card(s) landed and confirmed on the board (projecting)`,
  };
}

// ── check: notification-failures.jsonl size (U102 / C12.3 item 10b) ────────
//
// PROBLEM (master spec C12.3 item 10): the MSG-07 undeliverable ledger
// (`notify.ts`'s `notification-failures.jsonl` — the last rung of the
// escalation ladder, written whenever an owner/system notification could not
// be delivered by any other means) is durable and complete, but it is only
// ever discoverable by reading server logs / SSHing into the box. This check
// surfaces its SIZE as an advisory health field so an operator can see
// "undeliverables are accumulating" from the same JSON payload that already
// reports every other posture check — no shell access required.
//
// DESIGN NOTE — same posture as every other advisory check in this file
// (anthology/skill6 board projection, sweep_liveness): non-gating. A pile of
// undeliverable records is an OPERATIONAL signal (something downstream —
// Telegram config, an operator chat id — needs attention), never a Command
// Center correctness fault, so it must never flip the top-level pass/
// indeterminate verdict or trip auto-rollback. The route wrapper (route.ts)
// enforces that by keeping this OUT of the `checks` aggregation, exactly like
// its siblings.
//
// The absolute file path is deliberately OMITTED from the returned detail —
// this check is surfaced through the unauthenticated /api/health/deep bypass
// (same discipline `checkAnthologyBoardProjection` / `checkSkill6BoardProjection`
// already apply to their own resolved paths).

/** Default advisory threshold (line count) above which the check flags
 *  accumulation. Purely informational — see DESIGN NOTE above; overridable
 *  via NOTIFICATION_FAILURES_LOG_WARN_LINES for a box with different traffic. */
export const NOTIFICATION_FAILURES_LOG_WARN_LINES_DEFAULT = 25;

function resolveNotificationFailuresWarnLines(): number {
  const parsed = parseInt(process.env.NOTIFICATION_FAILURES_LOG_WARN_LINES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : NOTIFICATION_FAILURES_LOG_WARN_LINES_DEFAULT;
}

export interface NotificationFailuresLogCheckResult extends CheckResult {
  exists: boolean;
  size_bytes: number;
  line_count: number;
}

export function checkNotificationFailuresLog(): NotificationFailuresLogCheckResult {
  try {
    const stats = getNotificationFailuresLogStats();

    if (!stats.exists) {
      return {
        pass: true,
        exists: false,
        size_bytes: 0,
        line_count: 0,
        detail: 'notification_failures_log: OK — no notification-failures.jsonl on this box (no undeliverable notifications ever recorded)',
      };
    }

    const warnLines = resolveNotificationFailuresWarnLines();

    if (stats.lineCount > warnLines) {
      return {
        pass: false,
        indeterminate: false,
        exists: true,
        size_bytes: stats.sizeBytes,
        line_count: stats.lineCount,
        detail: `notification_failures_log: ${stats.lineCount} undeliverable notification(s) recorded (${stats.sizeBytes} bytes) — above the ${warnLines}-line advisory threshold; review notification-failures.jsonl on this box (non-gating)`,
      };
    }

    return {
      pass: true,
      exists: true,
      size_bytes: stats.sizeBytes,
      line_count: stats.lineCount,
      detail: `notification_failures_log: OK — ${stats.lineCount} undeliverable notification(s) recorded (${stats.sizeBytes} bytes), within the ${warnLines}-line advisory threshold`,
    };
  } catch (err) {
    return {
      pass: true,
      indeterminate: true,
      exists: false,
      size_bytes: 0,
      line_count: 0,
      detail: `notification_failures_log: could not read log stats — ${err instanceof Error ? err.message : String(err)} (UNKNOWN; non-gating)`,
    };
  }
}

// ── check: trust-coverage health metric (U94 / X.2.3) ───────────────────────
//
// "Requester-stamping completeness at every human creation door + a
// trust-coverage health metric >= 95%." The three enumerated doors
// (Command-Center UI create, Telegram/CEO-chat ingest, interview-driven
// department provisioning) each tag their own task_created event with a
// SEPARATE `requester_stamp_check` event (see src/lib/tasks.ts createTaskCore
// and src/app/api/departments/route.ts createDepartmentInDbDirect) recording
// whether THAT call landed a requester stamp — independent of the tasks
// table's requester_channel/requester_chat_id columns, so the ratio can never
// be circular (a door that never fires this event is a producer/operator
// create and correctly stays OUT of the denominator, per "producer-created
// tasks keep the operator-digest fallback").
export interface TrustCoverageResult extends CheckResult {
  human_door_total?: number;
  human_door_stamped?: number;
  coverage_pct?: number;
}

/** The X.2.3 floor: coverage below this on a box with real traffic is DRIFT. */
export const TRUST_COVERAGE_MIN_PCT = 95;

export function checkTrustCoverage(): TrustCoverageResult {
  try {
    const db = getDb();
    const totalRow = db
      .prepare(`SELECT COUNT(*) as c FROM events WHERE type = 'requester_stamp_check'`)
      .get() as { c: number } | undefined;
    const total = totalRow?.c ?? 0;

    if (total === 0) {
      // No human-door creation has ever fired on this box — legitimate PASS
      // (nothing to measure yet), never a false DRIFT on a fresh install.
      return {
        pass: true,
        human_door_total: 0,
        human_door_stamped: 0,
        coverage_pct: 100,
        detail:
          'trust_coverage: OK — no human-door task creations recorded yet on this box; nothing to measure',
      };
    }

    const stampedRow = db
      .prepare(
        `SELECT COUNT(*) as c FROM events
          WHERE type = 'requester_stamp_check'
            AND json_extract(metadata, '$.hasRequester') = 1`,
      )
      .get() as { c: number } | undefined;
    const stamped = stampedRow?.c ?? 0;

    const pct = Math.round((stamped / total) * 10000) / 100;
    const pass = pct >= TRUST_COVERAGE_MIN_PCT;

    return {
      pass,
      human_door_total: total,
      human_door_stamped: stamped,
      coverage_pct: pct,
      detail: pass
        ? `trust_coverage: OK — ${stamped}/${total} human-door task(s) (${pct}%) carry a requester stamp (>= ${TRUST_COVERAGE_MIN_PCT}% floor)`
        : `trust_coverage: DRIFT — only ${stamped}/${total} human-door task(s) (${pct}%) carry a requester stamp (< ${TRUST_COVERAGE_MIN_PCT}% floor)`,
    };
  } catch (err) {
    // Never fabricate a verdict on a read failure (locked/unavailable DB) —
    // degrade to UNKNOWN, non-gating, same posture as every other advisory
    // check in this file.
    return {
      pass: true,
      indeterminate: true,
      detail: `trust_coverage: advisory probe unavailable — ${
        err instanceof Error ? err.message : String(err)
      } (UNKNOWN; non-gating)`,
    };
  }
}

// ── check: persona match/grounding observability probe (A-U12) ─────────────
//
// CC half of the both-repo unit (ONB half: shared-utils/persona_grounding_
// health_probe.py, merged 2026-07-16, commit 4411c87b). The probe's own
// module docstring names this file + this posture explicitly: "The Command
// Center's deep-health check (src/lib/health/*) is expected to invoke this
// script as a subprocess (`--json`) exactly as it already does for its other
// box-local checks, and fold `persona_match` + `grounding` into its own
// deep-health response."
//
// The probe is a SIBLING of shared-utils/embedding_health.py in every way
// that matters here (single `--json`-emitting CLI, spawned with execFile,
// degrade-on-any-failure), so this check clones probeEmbeddingHealthPy's
// shape (src/app/api/health/route.ts) rather than inventing a new one.
//
// CRITICAL: the probe's imports are relative to the INSTALLED skill root
// (`../23-ai-workforce-blueprint/scripts/persona_blend.py`), and CC tracks
// NO `23-ai-workforce-blueprint` directory (0 files) — vendoring the probe
// into CC's own `shared-utils/` (the embedding_health.py pattern) would
// break its imports. Resolve it at the installed skills root instead, the
// same `resolveOpenClawRoot()` precedent persona-selector.ts already
// established for `persona-selector-v2.py` (same root, same `skills/`
// layout, siblings on every box that has both skill folders installed).
//
// The probe ALWAYS exits 0 by design (its docstring: "a non-zero exit would
// tempt a caller into treating an advisory read as a health gate") —
// degraded/healthy is conveyed ONLY via `grounding.degraded` in the JSON
// body, never via exit code. This check never keys on exit code for that
// reason; a non-zero exit / thrown execFile error is treated exactly like
// any other probe-unavailable failure (degrade to UNKNOWN, non-gating).

export interface PersonaMatchDistribution {
  count: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  buckets: { low: number; mid: number; high: number };
}

export interface PersonaGroundingInfo {
  degraded: boolean;
  event?: string;
  reasons?: string[];
  layers?: unknown;
}

export interface PersonaGroundingCheckResult extends CheckResult {
  persona_match?: PersonaMatchDistribution;
  grounding?: PersonaGroundingInfo;
}

const PERSONA_GROUNDING_PROBE_TIMEOUT_MS = 5_000;

function resolveOpenClawRootForPersonaGrounding(): string {
  if (process.env.OPENCLAW_ROOT) return process.env.OPENCLAW_ROOT;
  // VPS / Hostinger Docker default — mirrors persona-selector.ts's
  // resolveOpenClawRoot() precedent exactly.
  if (process.env.OPENCLAW_PLATFORM === 'vps') return '/data/.openclaw';
  return path.join(os.homedir(), '.openclaw');
}

/** Env-var override for tests / non-standard installs, mirroring
 *  EMBEDDING_HEALTH_SCRIPT's precedent in src/app/api/health/route.ts. */
export function resolvePersonaGroundingHealthScript(): string {
  const override = process.env.PERSONA_GROUNDING_HEALTH_SCRIPT;
  if (override) return override;
  return path.join(
    resolveOpenClawRootForPersonaGrounding(),
    'skills',
    'shared-utils',
    'persona_grounding_health_probe.py',
  );
}

/** Type-guard the trio the A-U12 acceptance schema requires: {count, mean,
 *  buckets}. The probe's real shape is a superset (also min/max) — accept
 *  the superset, but never fabricate a distribution when the required trio
 *  is absent or malformed. */
function isValidPersonaMatchShape(v: unknown): v is Partial<PersonaMatchDistribution> & {
  count: number;
  buckets: { low: number; mid: number; high: number };
} {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.count !== 'number') return false;
  if (!(o.mean === null || o.mean === undefined || typeof o.mean === 'number')) return false;
  const b = o.buckets as Record<string, unknown> | undefined;
  if (!b || typeof b !== 'object') return false;
  return typeof b.low === 'number' && typeof b.mid === 'number' && typeof b.high === 'number';
}

/**
 * Pure read for the deep-health advisory surface (A-U12 acceptance (a)).
 * Spawns the ONB-shipped probe with `--json`, schema-validates the
 * `persona_match` trio, and folds `grounding` alongside it. NEVER gates the
 * top-level pass/indeterminate verdict — the caller (the deep health route)
 * must place this under `advisory`, mirroring every other check in this
 * file's posture. `pass: false` here reflects a confirmed grounding
 * degrade for the field's OWN value only (same posture as
 * checkSweepLiveness's `pass: false` on a stale watcher) — it carries no
 * gating weight because `advisory` is structurally excluded from
 * `gatingChecks` in the route.
 */
export async function checkPersonaGrounding(): Promise<PersonaGroundingCheckResult> {
  try {
    const script = resolvePersonaGroundingHealthScript();
    if (!fs.existsSync(script)) {
      return {
        pass: true,
        indeterminate: true,
        detail: `persona_match: probe script not found at ${script} — not yet deployed on this box (UNKNOWN; non-gating)`,
      };
    }

    let stdout: string;
    try {
      const res = await execFileAsync('python3', [script, '--json'], {
        timeout: PERSONA_GROUNDING_PROBE_TIMEOUT_MS,
        encoding: 'utf-8',
        maxBuffer: 1_000_000,
      });
      stdout = res.stdout;
    } catch (spawnErr) {
      return {
        pass: true,
        indeterminate: true,
        detail: `persona_match: advisory probe unavailable — ${
          spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
        } (UNKNOWN; non-gating)`,
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      return {
        pass: true,
        indeterminate: true,
        detail: 'persona_match: probe emitted non-JSON output (UNKNOWN; non-gating)',
      };
    }

    const personaMatch = parsed.persona_match;
    if (!isValidPersonaMatchShape(personaMatch)) {
      return {
        pass: true,
        indeterminate: true,
        detail:
          'persona_match: probe output failed schema validation (missing/malformed count|mean|buckets) — (UNKNOWN; non-gating)',
      };
    }

    const groundingRaw = parsed.grounding as Record<string, unknown> | undefined;
    const degraded = groundingRaw?.degraded === true;

    const distribution: PersonaMatchDistribution = {
      count: personaMatch.count,
      mean: personaMatch.mean ?? null,
      min: typeof personaMatch.min === 'number' ? personaMatch.min : null,
      max: typeof personaMatch.max === 'number' ? personaMatch.max : null,
      buckets: {
        low: personaMatch.buckets.low,
        mid: personaMatch.buckets.mid,
        high: personaMatch.buckets.high,
      },
    };

    const grounding: PersonaGroundingInfo = {
      degraded,
      event: typeof groundingRaw?.event === 'string' ? groundingRaw.event : undefined,
      reasons: Array.isArray(groundingRaw?.reasons) ? (groundingRaw!.reasons as string[]) : undefined,
      layers: groundingRaw?.layers,
    };

    return {
      pass: !degraded,
      persona_match: distribution,
      grounding,
      detail: degraded
        ? `persona_match: grounding DEGRADED — ${distribution.count} sample(s) in the match-score log, mean ${
            distribution.mean ?? 'n/a'
          } (advisory only, non-gating)`
        : `persona_match: OK — ${distribution.count} sample(s) in the match-score log, mean ${
            distribution.mean ?? 'n/a'
          }, grounding healthy`,
    };
  } catch (err) {
    // Absolute last resort — never let an unexpected throw here reach the
    // route's outer catch (which would return 500 + pass:false and could
    // trip auto-rollback).
    return {
      pass: true,
      indeterminate: true,
      detail: `persona_match: advisory probe unavailable — ${
        err instanceof Error ? err.message : String(err)
      } (UNKNOWN; non-gating)`,
    };
  }
}
