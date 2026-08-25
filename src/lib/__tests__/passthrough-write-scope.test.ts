/**
 * passthrough-write-scope.test.ts  —  U052 anti-rot lock
 *
 * Proves the BEARER_REQUIRED_WRITE_ROUTES list in src/lib/bearer-required-routes.ts cannot
 * silently drift out of sync with the codebase.
 *
 * Derived 2026-07-27; counts re-derived 2026-07-29. Re-derive command (node):
 *   npx vitest run src/lib/__tests__/passthrough-write-scope.test.ts
 *
 * Counts baseline (measured 2026-07-27):
 *   - API routes exporting a mutating method (export async function): 106
 *     (2026-07-29: +2 since derivation -- tasks/[id]/persona-choice and
 *      tasks/[id]/resume, both POST, both added after 2026-07-27. Both are
 *      accepted residuals, NOT bearer-gated -- the browser interface calls
 *      both with no credential (TaskOverviewPanels.tsx:482 and
 *      PersonaPickerPanel.tsx:101), so gating them would 401 the operator's
 *      own resume button and persona picker. REACHABLE therefore RISES to
 *      101; it does not return to 99. See docs/SECURITY-RESIDUALS.md.)
 *   - protected by isWebhookSecretRoute:                               5
 *   - REACHABLE via forged same-origin:                              101
 *   - covered by BEARER_REQUIRED_WRITE_ROUTES (38 routes / 35 patterns): 38
 */

import { describe, it, expect } from 'vitest';
import { globSync } from 'glob';
import { readFileSync } from 'fs';
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
  const routeFiles = globSync('src/app/api/**/route.ts', { cwd: ROOT, nodir: true });
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
    allFiles.push(...globSync(`src/**/*.${ext}`, {
      cwd: ROOT,
      nodir: true,
      ignore: ['src/app/api/**'],
    }));
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
  for (const [route, methods] of routeSet) {
    results.push({ route, methods: [...methods].sort() });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 3. isWebhookSecretRoute re-implementation (independent of middleware.ts)
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET_ROUTES = [
  '/api/tasks/ingest',
  '/api/webhooks/agent-completion',
  '/api/webhooks/auto-route',
  '/api/webhooks/task-created',
];
const WEBHOOK_SECRET_DYNAMIC_ROUTES: RegExp[] = [
  /^\/api\/tasks\/[^/]+\/status$/,
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

const reachableCount = allMutatingRoutes.length - webhookProtectedCount;

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('passthrough-write-scope — anti-rot lock (U052)', () => {
  // ---- Counts ------------------------------------------------------------

  it('API routes exporting a mutating method: 108 (literal assertion)', () => {
    expect(allMutatingRoutes.length).toBe(108);
  });

  it('protected by isWebhookSecretRoute: 5', () => {
    expect(webhookProtectedCount).toBe(5);
  });

  it('REACHABLE via forged same-origin: 103', () => {
    expect(reachableCount).toBe(103);
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

  it('routes covered by BEARER_REQUIRED_WRITE_ROUTES (39 routes via 36 patterns)', () => {
    expect(bearerCoveredRoutes.size).toBe(39);
  });

  it('BEARER_REQUIRED_WRITE_ROUTES.length is 36, not 39 (checksum: 33 + 3×2 = 39)', () => {
    expect(BEARER_REQUIRED_WRITE_ROUTES.length).toBe(36);
  });

  it('route-list membership: BEARER_REQUIRED_WRITE_ROUTES includes /api/weight-profiles', () => {
    // U052: Tests the imported BEARER_REQUIRED_WRITE_ROUTES (single source of truth
    // from src/lib/bearer-required-routes.ts) directly — removing a route from the
    // shared module reddens this test. No hand-copied duplicate.
    expect(requiresBearerForWrite('/api/weight-profiles', 'POST')).toBe(true);
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
    for (const route of bearerCoveredRoutes) {
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
