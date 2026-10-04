/**
 * B02 — `requireHqContext`: direct-origin identity, exact operator/client identity,
 * signed grant resolution and private scope (SPEC S7 line 263-269; P02 contract §(d)).
 *
 * Acceptance exercised here (swarm-plan B02 check):
 *   • Q02 success control — a verified self subject resolves a real context, and the
 *     context carries its exact subject without collapsing it.
 *   • Two-company / two-subject denial matrix — company B's grant on company A's host,
 *     a foreign installation, an expired grant, an anonymous caller, a bearer-only
 *     caller and a shared client-kind host all refuse; same-company different subjects
 *     stay distinct principals.
 *   • No browser-held secret — the context carries no cookie/token/key field, and a
 *     refusal never echoes the credential it was handed.
 *
 * Isolation: `_isolated-db` is imported FIRST so DATABASE_PATH points at a unique
 * throwaway file and `src/lib/db`'s C8 guard can never open the live board (qc.md Q1,
 * P02 §(c)). Company resolution is exercised against that throwaway database through
 * the repo's real `companies` table, so the sentinel/identity rules are the real ones.
 *
 * NOT re-tested here (existing behaviour, existing tests, and this unit adds no code
 * to them): the resolver's own credential order and its RS256/JWKS verification
 * (`tests/unit/tenant-interview-routing-regression.test.ts`). This file tests the
 * Headquarters boundary built on top.
 */
import '../../_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb, run } from '../../../../src/lib/db';
import { signTenantGrant } from '../../../../src/lib/auth/tenant-context';
import { HqContextError, requireHqContext } from '../../../../src/lib/hq/context';

process.env.MC_API_TOKEN = 'fixture-api-token';
process.env.MC_INTERVIEW_COOKIE_SECRET = 'fixture-cookie-key';
process.env.MC_TENANT_SESSION_SECRET = 'fixture-cookie-key';
process.env.MC_INSTALLATION_ID = 'install-a';
process.env.CC_PUBLIC_URL = 'https://box-a.example';
delete process.env.COMPANY_SLUG;

const REGISTRY: Record<string, unknown> = {
  'a.example': { tenantId: 'tenant-a', companyId: 'company-a', kind: 'self', installationId: 'install-a' },
  'b.example': { tenantId: 'tenant-b', companyId: 'company-b', kind: 'self', installationId: 'install-a' },
  'c.example': { tenantId: 'tenant-c', companyId: 'company-c', kind: 'self', installationId: 'install-other' },
  'shared.example': {
    tenantId: 'tenant-shared',
    companyId: 'company-shared',
    clientId: 'client-shared',
    kind: 'client',
    installationId: 'install-shared',
    remoteUrl: 'https://customer-a.example',
    remoteApiToken: 'fixture-remote-token',
  },
};

/** Every environment read this boundary makes is set for the duration of `fn`. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const withRegistry = <T>(fn: () => Promise<T> | T) =>
  withEnv({ MC_TENANT_REGISTRY_JSON: JSON.stringify(REGISTRY) }, fn);

function req(host: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://${host}/api/hq/snapshot`, { headers: { host, ...headers } });
}

/** A real signed session grant, produced through the repo's own issuer (registry set, as a live box has it). */
async function sessionCookie(
  host: string,
  subject: string,
  opts: { companyId?: string; exp?: number; installationId?: string } = {},
): Promise<string> {
  return withRegistry(async () => {
    const token = await signTenantGrant({
      purpose: 'session',
      tenantId: `tenant-${host.split('.')[0]}`,
      companyId: opts.companyId,
      subject,
      host,
      installationId: opts.installationId ?? 'install-a',
      exp: opts.exp ?? Date.now() / 1000 + 3600,
      nonce: randomUUID(),
    });
    return `mc_tenant_session=${token}`;
  });
}

/** The refusal this boundary publishes — status, code and (never private) link. */
async function refusal(request: { headers: Headers }): Promise<HqContextError> {
  try {
    await requireHqContext(request);
  } catch (err) {
    assert.ok(err instanceof HqContextError, `expected HqContextError, got ${String(err)}`);
    return err;
  }
  throw new Error('requireHqContext resolved where a refusal was required');
}

getDb();
run("INSERT OR IGNORE INTO companies(id,name,slug) VALUES('company-a','Company A','company-a')", []);
run("INSERT OR IGNORE INTO companies(id,name,slug) VALUES('company-b','Company B','company-b')", []);

test('Q02 success control: a verified self subject resolves its registered company and exact subject', async () => {
  const cookie = await sessionCookie('a.example', 'Owner:A');
  const ctx = await withRegistry(() => requireHqContext(req('a.example', { cookie })));
  assert.equal(ctx.companyId, 'company-a');
  assert.equal(ctx.installationId, 'install-a');
  assert.equal(ctx.host, 'a.example');
  assert.equal(ctx.kind, 'self');
  assert.equal(ctx.subject, 'Owner:A', 'the verified subject is never normalized or collapsed');
  assert.equal(ctx.ownerSubject, ctx.subject, 'private scope is the same verified subject, not a second source');
});

test('no browser-held secret is returned or echoed by the context', async () => {
  const cookie = await sessionCookie('a.example', 'owner:a');
  const ctx = await withRegistry(() => requireHqContext(req('a.example', { cookie })));
  const serialized = JSON.stringify(ctx).toLowerCase();
  for (const forbidden of ['cookie', 'token', 'secret', 'authorization', 'bearer', 'password']) {
    assert.ok(!serialized.includes(forbidden), `context leaked a ${forbidden} field`);
  }
  const refusalText = (await withRegistry(() => refusal(req('a.example', { cookie: 'mc_tenant_session=forged.value' })))).message.toLowerCase();
  assert.ok(!refusalText.includes('forged'), 'refusal echoed the presented credential');
});

test('anonymous caller is refused 401 with no data and no link', async () => {
  const err = await withRegistry(() => refusal(req('a.example')));
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthenticated');
  assert.equal(err.link, null);
});

test('two-company matrix: a valid grant is host-bound and cannot be replayed on another company host', async () => {
  const forB = await sessionCookie('b.example', 'owner:b', { companyId: 'company-b' });
  // Same installation, same secret, same signing key — only the host differs.
  const err = await withRegistry(() => refusal(req('a.example', { cookie: forB })));
  assert.equal(err.status, 401, 'a foreign-company grant on this host is not an identity at all');
  assert.equal(err.code, 'unauthenticated');

  const forA = await sessionCookie('a.example', 'owner:a');
  const ctxA = await withRegistry(() => requireHqContext(req('a.example', { cookie: forA })));
  assert.equal(ctxA.companyId, 'company-a');
});

test('two-subject matrix: same company, different subjects stay separate principals', async () => {
  const one = await sessionCookie('a.example', 'owner:one');
  const two = await sessionCookie('a.example', 'owner:two');
  const ctxOne = await withRegistry(() => requireHqContext(req('a.example', { cookie: one })));
  const ctxTwo = await withRegistry(() => requireHqContext(req('a.example', { cookie: two })));
  assert.equal(ctxOne.companyId, ctxTwo.companyId, 'same company');
  assert.equal(ctxOne.subject, 'owner:one');
  assert.equal(ctxTwo.subject, 'owner:two');
  assert.notEqual(ctxOne.subject, ctxTwo.subject, 'subjects are never collapsed into one owner');
  assert.equal(ctxOne.ownerSubject, 'owner:one');
  assert.equal(ctxTwo.ownerSubject, 'owner:two');
});

test('expired signed grant is refused 401 before any company resolution', async () => {
  const expired = await sessionCookie('a.example', 'owner:a', { exp: 1 });
  const err = await withRegistry(() => refusal(req('a.example', { cookie: expired })));
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthenticated');
});

test('wrong installation is refused 403 even with a valid grant', async () => {
  const cookie = await sessionCookie('c.example', 'owner:c', { installationId: 'install-other' });
  const err = await withRegistry(() => refusal(req('c.example', { cookie })));
  assert.equal(err.status, 403);
  assert.equal(err.code, 'installation_mismatch');
});

test('shared client-kind host is refused 403 hq_direct_origin_required with the customer link', async () => {
  const err = await withRegistry(() => refusal(req('shared.example')));
  assert.equal(err.status, 403);
  assert.equal(err.code, 'hq_direct_origin_required');
  assert.equal(err.link, 'https://customer-a.example', 'the configured customer origin, and no private data');
  // Identity is not consulted at all: anonymous and credentialed callers get the same refusal.
  const withCookie = await withRegistry(() => refusal(req('shared.example', { cookie: 'mc_tenant_session=anything' })));
  assert.equal(withCookie.code, 'hq_direct_origin_required');
});

test('unregistered host is refused 403 and never selects a tenant', async () => {
  const err = await withRegistry(() => refusal(req('unknown.example')));
  assert.equal(err.status, 403);
  assert.equal(err.code, 'unregistered_host');
});

test('bearer-only operator:api identity is refused on a browser Headquarters route', async () => {
  const err = await withRegistry(() => refusal(req('a.example', { authorization: 'Bearer fixture-api-token' })));
  assert.equal(err.status, 403);
  assert.equal(err.code, 'hq_browser_identity_required');
});

test('a request carrying BOTH a service bearer and a verified browser identity authorizes as the browser subject', async () => {
  const cookie = await sessionCookie('a.example', 'owner:browser');
  const ctx = await withRegistry(() =>
    requireHqContext(req('a.example', { authorization: 'Bearer fixture-api-token', cookie })),
  );
  assert.equal(ctx.subject, 'owner:browser', 'the browser subject wins; the bearer never becomes the identity');
  assert.equal(ctx.ownerSubject, 'owner:browser');
  assert.equal(ctx.companyId, 'company-a');
});

test('the local development identity is refused, never accepted as a fallback', async () => {
  await withEnv({ MC_TENANT_REGISTRY_JSON: undefined, INTERVIEW_TENANT_TRUST_LOCAL: 'true', NODE_ENV: 'development' }, async () => {
    // Known-good control on the same environment: the existing resolver DOES produce
    // the development identity here, so the refusal below is this boundary's decision
    // and not an unreachable branch.
    const { resolveTenantContext } = await import('../../../../src/lib/auth/tenant-context');
    const control = await resolveTenantContext(req('localhost'));
    assert.equal(control.subject, 'development:local', 'known-good control on the same environment');

    const err = await refusal(req('localhost'));
    assert.equal(err.status, 403);
    assert.equal(err.code, 'hq_local_identity_refused');
  });
});

test('a sentinel identity resolves the installation company through the server resolver, never row order of a foreign row', async () => {
  const cookie = await sessionCookie('a.example', 'owner:a', { companyId: 'default' });
  await withEnv(
    {
      MC_TENANT_REGISTRY_JSON: JSON.stringify({
        'a.example': { tenantId: 'tenant-a', companyId: 'default', kind: 'self', installationId: 'install-a' },
      }),
      MC_COMPANY_ID: 'company-a',
    },
    async () => {
      const ctx = await requireHqContext(req('a.example', { cookie }));
      assert.equal(ctx.companyId, 'company-a', 'the installation identity decides, not a placeholder row');
    },
  );
});

test('an un-branded box with no resolvable company is refused 409 company_not_bound with a setup link, never global rows', async () => {
  const cookie = await sessionCookie('a.example', 'owner:a', { companyId: 'default' });
  // Only the placeholder rows exist: this is the genuinely unprovisioned state.
  run("DELETE FROM companies WHERE id IN ('company-a','company-b')", []);
  try {
    await withEnv(
      {
        MC_TENANT_REGISTRY_JSON: JSON.stringify({
          'a.example': { tenantId: 'tenant-a', companyId: 'default', kind: 'self', installationId: 'install-a' },
        }),
        MC_COMPANY_ID: undefined,
      },
      async () => {
        const err = await refusal(req('a.example', { cookie }));
        assert.equal(err.status, 409);
        assert.equal(err.code, 'company_not_bound');
        assert.equal(err.link, 'https://box-a.example/onboarding', 'a setup link, not a data response');
      },
    );
  } finally {
    run("INSERT OR IGNORE INTO companies(id,name,slug) VALUES('company-a','Company A','company-a')", []);
    run("INSERT OR IGNORE INTO companies(id,name,slug) VALUES('company-b','Company B','company-b')", []);
  }
});
