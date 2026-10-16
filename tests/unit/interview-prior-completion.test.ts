import './_isolated-db';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { NextRequest } from 'next/server';
import { closeDb, getDb } from '../../src/lib/db';
import { resolveTenantContext, signTenantGrant } from '../../src/lib/auth/tenant-context';
import { signCsrfToken } from '../../src/lib/csrf-protection';
import { priorCompletion } from '../../src/lib/interview/prior-completion';

const host = 'prior.example';
const reg = { kind: 'self', tenantId: 'prior-tenant', companyId: 'prior-company', installationId: 'prior-install', issuer: 'https://prior-access.example', audience: 'prior-aud', subjects: ['owner@example.com'] };
const workspace = mkdtempSync(join(tmpdir(), 'prior-completion-'));
Object.assign(process.env, {
  MC_API_TOKEN: 'prior-fixture-token', MC_INTERVIEW_COOKIE_SECRET: 'prior-fixture-secret',
  MC_TENANT_SESSION_SECRET: 'prior-fixture-session', MC_CSRF_COOKIE_SECRET: 'prior-fixture-csrf',
  MC_TENANT_REGISTRY_JSON: JSON.stringify({ [host]: reg }),
  OPENCLAW_WORKSPACE_ROOT: workspace, OPENCLAW_SKILL23_SCRIPTS: workspace,
  REQUIRE_CF_ACCESS: 'false', DEMO_MODE: 'false', DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
});
const statePath = join(workspace, '.workforce-build-state.json');
const original = JSON.stringify({ interviewComplete: false, interviewQc: { status: 'pending' }, companyId: reg.companyId });
writeFileSync(statePath, original);
function request(path: string, headers: Record<string, string> = {}, body?: unknown) {
  return new NextRequest(`https://${host}${path}`, { headers: { host, ...(body === undefined ? {} : { origin: `https://${host}` }), ...headers },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
}

test('declaration persists, isolates tenants, never completes build, and distinguishes access errors', async () => {
  const { POST } = await import('../../src/app/api/interview/prior-completion/route');
  const { GET: gate } = await import('../../src/app/api/interview/gate-status/route');
  const { GET: state } = await import('../../src/app/api/interview/state/route');
  const { middleware } = await import('../../src/middleware');
  const { checkInterviewCompleteViaFallback } = await import('../../src/lib/interview/gate-fallback');
  const session = await signTenantGrant({ ...reg, host, subject: 'owner-uuid', purpose: 'session', exp: Date.now()/1000 + 3600, nonce: 'fixture-nonce' });
  const csrf = (await signCsrfToken()).value;
  const headers = { cookie: `mc_tenant_session=${session}; mc_csrf_token=${csrf}` };
  const before = await middleware(request('/'));
  assert.equal(before.status, 403);
  assert.equal(before.headers.get('location'), null);
  assert.equal((await before.json()).error, 'tenant_access_required');
  assert.equal((await POST(request('/api/interview/prior-completion', {}, { confirmed: true }))).status, 403);
  assert.equal((await POST(request('/api/interview/prior-completion', { cookie: `mc_tenant_session=${session}` }, { confirmed: true }))).status, 403);
  assert.equal((await POST(request('/api/interview/prior-completion', { ...headers, authorization: 'Bearer prior-fixture-token' }, { confirmed: true }))).status, 403);
  assert.equal((await POST(request('/api/interview/prior-completion', { ...headers, origin: 'https://foreign.example' }, { confirmed: true }))).status, 403);
  assert.equal((await POST(request('/api/interview/prior-completion', headers, { confirmed: true, companyId: 'foreign' }))).status, 400);
  assert.equal((await gate(request('/api/interview/gate-status', headers))).status, 200);
  const first = await POST(request('/api/interview/prior-completion', headers, { confirmed: true }));
  assert.equal(first.status, 200);
  const declared = (await first.json()).declaration;
  assert.equal(declared.source, 'owner-self-attestation');
  assert.equal(declared.declaredBy, 'owner-uuid');
  assert.deepEqual((await (await POST(request('/api/interview/prior-completion', headers, { confirmed: true }))).json()).declaration, declared);
  closeDb(); // Reopen real on-disk DB: no process-local or browser latch.
  assert.deepEqual(priorCompletion(reg), declared);
  const { getInterviewState } = await import('../../src/lib/conversational-ai/interview-state');
  const conversational = await getInterviewState(await resolveTenantContext(request('/', headers)));
  assert.equal(conversational.complete, true);
  assert.equal(conversational.signal, 'owner-self-attestation');
  for (const key of ['tenantId', 'companyId', 'installationId']) assert.equal(priorCompletion({ ...reg, [key]: 'foreign' }), null);
  assert.equal(readFileSync(statePath, 'utf8'), original);
  const status = await (await gate(request('/api/interview/gate-status', headers))).json();
  assert.equal(status.priorCompletionDeclared, true);
  assert.equal(status.interviewComplete, false);
  assert.equal(status.buildCompleted, false);
  const progress = await (await state(request('/api/interview/state', headers))).json();
  assert.equal(progress.priorCompletionDeclared, true);
  assert.equal(progress.interviewComplete, false);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => gate(request('/api/interview/gate-status', Object.fromEntries(new Headers(init?.headers))))) as typeof fetch;
  try {
    assert.equal(await checkInterviewCompleteViaFallback(host), true);
    assert.equal((await middleware(request('/', headers))).status, 200);
    assert.equal((await middleware(request('/', headers))).status, 200);
    assert.equal((await middleware(request('/'))).status, 403);
    getDb().prepare('DELETE FROM interview_prior_completion_declarations').run();
    assert.equal((await middleware(request('/', headers))).status, 302);
    writeFileSync(statePath, JSON.stringify({ interviewComplete: true, interviewCompletedAt: '2026-06-20T12:00:44Z' }));
    assert.equal((await middleware(request('/', headers))).status, 200);
  } finally { globalThis.fetch = realFetch; closeDb(); }
});

test('client declaration and genuine completion survive stale remote state', async () => {
  const clientHost = 'client.prior.example';
  const client = { ...reg, kind: 'client', tenantId: 'remote-tenant', clientId: 'remote-client', remoteUrl: 'https://remote.prior.example', remoteSecret: 'remote-fixture' };
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: reg, [clientHost]: client });
  getDb().prepare('INSERT INTO clients(id,name,is_self,interview_complete) VALUES(?,?,0,1)').run(client.clientId, 'Fixture');
  const token = await signTenantGrant({ ...client, host: clientHost, subject: 'remote-owner', purpose: 'session', exp: Date.now()/1000 + 300, nonce: 'remote-fixture' });
  const csrf = (await signCsrfToken()).value;
  const headers = { host: clientHost, origin: `https://${clientHost}`, cookie: `mc_tenant_session=${token}; mc_csrf_token=${csrf}` };
  const { POST } = await import('../../src/app/api/interview/prior-completion/route');
  const { GET } = await import('../../src/app/api/interview/state/route');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ tenantId: client.tenantId, installationId: client.installationId, state: 'acknowledged', httpStatus: 200, result: { interviewComplete: false } }))) as typeof fetch;
  try {
    assert.equal((await POST(request('/api/interview/prior-completion', headers, { confirmed: true }))).status, 200);
    const progress = await (await GET(request('/api/interview/state', headers))).json();
    assert.equal(progress.interviewComplete, true);
    assert.equal(progress.priorCompletionDeclared, true);
    assert.equal((getDb().prepare('SELECT interview_complete FROM clients WHERE id=?').get(client.clientId) as { interview_complete: number }).interview_complete, 1);
    // An unavailable store must report failure, never promise a saved declaration.
    getDb().exec("CREATE TRIGGER reject_prior BEFORE INSERT ON interview_prior_completion_declarations BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    assert.equal((await POST(request('/api/interview/prior-completion', headers, { confirmed: true }))).status, 503);
    getDb().exec('DROP TRIGGER reject_prior');
  } finally { globalThis.fetch = originalFetch; process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: reg }); closeDb(); }
});

test('legacy email selector requires signed email; opaque subject and all JWT checks remain enforced', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'prior-key' };
  const jwt = (changes: Record<string, unknown> = {}) => {
    const raw = [ { alg: 'RS256', kid: 'prior-key' }, { sub: 'owner-uuid', email: 'owner@example.com', iss: reg.issuer, aud: [reg.audience], exp: Date.now()/1000 + 300, ...changes } ].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
    return raw + '.' + sign('RSA-SHA256', Buffer.from(raw), privateKey).toString('base64url');
  };
  const resolve = (token: string) => resolveTenantContext(request('/', { 'cf-access-jwt-assertion': token, 'cf-access-authenticated-user-email': 'owner@example.com' }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch;
  try {
    assert.equal((await resolve(jwt())).subject, 'owner@example.com');
    for (const claims of [{ email: 'stranger@example.com' }, { email: undefined }, { sub: '' }, { iss: 'https://foreign.example' }, { aud: ['foreign'] }, { exp: 1 }, { nbf: Date.now()/1000 + 999 }]) await assert.rejects(resolve(jwt(claims)));
    const parts = jwt().split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'owner-uuid', email: 'owner@example.com', iss: reg.issuer, aud: [reg.audience], exp: Date.now()/1000 + 999 })).toString('base64url');
    await assert.rejects(resolve(parts.join('.')));
    process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: { ...reg, allowedEmails: ['different@example.com'] } });
    await assert.rejects(resolve(jwt()));
    process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: { ...reg, subjects: ['opaque-subject'] } });
    await assert.rejects(resolve(jwt()));
    assert.equal((await resolve(jwt({ sub: 'opaque-subject' }))).subject, 'opaque-subject');
  } finally { globalThis.fetch = realFetch; process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: reg }); }
});
