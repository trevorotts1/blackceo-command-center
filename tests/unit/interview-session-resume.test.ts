import './_isolated-db';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { getDb, closeDb, queryOne } from '../../src/lib/db';
import { POST, GET } from '../../src/app/api/auth/interview-session/route';
import { signTenantGrant, verifyTenantGrant, resolveTenantContext } from '../../src/lib/auth/tenant-context';
import { INTERVIEW_INVITATION_TTL_SECONDS, INTERVIEW_SESSION_TTL_SECONDS } from '../../src/lib/interview/session-policy';

const host = 'resume-owner.example';
const registration = { tenantId: 'resume-tenant', companyId: 'resume-company', installationId: 'resume-install', kind: 'self' };
// Redemption now reads the canonical build state to decide whether the
// interview is over. Pin a workspace of this fixture's own: unpinned, the
// resolver walks to the REAL ~/.openclaw/workspace of whatever box runs the
// suite, and that box's own completed interview would refuse every enrollment
// here.
const workspace = path.join(process.env.CC_TEST_FIXTURE_ROOT!, 'resume-workspace');
fs.mkdirSync(workspace, { recursive: true });
process.env.OPENCLAW_WORKSPACE_ROOT = workspace;
fs.writeFileSync(path.join(workspace, '.workforce-build-state.json'), JSON.stringify({ ...registration, interviewComplete: false }));
process.env.MC_API_TOKEN = 'fixture-session-api';
process.env.MC_TENANT_SESSION_SECRET = 'fixture-session-signing';
process.env.DISABLE_CRON = '1';
process.env.DISABLE_BRIDGE_BOOTSTRAP = '1';
getDb();
beforeEach(() => { process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: registration }); });
const now = () => Math.floor(Date.now() / 1000);
const request = (ticket?: string, cookie = '', targetHost = host) => new NextRequest(`https://${targetHost}/api/auth/interview-session`, {
  method: ticket === undefined ? 'GET' : 'POST', headers: { host: targetHost, cookie, 'content-type': 'application/json' },
  ...(ticket === undefined ? {} : { body: JSON.stringify({ ticket }) }),
});
async function ticket(exp = now() + INTERVIEW_INVITATION_TTL_SECONDS, extra = {}) {
  return signTenantGrant({ ...registration, host, purpose: 'enrollment', subject: 'owner:fixture', exp, nonce: randomUUID(), ...extra });
}
async function enroll() {
  const token = await ticket(); const response = await POST(request(token));
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  return { token, response, cookie };
}
async function atTime<T>(timestamp: number, body: () => Promise<T>) {
  const original = Date.now; Date.now = () => timestamp;
  try { return await body(); } finally { Date.now = original; }
}

test('legacy 24h receipt field and 30-day cookie/JWT expiry remain separate and exact', async () => {
  assert.equal(INTERVIEW_INVITATION_TTL_SECONDS, 86400);
  assert.equal(INTERVIEW_SESSION_TTL_SECONDS, 2592000);
  const start = now(); const { response, cookie } = await enroll();
  assert.match(response.headers.get('set-cookie')!, /Max-Age=2592000/i);
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/i);
  assert.match(response.headers.get('set-cookie')!, /SameSite=strict/i);
  const grant = await verifyTenantGrant(cookie.split('=')[1], host, 'session');
  assert.ok(grant); assert.equal(grant.companyId, registration.companyId);
  assert.ok(grant.exp >= start + INTERVIEW_SESSION_TTL_SECONDS && grant.exp <= now() + INTERVIEW_SESSION_TTL_SECONDS);
  assert.equal((await response.json()).expiresAt, grant.exp);
});

test('a redeemed link resumes on its own browser and re-opens on a fresh one', async () => {
  const { token, cookie } = await enroll();
  // Same browser: the live cookie resumes, and resuming never extends it.
  const resumed = await POST(request(token, cookie));
  assert.equal(resumed.status, 200); assert.equal((await resumed.json()).resumed, true);
  assert.equal(resumed.headers.get('set-cookie'), null, 'resume must not silently extend lifetime');
  assert.equal(resumed.headers.get('cache-control'), 'private, no-store');
  // A second browser with no cookie is the case that used to be locked out.
  const second = await POST(request(token));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).resumed, false);
  const secondCookie = second.headers.get('set-cookie')!.split(';')[0];
  const grant = await verifyTenantGrant(secondCookie.split('=')[1], host, 'session');
  assert.equal(grant?.subject, 'owner:fixture', 're-opening must not switch owners');
});

test('a long-dormant link still resumes and still re-opens; neither age nor prior use ends it', async () => {
  const start = Date.now(); const { token, cookie } = await enroll();
  await atTime(start + 2 * 86400 * 1000, async () => {
    assert.equal((await POST(request(token, cookie))).status, 200);
    assert.equal((await POST(request(token))).status, 200);
    assert.equal((await GET(request(undefined, cookie))).status, 200);
  });
});

test('a ticket minted long ago still enrolls while the interview is unfinished', async () => {
  const start = Date.now();
  const stale = await ticket(now() - 45 * 86400);
  await atTime(start + 60 * 86400 * 1000, async () => {
    const response = await POST(request(stale));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).resumed, false);
  });
});

test('an expired browser session is recovered by re-opening the very same link', async () => {
  const start = Date.now(); const { token, cookie } = await enroll();
  await atTime(start + (INTERVIEW_SESSION_TTL_SECONDS + 2) * 1000, async () => {
    assert.equal((await GET(request(undefined, cookie))).status, 403);
    await assert.rejects(resolveTenantContext(request(undefined, cookie)));
    // The dead cookie drops through to the enrollment branch, and the original
    // link — already redeemed, long past its stamped exp — signs the owner
    // back in. This is why the session may stay bounded without stranding one.
    const recovered = await POST(request(token, cookie));
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).resumed, false);
    assert.ok(recovered.headers.get('set-cookie'));
  });
});

test('foreign host, company, installation and tenant never reuse active grants', async () => {
  const { token, cookie } = await enroll();
  assert.equal((await POST(request(token, cookie, 'foreign.example'))).status, 403);
  for (const changed of [{ companyId: 'another-company' }, { installationId: 'another-install' }, { tenantId: 'another-tenant' }]) {
    process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: { ...registration, ...changed } });
    assert.equal((await POST(request(token, cookie))).status, 403);
    assert.equal((await GET(request(undefined, cookie))).status, 403);
  }
});

test('another subject or invalid ticket cannot replace the authenticated owner', async () => {
  const { cookie } = await enroll();
  for (const other of [await ticket(now() + 60, { subject: 'owner:other' }), 'forged.signature']) {
    const response = await POST(request(other, cookie));
    assert.equal(response.status, 403); assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal((await resolveTenantContext(request(undefined, cookie))).subject, 'owner:fixture');
});

test('the first-use audit row survives database close/reopen and never becomes a gate', async () => {
  const { token, cookie } = await enroll();
  const grant = await verifyTenantGrant(token, host, 'enrollment'); assert.ok(grant);
  closeDb(); getDb();
  const row = queryOne<{ nonce: string; used_at: string }>('SELECT nonce,used_at FROM interview_enrollment_uses WHERE nonce=?', [grant.nonce]);
  assert.ok(row, 'the first redemption is still recorded');
  assert.ok(row!.used_at, 'with the time it happened');
  // Recorded, not spent.
  assert.equal((await POST(request(token))).status, 200);
  assert.equal((await POST(request(token, cookie))).status, 200);
  assert.equal(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM interview_enrollment_uses WHERE nonce=?', [grant.nonce])!.n, 1, 'the audit row is written once, not once per open');
});

test('legacy signed grant without company is rejected; fresh sign-in binds company', async () => {
  const legacy = { purpose: 'session', tenantId: registration.tenantId, installationId: registration.installationId, host, subject: 'owner:fixture', exp: now() + 60, nonce: randomUUID() };
  const payload = Buffer.from(JSON.stringify(legacy)).toString('base64url');
  const signature = createHmac('sha256', process.env.MC_TENANT_SESSION_SECRET!).update(payload).digest('base64url');
  assert.equal((await GET(request(undefined, `mc_tenant_session=${payload}.${signature}`))).status, 403);
  assert.equal((await POST(request(await ticket(), `mc_tenant_session=${payload}.${signature}`))).status, 200);
});

test('secret rotation revokes previously issued access', async () => {
  const { token, cookie } = await enroll();
  const previous = process.env.MC_TENANT_SESSION_SECRET;
  process.env.MC_TENANT_SESSION_SECRET = 'fixture-rotated-key';
  try { assert.equal((await POST(request(token, cookie))).status, 403); }
  finally { process.env.MC_TENANT_SESSION_SECRET = previous; }
});

test('malformed host fails closed without throwing or exposing session state', async () => {
  const { cookie } = await enroll();
  const malformed = new NextRequest(`https://${host}/api/auth/interview-session`, {
    headers: { host: '[malformed', cookie },
  });
  const response = await GET(malformed);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'session_expired_or_missing' });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});
