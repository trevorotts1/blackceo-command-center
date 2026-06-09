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

  // app-dev variants
  'appdev':            'app-development',
  'app-dev':           'app-development',
  'mobile':            'app-development',

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
 *  5. Otherwise return the normalized-but-unknown slug (lowercase, no "dept-")
 *     so callers never crash — they just get a gracefully-degraded value.
 *
 * @example
 *   canonicalDeptSlug('dept-webdev')      → 'web-development'
 *   canonicalDeptSlug('ceo-com')          → 'master-orchestrator'
 *   canonicalDeptSlug('billing')          → 'billing-finance'
 *   canonicalDeptSlug('marketing')        → 'marketing'
 *   canonicalDeptSlug('DEPT-MARKETING')   → 'marketing'
 *   canonicalDeptSlug('dept-ceo')         → 'master-orchestrator'
 *   canonicalDeptSlug('video-production') → 'video'
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

  // Step 5: return normalized-but-unknown slug (graceful fallback)
  return s;
}

/**
 * Return true if `slug` (after canonicalization) is the master-orchestrator
 * / CEO department.
 */
export function isMasterOrchestratorSlug(slug: string | null | undefined): boolean {
  return canonicalDeptSlug(slug) === 'master-orchestrator';
}
