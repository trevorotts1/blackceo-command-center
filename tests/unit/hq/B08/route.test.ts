/**
 * B08 route boundary (V08) — S8 envelope + S7 authorization refusals.
 *
 * The route body is exercised through `createHqSnapshotRoute` with injected
 * collaborators, so these tests run against the real route code, the REAL
 * `resolveTenantContext`, the REAL isolated database and the frozen `hq_*` DDL
 * stub — and no module this unit does not own. Refusals are asserted BEFORE any
 * read: a refused request must not be able to produce company data.
 */
import '../../_isolated-db';
// Test-only signing secret: the real resolver's documented chain is
// MC_TENANT_SESSION_SECRET → MC_INTERVIEW_COOKIE_SECRET → MC_API_TOKEN (P02 §e.3).
// No real secret is read, printed or reused here.
process.env.MC_TENANT_SESSION_SECRET = 'b08-route-test-secret';
import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import type Database from 'better-sqlite3';
import { getDb, getDbPath } from '../../../../src/lib/db';
import type { HqActivityEvent, HqDepartment } from '../../../../src/lib/hq/types';
import {
  createHqSnapshotRoute,
  hqSnapshotRouteDeps,
  HQ_SNAPSHOT_ASSEMBLY_PATHS,
  type HqRouteDeps,
} from '../../../../src/lib/hq/snapshot-route';
import type { HqSnapshotActivityRow } from '../../../../src/lib/hq/snapshot';

/* ------------------------------------------------------------------ *
 * Fixture (same frozen-S6 stub as snapshot.test.ts; see that file's note)
 * ------------------------------------------------------------------ */

function createHqTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hq_activity (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, company_id TEXT NOT NULL,
      source_key TEXT NOT NULL, content_hash TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT,
      actor_agent_id TEXT, recipient_agent_id TEXT, from_workspace_id TEXT, to_workspace_id TEXT,
      exchange_id TEXT, phase TEXT, payload_json TEXT NOT NULL, occurred_at TEXT,
      received_at TEXT NOT NULL, payload_bytes INTEGER NOT NULL DEFAULT 0,
      UNIQUE(company_id, source_key)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS hq_activity_state (
      company_id TEXT PRIMARY KEY, high_seq INTEGER NOT NULL, pruned_through_seq INTEGER NOT NULL,
      capture_state TEXT NOT NULL, retained_bytes INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    )`);
}

const HOST = 'hq.example.test';
const COMPANY = 'co-route';

function seedCompany(db: Database.Database): void {
  createHqTables(db);
  db.prepare('INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, ?, ?)').run(COMPANY, 'Route Co', 'route-co');
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, slug, company_id) VALUES (?, ?, ?, ?)')
    .run('ws-route', 'Route Dept', 'ws-route', COMPANY);
  db.prepare('INSERT OR IGNORE INTO agents (id, name, role, workspace_id) VALUES (?, ?, ?, ?)')
    .run('agent-route', 'Head', 'head', 'ws-route');
  db.prepare('DELETE FROM hq_activity WHERE company_id = ?').run(COMPANY);
  db.prepare('DELETE FROM hq_activity_state WHERE company_id = ?').run(COMPANY);
  db.prepare(
    `INSERT INTO hq_activity (id, company_id, source_key, content_hash, kind, task_id, actor_agent_id, phase, payload_json, received_at)
     VALUES ('evt-route', ?, 'key-route', 'hash', 'task', 'task-route', 'agent-route', 'created', '{"status":"done","previousStatus":null}', '2026-10-04T00:00:00Z')`,
  ).run(COMPANY);
  db.prepare(
    `INSERT INTO hq_activity_state (company_id, high_seq, pruned_through_seq, capture_state, retained_bytes, updated_at)
     SELECT ?, MAX(seq), 0, 'ok', 0, '2026-10-04T00:00:00Z' FROM hq_activity WHERE company_id = ?`,
  ).run(COMPANY, COMPANY);
}

/** Registers this process's tenant registry for HOST as kind='self' (real resolver path). */
function registerSelfTenant(companyId: string): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [HOST]: { tenantId: 'hq-self', companyId, kind: 'self', installationId: 'install-route' },
  });
}

/** A shared client-host (board proxy) registration — `kind:'client'` requires a clientId. */
function registerClientTenant(companyId: string): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [HOST]: {
      tenantId: 'hq-client', companyId, kind: 'client', clientId: 'client-route', installationId: 'install-route',
    },
  });
}

/** Cookie signed the way `signTenantGrant` does, for the registered host and tenant. */
async function sessionCookie(tenantId = 'hq-self'): Promise<string> {
  const { signTenantGrant } = await import('../../../../src/lib/auth/tenant-context');
  const token = await signTenantGrant({
    purpose: 'session', tenantId, companyId: COMPANY, subject: 'owner:route',
    host: HOST, installationId: 'install-route', exp: Date.now() / 1000 + 3600, nonce: 'b08-route',
  });
  return `mc_tenant_session=${token}`;
}

/** The route resolves collaborators from env so a refusal test needs none. */
function depsFromEnv(): () => Promise<HqRouteDeps> {
  return async () => {
    if (process.env.B08_DEPS === 'missing') return await hqSnapshotRouteDeps();
    const departments: HqDepartment[] = [{
      id: 'ws-route', slug: 'ws-route', name: 'Route Dept', headAgentId: 'agent-route', provisioning: 'ready',
      agents: [{
        id: 'agent-route', workspaceId: 'ws-route', displayName: 'Head', role: 'head', isHead: true,
        staffing: 'permanent', runtimeBound: true, canTalk: true, runtimeAgentId: 'rt-route',
        bindingKind: 'explicit', sharedRoleIds: [], status: 'working', observedAt: null,
        activeTaskIds: ['task-route'],
      }],
    }];
    return {
      loadRoster: async () => ({ departments, masterWorkspaceId: 'ws-route', sortOrder: { 'ws-route': 10 } }),
      buildLayout: async () => ({ revision: 'rev-route', rooms: [] }),
      projectEvent: (row: HqSnapshotActivityRow, resolveLabel: (id: string) => string | null): HqActivityEvent => ({
        id: row.id, seq: row.seq, kind: row.kind, phase: row.phase as HqActivityEvent['phase'],
        taskId: row.task_id ?? null,
        actorLabel: row.actor_agent_id ? resolveLabel(row.actor_agent_id) : null,
        recipientLabel: null, occurredAt: row.occurred_at ?? null, receivedAt: row.received_at,
        reference: row.source_key, payload: { status: 'done', previousStatus: null },
      }),
    };
  };
}

function request(query = '', cookie?: string, host = HOST): NextRequest {
  const headers: Record<string, string> = { host };
  if (cookie) headers.cookie = cookie;
  return new NextRequest(`https://${host}/api/hq/snapshot${query}`, { headers });
}

/* ------------------------------------------------------------------ *
 * Instrument control
 * ------------------------------------------------------------------ */

test('instrument control: the route module and its real auth resolver load, against an isolated DB', () => {
  const path = getDbPath();
  assert.ok(!path.endsWith('mission-control.db'), `refusing live-looking DB: ${path}`);
  assert.equal(typeof createHqSnapshotRoute, 'function');
  console.error(`[B08 route receipt] resolved DATABASE_PATH = ${path}`);
});

/* ------------------------------------------------------------------ *
 * Authorization refusals (must precede any read)
 * ------------------------------------------------------------------ */

test('route: unauthenticated request is refused 401 with the S8 error shape; no company data', async () => {
  registerSelfTenant(COMPANY);
  const route = createHqSnapshotRoute(async () => ({
    loadRoster: async () => { throw new Error('loadRoster must not be called for a refused request'); },
    buildLayout: async () => { throw new Error('buildLayout must not be called'); },
    projectEvent: () => { throw new Error('projectEvent must not be called'); },
  }));
  const response = await route(request('', undefined));
  assert.equal(response.status, 401);
  const body = await response.json() as { error: { code: string; retryable: boolean }; requestId: string };
  assert.equal(body.error.code, 'unauthenticated');
  assert.equal(typeof body.error.message, 'string');
  assert.equal(body.error.retryable, false);
  assert.ok(body.requestId.length > 0);
  assert.equal(JSON.stringify(body).includes(COMPANY), false, 'no company id may leak before authentication');
});

test('route: a client-kind (shared board proxy) host gets 403 hq_direct_origin_required before any read', async () => {
  registerClientTenant(COMPANY);
  const route = createHqSnapshotRoute(async () => {
    throw new Error('collaborators must not be resolved for a foreign-origin request');
  });
  // Authenticate first: the refusal under test is the ORIGIN/kind one, so the
  // session must be valid for the CLIENT registration (its own tenantId).
  const response = await route(request('', await sessionCookie('hq-client')));
  assert.equal(response.status, 403);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, 'hq_direct_origin_required');
});

test('route: an unassembled collaborator set is a NAMED 503, never an empty office', async () => {
  registerSelfTenant(COMPANY);
  process.env.B08_DEPS = 'missing';
  const route = createHqSnapshotRoute(depsFromEnv());
  const response = await route(request('', await sessionCookie()));
  delete process.env.B08_DEPS;
  assert.equal(response.status, 503);
  const body = await response.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'hq_modules_not_assembled');
  for (const path of HQ_SNAPSHOT_ASSEMBLY_PATHS) {
    assert.ok(body.error.message.includes(path.split(' ')[0]), `503 must name ${path}`);
  }
});

/* ------------------------------------------------------------------ *
 * Authorized read
 * ------------------------------------------------------------------ */

test('route: an authorized self-host owner reads only their company snapshot with the S8 envelope', async () => {
  const db = getDb();
  seedCompany(db);
  // A foreign company's row that must never appear.
  db.prepare('INSERT OR IGNORE INTO companies (id, name, slug) VALUES (?, ?, ?)').run('co-foreign', 'Foreign', 'foreign');
  db.prepare(
    `INSERT INTO hq_activity (id, company_id, source_key, content_hash, kind, payload_json, received_at)
     VALUES ('evt-foreign', 'co-foreign', 'key-foreign', 'hash', 'task', '{"status":"x","previousStatus":null}', '2026-10-04T00:00:00Z')`,
  ).run();

  registerSelfTenant(COMPANY);
  const route = createHqSnapshotRoute(depsFromEnv());
  const response = await route(request('?after=0', await sessionCookie()));
  assert.equal(response.status, 200);
  const body = await response.json() as {
    schemaVersion: 1; generatedAt: string; companyId: string; roster: HqDepartment[];
    layout: { revision: string }; layoutRevision: string; captureHealth: { state: string };
    taskLinks: { taskId: string }[]; activities: HqActivityEvent[];
    highSeq: number; prunedThroughSeq: number; feedCursor: number; resetRequired: boolean;
  };
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.companyId, COMPANY);
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));
  assert.equal(body.layoutRevision, 'rev-route');
  assert.equal(body.layout.revision, 'rev-route');
  assert.equal(body.captureHealth.state, 'ok');
  assert.deepEqual(body.taskLinks.map((link) => link.taskId), ['task-route']);
  assert.deepEqual(body.activities.map((event) => event.id), ['evt-route']);
  assert.equal(body.activities[0].actorLabel, 'Head', 'labels resolve inside the authorized company scope');
  assert.ok(body.highSeq > 0);
  assert.equal(body.resetRequired, false);
  assert.equal(body.feedCursor, 0, 'the client cursor is preserved on resume');
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('evt-foreign'), false);
  assert.equal(serialized.includes('Foreign'), false);
  db.prepare('DELETE FROM hq_activity WHERE company_id = ?').run('co-foreign');
  db.prepare('DELETE FROM companies WHERE id = ?').run('co-foreign');
});

test('route: HEADQUARTERS_ENABLED=0 reports a descriptive disabled status, not a fake snapshot', async () => {
  registerSelfTenant(COMPANY);
  process.env.HEADQUARTERS_ENABLED = '0';
  const route = createHqSnapshotRoute(async () => {
    throw new Error('collaborators must not be resolved while disabled');
  });
  const response = await route(request('', await sessionCookie()));
  delete process.env.HEADQUARTERS_ENABLED;
  assert.equal(response.status, 503);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, 'headquarters_disabled');
});
