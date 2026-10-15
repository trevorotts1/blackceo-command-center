/**
 * council-gauntlet-perf.test.ts — CWE-044 gauntlet: recorded-load
 * performance budgets (T154, directive Section 32.6).
 *
 * Method, stated so the measurement repeats on any machine:
 *   - Reference load seeded through the REAL repositories on an
 *     isolated database: 1,000 historical council sessions in one
 *     tenant/company scope, plus one session carrying a 200-event
 *     journal. (The Section 32.6 reference load's 10,000 linked
 *     actions belong to the host action board, not the council
 *     history store; the council-side budgets below are what this
 *     tree can honestly measure.)
 *   - The REAL route handlers are invoked in-process with signed
 *     tenant grants (the CWE-030 suite's pattern): GET
 *     /api/council/sessions (history list), GET
 *     /api/council/sessions/:id (session/snapshot and draft read),
 *     GET /api/council/sessions/:id/events (history page).
 *   - 200 measured requests per surface after 20 warmup requests;
 *     p95 compared with the Section 32.6 budget of 500 ms.
 *   - Provider variation: the surfaces measured here do not call a
 *     model provider at all (they are store reads), so the fast and
 *     slow synthetic provider cases do not move these numbers;
 *     model latency is a run-time property reported by the run
 *     services (CWE-050), not by these reads. Recorded as such in
 *     perf-results.json.
 *   - Start admission (p95 <= 750 ms) and stop acknowledgement
 *     (p95 <= 1 s): while the registry reports a contract not_ready
 *     the branch below records PENDING_CWE050_RERUN instead of
 *     measuring a stub. On a ready tree (post-CWE-050) it measures
 *     the granted path through the REAL routes. Amendment (CWE-044
 *     harness amendment, 2026-10-15): the fixture now performs the
 *     CWE-049 grant step the product law requires (a start posted
 *     with no grant lawfully answers 403
 *     RUN_AUTHORIZATION_REQUIRED): run-authorization preview and
 *     approve with an explicit route snapshot, then the start body
 *     carries the issued grant_id. Every sample is a FIRST start
 *     (or, for stop ack, a FIRST cancel) on a freshly seeded
 *     session with its own grant, and every sample asserts
 *     idempotent_replay === false, so the p95 is first-admission
 *     latency, never the recorded-receipt replay a repeat start
 *     returns under T055/T078. Preview and approve are the explicit
 *     user-consent interaction Section 32.6 excludes from the
 *     start-admission window, so they run untimed as setup; the
 *     timed window is the start (or cancel) POST through its full
 *     response: for start, the durable enqueue/202 receipt; for
 *     cancel, a response written only after the cancellation
 *     commit. Budgets and sample counts are unchanged.
 *   - Rate-limit honesty: the composed product enforces its
 *     Section 17.1 ceiling of 1,200 council API requests per
 *     minute per principal and company, and this suite's combined
 *     surfaces exceed that inside a single minute window. A 429
 *     RATE_LIMITED refusal is a capacity answer, not an admission
 *     measurement: when any step of a start/stop sample meets one,
 *     the sample is discarded, the fixture waits out the window
 *     (61 s), and the sample is re-measured from scratch with a
 *     fresh session and a fresh grant, so every recorded number
 *     is still a clean first operation admitted inside a live
 *     window. The number of such waits is recorded in
 *     perf-results.json as rate_limit_waits. No timed sample
 *     includes a refusal.
 *
 * Results are machine-relative: written on a loaded 2-CPU VM on
 * 2026-10-15 and labeled as such in perf-results.json. A budget
 * miss here is evidence about this machine under load; the harness
 * repeats identically on a quiet machine for the decisive run.
 */

import './_isolated-db';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';
import { signCsrfToken } from '../../src/lib/csrf-protection';
import type { SessionStateRecord } from '../../src/lib/council/contracts';
import type { CouncilStoredSession } from '../../src/lib/council/store';

const OUT_DIR =
  process.env.GAUNTLET_OUT ?? join(homedir(), 'workspace/skill77/cwe-044/evidence');
const WARMUP = 20;
const SAMPLES = 200;
const REST_BUDGET_MS = 500;

let repositories: InstanceType<
  typeof import('../../src/lib/council/store').CouncilRepositories
>;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let canonicalStringifyFn: typeof import('../../src/lib/council/contracts').canonicalStringify;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDb: () => void;
let sessionsRoute: { GET: (request: NextRequest) => Promise<Response> };
let sessionRoute: {
  GET: (request: NextRequest, ctx?: unknown) => Promise<Response>;
};
let eventsRoute: {
  GET: (request: NextRequest, ctx?: unknown) => Promise<Response>;
};
type PostRouteModule = {
  POST: (request: NextRequest, ctx?: unknown) => Promise<Response>;
};
let startRoute: PostRouteModule;
let cancelRoute: PostRouteModule;
let raPreviewRoute: PostRouteModule;
let raApproveRoute: PostRouteModule;
let writeEnvelope: ReturnType<typeof envelopeFromScopeFn>;

const now = '2026-10-14T12:00:00.000Z';
let idCounter = 0;
const newId = () => `cc044p-id-${(idCounter += 1).toString().padStart(5, '0')}`;

const SCOPE = {
  tenant_id: 'tenant-a',
  company_id: 'company-a',
  installation_id: 'install-a',
  owner_subject: null as string | null,
};
const RICH_SESSION = 'sess-perf-rich';
const DETAIL_SESSION = 'sess-perf-0500';

function makeStored(sessionId: string): CouncilStoredSession {
  const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.visibility = 'company';
  spec.brief_sha256 = canonicalHashFn(brief);
  const state: SessionStateRecord = {
    schema_version: 'wise-elders.session-state/v1',
    session_id: sessionId,
    mode: spec.mode,
    state: 'DRAFT',
    state_version: 0,
    brief_revision: brief.revision,
    resume_phase: null,
    cancel_generation: 0,
    revocation_generation: 0,
    attempt: 1,
    lease_epoch: 0,
    archived: false,
    updated_at: spec.created_at,
  };
  return { spec, brief, scope: { ...SCOPE }, state, sample: false };
}

function installRouteEnv(): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'council-a.test': {
      tenantId: 'tenant-a',
      companyId: 'company-a',
      kind: 'self',
      installationId: 'install-a',
    },
  });
  process.env.MC_TENANT_SESSION_SECRET = 'cc044-gauntlet-test-secret';
  process.env.MC_API_TOKEN = 'cc044-gauntlet-test-token';
  process.env.SECRET_KEY = 'cc044-gauntlet-secret-key';
  process.env.MC_CSRF_COOKIE_SECRET = 'cc044-gauntlet-csrf-secret';
  delete process.env.MC_INTERVIEW_COOKIE_SECRET;
  process.env.MC_COUNCIL_SUPPORT_SUBJECTS = 'support:root';
}

async function routeRequest(path: string, method = 'GET', csrf = false): Promise<NextRequest> {
  const headers: Record<string, string> = { host: 'council-a.test' };
  const token = await signTenantGrant({
    purpose: 'session',
    tenantId: 'tenant-a',
    companyId: 'company-a',
    subject: 'owner:alice',
    host: 'council-a.test',
    installationId: 'install-a',
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: `cc044-${Math.random()}`,
  });
  const cookies = [`mc_tenant_session=${token}`];
  if (csrf) {
    const { value } = await signCsrfToken();
    cookies.push(`mc_csrf_token=${value}`);
    headers['idempotency-key'] = `cc044-${Math.random()}`;
  }
  headers.cookie = cookies.join('; ');
  return new NextRequest(`https://council-a.test${path}`, { method, headers });
}

/**
 * POST request carrying a JSON body, built the way the CWE-050
 * composition and run-controls suites build theirs: the same
 * idempotency key travels in the header and in the body, alongside
 * the signed tenant grant and CSRF cookies.
 */
async function postJsonRequest(
  path: string,
  bodyFields: Record<string, unknown>,
): Promise<NextRequest> {
  const key = `cc044-${Math.random()}`;
  const headers: Record<string, string> = {
    host: 'council-a.test',
    'idempotency-key': key,
  };
  const token = await signTenantGrant({
    purpose: 'session',
    tenantId: 'tenant-a',
    companyId: 'company-a',
    subject: 'owner:alice',
    host: 'council-a.test',
    installationId: 'install-a',
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: `cc044-${Math.random()}`,
  });
  const { value } = await signCsrfToken();
  headers.cookie = [`mc_tenant_session=${token}`, `mc_csrf_token=${value}`].join('; ');
  return new NextRequest(`https://council-a.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...bodyFields, idempotency_key: key }),
  });
}

/** Explicit route snapshot, the CWE-050 composition test's shape. */
function routeSnapshot(): Record<string, unknown> {
  return {
    schema: 'wise-elders.route-selection/v1',
    selectionSource: 'explicit',
    routeId: 'route-a',
    routeRevision: 1,
    routeKind: 'fixed_model',
    providerSlug: 'provider-a',
    requestedRoute: 'route-a',
    requestedModelOrAlias: 'model-a',
    combinationMembers: null,
    reasoning: { requested: null, applied: null, supported: null, limitation: null },
    fallbackPolicy: 'none',
    providerAccountRef: null,
    capabilitySnapshot: {
      contextWindowTokens: 200000,
      maxOutputTokens: 8000,
      capabilities: ['text'],
      supportedReasoningLevels: null,
    },
    credential: {
      state: 'present',
      envVar: 'PROVIDER_A_API_KEY',
      source: 'process.env',
      checked: ['process.env'],
    },
    identityLevel: 'configured',
    scope: {
      tenantId: 'tenant-a',
      companyId: 'company-a',
      installationId: 'install-a',
      ownerSubject: null,
    },
    createdAt: new Date().toISOString(),
  };
}

/** Tagged refusal from the product's Section 17.1 rate limiter. */
class RateLimitedError extends Error {
  constructor(where: string) {
    super(`rate limited (429 RATE_LIMITED) at ${where}`);
    this.name = 'RateLimitedError';
  }
}

let rateLimitWaits = 0;
const MAX_RATE_LIMIT_WAITS_PER_SAMPLE = 4;

/**
 * A discarded sample waits out the limiter's one-minute window
 * (61 s covers both wall-clock-aligned and first-request-anchored
 * fixed windows) and is then re-measured from scratch.
 */
async function waitOutRateLimitWindow(): Promise<void> {
  rateLimitWaits += 1;
  await new Promise((resolve) => setTimeout(resolve, 61_000));
}

async function postRouteJson(
  route: PostRouteModule,
  path: string,
  sessionId: string,
  bodyFields: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await route.POST(await postJsonRequest(path, bodyFields), {
    params: Promise.resolve({ id: sessionId }),
  });
  const body = JSON.parse(await res.text());
  if (res.status === 429) throw new RateLimitedError(path);
  return { status: res.status, body };
}

async function timedRoutePost(
  route: PostRouteModule,
  path: string,
  sessionId: string,
  bodyFields: Record<string, unknown>,
): Promise<{ ms: number; status: number; body: any }> {
  const started = performance.now();
  const res = await route.POST(await postJsonRequest(path, bodyFields), {
    params: Promise.resolve({ id: sessionId }),
  });
  // Drain the body inside the window: the measurement covers the
  // full response, the same convention as timed() for the reads.
  const text = await res.text();
  const ms = performance.now() - started;
  const body = JSON.parse(text);
  if (res.status === 429) throw new RateLimitedError(path);
  return { ms, status: res.status, body };
}

/**
 * The CWE-049 grant step, through the real run-authorization
 * routes: preview (explicit route snapshot) then approve. Returns
 * the issued grant_id. Untimed setup for the start/stop samples:
 * this is the explicit user-consent interaction Section 32.6
 * excludes from the admission window.
 */
async function approveRunGrant(sessionId: string): Promise<string> {
  const preview = await postRouteJson(
    raPreviewRoute,
    `/api/council/sessions/${sessionId}/run-authorization/preview`,
    sessionId,
    { route_snapshot: routeSnapshot() },
  );
  assert.equal(
    preview.status,
    201,
    `grant preview for ${sessionId}: ${JSON.stringify(preview.body)}`,
  );
  const approved = await postRouteJson(
    raApproveRoute,
    `/api/council/sessions/${sessionId}/run-authorization/approve`,
    sessionId,
    { preview_id: preview.body.data.preview_id },
  );
  assert.equal(
    approved.status,
    201,
    `grant approve for ${sessionId}: ${JSON.stringify(approved.body)}`,
  );
  assert.equal(approved.body.data.status, 'active');
  return approved.body.data.grant_id as string;
}

let startSampleSeq = 0;
let stopSampleSeq = 0;

/**
 * One start-admission sample: a freshly seeded session with its
 * own freshly approved grant, timed on its FIRST start only. The
 * replay assertion makes a recorded-receipt repeat fail loudly
 * instead of silently entering the p95.
 */
async function sampleFirstStartAdmission(): Promise<number> {
  startSampleSeq += 1;
  const baseId = `sess-perf-start-${String(startSampleSeq).padStart(4, '0')}`;
  for (let attempt = 1; ; attempt++) {
    const sessionId = attempt === 1 ? baseId : `${baseId}-r${attempt}`;
    repositories.createSession(writeEnvelope, makeStored(sessionId));
    try {
      const grantId = await approveRunGrant(sessionId);
      const result = await timedRoutePost(
        startRoute,
        `/api/council/sessions/${sessionId}/start`,
        sessionId,
        { grant_id: grantId },
      );
      assert.equal(
        result.status,
        202,
        `first start for ${sessionId}: ${JSON.stringify(result.body)}`,
      );
      assert.equal(
        result.body.data.idempotent_replay,
        false,
        `start sample for ${sessionId} must be a first admission, not a replay`,
      );
      return result.ms;
    } catch (err) {
      if (err instanceof RateLimitedError && attempt <= MAX_RATE_LIMIT_WAITS_PER_SAMPLE) {
        await waitOutRateLimitWindow();
        continue;
      }
      throw err;
    }
  }
}

/**
 * One stop-ack sample: a freshly seeded, granted, and started
 * session (setup untimed), timed on its FIRST cancel only.
 */
async function sampleFirstStopAck(): Promise<number> {
  stopSampleSeq += 1;
  const baseId = `sess-perf-stop-${String(stopSampleSeq).padStart(4, '0')}`;
  for (let attempt = 1; ; attempt++) {
    const sessionId = attempt === 1 ? baseId : `${baseId}-r${attempt}`;
    repositories.createSession(writeEnvelope, makeStored(sessionId));
    try {
      const grantId = await approveRunGrant(sessionId);
      const started = await postRouteJson(
        startRoute,
        `/api/council/sessions/${sessionId}/start`,
        sessionId,
        { grant_id: grantId },
      );
      assert.equal(
        started.status,
        202,
        `setup start for ${sessionId}: ${JSON.stringify(started.body)}`,
      );
      const result = await timedRoutePost(
        cancelRoute,
        `/api/council/sessions/${sessionId}/cancel`,
        sessionId,
        {},
      );
      assert.equal(
        result.status,
        200,
        `first cancel for ${sessionId}: ${JSON.stringify(result.body)}`,
      );
      assert.equal(result.body.data.state, 'CANCELLED');
      assert.equal(
        result.body.data.idempotent_replay,
        false,
        `stop sample for ${sessionId} must be a first cancel, not a replay`,
      );
      return result.ms;
    } catch (err) {
      if (err instanceof RateLimitedError && attempt <= MAX_RATE_LIMIT_WAITS_PER_SAMPLE) {
        await waitOutRateLimitWindow();
        continue;
      }
      throw err;
    }
  }
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

interface MetricResult {
  surface: string;
  samples: number;
  warmup: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  budget_ms: number;
  within_budget: boolean;
}

const metrics: MetricResult[] = [];
const pendings: Array<{ surface: string; status: string; detail: string }> = [];

async function measure(
  surface: string,
  budgetMs: number,
  call: () => Promise<number>,
): Promise<void> {
  for (let i = 0; i < WARMUP; i++) await call();
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(await call());
  const sorted = [...samples].sort((a, b) => a - b);
  metrics.push({
    surface,
    samples: SAMPLES,
    warmup: WARMUP,
    p50_ms: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
    p95_ms: Math.round(p95(samples) * 10) / 10,
    max_ms: Math.round(sorted[sorted.length - 1] * 10) / 10,
    budget_ms: budgetMs,
    within_budget: p95(samples) <= budgetMs,
  });
}

function timed(fn: () => Promise<Response>): () => Promise<number> {
  return async () => {
    const started = performance.now();
    const res = await fn();
    // Drain the body: the measurement covers the full response.
    await res.text();
    return performance.now() - started;
  };
}

before(async () => {
  const storeModule = await import('../../src/lib/council/store');
  const adapterModule = await import('../../src/lib/council/persistence/council-store');
  const contractsModule = await import('../../src/lib/council/contracts');
  const dbModule = await import('../../src/lib/db');
  fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  envelopeFromScopeFn = storeModule.envelopeFromScope;
  canonicalHashFn = contractsModule.canonicalHash;
  canonicalStringifyFn = contractsModule.canonicalStringify;
  closeDb = dbModule.closeDb;
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const adapter = adapterModule.openCouncilStore();
  repositories = new storeModule.CouncilRepositories({
    adapter,
    diagnosticsDir: mkdtempSync(join(tmpdir(), 'cwe044-perf-diag-')),
    now: () => now,
    newId,
  });
  sessionsRoute = await import('../../src/app/api/council/sessions/route');
  sessionRoute = await import('../../src/app/api/council/sessions/[id]/route');
  eventsRoute = await import('../../src/app/api/council/sessions/[id]/events/route');
  startRoute = await import('../../src/app/api/council/sessions/[id]/start/route');
  cancelRoute = await import('../../src/app/api/council/sessions/[id]/cancel/route');
  raPreviewRoute = await import(
    '../../src/app/api/council/sessions/[id]/run-authorization/preview/route'
  );
  raApproveRoute = await import(
    '../../src/app/api/council/sessions/[id]/run-authorization/approve/route'
  );
  installRouteEnv();

  // Reference load: 1,000 historical sessions in the scope.
  const write = envelopeFromScopeFn(SCOPE, 'owner:alice', 'owner', 'write');
  writeEnvelope = write;
  for (let i = 1; i <= 1000; i++) {
    const id = `sess-perf-${String(i).padStart(4, '0')}`;
    repositories.createSession(write, makeStored(id));
  }
  // One session with a 200-event journal (chain tracked locally).
  repositories.createSession(write, makeStored(RICH_SESSION));
  const read = envelopeFromScopeFn(SCOPE, 'owner:alice', 'owner', 'read');
  let events = repositories.listEvents(read, RICH_SESSION, 0);
  let prevHash = events[events.length - 1].event_hash;
  let sequence = events[events.length - 1].sequence;
  for (let revision = 2; revision <= 200; revision++) {
    sequence += 1;
    const payload = {
      brief_revision: revision,
      previous_brief_revision: revision - 1,
      brief_sha256: canonicalHashFn({ gauntlet_revision: revision }),
    };
    const payloadJson = canonicalStringifyFn(payload);
    const eventHash = canonicalHashFn({
      tenant_id: SCOPE.tenant_id,
      company_id: SCOPE.company_id,
      session_id: RICH_SESSION,
      sequence,
      type: 'brief_revised',
      payload_json: payloadJson,
      prev_hash: prevHash,
      created_at: now,
    });
    adapter.appendEvent({
      scope: { tenantId: SCOPE.tenant_id, companyId: SCOPE.company_id },
      sessionId: RICH_SESSION,
      id: newId(),
      type: 'brief_revised',
      fromState: null,
      toState: null,
      actorSubject: 'owner:alice',
      payloadJson,
      prevHash,
      eventHash,
      createdAt: now,
    });
    prevHash = eventHash;
  }
  events = repositories.listEvents(read, RICH_SESSION, 0);
  assert.equal(events.length, 200);
});

after(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'perf-results.json'),
    JSON.stringify(
      {
        contract: 'T154',
        generated_at: new Date().toISOString(),
        machine:
          'machine-relative: loaded 2-CPU Linux VM, 2026-10-15; repeat on a quiet machine for decisive budget evidence',
        method:
          'real route handlers in-process with signed tenant grants; 200 measured requests after 20 warmup per surface; reference load 1,000 sessions + one 200-event journal seeded via the real repositories',
        provider_note:
          'the measured read surfaces call no model provider; fast/slow synthetic provider cases do not affect them. Model latency is reported separately by the run services (CWE-050) and is not conflated with interface budgets.',
        start_stop_method:
          'start admission and stop acknowledgement are measured on granted FIRST operations only (CWE-044 harness amendment, 2026-10-15). Each sample seeds a fresh session through the real repositories, obtains a real CWE-049 run grant through the run-authorization preview and approve routes with an explicit route snapshot, and passes grant_id in the start request body. The start sample asserts 202 with idempotent_replay === false, so no recorded-receipt replay (T055/T078) enters the p95; the timed window is the start POST through its full response, i.e. the durable enqueue/202 receipt. Preview and approve run untimed as setup: they are the explicit user-consent interaction Section 32.6 excludes from the admission window. The stop sample starts its fresh granted session untimed, then times the FIRST cancel POST through its full 200 response, asserting state CANCELLED and idempotent_replay === false; the response is written only after the cancellation commit. Visible-UI propagation of the cancellation is the separate event-to-UI metric, not this number. 200 measured samples after 20 warmup per surface, same as the reads. Rate limiting: the composed product enforces 1,200 council API requests per minute per principal and company (Section 17.1); when any step of a sample is refused with 429 RATE_LIMITED the sample is discarded, the fixture waits out the window (61 s), and the sample is re-measured from scratch with a fresh session and grant. rate_limit_waits counts those discards; no recorded sample includes a refusal.',
        rate_limit_waits: rateLimitWaits,
        metrics,
        pending: pendings,
      },
      null,
      2,
    ) + '\n',
  );
  closeDb();
});

test('history list p95 within 500 ms under the 1,000-session reference load', async () => {
  await measure('GET /api/council/sessions (history list, 1000 sessions in scope)', REST_BUDGET_MS, async () => {
    const ms = await timed(async () =>
      sessionsRoute.GET(await routeRequest('/api/council/sessions')),
    )();
    return ms;
  });
  const m = metrics[metrics.length - 1];
  assert.ok(m.within_budget, `${m.surface}: p95 ${m.p95_ms}ms exceeds ${m.budget_ms}ms`);
});

test('session detail (snapshot and draft read) p95 within 500 ms', async () => {
  await measure('GET /api/council/sessions/:id (session detail)', REST_BUDGET_MS, async () =>
    timed(async () =>
      sessionRoute.GET(
        await routeRequest(`/api/council/sessions/${DETAIL_SESSION}`),
        { params: Promise.resolve({ id: DETAIL_SESSION }) },
      ),
    )(),
  );
  const m = metrics[metrics.length - 1];
  assert.ok(m.within_budget, `${m.surface}: p95 ${m.p95_ms}ms exceeds ${m.budget_ms}ms`);
});

test('events history page p95 within 500 ms on a 200-event journal', async () => {
  await measure('GET /api/council/sessions/:id/events (200-event journal)', REST_BUDGET_MS, async () =>
    timed(async () =>
      eventsRoute.GET(
        await routeRequest(`/api/council/sessions/${RICH_SESSION}/events`),
        { params: Promise.resolve({ id: RICH_SESSION }) },
      ),
    )(),
  );
  const m = metrics[metrics.length - 1];
  assert.ok(m.within_budget, `${m.surface}: p95 ${m.p95_ms}ms exceeds ${m.budget_ms}ms`);
});

test('start admission and stop ack: measurement branch ready, pending while the registry says not_ready', async () => {
  const registrySrc = readFileSync(
    join(process.cwd(), 'src/lib/council/api/registry.ts'),
    'utf8',
  );
  const readinessOf = (contract: string): string => {
    const re = new RegExp(
      `contract_id: 'council\\.${contract.replace(/\./g, '\\.')}'[\\s\\S]{0,1600}?readiness: '([a-z_]+)'`,
    );
    return registrySrc.match(re)?.[1] ?? 'not_found';
  };
  const samplers = {
    'sessions.start': sampleFirstStartAdmission,
    'sessions.cancel': sampleFirstStopAck,
  } as const;
  for (const [contract, surface, budget] of [
    ['sessions.start', 'POST /api/council/sessions/:id/start (start admission)', 750],
    ['sessions.cancel', 'POST /api/council/sessions/:id/cancel (stop acknowledgement)', 1000],
  ] as const) {
    const readiness = readinessOf(contract);
    if (readiness !== 'ready') {
      pendings.push({
        surface,
        status: 'PENDING_CWE050_RERUN',
        detail: `registry readiness for ${contract} is '${readiness}' on this tree; the p95 <= ${budget}ms assertion runs unchanged once the contract is ready`,
      });
      continue;
    }
    // Ready branch (post-CWE-050 re-run): measure admission/ack p95
    // against the live routes, through the granted path. Every
    // sample is a first start (or first cancel) on a fresh session
    // with its own approved grant, and a replayed receipt or a
    // non-success response fails the sample loudly rather than
    // timing an error path or a replay as a first admission.
    await measure(surface, budget, samplers[contract]);
    const m = metrics[metrics.length - 1];
    assert.ok(m.within_budget, `${m.surface}: p95 ${m.p95_ms}ms exceeds ${m.budget_ms}ms`);
  }
  assert.ok(
    pendings.length > 0 ||
      (metrics.some((m) => m.surface.includes('start admission')) &&
        metrics.some((m) => m.surface.includes('stop acknowledgement'))),
    'the start/stop branch recorded either pendings or both measurements',
  );
});
