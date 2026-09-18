import './_isolated-db';
/**
 * The interview enrollment link does not expire on a clock. It is valid until
 * the interview it opens is complete, and only then may it be refused.
 *
 * These assertions cover the redemption side end to end: age is never a reason
 * to refuse, completion always is, and neither change weakened the signature,
 * ownership or host binding that makes a ticket trustworthy in the first place.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';
import { POST, GET } from '../../src/app/api/auth/interview-session/route';
import { signTenantGrant, verifyTenantGrant } from '../../src/lib/auth/tenant-context';
import { INTERVIEW_INVITATION_VALID_UNTIL, INTERVIEW_SESSION_TTL_SECONDS } from '../../src/lib/interview/session-policy';
import { interviewFinished } from '../../src/lib/interview/enrollment-window';

const root = process.env.CC_TEST_FIXTURE_ROOT!;
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const statePath = path.join(workspace, '.workforce-build-state.json');

const host = 'no-expiry.example';
const registration = { tenantId: 'noexp-tenant', companyId: 'noexp-company', installationId: 'noexp-install', kind: 'self' };
Object.assign(process.env, {
  OPENCLAW_WORKSPACE_ROOT: workspace,
  MC_API_TOKEN: 'no-expiry-fixture-api',
  MC_TENANT_SESSION_SECRET: 'no-expiry-fixture-signing',
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
});

getDb();

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const writeState = (state: unknown) => fs.writeFileSync(statePath, JSON.stringify(state));
const unfinished = { ...registration, interviewComplete: false };

beforeEach(() => {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: registration });
  writeState(unfinished);
});

/** A ticket exactly as the Command Center mints one, aged by `daysOld`. */
function ticket(daysOld = 0, extra: Record<string, unknown> = {}) {
  return signTenantGrant({
    ...registration, host, purpose: 'enrollment',
    subject: 'invited-owner:' + 'a'.repeat(64),
    exp: now() - daysOld * DAY + DAY,
    nonce: randomUUID(),
    ...extra,
  });
}
const redeem = (token: string, cookie = '') => POST(new NextRequest(`https://${host}/api/auth/interview-session`, {
  method: 'POST', headers: { host, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: token }),
}));

test('a link minted months ago still signs the owner in while the interview is unfinished', async () => {
  for (const daysOld of [1, 30, 365]) {
    const response = await redeem(await ticket(daysOld));
    assert.equal(response.status, 200, `a ${daysOld}-day-old link must still work`);
    const body = await response.json();
    assert.equal(body.resumed, false);
    assert.match(response.headers.get('set-cookie')!, /Max-Age=2592000/i);
  }
});

test('the link is refused once the interview is recorded complete', async () => {
  writeState({ ...registration, interviewComplete: true });
  const response = await redeem(await ticket());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'interview_already_complete');
  assert.equal(response.headers.get('set-cookie'), null);
});

test('the link is refused once the build is recorded complete', async () => {
  writeState({ ...registration, interviewComplete: false, buildCompletedAt: '2026-09-18T00:00:00.000Z' });
  const response = await redeem(await ticket());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'interview_already_complete');
});

test('an unreadable or absent build state is undetermined, and never locks the owner out', async () => {
  fs.rmSync(statePath);
  assert.equal((await redeem(await ticket(200))).status, 200);
  fs.writeFileSync(statePath, 'not json at all');
  assert.equal((await redeem(await ticket(200))).status, 200);
});

test("another company's completed interview never closes this link", async () => {
  writeState({ ...registration, companyId: 'someone-else', interviewComplete: true });
  assert.equal((await redeem(await ticket())).status, 200);
  assert.equal(interviewFinished({ companyId: 'someone-else', interviewComplete: true }, registration.companyId), false);
  assert.equal(interviewFinished({ interviewComplete: true }, registration.companyId), true, 'state with no owner recorded still closes it');
});

test('dropping the clock check did not loosen signature, owner or host binding', async () => {
  const token = await ticket(400);
  const [payload, signature] = token.split('.');
  for (const forged of [`${payload}.${signature.slice(0, -2)}AA`, `${payload}x.${signature}`, 'forged.signature', `${payload}.${signature}.extra`]) {
    assert.equal((await redeem(forged)).status, 403, 'a tampered ticket must never be honoured');
  }
  const foreign = await POST(new NextRequest('https://foreign.example/api/auth/interview-session', {
    method: 'POST', headers: { host: 'foreign.example', 'content-type': 'application/json' }, body: JSON.stringify({ ticket: token }),
  }));
  assert.equal(foreign.status, 403);
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: { ...registration, companyId: 'rebound-company' } });
  assert.equal((await redeem(token)).status, 403, 'a registry rebind must not carry the old grant over');
});

test('browser sessions still expire on the clock; only the link stopped doing so', async () => {
  const response = await redeem(await ticket(120));
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const session = await verifyTenantGrant(cookie.split('=')[1], host, 'session');
  assert.ok(session);
  assert.ok(session.exp <= now() + INTERVIEW_SESSION_TTL_SECONDS);
  const original = Date.now;
  Date.now = () => (now() + INTERVIEW_SESSION_TTL_SECONDS + 2) * 1000;
  try {
    assert.equal(await verifyTenantGrant(cookie.split('=')[1], host, 'session'), null);
    assert.equal((await GET(new NextRequest(`https://${host}/api/auth/interview-session`, { headers: { host, cookie } }))).status, 403);
  } finally { Date.now = original; }
});

test('the published validity contract is completion, not a duration', () => {
  assert.equal(INTERVIEW_INVITATION_VALID_UNTIL, 'interview-complete');
});
