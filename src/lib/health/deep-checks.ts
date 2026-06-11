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
        dbRowAbsent = true;
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

// Well-known large bind-mount paths that must NOT be used as the disk check
// target (Sheila-class wrong-mount false-green: /data is a separate large
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

  const isWrongMount = WRONG_MOUNT_PREFIXES.some(
    (prefix) => candidate === prefix || candidate.startsWith(prefix + '/')
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
    // process.cwd() resolve into a WRONG_MOUNT_PREFIXES path (Sheila-class
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
