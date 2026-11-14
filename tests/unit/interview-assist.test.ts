/**
 * BU-17 — the "I am not sure" helper.
 *
 * Three checks against a stub gateway client (no socket is opened):
 *   1. a history that grows a narration line first and the answer after it
 *      yields ONLY the answer — never the narration joined in;
 *   2. a gateway that throws still returns the registry's own suggestions with
 *      HTTP 200, so the owner always has something to tap;
 *   3. no response ever carries the word "gateway" (the raw error stays in the
 *      server log).
 *
 * The interval is 10 ms so the settle rule is exercised without slowing the
 * suite.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { getDb, run } from '../../src/lib/db';
import { ensureTenantInterview } from '../../src/lib/interview/remote-store';

process.env.MC_API_TOKEN = 'fixture-api-token';
process.env.MC_INTERVIEW_COOKIE_SECRET = 'fixture-cookie-key';
process.env.MC_INTERVIEW_SECRET = 'fixture-encryption-key';
process.env.OPENCLAW_WORKSPACE_ROOT = process.env.CC_TEST_FIXTURE_ROOT;
process.env.OPENCLAW_SKILL23_SCRIPTS = path.join(process.env.CC_TEST_FIXTURE_ROOT!, 'absent-scripts');
process.env.INTERVIEW_ASSIST_POLL_MS = '10';
process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
  'self.example': {
    tenantId: 'operator',
    companyId: 'company-self',
    kind: 'self',
    installationId: 'install-self',
  },
});

getDb();
run('INSERT OR IGNORE INTO companies(id,name,slug) VALUES(?,?,?)', [
  'company-self',
  'company-self',
  'company-self',
]);

const SESSION_KEY = 'agent:main:interview-fixture';
const interview = ensureTenantInterview('operator');
run('UPDATE tenant_interviews SET gateway_session_id=? WHERE tenant_id=?', [
  SESSION_KEY,
  'operator',
]);
assert.equal(interview.tenant_id, 'operator');

const INDUSTRY_SUGGESTIONS = [
  'Coaching or consulting',
  'Real estate',
  'Home or local services',
  'Online store',
  'Software',
  'Marketing agency',
  'Content creator',
  'Health and wellness',
];

function assistRequest(): NextRequest {
  return new NextRequest('https://self.example/api/interview/assist', {
    method: 'POST',
    headers: {
      host: 'self.example',
      authorization: 'Bearer fixture-api-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ questionId: 'industry' }),
  });
}

test('only the settled final answer becomes the suggestions, never the narration', async () => {
  const { POST: assist } = await import('../../src/app/api/interview/assist/route');
  const { OpenClawClient } = await import('../../src/lib/openclaw/client');
  const proto = OpenClawClient.prototype;
  const originals = {
    isConnected: proto.isConnected,
    getSessionHistory: proto.getSessionHistory,
    sendMessage: proto.sendMessage,
  };
  const ownerTurn = { role: 'user', content: '[INTERVIEW-HELPER] fixture prompt' };
  const narration = { role: 'assistant', content: 'Here are three for you:' };
  const finalLine = {
    role: 'assistant',
    content: 'Coaching or consulting\nReal estate\nHome or local services',
  };
  let reads = 0;
  proto.isConnected = () => true;
  proto.sendMessage = async () => {};
  proto.getSessionHistory = async () => {
    reads++;
    if (reads === 1) return []; // baseline, before the helper message
    if (reads === 2) return [ownerTurn];
    if (reads === 3) return [ownerTurn, narration];
    if (reads === 4) return [ownerTurn, narration, finalLine];
    return [ownerTurn, narration, finalLine]; // two equal polls: settled
  };

  try {
    const response = await assist(assistRequest());
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('gateway'), 'no raw gateway text in the response');
    assert.ok(!text.includes('Here are three for you:'), 'narration never becomes a suggestion');
    assert.deepEqual(JSON.parse(text), {
      ok: true,
      suggestions: ['Coaching or consulting', 'Real estate', 'Home or local services'],
      pending: false,
    });
  } finally {
    Object.assign(proto, originals);
  }
});

test('a throwing gateway still returns the registry suggestions with HTTP 200', async () => {
  const { POST: assist } = await import('../../src/app/api/interview/assist/route');
  const { OpenClawClient } = await import('../../src/lib/openclaw/client');
  const proto = OpenClawClient.prototype;
  const originals = {
    isConnected: proto.isConnected,
    getSessionHistory: proto.getSessionHistory,
    sendMessage: proto.sendMessage,
  };
  proto.isConnected = () => true;
  proto.getSessionHistory = async () => [];
  proto.sendMessage = async () => {
    throw new Error('gateway refused the message: ECONNREFUSED');
  };

  try {
    const response = await assist(assistRequest());
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('gateway'), 'no raw gateway text in the response');
    assert.deepEqual(JSON.parse(text), {
      ok: true,
      suggestions: INDUSTRY_SUGGESTIONS,
      pending: false,
    });
  } finally {
    Object.assign(proto, originals);
  }
});
