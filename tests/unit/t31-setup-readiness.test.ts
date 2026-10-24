/**
 * T-31 — setup readiness must be computed, never asserted.
 *
 * The failure this file exists to prevent: a readiness screen that shows green
 * because a variable is set. Every test below drives a real (throwaway) SQLite
 * file, and the assertions are about the STATE the probe produced and the
 * EVIDENCE that produced it — not about a configuration value.
 *
 * Pinned here:
 *   • READY only with evidence (a stored row, a statement that ran).
 *   • BLOCKED always carries a reason.
 *   • UNKNOWN is its own state and never rolls up to READY.
 *   • An action that cannot succeed is disabled WITH its reason.
 *   • A refused action reports the same reason at run time.
 *   • An enabled action that succeeds flips its item to READY.
 *
 * Run: node --import tsx --test tests/unit/t31-setup-readiness.test.ts
 */
import './_isolated-db'; // MUST be first: never touch a real database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  computeSetupReadiness,
  rollUp,
  runSetupAction,
  type SetupDeps,
} from '../../src/lib/readiness/setup';
import type { ReadinessItemId, ReadinessState } from '../../src/lib/readiness/types';

const FIXTURE_DIR = path.join(
  process.env.CC_TEST_FIXTURE_ROOT ?? os.tmpdir(),
  't31-setup-readiness',
);
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

const created: string[] = [];
process.on('exit', () => {
  for (const file of created) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      /* best effort — never mask the suite result */
    }
  }
});

function fixtureDb(label: string): Database.Database {
  const file = path.join(FIXTURE_DIR, `${label}-${process.pid}-${Date.now()}.db`);
  created.push(file);
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      config TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      description TEXT, icon TEXT, company_id TEXT REFERENCES companies(id),
      sort_order INTEGER DEFAULT 1000, archived_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hq_owner_login_uses (
      nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER NOT NULL
    );
  `);
  return db;
}

function seedReadyBox(db: Database.Database, companyId: string): void {
  db.prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)').run(companyId, 'Box', companyId);
  db.prepare('INSERT INTO workspaces (id, name, slug, company_id) VALUES (?, ?, ?, ?)').run(
    `${companyId}-general`, 'General', `${companyId}-general`, companyId,
  );
  db.prepare('INSERT INTO agents (id, name) VALUES (?, ?)').run('agent-1', 'Agent One');
}

/** Deps wired to a real fixture handle; gateway is a stub so no socket is opened. */
function deps(overrides: Partial<SetupDeps> & { db: Database.Database | null; companyId: string | null }): Partial<SetupDeps> {
  const { db, companyId, ...rest } = overrides;
  return {
    openDb: () => {
      if (!db) throw new Error('database_unavailable');
      return db;
    },
    companyId: () => companyId,
    host: () => 'localhost',
    probeGateway: async () => ({ ok: true, detail: { probe: 'tcp_connect', host: '127.0.0.1', port: 18789 } }),
    now: () => '2026-10-24T00:00:00.000Z',
    ...rest,
  };
}

function itemOf(readiness: Awaited<ReturnType<typeof computeSetupReadiness>>, id: ReadinessItemId) {
  const item = readiness.items.find((candidate) => candidate.id === id);
  assert.ok(item, `expected item ${id}`);
  return item;
}

function actionOf(readiness: Awaited<ReturnType<typeof computeSetupReadiness>>, id: string) {
  const action = readiness.actions.find((candidate) => candidate.id === id);
  assert.ok(action, `expected action ${id}`);
  return action;
}

// Belt and braces: the tenant registry is ambient state, so pin the code path
// this suite exercises (implicit-self on loopback) instead of hoping.
process.env.MC_TENANT_REGISTRY_JSON = '';
delete process.env.MC_INSTALLATION_ID;

test('T-31: a configured company id alone is never READY — the row decides', async () => {
  const db = fixtureDb('no-company');
  try {
    const readiness = await computeSetupReadiness({ deps: deps({ db, companyId: 'acme' }) });
    const item = itemOf(readiness, 'company_record');
    assert.equal(item.state, 'BLOCKED');
    assert.ok(item.reason, 'a blocked item must carry a reason');
    assert.match(item.reason!, /companies row/);
    // The evidence names the query and shows the row was absent.
    assert.match(item.evidence.probe, /SELECT .* FROM companies/);
    assert.equal(item.evidence.observed.row, null);
    assert.notEqual(readiness.overall, 'READY');
  } finally {
    db.close();
  }
});

test('T-31: a stored record makes the item READY and the evidence carries it', async () => {
  const db = fixtureDb('with-company');
  try {
    seedReadyBox(db, 'acme');
    const readiness = await computeSetupReadiness({ deps: deps({ db, companyId: 'acme' }) });

    const company = itemOf(readiness, 'company_record');
    assert.equal(company.state, 'READY');
    assert.deepEqual(company.evidence.observed.row, { id: 'acme', name: 'Box', slug: 'acme' });

    const workspace = itemOf(readiness, 'company_workspace');
    assert.equal(workspace.state, 'READY');
    assert.deepEqual(workspace.evidence.observed.activeWorkspaces, ['acme-general']);

    const roster = itemOf(readiness, 'agent_roster');
    assert.equal(roster.state, 'READY');
    assert.equal(roster.evidence.observed.agents, 1);

    // No identity at all → UNKNOWN, not BLOCKED and never READY.
    const unidentified = await computeSetupReadiness({ deps: deps({ db, companyId: null }) });
    const unknownCompany = itemOf(unidentified, 'company_record');
    assert.equal(unknownCompany.state, 'UNKNOWN');
    assert.equal(unknownCompany.reason, undefined);
    assert.notEqual(unidentified.overall, 'READY');
  } finally {
    db.close();
  }
});

test('T-31: pending migrations BLOCK schema with a reason and enable the action', async () => {
  const db = fixtureDb('pending-migrations');
  try {
    // Every real migration is pending against an empty ledger.
    const readiness = await computeSetupReadiness({ deps: deps({ db, companyId: 'acme' }) });
    const schema = itemOf(readiness, 'schema_migrations');
    assert.equal(schema.state, 'BLOCKED');
    assert.match(schema.reason!, /pending migration/);
    assert.ok(Array.isArray(schema.evidence.observed.pending));
    assert.ok((schema.evidence.observed.pending as string[]).length > 0);

    assert.equal(actionOf(readiness, 'apply_pending_migrations').enabled, true);
  } finally {
    db.close();
  }
});

test('T-31: an action that cannot succeed is disabled and says why', async () => {
  const db = fixtureDb('disabled-action');
  try {
    const readiness = await computeSetupReadiness({ deps: deps({ db, companyId: null }) });
    const action = actionOf(readiness, 'create_company_record');
    assert.equal(action.enabled, false);
    assert.equal(action.disabledReason, 'company_identity_unset');

    // Workspace creation cannot precede the company record.
    const withIdentity = await computeSetupReadiness({ deps: deps({ db, companyId: 'acme' }) });
    const workspaceAction = actionOf(withIdentity, 'create_default_workspace');
    assert.equal(workspaceAction.enabled, false);
    assert.equal(workspaceAction.disabledReason, 'company_record_not_ready');

    // Running a disabled action refuses with the SAME reason rather than
    // half-doing the work.
    const refused = await runSetupAction('create_company_record', {
      deps: deps({ db, companyId: null }),
    });
    assert.equal(refused.applied, false);
    assert.equal(refused.detail, 'company_identity_unset');
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n,
      0,
      'a refused action must not write',
    );
  } finally {
    db.close();
  }
});

test('T-31: an enabled action that succeeds flips the item to READY', async () => {
  const db = fixtureDb('flip');
  try {
    const options = { deps: deps({ db, companyId: 'acme' }) };
    const before = await computeSetupReadiness(options);
    assert.equal(itemOf(before, 'company_record').state, 'BLOCKED');
    assert.equal(actionOf(before, 'create_company_record').enabled, true);

    const result = await runSetupAction('create_company_record', options);
    assert.equal(result.applied, true, result.detail);

    const after = await computeSetupReadiness(options);
    assert.equal(itemOf(after, 'company_record').state, 'READY');
    assert.deepEqual(itemOf(after, 'company_record').evidence.observed.row, {
      id: 'acme', name: 'acme', slug: 'acme',
    });

    // And the now-unblocked workspace action can run.
    assert.equal(actionOf(after, 'create_default_workspace').enabled, true);
    const workspace = await runSetupAction('create_default_workspace', options);
    assert.equal(workspace.applied, true, workspace.detail);
    const final = await computeSetupReadiness(options);
    assert.equal(itemOf(final, 'company_workspace').state, 'READY');
  } finally {
    db.close();
  }
});

test('T-31: UNKNOWN is its own state and never rounds up to READY', async () => {
  // Roll-up arithmetic, pinned directly.
  const pairs: Array<[ReadinessState[], ReadinessState]> = [
    [[], 'READY'],
    [['READY', 'READY'], 'READY'],
    [['READY', 'UNKNOWN'], 'UNKNOWN'],
    [['UNKNOWN', 'UNKNOWN'], 'UNKNOWN'],
    [['UNKNOWN', 'BLOCKED'], 'BLOCKED'],
    [['READY', 'BLOCKED'], 'BLOCKED'],
  ];
  for (const [states, expected] of pairs) {
    assert.equal(rollUp(states), expected, `${states.join('+')} must roll up to ${expected}`);
  }

  // A dead database makes the dependent items UNKNOWN — not BLOCKED (we cannot
  // prove a fault either) and never READY.
  const readiness = await computeSetupReadiness({ deps: deps({ db: null, companyId: 'acme' }) });
  assert.equal(itemOf(readiness, 'database').state, 'BLOCKED');
  assert.match(itemOf(readiness, 'database').reason!, /database_unavailable/);
  for (const id of ['schema_migrations', 'dispatch_schema', 'company_record', 'company_workspace', 'agent_roster'] as const) {
    const item = itemOf(readiness, id);
    assert.equal(item.state, 'UNKNOWN', `${id} must be UNKNOWN when the database cannot be read`);
    assert.equal(item.evidence.observed.skipped, 'database_unavailable');
  }
  assert.notEqual(readiness.overall, 'READY');
});

test('T-31: a gateway that refuses a connection is BLOCKED, and its action is disabled', async () => {
  const db = fixtureDb('gateway');
  try {
    const readiness = await computeSetupReadiness({
      deps: deps({
        db,
        companyId: 'acme',
        probeGateway: async () => ({
          ok: false,
          detail: { probe: 'tcp_connect', host: '127.0.0.1', port: 18789, error: 'ECONNREFUSED' },
        }),
      }),
    });
    const gateway = itemOf(readiness, 'openclaw_gateway');
    assert.equal(gateway.state, 'BLOCKED');
    assert.equal(gateway.evidence.observed.error, 'ECONNREFUSED');
    assert.equal(gateway.evidence.probe, 'tcp_connect(OPENCLAW_GATEWAY_URL)');

    const sync = actionOf(readiness, 'sync_agent_roster');
    assert.equal(sync.enabled, false);
    assert.equal(sync.disabledReason, 'gateway_unreachable');
  } finally {
    db.close();
  }
});

test('T-31: every item carries the probe that decided it', async () => {
  const db = fixtureDb('evidence');
  try {
    seedReadyBox(db, 'acme');
    const readiness = await computeSetupReadiness({ deps: deps({ db, companyId: 'acme' }) });
    assert.ok(readiness.items.length >= 8);
    for (const item of readiness.items) {
      assert.ok(item.evidence.probe.length > 0, `${item.id} must name its probe`);
      assert.ok(item.evidence.at.length > 0, `${item.id} must timestamp its evidence`);
      assert.ok(item.evidence.observed && typeof item.evidence.observed === 'object');
      if (item.state === 'BLOCKED') assert.ok(item.reason, `${item.id} blocked without a reason`);
      if (item.state !== 'BLOCKED') assert.equal(item.reason, undefined, `${item.id} has a stale reason`);
    }
  } finally {
    db.close();
  }
});
