/**
 * Fable-5 regression — the board filter and the department seeder must resolve the
 * SAME active company, even when a stale placeholder company row has a LOWER rowid
 * than the real client company.
 *
 * Root cause this locks in:
 *   On legacy boxes onboarded before the branding seed wrote a real slug, the
 *   `companies` table carries a stale `command-center` row (name = the real client,
 *   slug = `command-center`) at rowid 1, and the real branded row (e.g. `marico`)
 *   at a HIGHER rowid. Two resolvers disagreed:
 *     • the board filter (resolveActiveCompanyId) is placeholder-aware → `marico`
 *     • the department seeder (seedCompanyGuarded's "first non-Default row") is
 *       NOT placeholder-aware → `command-center`
 *   Every boot/converge reseed therefore re-pinned all departments to
 *   `command-center` while the board filtered on `marico`, collapsing the board to
 *   the handful of rows the reseed never touches.
 *
 * The fix routes BOTH paths through resolveSeedingCompanyId (branding-seed.ts), a
 * single placeholder-aware resolver. This test reproduces Maria's exact company
 * table and asserts the two resolvers agree on `marico`.
 *
 * Run: node --import tsx --test tests/unit/fable5-active-company-resolution.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  resolveSeedingCompanyId,
  isPlaceholderCompany,
} from '../../src/lib/db/branding-seed';
import { resolveActiveCompanyId } from '../../src/lib/company';

/** Minimal companies table mirroring the production schema. */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      industry TEXT,
      logo_url TEXT,
      config TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

/**
 * Reproduce Maria's exact companies table: a stale `command-center` placeholder at
 * rowid 1 (name = the real client), the real `marico` brand at rowid 2, plus the
 * `default` sentinel and a couple of other strays.
 */
function seedMariaShape(db: Database.Database): void {
  const ins = db.prepare(
    'INSERT INTO companies (id, name, slug, industry, config) VALUES (?, ?, ?, ?, ?)',
  );
  ins.run('command-center', 'Marico Consulting LLC', 'command-center', '', '{}'); // rowid 1 — stale placeholder
  ins.run('marico', 'Marico Consulting LLC', 'marico', '', '{}'); // rowid 2 — real brand
  ins.run('default', 'Default', 'default', '', '{}'); // rowid 3 — sentinel
}

/** Run a block with COMPANY_SLUG / COMPANY_NAME cleared (deterministic fallback). */
function withoutCompanyEnv<T>(fn: () => T): T {
  const savedSlug = process.env.COMPANY_SLUG;
  const savedName = process.env.COMPANY_NAME;
  delete process.env.COMPANY_SLUG;
  delete process.env.COMPANY_NAME;
  try {
    return fn();
  } finally {
    if (savedSlug === undefined) delete process.env.COMPANY_SLUG;
    else process.env.COMPANY_SLUG = savedSlug;
    if (savedName === undefined) delete process.env.COMPANY_NAME;
    else process.env.COMPANY_NAME = savedName;
  }
}

test('Fable-5: a stale `command-center` placeholder at rowid 1 never wins over the real `marico` brand', () => {
  const db = makeTestDb();
  try {
    seedMariaShape(db);
    withoutCompanyEnv(() => {
      const active = resolveSeedingCompanyId(db);
      assert.strictEqual(
        active,
        'marico',
        'resolveSeedingCompanyId must skip the stale command-center placeholder and return the real brand',
      );
      assert.notStrictEqual(active, 'command-center', 'must NEVER resolve to the placeholder');
    });
  } finally {
    db.close();
  }
});

test('Fable-5: the board filter and the seeder resolve the SAME active company (no disagreement)', () => {
  const db = makeTestDb();
  try {
    seedMariaShape(db);
    withoutCompanyEnv(() => {
      const seeder = resolveSeedingCompanyId(db);
      const board = resolveActiveCompanyId(db);
      assert.strictEqual(
        seeder,
        board,
        'resolveSeedingCompanyId (seeder) and resolveActiveCompanyId (board) must agree — their disagreement was the Fable-5 root cause',
      );
      assert.strictEqual(board, 'marico');
    });
  } finally {
    db.close();
  }
});

test('Fable-5: an explicit COMPANY_SLUG override still wins, even over a placeholder-slug row', () => {
  const db = makeTestDb();
  try {
    seedMariaShape(db);
    const saved = process.env.COMPANY_SLUG;
    process.env.COMPANY_SLUG = 'marico';
    try {
      assert.strictEqual(resolveSeedingCompanyId(db), 'marico');
    } finally {
      if (saved === undefined) delete process.env.COMPANY_SLUG;
      else process.env.COMPANY_SLUG = saved;
    }
  } finally {
    db.close();
  }
});

test('Fable-5: only-placeholder companies → null (fail-open), never a placeholder id', () => {
  const db = makeTestDb();
  try {
    db.prepare(
      "INSERT INTO companies (id, name, slug, config) VALUES ('command-center', 'Command Center', 'command-center', '{}')",
    ).run();
    db.prepare(
      "INSERT INTO companies (id, name, slug, config) VALUES ('default', 'Default', 'default', '{}')",
    ).run();
    withoutCompanyEnv(() => {
      assert.strictEqual(
        resolveSeedingCompanyId(db),
        null,
        'an un-branded box (only placeholder companies) must resolve to null, not to a placeholder id',
      );
    });
  } finally {
    db.close();
  }
});

test('isPlaceholderCompany flags the legacy command-center / default / acme rows but not real brands', () => {
  assert.strictEqual(isPlaceholderCompany({ name: 'Marico Consulting LLC', slug: 'command-center' }), true);
  assert.strictEqual(isPlaceholderCompany({ name: 'Command Center', slug: 'whatever' }), true);
  assert.strictEqual(isPlaceholderCompany({ name: 'Default', slug: 'default' }), true);
  assert.strictEqual(isPlaceholderCompany({ name: 'Acme Corp', slug: 'acme-corp' }), true);
  assert.strictEqual(isPlaceholderCompany({ name: 'Marico Consulting LLC', slug: 'marico' }), false);
  assert.strictEqual(isPlaceholderCompany({ name: 'Riverside Media', slug: 'riverside-media' }), false);
});
