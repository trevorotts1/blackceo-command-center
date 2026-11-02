/**
 * CTR-191 focused contract check for the composed Council run transport.
 *
 * RUN (deliberately NOT run by the repair session):
 *
 *   node --import tsx scripts/council/check-run-transport-composition.ts
 *
 * No database, no network, no provider call, no secret read. Every case is a
 * refusal that happens BEFORE a request leaves the box, so the check proves
 * the typed failure surface without spending a provider request.
 */
import assert from 'node:assert/strict';
import type { CouncilRouteSelection } from '../../src/lib/council/explicit-selection';
import type { CouncilRunTransportDispatch } from '../../src/lib/council/engine';
import {
  CouncilRunTransportRefusal,
  createConfiguredCouncilRunTransport,
} from '../../src/lib/council/run-transport';

function route(overrides: Partial<CouncilRouteSelection> = {}): CouncilRouteSelection {
  return {
    schema: 'wise-elders.route-selection/v1',
    selectionSource: 'explicit',
    routeId: 'route-test',
    routeRevision: 1,
    routeKind: 'fixed_model',
    providerSlug: 'provider-not-installed',
    requestedRoute: 'route-test',
    requestedModelOrAlias: 'provider-not-installed/model-test',
    combinationMembers: null,
    reasoning: { requested: null, applied: null, supported: null, limitation: null },
    fallbackPolicy: 'none',
    providerAccountRef: null,
    capabilitySnapshot: {
      contextWindowTokens: 1,
      maxOutputTokens: 1,
      capabilities: ['text'],
      supportedReasoningLevels: null,
    },
    credential: { state: 'present', envVar: 'TEST_API_KEY', source: 'process.env', checked: [] },
    identityLevel: 'configured',
    scope: {
      tenantId: 'tenant-test',
      companyId: 'company-test',
      installationId: 'install-test',
      ownerSubject: 'owner-test',
    },
    createdAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  };
}

function dispatch(overrides: Partial<CouncilRouteSelection> = {}): CouncilRunTransportDispatch {
  return {
    tenant_id: 'tenant-test',
    company_id: 'company-test',
    installation_id: 'install-test',
    session_id: 'session-test',
    job_id: 'job-test',
    operation_id: 'op-test',
    attempt: 1,
    lease_epoch: 1,
    route: route(overrides),
    signal: new AbortController().signal,
  };
}

async function expectRefusal(
  transport: ReturnType<typeof createConfiguredCouncilRunTransport>,
  input: CouncilRunTransportDispatch,
  code: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await transport.dispatch(input);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof CouncilRunTransportRefusal, `expected a typed refusal for ${code}`);
  assert.equal((caught as CouncilRunTransportRefusal).code, code);
}

async function main(): Promise<void> {
  const transport = createConfiguredCouncilRunTransport();
  assert.equal(typeof transport.dispatch, 'function', 'transport exposes dispatch');

  // 1. No store composed => refuse before any request.
  await expectRefusal(transport, dispatch(), 'RUN_TRANSPORT_STORE_NOT_COMPOSED');

  // 2. Aborted before dispatch => typed refusal, not a fake result.
  const aborted = new AbortController();
  aborted.abort();
  await expectRefusal(
    createConfiguredCouncilRunTransport({ store: undefined }),
    { ...dispatch(), signal: aborted.signal },
    'RUN_TRANSPORT_ABORTED',
  );

  // 3. A non-explicit route is never resolved to a default.
  await expectRefusal(
    transport,
    dispatch({ selectionSource: 'client_default' }),
    'RUN_ROUTE_NOT_EXPLICIT',
  );

  // 4. A combination route is refused, never collapsed to one member.
  await expectRefusal(
    transport,
    dispatch({ routeKind: 'combination' }),
    'RUN_ROUTE_COMBINATION_UNSUPPORTED',
  );

  // 5. A fallback-permitting grant is refused: only the pinned route runs.
  await expectRefusal(
    transport,
    dispatch({ fallbackPolicy: 'client_approved_only' }),
    'RUN_ROUTE_FALLBACK_REFUSED',
  );

  console.log('check-run-transport-composition: OK (refusals only; no provider request)');
}

void main();
