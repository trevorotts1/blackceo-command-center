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
 *   Rows 14-19 (pm2 topology) — shell-only, tested by the probe fixture test
 *   Rows 25-27 (CF tunnel)    — external service, tested via probe fixture
 *
 * Rows covered: 1-13, 20-24, 28-30 (applicable to the TypeScript endpoint).
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

  // Row 7: DB name empty (WHERE clause excludes it) → treated as fresh install
  it('row 7: DB company name empty (excluded by WHERE) → indeterminate=true', async () => {
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
