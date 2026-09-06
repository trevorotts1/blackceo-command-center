import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { closeDb, getDb, queryOne, run } from '../../src/lib/db';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';

// Real route/storage lifecycle; remote installation is deliberately unavailable.
// No real gateway, owner message, credential store or client filesystem is used.
process.env.MC_API_TOKEN = 'launch-lifecycle-api-fixture';
process.env.MC_INTERVIEW_COOKIE_SECRET = 'launch-lifecycle-session-fixture';
process.env.MC_INTERVIEW_SECRET = 'launch-lifecycle-encryption-fixture';
process.env.OPENCLAW_WORKSPACE_ROOT = process.env.CC_TEST_FIXTURE_ROOT;
const owners = ['alpha', 'beta'] as const;
process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify(Object.fromEntries(owners.map(owner => [
  `${owner}.example`, { tenantId: `launch-${owner}`, companyId: `company-${owner}`,
    clientId: `client-${owner}`, installationId: `installation-${owner}`, kind: 'client' },
])));
getDb();
for (const owner of owners) {
  run('INSERT OR IGNORE INTO companies(id,name,slug) VALUES(?,?,?)', [`company-${owner}`, owner, owner]);
  run('INSERT OR IGNORE INTO clients(id,name,is_self) VALUES(?,?,0)', [`client-${owner}`, owner]);
}
const discovery = path.join(process.env.CC_TEST_FIXTURE_ROOT!, 'company-discovery');
fs.mkdirSync(discovery, { recursive: true });
const operatorTranscript = path.join(discovery, 'workforce-interview-answers.md');
fs.writeFileSync(operatorTranscript, '**Q:** Operator private question?\n**A:** OPERATOR_PRIVATE_SENTINEL\n');

function request(owner: string, route: string, cookie = '', body?: unknown, operationId?: string) {
  return new NextRequest(`https://${owner}.example${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { host: `${owner}.example`, cookie, 'content-type': 'application/json',
      ...(operationId ? { 'idempotency-key': operationId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function enroll(owner: string) {
  const { POST } = await import('../../src/app/api/auth/interview-session/route');
  const ticket = await signTenantGrant({ purpose: 'enrollment', tenantId: `launch-${owner}`,
    installationId: `installation-${owner}`, host: `${owner}.example`, subject: `owner:${owner}`,
    exp: Math.floor(Date.now() / 1000) + 300, nonce: randomUUID() });
  const response = await POST(request(owner, '/api/auth/interview-session', '', { ticket }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  assert.match(cookie, /^mc_tenant_session=/);
  assert.equal((await POST(request(owner, '/api/auth/interview-session', '', { ticket }))).status, 409);
  return cookie;
}

test('enroll → save → pause/reopen → export → completion wait preserves both clients and every answer', async () => {
  const { POST: answer } = await import('../../src/app/api/interview/answer/route');
  const { GET: state } = await import('../../src/app/api/interview/state/route');
  const { GET: readback } = await import('../../src/app/api/interview/answers/route');
  const { GET: exportAnswers } = await import('../../src/app/api/interview/answers/export/route');
  const { POST: complete } = await import('../../src/app/api/interview/complete/route');
  const cookies = { alpha: await enroll('alpha'), beta: await enroll('beta') };
  assert.equal((await state(request('beta', '/api/interview/state', cookies.alpha))).status, 403);
  assert.equal((await exportAnswers(request('alpha', '/api/interview/answers/export'))).status, 403);

  const before = await (await state(request('alpha', '/api/interview/state', cookies.alpha))).json();
  for (const owner of owners) {
    const payload = { questionId: 'company_name', prompt: 'What is your company called?',
      answer: `${owner.toUpperCase()} PRIVATE COMPANY`, phase: 'business', questionNumber: 1 };
    const first = await answer(request(owner, '/api/interview/answer', cookies[owner], payload, `launch-answer-${owner}`));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).saveStatus, 'saved_waiting_sync');
    const retry = await answer(request(owner, '/api/interview/answer', cookies[owner], payload, `launch-answer-${owner}`));
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).answeredCount, 1, 'same operation cannot duplicate an answer');
  }

  // Reopen the actual SQLite store and create a fresh browser session: neither
  // the answer nor the resume identity may depend on a tab's memory/cookie.
  closeDb(); getDb();
  cookies.alpha = await enroll('alpha');
  const resumed = await (await state(request('alpha', '/api/interview/state', cookies.alpha))).json();
  assert.equal(resumed.interviewId, before.interviewId);
  assert.ok(resumed.structured.answeredIds.includes('company_name'));
  assert.equal(resumed.resume.totalQuestionsAnswered, 1);
  assert.equal(resumed.remoteStatus, 'waiting_for_installation');
  assert.equal(resumed.interviewComplete, false);
  assert.equal(resumed.buildCompleted, false);

  for (const owner of owners) {
    const other = owner === 'alpha' ? 'beta' : 'alpha';
    const document = await exportAnswers(request(owner, '/api/interview/answers/export?download=1', cookies[owner]));
    assert.equal(document.status, 200);
    assert.match(document.headers.get('content-type')!, /text\/markdown/);
    assert.match(document.headers.get('content-disposition')!, /attachment/);
    const text = await document.text();
    assert.ok(text.includes('What is your company called?'));
    assert.equal(text.split(`${owner.toUpperCase()} PRIVATE COMPANY`).length - 1, 1);
    assert.ok(!text.includes(`${other.toUpperCase()} PRIVATE COMPANY`));
    assert.ok(!text.includes('OPERATOR_PRIVATE_SENTINEL'));
    const view = await readback(request(owner, '/api/interview/answers', cookies[owner]));
    assert.equal(view.status, 200);
    assert.ok((await view.text()).includes(`${owner.toUpperCase()} PRIVATE COMPANY`));
  }

  const pending = await complete(request('alpha', '/api/interview/complete', cookies.alpha, {}, 'launch-complete-alpha'));
  assert.equal(pending.status, 202, 'missing receiver cannot fabricate successful build handoff');
  assert.equal((await pending.json()).status, 'needs-review');
  const completion = queryOne<{ state: string; tenant_id: string }>(
    'SELECT state,tenant_id FROM interview_remote_operations WHERE operation_id=?', ['launch-complete-alpha']);
  assert.deepEqual(completion, { state: 'pending', tenant_id: 'launch-alpha' });
  assert.equal(queryOne<{ n: number }>("SELECT COUNT(*) n FROM interview_remote_operations WHERE tenant_id='launch-beta' AND operation_type='complete'")!.n, 0);
  assert.equal(fs.readFileSync(operatorTranscript, 'utf8'), '**Q:** Operator private question?\n**A:** OPERATOR_PRIVATE_SENTINEL\n');
  assert.match(queryOne<{ answer_text: string }>('SELECT answer_text FROM tenant_interview_answers WHERE operation_id=?', ['launch-answer-alpha'])!.answer_text, /^enc:v1:/);
});
