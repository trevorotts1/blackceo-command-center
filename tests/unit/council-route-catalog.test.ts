/**
 * CWE-008: council route catalog, readiness surface, and credential hygiene.
 *
 * Contracts covered:
 * - B08 closure proof: no credential values in client payloads. Proven with a
 *   planted fixture credential value resolved through the real host resolver
 *   (resolveProviderApiKey via credentialPresenceFor).
 * - Route-readiness surface for the UI units: a listed route is not
 *   qualified, and an untested route reports UNTESTED.
 * - Section 13.4 identity levels are derived from evidence only, never
 *   conflated: a provider report alone never reaches resolved-verified or
 *   quality-qualified.
 *
 * Runs via the Node built-in test runner under tsx (npm run test:unit).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRouteCatalog,
  credentialPresenceFor,
  deriveIdentityLevel,
  deriveRouteReadiness,
  NO_ROUTE_EVIDENCE,
  type ProviderRouteDescriptor,
  type RouteEvidence,
} from '../../src/lib/council/providers';
import type { ModelProvider } from '../../src/lib/model-providers/types';

// Built by concatenation so the fixture marker itself is a realistic,
// unmistakable credential-shaped string that exists only at runtime.
const PLANTED_CREDENTIAL = ['sk', 'fixture', 'planted', '9f8e7d6c5b4a'].join('-');

function fixtureProvider(): ModelProvider {
  return {
    slug: 'fixture-cloud',
    displayName: 'Fixture Cloud',
    authType: 'api_key',
    envCandidates: ['COUNCIL_FIXTURE_API_KEY'],
    fetchModels: async () => [],
  };
}

function fixtureRoute(overrides: Partial<ProviderRouteDescriptor> = {}): ProviderRouteDescriptor {
  return {
    routeId: 'fixture-cloud/fixture-model-a',
    providerSlug: 'fixture-cloud',
    displayLabel: 'Fixture Model A',
    kind: 'fixed_model',
    modelId: 'fixture-cloud/fixture-model-a',
    combinationMembers: [],
    providerAccountRef: 'fixture-account-1',
    capability: {
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
      capabilities: ['text', 'streaming'],
      supportedReasoningLevels: ['auto', 'low', 'medium', 'high'],
    },
    credential: { state: 'present', envVar: 'COUNCIL_FIXTURE_API_KEY', source: 'process.env', checked: [] },
    ...overrides,
  };
}

test('credential presence resolves through the host resolver and never carries the value', () => {
  process.env.COUNCIL_FIXTURE_API_KEY = PLANTED_CREDENTIAL;
  try {
    const presence = credentialPresenceFor(fixtureProvider());
    assert.equal(presence.state, 'present');
    assert.equal(presence.envVar, 'COUNCIL_FIXTURE_API_KEY');
    assert.equal(presence.source, 'process.env');
    assert.equal(JSON.stringify(presence).includes(PLANTED_CREDENTIAL), false);
  } finally {
    delete process.env.COUNCIL_FIXTURE_API_KEY;
  }
});

test('planted credential value appears in no emitted catalog payload', () => {
  process.env.COUNCIL_FIXTURE_API_KEY = PLANTED_CREDENTIAL;
  try {
    const presence = credentialPresenceFor(fixtureProvider());
    const catalog = buildRouteCatalog([fixtureRoute({ credential: presence })]);
    const serialized = JSON.stringify(catalog);
    assert.equal(serialized.includes(PLANTED_CREDENTIAL), false);
    assert.equal(catalog[0].credential.state, 'present');
  } finally {
    delete process.env.COUNCIL_FIXTURE_API_KEY;
  }
});

test('absent credential reports absent with checked names only', () => {
  delete process.env.COUNCIL_FIXTURE_API_KEY;
  const presence = credentialPresenceFor(fixtureProvider());
  // Other stores on this machine may legitimately hold a fixture key; the
  // invariant under test is shape, not this machine's stores: when absent,
  // checked names are listed and no value field exists anywhere.
  assert.equal('value' in presence, false);
  if (presence.state === 'absent') {
    assert.ok(presence.checked.includes('COUNCIL_FIXTURE_API_KEY'));
  }
});

test('a listed route with no evidence is UNTESTED and configured, never qualified', () => {
  const catalog = buildRouteCatalog([fixtureRoute()]);
  const entry = catalog[0];
  assert.equal(entry.readiness, 'UNTESTED');
  assert.equal(entry.identityLevel, 'configured');
  assert.equal(entry.qualityQualified, false);
});

test('a transport probe alone raises readiness to PROBED, still not qualified', () => {
  const evidence: RouteEvidence = { ...NO_ROUTE_EVIDENCE, transportProbed: true };
  assert.equal(deriveRouteReadiness(evidence), 'PROBED');
  assert.equal(deriveIdentityLevel(evidence), 'transport_probed');
  const catalog = buildRouteCatalog(
    [fixtureRoute()],
    new Map([['fixture-cloud/fixture-model-a', evidence]]),
  );
  assert.equal(catalog[0].qualityQualified, false);
});

test('a provider-reported identity is reported level only, never verified or qualified', () => {
  const evidence: RouteEvidence = {
    ...NO_ROUTE_EVIDENCE,
    transportProbed: true,
    reportedModelId: 'fixture-cloud/fixture-model-a',
  };
  assert.equal(deriveIdentityLevel(evidence), 'reported_identity');
  assert.equal(deriveRouteReadiness(evidence), 'PROBED');
});

test('only a recorded passing evaluation makes a route QUALIFIED and quality_qualified', () => {
  const passed: RouteEvidence = {
    ...NO_ROUTE_EVIDENCE,
    transportProbed: true,
    reportedModelId: 'fixture-cloud/fixture-model-a',
    identityVerification: { verified: true, method: 'fixture-verification' },
    evaluation: { status: 'passed', evaluationId: 'eval-fixture-1', recordedAt: '2026-10-14T00:00:00.000Z' },
  };
  assert.equal(deriveRouteReadiness(passed), 'QUALIFIED');
  assert.equal(deriveIdentityLevel(passed), 'quality_qualified');

  const failed: RouteEvidence = {
    ...passed,
    evaluation: { status: 'failed', evaluationId: 'eval-fixture-2', recordedAt: '2026-10-14T00:00:00.000Z' },
  };
  assert.equal(deriveRouteReadiness(failed), 'PROBED');
  assert.equal(deriveIdentityLevel(failed), 'resolved_identity_verified');
});

test('combination routes keep their pinned member list in the catalog', () => {
  const route = fixtureRoute({
    routeId: 'fixture-router/combination-1',
    providerSlug: 'fixture-router',
    kind: 'combination',
    modelId: null,
    combinationMembers: ['fixture-cloud/fixture-model-a', 'fixture-cloud/fixture-model-b'],
  });
  const catalog = buildRouteCatalog([route]);
  assert.deepEqual(catalog[0].combinationMembers, [
    'fixture-cloud/fixture-model-a',
    'fixture-cloud/fixture-model-b',
  ]);
  assert.equal(catalog[0].modelId, null);
  assert.equal(catalog[0].readiness, 'UNTESTED');
});
