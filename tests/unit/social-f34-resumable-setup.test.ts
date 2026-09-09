/**
 * social-f34-resumable-setup.test.ts — F34 acceptance (CC half).
 *
 * "A clean Mac or Docker install provisions a distinct client planner and
 * working intake URL. A crash after Google creates the file reuses it.
 * 'Ready' is shown only after the service, schema, schedule and links have
 * verified receipts."
 *
 * CC-side proof (the ONB social_bootstrap.py state machine is the owner; this
 * test proves the CC contract surface the bootstrap persists into):
 *   1. Distinct companies -> DISTINCT registry rows (unique(company_id,
 *      planner_kind) — a second company NEVER shares the sheet row).
 *   2. Re-registration of the SAME company+kind REPLACES the row (adopt,
 *      never duplicate).
 *   3. The engine-ownership claim is idempotent and demotes legacy owners —
 *      ONE schedule per company (F17 handover for bootstrap step 4).
 *   4. Health view integration: a box with no registered sheet reports
 *      unregistered (setup NOT complete), and after the registry row is
 *      written the view flips ok — "ready" follows receipts, not claims.
 *   5. Sharing drift (named-user-only) is surfaced as registry_drift — the
 *      F02 anyone/writer contract is never silently migrated away.
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/social-f34-resumable-setup.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, getDb, queryOne, run, timeNow } from '../../src/lib/db';
import {
  claimEngineOwnership,
  isEngineOwner,
  verifyEngineOwnership,
} from '../../src/lib/jobs/social-cycle';
import { serviceHealthReport } from '../../src/lib/health/service-health';

getDb();

function ensureRegistry() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS social_sheet_registry (
    company_id TEXT NOT NULL,
    planner_kind TEXT NOT NULL,
    sheet_id TEXT NOT NULL,
    sheet_url TEXT,
    schema_version TEXT,
    sharing TEXT,
    verified_at TEXT,
    PRIMARY KEY (company_id, planner_kind)
  )`);
}

/** The bootstrap step-3 persistence shape (sheet_registry.json contract). */
function registerSheet(companyId: string, sheetId: string, kind = 'social-planner',
                       sharing = 'anyone,writer', schemaVersion = '1.1.0') {
  ensureRegistry();
  run(
    `INSERT INTO social_sheet_registry (company_id, planner_kind, sheet_id, sheet_url, schema_version, sharing, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (company_id, planner_kind) DO UPDATE SET
       sheet_id = excluded.sheet_id, sheet_url = excluded.sheet_url,
       schema_version = excluded.schema_version, sharing = excluded.sharing,
       verified_at = excluded.verified_at`,
    [companyId, kind, sheetId,
     `https://docs.google.com/spreadsheets/d/${sheetId}`, schemaVersion, sharing, timeNow()],
  );
}

const db = () => getDb();

function cleanSocialTables() {
  for (const t of ['social_sheet_registry', 'social_engine_ownership', 'social_cycles']) {
    try { db().exec(`DELETE FROM ${t}`); } catch { /* fresh */ }
  }
}

test('1. distinct companies get DISTINCT registry rows — never a shared planner', () => {
  cleanSocialTables();
  registerSheet('company-f34-a', 'SHEET-A');
  registerSheet('company-f34-b', 'SHEET-B');
  const a = queryOne(`SELECT sheet_id FROM social_sheet_registry WHERE company_id = 'company-f34-a'`);
  const b = queryOne(`SELECT sheet_id FROM social_sheet_registry WHERE company_id = 'company-f34-b'`);
  assert.equal(a.sheet_id, 'SHEET-A');
  assert.equal(b.sheet_id, 'SHEET-B');
  assert.notEqual(a.sheet_id, b.sheet_id);
  assert.equal(
    (db().prepare('SELECT COUNT(*) AS n FROM social_sheet_registry').get() as { n: number }).n, 2,
  );
});

test('2. re-registration of the SAME company+kind REPLACES the row (adopt, never duplicate)', () => {
  cleanSocialTables();
  registerSheet('company-f34-a', 'SHEET-A1');
  registerSheet('company-f34-a', 'SHEET-A2'); // crash-resume re-adopts
  const row = queryOne(`SELECT sheet_id FROM social_sheet_registry WHERE company_id = 'company-f34-a'`);
  assert.equal(row.sheet_id, 'SHEET-A2');
  assert.equal(
    (db().prepare('SELECT COUNT(*) AS n FROM social_sheet_registry').get() as { n: number }).n, 1,
  );
});

test('3. engine-ownership claim: idempotent, demotes legacy, ONE active schedule per company', () => {
  cleanSocialTables();
  // Legacy row armed first (the forwarding-adapter era).
  run(
    `INSERT INTO social_engine_ownership (id, company_id, engine, scheduler_name, scheduler_expr, state, verified_at)
     VALUES ('legacy-f34', 'company-f34-a', 'skill35-weekly-theme', 'gateway-cron', '0 8 * * 6', 'active', ?)`,
    [timeNow()],
  );
  const first = claimEngineOwnership('company-f34-a', new Date(Date.now() + 300_000).toISOString());
  assert.equal(first.claimed, true);
  assert.equal(isEngineOwner('company-f34-a'), true, 'durable engine is the owner after claim');
  // Re-claim is idempotent (same owner row).
  const second = claimEngineOwnership('company-f34-a', new Date(Date.now() + 300_000).toISOString());
  assert.equal(second.ownerRow, first.ownerRow);
  // Exactly one ACTIVE row for the company; legacy superseded.
  const active = db().prepare(
    `SELECT COUNT(*) AS n FROM social_engine_ownership WHERE company_id = ? AND state = 'active'`,
  ).get('company-f34-a') as { n: number };
  assert.equal(active.n, 1);
  const legacyState = db().prepare(
    `SELECT state FROM social_engine_ownership WHERE id = 'legacy-f34'`,
  ).get() as { state: string };
  assert.equal(legacyState.state, 'superseded', 'legacy trigger must be superseded once the durable engine owns the schedule');
  const verify = verifyEngineOwnership();
  assert.equal(verify.ok, true);
});

test('4. health integration: unregistered sheet -> setup NOT complete; after the registry receipt -> ok', () => {
  cleanSocialTables();
  const before = serviceHealthReport();
  assert.equal(before.checks.sheet_registry.state, 'unregistered', 'ready is NEVER shown before the setup receipts exist');
  registerSheet('company-f34-a', 'SHEET-A');
  const after = serviceHealthReport();
  assert.equal(after.checks.sheet_registry.ok, true, 'registry receipt flips the check ok');
});

test('5. sharing drift surfaced: named-user-only sharing is registry_drift, never silent (F02)', () => {
  cleanSocialTables();
  registerSheet('company-f34-a', 'SHEET-A', 'social-planner', 'named-users-only');
  const report = serviceHealthReport();
  assert.equal(report.checks.sheet_registry.ok, false);
  assert.equal(report.checks.sheet_registry.state, 'registry_drift');
});

test('6. schema drift surfaced: a non-1.1.0 schema_version is a stale contract (F15)', () => {
  cleanSocialTables();
  registerSheet('company-f34-a', 'SHEET-A', 'social-planner', 'anyone,writer', '1.0.0');
  const report = serviceHealthReport();
  assert.equal(report.checks.sheet_registry.state, 'registry_drift');
});

test('cleanup', () => {
  closeDb();
});