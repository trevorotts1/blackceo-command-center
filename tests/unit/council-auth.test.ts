/**
 * council-auth.test.ts — CWE-007 trusted authorization adapter
 * (src/lib/council/auth.ts), directive Sections 17.1, 17.5, 28.2.
 *
 * Negative fixtures are the heart of this unit: cross-tenant and
 * cross-company reads denied, private session read by a same-company
 * non-owner denied, conflicting claimed scope rejected, missing auth
 * configuration fails closed, expired or foreign grants fail closed
 * (T084), and the operator token never appears in a client-bound
 * payload. Principals are resolved through the REAL tenant context with
 * REAL signed session grants (signTenantGrant); all credential values
 * below are invented test fixtures, never real secrets.
 *
 *   node --import tsx --test tests/unit/council-auth.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';
import { signCsrfToken } from '../../src/lib/csrf-protection';
import {
  assertClaimedScopeMatches,
  assertCouncilAuthConfigured,
  assertCouncilCsrf,
  assertCouncilSessionMutate,
  assertCouncilSessionRead,
  assertMachineBinding,
  assertNoConfiguredSecretsInPayload,
  assertNoQueryCredential,
  clientSafePrincipalView,
  CouncilAuthError,
  resolveCouncilPrincipal,
  type CouncilPrincipal,
  type CouncilSessionTarget,
} from '../../src/lib/council/auth';

const ENV_KEYS = [
  'MC_TENANT_REGISTRY_JSON',
  'MC_TENANT_SESSION_SECRET',
  'MC_INTERVIEW_COOKIE_SECRET',
  'MC_API_TOKEN',
  'MC_CSRF_COOKIE_SECRET',
  'MC_COUNCIL_SUPPORT_SUBJECTS',
] as const;

const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

const SESSION_SECRET = 'cwe007-fixture-session-secret';
const OPERATOR_TOKEN = 'cwe007-fixture-operator-token';
const CSRF_SECRET = 'cwe007-fixture-csrf-secret';

function installFixtureEnv(): void {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'council-a.test': {
      tenantId: 'tenant-a',
      companyId: 'company-a',
      kind: 'self',
      installationId: 'install-a',
    },
    'council-b.test': {
      tenantId: 'tenant-b',
      companyId: 'company-b',
      kind: 'self',
      installationId: 'install-b',
    },
  });
  process.env.MC_TENANT_SESSION_SECRET = SESSION_SECRET;
  process.env.MC_API_TOKEN = OPERATOR_TOKEN;
  process.env.MC_CSRF_COOKIE_SECRET = CSRF_SECRET;
  delete process.env.MC_INTERVIEW_COOKIE_SECRET;
  delete process.env.MC_COUNCIL_SUPPORT_SUBJECTS;
}

test.after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const HOSTS = {
  'council-a.test': {
    tenantId: 'tenant-a',
    companyId: 'company-a',
    installationId: 'install-a',
  },
  'council-b.test': {
    tenantId: 'tenant-b',
    companyId: 'company-b',
    installationId: 'install-b',
  },
} as const;

async function sessionRequest(
  host: keyof typeof HOSTS,
  subject: string,
): Promise<NextRequest> {
  const reg = HOSTS[host];
  const token = await signTenantGrant({
    purpose: 'session',
    tenantId: reg.tenantId,
    companyId: reg.companyId,
    subject,
    host,
    installationId: reg.installationId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: `fixture-${subject}`,
  });
  // NextRequest with an explicit host header, the repo's own tenant-test
  // pattern: a plain fetch Request drops the forbidden host header, and
  // tenant resolution keys on it.
  return new NextRequest(`https://${host}/api/council/sessions`, {
    headers: { host, cookie: `mc_tenant_session=${token}` },
  });
}

function isCouncilError(code: string, status?: number) {
  return (error: unknown): boolean =>
    error instanceof CouncilAuthError &&
    error.code === code &&
    (status === undefined || error.status === status);
}

const privateTargetA: CouncilSessionTarget = {
  visibility: 'private',
  scope: {
    tenant_id: 'tenant-a',
    company_id: 'company-a',
    installation_id: 'install-a',
    owner_subject: 'owner:alice',
  },
};

test('valid session grant resolves a principal with the exact trusted scope', async () => {
  installFixtureEnv();
  const principal = await resolveCouncilPrincipal(
    await sessionRequest('council-a.test', 'owner:alice'),
  );
  assert.equal(principal.subject, 'owner:alice');
  assert.equal(principal.channel, 'browser');
  assert.equal(principal.supportAccess, false);
  assert.deepEqual(principal.scope, {
    tenant_id: 'tenant-a',
    company_id: 'company-a',
    installation_id: 'install-a',
    owner_subject: null,
  });
});

test('cross-tenant grant fails closed: a grant minted for host B is worthless on host A (T084)', async () => {
  installFixtureEnv();
  const foreign = await sessionRequest('council-b.test', 'owner:alice');
  const replayed = new NextRequest('https://council-a.test/api/council/sessions', {
    headers: { host: 'council-a.test', cookie: foreign.headers.get('cookie') ?? '' },
  });
  await assert.rejects(
    resolveCouncilPrincipal(replayed),
    isCouncilError('COUNCIL_UNAUTHENTICATED', 403),
  );
});

test('expired session grant fails closed (T084)', async () => {
  installFixtureEnv();
  const payload = Buffer.from(
    JSON.stringify({
      purpose: 'session',
      tenantId: 'tenant-a',
      companyId: 'company-a',
      subject: 'owner:alice',
      host: 'council-a.test',
      installationId: 'install-a',
      exp: Math.floor(Date.now() / 1000) - 60,
      nonce: 'expired-fixture',
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  const request = new NextRequest('https://council-a.test/api/council/sessions', {
    headers: {
      host: 'council-a.test',
      cookie: `mc_tenant_session=${payload}.${signature}`,
    },
  });
  await assert.rejects(
    resolveCouncilPrincipal(request),
    isCouncilError('COUNCIL_UNAUTHENTICATED', 403),
  );
});

test('cross-company and cross-tenant session reads are denied (T073)', async () => {
  installFixtureEnv();
  const principal = await resolveCouncilPrincipal(
    await sessionRequest('council-a.test', 'owner:alice'),
  );
  for (const foreign of [
    { ...privateTargetA, scope: { ...privateTargetA.scope, company_id: 'company-b' } },
    { ...privateTargetA, scope: { ...privateTargetA.scope, tenant_id: 'tenant-b' } },
    {
      ...privateTargetA,
      scope: { ...privateTargetA.scope, installation_id: 'install-b' },
    },
  ]) {
    assert.throws(
      () => assertCouncilSessionRead(principal, foreign),
      isCouncilError('COUNCIL_CROSS_SCOPE'),
    );
  }
});

test('private session: non-owner in the same company denied, owner allowed, company-visible allowed (T073/T074)', async () => {
  installFixtureEnv();
  const owner = await resolveCouncilPrincipal(
    await sessionRequest('council-a.test', 'owner:alice'),
  );
  const colleague = await resolveCouncilPrincipal(
    await sessionRequest('council-a.test', 'user:bob'),
  );
  assert.equal(assertCouncilSessionRead(owner, privateTargetA), 'owner');
  assert.throws(
    () => assertCouncilSessionRead(colleague, privateTargetA),
    isCouncilError('COUNCIL_PRIVATE_OWNER_REQUIRED'),
  );
  assert.throws(
    () => assertCouncilSessionMutate(colleague, privateTargetA),
    isCouncilError('COUNCIL_PRIVATE_OWNER_REQUIRED'),
  );
  assert.equal(
    assertCouncilSessionRead(colleague, {
      ...privateTargetA,
      visibility: 'company',
    }),
    'company',
  );
});

test('conflicting claimed body scope rejected; equal claimed scope accepted; owner spoof rejected (T074)', async () => {
  installFixtureEnv();
  const principal = await resolveCouncilPrincipal(
    await sessionRequest('council-a.test', 'owner:alice'),
  );
  assertClaimedScopeMatches(principal, {
    tenant_id: 'tenant-a',
    companyId: 'company-a',
  });
  assertClaimedScopeMatches(principal, {});
  assert.throws(
    () => assertClaimedScopeMatches(principal, { company_id: 'company-b' }),
    isCouncilError('COUNCIL_SCOPE_MISMATCH'),
  );
  assert.throws(
    () => assertClaimedScopeMatches(principal, { tenantId: 'tenant-b' }),
    isCouncilError('COUNCIL_SCOPE_MISMATCH'),
  );
  // A copied approval naming someone else as owner confers nothing.
  assert.throws(
    () =>
      assertClaimedScopeMatches(principal, { owner_subject: 'owner:mallory' }),
    isCouncilError('COUNCIL_SCOPE_MISMATCH'),
  );
});

test('missing auth configuration fails closed with a readiness error, never an open API', async () => {
  installFixtureEnv();
  // Unregistered host.
  const unregistered = new NextRequest('https://nowhere.test/api/council/x', {
    headers: { host: 'nowhere.test' },
  });
  assert.throws(
    () => assertCouncilAuthConfigured(unregistered),
    isCouncilError('COUNCIL_AUTH_NOT_CONFIGURED', 503),
  );
  await assert.rejects(
    resolveCouncilPrincipal(unregistered),
    isCouncilError('COUNCIL_AUTH_NOT_CONFIGURED', 503),
  );
  // Registered host but no signing secret configured: a presented grant
  // cannot verify (the tenant verifier fails closed), and the readiness
  // probe reports not-configured. Neither path ever returns a principal.
  delete process.env.MC_TENANT_SESSION_SECRET;
  delete process.env.MC_API_TOKEN;
  const forged = new NextRequest('https://council-a.test/api/council/sessions', {
    headers: { host: 'council-a.test', cookie: 'mc_tenant_session=forged.value' },
  });
  await assert.rejects(
    resolveCouncilPrincipal(forged),
    isCouncilError('COUNCIL_UNAUTHENTICATED', 403),
  );
  assert.throws(
    () =>
      assertCouncilAuthConfigured(
        new NextRequest('https://council-a.test/api/council/x', {
          headers: { host: 'council-a.test' },
        }),
      ),
    isCouncilError('COUNCIL_AUTH_NOT_CONFIGURED', 503),
  );
  // No credentials at all: unauthenticated, never a principal.
  await assert.rejects(
    resolveCouncilPrincipal(
      new NextRequest('https://council-a.test/api/council/sessions', {
        headers: { host: 'council-a.test' },
      }),
    ),
    isCouncilError('COUNCIL_UNAUTHENTICATED', 403),
  );
});

test('operator token never appears in any client-bound payload', async () => {
  installFixtureEnv();
  const principal = await resolveCouncilPrincipal(
    new NextRequest('https://council-a.test/api/council/sessions', {
      headers: { host: 'council-a.test', authorization: `Bearer ${OPERATOR_TOKEN}` },
    }),
  );
  assert.equal(principal.channel, 'machine');
  const view = clientSafePrincipalView(principal);
  assertNoConfiguredSecretsInPayload(view);
  assert.equal(JSON.stringify(view).includes(OPERATOR_TOKEN), false);
  // Error surfaces carry codes and messages only.
  let caught: unknown = null;
  try {
    assertCouncilSessionRead(principal, privateTargetA);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof CouncilAuthError,
    'machine principal must not read a private session by scope alone',
  );
  assert.equal(
    JSON.stringify(
      caught,
      Object.getOwnPropertyNames(caught as Error),
    ).includes(OPERATOR_TOKEN),
    false,
  );
  // A planted token in a payload is caught by the guard.
  assert.throws(
    () => assertNoConfiguredSecretsInPayload({ note: `leak ${OPERATOR_TOKEN}` }),
    isCouncilError('COUNCIL_SECRET_LEAK', 500),
  );
  assertNoConfiguredSecretsInPayload({ note: 'clean payload' });
});

test('machine binding: installation pin, scope, operation set, session pin (T077)', async () => {
  installFixtureEnv();
  const machinePrincipal: CouncilPrincipal = await resolveCouncilPrincipal(
    new NextRequest('https://council-a.test/api/council/sessions', {
      headers: { host: 'council-a.test', authorization: `Bearer ${OPERATOR_TOKEN}` },
    }),
  );
  const binding = {
    installation_id: 'install-a',
    company_id: 'company-a',
    operations: ['read', 'export'] as const,
    session_id: 'session-1',
  };
  const pinned = new Headers({ 'x-expected-installation-id': 'install-a' });
  assertMachineBinding(machinePrincipal, pinned, binding, 'read', 'session-1');
  // No installation pin.
  assert.throws(
    () => assertMachineBinding(machinePrincipal, new Headers(), binding, 'read', 'session-1'),
    isCouncilError('COUNCIL_MACHINE_BINDING'),
  );
  // Wrong pin.
  assert.throws(
    () =>
      assertMachineBinding(
        machinePrincipal,
        new Headers({ 'x-expected-installation-id': 'install-b' }),
        binding,
        'read',
        'session-1',
      ),
    isCouncilError('COUNCIL_MACHINE_BINDING'),
  );
  // Operation outside the binding.
  assert.throws(
    () => assertMachineBinding(machinePrincipal, pinned, binding, 'execute', 'session-1'),
    isCouncilError('COUNCIL_MACHINE_BINDING'),
  );
  // Session-pinned binding used for another session.
  assert.throws(
    () => assertMachineBinding(machinePrincipal, pinned, binding, 'read', 'session-2'),
    isCouncilError('COUNCIL_MACHINE_BINDING'),
  );
  // A browser principal can never satisfy a machine binding.
  const browser = await resolveCouncilPrincipal(
    await sessionRequest('council-a.test', 'owner:alice'),
  );
  assert.throws(
    () => assertMachineBinding(browser, pinned, binding, 'read', 'session-1'),
    isCouncilError('COUNCIL_MACHINE_BINDING'),
  );
});

test('query credential parameters are rejected; clean queries pass', () => {
  installFixtureEnv();
  assert.throws(
    () =>
      assertNoQueryCredential(
        new URL('https://council-a.test/api/council/sessions?api_key=fixture'),
      ),
    isCouncilError('COUNCIL_QUERY_CREDENTIAL', 400),
  );
  assert.throws(
    () =>
      assertNoQueryCredential(
        new URL('https://council-a.test/api/council/events?access_token=fixture'),
      ),
    isCouncilError('COUNCIL_QUERY_CREDENTIAL', 400),
  );
  assertNoQueryCredential(
    new URL('https://council-a.test/api/council/sessions?visibility=company'),
  );
});

test('CSRF: mutating methods require the signed cookie, read-only methods exempt', async () => {
  installFixtureEnv();
  const { value } = await signCsrfToken();
  await assertCouncilCsrf(
    new NextRequest('https://council-a.test/api/council/sessions', {
      method: 'GET',
      headers: { host: 'council-a.test' },
    }),
  );
  await assert.rejects(
    assertCouncilCsrf(
      new NextRequest('https://council-a.test/api/council/sessions', {
        method: 'POST',
        headers: { host: 'council-a.test' },
      }),
    ),
    isCouncilError('COUNCIL_CSRF_REQUIRED'),
  );
  await assertCouncilCsrf(
    new NextRequest('https://council-a.test/api/council/sessions', {
      method: 'POST',
      headers: { host: 'council-a.test', cookie: `mc_csrf_token=${value}` },
    }),
  );
  await assert.rejects(
    assertCouncilCsrf(
      new NextRequest('https://council-a.test/api/council/sessions', {
        method: 'POST',
        headers: { host: 'council-a.test', cookie: 'mc_csrf_token=forged.value' },
      }),
    ),
    isCouncilError('COUNCIL_CSRF_REQUIRED'),
  );
});

test('support access: host-configured subject reads via the audited support path only, never mutates (T075)', async () => {
  installFixtureEnv();
  process.env.MC_COUNCIL_SUPPORT_SUBJECTS = 'support:carol';
  const support = await resolveCouncilPrincipal(
    await sessionRequest('council-a.test', 'support:carol'),
  );
  assert.equal(support.supportAccess, true);
  assert.equal(assertCouncilSessionRead(support, privateTargetA), 'support');
  assert.throws(
    () => assertCouncilSessionMutate(support, privateTargetA),
    isCouncilError('COUNCIL_PRIVATE_OWNER_REQUIRED'),
  );
  // The same subject without host configuration has no support path.
  delete process.env.MC_COUNCIL_SUPPORT_SUBJECTS;
  const ordinary = await resolveCouncilPrincipal(
    await sessionRequest('council-a.test', 'support:carol'),
  );
  assert.equal(ordinary.supportAccess, false);
  assert.throws(
    () => assertCouncilSessionRead(ordinary, privateTargetA),
    isCouncilError('COUNCIL_PRIVATE_OWNER_REQUIRED'),
  );
  // A request can never borrow another identity: claiming the session
  // owner as itself is a scope mismatch for the support subject too.
  assert.throws(
    () =>
      assertClaimedScopeMatches(ordinary, { owner_subject: 'owner:alice' }),
    isCouncilError('COUNCIL_SCOPE_MISMATCH'),
  );
});
