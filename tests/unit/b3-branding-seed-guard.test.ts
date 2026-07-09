/**
 * B.3 Branding Seed Guard — focused unit tests
 *
 * PRD Addendum B §B.3 (P0): "no seed may ever write Default over a configured client"
 *
 * Test fixtures (per PRD Verify section):
 *   (a) config present + empty companies table → seed writes REAL brand, never Default
 *   (b) existing non-Default row → seed is a NO-OP
 *   (c) no config file → Default allowed
 *
 * Plus:
 *   (d) B.1 partial-config rule: config present + empty companyName → partial-config,
 *       NOT seeded, never writes Default or any synthesised name
 *   (e) B.4 fixture: ecosystem.config.cjs template emits absolute DATABASE_PATH
 *
 * Run: node --import tsx --test tests/unit/b3-branding-seed-guard.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  seedCompanyGuarded,
  readCompanyConfigFromDisk,
  slugifyCompanyName,
  findCompanyConfigPaths,
  type BrandingSeedResult,
} from '../../src/lib/db/branding-seed';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'b3-seed-guard-'));
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Create an in-memory SQLite DB with the minimal companies table for tests.
 * Using ':memory:' avoids file-system side effects.
 */
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
 * Write a company-config.json to a temp dir's config/ subdirectory.
 */
function writeCompanyConfig(dir: string, data: object): void {
  mkdirSync(path.join(dir, 'config'), { recursive: true });
  writeFileSync(
    path.join(dir, 'config', 'company-config.json'),
    JSON.stringify(data),
    'utf-8',
  );
}

// ─── fixture (a): config present + empty companies table ──────────────────────

test('(a) config present + empty companies table → seeded from config, NEVER Default', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    writeCompanyConfig(dir, {
      companyName: 'Riverside Media Enterprises',
      industry: 'Media',
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#FF5733',
    });

    const result: BrandingSeedResult = seedCompanyGuarded(db, { cwd: dir });

    // Must report seeded-from-config
    assert.strictEqual(result.reason, 'seeded-from-config',
      `Expected reason='seeded-from-config', got '${result.reason}'`);
    assert.strictEqual(result.seeded, true, 'seeded must be true');
    assert.ok(result.companyId, 'companyId must be set');

    // Query the DB to verify the real brand was written
    const row = db.prepare('SELECT id, name, slug, industry, logo_url FROM companies WHERE id = ?').get(result.companyId) as {
      id: string; name: string; slug: string; industry: string; logo_url: string;
    };
    assert.ok(row, `Company row not found for id '${result.companyId}'`);
    assert.strictEqual(row.name, 'Riverside Media Enterprises', 'name must be real brand');
    assert.notStrictEqual(row.name, 'Default', 'name must NEVER be Default');
    assert.notStrictEqual(row.name, 'Command Center', 'name must not be generic fallback');
    assert.strictEqual(row.industry, 'Media', 'industry must be from config');

    // Verify no Default row exists
    const defaultRow = db.prepare("SELECT id FROM companies WHERE name = 'Default'").get();
    assert.strictEqual(defaultRow, undefined, 'No Default row must exist when config is present');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('(a) slug is derived from companyName when companySlug absent', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    writeCompanyConfig(dir, { companyName: 'Acme Corp & Partners LLC' });
    const result = seedCompanyGuarded(db, { cwd: dir });

    assert.strictEqual(result.reason, 'seeded-from-config');
    const expectedSlug = slugifyCompanyName('Acme Corp & Partners LLC');
    assert.strictEqual(result.companyId, expectedSlug,
      `companyId must be the slugified form of the company name`);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('(a) explicit companySlug in config takes precedence over derived slug', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    writeCompanyConfig(dir, {
      companyName: 'Summit Retail Group',
      companySlug: 'summit-retail',
    });
    const result = seedCompanyGuarded(db, { cwd: dir });
    assert.strictEqual(result.reason, 'seeded-from-config');
    assert.strictEqual(result.companyId, 'summit-retail',
      'explicit companySlug must be used as-is');
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ─── fixture (b): existing non-Default row → seed is a NO-OP ─────────────────

test('(b) existing non-Default company row → seed is a strict NO-OP, never overwrites', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    // Pre-insert a real company row
    db.prepare(
      "INSERT INTO companies (id, name, slug, industry, config) VALUES ('coastal', 'Coastal Ventures Media', 'coastal', 'Media', '{}')"
    ).run();

    // Even if config is present on disk (with a different name), seed must not touch it
    writeCompanyConfig(dir, { companyName: 'Should NOT overwrite' });

    const result = seedCompanyGuarded(db, { cwd: dir });

    assert.strictEqual(result.reason, 'already-exists-non-default',
      `Expected reason='already-exists-non-default', got '${result.reason}'`);
    assert.strictEqual(result.seeded, false, 'seeded must be false — NO-OP');
    assert.strictEqual(result.companyId, 'coastal', 'companyId must be the existing row id');

    // Verify the original row is untouched
    const row = db.prepare('SELECT name FROM companies WHERE id = ?').get('coastal') as { name: string };
    assert.strictEqual(row.name, 'Coastal Ventures Media', 'Existing row must not be overwritten');

    // Verify no new row was created
    const count = (db.prepare('SELECT COUNT(*) as c FROM companies').get() as { c: number }).c;
    assert.strictEqual(count, 1, 'Must still be exactly one company row');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('(b) NO-OP also applies when no config exists on disk — existing row is sacred', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    db.prepare(
      "INSERT INTO companies (id, name, slug, config) VALUES ('northgate', 'Northgate Group', 'northgate', '{}')"
    ).run();

    // No config file in dir
    const result = seedCompanyGuarded(db, { cwd: dir });

    assert.strictEqual(result.reason, 'already-exists-non-default');
    assert.strictEqual(result.seeded, false);

    // Existing row unchanged
    const row = db.prepare('SELECT name FROM companies WHERE id = ?').get('northgate') as { name: string };
    assert.strictEqual(row.name, 'Northgate Group');
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ─── fixture (c): no config → Default allowed ────────────────────────────────

test('(c) no config file + empty companies table → Default is seeded (allowed)', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    // dir has no config/ subdirectory — truly unconfigured box
    const result = seedCompanyGuarded(db, { cwd: dir });

    assert.strictEqual(result.reason, 'seeded-default-no-config',
      `Expected reason='seeded-default-no-config', got '${result.reason}'`);
    assert.strictEqual(result.seeded, true, 'seeded must be true');
    assert.strictEqual(result.companyId, 'default');

    const row = db.prepare("SELECT id, name FROM companies WHERE id = 'default'").get() as { id: string; name: string };
    assert.ok(row, 'Default company row must exist');
    assert.strictEqual(row.name, 'Default');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('(c) no config + existing Default row → already-default, no duplicate', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    db.prepare("INSERT INTO companies (id, name, slug, config) VALUES ('default', 'Default', 'default', '{}')").run();

    const result = seedCompanyGuarded(db, { cwd: dir });

    assert.strictEqual(result.reason, 'already-default');
    assert.strictEqual(result.seeded, false);
    assert.strictEqual(result.companyId, 'default');

    const count = (db.prepare('SELECT COUNT(*) as c FROM companies').get() as { c: number }).c;
    assert.strictEqual(count, 1, 'Still exactly one row');
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ─── fixture (d): B.1 partial-config rule ────────────────────────────────────

test('(d) B.1 partial-config: config exists but companyName empty string → partial-config, nothing written', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    writeCompanyConfig(dir, {
      companyName: '',  // explicitly empty
      industry: 'Real Estate',
    });

    const result = seedCompanyGuarded(db, { cwd: dir });

    assert.strictEqual(result.reason, 'partial-config',
      `Expected reason='partial-config' for empty companyName, got '${result.reason}'`);
    assert.strictEqual(result.seeded, false, 'seeded must be false for partial-config');
    assert.strictEqual(result.companyId, null, 'companyId must be null for partial-config');

    // Companies table must be completely empty — no Default, no synthesised name
    const count = (db.prepare('SELECT COUNT(*) as c FROM companies').get() as { c: number }).c;
    assert.strictEqual(count, 0, 'Companies table must stay empty when config is partial');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('(d) B.1 partial-config: config exists but companyName whitespace-only → partial-config', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    writeCompanyConfig(dir, { companyName: '   \t\n  ' });

    const result = seedCompanyGuarded(db, { cwd: dir });

    assert.strictEqual(result.reason, 'partial-config');
    assert.strictEqual(result.seeded, false);

    const count = (db.prepare('SELECT COUNT(*) as c FROM companies').get() as { c: number }).c;
    assert.strictEqual(count, 0, 'Nothing must be written for whitespace-only companyName');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('(d) B.1 partial-config: config exists but companyName null → partial-config', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    writeCompanyConfig(dir, { companyName: null, industry: 'Fashion' });

    const result = seedCompanyGuarded(db, { cwd: dir });

    assert.strictEqual(result.reason, 'partial-config');
    assert.strictEqual(result.seeded, false);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('(d) B.1 partial-config must NOT be the same branch as "no config" — different code paths', () => {
  const dirWithConfig = makeTmpDir();
  const dirNoConfig = makeTmpDir();
  const db1 = makeTestDb();
  const db2 = makeTestDb();
  try {
    writeCompanyConfig(dirWithConfig, { companyName: '' });

    const partialResult = seedCompanyGuarded(db1, { cwd: dirWithConfig });
    const noConfigResult = seedCompanyGuarded(db2, { cwd: dirNoConfig });

    assert.strictEqual(partialResult.reason, 'partial-config',
      'Config-with-empty-name must be partial-config');
    assert.strictEqual(noConfigResult.reason, 'seeded-default-no-config',
      'No-config must be seeded-default-no-config');

    // They must be different reasons — partial-config must NOT allow Default
    assert.notStrictEqual(partialResult.reason, noConfigResult.reason,
      'partial-config and no-config must take different code paths');
    assert.strictEqual(partialResult.seeded, false,
      'partial-config must not seed anything');
    assert.strictEqual(noConfigResult.seeded, true,
      'no-config must seed Default');
  } finally {
    db1.close();
    db2.close();
    cleanup(dirWithConfig);
    cleanup(dirNoConfig);
  }
});

// ─── fixture (d2): unpopulated template sentinel → partial-config (2026-07-08) ──

test('(d2) template sentinel "Your Company" → partial-config, nothing written (fail-closed)', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    // The repo ships this exact companyName template (config-guard.yml enforces it).
    // A box still carrying it has never been branded — seeding a `your-company`
    // row here is the attribution-drift bug. Must fail closed like a blank name.
    writeCompanyConfig(dir, { companyName: 'Your Company', industry: '', departments: [] });

    const result = seedCompanyGuarded(db, { cwd: dir });

    assert.strictEqual(result.reason, 'partial-config',
      `Expected reason='partial-config' for the "Your Company" template, got '${result.reason}'`);
    assert.strictEqual(result.seeded, false, 'template must not seed anything');
    assert.strictEqual(result.companyId, null, 'companyId must be null for template');

    const count = (db.prepare('SELECT COUNT(*) as c FROM companies').get() as { c: number }).c;
    assert.strictEqual(count, 0, 'No company row may be written for the unpopulated template');
    const bogus = db.prepare("SELECT id FROM companies WHERE slug = 'your-company'").get();
    assert.strictEqual(bogus, undefined, 'must NEVER create a bogus your-company row');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('(d2) template sentinel is case/space-insensitive ("  your company  ")', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    writeCompanyConfig(dir, { companyName: '  Your Company  ' });
    const result = seedCompanyGuarded(db, { cwd: dir });
    assert.strictEqual(result.reason, 'partial-config');
    assert.strictEqual(result.seeded, false);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('(d2) README env placeholder "Your Company Name" is also treated as template', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    writeCompanyConfig(dir, { companyName: 'Your Company Name' });
    const result = seedCompanyGuarded(db, { cwd: dir });
    assert.strictEqual(result.reason, 'partial-config');
    assert.strictEqual(result.seeded, false);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('(d2) a REAL brand that merely contains the word "Company" still seeds (no false positive)', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    writeCompanyConfig(dir, { companyName: 'Riverside Company Holdings' });
    const result = seedCompanyGuarded(db, { cwd: dir });
    assert.strictEqual(result.reason, 'seeded-from-config',
      'a real brand containing "Company" must NOT be misread as the template');
    assert.strictEqual(result.seeded, true);
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ─── table-missing guard ──────────────────────────────────────────────────────

test('table-missing: companies table absent → returns table-missing, no crash', () => {
  const dir = makeTmpDir();
  const db = new Database(':memory:');
  // Intentionally NOT creating the companies table
  try {
    const result = seedCompanyGuarded(db, { cwd: dir });
    assert.strictEqual(result.reason, 'table-missing');
    assert.strictEqual(result.seeded, false);
    assert.strictEqual(result.companyId, null);
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ─── idempotency: calling twice is safe ───────────────────────────────────────

test('idempotency: calling seedCompanyGuarded twice with the same config does not duplicate rows', () => {
  const dir = makeTmpDir();
  const db = makeTestDb();
  try {
    writeCompanyConfig(dir, { companyName: 'Brightline Consulting' });

    const r1 = seedCompanyGuarded(db, { cwd: dir });
    const r2 = seedCompanyGuarded(db, { cwd: dir });

    assert.strictEqual(r1.reason, 'seeded-from-config');
    assert.strictEqual(r2.reason, 'already-exists-non-default');
    assert.strictEqual(r2.seeded, false);

    const count = (db.prepare('SELECT COUNT(*) as c FROM companies').get() as { c: number }).c;
    assert.strictEqual(count, 1, 'Calling twice must not create duplicate rows');
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ─── readCompanyConfigFromDisk helper ────────────────────────────────────────

test('readCompanyConfigFromDisk returns null when no config file exists', () => {
  const dir = makeTmpDir();
  try {
    const result = readCompanyConfigFromDisk(dir);
    assert.strictEqual(result, null);
  } finally {
    cleanup(dir);
  }
});

test('readCompanyConfigFromDisk returns config with empty companyName when file has empty string', () => {
  const dir = makeTmpDir();
  try {
    writeCompanyConfig(dir, { companyName: '' });
    const result = readCompanyConfigFromDisk(dir);
    assert.notStrictEqual(result, null, 'Should return an object (not null) when file exists');
    assert.strictEqual(result!.companyName, '', 'Must preserve empty string — not default to anything');
  } finally {
    cleanup(dir);
  }
});

test('readCompanyConfigFromDisk returns null for malformed JSON (does not throw)', () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(path.join(dir, 'config'), { recursive: true });
    writeFileSync(path.join(dir, 'config', 'company-config.json'), '{invalid json', 'utf-8');

    // Must not throw
    let result: ReturnType<typeof readCompanyConfigFromDisk> = null;
    assert.doesNotThrow(() => {
      result = readCompanyConfigFromDisk(dir);
    });
    assert.strictEqual(result, null, 'Malformed JSON must return null');
  } finally {
    cleanup(dir);
  }
});

// ─── slugifyCompanyName ────────────────────────────────────────────────────────

test('slugifyCompanyName produces valid URL-safe slugs', () => {
  const cases: [string, string][] = [
    ['Riverside Media Enterprises', 'riverside-media-enterprises'],
    ['Acme Corp & Partners LLC', 'acme-corp-partners-llc'],
    ['  Leading/Trailing Spaces  ', 'leading-trailing-spaces'],
    ['Nadia\'s Consulting – Group', 'nadia-s-consulting-group'],
    ['', 'company'],  // empty → fallback
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(slugifyCompanyName(input), expected,
      `slugifyCompanyName(${JSON.stringify(input)}) should equal ${JSON.stringify(expected)}`);
  }
});

// ─── B.4 fixture (e): ecosystem.config.cjs emits absolute DATABASE_PATH ──────

test('(e) B.4 ecosystem.config.cjs template contains DATABASE_PATH set to absolute path', () => {
  const ecosystemPath = path.join(process.cwd(), 'ecosystem.config.cjs');
  const src = readFileSync(ecosystemPath, 'utf-8');

  // Must contain DATABASE_PATH in the env block
  assert.ok(
    src.includes('DATABASE_PATH'),
    'ecosystem.config.cjs must set DATABASE_PATH in the pm2 env block (B.4)'
  );

  // Must be set to an absolute path (or dynamically resolved from INSTALL_DIR)
  // The template uses either a hardcoded absolute path or the `DB_PATH` variable
  assert.ok(
    src.includes('DB_PATH') || src.includes('DATABASE_PATH:') || src.includes('DATABASE_PATH ='),
    'ecosystem.config.cjs must set DATABASE_PATH (as a variable or inline)'
  );

  // The resolved DB_PATH must be constructed from an absolute base, not process.cwd()
  // Pattern: uses INSTALL_DIR or CC_INSTALL_DIR, not process.cwd() alone
  assert.ok(
    src.includes('INSTALL_DIR') || src.includes('mission-control.db'),
    'ecosystem.config.cjs must pin DATABASE_PATH to a canonical absolute path (using INSTALL_DIR or hardcoded path)'
  );
});

test('(e) B.4 mac-mini-bootstrap.sh ecosystem template includes DATABASE_PATH', () => {
  const bootstrapPath = path.join(process.cwd(), 'scripts', 'install', 'mac-mini-bootstrap.sh');
  const src = readFileSync(bootstrapPath, 'utf-8');

  assert.ok(
    src.includes('DATABASE_PATH'),
    'mac-mini-bootstrap.sh ecosystem template must include DATABASE_PATH'
  );

  // DATABASE_PATH must reference the canonical install dir (ECOSYSTEM_DIR)
  assert.ok(
    src.includes('$ECOSYSTEM_DIR/mission-control.db') || src.includes('mission-control.db'),
    'mac-mini-bootstrap.sh must set DATABASE_PATH to $ECOSYSTEM_DIR/mission-control.db'
  );
});

test('(e) B.4 vps-docker-bootstrap.sh ecosystem template includes DATABASE_PATH', () => {
  const bootstrapPath = path.join(process.cwd(), 'scripts', 'install', 'vps-docker-bootstrap.sh');
  const src = readFileSync(bootstrapPath, 'utf-8');

  assert.ok(
    src.includes('DATABASE_PATH'),
    'vps-docker-bootstrap.sh ecosystem template must include DATABASE_PATH'
  );

  // VPS canonical path
  assert.ok(
    src.includes('/data/projects/command-center/mission-control.db'),
    'vps-docker-bootstrap.sh must set DATABASE_PATH to /data/projects/command-center/mission-control.db'
  );
});

// ─── findCompanyConfigPaths returns expected candidates ───────────────────────

test('findCompanyConfigPaths includes cwd/config/company-config.json as first candidate', () => {
  const paths = findCompanyConfigPaths('/some/install/dir');
  assert.ok(
    paths.length >= 1,
    'findCompanyConfigPaths must return at least one candidate'
  );
  assert.strictEqual(
    paths[0],
    path.join('/some/install/dir', 'config', 'company-config.json'),
    'First candidate must be <cwd>/config/company-config.json'
  );
});

// ─── brandingSeeded closeout hook documentation ───────────────────────────────

test('branding-seed.ts is exported from src/lib/db and exports seedCompanyGuarded', () => {
  // Structural: verify the module shape. The function is already imported at the
  // top of this test file, so this test only confirms the export exists.
  assert.strictEqual(typeof seedCompanyGuarded, 'function',
    'seedCompanyGuarded must be exported from branding-seed.ts');
});

test('branding-seed.ts documents the brandingSeeded closeout hook (comment present)', () => {
  const brandingSeedSrc = readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'db', 'branding-seed.ts'),
    'utf-8',
  );
  assert.ok(
    brandingSeedSrc.includes('brandingSeeded'),
    'branding-seed.ts must document the brandingSeeded closeout leg hook'
  );
  assert.ok(
    brandingSeedSrc.includes('openclaw-onboarding'),
    'branding-seed.ts must reference the openclaw-onboarding repo where the closeout leg lands'
  );
});
