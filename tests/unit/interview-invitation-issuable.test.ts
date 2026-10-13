/**
 * Items 07 + 13: readiness and issuance answer the SAME question the same way.
 *
 * The defect this pins: `/api/auth/interview-ready` reported `ready:true` (with
 * only a `warnings` entry) for a host whose registry entry carried no Access
 * issuer/audience/subjects — the exact state `createInterviewInvitation()`
 * refuses with 409 `access_identity_unregistered`. Every caller was told a link
 * could be issued at the moment it could not.
 *
 * The contract now: one shared predicate, `invitationPrerequisites()`, feeds
 * both. Readiness exposes `capabilities.invitationIssuable` and fails `ready`
 * for the same reasons; issuance keeps its specific refusal name. Nothing here
 * invents an issuer, an audience or a subject, and runtime health stays
 * separate (`capabilities.runtimeReady`, `providerLiveness`).
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const host = 'issuable.example';
const token = 'issuable-api-token';
const laneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issuable-'));
const workspace = path.join(laneRoot, 'workspace');
const companyRoot = path.join(laneRoot, 'company');
const runtimeRoot = path.join(laneRoot, 'runtime');
const stubScripts = path.join(laneRoot, 'stub-scripts');
const statePath = path.join(workspace, '.workforce-build-state.json');
const catalogPath = path.join(companyRoot, 'catalog.json');

const identity = { tenantId: 'issuable-tenant', companyId: 'issuable-company', installationId: 'issuable-install' };
const registered = {
  ...identity, kind: 'self',
  issuer: 'https://issuable-access.example', audience: 'issuable-audience', subjects: ['owner@issuable.example'],
};

function withRegistry(entry: unknown, fn: () => void | Promise<void>) {
  const saved = process.env.MC_TENANT_REGISTRY_JSON;
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: entry });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.MC_TENANT_REGISTRY_JSON;
      else process.env.MC_TENANT_REGISTRY_JSON = saved;
    });
}

test('predicate: a complete registered host is issuable', async () => {
  const { invitationPrerequisites } = await import('../../src/lib/auth/tenant-context');
  await withRegistry(registered, () => {
    const gate = invitationPrerequisites({ kind: 'self', installationId: identity.installationId, host });
    assert.deepEqual(gate, { issuable: true, reasons: [] });
  });
});

test('predicate: an identity-only registry (no Access triple) is not issuable', async () => {
  const { invitationPrerequisites } = await import('../../src/lib/auth/tenant-context');
  await withRegistry({ ...identity, kind: 'self' }, () => {
    const gate = invitationPrerequisites({ kind: 'self', installationId: identity.installationId, host });
    assert.equal(gate.issuable, false);
    assert.deepEqual(gate.reasons, ['access_identity_unregistered']);
  });
});

test('predicate: foreign installation and non-self registration fail on their own keys', async () => {
  const { invitationPrerequisites } = await import('../../src/lib/auth/tenant-context');
  await withRegistry(registered, () => {
    const foreign = invitationPrerequisites({ kind: 'self', installationId: 'someone-else-install', host });
    assert.equal(foreign.issuable, false);
    assert.ok(foreign.reasons.includes('installation_id'));
    const client = invitationPrerequisites({ kind: 'client', installationId: identity.installationId, host });
    assert.equal(client.issuable, false);
    assert.ok(client.reasons.includes('dedicated_self_registration'));
  });
});

test('predicate: an unregistered host is not issuable', async () => {
  const { invitationPrerequisites } = await import('../../src/lib/auth/tenant-context');
  const saved = process.env.MC_TENANT_REGISTRY_JSON;
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ 'someone-else.example': registered });
  try {
    const gate = invitationPrerequisites({ kind: 'self', installationId: identity.installationId, host });
    assert.equal(gate.issuable, false);
    assert.ok(gate.reasons.includes('access_identity_unregistered'));
  } finally {
    if (saved === undefined) delete process.env.MC_TENANT_REGISTRY_JSON;
    else process.env.MC_TENANT_REGISTRY_JSON = saved;
  }
});

test.before(async () => {
  for (const dir of [workspace, companyRoot, stubScripts, path.join(runtimeRoot, 'agents', 'main', 'agent')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(companyRoot, 'company-config.json'), JSON.stringify({ companyId: identity.companyId, companySlug: identity.companyId }));
  fs.writeFileSync(catalogPath, JSON.stringify({ personas: { canonical: { name: 'Canonical Fixture' } } }));
  for (const file of ['update-interview-state.sh', 'record-dept-decision.sh', 'list-canonical-departments.py']) {
    fs.writeFileSync(path.join(stubScripts, file), '# fixture\n');
  }
  fs.writeFileSync(path.join(runtimeRoot, 'openclaw.json'), JSON.stringify({ agents: { entries: { main: { workspace, model: 'fixture/model' } } } }));
  Object.assign(process.env, {
    OPENCLAW_WORKSPACE_ROOT: workspace, OPENCLAW_SKILL23_SCRIPTS: stubScripts, OPENCLAW_ROOT: runtimeRoot,
    OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:1', MC_API_TOKEN: token,
    MC_COMPANY_ID: identity.companyId, MC_INSTALLATION_ID: identity.installationId,
    MC_TENANT_PUBLIC_URL: `https://${host}`,
    DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
  });
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [host]: registered });
  process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON = JSON.stringify({ [identity.companyId]: {
    companyRoot, companyConfig: path.join(companyRoot, 'company-config.json'),
    companySlug: identity.companyId, personaCatalog: catalogPath,
  } });
  fs.writeFileSync(statePath, JSON.stringify({
    ...identity, interviewComplete: false, buildType: 'legacy', buildId: 'issuable-build',
  }));
  const { getDb, run } = await import('../../src/lib/db');
  getDb();
  run("INSERT OR IGNORE INTO companies(id,name,slug) VALUES(?,?,?)", [identity.companyId, 'Issuable Fixture', identity.companyId]);
  run("INSERT OR IGNORE INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)", [randomUUID(), 'General Task', 'general-task', identity.companyId]);
});

test('readiness: identity-only registry reports not-issuable AND not-ready (items 07 + 13)', async () => {
  const { GET } = await import('../../src/app/api/auth/interview-ready/route');
  const req = () => new NextRequest(`https://${host}/api/auth/interview-ready`, { headers: { host, authorization: `Bearer ${token}` } });
  await withRegistry({ ...identity, kind: 'self' }, async () => {
    const response = await GET(req());
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.equal(body.ready, false);
    assert.equal(body.capabilities.invitationIssuable, false);
    assert.ok(body.missing.includes('access_identity_unregistered'), JSON.stringify(body.missing));
    assert.ok(body.warnings.includes('missing_registry_identity'), JSON.stringify(body.warnings));
    // Runtime health stays a separate, still-truthful answer.
    assert.equal(body.capabilities.runtimeReady, true, JSON.stringify(body.capabilities));
    assert.equal(body.capabilities.state, true);
  });
  await withRegistry(registered, async () => {
    const response = await GET(req());
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ready, true);
    assert.equal(body.capabilities.invitationIssuable, true);
    assert.equal(body.capabilities.runtimeReady, true);
    assert.ok(!body.missing.includes('access_identity_unregistered'), JSON.stringify(body.missing));
  });
});

test('issuance: the unregistered host is refused by name, before any readiness claim', async () => {
  const { createInterviewInvitation } = await import('../../src/lib/interview/invitation');
  const req = () => new NextRequest(`https://${host}/api/auth/interview-invitation`, {
    method: 'POST', headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ recipientHash: 'a'.repeat(64) }),
  });
  await withRegistry({ ...identity, kind: 'self' }, async () => {
    const response = await createInterviewInvitation(req(), 'a'.repeat(64));
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.error, 'access_identity_unregistered');
  });
  await withRegistry(registered, async () => {
    const response = await createInterviewInvitation(req(), 'a'.repeat(64));
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.protocol, 'interview-invitation.v1');
    assert.ok(String(body.url).startsWith(`https://${host}/interview?enroll=`));
  });
});
