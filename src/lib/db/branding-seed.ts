/**
 * B.3 Branding Seed Guard
 *
 * PRD Addendum B §B.3 (P0): The seed may create "Default" ONLY when no
 * config/company-config.json exists on the box. If branding config exists, it
 * seeds FROM the config (name, slug, colors, logo). It NEVER overwrites an
 * existing non-Default company row under any circumstances.
 *
 * B.1 partial-config rule alignment: config present but companyName is empty,
 * null, or whitespace = MISCONFIGURED — the seed must NOT "fix" that by
 * writing "Default" or any synthesised name. In that state this function
 * returns { seeded: false, reason: 'partial-config' } so the caller knows to
 * flag the box as misconfigured.
 *
 * B.3 leg-2 hook for the onboarding `brandingSeeded` closeout leg (lands in
 * openclaw-onboarding separately):
 *   The external closeout script should call this function after writing
 *   company-config.json to the box, then verify the returned `companyId`
 *   matches the expected slug. The DB is now the ground truth.
 *
 * Exported for use by:
 *   - src/lib/db/migrations.ts  (autoSeedFromDepartmentsJson replacement)
 *   - future: openclaw-onboarding closeout brandingSeeded leg
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { ensureRuntimeConfigFile } from '../runtime-config';

export interface BrandingSeedResult {
  /** Whether a company row was actually written this call. */
  seeded: boolean;
  /** The company id/slug that exists (or was just created). */
  companyId: string | null;
  /** Human-readable outcome for logging. */
  reason:
    | 'already-exists-non-default'   // Existing non-Default row — no-op (correct)
    | 'seeded-from-config'           // Config present + valid name → wrote real brand
    | 'seeded-default-no-config'     // No config file → Default allowed
    | 'partial-config'               // Config file exists but companyName empty/blank
    | 'already-default'              // Already a Default row, no config → left as-is
    | 'table-missing';               // companies table doesn't exist yet
}

/**
 * Unpopulated-template sentinels for companyName.
 *
 * The repo ships config/company-config.example.json at "template state" — companyName
 * "Your Company", empty industry, departments:[] — and `.github/workflows/
 * config-guard.yml` ENFORCES that exact value on main. That template is NOT a
 * real client: a box still carrying it has never had Skill-23 closeout write the
 * client brand. Before this guard, `seedCompanyGuarded` treated "Your Company" as
 * a valid name and seeded a bogus `your-company` company row, so every department
 * seeded afterwards landed under the wrong `company_id` (attribution drift). We
 * now treat these sentinels EXACTLY like a blank name: partial-config, fail-closed,
 * nothing written — the box is flagged misconfigured rather than silently
 * mis-attributed. Matching is trimmed + case-insensitive.
 */
const TEMPLATE_COMPANY_NAMES = new Set([
  'your company',       // config/company-config.json template (config-guard.yml)
  'your company name',  // README env-var placeholder (COMPANY_NAME="Your Company Name")
]);

/** True when `name` is the unpopulated repo/template placeholder, not a real brand. */
export function isTemplateCompanyName(name: string | null | undefined): boolean {
  return TEMPLATE_COMPANY_NAMES.has(String(name ?? '').trim().toLowerCase());
}

export interface CompanyBrandingConfig {
  companyName: string;
  companySlug?: string;
  industry?: string;
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  commandCenterName?: string;
}

/**
 * The canonical list of config/company-config.json search paths (same order
 * as the rest of the codebase).
 *
 * When `cwd` is provided explicitly (e.g. for a specific install location or
 * in tests), ONLY the cwd-relative path is returned — the home-directory
 * fallbacks are skipped. This avoids picking up a neighbour install's config.
 *
 * When `cwd` is omitted the full fallback list is returned (production default).
 */
export function findCompanyConfigPaths(cwd?: string): string[] {
  const base = cwd ?? process.cwd();
  const cwdCandidate = ensureRuntimeConfigFile('company-config.json', base);

  // If an explicit cwd was supplied, search only that location.
  if (cwd !== undefined) {
    return [cwdCandidate];
  }

  // No explicit cwd — full fallback list for production use.
  const home = process.env.HOME ?? (process.platform === 'win32' ? process.env.USERPROFILE ?? '' : '');
  return [
    cwdCandidate,
    path.join(home, 'projects', 'command-center', 'config', 'company-config.json'),
    path.join(home, 'projects', 'mission-control', 'config', 'company-config.json'),
    path.join(home, 'clawd', 'projects', 'blackceo-command-center', 'config', 'company-config.json'),
    path.join('/opt', 'mission-control', 'config', 'company-config.json'),
    path.join('/data', 'projects', 'command-center', 'config', 'company-config.json'),
  ];
}

/**
 * Read company-config.json from the box. Returns null when the file is absent.
 * Returns an object with an EMPTY companyName when the file exists but the
 * field is blank (partial-config state per B.1 rule).
 */
export function readCompanyConfigFromDisk(cwd?: string): CompanyBrandingConfig | null {
  const candidates = findCompanyConfigPaths(cwd);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      // File present — return it even if companyName is blank (caller must
      // detect partial-config; we do NOT silently default to something).
      return {
        companyName: typeof raw.companyName === 'string' ? raw.companyName : '',
        companySlug: typeof raw.companySlug === 'string' ? raw.companySlug : undefined,
        industry: typeof raw.industry === 'string' ? raw.industry : undefined,
        logoUrl: typeof raw.logoUrl === 'string' ? raw.logoUrl : undefined,
        primaryColor: typeof raw.primaryColor === 'string' ? raw.primaryColor : undefined,
        secondaryColor: typeof raw.secondaryColor === 'string' ? raw.secondaryColor : undefined,
        commandCenterName: typeof raw.commandCenterName === 'string' ? raw.commandCenterName : undefined,
      };
    } catch {
      // Malformed JSON — treat as absent (don't fall through to Default)
      console.warn('[branding-seed] Failed to parse', candidate, '— treating as absent');
      return null;
    }
  }
  return null; // No config file found
}

/**
 * Derive a URL-safe slug from a company name.
 */
export function slugifyCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'company';
}

/**
 * The single authoritative company-seed function.
 *
 * Decision tree (spec from B.3 + B.1):
 *
 *   1. companies table missing → return table-missing (caller handles migration ordering)
 *   2. Non-Default company row already exists → return already-exists-non-default (NEVER overwrite)
 *   3. company-config.json exists on disk:
 *        a. companyName is empty/blank → return partial-config (B.1 misconfigured state)
 *        b. companyName is valid → upsert/seed from config → return seeded-from-config
 *   4. No config file:
 *        a. Default row already present → return already-default (leave as-is)
 *        b. No row at all → INSERT Default → return seeded-default-no-config
 *
 * All DB operations are idempotent (INSERT OR IGNORE). The function never
 * deletes or modifies existing rows.
 */
export function seedCompanyGuarded(
  db: Database.Database,
  opts?: { cwd?: string },
): BrandingSeedResult {
  // Step 1: guard against missing table (pre-migration state)
  try {
    db.prepare('SELECT COUNT(*) FROM companies').get();
  } catch {
    return { seeded: false, companyId: null, reason: 'table-missing' };
  }

  // Step 2: check for any existing non-Default company row
  const existing = db.prepare(
    "SELECT id, name FROM companies WHERE name != 'Default' LIMIT 1"
  ).get() as { id: string; name: string } | undefined;

  if (existing) {
    console.log('[branding-seed] Existing company row found:', existing.name, '— seed is a no-op');
    return { seeded: false, companyId: existing.id, reason: 'already-exists-non-default' };
  }

  // Step 3: read company-config.json
  const config = readCompanyConfigFromDisk(opts?.cwd);

  if (config !== null) {
    // Config file exists — check if companyName is valid (B.1 partial-config rule)
    const name = config.companyName.trim();
    if (!name) {
      console.warn(
        '[branding-seed] company-config.json exists but companyName is empty — ' +
          'box is MISCONFIGURED; seed aborted (partial-config)'
      );
      return { seeded: false, companyId: null, reason: 'partial-config' };
    }

    // Unpopulated template sentinel ("Your Company"): treat exactly like a blank
    // name — the box still carries the repo template and has NOT been branded, so
    // FAIL CLOSED rather than seed a bogus `your-company` row that would then own
    // every department (attribution drift). Real client config replaces this value
    // at Skill-23 closeout.
    if (isTemplateCompanyName(name)) {
      console.warn(
        `[branding-seed] company-config.json companyName is the unpopulated template ("${name}") — ` +
          'box is MISCONFIGURED (never branded); seed aborted (partial-config)'
      );
      return { seeded: false, companyId: null, reason: 'partial-config' };
    }

    // Valid config — seed from it
    const slug = (config.companySlug?.trim() || slugifyCompanyName(name));
    const configJson = JSON.stringify({
      primaryColor: config.primaryColor,
      secondaryColor: config.secondaryColor,
      commandCenterName: config.commandCenterName,
    });

    db.prepare(
      'INSERT OR IGNORE INTO companies (id, name, slug, industry, logo_url, config) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      slug,
      name,
      slug,
      config.industry ?? '',
      config.logoUrl ?? null,
      configJson,
    );

    console.log('[branding-seed] Seeded company from config:', name, '(slug:', slug + ')');
    return { seeded: true, companyId: slug, reason: 'seeded-from-config' };
  }

  // Step 4: no config file — Default is only acceptable when truly unconfigured
  const defaultRow = db.prepare("SELECT id FROM companies WHERE name = 'Default' LIMIT 1").get() as
    | { id: string }
    | undefined;

  if (defaultRow) {
    return { seeded: false, companyId: defaultRow.id, reason: 'already-default' };
  }

  // Nothing at all — allow Default for truly unconfigured boxes
  db.prepare(
    "INSERT OR IGNORE INTO companies (id, name, slug, industry, config) VALUES ('default', 'Default', 'default', '', '{}')"
  ).run();

  console.log('[branding-seed] No company-config.json found — seeded Default (unconfigured box)');
  return { seeded: true, companyId: 'default', reason: 'seeded-default-no-config' };
}
