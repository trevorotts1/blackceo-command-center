/**
 * WER-014: the production Council run worker (src/lib/council/engine.ts).
 *
 * Runner (repo convention, Node built-in test runner via tsx):
 *   node --import tsx --test tests/unit/council-run-worker.test.ts
 *
 * What is proven here (Tier A, isolated DATABASE_PATH, fake clock, no
 * network, no credentials):
 *   1. claim -> heartbeat -> dispatch -> settle -> finish, with the
 *      journaled lease_epoch as the one fencing generation;
 *   2. two concurrent workers: only the current generation commits, and
 *      the loser's late reply is rejected (no second consumption, no
 *      overwritten accepted attempt);
 *   3. restart recovery: an already-accepted result is not replayed;
 *   4. cancellation aborts supported in-flight transports and fences the
 *      late result;
 *   5. readiness is false when no transport is wired, and the queued job
 *      is left untouched (never simulated as executed).
 *
 * NOT proven here (deferred, never claimed as passed): a real provider
 * dispatch, a live nine-seat three-round run, or acknowledgment from an
 * actually supervised worker process.
 */

import './_isolated-db';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import type { CouncilPrincipal } from '../../src/lib/council/auth';
import type {
  RunCeilings,
  ScopeFields,
  SessionStateRecord,
} from '../../src/lib/council/contracts';
import type { CouncilRouteSelection } from '../../src/lib/council/explicit-selection';
import type { CouncilRunAuthorizationService } from '../../src/lib/council/run-authorization';
import type {
  CouncilEnvelope,
  CouncilRepositories,
  CouncilStoredSession,
} from '../../src/lib/council/store';
import type { CouncilJobService } from '../../src/lib/council/jobs';
import type {
  CouncilRunDrainSummary,
  CouncilRunTransport,
  CouncilRunWorker,
} from '../../src/lib/council/engine';

let WorkerClass: typeof import('../../src/lib/council/engine').CouncilRunWorker;
let AuthorizationClass: typeof import('../../src/lib/council/run-authorization').CouncilRunAuthorizationService;
let JobServiceClass: typeof import('../../src/lib/council/jobs').CouncilJobService;
let RepositoriesClass: typeof import('../../src/lib/council/store').CouncilRepositories;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let openCouncilStoreFn: typeof import('../../src/lib/council/persistence/council-store').openCouncilStore;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDbFn: () => void;

let now = '2026-10-14T12:00:00.000Z';
let idCounter = 0;
const newId = () => `wer014-${(idCounter += 1).toString().padStart(5, '0')}`;
const nowFn = () => now;

const ROUTE_POLICY_SHA256 = 'a'.repeat(64);

const SCOPE: ScopeFields = {
  tenant_id: 'tenant-a',
  company_id: 'company-a',
  installation_id: 'install-a',
  owner_subject: 'owner-1',
};
const RUN_SCOPE = {
  tenant_id: SCOPE.tenant_id,
  company_id: SCOPE.company_id,
  installation_id: SCOPE.installation_id,
};

let store: ReturnType<typeof import('../../src/lib/council/persistence/council-store').openCouncilStore>;
let repositories: CouncilRepositories;
let jobs: CouncilJobService;
let runAuthorization: CouncilRunAuthorizationService;

before(async () => {
  const engineModule = await import('../../src/lib/council/engine');
  WorkerClass = engineModule.CouncilRunWorker;
  const authorizationModule = await import('../../src/lib/council/run-authorization');
  AuthorizationClass = authorizationModule.CouncilRunAuthorizationService;
  const jobModule = await import('../../src/lib/council/jobs');
  JobServiceClass = jobModule.CouncilJobService;
  const storeModule = await import('../../src/lib/council/store');
  RepositoriesClass = storeModule.CouncilRepositories;
  envelopeFromScopeFn = storeModule.envelopeFromScope;
  const contracts = await import('../../src/lib/council/contracts');
  canonicalHashFn = contracts.canonicalHash;
  fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  const adapter = await import('../../src/lib/council/persistence/council-store');
  openCouncilStoreFn = adapter.openCouncilStore;
  const dbModule = await import('../../src/lib/db');
  closeDbFn = dbModule.closeDb;

  store = openCouncilStoreFn();
  repositories = new RepositoriesClass({ adapter: store, now: nowFn, newId });
  jobs = new JobServiceClass({ store, now: nowFn, newId });
  runAuthorization = new AuthorizationClass({ store, now: nowFn, newId });
});

after(() => {
  closeDbFn();
});

// ------------------------------------------------------------------ fixtures

function sampleStored(sessionId: string): CouncilStoredSession {
  const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
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
  return { spec, brief, scope: SCOPE, state, sample: false };
}

function principal(): CouncilPrincipal {
  return {
    subject: 'owner-1',
    tenantKind: 'self',
    channel: 'browser',
    supportAccess: false,
    scope: { ...SCOPE, owner_subject: null },
    tenant: {
      subject: 'owner-1',
      companyId: SCOPE.company_id,
      tenantId: SCOPE.tenant_id,
      installationId: SCOPE.installation_id,
    } as unknown as CouncilPrincipal['tenant'],
  };
}

function ownerEnvelope(): CouncilEnvelope {
  return envelopeFromScopeFn(SCOPE, 'owner-1', 'owner', 'write');
}

function routeSnapshot(): CouncilRouteSelection {
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
      tenantId: SCOPE.tenant_id,
      companyId: SCOPE.company_id,
      installationId: SCOPE.installation_id,
      ownerSubject: SCOPE.owner_subject,
    },
    createdAt: now,
  };
}

function ceilings(overrides: Partial<RunCeilings> = {}): RunCeilings {
  return {
    max_provider_requests: 50,
    max_output_repairs: 9,
    max_transport_retries: 8,
    max_input_tokens: null,
    max_output_tokens: null,
    max_money: { amount_minor: 100_000, currency: 'USD' },
    ...overrides,
  };
}

/** A QUEUED session with an approved grant and one durable council_run job. */
function prepareQueuedRun(sessionId: string): { jobId: string; grantId: string } {
  repositories.createSession(ownerEnvelope(), sampleStored(sessionId));
  repositories.transitionState(ownerEnvelope(), sessionId, 'READY', 0);
  repositories.transitionState(ownerEnvelope(), sessionId, 'QUEUED', 1);
  const preview = runAuthorization.previewRun(principal(), {
    session_id: sessionId,
    route_snapshot: routeSnapshot(),
    route_policy_sha256: ROUTE_POLICY_SHA256,
    ceilings: ceilings(),
  });
  const grant = runAuthorization.approveRun(principal(), preview.preview_id, {
    authority_mode: 'managed_principal',
  });
  const { job } = jobs.enqueueJob(
    { tenant_id: SCOPE.tenant_id, company_id: SCOPE.company_id },
    {
      session_id: sessionId,
      kind: 'council_run',
      idempotency_key: `council-run:${sessionId}:attempt:1`,
      payload: { grant_id: grant.grant_id, attempt: 1 },
    },
  );
  return { jobId: job.id, grantId: grant.grant_id };
}

interface DispatchLog {
  calls: number;
  routes: CouncilRouteSelection[];
}

function acceptedTransport(log: DispatchLog): CouncilRunTransport {
  return {
    async dispatch(input) {
      log.calls += 1;
      log.routes.push(input.route);
      return { status: 'accepted', actual_minor: 0, response_sha256: 'b'.repeat(64) };
    },
  };
}

function newWorker(
  workerId: string,
  transport: CouncilRunTransport | null,
  overrides: { heartbeatMs?: number } = {},
): CouncilRunWorker {
  return new WorkerClass(
    { store, repositories, jobs, runAuthorization },
    {
      workerId,
      transport,
      now: nowFn,
      newId,
      leaseTtlMs: 60_000,
      // Long by default so tests stay deterministic; heartbeats are
      // asserted directly through heartbeatOnce.
      heartbeatMs: overrides.heartbeatMs ?? 60_000,
    },
  );
}

function jobRow(jobId: string): {
  state: string;
  lease_epoch: number;
  checkpoint_json: string | null;
} {
  return store
    .handle()
    .prepare('SELECT state, lease_epoch, checkpoint_json FROM council_jobs WHERE id = ?')
    .get(jobId) as { state: string; lease_epoch: number; checkpoint_json: string | null };
}

function sessionState(
  sessionId: string,
): { state: string; state_version: number; lease_epoch: number } {
  const session = repositories.getSession(ownerEnvelope(), sessionId);
  assert.ok(session, 'session exists');
  return session.state;
}

function attemptRow(
  sessionId: string,
  operationId: string,
): { status: string; outcome_code: string | null } {
  return store
    .handle()
    .prepare(
      `SELECT status, outcome_code FROM council_provider_attempts
        WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND operation_id = ?`,
    )
    .get(SCOPE.tenant_id, SCOPE.company_id, sessionId, operationId) as {
    status: string;
    outcome_code: string | null;
  };
}

function reservationCounts(sessionId: string): { committed: number; reserved: number } {
  const rows = store
    .handle()
    .prepare(
      `SELECT state, COUNT(*) AS n FROM council_budget_reservations
        WHERE tenant_id = ? AND company_id = ? AND session_id = ? GROUP BY state`,
    )
    .all(SCOPE.tenant_id, SCOPE.company_id, sessionId) as Array<{ state: string; n: number }>;
  const pick = (state: string) => rows.find((r) => r.state === state)?.n ?? 0;
  return { committed: pick('committed'), reserved: pick('reserved') };
}

function opId(sessionId: string): string {
  return `council-run:${sessionId}:attempt:1:prepare`;
}

// --------------------------------------------------------------------- tests

test('claim -> heartbeat -> dispatch -> settle -> finish under one fencing generation', async () => {
  now = '2026-10-14T12:00:00.000Z';
  const sessionId = 'sess-wer014-1';
  const { jobId } = prepareQueuedRun(sessionId);
  const log: DispatchLog = { calls: 0, routes: [] };
  const worker = newWorker('worker-a', acceptedTransport(log));

  const summary = await worker.drain();
  assert.equal(summary.available, true, 'a transport is wired');
  assert.equal(summary.claimed, 1);
  assert.equal(summary.jobs[0].outcome, 'succeeded', JSON.stringify(summary));

  const state = sessionState(sessionId);
  assert.equal(state.lease_epoch, 1, 'the claim minted generation 1');
  assert.equal(state.state, 'PREPARING');

  const job = jobRow(jobId);
  assert.equal(job.state, 'succeeded');
  assert.equal(JSON.parse(job.checkpoint_json as string).status, 'accepted');

  assert.equal(log.calls, 1, 'exactly one provider dispatch');
  assert.equal(log.routes[0].routeId, 'route-a');
  assert.equal(
    log.routes[0].providerSlug,
    'provider-a',
    'the dispatch carries the explicitly selected route, never a hidden default',
  );
  assert.equal(log.routes[0].requestedModelOrAlias, 'model-a');

  const attempt = attemptRow(sessionId, opId(sessionId));
  assert.equal(attempt.status, 'accepted');
  assert.deepEqual(reservationCounts(sessionId), { committed: 1, reserved: 0 });
  assert.equal(worker.readiness().available, true);
  worker.stop();
});

test('heartbeat renews the lease only for the current fencing generation', () => {
  now = '2026-10-14T12:10:00.000Z';
  const sessionId = 'sess-wer014-hb';
  prepareQueuedRun(sessionId);
  const worker = newWorker('worker-hb', null);
  const job = jobs.claimDueJob(RUN_SCOPE, { kind: 'council_run', worker_id: 'worker-hb' });
  assert.ok(job);

  const claim = worker.claimSessionLease(ownerEnvelope(), sessionId);
  assert.equal(claim.claimed, true);
  assert.equal(worker.heartbeatOnce(RUN_SCOPE, job, claim), true, 'current generation lives');

  const next = worker.claimSessionLease(ownerEnvelope(), sessionId);
  assert.equal(next.lease_epoch, claim.lease_epoch + 1);
  assert.equal(
    worker.heartbeatOnce(RUN_SCOPE, job, claim),
    false,
    'a stale generation cannot heartbeat',
  );
  assert.equal(worker.heartbeatOnce(RUN_SCOPE, job, next), true);
  // Terminal the probe job so later drains never see it as due.
  store
    .handle()
    .prepare(
      `UPDATE council_jobs SET state = 'succeeded', lease_owner = NULL,
              lease_expires_at = NULL WHERE id = ?`,
    )
    .run(job.id);
  worker.stop();
});

test('two workers: only the current generation commits; the fenced late reply is rejected', async () => {
  now = '2026-10-14T12:20:00.000Z';
  const sessionId = 'sess-wer014-2';
  const { jobId } = prepareQueuedRun(sessionId);

  let releaseA: () => void = () => {};
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let aDispatched: () => void = () => {};
  const dispatchedA = new Promise<void>((resolve) => {
    aDispatched = resolve;
  });
  let aCalls = 0;
  const slowTransport: CouncilRunTransport = {
    async dispatch() {
      aCalls += 1;
      aDispatched();
      await gateA;
      return { status: 'accepted', actual_minor: 0, response_sha256: 'c'.repeat(64) };
    },
  };

  const workerA = newWorker('worker-a', slowTransport);
  const workerB = newWorker('worker-b', acceptedTransport({ calls: 0, routes: [] }));

  const drainA = workerA.drain();
  await dispatchedA;
  assert.equal(aCalls, 1);

  // A's lease expires (crash / partition); B recovers the job.
  store
    .handle()
    .prepare('UPDATE council_jobs SET lease_expires_at = ? WHERE id = ?')
    .run('2026-10-14T12:00:00.000Z', jobId);

  const summaryB = await workerB.drain();
  assert.equal(summaryB.claimed, 1, 'B took the expired job');
  assert.equal(summaryB.jobs[0].outcome, 'succeeded');

  // A's late reply arrives after the generation moved.
  releaseA();
  const summaryA: CouncilRunDrainSummary = await drainA;
  assert.equal(summaryA.jobs[0].outcome, 'fenced', JSON.stringify(summaryA));

  const state = sessionState(sessionId);
  assert.equal(state.lease_epoch, 2, 'B minted generation 2');
  assert.equal(jobRow(jobId).state, 'succeeded');

  const attempt = attemptRow(sessionId, opId(sessionId));
  assert.equal(attempt.status, 'accepted', 'the current generation keeps the accepted result');
  assert.deepEqual(
    reservationCounts(sessionId),
    { committed: 1, reserved: 0 },
    'exactly one settlement; the fenced generation settled nothing',
  );

  const attempts = store
    .handle()
    .prepare(
      `SELECT COUNT(*) AS n FROM council_provider_attempts
        WHERE tenant_id = ? AND company_id = ? AND session_id = ?`,
    )
    .get(SCOPE.tenant_id, SCOPE.company_id, sessionId) as { n: number };
  assert.equal(attempts.n, 1, 'one operation, one attempt row');
  workerA.stop();
  workerB.stop();
});

test('restart recovery: an already-accepted result is not replayed', async () => {
  now = '2026-10-14T12:40:00.000Z';
  const sessionId = 'sess-wer014-3';
  const { jobId } = prepareQueuedRun(sessionId);

  // A worker claimed the job and accepted a result, then died before
  // finishing; its lease is now expired.
  const crashed = newWorker('worker-crashed', null);
  const claimedJob = jobs.claimDueJob(RUN_SCOPE, {
    kind: 'council_run',
    worker_id: 'worker-crashed',
  });
  assert.ok(claimedJob);
  const claim = crashed.claimSessionLease(ownerEnvelope(), sessionId);
  assert.equal(claim.claimed, true);
  const operationId = opId(sessionId);
  store
    .handle()
    .prepare(
      `INSERT INTO council_provider_attempts
         (tenant_id, company_id, session_id, id, job_id, operation_id, seat_id, round,
          provider_id, provider_config_version, model_ref, model_selection_source, status,
          outcome_code, retry_safe, input_tokens, output_tokens, actual_cost_minor, currency,
          request_hash, response_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 'provider-a', 'run-grant', 'model-a', 'explicit',
               'accepted', NULL, 0, 1, 1, 0, 'USD', 'hash-request', 'hash-response', ?, ?)`,
    )
    .run(
      SCOPE.tenant_id,
      SCOPE.company_id,
      sessionId,
      newId(),
      jobId,
      operationId,
      now,
      now,
    );
  store
    .handle()
    .prepare(
      `UPDATE council_jobs SET state = 'running', lease_expires_at = ?
        WHERE id = ?`,
    )
    .run('2026-10-14T12:00:00.000Z', jobId);

  const log: DispatchLog = { calls: 0, routes: [] };
  const recovered = newWorker('worker-recovery', acceptedTransport(log));
  const summary = await recovered.drain();
  assert.equal(summary.jobs[0].outcome, 'recovered', JSON.stringify(summary));
  assert.equal(log.calls, 0, 'an accepted result is never dispatched again');
  assert.equal(jobRow(jobId).state, 'succeeded');
  assert.equal(attemptRow(sessionId, operationId).status, 'accepted');
  recovered.stop();
});

test('cancellation aborts the in-flight transport and fences the late result', async () => {
  now = '2026-10-14T13:00:00.000Z';
  const sessionId = 'sess-wer014-4';
  const { jobId } = prepareQueuedRun(sessionId);

  let dispatched: () => void = () => {};
  const didDispatch = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let aborts = 0;
  const stubbornTransport: CouncilRunTransport = {
    async dispatch(input) {
      dispatched();
      input.signal.addEventListener('abort', () => {
        aborts += 1;
      });
      await gate;
      // A rude provider answers anyway, after the abort.
      return { status: 'accepted', actual_minor: 0 };
    },
  };

  const worker = newWorker('worker-cancel', stubbornTransport);
  const drainP = worker.drain();
  await didDispatch;

  const receipt = worker.cancelSessionRun(ownerEnvelope(), sessionId, {
    reason: 'owner_cancelled',
  });
  assert.equal(receipt.transports_aborted, 1);
  assert.equal(receipt.jobs_cancelled, 1);
  assert.equal(receipt.lease_epoch, 2, 'cancellation bumps the fencing generation');

  release();
  const summary = await drainP;
  assert.equal(summary.jobs[0].outcome, 'fenced', JSON.stringify(summary));
  assert.equal(aborts, 1, 'the supported transport observed the abort');
  assert.equal(jobRow(jobId).state, 'cancelled');
  assert.equal(attemptRow(sessionId, opId(sessionId)).status, 'cancelled');
  assert.deepEqual(
    reservationCounts(sessionId),
    { committed: 0, reserved: 1 },
    'the fenced generation settles nothing; the estimate stays reserved for review',
  );
  worker.stop();
});

test('readiness is false without a wired transport and the job is not executed', async () => {
  now = '2026-10-14T13:20:00.000Z';
  const sessionId = 'sess-wer014-5';
  const { jobId } = prepareQueuedRun(sessionId);

  const worker = newWorker('worker-unwired', null);
  const readiness = worker.readiness();
  assert.equal(readiness.available, false);
  assert.equal(readiness.reason, 'transport_not_configured');

  const summary = await worker.drain();
  assert.equal(summary.available, false);
  assert.equal(summary.claimed, 0);
  assert.equal(jobRow(jobId).state, 'queued', 'no simulated execution: the job stays queued');
  assert.equal(sessionState(sessionId).state, 'QUEUED');
  const attempts = store
    .handle()
    .prepare(
      'SELECT COUNT(*) AS n FROM council_provider_attempts WHERE tenant_id = ? AND company_id = ? AND session_id = ?',
    )
    .get(SCOPE.tenant_id, SCOPE.company_id, sessionId) as { n: number };
  assert.equal(attempts.n, 0, 'nothing was recorded as dispatched');
  worker.stop();
});
