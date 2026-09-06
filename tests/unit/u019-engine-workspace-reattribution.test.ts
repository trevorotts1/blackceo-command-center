/** Engine ownership regression: client-owned rows survive every converge;
 * existing system/default queues remain byte-identical. Real migrated DB. */
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
test('existing system engines remain default and new marketing belongs to the client', () => {
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
test('client-bound engine ownership survives repeated convergence and migrations', () => {
  const db = getDb();
  // Simulate a safely bound client engine, with its existing agent references.
  db.prepare(`UPDATE workspaces SET company_id = 'realco-id' WHERE slug = 'podcast'`).run();
  assert.equal(companyOf('podcast'), 'realco-id', 'precondition: podcast belongs to this client');

  reseedWorkspacesFromConfig(getDb(), { force: true });

  reseedWorkspacesFromConfig(getDb(), { force: true });
  assert.equal(
    companyOf('podcast'),
    'realco-id',
    'converge must never erase a client binding',
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

test('custom system engine row remains byte-identical across convergence', () => {
  const db = getDb();
  db.prepare("UPDATE workspaces SET name='System Anthology Queue', icon='S', sort_order=77 WHERE id='anthology'").run();
  const before = db.prepare("SELECT * FROM workspaces WHERE id='anthology'").get();
  reseedWorkspacesFromConfig(db, { force: true });
  reseedWorkspacesFromConfig(db, { force: true });
  assert.deepEqual(db.prepare("SELECT * FROM workspaces WHERE id='anthology'").get(), before);
});

test('new engine department uses active company instead of default', () => {
  const db = getDb();
  // A unique manifest engine spelling with no old shared queue: deleting an
  // isolated fixture's unused anthology rows models a missing engine.
  db.prepare("DELETE FROM agent_skills WHERE agent_id IN (SELECT id FROM agents WHERE workspace_id='anthology')").run();
  db.prepare("UPDATE workspaces SET head_agent_id=NULL WHERE id='anthology'").run();
  db.prepare("DELETE FROM agents WHERE workspace_id='anthology'").run();
  db.prepare("DELETE FROM workspaces WHERE id='anthology'").run();
  reseedWorkspacesFromConfig(db, { force: true });
  assert.equal(companyOf('anthology'), 'realco-id');
});
