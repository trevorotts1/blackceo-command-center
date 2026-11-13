/**
 * BU-25 acceptance — the operator-hosted lane says "we cannot reach your
 * system", not "answer more".
 *
 * THE BUG THIS PREVENTS: a client tenant (a remote box reached over the
 * operator-hosted lane) whose own box is down was answered by `next` with a
 * generic refusal — the page then showed a lock hint that reads like "answer
 * more questions". The owner was told to keep answering an interview whose
 * system could not be reached at all.
 *
 * Offline and deterministic: the client's registration names a remote endpoint
 * that is guaranteed to be unreachable, so `readRemoteInterviewState` throws
 * exactly as it does when a real box is down.
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { createClient } from '../../src/lib/clients';

process.env.MC_API_TOKEN = 'bu25-client-tenant-token';
process.env.MC_INTERVIEW_SECRET = process.env.MC_INTERVIEW_SECRET || 'bu25-client-tenant-secret';
process.env.MC_INTERVIEW_COOKIE_SECRET =
  process.env.MC_INTERVIEW_COOKIE_SECRET || 'bu25-client-tenant-cookie';
process.env.OPENCLAW_WORKSPACE_ROOT = process.env.CC_TEST_FIXTURE_ROOT;
process.env.OPENCLAW_SKILL23_SCRIPTS = `${process.env.CC_TEST_FIXTURE_ROOT}/absent-scripts`;
delete process.env.CC_PUBLIC_URL;

/** The exact sentence the page must show (spec wording, character for character). */
const UNREACHABLE_MESSAGE =
  'We cannot reach your system right now. Your answers are saved. Please try again in a few minutes.';

const CLIENT_HOST = 'client.example';

const CLIENT_ID = createClient({ name: 'Fixture Client', gateway_url: 'ws://127.0.0.1:1' }).id;

/** Point the client host at a remote endpoint that can never answer. */
function registerClient(extra: { remoteUrl?: string; remoteSecret?: string } = {}): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [CLIENT_HOST]: {
      tenantId: 'client-tenant',
      companyId: 'company-client',
      clientId: CLIENT_ID,
      kind: 'client',
      installationId: 'install-client',
      ...extra,
    },
  });
}

function clientRequest(path: string): NextRequest {
  return new NextRequest(`https://${CLIENT_HOST}${path}`, {
    method: 'GET',
    headers: { host: CLIENT_HOST, authorization: `Bearer ${process.env.MC_API_TOKEN}` },
  });
}

test('next: an unreachable client box returns 503 box_unreachable with the saved-answers message', async () => {
  // The remote reader throws: no remote endpoint is registered for this tenant.
  registerClient();
  const { GET: next } = await import('../../src/app/api/interview/next/route');

  const response = await next(clientRequest('/api/interview/next'));

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'box_unreachable');
  assert.equal(body.message, UNREACHABLE_MESSAGE);
  // Never the tooling refusal, never the gate's next question.
  assert.notEqual(body.error, 'temporarily_unavailable');
  assert.equal(body.done, undefined);
});

test('next: a registered-but-dead remote endpoint is the same box_unreachable answer', async () => {
  // A URL that resolves to a closed port: the remote reader throws on transport.
  registerClient({ remoteUrl: 'http://127.0.0.1:1', remoteSecret: 'fixture-remote-secret' });
  const { GET: next } = await import('../../src/app/api/interview/next/route');

  const response = await next(clientRequest('/api/interview/next'));

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'box_unreachable');
  assert.equal(body.message, UNREACHABLE_MESSAGE);
});

test('state: an unreachable client box reads waiting_for_installation with a null gate', async () => {
  registerClient();
  const { GET: state } = await import('../../src/app/api/interview/state/route');

  const response = await state(clientRequest('/api/interview/state'));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.remoteStatus, 'waiting_for_installation');
  assert.equal(body.remoteAvailable, false);
  assert.equal(body.gate, null);
});
