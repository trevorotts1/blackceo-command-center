/**
 * C10 — GET /api/sops?department= misses alias-keyed rows.
 *
 * api/sops/route.ts used an EXACT `AND department = ?` match, while
 * lib/sops.ts's scoreSOPForTask DOES canonicalize both sides (asymmetric).
 * A row still keyed to a LEGACY alias slug (webdev, billing, support, ...) —
 * e.g. on a box where C2's migration 091 re-key hasn't run yet, or a row
 * inserted post-migration without going through the canonicalizer — silently
 * never matched a canonical-slug query, so the library read as empty for that
 * department even though rows existed.
 *
 * These tests prove the fix: the department filter now canonicalizes BOTH the
 * query param and each row's stored department before comparing, so:
 *   - a canonical-slug query finds an alias-keyed row, and
 *   - an alias-slug query finds a canonical-keyed row,
 * while an unrelated department is still correctly excluded, keyword
 * filtering / include_deleted continue to behave exactly as before, and (C8)
 * exact test/fixture-residue departments are excluded outright.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// getDb()'s boot-time auto-seed derives fallback candidate paths from
// os.homedir() (e.g. ~/clawd/zero-human-company/<slug>/departments.json).
// Point HOME at a fresh, empty temp dir so this file's assertions never
// depend on real company data that may exist on the host running it.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-c10-alias-home-'));
process.env.HOME = TMP_HOME;
delete process.env.MASTER_FILES_DIR;
delete process.env.ZERO_HUMAN_COMPANY_DIR;
delete process.env.BLACKCEO_COMMAND_CENTER_ROOT;

// ── Isolated test DB ─────────────────────────────────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-c10-alias-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.DISABLE_QC_AUTO_SCORER = 'true';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;

type DbModule = typeof import('../../src/lib/db');
type RouteModule = typeof import('../../src/app/api/sops/route');

let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];
let GET: RouteModule['GET'];

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  closeDb = db.closeDb;
  const route = await import('../../src/app/api/sops/route');
  GET = route.GET;
  getDb(); // run migrations once
});

test.after(() => {
  try {
    closeDb();
  } catch {
    /* ignore */
  }
});

function insertSop(id: string, name: string, slug: string, department: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sops (id, name, slug, description, version, department, task_keywords, steps, success_criteria, persona_hints, created_at, updated_at)
     VALUES (?, ?, ?, '', 1, ?, '', '[{"name":"step 1"}]', '', '[]', ?, ?)`,
  ).run(id, name, slug, department, now, now);
}

async function getSops(query: string): Promise<Array<{ department: string | null; slug: string }>> {
  const { NextRequest } = await import('next/server');
  const req = new NextRequest(`http://localhost/api/sops${query}`, { method: 'GET' });
  const res = await GET(req);
  assert.equal(res.status, 200, `GET /api/sops${query} should 200`);
  return (await res.json()) as Array<{ department: string | null; slug: string }>;
}

// ── 1. Seed alias-keyed + canonical-keyed + unrelated rows ──────────────────
test('1 — seed fixture rows: one alias-keyed, one canonical-keyed, one unrelated', () => {
  insertSop('c10-alias-webdev', 'Legacy Webdev SOP', 'c10-legacy-webdev-sop', 'webdev');
  insertSop('c10-canon-webdev', 'Canonical Web-Dev SOP', 'c10-canon-webdev-sop', 'web-development');
  insertSop('c10-unrelated', 'Marketing SOP', 'c10-marketing-sop', 'marketing');
  const rows = getDb().prepare('SELECT id FROM sops WHERE id LIKE ?').all('c10-%') as { id: string }[];
  assert.equal(rows.length, 3, 'precondition: all 3 fixture rows inserted');
});

// ── 2. A CANONICAL-slug query finds the alias-keyed row (the core C10 bug) ──
test('2 — department=web-development finds the alias-keyed "webdev" row', async () => {
  const rows = await getSops('?department=web-development');
  const slugs = rows.map((r) => r.slug);
  assert.ok(slugs.includes('c10-legacy-webdev-sop'), 'canonical query must match the alias-keyed row');
  assert.ok(slugs.includes('c10-canon-webdev-sop'), 'canonical query must also match the canonical row');
  assert.ok(!slugs.includes('c10-marketing-sop'), 'an unrelated department must still be excluded');
});

// ── 3. An ALIAS-slug query finds the canonical-keyed row (symmetric) ────────
test('3 — department=webdev (the alias itself) also finds the canonical row', async () => {
  const rows = await getSops('?department=webdev');
  const slugs = rows.map((r) => r.slug);
  assert.ok(slugs.includes('c10-legacy-webdev-sop'));
  assert.ok(slugs.includes('c10-canon-webdev-sop'), 'alias query must ALSO match the canonical-keyed row');
});

// ── 4. A different alias of the SAME canonical dept also matches ────────────
test('4 — department=web-dev (a different alias of the same canonical slug) matches both', async () => {
  const rows = await getSops('?department=web-dev');
  const slugs = rows.map((r) => r.slug);
  assert.ok(slugs.includes('c10-legacy-webdev-sop'));
  assert.ok(slugs.includes('c10-canon-webdev-sop'));
});

// ── 5. An unrelated canonical department returns neither ────────────────────
test('5 — department=marketing does not return the web-development rows', async () => {
  const rows = await getSops('?department=marketing');
  const slugs = rows.map((r) => r.slug);
  assert.ok(slugs.includes('c10-marketing-sop'));
  assert.ok(!slugs.includes('c10-legacy-webdev-sop'));
  assert.ok(!slugs.includes('c10-canon-webdev-sop'));
});

// ── 6. No department param: unfiltered (regression — behavior unchanged) ────
test('6 — no department param returns all 3 fixture rows (unfiltered)', async () => {
  const rows = await getSops('');
  const slugs = rows.map((r) => r.slug);
  assert.ok(slugs.includes('c10-legacy-webdev-sop'));
  assert.ok(slugs.includes('c10-canon-webdev-sop'));
  assert.ok(slugs.includes('c10-marketing-sop'));
});

// ── 7. Keyword filter still combines correctly with the alias-aware dept filter ─
test('7 — keywords + alias department filter combine (AND, not OR)', async () => {
  const db = getDb();
  db.prepare('UPDATE sops SET task_keywords = ? WHERE id = ?').run('deploy,release', 'c10-alias-webdev');
  const rows = await getSops('?department=web-development&keywords=deploy');
  const slugs = rows.map((r) => r.slug);
  assert.ok(slugs.includes('c10-legacy-webdev-sop'), 'row with the matching keyword must be included');
  assert.ok(!slugs.includes('c10-canon-webdev-sop'), 'row without the keyword must be excluded');
});

// ── 8. C8 — test-residue departments are excluded even with include_deleted=1 ─
test('8 — a test-dept residue row is excluded even with include_deleted=1', async () => {
  insertSop('c10-c8-residue', 'Dims Test SOP (residue)', 'c10-c8-residue-sop', 'test-dept');
  const rows = await getSops('?include_deleted=1');
  const slugs = rows.map((r) => r.slug);
  assert.ok(!slugs.includes('c10-c8-residue-sop'), 'test-dept rows must never surface, even with include_deleted=1');
});

// ── 9. The "dept-" auto-seed spelling is matched too ────────────────────────
test('9 — a "dept-webdev"-keyed row is found by a canonical department=web-development query', async () => {
  insertSop('c10-deptprefix', 'Dept-prefixed Webdev SOP', 'c10-deptprefix-sop', 'dept-webdev');
  const rows = await getSops('?department=web-development');
  const slugs = rows.map((r) => r.slug);
  assert.ok(
    slugs.includes('c10-deptprefix-sop'),
    'the workspace auto-seed "dept-" spelling must be in the expanded alias set',
  );
});

// ── 10. expandDeptSlugAliases — the inverse of canonicalDeptSlug ────────────
test('10 — expandDeptSlugAliases returns every raw spelling of a department', async () => {
  const { expandDeptSlugAliases, canonicalDeptSlug } = await import(
    '../../src/lib/routing/canonical-slug'
  );

  const webAliases = expandDeptSlugAliases('web-development');
  for (const expected of ['web-development', 'webdev', 'web-dev', 'web', 'dept-webdev']) {
    assert.ok(expected && webAliases.includes(expected), `expected "${expected}" in the alias set`);
  }

  // Every returned spelling must canonicalize BACK to the same department —
  // that round-trip is what makes the SQL IN(...) exactly equivalent to the old
  // canonicalize-both-sides JS compare.
  for (const alias of webAliases) {
    assert.equal(
      canonicalDeptSlug(alias),
      'web-development',
      `"${alias}" must canonicalize back to web-development`,
    );
  }

  // An alias input yields the SAME set as its canonical form (symmetry).
  assert.deepEqual(
    [...expandDeptSlugAliases('dept-webdev')].sort(),
    [...webAliases].sort(),
    'an alias input must expand to the same set as its canonical form',
  );

  // An unknown department degrades gracefully to itself — never an empty IN-list
  // (which would match nothing) and never a wildcard (which would match all).
  assert.deepEqual(
    expandDeptSlugAliases('totally-unknown-dept').sort(),
    ['dept-totally-unknown-dept', 'totally-unknown-dept'],
  );

  assert.deepEqual(expandDeptSlugAliases(''), [], 'a blank slug expands to nothing');
});

// ── 11. A blank department param matches NOTHING (never the whole library) ──
test('11 — department= (blank) returns [] rather than the entire SOP library', async () => {
  const rows = await getSops('?department=%20');
  assert.deepEqual(rows, [], 'a whitespace-only department must not fall through to an unfiltered SELECT');
});

// ── 12. EFFICIENCY LOCK — the department filter lives in SQL, not in JS ─────
// Source-level guard (same spirit as the C8 isolation guard). The first C10 fix
// DELETED the `AND department = ?` predicate and post-filtered the result array
// in JS, so every ?department= request SELECTed the WHOLE sops table (~2.5k rows
// on a live box) and materialized every row just to discard almost all of them.
// Behavior tests alone cannot catch that regression — both forms return the same
// rows. This asserts the shape of the query itself.
test('12 — /api/sops filters department IN SQL (no whole-table scan + JS post-filter)', async () => {
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const urlMod = await import('node:url');

  const here = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
  const routePath = pathMod.resolve(here, '../../src/app/api/sops/route.ts');
  const src = fsMod.readFileSync(routePath, 'utf8');

  // The GET handler body only (POST below it is irrelevant here).
  const getBody = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'));

  assert.match(
    getBody,
    /AND LOWER\(TRIM\(COALESCE\(department[\s\S]*?IN \(/,
    'the department filter must be a SQL IN(...) predicate on the query, not a JS post-filter',
  );
  assert.ok(
    !/sops\s*=\s*sops\.filter\(/.test(getBody),
    'GET /api/sops must not re-assign `sops` from a JS .filter() — that means the whole table was SELECTed first',
  );
});
