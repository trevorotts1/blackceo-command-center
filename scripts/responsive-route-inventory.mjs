// scripts/responsive-route-inventory.mjs
//
// Skill-6 U54 (spec crosswalk HL/U69) — stage 1 of the whole-app responsive
// audit PROGRAM: "Inventory freeze."
//
// Mechanically enumerates every Next.js App Router page route from
// `src/app/**/page.tsx` AT RUN TIME — never a hardcoded list — so a newly
// added page can never silently escape the audit (the exact hole this unit
// exists to close: the harness's old default list covered 7 of 38+ routes).
// Then resolves each route's dynamic segments ([slug], [dept], [id], ...)
// to ONE pinned, representative fixture value, per the spec's "pin one
// representative fixture per dynamic segment ... from seeded data on the
// audit box."
//
// Fixture resolution order per dynamic segment:
//   1. A route with no dynamic segment needs nothing — it resolves to
//      itself immediately.
//   2. STATIC fixtures (ROUTE_FIXTURES below) that never need a DB row
//      (e.g. a department slug, a redirect-only nudge-link slug) resolve
//      immediately.
//   3. DB-backed fixtures query the seeded SQLite DB for one real row
//      (`SELECT <column> FROM <table> ... LIMIT 1`) when a DB file is
//      reachable and `better-sqlite3` resolves. Producing a REAL row here
//      requires an actual seeded box — that live step is the operator-box
//      leg; this module is the mechanism, and degrades honestly (see 4)
//      when run before that leg has happened.
//   4. If neither resolves, the segment is left UNRESOLVED and the route is
//      flagged `unresolved: true` with a `reason` — never silently
//      substituted with a value that could be mistaken for a real audited
//      cell. Callers (responsive-audit.mjs) must skip unresolved routes
//      rather than hit a guaranteed 404 and record it as a layout defect.
//
// Read-only. No network calls. No DB mutation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Route-pattern -> fixture resolver, keyed by the FULL route pattern (never
 * by param name alone) because the same param name (`[id]`) names a
 * different entity on different routes (campaign vs sop vs notebook vs
 * research search vs web-agent session).
 */
export const ROUTE_FIXTURES = {
  '/agents/[agentId]': { table: 'agents', column: 'id' },
  '/campaigns/[id]': { table: 'campaigns', column: 'id' },
  '/ceo-board/[dept]': { static: 'marketing' },
  '/ceo-board/[dept]/focus': { static: 'marketing' },
  // Nudge-link redirect: the page redirects to /interview regardless of the
  // slug's real validity, so any placeholder is a legitimate fixture.
  '/onboarding/resume/[slug]': { static: 'resume-check' },
  '/operator/notebook/[id]': { table: 'notebooks', column: 'id' },
  '/operator/research/[id]': { table: 'research_searches', column: 'id' },
  '/operator/web-agent/session/[id]': { table: 'web_agent_sessions', column: 'id' },
  '/sops/[id]': { table: 'sops', column: 'id' },
  '/workspace/[slug]': { table: 'workspaces', column: 'slug', static: 'default' },
  // Optional catch-all: Next.js treats the base path (segment omitted) as a
  // legal match, so the route stands on its own with zero DB dependency.
  '/participant/[[...token]]': { optionalCatchAll: true },
};

const PAGE_FILE = 'page.tsx';

function toRoutePattern(appDir, fileDir) {
  const rel = path.relative(appDir, fileDir).split(path.sep).join('/');
  if (rel === '.' || rel === '') return '/';
  // Strip Next.js route-group segments, e.g. (marketing) — they are never
  // part of the URL.
  const segments = rel.split('/').filter((s) => !(s.startsWith('(') && s.endsWith(')')));
  return '/' + segments.join('/');
}

/**
 * Walk src/app recursively and mechanically collect every page.tsx route.
 * Pure fs, no caching, no hardcoded list.
 */
export function discoverPageRoutes({ appDir = path.join(REPO_ROOT, 'src', 'app') } = {}) {
  const routes = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // api/ holds route HANDLERS, never UI pages — out of scope for a
        // responsive-layout audit even if it ever contained a page.tsx.
        if (entry.name === 'api') continue;
        walk(full);
      } else if (entry.isFile() && entry.name === PAGE_FILE) {
        routes.push({ pattern: toRoutePattern(appDir, dir), file: path.relative(REPO_ROOT, full) });
      }
    }
  }
  walk(appDir);
  routes.sort((a, b) => a.pattern.localeCompare(b.pattern));
  return routes;
}

function isDynamicSegment(seg) {
  return seg.startsWith('[') && seg.endsWith(']');
}

/**
 * Best-effort read-only DB lookup for one fixture row. Returns the column
 * value as a string, or null if the DB file / driver / table / row isn't
 * reachable. Callers MUST treat null as "could not resolve" — never coerce
 * it into a fake value.
 */
export function queryFixtureFromDb({ table, column, dbPath }) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  let Database;
  try {
    // Lazy + optional: route discovery (stage 1) must work with zero deps
    // installed (pure fs enumeration) even when better-sqlite3 was never
    // built. Only fixture resolution needs it.
    Database = require('better-sqlite3');
  } catch {
    return null;
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`SELECT "${column}" AS v FROM "${table}" ORDER BY rowid LIMIT 1`).get();
    return row && row.v != null ? String(row.v) : null;
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

/** Default seeded-DB search locations (mirrors qc-cc.sh + package.json db:* conventions). */
export function defaultDbPaths() {
  return [
    process.env.RESPONSIVE_AUDIT_DB_PATH,
    path.join(REPO_ROOT, 'mission-control.db'),
    path.join(path.dirname(REPO_ROOT), 'data', 'mission-control.db'),
  ].filter(Boolean);
}

/**
 * Resolve one route pattern (with its dynamic segments) to a concrete,
 * requestable href. Never guesses: a segment with no fixture rule and no
 * live DB row comes back unresolved rather than a plausible-looking fake.
 */
export function resolveRouteFixture(pattern, { dbPaths = defaultDbPaths(), fixtures = ROUTE_FIXTURES } = {}) {
  const segments = pattern.split('/').filter(Boolean);
  const hasDynamic = segments.some(isDynamicSegment);
  if (!hasDynamic) return { pattern, href: pattern, unresolved: false, reason: null };

  const rule = fixtures[pattern];
  if (!rule) {
    return { pattern, href: null, unresolved: true, reason: 'no fixture rule registered for this dynamic route' };
  }
  if (rule.optionalCatchAll) {
    const href = '/' + segments.slice(0, -1).join('/');
    return { pattern, href: href === '/' ? '/' : href || '/', unresolved: false, reason: null };
  }
  if (rule.table) {
    for (const dbPath of dbPaths) {
      const value = queryFixtureFromDb({ table: rule.table, column: rule.column, dbPath });
      if (value) {
        const href = '/' + segments.map((s) => (isDynamicSegment(s) ? value : s)).join('/');
        return { pattern, href, unresolved: false, reason: null, source: dbPath };
      }
    }
    if (rule.static) {
      const href = '/' + segments.map((s) => (isDynamicSegment(s) ? rule.static : s)).join('/');
      return {
        pattern,
        href,
        unresolved: false,
        reason: 'no live DB row found — used the static fallback, not a real seeded row',
        fallback: true,
      };
    }
    return { pattern, href: null, unresolved: true, reason: `no live "${rule.table}" row found and no static fallback registered` };
  }
  // static-only rule (no DB table at all)
  const href = '/' + segments.map((s) => (isDynamicSegment(s) ? rule.static : s)).join('/');
  return { pattern, href, unresolved: false, reason: null };
}

/** Full stage-1 output: every route, resolved. */
export function buildRouteInventory(opts = {}) {
  const routes = discoverPageRoutes(opts);
  return routes.map((r) => ({ ...r, ...resolveRouteFixture(r.pattern, opts) }));
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const inventory = buildRouteInventory();
  console.log(JSON.stringify(inventory, null, 2));
  const unresolved = inventory.filter((r) => r.unresolved);
  if (unresolved.length) {
    console.error(`\n${unresolved.length}/${inventory.length} route(s) have no resolvable fixture (see "reason" per entry above).`);
  }
}
