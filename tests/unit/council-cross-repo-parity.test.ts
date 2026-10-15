/**
 * CWE-045 cross-repo parity proof, Command Center side (CWE-049
 * remainder).
 *
 * The ONE canonical RunAuthorizationService must behave identically
 * from the portable runtime and from Command Center consumers: same
 * fences, same reservation semantics, same typed refusals. The
 * scenario definitions live in
 * tests/fixtures/run-authorization-parity-scenarios.json; a
 * byte-identical copy lives in the ONB runtime
 * (runtime/tests/scenarios/) and its runner
 * (run-authorization-parity.test.ts) asserts the same expectations.
 * Both runners pin the scenario file's sha256, so the two sides can
 * never drift into proving different things.
 *
 * Every step outcome is canonical: ok with the named fields, or the
 * typed refusal code. Ids, timestamps, and hashes never appear.
 */
import './_isolated-db';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CouncilPrincipal } from '../../src/lib/council/auth';
import type { RunCeilings, ScopeFields, SessionStateRecord } from '../../src/lib/council/contracts';
import type { CouncilRouteSelection } from '../../src/lib/council/explicit-selection';
import type {
  CouncilRunAuthorizationService,
  CouncilRunAuthorizationError,
} from '../../src/lib/council/run-authorization';
import type { CouncilEnvelope, CouncilRepositories, CouncilStoredSession } from '../../src/lib/council/store';

const SCENARIO_FILE_SHA256 = '1c92d43f6bddd5597244aa99fd4ed60581e78084d2d84e1466c89ef48a20ee56';
const scenarioPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'run-authorization-parity-scenarios.json',
);
const scenarioBytes = readFileSync(scenarioPath);
const scenarios = JSON.parse(scenarioBytes.toString('utf8'));

let ServiceClass: typeof CouncilRunAuthorizationService;
let ErrorClass: typeof CouncilRunAuthorizationError;
let repositories: CouncilRepositories;
let openCouncilStoreFn: typeof import('../../src/lib/council/persistence/council-store').openCouncilStore;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');

let now = '2026-10-14T12:00:00.000Z';
let idCounter = 0;
const newId = () => `cc045-${(idCounter += 1).toString().padStart(4, '0')}`;
const nowFn = () => now;
const ROUTE_POLICY_SHA256 = 'a'.repeat(64);

const SCOPE: ScopeFields = {
  tenant_id: 'tenant-a',
  company_id: 'company-a',
  installation_id: 'install-a',
  owner_subject: 'owner-1',
};
const OTHER_SCOPE: ScopeFields = {
  tenant_id: 'tenant-a',
  company_id: 'company-b',
  installation_id: 'install-b',
  owner_subject: 'owner-2',
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

function sampleStored(sessionId: string, scopeFields: ScopeFields): CouncilStoredSession {
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

interface World {
  service: CouncilRunAuthorizationService;
  store: ReturnType<typeof openCouncilStoreFn>;
  previewId: string | null;
  grantId: string | null;
}

function makeWorld(sessionId: string): World {
  now = '2026-10-14T12:00:00.000Z';
  // idCounter is deliberately NOT reset: every scenario shares the
  // one isolated database, so ids must stay unique across worlds.
  const store = openCouncilStoreFn();
  const service = new ServiceClass({ store, now: nowFn, newId });
  const envelope: CouncilEnvelope = envelopeFromScopeFn(SCOPE, 'owner-1', 'owner', 'write');
  repositories.createSession(envelope, sampleStored(sessionId, SCOPE));
  return { service, store, previewId: null, grantId: null };
}

type Outcome = Record<string, unknown>;

function attempt(fn: () => Outcome): Outcome {
  try {
    return fn();
  } catch (error) {
    // Canonical typed refusals carry the stable Section 17.3 code
    // callers branch on (CouncilRunAuthorizationError in this host).
    // Anything else is an unexpected failure and is recorded as such
    // so the parity diff shows it.
    if (error instanceof ErrorClass) {
      return { ok: false, code: (error as CouncilRunAuthorizationError).code };
    }
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string') return { ok: false, code };
    return { ok: false, code: `UNEXPECTED:${error instanceof Error ? error.message : String(error)}` };
  }
}

function runStep(world: World, sessionId: string, scenarioId: string, step: Record<string, any>): Outcome | null {
  // Operation keys are unique per (tenant, company) in BOTH repos'
  // canonical schemas, so each scenario namespaces its keys; the
  // transcripts stay comparable because outcomes never carry keys.
  const op = (id: string | undefined) => (id === undefined ? undefined : `${scenarioId}:${id}`);
  const defaults = scenarios.defaults;
  switch (step.do) {
    case 'advance_clock_ms':
      now = new Date(Date.parse(now) + step.ms).toISOString();
      return null;
    case 'preview':
      return attempt(() => {
        const preview = world.service.previewRun(principal(), {
          session_id: sessionId,
          purpose: step.purpose,
          route_snapshot: routeSnapshot(),
          route_policy_sha256: ROUTE_POLICY_SHA256,
          ceilings: { ...defaults.ceilings, ...(step.ceilings ?? {}) } as RunCeilings,
        });
        world.previewId = preview.preview_id;
        return { ok: true };
      });
    case 'approve':
      return attempt(() => {
        const grant = world.service.approveRun(principal(), world.previewId!, {
          authority_mode: 'managed_principal',
        });
        world.grantId = grant.grant_id;
        return { ok: true, status: grant.status };
      });
    case 'resolve':
      return attempt(() => {
        const grant = world.service.resolveRunGrant(principal(), world.grantId!, sessionId);
        return grant ? { ok: true, found: true, status: grant.status } : { ok: true, found: false };
      });
    case 'revoke':
      return attempt(() => {
        world.service.revokeRunGrant(principal(), world.grantId!);
        return { ok: true };
      });
    case 'admit':
      return attempt(() => {
        const actor = step.scope === 'other' ? principal('owner-2', OTHER_SCOPE) : principal();
        const admission = world.service.admitOperation(actor, {
          grant_id: world.grantId!,
          session_id: sessionId,
          operation_id: op(step.operation_id),
          kind: step.kind ?? 'provider_request',
          purpose: step.purpose,
          estimate_minor: defaults.estimate_minor,
          currency: defaults.currency,
          lease_epoch: defaults.lease_epoch,
          route_snapshot: routeSnapshot(),
          original_operation_id: op(step.original_operation_id) ?? null,
        });
        return { ok: true, replayed: admission.replayed };
      });
    case 'consume':
      return attempt(() => {
        world.service.recordConsumption(principal(), {
          grant_id: world.grantId!,
          session_id: sessionId,
          operation_id: op(step.operation_id),
          lease_epoch: defaults.lease_epoch,
          outcome: step.outcome,
          actual_minor: step.outcome === 'settled' ? defaults.estimate_minor : undefined,
        });
        return { ok: true };
      });
    case 'count_reservations':
      return attempt(() => {
        const row = world.store
          .handle()
          .prepare('SELECT COUNT(*) AS n FROM council_budget_reservations WHERE session_id = ?')
          .get(sessionId) as { n: number };
        return { ok: true, count: row.n };
      });
    default:
      throw new Error(`unknown parity step: ${step.do}`);
  }
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

test('parity scenario file is the pinned canonical copy', () => {
  const digest = createHash('sha256').update(scenarioBytes).digest('hex');
  assert.equal(digest, SCENARIO_FILE_SHA256);
  assert.equal(scenarios.schema, 'wise-elders.run-authorization-parity/v1');
  for (const scenario of scenarios.scenarios) {
    for (const step of scenario.steps) {
      if (step.do !== 'advance_clock_ms') {
        assert.ok(step.expect, `${scenario.id} step (${step.do}) must pin an expected outcome`);
      }
    }
  }
});

test('run authorization parity scenarios (Command Center)', () => {
  const transcript: Array<Record<string, unknown>> = [];
  scenarios.scenarios.forEach((scenario: Record<string, any>, scenarioIndex: number) => {
    const sessionId = `sess-parity-${scenarioIndex}`;
    const world = makeWorld(sessionId);
    scenario.steps.forEach((step: Record<string, any>, index: number) => {
      const outcome = runStep(world, sessionId, scenario.id, step);
      if (outcome === null) return;
      transcript.push({ scenario: scenario.id, step: index, do: step.do, outcome });
      if (step.expect) {
        assert.deepEqual(
          outcome,
          step.expect,
          `${scenario.id} step ${index} (${step.do}) outcome must equal the pinned expectation`,
        );
      }
    });
  });
  if (process.env.PARITY_TRANSCRIPT_OUT) {
    writeFileSync(process.env.PARITY_TRANSCRIPT_OUT, `${JSON.stringify(transcript, null, 2)}\n`);
  }
});
