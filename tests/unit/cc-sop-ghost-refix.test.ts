/**
 * C2 — CC SOP-library "ghost" refix.
 *
 * The live DB had 54 stale/test SOP rows: legacy-alias-keyed starter rows
 * (webdev/support/comms/billing/appdev/openclaw/social/paid-ads), deprecated-
 * department rows (ceo/security/hr-people/finance-accounting/operations/
 * data-analytics/executive-assistant), and ~30 `test-dept` residue rows that
 * leaked from test harnesses writing to the live DB. A canonical-slug SOP query
 * matched none of them, so the library read as a ghost.
 *
 * These tests prove the two-part fix:
 *   1. sops-seed.ts now seeds ONLY canonical-slug starter SOPs, with the 7
 *      deprecated departments dropped.
 *   2. migration 091 / rekeyAndPurgeGhostSops() re-keys legacy rows to canonical
 *      slugs PRESERVING their sop ids, soft-deletes the deprecated rows, and
 *      purges the test-dept residue.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated test DB ─────────────────────────────────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-c2-sop-ghost-')),
  'mission-control.test.db',
);
// Must be set before any import of @/lib/db so DB_PATH captures it.
process.env.DATABASE_PATH = TMP_DB;
process.env.DISABLE_QC_AUTO_SCORER = 'true';
// Point OpenClaw root at nowhere so no real departments.json / role library is
// auto-seeded into the test DB — the sops table holds exactly the starter set.
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-c2-sop-ghost';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;

// ── Static source-of-truth imports (no DB needed) ────────────────────────────
import { STARTER_SOPS } from '../../src/lib/sops-seed';
import { CANONICAL_SLUGS, canonicalDeptSlug } from '../../src/lib/routing/canonical-slug';

const DEPRECATED = [
  'ceo',
  'security',
  'hr-people',
  'finance-accounting',
  'operations',
  'data-analytics',
  'executive-assistant',
];
const LEGACY_ALIASES = ['webdev', 'support', 'comms', 'billing', 'appdev', 'openclaw', 'social', 'paid-ads'];

// ── DB-backed module handles (loaded in test.before) ─────────────────────────
type DbModule = typeof import('../../src/lib/db');
type MigrationsModule = typeof import('../../src/lib/db/migrations');
let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];
let rekeyAndPurgeGhostSops: MigrationsModule['rekeyAndPurgeGhostSops'];

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  closeDb = db.closeDb;
  const migrations = await import('../../src/lib/db/migrations');
  rekeyAndPurgeGhostSops = migrations.rekeyAndPurgeGhostSops;
  // Trigger the full migration + auto-seed chain (incl. migration 091, no-op on
  // an empty sops table, then autoSeedStarterSOPs → 16 canonical starter rows).
  getDb();
});

test.after(() => {
  try {
    closeDb();
  } catch {
    /* ignore */
  }
});

// Insert a raw SOP row bypassing the seeder, to simulate pre-C2 live residue.
function insertGhost(slug: string, name: string, department: string) {
  const db = getDb();
  const id = `ghost-${slug}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sops (id, name, slug, description, version, department, task_keywords, steps, success_criteria, persona_hints, created_at, updated_at)
     VALUES (?, ?, ?, '', 1, ?, '', '[]', '', '[]', ?, ?)`,
  ).run(id, name, slug, department, now, now);
  return id;
}

// ── 1. Seed source of truth: canonical, deprecated dropped ───────────────────
test('1 — STARTER_SOPS holds exactly the 16 canonical starter SOPs', () => {
  assert.equal(STARTER_SOPS.length, 16, 'deprecated departments must be dropped, leaving 16');
});

test('2 — every starter SOP is keyed to a CANONICAL department slug', () => {
  for (const sop of STARTER_SOPS) {
    assert.ok(
      CANONICAL_SLUGS.has(sop.department),
      `starter SOP ${sop.slug} keyed to non-canonical department "${sop.department}"`,
    );
    // Idempotent under canonicalization — proves it is already the canonical form.
    assert.equal(
      canonicalDeptSlug(sop.department),
      sop.department,
      `starter SOP ${sop.slug} department must be canonical`,
    );
  }
});

test('3 — no starter SOP is keyed to a deprecated department or a legacy alias', () => {
  const depts = new Set(STARTER_SOPS.map((s) => s.department));
  for (const dep of DEPRECATED) {
    assert.ok(!depts.has(dep), `deprecated department "${dep}" must not be seeded`);
  }
  for (const alias of LEGACY_ALIASES) {
    assert.ok(!depts.has(alias), `legacy alias "${alias}" must be re-keyed, never seeded raw`);
  }
});

// ── 4. Fresh-DB auto-seed yields the canonical set, no residue ───────────────
test('4 — a fresh DB auto-seeds the 16 canonical starter slugs, zero test/deprecated residue', () => {
  const db = getDb();
  const active = db
    .prepare('SELECT slug, department FROM sops WHERE deleted_at IS NULL')
    .all() as { slug: string; department: string }[];

  const seededSlugs = new Set(active.map((r) => r.slug));
  for (const sop of STARTER_SOPS) {
    assert.ok(seededSlugs.has(sop.slug), `starter slug ${sop.slug} should be seeded active`);
  }
  for (const row of active) {
    assert.ok(
      CANONICAL_SLUGS.has(row.department),
      `active SOP ${row.slug} has non-canonical department "${row.department}"`,
    );
    assert.notEqual(row.department, 'test-dept', 'no active test-dept rows on a fresh DB');
    assert.ok(!DEPRECATED.includes(row.department), `no active deprecated dept "${row.department}"`);
  }
});

// ── 5. Migration re-keys legacy rows, PRESERVING ids ─────────────────────────
test('5 — rekeyAndPurgeGhostSops re-keys legacy alias rows to canonical, id preserved', () => {
  const expected: Record<string, string> = {
    webdev: 'web-development',
    support: 'customer-support',
    comms: 'communications',
    billing: 'billing-finance',
    appdev: 'app-development',
    openclaw: 'openclaw-maintenance',
    social: 'social-media',
    'paid-ads': 'paid-advertisement',
  };
  const legacyIds: Record<string, string> = {};
  for (const alias of Object.keys(expected)) {
    legacyIds[alias] = insertGhost(`legacy-${alias}`, `Legacy ${alias} SOP`, alias);
  }
  // A row already canonical must be left untouched (id + slug + dept unchanged).
  const canonicalUntouchedId = insertGhost('canonical-marketing', 'Canonical Marketing SOP', 'marketing');

  const result = rekeyAndPurgeGhostSops(getDb());
  // Exactly the 8 legacy alias rows re-keyed (starter rows + 'marketing' already canonical).
  assert.equal(result.rekeyed, 8, 'exactly the 8 legacy alias rows should be re-keyed');

  const db = getDb();
  for (const [alias, canon] of Object.entries(expected)) {
    const row = db.prepare('SELECT id, department, deleted_at FROM sops WHERE id = ?').get(legacyIds[alias]) as
      | { id: string; department: string; deleted_at: string | null }
      | undefined;
    assert.ok(row, `legacy ${alias} row must still exist (re-keyed, not deleted)`);
    assert.equal(row!.id, legacyIds[alias], `sop id for ${alias} must be PRESERVED across re-key`);
    assert.equal(row!.department, canon, `${alias} must be re-keyed to ${canon}`);
    assert.equal(row!.deleted_at, null, `re-keyed ${alias} row must stay active`);
  }
  const marketing = db.prepare('SELECT department FROM sops WHERE id = ?').get(canonicalUntouchedId) as
    | { department: string }
    | undefined;
  assert.equal(marketing!.department, 'marketing', 'already-canonical row must be untouched');
});

// ── 6. Migration soft-deletes deprecated rows, preserving ids ────────────────
test('6 — rekeyAndPurgeGhostSops soft-deletes deprecated-department rows (id preserved)', () => {
  const depIds: Record<string, string> = {};
  for (const dep of DEPRECATED) {
    depIds[dep] = insertGhost(`dep-${dep}`, `Deprecated ${dep} SOP`, dep);
  }

  const result = rekeyAndPurgeGhostSops(getDb());
  assert.equal(result.deprecatedRetired, DEPRECATED.length, 'all 7 deprecated rows soft-deleted');

  const db = getDb();
  for (const dep of DEPRECATED) {
    const row = db.prepare('SELECT id, department, deleted_at FROM sops WHERE id = ?').get(depIds[dep]) as
      | { id: string; department: string; deleted_at: string | null }
      | undefined;
    assert.ok(row, `deprecated ${dep} row must still exist physically (soft delete)`);
    assert.equal(row!.id, depIds[dep], `deprecated ${dep} sop id preserved`);
    assert.ok(row!.deleted_at, `deprecated ${dep} row must carry deleted_at`);
  }
  // No ACTIVE row keyed to any deprecated department.
  const activeDep = db
    .prepare(
      `SELECT COUNT(*) AS c FROM sops WHERE deleted_at IS NULL AND department IN (${DEPRECATED.map(() => '?').join(',')})`,
    )
    .get(...DEPRECATED) as { c: number };
  assert.equal(activeDep.c, 0, 'zero active deprecated-department SOPs remain');
});

// ── 7. Migration purges test-dept residue entirely ───────────────────────────
test('7 — rekeyAndPurgeGhostSops purges test-dept residue (physically gone)', () => {
  const testIds = [
    insertGhost('test-a', 'Dims Test SOP A', 'test-dept'),
    insertGhost('test-b', 'Dims Test SOP B', 'test-dept'),
    insertGhost('test-c', 'Model Drift Test SOP', 'test-dept'),
  ];

  const result = rekeyAndPurgeGhostSops(getDb());
  assert.equal(result.testPurged, 3, 'all 3 test-dept residue rows purged');

  const db = getDb();
  for (const id of testIds) {
    const row = db.prepare('SELECT id FROM sops WHERE id = ?').get(id);
    assert.equal(row, undefined, `test-dept row ${id} must be physically deleted`);
  }
  const remaining = db.prepare("SELECT COUNT(*) AS c FROM sops WHERE department = 'test-dept'").get() as {
    c: number;
  };
  assert.equal(remaining.c, 0, 'no test-dept rows may remain (active or soft-deleted)');
});

// ── 8. Idempotency: a second run is a total no-op ────────────────────────────
test('8 — rekeyAndPurgeGhostSops is idempotent (second run does nothing)', () => {
  const again = rekeyAndPurgeGhostSops(getDb());
  assert.deepEqual(again, { rekeyed: 0, deprecatedRetired: 0, testPurged: 0 });
});

// ── 9. End state: full active library is canonical + residue-free ────────────
test('9 — post-migration active SOP set is fully canonical with no test/deprecated rows', () => {
  const db = getDb();
  const active = db.prepare('SELECT slug, department FROM sops WHERE deleted_at IS NULL').all() as {
    slug: string;
    department: string;
  }[];
  assert.ok(active.length >= STARTER_SOPS.length, 'at least the canonical starter set is active');
  for (const row of active) {
    assert.ok(
      CANONICAL_SLUGS.has(row.department),
      `active SOP ${row.slug} keyed to non-canonical "${row.department}"`,
    );
    assert.notEqual(row.department, 'test-dept');
    assert.ok(!DEPRECATED.includes(row.department));
  }
});
