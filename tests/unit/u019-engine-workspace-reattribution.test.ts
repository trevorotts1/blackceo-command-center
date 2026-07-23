/**
 * U019 — Company re-attribution engine workspace fix.
 *
 * The podcast + anthology workspaces are fleet-shared PRODUCER ENGINES, not
 * per-client departments. reseedWorkspacesFromConfig's UPSERT used to stamp
 * every NEW workspace with the resolved ACTIVE company's id, so on a
 * multi-client box a converge would attribute the shared podcast/anthology
 * engines to whichever client was active — and boardWhereClause() then hid them
 * from every OTHER client on the same box.
 *
 * The fix: engine slugs (podcast/anthology) ALWAYS carry company_id='default' —
 * both on the NEW-row INSERT and, as a self-heal, on the ON CONFLICT branch
 * (independent of the U017 migration). Non-engine workspaces still re-attribute
 * to the active company normally.
 *
 * Proves:
 *   1. A fresh converge with an active company set seeds podcast + anthology
 *      with company_id='default' (excluded from re-attribution).
 *   2. A non-engine workspace (marketing) IS re-attributed to the active company.
 *   3. A legacy-misattributed engine row (company_id=realco) is HEALED back to
 *      'default' on the next converge (the ON CONFLICT self-heal).
 *   4. A non-engine row's company_id is NEVER overwritten on conflict (the
 *      pre-existing attribution-wipe guard is preserved).
 *
 * Node built-in test runner under tsx (`npm run test:unit`). DB-backed, isolated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point HOME at a fresh, empty temp dir BEFORE any import so the test never
// depends on — or is polluted by — real company data on the machine running it.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-u019-home-'));
process.env.HOME = TMP_HOME;
delete process.env.MASTER_FILES_DIR;
delete process.env.BLACKCEO_COMMAND_CENTER_ROOT;
delete process.env.COMPANY_SLUG;
delete process.env.COMPANY_NAME;

// Controlled departments.json: two engine slugs + one ordinary department.
// ZERO_HUMAN_COMPANY_DIR is the FIRST candidate resolveDepartmentsConfigPath
// probes, so this short-circuits all TCC-gated discovery and makes the seed set
// deterministic across machines.
const COMPANY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-u019-company-'));
fs.writeFileSync(
  path.join(COMPANY_DIR, 'departments.json'),
  JSON.stringify([
    { id: 'podcast', slug: 'podcast', name: 'Podcast', emoji: '🎙️' },
    { id: 'anthology', slug: 'anthology', name: 'Anthology', emoji: '📚' },
    { id: 'marketing', slug: 'marketing', name: 'Marketing', emoji: '📣' },
  ]),
);
process.env.ZERO_HUMAN_COMPANY_DIR = COMPANY_DIR;

// Isolated test DB.
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'cc-u019-db-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.DISABLE_QC_AUTO_SCORER = 'true';
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;

type DbModule = typeof import('../../src/lib/db');
type MigrationsModule = typeof import('../../src/lib/db/migrations');

let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];
let reseedWorkspacesFromConfig: MigrationsModule['reseedWorkspacesFromConfig'];

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  closeDb = db.closeDb;
  const migrations = await import('../../src/lib/db/migrations');
  reseedWorkspacesFromConfig = migrations.reseedWorkspacesFromConfig;
  // Run the full migration chain once on a fresh DB (creates the schema).
  getDb();
});

test.after(() => {
  try {
    closeDb();
  } catch {
    /* ignore */
  }
});

// Seed the 'default' sentinel + a REAL active company so resolveSeedingCompanyId
// resolves to the real one (it skips placeholder slugs like 'default').
function seedCompanies() {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug) VALUES ('default', 'Default', 'default')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug) VALUES ('realco-id', 'RealCo', 'realco')`,
  ).run();
}

function companyOf(slug: string): string | undefined {
  const row = getDb()
    .prepare('SELECT company_id FROM workspaces WHERE slug = ?')
    .get(slug) as { company_id: string } | undefined;
  return row?.company_id;
}

// ── 1 + 2. Fresh converge: engines -> 'default', non-engine -> active company ──
test('1+2 — converge seeds podcast/anthology as default but marketing as the active company', () => {
  seedCompanies();
  reseedWorkspacesFromConfig(getDb(), { force: true });

  assert.equal(companyOf('podcast'), 'default', 'podcast engine must be company_id=default');
  assert.equal(companyOf('anthology'), 'default', 'anthology engine must be company_id=default');
  assert.equal(
    companyOf('marketing'),
    'realco-id',
    'a non-engine workspace must be attributed to the active company',
  );
});

// ── 3. ON CONFLICT self-heal: a misattributed engine row is forced to default ──
test('3 — a legacy-misattributed engine row is healed back to default on the next converge', () => {
  const db = getDb();
  // Simulate the pre-fix damage: podcast got re-attributed to the active client.
  db.prepare(`UPDATE workspaces SET company_id = 'realco-id' WHERE slug = 'podcast'`).run();
  assert.equal(companyOf('podcast'), 'realco-id', 'precondition: podcast is misattributed');

  reseedWorkspacesFromConfig(getDb(), { force: true });

  assert.equal(
    companyOf('podcast'),
    'default',
    'the ON CONFLICT self-heal must force the engine back to default',
  );
});

// ── 4. Attribution-wipe guard preserved: a non-engine row is NEVER overwritten ──
test('4 — a non-engine workspace company_id is never overwritten on conflict', () => {
  const db = getDb();
  // Manually re-attribute marketing to a different (still-valid) company.
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug) VALUES ('otherco-id', 'OtherCo', 'otherco')`,
  ).run();
  db.prepare(`UPDATE workspaces SET company_id = 'otherco-id' WHERE slug = 'marketing'`).run();
  assert.equal(companyOf('marketing'), 'otherco-id', 'precondition: marketing re-attributed');

  reseedWorkspacesFromConfig(getDb(), { force: true });

  assert.equal(
    companyOf('marketing'),
    'otherco-id',
    'the attribution-wipe guard must keep a non-engine row company_id untouched on conflict',
  );
});
