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
import Database from 'better-sqlite3';
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

describe('paid asset budget approvals', () => {
  const budget = (over: Record<string, unknown> = {}) => body({
    kind: 'paid_asset_budget', action: 'generate_images', object_key: 'campaign-pictures',
    title: 'Picture budget', summary: 'Generate the campaign pictures.', cap_minor: 2500, currency: 'USD', ...over,
  });

  it('registers a budget request carrying its cap, and refuses a missing, bad or misplaced cap', async () => {
    const res = await create(budget(), { bearer: TOKEN });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ kind: 'paid_asset_budget', cap_minor: 2500, currency: 'USD', status: 'pending' });
    const refusals = await Promise.all([
      create(budget({ object_key: 'b1', cap_minor: undefined }), { bearer: TOKEN }),
      create(budget({ object_key: 'b2', currency: undefined }), { bearer: TOKEN }),
      create(budget({ object_key: 'b3', cap_minor: 0 }), { bearer: TOKEN }),
      create(budget({ object_key: 'b4', cap_minor: 25.5 }), { bearer: TOKEN }),
      create(budget({ object_key: 'b5', currency: 'usd' }), { bearer: TOKEN }),
      create(body({ object_key: 'b6', cap_minor: 2500, currency: 'USD' }), { bearer: TOKEN }),
    ]);
    expect(refusals.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400]);
    expect((await refusals[5].json()).error).toBe('cap_not_allowed');
  });

  it('replays the same budget, but a different cap is a new request', async () => {
    const a = await (await create(budget({ object_key: 'replay-cap' }), { bearer: TOKEN })).json();
    const again = await (await create(budget({ object_key: 'replay-cap' }), { bearer: TOKEN })).json();
    expect(again).toMatchObject({ request_id: a.request_id, replayed: true });
    const bigger = await (await create(budget({ object_key: 'replay-cap', cap_minor: 9900 }), { bearer: TOKEN })).json();
    expect(bigger.request_id).not.toBe(a.request_id);
  });

  it('the owner approving on the page mints a launch approval carrying the same cap', async () => {
    const made = await (await create(budget({ object_key: 'approve-budget' }), { bearer: TOKEN })).json();
    expect(await decide(made.request_id, 'approve', '', ownerCookie)).toMatchObject({ ok: true, status: 'approved' });
    const polled = await (await status(made.request_id, { bearer: TOKEN })).json();
    const rec = await (await approvalRecord(polled.approval_id, { bearer: TOKEN })).json();
    expect(rec).toMatchObject({
      kind: 'paid_asset_budget', cap_minor: 2500, currency: 'USD', approver: OWNER,
      verification_class: 'authenticated_platform_record', revoked: false,
    });
  });

  it('the agent token still cannot decide a budget request', async () => {
    const made = await (await create(budget({ object_key: 'agent-cannot' }), { bearer: TOKEN })).json();
    const { decideApprovalRequest } = await import('../../src/lib/approval-requests');
    const out = decideApprovalRequest({ tenantId: 'tenant-a', subject: 'operator:api' } as never, made.request_id, { decision: 'approve' });
    expect(out.status).toBe(403);
  });

  it('shows the spending limit on the approval page, and no limit on other kinds', async () => {
    const made = await (await create(budget({ object_key: 'page-budget' }), { bearer: TOKEN })).json();
    const plain = await (await create(body({ object_key: 'page-plain' }), { bearer: TOKEN })).json();
    const { default: Page } = await import('../../src/app/approvals/[requestId]/page');
    pageCookie = ownerCookie;
    const withCap = renderToStaticMarkup(await Page({ params: Promise.resolve({ requestId: made.request_id }) }));
    expect(withCap).toContain('Spending limit: $25.00 USD');
    const without = renderToStaticMarkup(await Page({ params: Promise.resolve({ requestId: plain.request_id }) }));
    expect(without).not.toContain('Spending limit');
  });
});

describe('budget amounts per currency', () => {
  it('formats by the currency minor unit and refuses an unknown currency', async () => {
    const { formatCap } = await import('../../src/lib/approval-requests');
    expect(formatCap(2500, 'USD')).toBe('$25.00 USD');
    expect(formatCap(2500, 'JPY')).toBe('¥2,500 JPY');
    expect(formatCap(2500, 'KWD')?.replace(/\s/g, ' ')).toBe('KWD 2.500 KWD');
    expect(formatCap(null, null)).toBeNull();
    const bad = await create(body({ kind: 'paid_asset_budget', object_key: 'zzz', cap_minor: 100, currency: 'ZZZ' }), { bearer: TOKEN });
    expect(bad.status).toBe(400);
  });
});

/**
 * Mirrors openclaw-onboarding approval_record.py (normalize_record + _check) for
 * a live Command Center row: kind via COMMAND_CENTER_KIND_ALIASES (qc_session and
 * email_deploy are canonical as-is), plan hash, consenting actor
 * (client_identity_ref), tenant, source_message_ref, scope split on commas,
 * revoked, expiry. Returns the names that would be refused.
 */
function consumerMismatches(rec: Record<string, unknown>, want: { kind: string; plan_hash: string; actor: string; tenant: string; scope: string[] }): string[] {
  const bad: string[] = [];
  if (rec.kind !== want.kind) bad.push('kind');
  if (String(rec.plan_hash).replace(/^sha256:/, '').toLowerCase() !== want.plan_hash.toLowerCase()) bad.push('plan_hash');
  if (String(rec.client_identity_ref ?? '').toLowerCase() !== want.actor.toLowerCase()) bad.push('consenting_actor_ref');
  if (String(rec.tenant_id ?? '').toLowerCase() !== want.tenant.toLowerCase()) bad.push('tenant_ref');
  if (typeof rec.source_message_ref !== 'string' || !rec.source_message_ref.trim()) bad.push('source_message_ref');
  if (rec.verification_class !== undefined && rec.verification_class !== 'authenticated_platform_record') bad.push('verification_class');
  if (typeof rec.scope !== 'string') bad.push('scope');
  else {
    const s = rec.scope;
    const covered = new Set([s.trim(), ...s.split(',').map((p) => p.trim()).filter(Boolean)]);
    if (!want.scope.every((e) => covered.has(e))) bad.push('scope');
  }
  if (rec.revoked !== false) bad.push('revoked');
  if (!(Date.parse(String(rec.expires_at)) > Date.now())) bad.push('expires_at');
  return bad;
}

describe('qc_session and email_deploy approvals (Skill 44 QC, Skill 50 deploy)', () => {
  const CASES = [
    { kind: 'qc_session', action: 'qc_built_workflow', scope: ['qc_model:kimi-k2.6', 'qc_session:sess-42'] },
    { kind: 'email_deploy', action: 'email_deploy', scope: ['golden-landing-10'] },
  ] as const;
  const scoped = (c: (typeof CASES)[number], over: Record<string, unknown> = {}) => body({
    kind: c.kind, action: c.action, object_key: `${c.kind}-obj`, scope: [...c.scope],
    title: `${c.kind} approval`, summary: 'Owner approves this exact plan.', ...over,
  });

  for (const c of CASES) {
    it(`${c.kind}: the agent registers it with scope; the owner approves; the record reads back with every field approval_record.py checks`, async () => {
      const res = await create(scoped(c), { bearer: TOKEN });
      expect(res.status).toBe(201);
      const made = await res.json();
      expect(made).toMatchObject({ kind: c.kind, scope: [...c.scope], status: 'pending', approval_id: null });
      expect((await (await create(scoped(c), { bearer: TOKEN })).json())).toMatchObject({ request_id: made.request_id, replayed: true });

      expect(await decide(made.request_id, 'approve', '', ownerCookie)).toMatchObject({ ok: true, status: 'approved' });
      const polled = await (await status(made.request_id, { bearer: TOKEN })).json();
      expect(polled).toMatchObject({ status: 'approved', decided_by: OWNER });
      expect(polled.approval_id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);

      // The exact GET approval_record.py `_fetch` makes, with the agent bearer.
      const got = await approvalRecord(polled.approval_id, { bearer: TOKEN });
      expect(got.status).toBe(200);
      const rec = await got.json();
      expect(rec).toMatchObject({
        approval_id: polled.approval_id, kind: c.kind, plan_hash: `sha256:${PLAN}`, tenant_id: 'tenant-a',
        client_identity_ref: OWNER, scope: c.scope.join(', '), revoked: false, active: true,
        source_message_ref: `approval-request:${made.request_id}`, cap_minor: null, currency: null,
      });
      expect(consumerMismatches(rec, { kind: c.kind, plan_hash: PLAN, actor: OWNER, tenant: 'tenant-a', scope: [...c.scope] })).toEqual([]);
      // Bound to this plan and this scope only.
      expect(consumerMismatches(rec, { kind: c.kind, plan_hash: 'f'.repeat(64), actor: OWNER, tenant: 'tenant-a', scope: ['other-run'] }))
        .toEqual(['plan_hash', 'scope']);
      // A record of one kind never satisfies the other kind's check.
      const other = c.kind === 'qc_session' ? 'email_deploy' : 'qc_session';
      expect(consumerMismatches(rec, { kind: other, plan_hash: PLAN, actor: OWNER, tenant: 'tenant-a', scope: [...c.scope] })).toEqual(['kind']);
    });

    it(`${c.kind}: the agent bearer cannot self-approve through either door`, async () => {
      const made = await (await create(scoped(c, { object_key: `${c.kind}-self` }), { bearer: TOKEN })).json();
      const { decideApprovalRequest } = await import('../../src/lib/approval-requests');
      const { resolveTenantContext } = await import('../../src/lib/auth/tenant-context');
      const agentCtx = await resolveTenantContext(req('/x', { bearer: TOKEN }));
      const before = approvalCount();
      const out = decideApprovalRequest(agentCtx, made.request_id, { decision: 'approve' });
      expect(out.status).toBe(403);
      expect(out.payload.error).toBe('client_identity_required');
      const { POST } = await import('../../src/app/api/launch-approvals/route');
      const direct = await POST(req('/api/launch-approvals', {
        method: 'POST', bearer: TOKEN,
        body: { kind: c.kind, plan_hash: `sha256:${PLAN}`, scope: c.scope.join(', '), source_message: { ref: `agent-${c.kind}`, sender: OWNER, text: `APPROVE ${PLAN.slice(0, 8)}` } },
      }));
      expect(direct.status).toBe(403);
      expect(approvalCount()).toBe(before);
      expect((await (await status(made.request_id, { bearer: TOKEN })).json())).toMatchObject({ status: 'pending', approval_id: null });
    });
  }

  it('requires scope for these kinds, refuses it on every other kind, and refuses entries the consumer would split', async () => {
    const [q] = CASES;
    const results = await Promise.all([
      create(scoped(q, { object_key: 's1', scope: undefined }), { bearer: TOKEN }),
      create(scoped(q, { object_key: 's2', scope: [] }), { bearer: TOKEN }),
      create(scoped(q, { object_key: 's3', scope: ['qc_model:a, qc_session:b'] }), { bearer: TOKEN }),
      create(scoped(q, { object_key: 's4', scope: 'qc_model:a' }), { bearer: TOKEN }),
      create(scoped(q, { object_key: 's5', scope: [''] }), { bearer: TOKEN }),
      create(scoped(q, { object_key: 's6', cap_minor: 100, currency: 'USD' }), { bearer: TOKEN }),
      create(body({ object_key: 's7', scope: ['x'] }), { bearer: TOKEN }),
    ]);
    expect(results.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400, 400]);
    expect((await results[6].json()).error).toBe('scope_not_allowed');
    expect((await results[5].json()).error).toBe('cap_not_allowed');
  });

  it('a different scope for the same plan is a new request, never a replay', async () => {
    const [q] = CASES;
    const a = await (await create(scoped(q, { object_key: 'scope-replay' }), { bearer: TOKEN })).json();
    const b = await (await create(scoped(q, { object_key: 'scope-replay', scope: ['qc_model:other', 'qc_session:sess-42'] }), { bearer: TOKEN })).json();
    expect(b.request_id).not.toBe(a.request_id);
  });

  it('the approval page shows the owner exactly what the approval covers', async () => {
    const [q] = CASES;
    const made = await (await create(scoped(q, { object_key: 'page-scope' }), { bearer: TOKEN })).json();
    pageCookie = ownerCookie;
    const { default: Page } = await import('../../src/app/approvals/[requestId]/page');
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ requestId: made.request_id }) }));
    expect(html).toContain('Covers: qc_model:kimi-k2.6, qc_session:sess-42');
  });

  it('existing kinds still mint the Convert and Flow binding JSON', async () => {
    const made = await (await create(body({ object_key: 'binding-kept' }), { bearer: TOKEN })).json();
    expect(made.scope).toBeNull();
    await decide(made.request_id, 'approve', '', ownerCookie);
    const polled = await (await status(made.request_id, { bearer: TOKEN })).json();
    const rec = await (await approvalRecord(polled.approval_id, { bearer: TOKEN })).json();
    expect(JSON.parse(rec.scope)).toEqual({ location_id: LOCATION, action: 'publish', object_key: 'binding-kept' });
    expect(rec.verification_class).toBe('authenticated_platform_record');
  });
});

describe('migration 182', () => {
  const mig = () => migrations.find((m) => m.id === '182')!;
  const upTo181 = (db: Database.Database) => {
    for (const id of ['177', '179', '181']) migrations.find((m) => m.id === id)!.up(db);
  };

  it('widens both kind checks, adds scope_json, keeps every row and both launch_approvals guards, and re-runs', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    upTo181(db);
    db.prepare(`INSERT INTO launch_approvals (approval_id, tenant_id, client_identity_ref, kind, plan_hash, scope, expires_at, source_message_ref, created_at)
      VALUES ('a1','t','o','publish','sha256:${PLAN}','s','2099-01-01','m1','2026-01-01')`).run();
    db.prepare(`INSERT INTO approval_requests (request_id, tenant_id, kind, location_id, action, object_key, plan_sha256,
      title, summary, requested_by, expires_at, created_at) VALUES ('r1','t','publish','l','a','o','${PLAN}','T','S','agent','2099-01-01','2026-01-01')`).run();
    expect(mig()?.name).toBe('approval_kinds_qc_session_email_deploy');
    expect(() => db.transaction(() => { mig().up(db); mig().up(db); })()).not.toThrow();
    expect(db.prepare('SELECT approval_id, kind FROM launch_approvals').all()).toEqual([{ approval_id: 'a1', kind: 'publish' }]);
    expect(db.prepare('SELECT request_id, scope_json FROM approval_requests').all()).toEqual([{ request_id: 'r1', scope_json: null }]);
    for (const k of ['qc_session', 'email_deploy']) {
      expect(() => db.prepare(`INSERT INTO launch_approvals (approval_id, tenant_id, client_identity_ref, kind, plan_hash, scope, expires_at, source_message_ref, created_at)
        VALUES ('a-${k}','t','o','${k}','sha256:${PLAN}','s','2099-01-01','m-${k}','2026-01-01')`).run()).not.toThrow();
      expect(() => db.prepare(`INSERT INTO approval_requests (request_id, tenant_id, kind, location_id, action, object_key, plan_sha256,
        scope_json, title, summary, requested_by, expires_at, created_at) VALUES ('r-${k}','t','${k}','l','a','o','${PLAN}','["x"]','T','S','agent','2099-01-01','2026-01-01')`).run()).not.toThrow();
    }
    expect(() => db.prepare(`INSERT INTO launch_approvals (approval_id, tenant_id, client_identity_ref, kind, plan_hash, scope, expires_at, source_message_ref, created_at)
      VALUES ('bad','t','o','bogus','sha256:${PLAN}','s','2099-01-01','m-bad','2026-01-01')`).run()).toThrow();
    // The immutability guards survive the rebuild.
    expect(() => db.prepare("DELETE FROM launch_approvals WHERE approval_id='a1'").run()).toThrow(/never deleted/);
    expect(() => db.prepare("UPDATE launch_approvals SET scope='other' WHERE approval_id='a1'").run()).toThrow(/immutable/);
    expect(() => db.prepare("INSERT INTO launch_approvals (approval_id, tenant_id, client_identity_ref, kind, plan_hash, scope, expires_at, source_message_ref, created_at) VALUES ('dup','t','o','publish','p','s','2099','m1','2026')").run()).toThrow(/UNIQUE/);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all().map((r) => (r as { name: string }).name);
    expect(idx).toEqual(expect.arrayContaining(['idx_launch_approvals_plan', 'idx_approval_requests_status', 'idx_approval_requests_plan']));
  });

  it('the fully migrated live database keeps the launch_approvals guards', () => {
    const triggers = getDb().prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='launch_approvals'").all().map((r) => (r as { name: string }).name);
    expect(triggers).toEqual(expect.arrayContaining(['launch_approvals_no_delete', 'launch_approvals_revoke_only']));
    const sql = (getDb().prepare("SELECT sql FROM sqlite_master WHERE name='launch_approvals'").get() as { sql: string }).sql;
    expect(sql).toContain("'qc_session'");
    expect(sql).toContain("'email_deploy'");
  });

  it('refuses instead of silently cascading when a child deletes with launch_approvals', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    upTo181(db);
    db.exec(`CREATE TABLE child (id TEXT PRIMARY KEY, approval_id TEXT REFERENCES launch_approvals(approval_id) ON DELETE CASCADE);`);
    expect(() => db.transaction(() => mig().up(db))()).toThrow(/child would lose rows/);
  });
});

describe('migration 181', () => {
  const mig = () => migrations.find((m) => m.id === '181')!;

  it('widens the kind, keeps every row and extra column, and re-runs without error', () => {
    const db = new Database(':memory:');
    migrations.find((m) => m.id === '179')!.up(db);
    db.exec('ALTER TABLE approval_requests ADD COLUMN local_extra TEXT');
    db.prepare(`INSERT INTO approval_requests (request_id, tenant_id, kind, location_id, action, object_key, plan_sha256,
      title, summary, requested_by, expires_at, created_at, local_extra)
      VALUES ('r1','t','publish','l','a','o','${PLAN}','T','S','agent','2099-01-01','2026-01-01','kept')`).run();
    expect(mig()?.name).toBe('approval_requests_paid_asset_budget');
    expect(() => { mig().up(db); mig().up(db); }).not.toThrow();
    expect(db.prepare('SELECT kind, local_extra, cap_minor FROM approval_requests').all()).toEqual([{ kind: 'publish', local_extra: 'kept', cap_minor: null }]);
    expect(() => db.prepare(`INSERT INTO approval_requests (request_id, tenant_id, kind, location_id, action, object_key, plan_sha256,
      cap_minor, currency, title, summary, requested_by, expires_at, created_at)
      VALUES ('r2','t','paid_asset_budget','l','a','o','${PLAN}',2500,'USD','T','S','agent','2099-01-01','2026-01-01')`).run()).not.toThrow();
    expect(() => db.prepare(`INSERT INTO approval_requests (request_id, tenant_id, kind, location_id, action, object_key, plan_sha256,
      title, summary, requested_by, expires_at, created_at)
      VALUES ('r3','t','bogus','l','a','o','${PLAN}','T','S','agent','2099-01-01','2026-01-01')`).run()).toThrow();
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='approval_requests'").all().map((r: { name: string }) => r.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_approval_requests_status', 'idx_approval_requests_plan']));
  });

  it('handles a kind CHECK stored with different spacing and keeps a locally added index', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE approval_requests (request_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind  IN ( 'automation_write' , 'publish' )), location_id TEXT NOT NULL, action TEXT NOT NULL,
      object_key TEXT NOT NULL, plan_sha256 TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
      preview_json TEXT NOT NULL DEFAULT '{}', requested_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT NOT NULL, valid_until TEXT, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
      decision_note TEXT, approval_id TEXT);
      CREATE INDEX idx_local_extra ON approval_requests(requested_by);`);
    mig().up(db);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='approval_requests'").get() as { sql: string }).sql;
    expect(sql).toContain("'paid_asset_budget'");
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='approval_requests'").all().map((r) => (r as { name: string }).name);
    expect(idx).toContain('idx_local_extra');
  });

  it('rebuilds under foreign_keys=ON when another table references approval_requests', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrations.find((m) => m.id === '179')!.up(db);
    db.exec(`CREATE TABLE child (id TEXT PRIMARY KEY, request_id TEXT REFERENCES approval_requests(request_id));`);
    db.prepare(`INSERT INTO approval_requests (request_id, tenant_id, kind, location_id, action, object_key, plan_sha256,
      title, summary, requested_by, expires_at, created_at) VALUES ('r1','t','publish','l','a','o','${PLAN}','T','S','agent','2099-01-01','2026-01-01')`).run();
    db.prepare("INSERT INTO child (id, request_id) VALUES ('c1','r1')").run();
    expect(() => db.transaction(() => mig().up(db))()).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) n FROM child').get()).toEqual({ n: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('refuses instead of silently cascading when a child deletes with approval_requests', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrations.find((m) => m.id === '179')!.up(db);
    db.exec(`CREATE TABLE child (id TEXT PRIMARY KEY, request_id TEXT REFERENCES approval_requests(request_id) ON DELETE CASCADE);`);
    db.prepare(`INSERT INTO approval_requests (request_id, tenant_id, kind, location_id, action, object_key, plan_sha256,
      title, summary, requested_by, expires_at, created_at) VALUES ('r1','t','publish','l','a','o','${PLAN}','T','S','agent','2099-01-01','2026-01-01')`).run();
    db.prepare("INSERT INTO child (id, request_id) VALUES ('c1','r1')").run();
    expect(() => db.transaction(() => mig().up(db))()).toThrow(/child would lose rows/);
    expect(db.prepare('SELECT COUNT(*) n FROM child').get()).toEqual({ n: 1 });
  });

  it('upgrades a box that already rebuilt the table with the budget kind and cap columns', () => {
    const db = new Database(':memory:');
    migrations.find((m) => m.id === '179')!.up(db);
    mig().up(db);
    expect(() => mig().up(db)).not.toThrow();
    const cols = db.prepare('PRAGMA table_info(approval_requests)').all().map((c: { name: string }) => c.name);
    expect(cols.filter((c: string) => c === 'cap_minor' || c === 'currency')).toEqual(['cap_minor', 'currency']);
  });
});
