/**
 * Skill-6 U54 (spec crosswalk HL/U69) — stage 1 "Inventory freeze" tests.
 *
 * THE INVARIANT THIS EXISTS TO PROVE
 * -----------------------------------
 * The whole-app responsive audit is only whole-app if new pages can never
 * silently escape it. That means the route list must be computed
 * MECHANICALLY from `src/app/**\/page.tsx` at run time — never a hardcoded
 * number or list. This suite proves:
 *
 *   1. `discoverPageRoutes()`'s count agrees with an INDEPENDENT filesystem
 *      walk (a plain recursive `fs` scan written separately from the
 *      module under test, so a bug shared by both would have to be
 *      coincidental, not structural).
 *   2. Known, currently-real routes are present verbatim.
 *   3. `api/` route handlers are correctly excluded (they are not UI pages).
 *   4. Dynamic-segment fixture resolution:
 *        - a route with no dynamic segment resolves to itself,
 *        - a route with a registered STATIC fixture resolves without a DB,
 *        - a route with a registered DB-backed fixture resolves against a
 *          real (temp, throwaway) SQLite row when one exists,
 *        - the SAME DB-backed route reports `unresolved` honestly (never a
 *          fake value) when no DB is reachable and no static fallback
 *          exists,
 *        - the optional catch-all route resolves to its base path.
 *   5. Adding a brand-new page.tsx under a temp fixture app dir changes the
 *      discovered count by exactly one — proving new pages cannot silently
 *      escape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  discoverPageRoutes,
  resolveRouteFixture,
  buildRouteInventory,
  REPO_ROOT,
} from '../../scripts/responsive-route-inventory.mjs';

// --- 1. Independent count cross-check -------------------------------------

function independentPageTsxCount(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'api') continue; // mirrors the module's own exclusion, verified separately in test 3
      count += independentPageTsxCount(full);
    } else if (entry.name === 'page.tsx') {
      count += 1;
    }
  }
  return count;
}

test('U54/inventory: discoverPageRoutes() count matches an independent fs walk', () => {
  const appDir = path.join(REPO_ROOT, 'src', 'app');
  const mechanical = discoverPageRoutes({ appDir });
  const independent = independentPageTsxCount(appDir);
  assert.equal(mechanical.length, independent);
  assert.ok(mechanical.length > 0, 'expected at least one page route in src/app');
});

test('U54/inventory: known static routes are present verbatim', () => {
  const patterns = discoverPageRoutes().map((r) => r.pattern);
  for (const known of ['/', '/kanban', '/personas', '/tasks/all', '/tasks/by-department', '/settings', '/settings/intelligence']) {
    assert.ok(patterns.includes(known), `expected ${known} in the mechanical inventory`);
  }
});

test('U54/inventory: api/ route handlers are excluded (not UI pages)', () => {
  const patterns = discoverPageRoutes().map((r) => r.pattern);
  assert.ok(
    patterns.every((p) => !p.startsWith('/api/') && p !== '/api'),
    'no /api/* pattern should appear in a UI-route inventory'
  );
});

test('U54/inventory: a newly added page.tsx changes the count by exactly one', () => {
  const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u54-app-'));
  fs.mkdirSync(path.join(tmpAppDir, 'existing'), { recursive: true });
  fs.writeFileSync(path.join(tmpAppDir, 'existing', 'page.tsx'), 'export default function P() { return null; }');
  const before = discoverPageRoutes({ appDir: tmpAppDir });
  assert.equal(before.length, 1);

  fs.mkdirSync(path.join(tmpAppDir, 'brand-new'), { recursive: true });
  fs.writeFileSync(path.join(tmpAppDir, 'brand-new', 'page.tsx'), 'export default function P() { return null; }');
  const after = discoverPageRoutes({ appDir: tmpAppDir });
  assert.equal(after.length, 2, 'a newly added page must never silently escape the mechanical inventory');
  assert.ok(after.some((r) => r.pattern === '/brand-new'));

  fs.rmSync(tmpAppDir, { recursive: true, force: true });
});

test('U54/inventory: route groups (parens) are stripped from the URL pattern', () => {
  const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u54-app-group-'));
  fs.mkdirSync(path.join(tmpAppDir, '(marketing)', 'promo'), { recursive: true });
  fs.writeFileSync(path.join(tmpAppDir, '(marketing)', 'promo', 'page.tsx'), 'export default function P() { return null; }');
  const routes = discoverPageRoutes({ appDir: tmpAppDir });
  assert.deepEqual(
    routes.map((r) => r.pattern),
    ['/promo']
  );
  fs.rmSync(tmpAppDir, { recursive: true, force: true });
});

// --- Fixture resolution -----------------------------------------------------

test('U54/fixtures: a static route (no dynamic segment) resolves to itself', () => {
  const result = resolveRouteFixture('/kanban', { dbPaths: [] });
  assert.deepEqual(result, { pattern: '/kanban', href: '/kanban', unresolved: false, reason: null });
});

test('U54/fixtures: a registered STATIC fixture resolves without any DB', () => {
  const result = resolveRouteFixture('/ceo-board/[dept]', { dbPaths: [] });
  assert.equal(result.unresolved, false);
  assert.equal(result.href, '/ceo-board/marketing');
});

test('U54/fixtures: optional catch-all resolves to its base path', () => {
  const result = resolveRouteFixture('/participant/[[...token]]', { dbPaths: [] });
  assert.equal(result.unresolved, false);
  assert.equal(result.href, '/participant');
});

test('U54/fixtures: a DB-backed route resolves against a real seeded row when one exists', () => {
  const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'u54-db-')), 'seeded.db');
  const db = new Database(tmpDb);
  db.exec('CREATE TABLE campaigns (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO campaigns (id, name) VALUES (?, ?)').run('camp-real-123', 'Real Seeded Campaign');
  db.close();

  const result = resolveRouteFixture('/campaigns/[id]', { dbPaths: [tmpDb] });
  assert.equal(result.unresolved, false);
  assert.equal(result.href, '/campaigns/camp-real-123');
  assert.equal(result.source, tmpDb);
});

test('U54/fixtures: a DB-backed route with no table and no static fallback is honestly UNRESOLVED (never faked)', () => {
  const result = resolveRouteFixture('/campaigns/[id]', { dbPaths: [] });
  assert.equal(result.unresolved, true);
  assert.equal(result.href, null);
  assert.match(result.reason as string, /no live "campaigns" row found/);
});

test('U54/fixtures: an unregistered dynamic route is honestly UNRESOLVED', () => {
  const result = resolveRouteFixture('/totally/[unknown]/route', { dbPaths: [] });
  assert.equal(result.unresolved, true);
  assert.match(result.reason as string, /no fixture rule registered/);
});

test('U54/fixtures: workspace slug falls back to the deterministic "default" seed workspace when DB is unreachable', () => {
  const result = resolveRouteFixture('/workspace/[slug]', { dbPaths: [] });
  assert.equal(result.unresolved, false);
  assert.equal(result.href, '/workspace/default');
  assert.equal(result.fallback, true);
});

test('U54/inventory: buildRouteInventory() covers every discovered route, each carrying a resolution verdict', () => {
  const inventory = buildRouteInventory();
  const discovered = discoverPageRoutes();
  assert.equal(inventory.length, discovered.length);
  for (const entry of inventory) {
    assert.ok('unresolved' in entry);
    assert.ok('href' in entry);
  }
});
