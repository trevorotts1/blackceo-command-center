/**
 * Owner approvals inbox.
 *
 * The agent (MC_API_TOKEN bearer) registers a request and polls it; only the
 * tenant's registered owner can decide it; approving mints ONE launch approval
 * record carrying exactly the fields the Convert and Flow safety gate verifies
 * (Skill 44, safety_gate.py `_require_approval`). Drives the REAL route
 * handlers, the REAL decision function and the REAL deep-link page against an
 * isolated DB.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { getDb } from '../../src/lib/db';
import { migrations } from '../../src/lib/db/migrations';
import { signTenantGrant } from '../../src/lib/auth/tenant-context';
import { ownerSubjectForChatId } from '../../src/lib/auth/owner-login';
import { BEARER_REQUIRED_WRITE_ROUTES, requiresBearerForWrite } from '../../src/lib/bearer-required-routes';

const HOST = 'cc.inbox.test';
const OWNER = 'owner@client.test';
const TOKEN = 'agent-token-for-inbox-test';
const PLAN = 'ab12cd34'.padEnd(64, 'e');
const LOCATION = 'loc_ABC123';

// The deep-link page reads the request's cookie through next/headers.
let pageCookie = '';
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: HOST, cookie: pageCookie }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

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

const body = (over: Record<string, unknown> = {}) => ({
  kind: 'publish', location_id: LOCATION, action: 'publish', object_key: 'social:2026-11-09..15',
  plan_sha256: PLAN, title: 'Social media plan, Nov 9-15',
  summary: 'Seven posts across Instagram and Facebook, one per day.',
  preview: {
    text: 'Mon: launch teaser <script>alert(1)</script>',
    links: [{ label: 'Plan spreadsheet', url: 'https://docs.google.com/spreadsheets/d/abc/edit' }],
    images: ['https://cdn.example.test/post-1.png'],
  },
  requested_by: 'social-media-agent',
  ...over,
});

async function create(payload: unknown, auth: { cookie?: string; bearer?: string }) {
  const { POST } = await import('../../src/app/api/approval-requests/route');
  return POST(req('/api/approval-requests', { method: 'POST', body: payload, ...auth }));
}
async function status(id: string, auth: { cookie?: string; bearer?: string }) {
  const { GET } = await import('../../src/app/api/approval-requests/[requestId]/route');
  return GET(req(`/api/approval-requests/${id}`, auth), { params: Promise.resolve({ requestId: id }) } as never);
}
async function list(auth: { cookie?: string; bearer?: string }, q = '') {
  const { GET } = await import('../../src/app/api/approval-requests/route');
  return GET(req(`/api/approval-requests${q}`, auth));
}
async function approvalRecord(id: string, auth: { cookie?: string; bearer?: string }) {
  const { GET } = await import('../../src/app/api/launch-approvals/[approvalId]/route');
  return GET(req(`/api/launch-approvals/${id}`, auth), { params: Promise.resolve({ approvalId: id }) } as never);
}
async function decide(id: string, decision: 'approve' | 'request_changes', note: string, cookie: string) {
  pageCookie = cookie;
  const { submitApprovalDecision } = await import('../../src/app/approvals/actions');
  return submitApprovalDecision(id, decision, note);
}

/** Mirrors safety_gate.py `_require_approval` field by field. Returns the mismatched names. */
function gateMismatches(rec: Record<string, unknown>, want: { kind: string; location_id: string; action: string; object_key: string; plan_sha256: string }): string[] {
  const needed = ['kind', 'location_id', 'action', 'object_key', 'plan_sha256', 'approver', 'expires_at', 'revoked', 'verification_class'];
  if (needed.some((k) => !(k in rec))) return ['malformed'];
  const bad: string[] = [];
  if (rec.kind !== want.kind) bad.push('kind');
  if (rec.location_id !== want.location_id) bad.push('location_id');
  if (rec.action !== want.action) bad.push('action');
  if (rec.object_key !== want.object_key) bad.push('object_key');
  if (rec.plan_sha256 !== want.plan_sha256) bad.push('plan_sha256');
  if (typeof rec.approver !== 'string' || !rec.approver.trim()) bad.push('approver');
  if (rec.revoked !== false) bad.push('revoked');
  if (rec.verification_class !== 'authenticated_platform_record') bad.push('verification_class');
  if (!(Date.parse(String(rec.expires_at)) > Date.now())) bad.push('expires_at');
  return bad;
}

let ownerCookie = '';
beforeAll(async () => {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [HOST]: { tenantId: 'tenant-a', companyId: 'default', kind: 'self', installationId: 'install-a', subjects: [OWNER] },
  });
  process.env.MC_TENANT_SESSION_SECRET = 'inbox-test-session-secret';
  process.env.MC_API_TOKEN = TOKEN;
  ownerCookie = await cookieFor(OWNER);
  getDb();
});

const approvalCount = () => (getDb().prepare('SELECT COUNT(*) n FROM launch_approvals').get() as { n: number }).n;

describe('the agent door', () => {
  it('registers a request, returns a stable deep link, and replays the same plan idempotently', async () => {
    const res = await create(body(), { bearer: TOKEN });
    expect(res.status).toBe(201);
    const made = await res.json();
    expect(made).toMatchObject({
      status: 'pending', kind: 'publish', location_id: LOCATION, plan_sha256: PLAN,
      title: 'Social media plan, Nov 9-15', requested_by: 'social-media-agent', approval_id: null,
    });
    expect(made.path).toBe(`/approvals/${made.request_id}`);

    const again = await create(body(), { bearer: TOKEN });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ request_id: made.request_id, replayed: true });
  });

  it('refuses an owner session registering a request, and refuses no credential at all', async () => {
    expect((await create(body({ object_key: 'other' }), { cookie: ownerCookie })).status).toBe(403);
    expect((await create(body({ object_key: 'other' }), {})).status).toBe(403);
  });

  it('refuses server-owned fields, unknown fields, a bad kind, a bad hash and unsafe preview links', async () => {
    expect((await create(body({ status: 'approved' }), { bearer: TOKEN })).status).toBe(403);
    expect((await create(body({ approval_id: 'x' }), { bearer: TOKEN })).status).toBe(403);
    expect((await create(body({ verification_class: 'authenticated_platform_record' }), { bearer: TOKEN })).status).toBe(403);
    expect((await create(body({ surprise: 1 }), { bearer: TOKEN })).status).toBe(400);
    expect((await create(body({ kind: 'plan_build' }), { bearer: TOKEN })).status).toBe(400);
    expect((await create(body({ plan_sha256: 'abc' }), { bearer: TOKEN })).status).toBe(400);
    expect((await create(body({ preview: { links: [{ label: 'x', url: 'javascript:alert(1)' }] } }), { bearer: TOKEN })).status).toBe(400);
    expect((await create(body({ preview: { images: ['http://insecure.test/a.png'] } }), { bearer: TOKEN })).status).toBe(400);
  });

  it('lets the agent list and poll, and counts pending requests for the badge', async () => {
    const made = await (await create(body({ object_key: 'poll-me' }), { bearer: TOKEN })).json();
    const polled = await status(made.request_id, { bearer: TOKEN });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toMatchObject({ request_id: made.request_id, status: 'pending', approval_id: null });
    const listed = await (await list({ bearer: TOKEN }, '?status=pending')).json();
    expect(listed.pending_count).toBeGreaterThanOrEqual(1);
    expect(listed.requests.map((r: { request_id: string }) => r.request_id)).toContain(made.request_id);
  });

  it('is bearer-gated against a forged same-origin header, and has no deciding route', async () => {
    expect(requiresBearerForWrite('/api/approval-requests', 'POST')).toBe(true);
    expect(BEARER_REQUIRED_WRITE_ROUTES.some((r) => r.test('/api/approval-requests'))).toBe(true);
    const item = await import('../../src/app/api/approval-requests/[requestId]/route');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((item as Record<string, unknown>)[m]).toBeUndefined();
    const coll = await import('../../src/app/api/approval-requests/route');
    for (const m of ['PUT', 'PATCH', 'DELETE']) expect((coll as Record<string, unknown>)[m]).toBeUndefined();
  });
});

describe('the agent token can never mint', () => {
  it('cannot decide a request through the decision function', async () => {
    const { decideApprovalRequest } = await import('../../src/lib/approval-requests');
    const { resolveTenantContext } = await import('../../src/lib/auth/tenant-context');
    const made = await (await create(body({ object_key: 'agent-cannot-approve' }), { bearer: TOKEN })).json();
    const agentCtx = await resolveTenantContext(req('/x', { bearer: TOKEN }));
    expect(agentCtx.subject).toBe('operator:api');
    const before = approvalCount();
    const res = decideApprovalRequest(agentCtx, made.request_id, { decision: 'approve' });
    expect(res.status).toBe(403);
    expect(res.payload.error).toBe('client_identity_required');
    expect(approvalCount()).toBe(before);
    expect((await (await status(made.request_id, { bearer: TOKEN })).json()).status).toBe('pending');
  });

  it('cannot mint through the existing launch-approvals door either', async () => {
    const { POST } = await import('../../src/app/api/launch-approvals/route');
    const before = approvalCount();
    const res = await POST(req('/api/launch-approvals', {
      method: 'POST', bearer: TOKEN,
      body: { kind: 'publish', plan_hash: `sha256:${PLAN}`, scope: 's', source_message: { ref: 'agent-m', sender: OWNER, text: `APPROVE ${PLAN.slice(0, 8)}` } },
    }));
    expect(res.status).toBe(403);
    expect(approvalCount()).toBe(before);
  });

  it('a stranger session (not a registered owner) cannot decide', async () => {
    const made = await (await create(body({ object_key: 'stranger' }), { bearer: TOKEN })).json();
    const out = await decide(made.request_id, 'approve', '', await cookieFor('mallory@evil.test'));
    expect(out.ok).toBe(false);
    expect((await (await status(made.request_id, { bearer: TOKEN })).json()).approval_id).toBeNull();
  });
});

describe('the owner decision', () => {
  it('Approve mints a record the safety gate would accept, and the agent can then read its id', async () => {
    const made = await (await create(body({ object_key: 'approve-me' }), { bearer: TOKEN })).json();
    const out = await decide(made.request_id, 'approve', 'Looks great', ownerCookie);
    expect(out).toMatchObject({ ok: true, status: 'approved' });

    const polled = await (await status(made.request_id, { bearer: TOKEN })).json();
    expect(polled).toMatchObject({ status: 'approved', decided_by: OWNER, decision_note: 'Looks great' });
    expect(polled.approval_id).toMatch(/^[0-9a-f-]{36}$/);

    // The exact call the safety gate makes: GET with the agent bearer.
    const rec = await (await approvalRecord(polled.approval_id, { bearer: TOKEN })).json();
    // The binding rides in scope JSON; no extra launch_approvals columns.
    expect(JSON.parse(rec.scope)).toEqual({ location_id: LOCATION, action: 'publish', object_key: 'approve-me' });
    expect(rec).toMatchObject({
      kind: 'publish', plan_hash: `sha256:${PLAN}`, client_identity_ref: OWNER, revoked: false,
      location_id: LOCATION, action: 'publish', object_key: 'approve-me',
      plan_sha256: PLAN, approver: OWNER, verification_class: 'authenticated_platform_record',
    });
    expect(Date.parse(rec.expires_at)).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
    expect(gateMismatches(rec, { kind: 'publish', location_id: LOCATION, action: 'publish', object_key: 'approve-me', plan_sha256: PLAN })).toEqual([]);
    // Id shape the gate accepts (^[A-Za-z0-9_-]{8,128}$).
    expect(polled.approval_id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    // Wrong binding is refused by the same check.
    expect(gateMismatches(rec, { kind: 'automation_write', location_id: 'loc_OTHER', action: 'publish', object_key: 'approve-me', plan_sha256: PLAN }))
      .toEqual(['kind', 'location_id']);
  });

  it('is idempotent: approving twice mints one record', async () => {
    const made = await (await create(body({ object_key: 'twice' }), { bearer: TOKEN })).json();
    await decide(made.request_id, 'approve', '', ownerCookie);
    const first = (await (await status(made.request_id, { bearer: TOKEN })).json()).approval_id;
    const before = approvalCount();
    const second = await decide(made.request_id, 'approve', '', ownerCookie);
    expect(second.ok).toBe(true);
    expect(approvalCount()).toBe(before);
    expect((await (await status(made.request_id, { bearer: TOKEN })).json()).approval_id).toBe(first);
  });

  it('Request changes records a note the agent can read and mints nothing', async () => {
    const made = await (await create(body({ object_key: 'needs-edits' }), { bearer: TOKEN })).json();
    const before = approvalCount();
    const out = await decide(made.request_id, 'request_changes', 'Move Tuesday to Wednesday', ownerCookie);
    expect(out).toMatchObject({ ok: true, status: 'changes_requested' });
    expect(approvalCount()).toBe(before);
    expect(await (await status(made.request_id, { bearer: TOKEN })).json())
      .toMatchObject({ status: 'changes_requested', decision_note: 'Move Tuesday to Wednesday', approval_id: null });
    // A closed request cannot then be approved.
    expect((await decide(made.request_id, 'approve', '', ownerCookie)).ok).toBe(false);
    // The revised plan (new hash) is a fresh request.
    const revised = await create(body({ object_key: 'needs-edits', plan_sha256: 'f'.repeat(64) }), { bearer: TOKEN });
    expect(revised.status).toBe(201);
  });

  it('refuses an expired request', async () => {
    const made = await (await create(body({ object_key: 'stale' }), { bearer: TOKEN })).json();
    getDb().prepare('UPDATE approval_requests SET expires_at = ? WHERE request_id = ?').run('2020-01-01T00:00:00.000Z', made.request_id);
    expect((await status(made.request_id, { bearer: TOKEN }).then((r) => r.json())).status).toBe('expired');
    expect((await decide(made.request_id, 'approve', '', ownerCookie)).ok).toBe(false);
  });

  it('keeps tenants apart: another tenant\'s request reads as not found', async () => {
    getDb().prepare(
      `INSERT INTO approval_requests (request_id, tenant_id, kind, location_id, action, object_key, plan_sha256, title, summary, requested_by, expires_at, created_at)
       VALUES ('foreign-request-1', 'tenant-b', 'publish', 'l', 'publish', 'o', ?, 't', 's', 'a', '2099-01-01T00:00:00.000Z', '2026-11-12T00:00:00.000Z')`,
    ).run(PLAN);
    expect((await status('foreign-request-1', { bearer: TOKEN })).status).toBe(404);
    expect((await decide('foreign-request-1', 'approve', '', ownerCookie)).ok).toBe(false);
  });
});

describe('the deep link and the list page', () => {
  it('/approvals/<id> renders the title, summary, preview as text, links, images and both buttons', async () => {
    const made = await (await create(body({ object_key: 'render-me' }), { bearer: TOKEN })).json();
    pageCookie = ownerCookie;
    const { default: Page } = await import('../../src/app/approvals/[requestId]/page');
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ requestId: made.request_id }) }));
    expect(html).toContain('Social media plan, Nov 9-15');
    expect(html).toContain('Seven posts across Instagram and Facebook');
    expect(html).toContain('href="https://docs.google.com/spreadsheets/d/abc/edit"');
    expect(html).toContain('src="https://cdn.example.test/post-1.png"');
    expect(html).toContain('>Approve<');
    expect(html).toContain('>Request changes<');
    // Agent-supplied text is escaped, never injected as markup.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows no buttons once answered, and the owner\'s note after a change request', async () => {
    const made = await (await create(body({ object_key: 'answered' }), { bearer: TOKEN })).json();
    await decide(made.request_id, 'request_changes', 'Swap the photo', ownerCookie);
    pageCookie = ownerCookie;
    const { default: Page } = await import('../../src/app/approvals/[requestId]/page');
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ requestId: made.request_id }) }));
    expect(html).toContain('Changes requested');
    expect(html).toContain('Swap the photo');
    expect(html).not.toContain('>Approve<');
  });

  it('/approvals lists waiting requests, and asks an unauthenticated visitor to sign in', async () => {
    await create(body({ object_key: 'listed' }), { bearer: TOKEN });
    pageCookie = ownerCookie;
    const { default: ListPage } = await import('../../src/app/approvals/page');
    const html = renderToStaticMarkup(await ListPage());
    expect(html).toContain('Approvals');
    expect(html).toContain('Social media plan, Nov 9-15');
    pageCookie = '';
    const signedOut = renderToStaticMarkup(await ListPage());
    expect(signedOut).toContain('Sign in');
    expect(signedOut).not.toContain('Social media plan');
  });
});

describe('owner-login identity', () => {
  const OWNER_CHAT = '7770001234';

  it('accepts the session of the tenant\'s own owner chat (invited-owner:<sha256(chat)>), and nobody else', async () => {
    process.env.OPENCLAW_OWNER_CHAT_ID = OWNER_CHAT;
    try {
      const made = await (await create(body({ object_key: 'owner-login-ok' }), { bearer: TOKEN })).json();
      const stale = await decide(made.request_id, 'approve', '', await cookieFor(ownerSubjectForChatId('9990009999')));
      expect(stale.ok).toBe(false); // an invited-owner hash that is not the current owner chat
      const own = await decide(made.request_id, 'approve', '', await cookieFor(ownerSubjectForChatId(OWNER_CHAT)));
      expect(own).toMatchObject({ ok: true, status: 'approved' });
      const polled = await (await status(made.request_id, { bearer: TOKEN })).json();
      const rec = await (await approvalRecord(polled.approval_id, { bearer: TOKEN })).json();
      expect(rec.approver).toBe(ownerSubjectForChatId(OWNER_CHAT));
      expect(rec.verification_class).toBe('authenticated_platform_record');
    } finally {
      delete process.env.OPENCLAW_OWNER_CHAT_ID;
    }
  });

  it('fails closed when no owner chat is configured', async () => {
    delete process.env.OPENCLAW_OWNER_CHAT_ID;
    const made = await (await create(body({ object_key: 'owner-login-closed' }), { bearer: TOKEN })).json();
    const out = await decide(made.request_id, 'approve', '', await cookieFor(ownerSubjectForChatId(OWNER_CHAT)));
    expect(out.ok).toBe(false);
  });
});

describe('approval lifetime', () => {
  it('covers the whole window being approved (valid_until) and caps at 30 days', async () => {
    const until = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString();
    const made = await (await create(body({ object_key: 'long-window', valid_until: until }), { bearer: TOKEN })).json();
    expect(made.valid_until).toBe(until);
    await decide(made.request_id, 'approve', '', ownerCookie);
    const polled = await (await status(made.request_id, { bearer: TOKEN })).json();
    const rec = await (await approvalRecord(polled.approval_id, { bearer: TOKEN })).json();
    expect(Date.parse(rec.expires_at)).toBe(Date.parse(until));
    const tooFar = await create(body({ object_key: 'x', valid_until: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString() }), { bearer: TOKEN });
    expect(tooFar.status).toBe(400);
  });

  it('a chat-reply record never carries the gate fields', async () => {
    const { POST } = await import('../../src/app/api/launch-approvals/route');
    const res = await POST(req('/api/launch-approvals', {
      method: 'POST', cookie: ownerCookie,
      body: { kind: 'publish', plan_hash: `sha256:${PLAN}`, scope: 'free text', source_message: { ref: 'chat-1', sender: OWNER, text: `APPROVE ${PLAN.slice(0, 8)}` } },
    }));
    const rec = await (await approvalRecord((await res.json()).approval_id, { bearer: TOKEN })).json();
    expect(rec.verification_class).toBeUndefined();
    expect(rec.location_id).toBeUndefined();
  });
});

describe('migration 179', () => {
  const mig = () => migrations.find((m) => m.id === '179')!;

  it('exists and re-runs without error', () => {
    expect(mig()?.name).toBe('approval_requests_inbox');
    expect(Object.keys(getDb().prepare('SELECT * FROM launch_approvals LIMIT 0').columns().reduce((o: Record<string, 1>, c) => ({ ...o, [c.name]: 1 }), {})))
      .not.toContain('location_id'); // launch_approvals is not altered
    expect(() => { mig().up(getDb()); mig().up(getDb()); }).not.toThrow();
  });
})
