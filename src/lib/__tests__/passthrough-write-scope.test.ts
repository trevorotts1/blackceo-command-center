/**
 * passthrough-write-scope.test.ts  —  U052 anti-rot lock
 *
 * Proves the BEARER_REQUIRED_WRITE_ROUTES list in src/lib/bearer-required-routes.ts cannot
 * silently drift out of sync with the codebase.
 *
 * Derived 2026-07-27; counts re-derived 2026-07-29. Re-derive command (node):
 *   npx vitest run src/lib/__tests__/passthrough-write-scope.test.ts
 *
 * Counts baseline (measured 2026-07-27; re-derived 2026-08-31 for FIX 5
 * stage-timings: 110 mutating routes, 6 webhook-protected, 104 reachable;
 * re-derived 2026-09-08 for F38 social media asset route: 114 mutating,
 * 6 webhook-protected, 108 non-webhook; re-derived 2026-09-09 for F27
 * social-theme mini app: 121 mutating, 6 webhook-protected, 115
 * non-webhook — 44 routes via 41 bearer patterns; re-derived 2026-09-09
 * for F40 measured-outcome ingest (W4 integration commit): 122 mutating,
 * 6 webhook-protected, 116 non-webhook — 45 routes via 42 bearer patterns;
 * re-derived 2026-09-14 for UPDATE-014 / Issue39 (operator pre-engine recovery,
 * POST /api/tasks/{id}/operator-preengine-recovery — an operator-only surface
 * the browser interface never calls, gated by BOTH the Bearer pattern in
 * src/lib/bearer-required-routes.ts AND middleware's webhook-secret dynamic
 * list at src/middleware.ts:166): 124 mutating, 7 webhook-protected (5 static +
 * 2 dynamic), 117 non-webhook — 44 bearer patterns match 47 route templates
 * (41 single-route + 3 collection-or-item x2; 41 + 3x2 = 47), of which the one
 * new recovery template is webhook-gated as well, leaving 46 bearer-ONLY
 * covered. Templates and bearer-only coverage are DIFFERENT numbers here; the 5
 * client-facing social-theme routes are middleware-exempt + route-level
 * CSRF/same-origin):
 *
 * re-derived 2026-09-24 for durable prior-completion declaration (PR #423 /
 * JEV-010 era): POST /api/interview/prior-completion — the owner's browser
 * declaration that the interview was already done (InterviewClient.tsx:772
 * with the session cookie + CSRF, never a bearer): 129 mutating, 7
 * webhook-protected (5 static + 2 dynamic), 122 non-webhook — bearer coverage
 * unchanged (47 patterns → 51 templates, 50 bearer-ONLY; a session route is
 * not a service-to-service route and must NOT join BEARER_REQUIRED_WRITE_ROUTES).
 *
 * re-derived 2026-09-21 for ask-at-capacity: the owner's answer to a provider
 * question (POST /api/tasks/{id}/provider-choice) and the intake's lane
 * corrections (POST /api/routing-corrections). Both are service-to-service —
 * the answer arrives from the agent that delivered the question, the
 * corrections from the intake itself — and the browser interface calls
 * neither: 128 mutating, 7 webhook-protected (5 static + 2 dynamic), 121
 * non-webhook — 47 bearer patterns match 51 route templates (43 single-route +
 * 4 collection-or-item x2; 43 + 4x2 = 51), of which the pre-engine recovery
 * template is webhook-gated as well, leaving 50 bearer-ONLY covered.
 *
 * re-derived 2026-09-14 for WS-C Skill 69 archify (POST /api/archify-runs +
 * PATCH /api/archify-runs/{id} — service-to-service; the browser interface never
 * calls them): 126 mutating, 7 webhook-protected (5 static + 2 dynamic), 119
 * non-webhook — 45 bearer patterns match 49 route templates (41 single-route +
 * 4 collection-or-item x2; 41 + 4x2 = 49), of which the pre-engine recovery
 * template is webhook-gated as well, leaving 48 bearer-ONLY covered. This lock
 * was GREEN on the pre-feature base (124 / 7 / 117 — 44 patterns → 47 templates,
 * 46 bearer-ONLY); the two new route files are what required the re-derivation.
 * The bullet list below is the earlier running narrative, kept for history.
 *   - API routes exporting a mutating method (export async function): 107
 *     (2026-08-31: +1 for FIX 35 — tasks/[id]/audit-backfill, POST, bearer-
 *      gated in BEARER_REQUIRED_WRITE_ROUTES; hygiene-job-only, never called
 *      by the browser interface.)
 *     (2026-07-29: +2 since derivation -- tasks/[id]/persona-choice and
 *      tasks/[id]/resume, both POST, both added after 2026-07-27. Both are
 *      accepted residuals, NOT bearer-gated -- the browser interface calls
 *      both with no credential (TaskOverviewPanels.tsx:482 and
 *      PersonaPickerPanel.tsx:101), so gating them would 401 the operator's
 *      own resume button and persona picker. REACHABLE therefore RISES to
 *      101; it does not return to 99. See docs/SECURITY-RESIDUALS.md.)
 *   - protected by isWebhookSecretRoute:                               5
 *   - REACHABLE via forged same-origin:                              101
 *   - covered by BEARER_REQUIRED_WRITE_ROUTES (40 routes / 37 patterns): 40
 *     (2026-09-08: +1 pattern for F38 — POST /api/social/media/{id} asset-
 *      register ingest is bearer-gated. Now 42 routes via 39 patterns:
 *      36 single + 3 collection-or-item x2. Checksum 36 + (3 x 2) = 42.)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, relative } from 'path';
import { BEARER_REQUIRED_WRITE_ROUTES, requiresBearerForWrite } from '../bearer-required-routes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, '../../..');

/** Normalise a Next.js filesystem path to an API-path template.
 *  src/app/api/tasks/[id]/route.ts  ->  /api/tasks/{id}
 */
function pathToRouteTemplate(filePath: string): string {
  let p = relative(resolve(ROOT, 'src/app/api'), filePath);
  // drop trailing /route.ts or /route.tsx
  p = p.replace(/\/route\.(ts|tsx)$/, '');
  // normalise Next.js [param] and [...catchAll] to placeholder {id}
  p = p.replace(/\[([^\]]+)\]/g, '{id}');
  // prepend /api/
  return '/api/' + p;
}

// ---------------------------------------------------------------------------
// 1. SCAN: every route.ts under src/app/api/ for exported mutating handlers
// ---------------------------------------------------------------------------

interface MutatingRoute {
  path: string;    // e.g. "/api/tasks/{id}/activities"
  methods: string[];
}

function scanApiRoutes(): MutatingRoute[] {
  const routeFiles = readdirSync(resolve(ROOT, 'src/app/api'), { recursive: true, encoding: 'utf8' })
    .filter((file) => file === 'route.ts' || file.endsWith('/route.ts'))
    .map((file) => `src/app/api/${file}`);
  const results: MutatingRoute[] = [];

  for (const relPath of routeFiles) {
    const absPath = resolve(ROOT, relPath);
    const src = readFileSync(absPath, 'utf-8');
    const methods: string[] = [];

    // Match: export async function POST / PATCH / PUT / DELETE
    // Also catch: export function POST / PATCH / PUT / DELETE (without async)
    const exportFnRe = /export\s+(async\s+)?function\s+(POST|PATCH|PUT|DELETE)\b/g;
    let m: RegExpExecArray | null;
    while ((m = exportFnRe.exec(src)) !== null) {
      methods.push(m[2]);
    }

    if (methods.length > 0) {
      results.push({ path: pathToRouteTemplate(absPath), methods });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 2. SCAN: multi-line browser-side mutating fetch() calls in src/
//           excluding src/app/api/
//
// The scanner examines lines containing method: 'POST'|'PATCH'|'PUT'|'DELETE'
// and searches nearby lines for /api/ URL templates. This catches both inline
// fetches and multi-line fetch objects.
// ---------------------------------------------------------------------------

interface InterfaceCall {
  route: string;
  methods: string[];
}

function scanInterfaceMutatingFetches(): InterfaceCall[] {
  const allowedExts = ['ts', 'tsx'];
  const allFiles: string[] = [];
  for (const ext of allowedExts) {
    allFiles.push(...readdirSync(resolve(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith(`.${ext}`) && !file.startsWith('app/api/'))
      .map((file) => `src/${file}`));
  }

  const routeSet = new Map<string, Set<string>>();

  const methodLineRe = /method\s*:\s*['"](POST|PATCH|PUT|DELETE)['"]/;
  // Match URL template strings near method lines
  const urlRe = /['"`](\/api\/[^'"`]*?)['"`]/g;

  for (const relPath of allFiles) {
    const absPath = resolve(ROOT, relPath);
    let src: string;
    try {
      src = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = src.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const methodMatch = methodLineRe.exec(lines[i]);
      if (!methodMatch) continue;

      const method = methodMatch[1];

      // Search nearby lines (window: i-5 to i+5) for /api/ URL templates
      for (let j = Math.max(0, i - 5); j < Math.min(lines.length, i + 6); j++) {
        let urlM: RegExpExecArray | null;
        urlRe.lastIndex = 0;
        while ((urlM = urlRe.exec(lines[j])) !== null) {
          let url = urlM[1];

          // Skip obvious non-route identifiers and test fixtures
          if (!url.startsWith('/api/')) continue;

          // Normalise template literals: ${var} -> {id}
          url = url.replace(/\$\{[^}]+\}/g, '{id}');

          // Strip trailing query strings: ?source_id=... etc
          const qIdx = url.indexOf('?');
          if (qIdx !== -1) url = url.substring(0, qIdx);

          // Deduplicate within this file
          if (!routeSet.has(url)) {
            routeSet.set(url, new Set());
          }
          routeSet.get(url)!.add(method);
        }
      }
    }
  }

  const results: InterfaceCall[] = [];
  for (const [route, methods] of Array.from(routeSet.entries())) {
    results.push({ route, methods: Array.from(methods).sort() });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 3. isWebhookSecretRoute re-implementation (independent of middleware.ts)
// ---------------------------------------------------------------------------

// MIRROR — the two arrays below re-implement src/middleware.ts's
// WEBHOOK_SECRET_ROUTES + WEBHOOK_SECRET_DYNAMIC_ROUTES by hand (this lock
// deliberately does NOT import the middleware module). A route added to the
// middleware lists therefore MUST be added here in the same change, or the
// census below silently classifies it as non-webhook and asserts a stale
// picture. See src/middleware.ts:164-167 for the live lists.
const WEBHOOK_SECRET_ROUTES = [
  '/api/tasks/ingest',
  '/api/webhooks/agent-completion',
  '/api/webhooks/auto-route',
  '/api/webhooks/task-created',
  // FIX 5 (presentation rev2 phase A): stage-timings ingest joined the
  // fail-closed webhook family in src/middleware.ts — keep this independent
  // re-implementation in lockstep (U052 reddens on any drift).
  '/api/presentations/stage-timings',
];
const WEBHOOK_SECRET_DYNAMIC_ROUTES: RegExp[] = [
  /^\/api\/tasks\/[^/]+\/status$/,
  // UPDATE-014 / Issue39: the operator pre-engine recovery route joined
  // middleware's WEBHOOK_SECRET_DYNAMIC_ROUTES (src/middleware.ts:166), so it is
  // webhook-gated AS WELL AS bearer-gated. It must not be counted below as a
  // bearer-ONLY-covered route.
  /^\/api\/tasks\/[^/]+\/operator-preengine-recovery$/,
];

function matchesRoute(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

function isWebhookSecretRouteTest(pathname: string): boolean {
  return (
    WEBHOOK_SECRET_ROUTES.some((r) => matchesRoute(pathname, r)) ||
    WEBHOOK_SECRET_DYNAMIC_ROUTES.some((r) => r.test(pathname))
  );
}

// ---------------------------------------------------------------------------
// Pre-loaded data (computed once at module scope)
// ---------------------------------------------------------------------------

const allMutatingRoutes = scanApiRoutes();
const interfaceCalls = scanInterfaceMutatingFetches();
const interfaceRouteSet = new Set(interfaceCalls.map((c) => c.route));

// Build a set of concrete route paths covered by BEARER_REQUIRED_WRITE_ROUTES (imported from the shared module)
const bearerCoveredRoutes = new Set<string>();
for (const route of allMutatingRoutes) {
  if (requiresBearerForWrite(route.path, 'POST') && !isWebhookSecretRouteTest(route.path)) {
    bearerCoveredRoutes.add(route.path);
  }
}

const webhookProtectedCount = allMutatingRoutes.filter((r) =>
  isWebhookSecretRouteTest(r.path)
).length;

const nonWebhookCount = allMutatingRoutes.length - webhookProtectedCount;

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('passthrough-write-scope — anti-rot lock (U052)', () => {
  // ---- Counts ------------------------------------------------------------

  it('API routes exporting a mutating method: 129 (literal assertion)', () => {
    expect(allMutatingRoutes.length).toBe(129);
  });

  it('protected by isWebhookSecretRoute: 7 (5 static + 2 dynamic — middleware src/middleware.ts:137-167)', () => {
    expect(webhookProtectedCount).toBe(7);
  });

  it('non-webhook write routes: 122 (129 mutating − 7 webhook-protected; tenant authentication remains required)', () => {
    expect(nonWebhookCount).toBe(122);
  });

  it('interface call templates found by multi-line scanner', () => {
    // The multi-line scanner picks up URL templates near method: keys.
    // Exact count depends on scanning methodology — the card's Python scanner
    // got 62 distinct templates. Our regex-based multi-line approach gets
    // close but may differ on variable-based URLs.
    // We assert a floor here; the anti-rot property comes from the
    // classification check (test below), not the raw count.
    const count = interfaceCalls.length;
    // Log for visibility — this number should stay roughly stable
    console.log(`\nInterface mutating fetch templates found: ${count}`);
    console.log('Routes:', interfaceCalls.map(c => c.route).sort().join(', '));
    expect(count).toBeGreaterThanOrEqual(40);
  });

  it('bearer-ONLY-covered routes: 50 (47 patterns match 51 templates; 1 of them — UPDATE-014 /api/tasks/{id}/operator-preengine-recovery — is webhook-gated, so 51 − 1 = 50)', () => {
    expect(bearerCoveredRoutes.size).toBe(50);
  });

  it('BEARER_REQUIRED_WRITE_ROUTES.length is 47, matching 51 route templates (checksum: 43 + 4×2 = 51; ask-at-capacity added /api/routing-corrections and /api/tasks/{id}/provider-choice, both single-route service-to-service surfaces)', () => {
    expect(BEARER_REQUIRED_WRITE_ROUTES.length).toBe(47);
  });

  it('route-list membership: BEARER_REQUIRED_WRITE_ROUTES includes /api/weight-profiles', () => {
    // U052: Tests the imported BEARER_REQUIRED_WRITE_ROUTES (single source of truth
    // from src/lib/bearer-required-routes.ts) directly — removing a route from the
    // shared module reddens this test. No hand-copied duplicate.
    expect(requiresBearerForWrite('/api/weight-profiles', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/auth/interview-invitation', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/bugs', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/execution-queue/abc', 'DELETE')).toBe(true);
  });

  // ---- Derivation test: every reachable route is classified ---------------

  it('every reachable mutating route is either in BEARER_REQUIRED_WRITE_ROUTES or called by the interface', () => {
    const unclassified: string[] = [];
    const routeByPattern = new Set<string>(); // routes covered by bearer patterns

    for (const route of allMutatingRoutes) {
      if (requiresBearerForWrite(route.path, 'POST')) {
        routeByPattern.add(route.path);
      }
    }

    for (const route of allMutatingRoutes) {
      const p = route.path;
      if (isWebhookSecretRouteTest(p)) continue; // excluded, already gated
      if (requiresBearerForWrite(p, 'POST')) continue;      // closed by this unit
      if (interfaceRouteSet.has(p)) continue;      // interface needs it — kept open
      unclassified.push(p);
    }

    // The anti-rot assertion: if a NEW route is added without classification,
    // it appears here and the test fails.
    expect(unclassified).toEqual([]);
  });

  // ---- No-overlap test (full check against all patterns across all files) ---

  it('no route matched by BEARER_REQUIRED_WRITE_ROUTES appears in the interface call set', () => {
    const overlap: string[] = [];
    // Check concrete route intersection
    for (const route of Array.from(bearerCoveredRoutes)) {
      if (interfaceRouteSet.has(route)) {
        overlap.push(route);
      }
    }
    // Also check: do any interface-called routes match a bearer pattern?
    // (This catches routes not in the API tree but called from the interface)
    for (const iface of interfaceCalls) {
      if (requiresBearerForWrite(iface.route, 'POST') && !bearerCoveredRoutes.has(iface.route)) {
        overlap.push(`${iface.route} (matched by pattern but not in API route tree — may be a false alarm)`);
      }
    }
    expect(overlap).toEqual([]);
  });

  // ---- Read methods unaffected -------------------------------------------

  it('requiresBearerForWrite returns false for GET/HEAD/OPTIONS on listed routes', () => {
    expect(requiresBearerForWrite('/api/bugs', 'GET')).toBe(false);
    expect(requiresBearerForWrite('/api/weight-profiles', 'GET')).toBe(false);
    expect(requiresBearerForWrite('/api/ad-campaigns', 'HEAD')).toBe(false);
    expect(requiresBearerForWrite('/api/workspaces/abc', 'OPTIONS')).toBe(false);
  });

  it('requiresBearerForWrite returns true for mutating methods on listed routes', () => {
    expect(requiresBearerForWrite('/api/bugs', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/weight-profiles', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/auth/interview-invitation', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/ad-campaigns/123', 'PATCH')).toBe(true);
    expect(requiresBearerForWrite('/api/workspaces/abc', 'DELETE')).toBe(true);
    expect(requiresBearerForWrite('/api/sops/abc', 'PUT')).toBe(true);
  });

  // ---- Boundary cases ----------------------------------------------------

  it('/api/sops/proposals/abc → false (interface calls it)', () => {
    expect(requiresBearerForWrite('/api/sops/proposals/abc', 'POST')).toBe(false);
    expect(requiresBearerForWrite('/api/sops/proposals/abc', 'POST')).toBe(false);
  });

  it('/api/sops/abc → true (on the closable list)', () => {
    expect(requiresBearerForWrite('/api/sops/abc', 'PATCH')).toBe(true);
    expect(requiresBearerForWrite('/api/sops/abc', 'POST')).toBe(true);
  });

  it('/api/tasks/abc → false (interface calls it — PATCH/DELETE)', () => {
    expect(requiresBearerForWrite('/api/tasks/abc', 'PATCH')).toBe(false);
    expect(requiresBearerForWrite('/api/tasks/abc', 'POST')).toBe(false);
  });

  it('/api/tasks/abc/activities → true (on the closable list)', () => {
    expect(requiresBearerForWrite('/api/tasks/abc/activities', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/tasks/abc/activities', 'POST')).toBe(true);
  });

  it('/api/internal/auth-rejected → false (internal 401 sink, unreachable via middleware)', () => {
    expect(requiresBearerForWrite('/api/internal/auth-rejected', 'POST')).toBe(false);
    expect(requiresBearerForWrite('/api/internal/auth-rejected', 'POST')).toBe(false);
  });

  // ---- Collection-or-item patterns cover both forms ----------------------

  it('collection-or-item patterns cover collection and item forms', () => {
    expect(requiresBearerForWrite('/api/ad-campaigns', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/ad-campaigns/abc', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/bugs', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/bugs/abc', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/execution-queue', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/execution-queue/abc', 'POST')).toBe(true);
  });

  // ---- sops negative lookahead: feedback/proposals are excluded ---------

  it('/api/sops/feedback → false (excluded by negative lookahead)', () => {
    expect(requiresBearerForWrite('/api/sops/feedback', 'POST')).toBe(false);
    expect(requiresBearerForWrite('/api/sops/feedback', 'POST')).toBe(false);
  });

  it('/api/sops/proposals → false (excluded by negative lookahead)', () => {
    expect(requiresBearerForWrite('/api/sops/proposals', 'POST')).toBe(false);
    expect(requiresBearerForWrite('/api/sops/proposals', 'POST')).toBe(false);
  });

  // ---- sops import-role-library is covered -------------------------------

  it('/api/sops/import-role-library → true (covered)', () => {
    expect(requiresBearerForWrite('/api/sops/import-role-library', 'POST')).toBe(true);
    expect(requiresBearerForWrite('/api/sops/import-role-library', 'POST')).toBe(true);
  });
});
