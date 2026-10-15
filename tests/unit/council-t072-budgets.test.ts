/**
 * T072 (owner CWE-045): Section 32.6 interface and API budgets,
 * exercised at the composed level under the fixed recorded load.
 *
 * Reference load (Section 32.6), seeded for real into the isolated
 * store: 1,000 historical sessions and 10,000 linked action records
 * in one company scope; 20 warmup requests then 200 measured
 * requests per REST leg, in process, against the real route
 * handlers and services. Provider-generation time is excluded by
 * construction: no provider is contacted anywhere in this file.
 *
 * Budgets asserted: history, snapshot, and draft REST p95 <= 500ms;
 * start admission p95 <= 750ms; stop acknowledgement p95 <= 1s;
 * committed event to visible read p95 <= 1s (measured through the
 * composition root's outbox pump into the sessions read); a
 * 200-event reconnection catch-up completes in <= 2s; local action
 * feedback (capabilities read) p95 <= 200ms.
 *
 * Not re-proven here: the initial-page cold-cache budget and the
 * paged report budgets are presentation and export measures owned
 * by CWE-044's fixture evidence and CWE-038's export suite; this
 * file closes the API and event legs at the composed level.
 *
 * Run with:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-t072-budgets.test.ts
 */
import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';
import { signCsrfToken } from '../../src/lib/csrf-protection';

const ALICE = 'owner:alice';
const SESSION_COUNT = 1_000;
const LINK_COUNT = 10_000;
const START_COUNT = 200;

const savedEnv: Record<string, string | undefined> = {};
for (const key of ['MC_TENANT_REGISTRY_JSON', 'MC_TENANT_SESSION_SECRET', 'MC_API_TOKEN', 'MC_CSRF_COOKIE_SECRET']) {
  savedEnv[key] = process.env[key];
}

function installFixtureEnv(): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'council-a.test': { tenantId: 'tenant-a', companyId: 'company-a', kind: 'self', installationId: 'install-a' },
  });
  process.env.MC_TENANT_SESSION_SECRET = 'cwe045-t072-session-secret';
  process.env.MC_API_TOKEN = 'cwe045-t072-operator-token';
  process.env.MC_CSRF_COOKIE_SECRET = 'cwe045-t072-csrf-secret';
}

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type RouteHandler = (request: NextRequest, ctx?: unknown) => Promise<Response>;

let sessionsRoute: { GET: RouteHandler; POST: RouteHandler };
let sessionRoute: { GET: RouteHandler };
let startRoute: { POST: RouteHandler };
let cancelRoute: { POST: RouteHandler };
let eventsRoute: { GET: RouteHandler };
let capabilitiesRoute: { GET: RouteHandler };
let db: import('better-sqlite3').Database;
let engine: import('../../src/lib/council/engine').CouncilEngine;

const scope = { tenant_id: 'tenant-a', company_id: 'company-a', installation_id: 'install-a', owner_subject: null };
const historyIds: string[] = [];
const startIds: string[] = [];

async function makeRequest(
  path: string,
  options: { method?: string; body?: unknown; csrf?: boolean; idempotencyKey?: string; subject?: string } = {},
): Promise<NextRequest> {
  const headers: Record<string, string> = { host: 'council-a.test' };
  const token = await signTenantGrant({
    purpose: 'session',
    tenantId: 'tenant-a',
    companyId: 'company-a',
    subject: options.subject ?? ALICE,
    host: 'council-a.test',
    installationId: 'install-a',
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: `t072-${Math.random()}`,
  });
  const cookies = [`mc_tenant_session=${token}`];
  if (options.csrf) {
    const { value } = await signCsrfToken();
    cookies.push(`mc_csrf_token=${value}`);
  }
  headers.cookie = cookies.join('; ');
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return new NextRequest(`https://council-a.test${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}


function draftBody(): Record<string, unknown> {
  return {
    mode: 'selected',
    visibility: 'company',
    seat_ids: ['simon-sinek', 'brene-brown'],
    source_pack_version: 'pack-fixture-1.0.0',
    model_policy: {
      selection: 'explicit',
      route_id: 'route-fixture-1',
      requested_model_id: 'model-selected-by-client',
      reasoning_preference: null,
      fallback_policy: 'none',
    },
    brief: {
      question: 'Should we pilot the revised offer before a broad launch?',
      options: [
        { id: 'A', label: 'Keep the current offer', kind: 'status_quo' },
        { id: 'B', label: 'Pilot the revised offer', kind: 'bounded_test' },
      ],
      facts: [],
      assumptions: [],
      unknowns: [],
      constraints: [],
      relevance_weights: { 'simon-sinek': 2, 'brene-brown': 3 },
      critical_domains: [],
      evidence_manifest: [],
      private_preference_ref: null,
      display_timezone: 'America/New_York',
    },
  };
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

async function measure(label: string, count: number, fn: (index: number) => Promise<void>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const started = performance.now();
    await fn(i);
    samples.push(performance.now() - started);
  }
  const value = p95(samples);
  console.log(`[T072] ${label}: p95 ${value.toFixed(1)}ms over ${count} measured requests`);
  return value;
}

before(async () => {
  installFixtureEnv();
  sessionsRoute = await import('../../src/app/api/council/sessions/route');
  sessionRoute = await import('../../src/app/api/council/sessions/[id]/route');
  startRoute = await import('../../src/app/api/council/sessions/[id]/start/route');
  cancelRoute = await import('../../src/app/api/council/sessions/[id]/cancel/route');
  eventsRoute = await import('../../src/app/api/council/sessions/[id]/events/route');
  capabilitiesRoute = await import('../../src/app/api/council/capabilities/route');
  const dbModule = await import('../../src/lib/db');
  db = dbModule.getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at) VALUES ('company-a', 'Company A', 'company-a', '{}', ?, ?)`,
  ).run(nowIso, nowIso);
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, company_id, created_at, updated_at) VALUES ('default', 'Default', 'default', 'company-a', ?, ?)`,
  ).run(nowIso, nowIso);

  // Seed the reference load: 1,000 historical sessions through the
  // real store, then 10,000 linked action records by bulk insert.
  const store = await import('../../src/lib/council/store');
  const contracts = await import('../../src/lib/council/contracts');
  const fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  const repositories = new store.CouncilRepositories();
  const envelope = store.envelopeFromScope(scope as never, ALICE, 'owner', 'write');
  for (let i = 0; i < SESSION_COUNT; i += 1) {
    const sessionId = `sess-hist-${String(i).padStart(4, '0')}`;
    historyIds.push(sessionId);
    const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
    const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
    spec.session_id = sessionId;
    brief.session_id = sessionId;
    spec.visibility = 'company';
    spec.brief_sha256 = contracts.canonicalHash(brief);
    repositories.createSession(envelope, {
      spec,
      brief,
      scope,
      state: {
        schema_version: 'wise-elders.session-state/v1',
        session_id: sessionId,
        mode: spec.mode,
        state: i < START_COUNT ? 'DRAFT' : 'COMPLETED',
        state_version: 1,
        brief_revision: brief.revision,
        resume_phase: null,
        cancel_generation: 0,
        revocation_generation: 0,
        attempt: 1,
        lease_epoch: 0,
        archived: false,
        updated_at: spec.created_at,
      },
      sample: false,
    } as never);
    if (i < START_COUNT) startIds.push(sessionId);
  }
  const insertProposal = db.prepare(
    `INSERT INTO council_action_proposals (tenant_id, company_id, session_id, id, verdict_id, plan_hash, actions_json, risk_class, status, supersedes_id, created_at)
     VALUES ('tenant-a', 'company-a', ?, ?, ?, ?, '[]', 'low', 'approved', NULL, ?)`,
  );
  const insertLink = db.prepare(
    `INSERT INTO council_task_links (tenant_id, company_id, session_id, id, parent_session_task_id, action_proposal_id, action_id, plan_hash, operation_id, task_id, task_board_ref, created_at)
     VALUES ('tenant-a', 'company-a', ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const insertAll = db.transaction(() => {
    let n = 0;
    for (const sessionId of historyIds) {
      insertProposal.run(sessionId, `proposal-${sessionId}`, `verdict-${sessionId}`, `plan-hash-${sessionId}`, nowIso);
      for (let k = 0; k < LINK_COUNT / SESSION_COUNT; k += 1) {
        n += 1;
        insertLink.run(
          sessionId,
          `link-${n}`,
          `proposal-${sessionId}`,
          `act-${k}`,
          `plan-hash-${sessionId}`,
          `op-link-${n}`,
          `task-link-${n}`,
          nowIso,
        );
      }
    }
  });
  insertAll();

  // One approved council_run grant per start-leg session.
  const runAuth = await import('../../src/lib/council/run-authorization');
  const adapter = await import('../../src/lib/council/persistence/council-store');
  const service = new runAuth.CouncilRunAuthorizationService({
    store: adapter.openCouncilStore(),
    now: () => new Date().toISOString(),
    newId: () => `t072-${Math.random().toString(36).slice(2)}`,
  });
  const principal = {
    subject: ALICE,
    tenantKind: 'self',
    channel: 'browser',
    supportAccess: false,
    scope: { ...scope, owner_subject: null },
    tenant: { tenantId: 'tenant-a', companyId: 'company-a', clientId: null, kind: 'self', subject: ALICE, host: 'council-a.test', installationId: 'install-a' },
  } as unknown as import('../../src/lib/council/auth').CouncilPrincipal;
  const snapshot = {
    schema: 'wise-elders.route-selection/v1',
    selectionSource: 'explicit',
    routeId: 'route-t072',
    routeRevision: 1,
    routeKind: 'fixed_model',
    providerSlug: 'provider-t072',
    requestedRoute: 'route-t072',
    requestedModelOrAlias: 'model-t072',
    combinationMembers: null,
    reasoning: { requested: null, applied: null, supported: null, limitation: null },
    fallbackPolicy: 'none',
    providerAccountRef: null,
    capabilitySnapshot: { contextWindowTokens: 8192, maxOutputTokens: 1024, capabilities: ['text'], supportedReasoningLevels: null },
    credential: { state: 'present', envVar: 'T072_API_KEY', source: 'process.env', checked: ['process.env'] },
    identityLevel: 'configured',
    scope: { tenantId: 'tenant-a', companyId: 'company-a', installationId: 'install-a', ownerSubject: null },
    createdAt: nowIso,
  } as unknown as import('../../src/lib/council/explicit-selection').CouncilRouteSelection;
  for (const sessionId of startIds) {
    const preview = service.previewRun(principal, {
      session_id: sessionId,
      route_snapshot: snapshot,
      route_policy_sha256: 'c'.repeat(64),
      ceilings: {
        max_provider_requests: 50,
        max_output_repairs: 9,
        max_transport_retries: 8,
        max_input_tokens: null,
        max_output_tokens: null,
        max_money: { amount_minor: 100_000, currency: 'USD' },
      },
    });
    service.approveRun(principal, preview.preview_id, { authority_mode: 'managed_principal' });
  }

  const engineModule = await import('../../src/lib/council/engine');
  engine = engineModule.getCouncilEngine();
});

test('T072 history leg: sessions list p95 within 500ms under the reference load', async () => {
  for (let i = 0; i < 20; i += 1) await sessionsRoute.GET(await makeRequest('/api/council/sessions', { subject: 'viewer:history' }));
  const value = await measure('history list', 200, async () => {
    const response = await sessionsRoute.GET(await makeRequest('/api/council/sessions', { subject: 'viewer:history' }));
    assert.equal(response.status, 200);
  });
  assert.ok(value <= 500, `history p95 ${value.toFixed(1)}ms exceeds 500ms`);
});

test('T072 snapshot leg: session read p95 within 500ms', async () => {
  const target = historyIds[500];
  for (let i = 0; i < 20; i += 1) {
    await sessionRoute.GET(await makeRequest(`/api/council/sessions/${target}`, { subject: 'viewer:snapshot' }), { params: Promise.resolve({ id: target }) });
  }
  const value = await measure('session snapshot', 200, async () => {
    const response = await sessionRoute.GET(await makeRequest(`/api/council/sessions/${target}`, { subject: 'viewer:snapshot' }), { params: Promise.resolve({ id: target }) });
    assert.equal(response.status, 200);
  });
  assert.ok(value <= 500, `snapshot p95 ${value.toFixed(1)}ms exceeds 500ms`);
});

test('T072 draft leg: draft creation p95 within 500ms', async () => {
  const body = draftBody();
  for (let i = 0; i < 20; i += 1) {
    await sessionsRoute.POST(await makeRequest('/api/council/sessions', { method: 'POST', csrf: true, subject: 'viewer:draft', idempotencyKey: `t072-warm-${i}`, body: { ...body, idempotency_key: `t072-warm-${i}` } }));
  }
  const value = await measure('draft create', 200, async (i) => {
    const key = `t072-draft-${i}`;
    const response = await sessionsRoute.POST(await makeRequest('/api/council/sessions', { method: 'POST', csrf: true, subject: 'viewer:draft', idempotencyKey: key, body: { ...body, idempotency_key: key } }));
    assert.equal(response.status, 201, `draft create ${i}`);
  });
  assert.ok(value <= 500, `draft p95 ${value.toFixed(1)}ms exceeds 500ms`);
});

test('T072 local feedback leg: capabilities read p95 within 200ms', async () => {
  for (let i = 0; i < 20; i += 1) await capabilitiesRoute.GET(await makeRequest('/api/council/capabilities', { subject: 'viewer:local' }));
  const value = await measure('capabilities read', 200, async () => {
    const response = await capabilitiesRoute.GET(await makeRequest('/api/council/capabilities', { subject: 'viewer:local' }));
    assert.equal(response.status, 200);
  });
  assert.ok(value <= 200, `capabilities p95 ${value.toFixed(1)}ms exceeds 200ms`);
});

test('T072 start and stop legs: start admission p95 within 750ms, stop ack p95 within 1s', async () => {
  const startValue = await measure('session start', START_COUNT, async (i) => {
    const id = startIds[i];
    const key = `t072-start-${i}`;
    const response = await startRoute.POST(
      await makeRequest(`/api/council/sessions/${id}/start`, { method: 'POST', csrf: true, subject: 'viewer:run', idempotencyKey: key, body: { idempotency_key: key } }),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(response.status, 202, `start ${id}`);
  });
  assert.ok(startValue <= 750, `start p95 ${startValue.toFixed(1)}ms exceeds 750ms`);

  const stopValue = await measure('session cancel', START_COUNT, async (i) => {
    const id = startIds[i];
    const key = `t072-cancel-${i}`;
    const response = await cancelRoute.POST(
      await makeRequest(`/api/council/sessions/${id}/cancel`, { method: 'POST', csrf: true, subject: 'viewer:run', idempotencyKey: key, body: { idempotency_key: key } }),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(response.status, 200, `cancel ${id}`);
  });
  assert.ok(stopValue <= 1000, `stop p95 ${stopValue.toFixed(1)}ms exceeds 1s`);
});

test('T072 event visibility: committed events reach the read model within 1s through the pump', async () => {
  // Settle every intent the seeding produced, so each sample below
  // measures only its own commit.
  engine.pumpOutboxOnce();
  const samples: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const key = `t072-visible-${i}`;
    const started = performance.now();
    const created = await sessionsRoute.POST(
      await makeRequest('/api/council/sessions', {
        method: 'POST',
        csrf: true,
        subject: 'viewer:visibility',
        idempotencyKey: key,
        body: { ...draftBody(), idempotency_key: key },
      }),
    );
    assert.equal(created.status, 201, `visibility create ${i}`);
    const createdBody = await created.json();
    const sessionId = createdBody.data.spec.session_id as string;
    engine.pumpOutboxOnce();
    const pending = db
      .prepare(`SELECT COUNT(*) AS n FROM council_projection_outbox WHERE session_id = ? AND state = 'pending'`)
      .get(sessionId) as { n: number };
    assert.equal(pending.n, 0, 'the committed event intent is drained by the pump');
    const response = await sessionsRoute.GET(await makeRequest('/api/council/sessions', { subject: 'viewer:history' }));
    const body = await response.json();
    const visible = (body.data.sessions as Array<{ session_id: string }>).some((entry) => entry.session_id === sessionId);
    assert.ok(visible, `${sessionId} visible in the sessions read after the pump`);
    samples.push(performance.now() - started);
  }
  const value = p95(samples);
  console.log(`[T072] event visibility: p95 ${value.toFixed(1)}ms over 20 samples`);
  assert.ok(value <= 1000, `event visibility p95 ${value.toFixed(1)}ms exceeds 1s`);
});

test('T072 reconnection catch-up: a 200-event gap reads back within 2s', async () => {
  const target = historyIds[700];
  // Produce a 200-event gap on one session through the journal.
  const store = await import('../../src/lib/council/store');
  const { appendKanbanJournalEvent } = await import('../../src/lib/council/kanban/journal');
  for (let i = 0; i < 200; i += 1) {
    appendKanbanJournalEvent(db, { tenant_id: 'tenant-a', company_id: 'company-a' }, target, {
      eventId: `t072-gap-${i}`,
      actorSubject: ALICE,
      action: 't072_gap_marker',
      createdAt: new Date(Date.now() + i).toISOString(),
      data: { index: i, authorization: { permission: 'read' } },
    });
  }
  const started = performance.now();
  let after = 0;
  let gapEvents = 0;
  let pages = 0;
  for (;;) {
    const response = await eventsRoute.GET(
      await makeRequest(`/api/council/sessions/${target}/events?after=${after}`, { subject: 'viewer:catchup' }),
      { params: Promise.resolve({ id: target }) },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.kind, 'page', 'a 200-event gap is within the resync page cap and returns as pages');
    const page = body.data.page as { events: Array<{ type: string; sequence: number }>; has_more: boolean };
    pages += 1;
    gapEvents += page.events.filter((entry) => entry.type === 'operation_completed').length;
    if (!page.has_more || page.events.length === 0) break;
    after = page.events[page.events.length - 1].sequence;
  }
  const elapsed = performance.now() - started;
  assert.ok(gapEvents >= 200, `the full 200-event gap is returned across ${pages} page(s), got ${gapEvents}`);
  console.log(`[T072] reconnection catch-up: ${elapsed.toFixed(1)}ms for a 200-event gap`);
  assert.ok(elapsed <= 2000, `catch-up ${elapsed.toFixed(1)}ms exceeds 2s`);
  void store;
});
