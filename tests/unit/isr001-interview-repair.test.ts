import './_isolated-db';
/**
 * ISR-001 — generic interview source repair: verified Access identity entry,
 * short-link session exchange, existing-ticket compatibility, dept decline
 * warning/cancel/confirm with keep-undo, and saved decisions surviving reload.
 *
 * Isolated: throwaway DATABASE_PATH (via _isolated-db), fixture workspace and
 * script dirs under the OS temp dir, stubbed JWKS fetch, no live gateway, no
 * network, no production writes. The dept writer legs shell the READ-ONLY
 * Skill-23 loss reader plus record-dept-decision.sh with --state pinned to the
 * fixture file and the rate-limit ledger pinned to the fixture dir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb, closeDb, run } from '../../src/lib/db';

const laneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isr001-'));
const workspace = path.join(laneRoot, 'workspace');
const companyRoot = path.join(laneRoot, 'company');
const runtimeRoot = path.join(laneRoot, 'runtime');
const stubScripts = path.join(laneRoot, 'stub-scripts');
const discovery = path.join(workspace, 'company-discovery');
const statePath = path.join(workspace, '.workforce-build-state.json');
const catalogPath = path.join(companyRoot, 'catalog.json');

const host = 'isr001.example';
const registration = {
  tenantId: 'isr001-tenant', companyId: 'isr001-company', installationId: 'isr001-install',
  kind: 'self', issuer: 'https://isr001-access.example', audience: 'isr001-audience',
  subjects: ['owner-subject-1'],
};
const token = 'isr001-api-token';
Object.assign(process.env, {
  OPENCLAW_WORKSPACE_ROOT: workspace,
  OPENCLAW_SKILL23_SCRIPTS: stubScripts,
  OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:1',
  OPENCLAW_ROOT: runtimeRoot,
  MC_API_TOKEN: token,
  MC_TENANT_SESSION_SECRET: 'isr001-session-secret',
  MC_INTERVIEW_COOKIE_SECRET: 'isr001-cookie-secret',
  MC_CSRF_COOKIE_SECRET: 'isr001-csrf-secret',
  MC_INTERVIEW_SECRET: 'isr001-encryption-fixture',
  MC_COMPANY_ID: 'isr001-company',
  MC_INSTALLATION_ID: 'isr001-install',
  MC_TENANT_PUBLIC_URL: `https://${host}`,
  MC_TENANT_REGISTRY_JSON: JSON.stringify({ [host]: registration }),
  INTERVIEW_RATE_LIMIT_STATE_FILE: path.join(laneRoot, 'rate-limit.json'),
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
});
process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON = JSON.stringify({ 'isr001-company': {
  companyRoot, companyConfig: path.join(companyRoot, 'company-config.json'),
  companySlug: 'isr001-company', personaCatalog: catalogPath,
} });

const freshState = () => ({
  tenantId: 'isr001-tenant', companyId: 'isr001-company', installationId: 'isr001-install',
  interviewComplete: false, buildType: 'legacy', buildId: 'isr001-build',
});
const writeState = (state: unknown) => fs.writeFileSync(statePath, JSON.stringify(state));

getDb();

function req(route: string, opts?: { headers?: Record<string, string>; body?: unknown; cookie?: string }) {
  const headers: Record<string, string> = { host, ...(opts?.headers || {}) };
  if (opts?.cookie) headers.cookie = opts.cookie;
  if (opts?.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`https://${host}${route}`, {
    method: opts?.body !== undefined ? 'POST' : 'GET',
    headers,
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

// ---- RSA fixture for the verified Access JWT ----
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'isr001-key', alg: 'RS256' };
const realFetch = globalThis.fetch;
function stubJwks() {
  globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}
function accessJwt(sub: string, overrides: Record<string, unknown> = {}) {
  const header = { alg: 'RS256', kid: 'isr001-key' };
  const payload = {
    iss: registration.issuer, sub, aud: [registration.audience],
    exp: Math.floor(Date.now() / 1000) + 300, email: 'owner@isr001.example', ...overrides,
  };
  const content = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`;
}
async function csrfCookie(): Promise<string> {
  const { signCsrfToken } = await import('../../src/lib/csrf-protection');
  const { value } = await signCsrfToken();
  return `mc_csrf_token=${value}`;
}
async function sessionCookie(subject: string): Promise<string> {
  const { signTenantGrant } = await import('../../src/lib/auth/tenant-context');
  const grant = await signTenantGrant({
    ...registration, host, purpose: 'session', subject,
    exp: Math.floor(Date.now() / 1000) + 3600, nonce: randomUUID(),
  });
  return `mc_tenant_session=${grant}; ${await csrfCookie()}`;
}

test.before(() => {
  for (const dir of [workspace, companyRoot, discovery, stubScripts, path.join(runtimeRoot, 'agents', 'main', 'agent')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(companyRoot, 'company-config.json'), JSON.stringify({ companyId: 'isr001-company', companySlug: 'isr001-company' }));
  fs.writeFileSync(catalogPath, JSON.stringify({ personas: { canonical: { name: 'Canonical Fixture' } } }));
  for (const file of ['update-interview-state.sh', 'record-dept-decision.sh', 'list-canonical-departments.py']) {
    fs.writeFileSync(path.join(stubScripts, file), '# fixture\n');
  }
  fs.writeFileSync(path.join(runtimeRoot, 'openclaw.json'), JSON.stringify({
    agents: { entries: { main: { workspace, model: 'fixture/model' } } },
  }));
  writeState(freshState());
  run("INSERT OR IGNORE INTO companies(id,name,slug) VALUES('isr001-company','ISR Fixture','isr001-company')");
  run("INSERT OR IGNORE INTO workspaces(id,name,slug,company_id) VALUES('isr001-ws','General Task','general-task','isr001-company')");
});
test.after(() => { restoreFetch(); closeDb(); });

test('valid signed Access identity opens the short link with no prior cookie', async () => {
  stubJwks();
  try {
    const { POST: invite } = await import('../../src/app/api/auth/interview-invitation/route');
    const invited = await invite(req('/api/auth/interview-invitation', {
      headers: { authorization: `Bearer ${token}` },
      body: { recipientHash: 'b'.repeat(64) },
    }));
    assert.equal(invited.status, 200, JSON.stringify(await invited.clone().json()));
    const receipt = await invited.json();
    const url = new URL(receipt.url);
    assert.equal(url.hostname, host);
    assert.equal(url.pathname, '/interview');
    assert.ok(url.searchParams.get('enroll'), 'short link carries ?enroll=');
    assert.equal(url.hash, '', 'no fragment bearer');
    const ticket = url.searchParams.get('enroll')!;
    const { POST: exchange } = await import('../../src/app/api/auth/interview-session/route');
    const entered = await exchange(req('/api/auth/interview-session', { body: { ticket } }));
    assert.equal(entered.status, 200, JSON.stringify(await entered.clone().json()));
    assert.match(entered.headers.get('set-cookie') || '', /mc_tenant_session=.*HttpOnly/i);
    // Re-open without a cookie works while the interview is unfinished.
    const reopened = await exchange(req('/api/auth/interview-session', { body: { ticket } }));
    assert.equal(reopened.status, 200);
  } finally {
    restoreFetch();
  }
});

test('unregistered Access identity refuses issuance with a safe compatibility error', async () => {
  const saved = process.env.MC_TENANT_REGISTRY_JSON;
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: {
    tenantId: 'isr001-tenant', companyId: 'isr001-company', installationId: 'isr001-install', kind: 'self',
  } });
  try {
    const { POST: invite } = await import('../../src/app/api/auth/interview-invitation/route');
    const refused = await invite(req('/api/auth/interview-invitation', {
      headers: { authorization: `Bearer ${token}` },
      body: { recipientHash: 'c'.repeat(64) },
    }));
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, 'access_identity_unregistered');
  } finally {
    process.env.MC_TENANT_REGISTRY_JSON = saved;
  }
});

test('wrong owner, issuer, audience, expired, forged Access tokens are rejected', async () => {
  stubJwks();
  try {
    const { resolveTenantContext } = await import('../../src/lib/auth/tenant-context');
    const context = (jwt: string) =>
      resolveTenantContext(req('/api/interview/state', { headers: { 'cf-access-jwt-assertion': jwt } }));
    await assert.rejects(context(accessJwt('intruder-subject')), 'wrong subject');
    await assert.rejects(context(accessJwt('owner-subject-1', { iss: 'https://evil.example' })), 'wrong issuer');
    await assert.rejects(context(accessJwt('owner-subject-1', { aud: ['wrong-audience'] })), 'wrong audience');
    await assert.rejects(
      context(accessJwt('owner-subject-1', { exp: Math.floor(Date.now() / 1000) - 10 })), 'expired',
    );
    await assert.rejects(context('forged.header.payload'), 'forged signature');
    const good = await context(accessJwt('owner-subject-1'));
    assert.equal(good.subject, 'owner-subject-1');
    assert.equal(good.email, 'owner@isr001.example');
  } finally {
    restoreFetch();
  }
});

test('unsigned email headers alone never authenticate', async () => {
  const { resolveTenantContext } = await import('../../src/lib/auth/tenant-context');
  await assert.rejects(
    resolveTenantContext(req('/api/interview/state', {
      headers: { 'cf-access-authenticated-user-email': 'owner@isr001.example' },
    })),
  );
  await assert.rejects(
    resolveTenantContext(req('/api/interview/state', {
      headers: { 'x-operator-email': 'owner@isr001.example' },
    })),
  );
});

test('allowedEmails allowlist gates the signed email claim only', async () => {
  stubJwks();
  const saved = process.env.MC_TENANT_REGISTRY_JSON;
  try {
    process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
      [host]: { ...registration, allowedEmails: ['owner@isr001.example'] },
    });
    const { resolveTenantContext } = await import('../../src/lib/auth/tenant-context');
    const good = await resolveTenantContext(req('/api/interview/state', {
      headers: { 'cf-access-jwt-assertion': accessJwt('owner-subject-1') },
    }));
    assert.equal(good.subject, 'owner-subject-1');
    await assert.rejects(resolveTenantContext(req('/api/interview/state', {
      headers: { 'cf-access-jwt-assertion': accessJwt('owner-subject-1', { email: 'intruder@evil.example' }) },
    })), 'unlisted signed email');
  } finally {
    process.env.MC_TENANT_REGISTRY_JSON = saved;
    restoreFetch();
  }
});

test('existing enrollment tickets still exchange and re-open', async () => {
  const { signTenantGrant } = await import('../../src/lib/auth/tenant-context');
  const { POST: exchange } = await import('../../src/app/api/auth/interview-session/route');
  const ticket = await signTenantGrant({
    ...registration, host, purpose: 'enrollment', subject: 'owner:legacy',
    exp: Math.floor(Date.now() / 1000) + 900, nonce: randomUUID(),
  });
  const first = await exchange(req('/api/auth/interview-session', { body: { ticket } }));
  assert.equal(first.status, 200);
  const cookie = first.headers.get('set-cookie')!.split(';')[0];
  const resumed = await exchange(req('/api/auth/interview-session', { body: { ticket }, cookie }));
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).resumed, true);
  const fresh = await exchange(req('/api/auth/interview-session', { body: { ticket } }));
  assert.equal(fresh.status, 200, 're-open without cookie works while unfinished');
});

test('dept decline warns first, cancel keeps state, confirm records, keep restores', async () => {
  const realScripts = '/Users/blackceomacmini/.openclaw/skills/23-ai-workforce-blueprint/scripts';
  const savedScripts = process.env.OPENCLAW_SKILL23_SCRIPTS;
  process.env.OPENCLAW_SKILL23_SCRIPTS = realScripts;
  try {
    const cookie = await sessionCookie('owner:isr001');
    const { POST: decide } = await import('../../src/app/api/interview/decision/route');
    writeState({ ...registration, interviewComplete: false, canonicalReconciliation: { decisions: {} } });

    // 1) Unconfirmed floor decline → 409 with the authoritative warning, nothing written.
    const warned = await decide(req('/api/interview/decision', {
      body: { dept: 'marketing', decision: 'no' }, cookie,
    }));
    assert.equal(warned.status, 409, JSON.stringify(await warned.clone().json()));
    const warnedBody = await warned.json();
    assert.equal(warnedBody.error, 'confirm_loss_required');
    assert.match(warnedBody.warning, /brand awareness/);
    const afterWarn = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual(afterWarn.canonicalReconciliation?.decisions || {}, {}, 'warn must not write');

    // 2) Cancel path = the client never re-posts: state stays untouched (proven above).

    // 3) Confirm with the acknowledged warning → recorded with provenance.
    const confirmed = await decide(req('/api/interview/decision', {
      body: { dept: 'marketing', decision: 'no', confirmLoss: true }, cookie,
    }));
    assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.clone().json()));
    const recorded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const entry = recorded.canonicalReconciliation.decisions.marketing;
    assert.equal(entry.decision, 'no');
    assert.ok(entry.decidedBy, 'provenance required');
    assert.equal(entry.lossWarningAck, true);
    assert.match(entry.lossWarning, /brand awareness/);

    // 4) Keep/undo: re-deciding yes restores the department (reload shows yes).
    const restored = await decide(req('/api/interview/decision', {
      body: { dept: 'marketing', decision: 'yes' }, cookie,
    }));
    assert.equal(restored.status, 200, JSON.stringify(await restored.clone().json()));
    const reloaded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(reloaded.canonicalReconciliation.decisions.marketing.decision, 'yes');
    assert.equal(reloaded.canonicalReconciliation.decisions.marketing.decidedBy, 'owner:isr001');
  } finally {
    process.env.OPENCLAW_SKILL23_SCRIPTS = savedScripts;
  }
});

test('forged CSRF and cross-origin decision writes are refused', async () => {
  const { signTenantGrant } = await import('../../src/lib/auth/tenant-context');
  const grant = await signTenantGrant({
    ...registration, host, purpose: 'session', subject: 'owner:isr001',
    exp: Math.floor(Date.now() / 1000) + 3600, nonce: randomUUID(),
  });
  const bare = `mc_tenant_session=${grant}`;
  const { POST: decide } = await import('../../src/app/api/interview/decision/route');
  const noCsrf = await decide(req('/api/interview/decision', {
    body: { dept: 'sales', decision: 'yes' }, cookie: bare,
  }));
  assert.equal(noCsrf.status, 403);
  const crossOrigin = await decide(req('/api/interview/decision', {
    body: { dept: 'sales', decision: 'yes' },
    cookie: `${bare}; ${(await csrfCookie()).slice('mc_csrf_token='.length) ? await csrfCookie() : ''}`,
    headers: { origin: 'https://evil.example' },
  }));
  assert.equal(crossOrigin.status, 403);
});

test('structured answer saves and resume position survives reload', async () => {
  const cookie = await sessionCookie('owner:isr001');
  const { POST: answer } = await import('../../src/app/api/interview/answer/route');
  const { GET: state } = await import('../../src/app/api/interview/state/route');
  const payload = {
    questionId: 'company_name', prompt: 'What is your company name?',
    answer: 'ISR Fixture Company', phase: 'business', questionNumber: 1,
  };
  const saved = await answer(req('/api/interview/answer', { body: payload, cookie }));
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  assert.equal((await saved.json()).appended, true);
  const first = await state(req('/api/interview/state', { cookie }));
  assert.equal(first.status, 200);
  const before = await first.json();
  assert.ok(before.structured.answeredIds.includes('company_name'));
  // Reload: the same transcript position comes back, never a restart.
  const second = await state(req('/api/interview/state', { cookie }));
  const after = await second.json();
  assert.deepEqual(after.structured.answeredIds, before.structured.answeredIds);
  assert.equal(after.transcript.qBlockCount, before.transcript.qBlockCount);
});
