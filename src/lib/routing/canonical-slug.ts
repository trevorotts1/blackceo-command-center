/**
 * Canonical Department Slug Normalization
 *
 * Three incompatible slug schemes existed across the codebase:
 *   1. Router DEFAULT_DEPARTMENTS ids:     marketing, web-development, ceo-com
 *   2. Live workspace slugs from seed:     dept-marketing, dept-webdev, dept-ceo
 *   3. ZHC canonical bare slugs:           marketing, app-development, billing-finance
 *
 * This module provides ONE function — canonicalDeptSlug — that maps ANY
 * variant to the ZHC canonical bare slug set.  Apply it at every join point
 * where a slug from user input, a DB column, or the workspace auto-seed meets
 * routing or SOP-match logic.
 *
 * Canonical set (ZHC 24-department model, +1 mandatory catch-all):
 *   master-orchestrator, marketing, sales, billing-finance, customer-support,
 *   web-development, app-development, graphics, video, audio, research,
 *   communications, crm, openclaw-maintenance, legal, social-media,
 *   paid-advertisement, presentations, client-coaches, course-creator,
 *   podcast, community-management, personal-assistant, security,
 *   general-task (catch-all, mandatory on every client)
 */

/** The authoritative ZHC canonical department slug set. */
export const CANONICAL_SLUGS = new Set([
  'master-orchestrator',
  'marketing',
  'sales',
  'billing-finance',
  'customer-support',
  'web-development',
  'app-development',
  'graphics',
  'video',
  'audio',
  'research',
  'communications',
  'crm',
  'openclaw-maintenance',
  'legal',
  'social-media',
  'paid-advertisement',
  'presentations',
  'client-coaches',
  'course-creator',
  'podcast',
  'community-management',
  'personal-assistant',
  // General Task — mandatory catch-all dept. Every client gets one.
  // Reached only via the confidence-floor fallback in comDispatch(); never
  // wins keyword / semantic routing on merit (priority 1, empty keywords).
  'general-task',
  // Engineering — promoted to CORE/FLOOR dept (UNIT ENG — 2026-06-28).
  'engineering',
]);

/**
 * Explicit alias map: every non-canonical variant → its canonical slug.
 * Matching is done AFTER stripping the "dept-" prefix and lower-casing,
 * so each entry here only needs to handle the remaining variant.
 */
const ALIAS_MAP: Record<string, string> = {
  // CEO / master-orchestrator variants
  'ceo':               'master-orchestrator',
  'ceo-com':           'master-orchestrator',
  'com':               'master-orchestrator',
  'central-operations':'master-orchestrator',

  // billing variants
  'billing':           'billing-finance',

  // web-dev variants
  'webdev':            'web-development',
  'web-dev':           'web-development',
  'web':               'web-development',

  // app-dev variants → app-development (a DISTINCT chosen department with its own
  // Kanban lane). App Development and Engineering are two separate canonical
  // departments (both live in CANONICAL_SLUGS and departments.config.ts uses
  // 'app-development'); a client that chose BOTH must get BOTH lanes. Mapping
  // 'app-development' → 'engineering' here (removed 2026-07-08) collapsed the two
  // during the seed dedup (findCanonicalWorkspaceId), so App Development never got
  // a lane on a box that also had Engineering. 'app-development' is therefore left
  // to resolve to itself (Step-4 canonical passthrough), never aliased away.
  'appdev':             'app-development',
  'app-dev':            'app-development',
  'mobile':             'app-development',
  // engineering aliases → engineering (canonical CORE slug). These stay pointed at
  // 'engineering' — only the destructive 'app-development' → 'engineering' entry was
  // removed, because App Development is its own chosen department.
  'software-development': 'engineering',
  'software-dev':         'engineering',
  'apps':                 'engineering',

  // video variants
  'video-production':  'video',

  // audio variants
  'audio-production':  'audio',

  // legal variants
  'legal-compliance':  'legal',
  'compliance':        'legal',

  // customer-support variants
  'support':           'customer-support',
  'customer-service':  'customer-support',

  // communications variants
  'comms':             'communications',
  'communication':     'communications',

  // social-media variants
  'social':            'social-media',

  // paid-advertisement variants
  'paid-ads':          'paid-advertisement',
  'paid-advertising':  'paid-advertisement',

  // openclaw-maintenance variants
  'openclaw':          'openclaw-maintenance',

  // general-task aliases
  'general':           'general-task',
  'misc':              'general-task',
  'catch-all':         'general-task',
  'catchall':          'general-task',
  'unclassified':      'general-task',

  // legacy department slugs that have no canonical equivalent yet —
  // normalize to lowercase but leave as-is so downstream code can still
  // route them without a crash.  (legacy)
  'operations':        'operations',
  'hr':                'hr',
  'it':                'it',
  'creative':          'creative',
  'security':          'security',
};

/**
 * Map any department slug variant to the canonical ZHC bare slug.
 *
 * Steps:
 *  1. Lowercase + trim
 *  2. Strip leading "dept-" prefix (workspace auto-seed format)
 *  3. Look up in ALIAS_MAP for explicit remapping
 *  4. If the result is already canonical, return as-is
 *  5. Trailing "-dept" suffix (legacy folder / fabricated-demo-seed shape —
 *     see src/app/api/departments/[id]/personas/route.ts's own "legacy
 *     <id>-dept suffixed folder... very old installs" comment, and the 5
 *     fabricated recommendation-seed ids migration 103 purges by exact
 *     fingerprint: marketing-dept, sales-dept, operations-dept,
 *     creative-dept, support-dept). RECOGNITION-GATED, never blind: only
 *     strips when the stripped form is ALREADY a known alias or canonical
 *     slug, so an arbitrary custom id that merely ends in "-dept" (a
 *     client's own "my-custom-dept" workspace, or a deliberately
 *     dept-suffixed real department name) is never mutated into a
 *     different, shorter, unrecognized value.
 *  6. Otherwise return the normalized-but-unknown slug (lowercase, no
 *     "dept-") so callers never crash — they just get a gracefully-
 *     degraded value.
 *
 * @example
 *   canonicalDeptSlug('dept-webdev')      → 'web-development'
 *   canonicalDeptSlug('ceo-com')          → 'master-orchestrator'
 *   canonicalDeptSlug('billing')          → 'billing-finance'
 *   canonicalDeptSlug('marketing')        → 'marketing'
 *   canonicalDeptSlug('DEPT-MARKETING')   → 'marketing'
 *   canonicalDeptSlug('dept-ceo')         → 'master-orchestrator'
 *   canonicalDeptSlug('video-production') → 'video'
 *   canonicalDeptSlug('sales-dept')       → 'sales'
 *   canonicalDeptSlug('dept-crm-dept')    → 'crm'
 *   canonicalDeptSlug('my-custom-dept')   → 'my-custom-dept' (unresolved, unchanged)
 */
export function canonicalDeptSlug(slug: string | null | undefined): string {
  if (!slug) return '';

  // Step 1: normalize case and whitespace
  let s = slug.trim().toLowerCase();

  // Step 2: strip "dept-" prefix
  if (s.startsWith('dept-')) {
    s = s.slice(5);
  }

  // Step 3: alias map lookup
  if (Object.prototype.hasOwnProperty.call(ALIAS_MAP, s)) {
    return ALIAS_MAP[s];
  }

  // Step 4: already canonical
  if (CANONICAL_SLUGS.has(s)) {
    return s;
  }

  // Step 5: trailing "-dept" suffix, recognition-gated (see doc comment above).
  if (s.length > 5 && s.endsWith('-dept')) {
    const stripped = s.slice(0, -5);
    if (Object.prototype.hasOwnProperty.call(ALIAS_MAP, stripped)) {
      return ALIAS_MAP[stripped];
    }
    if (CANONICAL_SLUGS.has(stripped)) {
      return stripped;
    }
  }

  // Step 6: return normalized-but-unknown slug (graceful fallback)
  return s;
}

/**
 * Return true if `slug` (after canonicalization) is the master-orchestrator
 * / CEO department.
 */
export function isMasterOrchestratorSlug(slug: string | null | undefined): boolean {
  return canonicalDeptSlug(slug) === 'master-orchestrator';
}

/**
 * Every RAW department slug that canonicalizes to the same department as `slug`.
 *
 * This is the INVERSE of canonicalDeptSlug: given any variant, return the full
 * set of stored spellings that mean the same department — the canonical slug,
 * every ALIAS_MAP key pointing at it, and the "dept-" prefixed form of each.
 *
 * Exists so a DB query can do the alias-aware match IN SQL instead of pulling
 * the whole table into JS and filtering there (C10). A `sops` row may still be
 * keyed to a LEGACY alias ('webdev', 'billing') if C2's re-key migration hasn't
 * reached that box yet, while the caller always queries the CANONICAL slug — so
 * an exact `department = ?` silently drops those rows. Expanding to
 * `LOWER(TRIM(department)) IN (...)` keeps the filter in SQLite while still
 * matching every alias.
 *
 * Returns lowercase, de-duplicated values. An unknown slug returns just itself
 * (+ its dept- form), matching canonicalDeptSlug's graceful Step-5 fallback, so
 * a caller never gets an empty IN-list and never accidentally matches everything.
 *
 * @example
 *   expandDeptSlugAliases('web-development')
 *     → ['web-development','dept-web-development','webdev','dept-webdev',
 *        'web-dev','dept-web-dev','web','dept-web']
 *   expandDeptSlugAliases('dept-webdev')   // same set — input is canonicalized first
 *   expandDeptSlugAliases('unknown-dept')  → ['unknown-dept','dept-unknown-dept']
 */
export function expandDeptSlugAliases(slug: string | null | undefined): string[] {
  const canon = canonicalDeptSlug(slug);
  if (!canon) return [];

  const bare = new Set<string>([canon]);
  for (const [alias, target] of Object.entries(ALIAS_MAP)) {
    if (target === canon) bare.add(alias);
  }

  // Include the workspace auto-seed "dept-" spelling of every variant, since
  // canonicalDeptSlug strips that prefix and rows may carry it.
  const out: string[] = [];
  bare.forEach((s) => {
    out.push(s);
    out.push(`dept-${s}`);
  });
  return out;
}
