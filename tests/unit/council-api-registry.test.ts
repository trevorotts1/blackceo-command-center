/**
 * council-api-registry.test.ts — CWE-029 endpoint contract registry
 * (src/lib/council/api/registry.ts), directive Sections 11.6, 17.2,
 * 17.5, 17.6.
 *
 * Proves the registry is complete against the Section 17 surface:
 * every endpoint from the Section 17.2 inventory plus the four
 * Section 17.5 run-authorization endpoints is registered exactly
 * once, every entry is a valid canonical CWE-003 EndpointContract,
 * the foundation-ready set is exactly the safe reads plus draft
 * creation and brief revision, and every not-ready entry names a
 * real owning unit other than CWE-029. Also proves the Section 17.3
 * error envelope shape and the FEATURE_NOT_READY discipline: typed
 * code, owning unit named, no identifier fields that look real.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/council-api-registry.test.ts
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNCIL_ENDPOINT_REGISTRY,
  endpointById,
  endpointByRoute,
  registrySummary,
} from '../../src/lib/council/api/registry';
import {
  errorResponse,
  featureNotReady,
  translateError,
} from '../../src/lib/council/api/errors';
import { validateEndpointContract } from '../../src/lib/council/contracts';
import { CouncilPersistenceError } from '../../src/lib/council/store';
import { CouncilAuthError } from '../../src/lib/council/auth';

/** The full Section 17 surface: 17.2 inventory + 17.5 run-authorization. */
const EXPECTED_SURFACE: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/api/council/capabilities'],
  ['GET', '/api/council/advisors'],
  ['GET', '/api/council/models'],
  ['POST', '/api/council/models/probe'],
  ['GET', '/api/council/sessions'],
  ['POST', '/api/council/sessions'],
  ['GET', '/api/council/sessions/:id'],
  ['PATCH', '/api/council/sessions/:id/brief'],
  ['POST', '/api/council/sessions/:id/start'],
  ['POST', '/api/council/sessions/:id/pause'],
  ['POST', '/api/council/sessions/:id/cancel'],
  ['POST', '/api/council/sessions/:id/resume'],
  ['GET', '/api/council/sessions/:id/events'],
  ['GET', '/api/council/sessions/:id/evidence/:evidenceId'],
  ['GET', '/api/council/sessions/:id/verdict'],
  ['POST', '/api/council/sessions/:id/decision'],
  ['POST', '/api/council/sessions/:id/action-plan/preview'],
  ['POST', '/api/council/sessions/:id/action-plan/approve'],
  ['POST', '/api/council/sessions/:id/action-plan/create'],
  ['POST', '/api/council/sessions/:id/follow-up'],
  ['POST', '/api/council/sessions/:id/rerun'],
  ['POST', '/api/council/sessions/:id/outcomes'],
  ['POST', '/api/council/exports'],
  ['GET', '/api/council/exports/:exportId'],
  ['POST', '/api/council/sessions/:id/archive'],
  ['DELETE', '/api/council/sessions/:id'],
  ['GET', '/api/council/settings'],
  ['PATCH', '/api/council/settings'],
  ['POST', '/api/council/sessions/:id/run-authorization/preview'],
  ['POST', '/api/council/sessions/:id/run-authorization/approve'],
  ['GET', '/api/council/sessions/:id/run-authorization'],
  ['POST', '/api/council/sessions/:id/run-authorization/revoke'],
];

const EXPECTED_READY: ReadonlySet<string> = new Set([
  'council.capabilities.get',
  'council.advisors.get',
  'council.models.get',
  'council.sessions.list',
  'council.sessions.create',
  'council.sessions.get',
  'council.sessions.brief.patch',
  'council.sessions.verdict.get',
  'council.models.probe',
  // CWE-050 graduation: every endpoint whose owning service exists
  // in this tree is now ready and bound at the composition root.
  // CWE-045 graduation: council.models.probe is ready too; its probe
  // executor (model-probe.ts) composes the CWE-008 catalog, the
  // CWE-049 capability_probe grant fences, and the host connectors'
  // optional chat transport.
  'council.sessions.events.get',
  'council.sessions.evidence.get',
  'council.sessions.start',
  'council.sessions.pause',
  'council.sessions.cancel',
  'council.sessions.resume',
  'council.sessions.run_authorization.preview',
  'council.sessions.run_authorization.approve',
  'council.sessions.run_authorization.get',
  'council.sessions.run_authorization.revoke',
  'council.sessions.decision',
  'council.sessions.follow_up',
  'council.sessions.rerun',
  'council.sessions.outcomes',
  'council.sessions.action_plan.preview',
  'council.sessions.action_plan.approve',
  'council.sessions.action_plan.create',
  'council.exports.create',
  'council.exports.get',
  'council.sessions.archive',
  'council.sessions.delete',
  'council.settings.get',
  'council.settings.patch',
]);

test('registry covers the entire Section 17 surface exactly once', () => {
  const actual = COUNCIL_ENDPOINT_REGISTRY.map(
    (item) => `${item.contract.method} ${item.contract.path}`,
  );
  const expected = EXPECTED_SURFACE.map(([method, path]) => `${method} ${path}`);
  assert.deepEqual([...actual].sort(), [...expected].sort());
  assert.equal(new Set(actual).size, actual.length, 'no duplicate routes');
  const ids = COUNCIL_ENDPOINT_REGISTRY.map((item) => item.contract.contract_id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate contract ids');
});

test('every registry entry is a valid canonical EndpointContract', () => {
  for (const item of COUNCIL_ENDPOINT_REGISTRY) {
    const check = validateEndpointContract(item.contract);
    assert.ok(check.ok, `${item.contract.contract_id}: ${JSON.stringify(check)}`);
    assert.equal(item.contract.schema_version, 'wise-elders.endpoint-contract/v1');
    assert.ok(item.contract.service_owner.length > 0);
    assert.ok(item.contract.contract_test_gate.length > 0);
    assert.ok(item.contract.live_integration_gate.length > 0);
    if (item.contract.method === 'GET') {
      assert.equal(item.contract.idempotency, 'safe_read', item.contract.contract_id);
    } else {
      assert.equal(item.contract.idempotency, 'required_key', item.contract.contract_id);
    }
  }
});

test('the ready set is exactly the foundation safe reads and draft writes', () => {
  const ready = COUNCIL_ENDPOINT_REGISTRY.filter((i) => i.readiness === 'ready').map(
    (i) => i.contract.contract_id,
  );
  assert.deepEqual([...ready].sort(), [...EXPECTED_READY].sort());
  const summary = registrySummary();
  assert.equal(summary.total, EXPECTED_SURFACE.length);
  assert.equal(summary.ready, EXPECTED_READY.size);
  assert.equal(summary.not_ready, EXPECTED_SURFACE.length - EXPECTED_READY.size);
});

test('every not-ready entry names its real owning unit (Section 17.5)', () => {
  const expectedOwners: Record<string, string> = {
    'council.models.probe': 'CWE-009',
    'council.sessions.start': 'CWE-027',
    'council.sessions.pause': 'CWE-027',
    'council.sessions.cancel': 'CWE-027',
    'council.sessions.resume': 'CWE-027',
    'council.sessions.events.get': 'CWE-030',
    'council.sessions.evidence.get': 'CWE-025',
    'council.sessions.decision': 'CWE-050',
    'council.sessions.action_plan.preview': 'CWE-036',
    'council.sessions.action_plan.approve': 'CWE-036',
    'council.sessions.action_plan.create': 'CWE-036',
    'council.sessions.follow_up': 'CWE-050',
    'council.sessions.rerun': 'CWE-050',
    'council.sessions.outcomes': 'CWE-050',
    'council.exports.create': 'CWE-038',
    'council.exports.get': 'CWE-038',
    'council.sessions.archive': 'CWE-050',
    'council.sessions.delete': 'CWE-050',
    'council.settings.get': 'CWE-050',
    'council.settings.patch': 'CWE-050',
    'council.sessions.run_authorization.preview': 'CWE-049',
    'council.sessions.run_authorization.approve': 'CWE-049',
    'council.sessions.run_authorization.get': 'CWE-049',
    'council.sessions.run_authorization.revoke': 'CWE-049',
  };
  for (const item of COUNCIL_ENDPOINT_REGISTRY) {
    if (item.readiness === 'ready') continue;
    const expected = expectedOwners[item.contract.contract_id];
    assert.ok(expected, `missing owner expectation for ${item.contract.contract_id}`);
    assert.equal(item.owning_unit, expected, item.contract.contract_id);
  }
});

test('registry lookups resolve by id and by method + path template', () => {
  assert.equal(endpointById('council.sessions.create').contract.method, 'POST');
  assert.equal(
    endpointByRoute('PATCH', '/api/council/sessions/:id/brief')?.contract.contract_id,
    'council.sessions.brief.patch',
  );
  assert.equal(endpointByRoute('GET', '/api/council/nope'), null);
  assert.throws(() => endpointById('council.nope'), /Unknown council endpoint contract id/);
});

test('FEATURE_NOT_READY: typed envelope, owning unit named, no real-looking IDs', async () => {
  const response = errorResponse(featureNotReady('CWE-027', 'Council session run start'), 'req-1');
  assert.equal(response.status, 501);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'ok']);
  assert.deepEqual(Object.keys(body.error).sort(), [
    'action',
    'code',
    'message',
    'request_id',
    'retryable',
  ]);
  assert.equal(body.error.code, 'FEATURE_NOT_READY');
  assert.equal(body.error.retryable, false);
  assert.match(body.error.message, /CWE-027/);
  assert.match(body.error.message, /No operation was performed/);
  const serialized = JSON.stringify(body);
  assert.ok(!/session_id|export_id|task_id|grant_id/.test(serialized.replace('request_id', '')));
});

test('error translation passes canonical codes through with mapped statuses', () => {
  const notFound = translateError(
    new CouncilPersistenceError('PERSISTENCE_SESSION_NOT_FOUND', 'missing'),
  );
  assert.equal(notFound.code, 'PERSISTENCE_SESSION_NOT_FOUND');
  assert.equal(notFound.status, 404);
  const deferred = translateError(
    new CouncilPersistenceError('PERSISTENCE_STORE_DEFERRED', 'locked', { retryable: true }),
  );
  assert.equal(deferred.status, 503);
  assert.equal(deferred.retryable, true);
  const notConfigured = translateError(
    new CouncilAuthError(
      'COUNCIL_AUTH_NOT_CONFIGURED',
      'Council authorization is not configured on this installation.',
      503,
    ),
  );
  assert.equal(notConfigured.code, 'COUNCIL_AUTH_NOT_CONFIGURED');
  assert.equal(notConfigured.status, 503);
  const unknown = translateError(new Error('boom'));
  assert.equal(unknown.code, 'INTERNAL_ERROR');
  assert.equal(unknown.status, 500);
  assert.ok(!unknown.message.includes('boom'), 'internal messages are not leaked');
});
