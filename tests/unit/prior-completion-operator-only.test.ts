import './_isolated-db';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { getDb } from '../../src/lib/db';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';
import { signCsrfToken } from '../../src/lib/csrf-protection';
import { priorCompletion } from '../../src/lib/interview/prior-completion';

/**
 * BU-05 (WF-008 / WF-013) — "I have already completed the interview" and
 * "Skip for now" are operator-only.
 *
 *   1. A non-operator self session is refused with 403 operator_required and
 *      writes no declaration row.
 *   2. A client-kind session is refused the same way — never an owner
 *      attestation about someone else's company.
 *   3. An operator session (self tenant, operator: subject) is accepted; a
 *      failing store still answers 503 and never promises a saved declaration.
 *   4. The rendered interview page carries neither the declaration control nor
 *      "Skip for now" for a non-operator.
 *
 * Rows written before this change are untouched and keep opening the dashboard
 * through the gate cookie (`refreshInterviewGate` reads them); this unit deletes
 * none of them.
 */

const host = 'operator-only.example';
const selfReg = {
  kind: 'self',
  tenantId: 'oo-tenant',
  companyId: 'oo-company',
  installationId: 'oo-install',
  issuer: 'https://operator-only-access.example',
  audience: 'oo-aud',
  subjects: ['owner@example.com'],
};
const clientHost = 'client.operator-only.example';
const clientReg = {
  ...selfReg,
  kind: 'client',
  tenantId: 'oo-remote-tenant',
  clientId: 'oo-remote-client',
  remoteUrl: 'https://remote.operator-only.example',
  remoteSecret: 'oo-remote-fixture',
};

const workspace = mkdtempSync(join(tmpdir(), 'prior-operator-only-'));
Object.assign(process.env, {
  MC_API_TOKEN: 'oo-fixture-token',
  MC_INTERVIEW_COOKIE_SECRET: 'oo-fixture-secret',
  MC_TENANT_SESSION_SECRET: 'oo-fixture-session',
  MC_CSRF_COOKIE_SECRET: 'oo-fixture-csrf',
  MC_TENANT_REGISTRY_JSON: JSON.stringify({ [host]: selfReg, [clientHost]: clientReg }),
  OPENCLAW_WORKSPACE_ROOT: workspace,
  OPENCLAW_SKILL23_SCRIPTS: workspace,
  REQUIRE_CF_ACCESS: 'false',
  DEMO_MODE: 'false',
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
});
writeFileSync(
  join(workspace, '.workforce-build-state.json'),
  JSON.stringify({ interviewComplete: false, interviewQc: { status: 'pending' }, companyId: selfReg.companyId }),
);

function request(hostName: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return new NextRequest(`https://${hostName}${path}`, {
    headers: {
      host: hostName,
      ...(body === undefined ? {} : { origin: `https://${hostName}` }),
      ...headers,
    },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
}

async function sessionHeaders(hostName: string, reg: Record<string, unknown>, subject: string) {
  const session = await signTenantGrant({
    ...(reg as typeof selfReg),
    host: hostName,
    subject,
    purpose: 'session',
    exp: Date.now() / 1000 + 3600,
    nonce: `fixture-${subject}`,
  });
  const csrf = (await signCsrfToken()).value;
  return {
    host: hostName,
    origin: `https://${hostName}`,
    cookie: `mc_tenant_session=${session}; mc_csrf_token=${csrf}`,
  };
}

function declarationCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM interview_prior_completion_declarations').get() as { n: number }).n;
}

test('a non-operator self session is refused and writes no declaration', async () => {
  const { POST } = await import('../../src/app/api/interview/prior-completion/route');
  const headers = await sessionHeaders(host, selfReg, 'owner-uuid');
  const response = await POST(request(host, '/api/interview/prior-completion', headers, { confirmed: true }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'operator_required');
  assert.equal(declarationCount(), 0);
  assert.equal(priorCompletion(selfReg), null);
});

test('a client-kind session is refused and writes no declaration', async () => {
  getDb().prepare('INSERT INTO clients(id,name,is_self,interview_complete) VALUES(?,?,0,0)').run(clientReg.clientId, 'Fixture');
  const { POST } = await import('../../src/app/api/interview/prior-completion/route');
  const headers = await sessionHeaders(clientHost, clientReg, 'remote-owner');
  const response = await POST(request(clientHost, '/api/interview/prior-completion', headers, { confirmed: true }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'operator_required');
  assert.equal(declarationCount(), 0);
});

test('an operator session is accepted; a failing store answers 503, never a promise', async () => {
  const { POST } = await import('../../src/app/api/interview/prior-completion/route');
  const headers = await sessionHeaders(host, selfReg, 'operator:owner-uuid');
  const accepted = await POST(request(host, '/api/interview/prior-completion', headers, { confirmed: true }));
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).priorCompletionDeclared, true);
  assert.equal(declarationCount(), 1);
  getDb().exec(
    "CREATE TRIGGER oo_reject_prior BEFORE INSERT ON interview_prior_completion_declarations BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END",
  );
  try {
    const refused = await POST(request(host, '/api/interview/prior-completion', headers, { confirmed: true }));
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).error, 'declaration_not_saved');
  } finally {
    getDb().exec('DROP TRIGGER oo_reject_prior');
  }
});

test('the non-operator page render carries neither control', async () => {
  const { default: InterviewClient } = await import('../../src/app/interview/InterviewClient');
  const router = {
    back() {},
    forward() {},
    refresh() {},
    hmrRefresh() {},
    push() {},
    replace() {},
    prefetch() {},
    experimental_gesturePush() {},
  };
  const markup = renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: router }, createElement(InterviewClient)),
  );
  // Control first: the consent screen really rendered.
  assert.ok(markup.includes('Begin interview'), 'the consent screen must render');
  assert.equal(markup.includes('I have already completed the interview'), false);
  assert.equal(markup.includes('Skip for now'), false);
});
