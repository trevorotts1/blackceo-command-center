/**
 * PRD-32 / PRD-01 — the launch approval endpoint.
 *
 * An approval record is minted only from the tenant's registered client's own
 * reply (`APPROVE <first 8 chars of the plan hash>`); the agent/operator token
 * can read but never mint. Drives the REAL route handlers against an isolated DB.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { getDb } from '../../src/lib/db';
import { migrations } from '../../src/lib/db/migrations';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';
import { LAUNCH_ABILITIES, getLaunchAbility } from '../../src/lib/launch-abilities';

const HOST = 'cc.approval.test';
const CLIENT = 'owner@client.test';
const DIGEST = 'a1b2c3d4'.padEnd(64, 'e');
const PLAN = `sha256:${DIGEST}`;
const OPERATOR_TOKEN = 'operator-token-for-test';

async function cookieFor(subject: string): Promise<string> {
  const jwt = await signTenantGrant({
    purpose: 'session', tenantId: 'tenant-a', companyId: 'default', subject, host: HOST,
    installationId: 'install-a', exp: Date.now() / 1000 + 3600, nonce: 'n-' + subject,
  });
  return `mc_tenant_session=${jwt}`;
}

function req(url: string, init: { method?: string; cookie?: string; bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { host: HOST, 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return new NextRequest(`http://${HOST}${url}`, {
    method: init.method ?? 'GET', headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const reply = (over: Record<string, unknown> = {}) => ({
  kind: 'plan_build', plan_hash: PLAN, scope: 'build the launch pages',
  source_message: { ref: 'msg-1', sender: CLIENT, text: `Looks good. APPROVE ${DIGEST.slice(0, 8)}` },
  ...over,
});

async function post(body: unknown, auth: { cookie?: string; bearer?: string }) {
  const { POST } = await import('../../src/app/api/launch-approvals/route');
  return POST(req('/api/launch-approvals', { method: 'POST', body, ...auth }));
}
async function get(id: string, auth: { cookie?: string; bearer?: string }) {
  const { GET } = await import('../../src/app/api/launch-approvals/[approvalId]/route');
  return GET(req(`/api/launch-approvals/${id}`, auth), { params: { approvalId: id } } as never);
}

let clientCookie = '';
beforeAll(async () => {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [HOST]: { tenantId: 'tenant-a', companyId: 'default', kind: 'self', installationId: 'install-a', subjects: [CLIENT] },
  });
  process.env.MC_TENANT_SESSION_SECRET = 'approval-test-session-secret';
  process.env.MC_API_TOKEN = OPERATOR_TOKEN;
  clientCookie = await cookieFor(CLIENT);
  getDb(); // runs migrations on the isolated DB
});

describe('minting', () => {
  it('mints a full record from the registered client reply, and GET returns it', async () => {
    const res = await post(reply(), { cookie: clientCookie });
    expect(res.status).toBe(201);
    const rec = await res.json();
    expect(rec).toMatchObject({
      tenant_id: 'tenant-a', client_identity_ref: CLIENT, kind: 'plan_build', plan_hash: PLAN,
      scope: 'build the launch pages', cap_minor: null, currency: null, revoked: false, source_message_ref: 'msg-1',
    });
    expect(rec.approval_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(rec.expires_at)).toBeGreaterThan(Date.now());

    const got = await get(rec.approval_id, { bearer: OPERATOR_TOKEN }); // agent may READ
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ ...rec, active: true });
  });

  it('stores the money cap for paid_asset_budget and requires it', async () => {
    const noCap = await post(reply({ kind: 'paid_asset_budget', source_message: { ref: 'msg-2', sender: CLIENT, text: `APPROVE ${DIGEST.slice(0, 8)}` } }), { cookie: clientCookie });
    expect(noCap.status).toBe(400);
    const ok = await post(reply({ kind: 'paid_asset_budget', cap_minor: 4500, currency: 'USD', source_message: { ref: 'msg-3', sender: CLIENT, text: `approve ${DIGEST.slice(0, 8).toUpperCase()}` } }), { cookie: clientCookie });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ kind: 'paid_asset_budget', cap_minor: 4500, currency: 'USD' });
  });

  it('refuses a reply from any other sender', async () => {
    const mismatch = await post(reply({ source_message: { ref: 'msg-4', sender: 'mallory@evil.test', text: `APPROVE ${DIGEST.slice(0, 8)}` } }), { cookie: clientCookie });
    expect(mismatch.status).toBe(403);
    const stranger = await post(reply({ source_message: { ref: 'msg-5', sender: 'mallory@evil.test', text: `APPROVE ${DIGEST.slice(0, 8)}` } }), { cookie: await cookieFor('mallory@evil.test') });
    expect(stranger.status).toBe(403);
  });

  it('refuses a wrong plan-hash prefix, and a reply with no APPROVE', async () => {
    const wrong = await post(reply({ source_message: { ref: 'msg-6', sender: CLIENT, text: 'APPROVE deadbeef' } }), { cookie: clientCookie });
    expect(wrong.status).toBe(422);
    const none = await post(reply({ source_message: { ref: 'msg-7', sender: CLIENT, text: `sounds good ${DIGEST.slice(0, 8)}` } }), { cookie: clientCookie });
    expect(none.status).toBe(422);
  });

  it('refuses a request authenticated only by the agent/operator token, even with a perfect reply', async () => {
    const res = await post(reply({ source_message: { ref: 'msg-8', sender: CLIENT, text: `APPROVE ${DIGEST.slice(0, 8)}` } }), { bearer: OPERATOR_TOKEN });
    expect(res.status).toBe(403);
    expect((await post(reply(), {})).status).toBe(403); // no credential at all
  });

  it('refuses direct field setting: no source message, or server-owned fields', async () => {
    const { source_message: _drop, ...direct } = reply();
    void _drop;
    expect((await post(direct, { cookie: clientCookie })).status).toBe(403);
    expect((await post({ ...reply({ source_message: { ref: 'msg-9', sender: CLIENT, text: `APPROVE ${DIGEST.slice(0, 8)}` } }), approval_id: 'chosen', revoked: false }, { cookie: clientCookie })).status).toBe(403);
    expect((await post({ ...direct, approval_id: 'x', tenant_id: 'tenant-a', client_identity_ref: CLIENT }, { bearer: OPERATOR_TOKEN })).status).toBe(403);
  });

  it('is replay-safe: same reply returns the same record, a different claim on the ref conflicts', async () => {
    const first = await (await post(reply({ source_message: { ref: 'msg-10', sender: CLIENT, text: `APPROVE ${DIGEST.slice(0, 8)}` } }), { cookie: clientCookie })).json();
    const again = await post(reply({ source_message: { ref: 'msg-10', sender: CLIENT, text: `APPROVE ${DIGEST.slice(0, 8)}` } }), { cookie: clientCookie });
    expect(again.status).toBe(200);
    expect((await again.json()).approval_id).toBe(first.approval_id);
    const clash = await post(reply({ kind: 'publish', source_message: { ref: 'msg-10', sender: CLIENT, text: `APPROVE ${DIGEST.slice(0, 8)}` } }), { cookie: clientCookie });
    expect(clash.status).toBe(409);
  });
});

describe('read-only surface', () => {
  it('exports no PUT/PATCH/DELETE (Next answers 405), and no GET on the mint door', async () => {
    const item = await import('../../src/app/api/launch-approvals/[approvalId]/route');
    const coll = await import('../../src/app/api/launch-approvals/route');
    for (const m of ['PUT', 'PATCH', 'DELETE', 'POST']) expect((item as Record<string, unknown>)[m]).toBeUndefined();
    for (const m of ['PUT', 'PATCH', 'DELETE', 'GET']) expect((coll as Record<string, unknown>)[m]).toBeUndefined();
  });

  it('answers 404 for another tenant\'s approval and for a missing id', async () => {
    getDb().prepare(
      `INSERT INTO launch_approvals (approval_id, tenant_id, client_identity_ref, kind, plan_hash, scope, expires_at, source_message_ref, created_at)
       VALUES ('other-tenant-row', 'tenant-b', 'x@y.test', 'publish', ?, 's', '2099-01-01T00:00:00.000Z', 'm', '2026-11-02T00:00:00.000Z')`,
    ).run(PLAN);
    expect((await get('other-tenant-row', { bearer: OPERATOR_TOKEN })).status).toBe(404);
    expect((await get('no-such-id', { bearer: OPERATOR_TOKEN })).status).toBe(404);
  });
});

describe('migration and table guards', () => {
  const mig = () => migrations.find((m) => m.name === 'launch_approvals')!;

  it('re-runs twice without error', () => {
    const db = new Database(':memory:');
    expect(mig()).toBeDefined();
    expect(() => { mig().up(db); mig().up(db); }).not.toThrow();
    db.close();
  });

  it('the table refuses DELETE and edits, but allows a one-way revoke', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO launch_approvals (approval_id, tenant_id, client_identity_ref, kind, plan_hash, scope, expires_at, source_message_ref, created_at)
       VALUES ('guard-row', 'tenant-a', ?, 'publish', ?, 's', '2099-01-01T00:00:00.000Z', 'guard-m', '2026-11-02T00:00:00.000Z')`,
    ).run(CLIENT, PLAN);
    expect(() => db.prepare("DELETE FROM launch_approvals WHERE approval_id='guard-row'").run()).toThrow(/never deleted/);
    expect(() => db.prepare("UPDATE launch_approvals SET scope='other' WHERE approval_id='guard-row'").run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE launch_approvals SET revoked=1 WHERE approval_id='guard-row'").run()).not.toThrow();
    expect(() => db.prepare("UPDATE launch_approvals SET revoked=0 WHERE approval_id='guard-row'").run()).toThrow(/immutable/);
  });
});

describe('PRD-32 — Skill 83 ability', () => {
  it('lists an approval stage and an offers plan section', () => {
    const bf = getLaunchAbility(83)!;
    expect(bf.slug).toBe('black-friday-launcher');
    expect(bf.stageOrder).toContain('approval');
    expect(bf.stageOrder.indexOf('approval')).toBeLessThan(bf.stageOrder.indexOf('dispatch'));
    expect(bf.planSections).toContain('offers');
    expect(LAUNCH_ABILITIES.filter((a) => a.planSections.includes('offers')).map((a) => a.skill)).toEqual([83]);
  });
});
