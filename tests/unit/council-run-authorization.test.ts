/**
 * CWE-049 tests: the managed run authorization adapter
 * (src/lib/council/run-authorization.ts), the Command Center form of
 * the ONE canonical RunAuthorizationService, over the real host store
 * (isolated DATABASE_PATH, getDb() migration chain, CWE-006
 * repositories, CWE-005 adapter) with a deterministic fake clock.
 *
 * Mirrors the portable service's Section 35.14 contracts (T135-T142)
 * for the managed host: full lifecycle with consumption reconciliation
 * against the reservation rows, standing-grant satisfaction without
 * broadening, revocation fencing including admission replays, expiry,
 * cross-scope and purpose negatives, and the journal hash chain over
 * the whole lifecycle (verified through CWE-006's verifyChain).
 */
import './_isolated-db';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import type { CouncilPrincipal } from '../../src/lib/council/auth';
import type {
  RunCeilings,
  ScopeFields,
  SessionStateRecord,
} from '../../src/lib/council/contracts';
import type { CouncilRouteSelection } from '../../src/lib/council/explicit-selection';
import type {
  CouncilRunAuthorizationService,
  CouncilRunAuthorizationError,
} from '../../src/lib/council/run-authorization';
import type {
  CouncilEnvelope,
  CouncilRepositories,
  CouncilStoredSession,
} from '../../src/lib/council/store';

let ServiceClass: typeof CouncilRunAuthorizationService;
let ErrorClass: typeof CouncilRunAuthorizationError;
let repositories: CouncilRepositories;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let openCouncilStoreFn: typeof import('../../src/lib/council/persistence/council-store').openCouncilStore;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');

let now = '2026-10-14T12:00:00.000Z';
let idCounter = 0;
const newId = () => `cc049-${(idCounter += 1).toString().padStart(4, '0')}`;
const nowFn = () => now;

function advanceClock(ms: number): void {
  now = new Date(Date.parse(now) + ms).toISOString();
}

const ROUTE_POLICY_SHA256 = 'a'.repeat(64);

function makeService(): CouncilRunAuthorizationService {
  return new ServiceClass({
    store: openCouncilStoreFn(),
    now: nowFn,
    newId,
  });
}

function sampleStored(
  sessionId: string,
  scopeFields: ScopeFields,
): CouncilStoredSession {
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
  return { spec, brief, scope: scopeFields, state, sample: false };
}

const SCOPE: ScopeFields = {
  tenant_id: 'tenant-a',
  company_id: 'company-a',
  installation_id: 'install-a',
  owner_subject: 'owner-1',
};

function principal(subject = 'owner-1', scopeFields: ScopeFields = SCOPE): CouncilPrincipal {
  return {
    subject,
    tenantKind: 'self',
    channel: 'browser',
    supportAccess: false,
    scope: { ...scopeFields, owner_subject: null },
    tenant: {
      subject,
      companyId: scopeFields.company_id,
      tenantId: scopeFields.tenant_id,
      installationId: scopeFields.installation_id,
    } as unknown as CouncilPrincipal['tenant'],
  };
}

function ownerEnvelope(scopeFields: ScopeFields = SCOPE): CouncilEnvelope {
  return envelopeFromScopeFn(scopeFields, 'owner-1', 'owner', 'write');
}

function routeSnapshot(scopeFields: ScopeFields = SCOPE): CouncilRouteSelection {
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
      tenantId: scopeFields.tenant_id,
      companyId: scopeFields.company_id,
      installationId: scopeFields.installation_id,
      ownerSubject: scopeFields.owner_subject,
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

function setupSession(sessionId: string, scopeFields: ScopeFields = SCOPE) {
  const session = sampleStored(sessionId, scopeFields);
  repositories.createSession(ownerEnvelope(scopeFields), session);
  return session;
}

function previewAndApprove(
  service: CouncilRunAuthorizationService,
  session: CouncilStoredSession,
  overrides: { ceilings?: RunCeilings } = {},
) {
  const preview = service.previewRun(principal(), {
    session_id: session.spec.session_id,
    route_snapshot: routeSnapshot(session.scope),
    route_policy_sha256: ROUTE_POLICY_SHA256,
    ceilings: overrides.ceilings ?? ceilings(),
  });
  const grant = service.approveRun(principal(), preview.preview_id, {
    authority_mode: 'managed_principal',
  });
  return { preview, grant };
}

function isCode(code: string) {
  return (error: unknown) =>
    error instanceof ErrorClass && (error as CouncilRunAuthorizationError).code === code;
}

before(async () => {
  const serviceModule = await import('../../src/lib/council/run-authorization');
  ServiceClass = serviceModule.CouncilRunAuthorizationService;
  ErrorClass = serviceModule.CouncilRunAuthorizationError;
  const store = await import('../../src/lib/council/store');
  envelopeFromScopeFn = store.envelopeFromScope;
  const adapter = await import('../../src/lib/council/persistence/council-store');
  openCouncilStoreFn = adapter.openCouncilStore;
  const contracts = await import('../../src/lib/council/contracts');
  canonicalHashFn = contracts.canonicalHash;
  fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  repositories = new store.CouncilRepositories({ now: nowFn, newId });
});

test('managed lifecycle: preview, approve, resolve, admit, consume, reconcile, chain intact', () => {
  now = '2026-10-14T12:00:00.000Z';
  const service = makeService();
  const session = setupSession('sess-cc-1');
  const { preview, grant } = previewAndApprove(service, session, {
    ceilings: ceilings({ max_provider_requests: 3 }),
  });
  assert.equal(
    Date.parse(preview.expires_at) - Date.parse(preview.created_at),
    15 * 60_000,
  );
  assert.equal(grant.authority_mode, 'managed_principal');
  assert.equal(
    Date.parse(grant.expires_at) - Date.parse(grant.created_at),
    24 * 3_600_000,
  );
  assert.deepEqual(
    service.resolveRunGrant(principal(), grant.grant_id, 'sess-cc-1')?.grant_id,
    grant.grant_id,
  );
  const admit = (operationId: string) =>
    service.admitOperation(principal(), {
      grant_id: grant.grant_id,
      session_id: 'sess-cc-1',
      operation_id: operationId,
      kind: 'provider_request',
      estimate_minor: 100,
      currency: 'USD',
      lease_epoch: 0,
      route_snapshot: routeSnapshot(),
    });
  const a1 = admit('op-1');
  assert.equal(a1.state, 'reserved');
  assert.equal(admit('op-1').replayed, true);
  admit('op-2');
  admit('op-3');
  assert.throws(() => admit('op-4'), isCode('BUDGET_EXHAUSTED'));
  const consumption = service.recordConsumption(principal(), {
    grant_id: grant.grant_id,
    session_id: 'sess-cc-1',
    operation_id: 'op-1',
    lease_epoch: 0,
    outcome: 'settled',
    actual_minor: 90,
  });
  assert.equal(consumption.state, 'committed');
  assert.equal(consumption.totals.committed_actual_minor, 90);
  assert.equal(consumption.totals.outstanding_minor, 290);
  const chain = repositories.verifyChain(ownerEnvelope(), 'sess-cc-1');
  assert.equal(chain.ok, true, 'grant lifecycle events extend the same hash chain');
});

test('managed revocation fences replays; standing grant satisfies without broadening; expiry binds', () => {
  now = '2026-10-14T12:00:00.000Z';
  const service = makeService();
  const session = setupSession('sess-cc-2');
  const { grant } = previewAndApprove(service, session);
  service.admitOperation(principal(), {
    grant_id: grant.grant_id,
    session_id: 'sess-cc-2',
    operation_id: 'op-f1',
    kind: 'provider_request',
    estimate_minor: 100,
    currency: 'USD',
    lease_epoch: 0,
    route_snapshot: routeSnapshot(),
  });
  service.revokeRunGrant(principal(), grant.grant_id);
  assert.equal(service.resolveRunGrant(principal(), grant.grant_id, 'sess-cc-2'), null);
  assert.throws(
    () =>
      service.admitOperation(principal(), {
        grant_id: grant.grant_id,
        session_id: 'sess-cc-2',
        operation_id: 'op-f1',
        kind: 'provider_request',
        estimate_minor: 100,
        currency: 'USD',
        lease_epoch: 0,
        route_snapshot: routeSnapshot(),
      }),
    isCode('RUN_GRANT_INACTIVE'),
    'replay of an earlier admission is fenced after revocation',
  );

  // Standing path.
  const parent = service.provisionStandingAuthorization(principal(), {
    purpose: 'council_run',
    route_policy_sha256: ROUTE_POLICY_SHA256,
    pack_version: session.spec.source_pack_version,
    seat_ids: [...session.spec.seat_ids],
    ceilings: ceilings(),
    expires_at: '2026-10-15T00:00:00.000Z',
  });
  const preview = service.previewRun(principal(), {
    session_id: 'sess-cc-2',
    route_snapshot: routeSnapshot(),
    route_policy_sha256: ROUTE_POLICY_SHA256,
    ceilings: ceilings({ max_provider_requests: 5 }),
  });
  const child = service.approveRun(principal(), preview.preview_id, {
    authority_mode: 'existing_standing_grant',
    standing_parent_grant_id: parent.grant_id,
  });
  assert.equal(child.authority_mode, 'existing_standing_grant');
  assert.equal(child.standing_parent_grant_id, parent.grant_id);
  assert.equal(child.ceilings.max_provider_requests, 5);
  assert.ok(Date.parse(child.expires_at) <= Date.parse(parent.expires_at));

  // Broader than the parent: refused.
  const narrowParent = service.provisionStandingAuthorization(principal(), {
    purpose: 'council_run',
    route_policy_sha256: ROUTE_POLICY_SHA256,
    pack_version: session.spec.source_pack_version,
    seat_ids: [...session.spec.seat_ids],
    ceilings: ceilings({ max_money: { amount_minor: 10, currency: 'USD' } }),
    expires_at: '2026-10-15T00:00:00.000Z',
  });
  const bigPreview = service.previewRun(principal(), {
    session_id: 'sess-cc-2',
    route_snapshot: routeSnapshot(),
    route_policy_sha256: ROUTE_POLICY_SHA256,
    ceilings: ceilings(),
  });
  assert.throws(
    () =>
      service.approveRun(principal(), bigPreview.preview_id, {
        authority_mode: 'existing_standing_grant',
        standing_parent_grant_id: narrowParent.grant_id,
      }),
    isCode('RUN_GRANT_PARENT_INVALID'),
  );

  // Grant expiry: 24h later the child no longer resolves or admits.
  advanceClock(24 * 3_600_000 + 1);
  assert.equal(service.resolveRunGrant(principal(), child.grant_id, 'sess-cc-2'), null);
  now = '2026-10-14T12:00:00.000Z';
});

test('managed negatives: local mode refused here, cross-scope invisible, purpose bound', () => {
  now = '2026-10-14T12:00:00.000Z';
  const service = makeService();
  const session = setupSession('sess-cc-3');
  const preview = service.previewRun(principal(), {
    session_id: 'sess-cc-3',
    route_snapshot: routeSnapshot(),
    route_policy_sha256: ROUTE_POLICY_SHA256,
    ceilings: ceilings(),
  });
  assert.throws(
    () =>
      service.approveRun(principal(), preview.preview_id, {
        authority_mode: 'local_interactive_owner',
      }),
    isCode('RUN_AUTHORITY_MODE_MISMATCH'),
  );
  const grant = service.approveRun(principal(), preview.preview_id, {
    authority_mode: 'managed_principal',
  });
  // Another installation's principal cannot resolve the grant.
  const foreign = principal('owner-1', {
    ...SCOPE,
    installation_id: 'install-b',
  });
  assert.equal(service.resolveRunGrant(foreign, grant.grant_id, 'sess-cc-3'), null);
  // Purpose mismatch at admission.
  assert.throws(
    () =>
      service.admitOperation(principal(), {
        grant_id: grant.grant_id,
        session_id: 'sess-cc-3',
        operation_id: 'op-p1',
        kind: 'provider_request',
        purpose: 'follow_up',
        estimate_minor: 100,
        currency: 'USD',
        lease_epoch: 0,
        route_snapshot: routeSnapshot(),
      }),
    isCode('RUN_GRANT_PURPOSE_MISMATCH'),
  );
  // A fabricated grant id admits nothing.
  assert.throws(
    () =>
      service.admitOperation(principal(), {
        grant_id: 'grant-fabricated',
        session_id: 'sess-cc-3',
        operation_id: 'op-p2',
        kind: 'provider_request',
        estimate_minor: 100,
        currency: 'USD',
        lease_epoch: 0,
        route_snapshot: routeSnapshot(),
      }),
    isCode('RUN_GRANT_NOT_FOUND'),
  );
});
