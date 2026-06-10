/**
 * Unit tests for /api/health/deep — porting the B.1 truth table as spec.
 *
 * Every applicable row in docs/B1-truth-table.md becomes one or more test
 * cases here.  A new edge case is a new row + new test, by design.
 *
 * We test the check functions from src/lib/health/deep-checks.ts directly
 * (not the HTTP layer) for speed and determinism.  The fixtures use
 * in-memory SQLite mocks and temp-dir .next trees.
 *
 * Truth-table rows NOT covered here (handled by cc-health-check.sh):
 *   Rows 14-19 (pm2 topology)   — shell-only, tested by the probe fixture test
 *   Rows 25-27, 33 (CF tunnel)  — public-URL probe in cc-health-check.sh
 *
 * Rows covered: 1-13, 20-24, 28-32 (applicable to the TypeScript endpoint).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal .next build tree in a temp dir. */
function makeNextBuild(dir: string, opts: {
  withBuildId?: boolean;
  withManifest?: boolean;
  withStaticDir?: boolean;
  missingAsset?: string;   // relative path under .next/ to omit e.g. 'static/chunks/main-abc123.js'
} = {}): void {
  const {
    withBuildId = true,
    withManifest = true,
    withStaticDir = true,
    missingAsset,
  } = opts;

  const nextDir = path.join(dir, '.next');
  fs.mkdirSync(nextDir, { recursive: true });

  if (withBuildId) {
    fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'abc123test');
  }

  if (withStaticDir) {
    // Use RELATIVE path form that real build-manifest.json uses (no /_next/ prefix)
    const relPath = 'static/chunks/main-abc123.js';
    const diskPath = path.join(nextDir, relPath);
    fs.mkdirSync(path.dirname(diskPath), { recursive: true });

    if (missingAsset !== relPath) {
      fs.writeFileSync(diskPath, '// placeholder js');
    }

    if (withManifest) {
      // Real build-manifest.json format: relative paths (no /_next/ prefix)
      const manifest = {
        pages: {
          '/': [relPath],
          '/_app': [relPath],
        },
        polyfillFiles: [],
        lowPriorityFiles: [],
      };
      fs.writeFileSync(path.join(nextDir, 'build-manifest.json'), JSON.stringify(manifest));
    }
  } else if (withManifest) {
    const manifest = { pages: {}, polyfillFiles: [], lowPriorityFiles: [] };
    fs.writeFileSync(path.join(nextDir, 'build-manifest.json'), JSON.stringify(manifest));
  }
}

/** Create a minimal company-config.json. */
function writeCompanyConfig(dir: string, content: Record<string, unknown>): void {
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'company-config.json'), JSON.stringify(content));
}

// ── module loading ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-health-test-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadChecks() {
  vi.resetModules();
  return await import('../../src/lib/health/deep-checks.js') as typeof import('../../src/lib/health/deep-checks');
}

// ────────────────────────────────────────────────────────────────────────────
// ASSET MANIFEST CHECKS (truth-table rows 11-12)
// ────────────────────────────────────────────────────────────────────────────

describe('asset_manifest', () => {
  // Row 11: manifest present and all assets exist → PASS
  it('row 11: complete build with all assets present → pass=true', async () => {
    makeNextBuild(tmpDir);
    const { checkAssetManifest } = await loadChecks();
    const result = checkAssetManifest();
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/OK/);
    // referenced_count > 0 confirms the filter actually found paths
    expect((result as { referenced_count?: number }).referenced_count).toBeGreaterThan(0);
  });

  // Row 12: manifest exists but references an asset missing from disk → FAIL
  // FIXED: uses relative path form matching real build-manifest.json format
  it('row 12: stale manifest — referenced asset missing from disk → pass=false', async () => {
    makeNextBuild(tmpDir, { missingAsset: 'static/chunks/main-abc123.js' });
    const { checkAssetManifest } = await loadChecks();
    const result = checkAssetManifest();
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/missing/i);
  });

  // Row 13: old but complete build — age alone does NOT fail
  it('row 13: old but complete build (all assets present) → pass=true', async () => {
    makeNextBuild(tmpDir);
    const buildIdPath = path.join(tmpDir, '.next', 'BUILD_ID');
    const epoch = new Date(0);
    fs.utimesSync(buildIdPath, epoch, epoch);
    const { checkAssetManifest } = await loadChecks();
    const result = checkAssetManifest();
    expect(result.pass).toBe(true);
  });

  it('missing BUILD_ID file → pass=false', async () => {
    makeNextBuild(tmpDir, { withBuildId: false });
    const { checkAssetManifest } = await loadChecks();
    const result = checkAssetManifest();
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/BUILD_ID missing/i);
  });

  it('static dir absent → pass=false', async () => {
    makeNextBuild(tmpDir, { withStaticDir: false });
    const { checkAssetManifest } = await loadChecks();
    const result = checkAssetManifest();
    expect(result.pass).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// COMPANY BRANDING CHECKS (truth-table rows 1-7)
// ────────────────────────────────────────────────────────────────────────────

describe('company_branding — config file rules', () => {
  // Row 1b (Round-2 fix #3): config absent + DB has real branded name → PASS.
  // This is the API-onboarded install path: no config file is present but the
  // company was seeded directly via the API.  The old Row 1 specification said
  // "config absent → FAIL" which was wrong — the implementation already handled
  // this correctly but there was no vitest proof for the passing path.
  it('row 1b: config absent + DB has real branded name (API-onboarded) → pass=true', async () => {
    // No config file written — tmpDir has no config/company-config.json
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            if (sql.includes('SELECT name FROM companies')) return { name: 'Karen Vaughn Enterprises' };
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: ['001'], pending: [] }),
      DB_PATH: path.join(tmpDir, 'test.db'),
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.pass).toBe(true);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/onboarded via API/i);
    expect((result as { config_exists?: boolean }).config_exists).toBe(false);
  });

  // Row 1 (narrowed): config absent + DB empty/absent → UNKNOWN (not FAIL).
  // FIXED: mock getDb so real migration 064 does not insert 'Default' row
  it('row 1+6: config absent + no DB row → indeterminate=true (UNKNOWN, not FAIL)', async () => {
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            if (sql.includes('SELECT name FROM companies')) return undefined;
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: [], pending: [] }),
      DB_PATH: path.join(tmpDir, 'test.db'),
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.indeterminate).toBe(true);
  });

  // Row 2: config present but companyName absent → FAIL
  it('row 2: config present but companyName absent (empty object) → pass=false', async () => {
    writeCompanyConfig(tmpDir, {});
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/partial-config rule/i);
  });

  it('partial-config rule: config present, companyName empty string → pass=false', async () => {
    writeCompanyConfig(tmpDir, { companyName: '' });
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/partial-config rule/i);
  });

  it('partial-config rule: config present, companyName whitespace-only → pass=false', async () => {
    writeCompanyConfig(tmpDir, { companyName: '   ' });
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/partial-config rule/i);
  });

  it('partial-config rule: config present, companyName null → pass=false', async () => {
    writeCompanyConfig(tmpDir, { companyName: null });
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
  });

  // Row 36: config present with valid companyName + DB companies row entirely absent → PASS
  // A valid config is sufficient to declare the company configured; a missing DB
  // row (e.g. fresh deploy before seed runs) must NOT be treated as a FAIL or UNKNOWN.
  // Implementation: deep-checks.ts falls through all guards with dbRowAbsent=true,
  // configExists=true, configName set — reaches the full happy-path return.
  it('row 36: config present with valid companyName + DB row absent (not empty, truly absent) → pass=true', async () => {
    writeCompanyConfig(tmpDir, { companyName: 'Karen Vaughn Enterprises' });
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            // DB row absent — no row in companies table
            if (sql.includes('SELECT name FROM companies')) return undefined;
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: ['001'], pending: [] }),
      DB_PATH: path.join(tmpDir, 'test.db'),
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    // Config file with valid companyName is sufficient → PASS
    expect(result.pass).toBe(true);
    expect(result.indeterminate).not.toBe(true);
  });

  // Row 3: config present with valid companyName + matching DB name → PASS
  it('row 3: config present with valid companyName → passes', async () => {
    writeCompanyConfig(tmpDir, { companyName: 'Acme Corp' });
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            if (sql.includes('SELECT name FROM companies')) return { name: 'Acme Corp' };
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: ['001'], pending: [] }),
      DB_PATH: path.join(tmpDir, 'test.db'),
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.detail).not.toMatch(/partial-config rule/i);
    expect(result.pass).toBe(true);
  });
});

describe('company_branding — DB branding checks', () => {
  // Row 4 variant: DB company row = "Command Center" → FAIL
  // FALSE-GREEN CONFIRMED on feat/b1-cc-health-check (old branch, line 1125):
  // only `== "default"` was checked; "Command Center" was treated as a valid
  // client name.  The TypeScript PLACEHOLDER_NAMES set includes 'command center'
  // so the deep-checks.ts path IS correct — this test proves it.
  it('row 4 (Command Center, configured-box): DB name="Command Center", config matches → pass=false', async () => {
    writeCompanyConfig(tmpDir, { companyName: 'Command Center' });
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            if (sql.includes('SELECT name FROM companies')) return { name: 'Command Center' };
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: ['001'], pending: [] }),
      DB_PATH: '/tmp/test.db',
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    // 'Command Center' is a PLACEHOLDER_NAME — must FAIL even when config and DB agree
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/placeholder/i);
  });

  // Row 4 variant: unconfigured-box path — config absent, DB="Command Center" → FAIL
  // The shell script feat/b1-cc-health-check had a second false-green on the
  // unconfigured-box branch (line 1163 also only checked "default").  This test
  // covers the TypeScript equivalent: config absent + DB placeholder → FAIL via
  // the placeholder-name check in deep-checks.ts before the "config absent" exit.
  it('row 4 (Command Center, unconfigured-box): config absent, DB="Command Center" → pass=false', async () => {
    // No config file written
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            if (sql.includes('SELECT name FROM companies')) return { name: 'Command Center' };
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: ['001'], pending: [] }),
      DB_PATH: '/tmp/test.db',
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    // PLACEHOLDER_NAMES check fires before the "config absent + branded DB → PASS" branch
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/placeholder/i);
  });

  // Row 4: DB company row = "Default" → FAIL
  it('row 4: DB company name is "Default" → pass=false', async () => {
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            if (sql.includes('SELECT name FROM companies')) return { name: 'Default' };
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: [], pending: [] }),
      DB_PATH: '/tmp/test.db',
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/placeholder/i);
  });

  // Row 5: DB company row branded → PASS
  it('row 5: DB company name is real brand name → pass=true', async () => {
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            if (sql.includes('SELECT name FROM companies')) return { name: 'Karen Vaughn Enterprises' };
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: [], pending: [] }),
      DB_PATH: '/tmp/test.db',
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.pass).toBe(true);
  });

  // Row 6: DB row absent + no config → UNKNOWN
  it('row 6: no DB company row (fresh install) + no config → indeterminate=true', async () => {
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            if (sql.includes('SELECT name FROM companies')) return undefined;
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: [], pending: [] }),
      DB_PATH: '/tmp/test.db',
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.indeterminate).toBe(true);
    expect(result.pass).toBe(false);
  });

  // Row 7: DB companies row with empty-string name → FAIL
  // SPEC: "Empty string is as bad as absent."
  // FIX: the old SQL `WHERE name != ''` EXCLUDED the empty row (returning undefined →
  // dbRowAbsent=true → UNKNOWN).  The new query selects ALL rows; empty-string name
  // is detected in application code and correctly returns FAIL.
  it('row 7: DB company name is empty string → pass=false, NOT indeterminate', async () => {
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            // Return a row with an empty-string name — the fixed query returns this
            if (sql.includes('SELECT name FROM companies')) return { name: '' };
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: [], pending: [] }),
      DB_PATH: '/tmp/test.db',
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    // spec=FAIL, impl must NOT return indeterminate
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/empty|placeholder/i);
  });

  // Row 7 sub-case: empty string with config present → FAIL (not partial-config rule,
  // but DB-branding FAIL because empty string name is returned from DB)
  it('row 7b: DB empty-string name with valid config → pass=false (DB name FAIL)', async () => {
    writeCompanyConfig(tmpDir, { companyName: 'Acme Corp' });
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            if (sql.includes('SELECT name FROM companies')) return { name: '' };
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: [], pending: [] }),
      DB_PATH: '/tmp/test.db',
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
  });

  // Row 28: DB locked → UNKNOWN
  it('row 28: DB locked (SQLITE_BUSY) → indeterminate=true', async () => {
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: () => ({
          get: () => { throw new Error('SQLITE_BUSY: database is locked'); },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => { throw new Error('SQLITE_BUSY: database is locked'); },
      DB_PATH: '/tmp/test.db',
    }));
    const { checkCompanyBranding } = await loadChecks();
    const result = checkCompanyBranding();
    expect(result.indeterminate).toBe(true);
    expect(result.detail).toMatch(/SQLITE_BUSY|transient/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DATABASE_PATH CHECKS (truth-table rows 20-22)
// ────────────────────────────────────────────────────────────────────────────

describe('database_path', () => {
  // Row 20: DATABASE_PATH set and absolute → PASS
  it('row 20: DATABASE_PATH set to absolute writable path → pass=true', async () => {
    const saved = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path.join(tmpDir, 'mission-control.db');
    const { checkDatabasePath } = await loadChecks();
    const result = checkDatabasePath();
    expect(result.pass).toBe(true);
    if (saved !== undefined) process.env.DATABASE_PATH = saved;
    else delete process.env.DATABASE_PATH;
  });

  // Row 21: DATABASE_PATH unset → PASS
  it('row 21: DATABASE_PATH unset → pass=true (default path valid)', async () => {
    const saved = process.env.DATABASE_PATH;
    delete process.env.DATABASE_PATH;
    const { checkDatabasePath } = await loadChecks();
    const result = checkDatabasePath();
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/default/i);
    if (saved !== undefined) process.env.DATABASE_PATH = saved;
  });

  // Row 22: DATABASE_PATH dir does not exist → FAIL
  it('row 22: DATABASE_PATH dir does not exist → pass=false', async () => {
    const saved = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = '/nonexistent/deep/path/mission-control.db';
    const { checkDatabasePath } = await loadChecks();
    const result = checkDatabasePath();
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/does not exist/i);
    if (saved !== undefined) process.env.DATABASE_PATH = saved;
    else delete process.env.DATABASE_PATH;
  });

  // Extra: relative DATABASE_PATH → FAIL
  it('relative DATABASE_PATH → pass=false', async () => {
    const saved = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = 'relative/path/mission-control.db';
    const { checkDatabasePath } = await loadChecks();
    const result = checkDatabasePath();
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/not an absolute path/i);
    if (saved !== undefined) process.env.DATABASE_PATH = saved;
    else delete process.env.DATABASE_PATH;
  });
});

// ────────────────────────────────────────────────────────────────────────────
// MIGRATIONS CHECKS (truth-table rows 29-30)
// ────────────────────────────────────────────────────────────────────────────

describe('migrations', () => {
  // Row 29: all migrations applied → PASS
  it('row 29: all migrations applied → pass=true', async () => {
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({}),
      getMigrationStatus: () => ({ applied: ['001', '002', '003'], pending: [] }),
      DB_PATH: path.join(tmpDir, 'test.db'),
    }));
    const { checkMigrations } = await loadChecks();
    const result = checkMigrations();
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/OK/);
  });

  // Row 30: pending migrations → FAIL
  it('row 30: pending migrations → pass=false', async () => {
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({}),
      getMigrationStatus: () => ({ applied: ['001', '002'], pending: ['003', '004'] }),
      DB_PATH: path.join(tmpDir, 'test.db'),
    }));
    const { checkMigrations } = await loadChecks();
    const result = checkMigrations();
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/pending/i);
    expect((result as { pending_count?: number }).pending_count).toBe(2);
  });

  // Row 28 (migrations): DB locked → indeterminate
  it('row 28 (migrations): DB locked → indeterminate=true', async () => {
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({}),
      getMigrationStatus: () => { throw new Error('SQLITE_BUSY: database is locked'); },
      DB_PATH: path.join(tmpDir, 'test.db'),
    }));
    const { checkMigrations } = await loadChecks();
    const result = checkMigrations();
    expect(result.indeterminate).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DISK HEADROOM CHECKS (truth-table rows 23-24)
// ────────────────────────────────────────────────────────────────────────────

describe('disk_headroom', () => {
  // Row 23: >= 500 MB free → PASS
  // FIXED: mock _readDiskFreeBytes directly so statfsSync's real syscall is bypassed
  it('row 23: >= 500 MB free → pass=true', async () => {
    const checks = await loadChecks();
    checks.diskReader.readFreeBytes = () => 10 * 1024 ** 3; // 10 GB
    const result = await checks.checkDiskHeadroom();
    expect(result.pass).toBe(true);
  });

  // Row 24: < 500 MB free → FAIL
  it('row 24: < 500 MB free → pass=false', async () => {
    const checks = await loadChecks();
    checks.diskReader.readFreeBytes = () => 100 * 1024 * 1024; // 100 MB
    const result = await checks.checkDiskHeadroom();
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/below/i);
  });

  // Row 35: wrong-mount false-green — /data exists on a SEPARATE high-capacity
  // filesystem; the CC app runs from process.cwd() on a LOW-space partition.
  //
  // The Sheila-class false-green: a previous Docker install left an empty /data
  // directory on the root filesystem (root has 80 GB free). The CC app is
  // installed at ~/blackceo-command-center on a separate /home partition with
  // only 300 MB free. An old _resolve_disk_path() heuristic that picks /data
  // when the directory exists would probe df /data = 80 GB → false PASS.
  //
  // The guard in deep-checks.ts: checkPath resolves from DATABASE_PATH dir or
  // process.cwd() — NEVER from /data presence alone. This test proves the guard
  // holds: even when the mock returns abundant space for the /data path, the
  // check probes process.cwd() (tmpDir, mocked to 300 MB) and returns FAIL.
  //
  // Implementation: diskReader.readFreeBytes is called with the resolved
  // checkPath. We mock it to distinguish the two paths:
  //   - any path that IS process.cwd() (tmpDir) → 300 MB (low space, CC partition)
  //   - any path that is /data or contains /data  → 80 GB (abundant, wrong mount)
  // Because checkDiskHeadroom() resolves checkPath from process.cwd() (since no
  // DATABASE_PATH is set in this test), it always calls readFreeBytes(tmpDir).
  // The /data branch in the mock is never called → FAIL is returned.
  it('row 35: /data exists with abundant space but CC cwd has <500 MB → pass=false (wrong-mount guard)', async () => {
    const checks = await loadChecks();
    // Mock returns disk space depending on which path is probed.
    // The check MUST probe process.cwd() (tmpDir), not /data.
    checks.diskReader.readFreeBytes = (checkPath: string): number => {
      if (checkPath.startsWith('/data') || checkPath === '/data') {
        // Abundant space on the /data mount (the wrong mount that the old
        // heuristic would have picked) — 80 GB.
        return 80 * 1024 ** 3;
      }
      // process.cwd() = tmpDir = the CC app partition — only 300 MB free.
      // This is below the 500 MB threshold.
      return 300 * 1024 * 1024;
    };

    // No DATABASE_PATH set → checkPath resolves to process.cwd() (tmpDir).
    // process.cwd() is mocked to tmpDir in beforeEach.
    const saved = process.env.DATABASE_PATH;
    delete process.env.DATABASE_PATH;

    const result = await checks.checkDiskHeadroom();

    if (saved !== undefined) process.env.DATABASE_PATH = saved;

    // Must FAIL: 300 MB < 500 MB threshold.
    // If the check probed /data instead of process.cwd(), it would see 80 GB → PASS.
    // A PASS here means the wrong-mount guard is broken.
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/below/i);
    // Confirm the check path is NOT /data — it must be process.cwd() (tmpDir).
    expect((result as { path?: string }).path).not.toMatch(/^\/data/);
  });

  // Row 35 variant: DATABASE_PATH is set to a path under /home (the correct
  // CC partition, 300 MB free) while /data has 80 GB. The check must probe
  // DATABASE_PATH's directory (the CC partition) and return FAIL.
  it('row 35 variant: DATABASE_PATH set to CC partition path, /data has more space → check probes DATABASE_PATH dir → pass=false', async () => {
    const checks = await loadChecks();
    checks.diskReader.readFreeBytes = (checkPath: string): number => {
      if (checkPath.startsWith('/data') || checkPath === '/data') {
        return 80 * 1024 ** 3; // /data: 80 GB (wrong mount)
      }
      return 300 * 1024 * 1024; // DATABASE_PATH dir (CC partition): 300 MB
    };

    const saved = process.env.DATABASE_PATH;
    // Set DATABASE_PATH to a path under tmpDir (the CC partition, not /data).
    process.env.DATABASE_PATH = path.join(tmpDir, 'mission-control.db');

    const result = await checks.checkDiskHeadroom();

    if (saved !== undefined) process.env.DATABASE_PATH = saved;
    else delete process.env.DATABASE_PATH;

    // Must FAIL: DATABASE_PATH dir (tmpDir) has 300 MB < 500 MB threshold.
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/below/i);
    // The check path must be tmpDir (DATABASE_PATH dir), never /data.
    expect((result as { path?: string }).path).toBe(tmpDir);
    expect((result as { path?: string }).path).not.toMatch(/^\/data/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// HTML TITLE CHECKS (truth-table rows 8-9)
// ────────────────────────────────────────────────────────────────────────────

describe('html_title', () => {
  function writeServerHtml(dir: string, title: string): void {
    const serverDir = path.join(dir, '.next', 'server', 'pages');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, 'index.html'),
      `<!DOCTYPE html><html><head><title>${title}</title></head><body></body></html>`
    );
  }

  // Row 8: HTML title contains client brand name → PASS
  it('row 8: branded HTML title → pass=true', async () => {
    writeServerHtml(tmpDir, 'Karen Vaughn Enterprises');
    const { checkHtmlTitle } = await loadChecks();
    const result = checkHtmlTitle();
    expect(result.pass).toBe(true);
    expect((result as { title?: string }).title).toBe('Karen Vaughn Enterprises');
    expect(result.detail).toMatch(/row 8.*PASS|PASS.*row 8/i);
  });

  // Row 9: HTML title is "Command Center" → FAIL
  it('row 9: generic placeholder title "Command Center" → pass=false', async () => {
    writeServerHtml(tmpDir, 'Command Center');
    const { checkHtmlTitle } = await loadChecks();
    const result = checkHtmlTitle();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/placeholder|unbranded|row 9/i);
  });

  it('row 9 variant: generic title "BlackCEO Command Center" → pass=false', async () => {
    writeServerHtml(tmpDir, 'BlackCEO Command Center');
    const { checkHtmlTitle } = await loadChecks();
    const result = checkHtmlTitle();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
  });

  it('row 9 variant: empty title → pass=false', async () => {
    writeServerHtml(tmpDir, '');
    const { checkHtmlTitle } = await loadChecks();
    const result = checkHtmlTitle();
    expect(result.pass).toBe(false);
  });

  // No pre-rendered HTML → indeterminate (not FAIL; live server may have branded title)
  it('no pre-rendered HTML → indeterminate=true (not FAIL)', async () => {
    const { checkHtmlTitle } = await loadChecks();
    const result = checkHtmlTitle();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEXT_PUBLIC_APP_URL CHECKS (truth-table rows 31-32)
// ────────────────────────────────────────────────────────────────────────────

describe('next_public_app_url', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.CC_PUBLIC_URL;
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.CC_PUBLIC_URL;
  });

  // Row 31: NEXT_PUBLIC_APP_URL set and consistent → PASS
  it('row 31: NEXT_PUBLIC_APP_URL set to valid absolute URL → pass=true', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://karen.zerohumanworkforce.com';
    const { checkNextPublicAppUrl } = await loadChecks();
    const result = checkNextPublicAppUrl();
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/row 31.*PASS|PASS.*row 31/i);
  });

  // Row 31 variant: unset → PASS (relative URLs OK for localhost)
  it('row 31 variant: NEXT_PUBLIC_APP_URL unset → pass=true (relative URLs acceptable)', async () => {
    const { checkNextPublicAppUrl } = await loadChecks();
    const result = checkNextPublicAppUrl();
    expect(result.pass).toBe(true);
  });

  // Row 32: NEXT_PUBLIC_APP_URL set to localhost but CC_PUBLIC_URL is a real domain → FAIL
  it('row 32: NEXT_PUBLIC_APP_URL=localhost but CC_PUBLIC_URL is remote domain → pass=false', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:4000';
    process.env.CC_PUBLIC_URL = 'https://karen.zerohumanworkforce.com';
    const { checkNextPublicAppUrl } = await loadChecks();
    const result = checkNextPublicAppUrl();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/mismatch|row 32|localhost/i);
  });

  // Row 32 variant: invalid URL → FAIL
  it('row 32 variant: NEXT_PUBLIC_APP_URL is not a valid URL → pass=false', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'not-a-url';
    const { checkNextPublicAppUrl } = await loadChecks();
    const result = checkNextPublicAppUrl();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/not a valid|row 32/i);
  });

  // Row 31 happy path: localhost both sides (consistent)
  it('row 31 variant: NEXT_PUBLIC_APP_URL=localhost + CC_PUBLIC_URL=localhost → pass=true', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:4000';
    process.env.CC_PUBLIC_URL = 'http://localhost:4000';
    const { checkNextPublicAppUrl } = await loadChecks();
    const result = checkNextPublicAppUrl();
    expect(result.pass).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// OVERALL ENDPOINT SHAPE
// ────────────────────────────────────────────────────────────────────────────

describe('GET /api/health/deep — response shape', () => {
  it('response always includes pass, indeterminate, timestamp, and checks object', async () => {
    makeNextBuild(tmpDir);
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: (sql: string) => ({
          get: () => {
            if (sql.includes('sqlite_master')) return { name: 'companies' };
            if (sql.includes('SELECT name FROM companies')) return { name: 'Test Corp' };
            return undefined;
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: ['001'], pending: [] }),
      DB_PATH: path.join(tmpDir, 'test.db'),
    }));

    // Inject disk mock before loading route
    const checks = await loadChecks();
    checks.diskReader.readFreeBytes = () => 20 * 1024 ** 3;

    vi.resetModules();
    const mod = await import('../../src/app/api/health/deep/route.js') as {
      GET?: () => Promise<Response>;
    };
    if (!mod.GET) return;

    const response = await mod.GET();
    const body = await response.json() as Record<string, unknown>;

    expect(body).toHaveProperty('pass');
    expect(body).toHaveProperty('indeterminate');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('checks');
    expect(typeof body.pass).toBe('boolean');
    expect(typeof body.indeterminate).toBe('boolean');
    expect(typeof body.timestamp).toBe('string');
    expect(typeof body.checks).toBe('object');
  });

  it('indeterminate=true when any check is UNKNOWN — overall pass stays false', async () => {
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: () => ({
          get: () => { throw new Error('SQLITE_BUSY: database is locked'); },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => { throw new Error('SQLITE_BUSY: database is locked'); },
      DB_PATH: path.join(tmpDir, 'test.db'),
    }));
    makeNextBuild(tmpDir);

    const checks = await loadChecks();
    checks.diskReader.readFreeBytes = () => 20 * 1024 ** 3;

    vi.resetModules();
    const mod = await import('../../src/app/api/health/deep/route.js') as {
      GET?: () => Promise<Response>;
    };
    if (!mod.GET) return;

    const response = await mod.GET();
    const body = await response.json() as Record<string, unknown>;
    expect(body.indeterminate).toBe(true);
    expect(body.pass).toBe(false);
  });
});
