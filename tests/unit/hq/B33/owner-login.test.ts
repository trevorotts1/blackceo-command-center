import '../../_isolated-db';
/**
 * B33 — direct-owner login for a completed company (SPEC rev 4 S7).
 *
 * The whole risk in this unit is that a sign-in capability becomes something it
 * is not: permanent, reusable, cross-origin, switchable onto somebody else's
 * session, or issuable by a caller. Every test below is one of those refusals,
 * plus the one known-good control that proves the instrument can still say yes.
 *
 * No live gateway, no fleet touch, no client write, no secret printed. The
 * database is the isolated temp file the fixture created; the resolved path is
 * asserted before any test runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb, getDbPath, run, queryOne } from '../../../../src/lib/db';
import { POST, GET, PATCH, DELETE } from '../../../../src/app/api/auth/owner-session/route';
import { signTenantGrant, verifyTenantGrant } from '../../../../src/lib/auth/tenant-context';
import { signCsrfToken, CSRF_COOKIE_NAME } from '../../../../src/lib/csrf-protection';
import {
  OWNER_LOGIN_PURPOSE,
  OWNER_LOGIN_TTL_SECONDS,
  OWNER_REDIRECT_PATH,
  OWNER_SESSION_TTL_SECONDS,
  ownerSubjectForChatId,
} from '../../../../src/lib/auth/owner-login';

/* ── Fixture ──────────────────────────────────────────────────────────────── */

const HOST = 'owner-login.example';
const ORIGIN = `https://${HOST}`;
const REGISTRATION = {
  tenantId: 'ol-tenant',
  companyId: 'ol-company',
  installationId: 'ol-install',
  kind: 'self' as const,
};
const OWNER_CHAT = '15550001111';
const OWNER_SUBJECT = ownerSubjectForChatId(OWNER_CHAT);
const OTHER_SUBJECT = ownerSubjectForChatId('15550002222');

const root = process.env.CC_TEST_FIXTURE_ROOT!;
const workspace = path.join(root, 'owner-login-workspace');
fs.mkdirSync(workspace, { recursive: true });

Object.assign(process.env, {
  OPENCLAW_WORKSPACE_ROOT: workspace,
  OPENCLAW_OWNER_CHAT_ID: OWNER_CHAT,
  CC_PUBLIC_URL: ORIGIN,
  MC_TENANT_SESSION_SECRET: 'owner-login-fixture-signing',
  MC_COMPANY_ID: REGISTRATION.companyId,
  MC_INSTALLATION_ID: REGISTRATION.installationId,
  MC_TENANT_REGISTRY_JSON: JSON.stringify({ [HOST]: REGISTRATION }),
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
});
// F2 PATCH re-derivation reads owner record through resolveOwnerChatId(),
// which also consults workspace build state. Pin fixture owner there so
// env-clearing tests still resolve same owner.
fs.writeFileSync(
  path.join(workspace, '.workforce-build-state.json'),
  JSON.stringify({ ownerChat: OWNER_CHAT }),
);

// `hq_owner_login_uses` is B01's migration 169 DDL and is NOT on this branch.
// The consuming unit creates the exact frozen shape here so its own nonce
// semantics can be tested; the migration remains B01's, byte for byte:
// SPEC S6 line 245 / S7 line 281 — nonce TEXT PRIMARY KEY, expires_at INTEGER
// NOT NULL, used_at INTEGER NOT NULL.
getDb();
run(`CREATE TABLE IF NOT EXISTS hq_owner_login_uses (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL
)`);

const now = () => Math.floor(Date.now() / 1000);

/** A ticket exactly as the mint script signs one. */
async function ticket(overrides: Partial<Parameters<typeof signTenantGrant>[0]> = {}) {
  return signTenantGrant({
    purpose: OWNER_LOGIN_PURPOSE,
    tenantId: REGISTRATION.tenantId,
    companyId: REGISTRATION.companyId,
    installationId: REGISTRATION.installationId,
    host: HOST,
    subject: OWNER_SUBJECT,
    exp: now() + OWNER_LOGIN_TTL_SECONDS,
    nonce: randomUUID(),
    ...overrides,
  });
}

/** One signed anti-forgery cookie, as the landing page would have received. */
async function antiForgeryCookie(): Promise<string> {
  const { value } = await signCsrfToken();
  return `${CSRF_COOKIE_NAME}=${value}`;
}

function redeem(
  token: string,
  options: { origin?: string | null; cookie?: string; fetchSite?: string | null; extraHeaders?: Record<string, string>; host?: string } = {},
) {
  const headers: Record<string, string> = { host: options.host ?? HOST, 'content-type': 'application/json' };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.origin = origin;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.fetchSite !== null && options.fetchSite !== undefined) headers['sec-fetch-site'] = options.fetchSite;
  Object.assign(headers, options.extraHeaders ?? {});
  return POST(
    new NextRequest(`${ORIGIN}/api/auth/owner-session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ticket: token }),
    }),
  );
}

const nonceOf = (token: string): string =>
  JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).nonce;

/* ── Instrument ───────────────────────────────────────────────────────────── */

test('the isolated database is real and the nonce table is the frozen shape', () => {
  const resolved = getDbPath();
  assert.ok(resolved && resolved !== '', 'the fixture resolved a database path');
  assert.ok(resolved.startsWith(os.tmpdir()), `resolved path is the isolated temp db: ${resolved}`);
  assert.notEqual(path.basename(resolved), 'mission-control.db', 'never the live board file');
  const columns = (
    queryOne<{ name: string }>(
      "SELECT name FROM pragma_table_info('hq_owner_login_uses') ORDER BY cid LIMIT 1",
    ) as { name: string } | undefined
  )?.name;
  assert.equal(columns, 'nonce', 'nonce is the first (primary key) column');
});

test('KNOWN-GOOD CONTROL: a fresh ticket signs the owner in and the session verifies', async () => {
  const response = await redeem(await ticket(), { cookie: await antiForgeryCookie() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.subject, OWNER_SUBJECT);
  assert.equal(body.redirectTo, OWNER_REDIRECT_PATH);
  const cookie = response.headers.get('set-cookie')!;
  assert.match(cookie, /mc_tenant_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=lax/i);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.match(cookie, new RegExp(`Max-Age=${OWNER_SESSION_TTL_SECONDS}`));
  const grant = await verifyTenantGrant(cookie.split(';')[0].split('=').slice(1).join('='), HOST, 'session');
  assert.ok(grant, 'the issued cookie is a real verifiable session grant');
  assert.equal(grant.subject, OWNER_SUBJECT);
  assert.ok(grant.exp <= now() + OWNER_SESSION_TTL_SECONDS, 'a 30-day session, not an unbounded one');
});

/* ── Expiry: the purpose is bounded, enrollment stays timeless ────────────── */

test('the ten-minute grant is the ONLY bound: an owner-login ticket does not outlive its exp', async () => {
  const live = await ticket();
  assert.equal((await redeem(live, { cookie: await antiForgeryCookie() })).status, 200);

  // Same signature, same building, exp moved two seconds into the past.
  const stale = await ticket({ exp: now() - 2 });
  assert.equal(await verifyTenantGrant(stale, HOST, OWNER_LOGIN_PURPOSE), null, 'an expired owner-login grant never verifies');
  const refused = await redeem(stale, { cookie: await antiForgeryCookie() });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, 'owner_ticket_invalid');
  assert.equal(refused.headers.get('set-cookie'), null, 'a refusal issues no session');
});

test('enrollment is still deliberately timeless — the expiry fix did not quietly bound it', async () => {
  const enrollment = await signTenantGrant({
    purpose: 'enrollment',
    tenantId: REGISTRATION.tenantId,
    companyId: REGISTRATION.companyId,
    installationId: REGISTRATION.installationId,
    host: HOST,
    subject: 'invited-owner:' + 'a'.repeat(64),
    exp: now() - 400 * 86400,
    nonce: randomUUID(),
  });
  const grant = await verifyTenantGrant(enrollment, HOST, 'enrollment');
  assert.ok(grant, 'an enrollment ticket with a long-past exp still verifies');
});

test('a session grant, not just owner-login, is still bounded by its exp', async () => {
  const expiredSession = await signTenantGrant({
    purpose: 'session',
    tenantId: REGISTRATION.tenantId,
    companyId: REGISTRATION.companyId,
    installationId: REGISTRATION.installationId,
    host: HOST,
    subject: OWNER_SUBJECT,
    exp: now() - 1,
    nonce: randomUUID(),
  });
  assert.equal(await verifyTenantGrant(expiredSession, HOST, 'session'), null);
});

/* ── One use ──────────────────────────────────────────────────────────────── */

test('a consumed ticket is refused a second time, and the response-loss case cannot replay', async () => {
  const single = await ticket();
  const first = await redeem(single, { cookie: await antiForgeryCookie() });
  assert.equal(first.status, 200);
  const second = await redeem(single, { cookie: await antiForgeryCookie() });
  assert.equal(second.status, 403);
  assert.equal((await second.json()).error, 'owner_ticket_used');
  assert.equal(second.headers.get('set-cookie'), null, 'the loser of the race gets no cookie');
  const row = queryOne<{ used_at: number }>('SELECT used_at FROM hq_owner_login_uses WHERE nonce=?', [nonceOf(single)]);
  assert.ok(row, 'the winning nonce is recorded');
  assert.equal(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM hq_owner_login_uses WHERE nonce=?', [nonceOf(single)])!.n, 1);
});

test('concurrency: ten simultaneous redemptions of one ticket produce exactly one winner', async () => {
  const shared = await ticket();
  const cookies = await Promise.all(Array.from({ length: 10 }, () => antiForgeryCookie()));
  const results = await Promise.all(cookies.map((cookie) => redeem(shared, { cookie })));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one 200, saw ${JSON.stringify(statuses)}`);
  assert.equal(statuses.filter((s) => s === 403).length, 9);
  assert.equal(
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM hq_owner_login_uses WHERE nonce=?', [nonceOf(shared)])!.n,
    1,
    'one row, one use — the primary key arbitrated, not process memory',
  );
});

test('restart safety: the nonce lives in the database, so a fresh process cannot re-redeem', async () => {
  const single = await ticket();
  assert.equal((await redeem(single, { cookie: await antiForgeryCookie() })).status, 200);
  // Simulate the process-restart case that a process-local replay Map loses:
  // the check goes to durable state, and the row is already there.
  const direct = queryOne<{ nonce: string }>('SELECT nonce FROM hq_owner_login_uses WHERE nonce=?', [nonceOf(single)]);
  assert.ok(direct, 'nonce persisted, not held in memory');
  assert.equal((await redeem(single, { cookie: await antiForgeryCookie() })).status, 403);
});

/* ── Origin / host / company / subject ────────────────────────────────────── */

test('a wrong or absent Origin is refused, scheme and port included', async () => {
  const attempts: Array<{ origin?: string | null; extraHeaders?: Record<string, string> }> = [
    { origin: 'https://evil.example' },
    { origin: 'http://owner-login.example' },              // scheme downgrade
    { origin: 'https://owner-login.example:8443' },        // port mismatch
    { origin: 'https://sub.owner-login.example' },         // subdomain mismatch
    { origin: null },                                      // absent entirely
    { origin: undefined, extraHeaders: { origin: 'not a url' } },
  ];
  for (const attempt of attempts) {
    const response = await redeem(await ticket(), { cookie: await antiForgeryCookie(), ...attempt });
    assert.equal(response.status, 403, `Origin ${JSON.stringify(attempt.origin)} must be refused`);
    assert.equal((await response.json()).error, 'owner_origin_mismatch');
  }
});

test('the anti-forgery cookie is required, and a forged one is not a substitute', async () => {
  const missing = await redeem(await ticket());
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).error, 'owner_antiforgery_missing');

  const forged = await redeem(await ticket(), { cookie: `${CSRF_COOKIE_NAME}=not.a.real.token` });
  assert.equal(forged.status, 403);
  assert.equal((await forged.json()).error, 'owner_antiforgery_missing');
});

test('cross-site Fetch Metadata is refused when present, and its absence alone is not fatal', async () => {
  const crossSite = await redeem(await ticket(), { cookie: await antiForgeryCookie(), fetchSite: 'cross-site' });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error, 'owner_origin_mismatch');

  const sameOrigin = await redeem(await ticket(), { cookie: await antiForgeryCookie(), fetchSite: 'same-origin' });
  assert.equal(sameOrigin.status, 200);
});

test('a ticket minted for another host, company or installation never redeems here', async () => {
  const foreignHost = await ticket({ host: 'other.example' });
  assert.equal((await redeem(foreignHost, { cookie: await antiForgeryCookie() })).status, 403);

  const foreignCompany = await ticket({ companyId: 'someone-else' });
  assert.equal((await redeem(foreignCompany, { cookie: await antiForgeryCookie() })).status, 403);

  const foreignInstall = await ticket({ installationId: 'not-this-box' });
  assert.equal((await redeem(foreignInstall, { cookie: await antiForgeryCookie() })).status, 403);

  const foreignTenant = await ticket({ tenantId: 'other-tenant' });
  assert.equal((await redeem(foreignTenant, { cookie: await antiForgeryCookie() })).status, 403);
});

test('a client-kind registration cannot redeem an owner ticket', async () => {
  const clientReg = {
    ...REGISTRATION,
    kind: 'client',
    clientId: 'some-client',
  };
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [HOST]: clientReg });
  try {
    assert.equal((await redeem(await ticket(), { cookie: await antiForgeryCookie() })).status, 403);
  } finally {
    process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [HOST]: REGISTRATION });
  }
});

test('a tampered signature, a mismatched purpose, and a bearer cannot get in', async () => {
  const valid = await ticket();
  const [payload, signature] = valid.split('.');
  for (const forged of [`${payload}.${signature.slice(0, -2)}AA`, `${payload}x.${signature}`, 'forged.signature', `${payload}.${signature}.extra`]) {
    const response = await redeem(forged, { cookie: await antiForgeryCookie() });
    assert.equal(response.status, 403, `tampered ticket ${forged.slice(0, 12)}… must be refused`);
  }
  // A session grant is not an owner-login grant, even though both are signed.
  const wrongPurpose = await ticket({ purpose: 'session' as never });
  assert.equal((await redeem(wrongPurpose, { cookie: await antiForgeryCookie() })).status, 403);

  const withBearer = await redeem(await ticket(), {
    cookie: await antiForgeryCookie(),
    extraHeaders: { authorization: 'Bearer ' + (process.env.MC_API_TOKEN ?? 'anything') },
  });
  assert.equal(withBearer.status, 403);
  assert.equal((await withBearer.json()).error, 'owner_bearer_not_accepted');
});

test('body shape is enforced: {ticket} only, bounded, and never a caller-chosen target', async () => {
  const cookie = await antiForgeryCookie();
  const post = (body: string, raw = false) =>
    POST(
      new NextRequest(`${ORIGIN}/api/auth/owner-session`, {
        method: 'POST',
        headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', cookie },
        body,
      }),
    );

  assert.equal((await post('')).status, 403);
  assert.equal((await post('{')).status, 403);
  assert.equal((await post(JSON.stringify({ ticket: 42 }))).status, 403);
  assert.equal((await post(JSON.stringify({ ticket: 'x'.repeat(4097) }))).status, 403);

  // A `next`-style field is ignored entirely: the only destination is /hq.
  const withNext = await post(JSON.stringify({ ticket: await ticket(), next: 'https://evil.example' }));
  assert.equal(withNext.status, 200);
  assert.equal((await withNext.json()).redirectTo, OWNER_REDIRECT_PATH);

  // Over 4 KiB is refused before any parse.
  assert.equal((await post('x'.repeat(4097), true)).status, 403);
});

/* ── Existing identity is never replaced ──────────────────────────────────── */

/** A valid browser session cookie for `subject`, as the interview route issues one. */
async function sessionCookie(subject: string): Promise<string> {
  const token = await signTenantGrant({
    purpose: 'session',
    tenantId: REGISTRATION.tenantId,
    companyId: REGISTRATION.companyId,
    installationId: REGISTRATION.installationId,
    host: HOST,
    subject,
    exp: now() + 3600,
    nonce: randomUUID(),
  });
  return `mc_tenant_session=${token}`;
}

test('a different subject presenting a ticket is told to sign out — identities never merge', async () => {
  const cookie = await antiForgeryCookie();
  const response = await redeem(await ticket(), {
    cookie,
    extraHeaders: { cookie: `${cookie}; ${await sessionCookie(OTHER_SUBJECT)}` },
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'identity_switch_requires_signout');
  assert.equal(response.headers.get('set-cookie'), null, 'no cookie is handed to the wrong principal');
});

test('the same stable subject re-redeeming its own fresh ticket continues without a switch', async () => {
  const cookie = await antiForgeryCookie();
  const response = await redeem(await ticket(), {
    cookie,
    extraHeaders: { cookie: `${cookie}; ${await sessionCookie(OWNER_SUBJECT)}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).subject, OWNER_SUBJECT);
});

/* ── GET / PATCH / DELETE ─────────────────────────────────────────────────── */

test('GET reports scope and no secrets; anonymous gets nothing', async () => {
  const anonymous = await GET(new NextRequest(`${ORIGIN}/api/auth/owner-session`, { headers: { host: HOST } }));
  assert.equal(anonymous.status, 403);
  assert.equal((await anonymous.json()).error, 'owner_session_missing');

  const authed = await GET(
    new NextRequest(`${ORIGIN}/api/auth/owner-session`, {
      headers: { host: HOST, cookie: await sessionCookie(OWNER_SUBJECT) },
    }),
  );
  assert.equal(authed.status, 200);
  const body = await authed.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.subject, OWNER_SUBJECT);
  assert.equal(body.via, 'session');
  const serialized = JSON.stringify(body);
  for (const secret of ['ticket', 'mc_tenant_session', 'gateway', 'token']) {
    assert.doesNotMatch(serialized, new RegExp(secret, 'i'), `response must not carry ${secret}`);
  }
});

test('PATCH renews only a live browser session under exact-origin and anti-forgery checks, and never switches subject', async () => {
  const cookie = await antiForgeryCookie();
  const session = await sessionCookie(OWNER_SUBJECT);
  const patch = (headers: Record<string, string>) =>
    PATCH(new NextRequest(`${ORIGIN}/api/auth/owner-session`, { method: 'PATCH', headers: { host: HOST, ...headers } }));

  assert.equal((await patch({})).status, 403, 'no Origin, no renewal');
  const wrongOrigin = await patch({ origin: 'https://evil.example', cookie });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await wrongOrigin.json()).error, 'owner_origin_mismatch');
  assert.equal((await patch({ origin: ORIGIN, cookie: `${cookie}; ${session}` })).status, 200, 'the control: a live session with checks passes');
  const withoutAntiforgery = await patch({ origin: ORIGIN, cookie: session });
  assert.equal(withoutAntiforgery.status, 403);
  assert.equal((await withoutAntiforgery.json()).error, 'owner_antiforgery_missing');

  // A session for a subject the resolver no longer agrees with is a collision.
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [HOST]: { ...REGISTRATION, companyId: 'rebound' } });
  try {
    const rebound = await patch({ origin: ORIGIN, cookie: `${cookie}; ${session}` });
    assert.equal(rebound.status, 403, 'a registry rebind does not carry the old session over');
  } finally {
    process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ [HOST]: REGISTRATION });
  }

  // Renewal without any session at all.
  assert.equal((await patch({ origin: ORIGIN, cookie })).status, 403);
});

test('DELETE clears this cookie and says so, without pretending to end an Access identity', async () => {
  const cookie = await antiForgeryCookie();
  const withoutIdentity = await DELETE(
    new NextRequest(`${ORIGIN}/api/auth/owner-session`, { method: 'DELETE', headers: { host: HOST, origin: ORIGIN, cookie } }),
  );
  assert.equal(withoutIdentity.status, 403, 'DELETE is not part of the unauthenticated exemption');

  const response = await DELETE(
    new NextRequest(`${ORIGIN}/api/auth/owner-session`, {
      method: 'DELETE',
      headers: { host: HOST, origin: ORIGIN, cookie: `${cookie}; ${await sessionCookie(OWNER_SUBJECT)}` },
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cleared, true);
  assert.equal(body.via, 'session');
  const cleared = response.headers.get('set-cookie')!;
  assert.match(cleared, /mc_tenant_session=;/);
  assert.match(cleared, /Max-Age=0/);
  assert.doesNotMatch(JSON.stringify(body), /access/i, 'no claim about an independent Access identity');
});

/* ── Retention ────────────────────────────────────────────────────────────── */

test('expired nonce rows are pruned on the safe side of the capability clock', async () => {
  const staleNonce = randomUUID();
  const freshNonce = randomUUID();
  const far = now() - 400 * 86400;
  run('INSERT INTO hq_owner_login_uses (nonce,expires_at,used_at) VALUES (?,?,?)', [staleNonce, far, far]);
  run('INSERT INTO hq_owner_login_uses (nonce,expires_at,used_at) VALUES (?,?,?)', [freshNonce, now() + OWNER_LOGIN_TTL_SECONDS, now()]);

  const pruned = await redeem(await ticket(), { cookie: await antiForgeryCookie() });
  assert.equal(pruned.status, 200);

  assert.equal(
    queryOne('SELECT nonce FROM hq_owner_login_uses WHERE nonce=?', [staleNonce]),
    undefined,
    'a long-expired row is cleaned up',
  );
  assert.ok(
    queryOne('SELECT nonce FROM hq_owner_login_uses WHERE nonce=?', [freshNonce]),
    'a still-valid row is never evicted to make room',
  );
});

/* ── The landing page itself ──────────────────────────────────────────────── */

test('the landing page is data-free: no database, no server data fetch, no caller-chosen redirect', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/app/owner-login/page.tsx'),
    'utf8',
  );
  // Scan the CODE, not the prose: this file documents the very things it
  // refuses to do ("no analytics", "no returnTo"), and a bare substring scan
  // would match its own explanation. Comments out, then judge.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // No server-side data access of any kind — the page cannot render company
  // data before authentication because it never asks for any.
  for (const forbidden of ['@/lib/db', 'getDb(', 'queryOne', 'queryAll', 'requireHqContext', 'resolveTenantContext']) {
    assert.equal(code.includes(forbidden), false, `landing page must not reference ${forbidden}`);
  }
  // No third-party or analytics resource on a page that handles a capability,
  // and no absolute URL at all: the only request it makes is same-origin.
  for (const forbidden of ['http://', 'https://', 'gtag', 'googletagmanager', 'analytics']) {
    assert.equal(code.includes(forbidden), false, `landing page must not reference ${forbidden}`);
  }
  // The destination is a constant, and no caller-supplied redirect exists.
  assert.match(code, /const DESTINATION = '\/hq'/, 'the only destination is the /hq constant');
  for (const forbidden of ['returnTo', 'redirectUrl', 'next=']) {
    assert.equal(code.includes(forbidden), false, `landing page must not honour ${forbidden}`);
  }
  assert.match(code, /history\.replaceState/, 'the fragment is stripped from history');
  assert.match(code, /window\.location\.hash/, 'the ticket is read from the fragment, never a query');
});

/* ── F1: port-bearing origin mints a verifiable session ─────────────────── */

test('F1: a port-bearing configured origin mints a grant the runtime host form verifies', async () => {
  // requestHost() strips the port by design; the mint must sign the same
  // hostname-only form, or redeem 200s a cookie /hq can never verify.
  const PORT_HOST = 'owner-login-port.example';
  const PORT_ORIGIN = `http://${PORT_HOST}:4000`;
  const savedRegistry = process.env.MC_TENANT_REGISTRY_JSON;
  const savedUrl = process.env.CC_PUBLIC_URL;
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [PORT_HOST]: { ...REGISTRATION, tenantId: 'ol-port', companyId: REGISTRATION.companyId, installationId: REGISTRATION.installationId },
  });
  process.env.CC_PUBLIC_URL = PORT_ORIGIN;
  try {
    const portTicket = await signTenantGrant({
      purpose: OWNER_LOGIN_PURPOSE,
      tenantId: 'ol-port',
      companyId: REGISTRATION.companyId,
      installationId: REGISTRATION.installationId,
      host: PORT_HOST, // mint signs origin.hostname, never origin.host
      subject: OWNER_SUBJECT,
      exp: now() + OWNER_LOGIN_TTL_SECONDS,
      nonce: randomUUID(),
    });
    const redeemHeaders: Record<string, string> = {
      host: `${PORT_HOST}:4000`, // Host header the runtime actually sends
      origin: PORT_ORIGIN,
      'content-type': 'application/json',
      cookie: await antiForgeryCookie(),
    };
    const response = await POST(
      new NextRequest(`${PORT_ORIGIN}/api/auth/owner-session`, {
        method: 'POST',
        headers: redeemHeaders,
        body: JSON.stringify({ ticket: portTicket }),
      }),
    );
    assert.equal(response.status, 200, 'port-bearing origin must redeem, not refuse');
    const rawCookie = response.headers.get('set-cookie')!;
    const sessionToken = rawCookie.split(';')[0].split('=').slice(1).join('=');
    // Verify through the runtime host form (requestHost strips the port).
    const grant = await verifyTenantGrant(sessionToken, PORT_HOST, 'session');
    assert.ok(grant, 'issued session must verify under the hostname-only host');
    assert.equal(grant.subject, OWNER_SUBJECT);
    const decoded = JSON.parse(Buffer.from(portTicket.split('.')[0], 'base64url').toString());
    assert.equal(decoded.host, PORT_HOST, 'mint binds hostname-only host, never host:port');
  } finally {
    process.env.MC_TENANT_REGISTRY_JSON = savedRegistry;
    process.env.CC_PUBLIC_URL = savedUrl;
  }
});

test('F1: the REAL mint script signs hostname-only, and its link redeems verifiably', async () => {
  // The test above proves the ROUTE half. This one proves the MINT half: the
  // real script, run as the operator runs it, for a port-bearing configured
  // origin. Reverting `origin.hostname` to `origin.host` in the script must
  // turn exactly this test red; without it the script's port bug is invisible.
  const scriptPath = fileURLToPath(new URL('../../../../scripts/mint-owner-login.ts', import.meta.url));
  const repoRoot = path.resolve(path.dirname(scriptPath), '..');
  assert.ok(fs.existsSync(scriptPath), `mint script path resolves: ${scriptPath}`);

  const PORT_HOST = 'owner-login-script.example';
  const PORT_ORIGIN = `http://${PORT_HOST}:4000`;
  const savedRegistry = process.env.MC_TENANT_REGISTRY_JSON;
  const savedUrl = process.env.CC_PUBLIC_URL;
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [PORT_HOST]: { ...REGISTRATION, tenantId: 'ol-script', companyId: REGISTRATION.companyId, installationId: REGISTRATION.installationId },
  });
  process.env.CC_PUBLIC_URL = PORT_ORIGIN;
  try {
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', scriptPath, '--origin', PORT_ORIGIN],
      { cwd: repoRoot, env: process.env, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(run.status, 0, `mint script exits 0: ${run.stderr?.slice(0, 300)}`);
    const link = (run.stdout || '').split('\n')[0] || '';
    assert.match(link, /^http:\/\/owner-login-script\.example:4000\/owner-login#ticket=/, 'real script link format');
    const minted = link.split('#ticket=')[1];
    const decoded = JSON.parse(Buffer.from(minted.split('.')[0], 'base64url').toString());
    assert.equal(decoded.host, PORT_HOST, 'the script signs hostname-only, never host:port');
    assert.equal(decoded.purpose, OWNER_LOGIN_PURPOSE);

    const response = await POST(
      new NextRequest(`${PORT_ORIGIN}/api/auth/owner-session`, {
        method: 'POST',
        headers: {
          host: `${PORT_HOST}:4000`,
          origin: PORT_ORIGIN,
          'content-type': 'application/json',
          cookie: await antiForgeryCookie(),
        },
        body: JSON.stringify({ ticket: minted }),
      }),
    );
    assert.equal(response.status, 200, 'the real script output must redeem, not be refused');
    const rawCookie = response.headers.get('set-cookie')!;
    const sessionToken = rawCookie.split(';')[0].split('=').slice(1).join('=');
    const grant = await verifyTenantGrant(sessionToken, PORT_HOST, 'session');
    assert.ok(grant, 'the session from the real script link verifies under the runtime host form');
    assert.equal(grant.subject, OWNER_SUBJECT);
  } finally {
    process.env.MC_TENANT_REGISTRY_JSON = savedRegistry;
    process.env.CC_PUBLIC_URL = savedUrl;
  }
});

/* ── F2: PATCH refuses a removed owner mapping ─────────────────────────── */

test('F2: PATCH renews while the owner mapping matches, then 403s it after removal', async () => {
  const cookie = await antiForgeryCookie();
  const session = await sessionCookie(OWNER_SUBJECT);
  const patch = (headers: Record<string, string>) =>
    PATCH(new NextRequest(`${ORIGIN}/api/auth/owner-session`, { method: 'PATCH', headers: { host: HOST, ...headers } }));

  // Control: mapping matches, renewal passes.
  const control = await patch({ origin: ORIGIN, cookie: `${cookie}; ${session}` });
  assert.equal(control.status, 200, 'live session with matching owner record renews');
  assert.ok((control.headers.get('set-cookie') || '').includes('mc_tenant_session='), 'control issues a fresh cookie');

  // Flip the owner record only: same registry, same session, new chat id.
  const savedOwner = process.env.OPENCLAW_OWNER_CHAT_ID;
  fs.writeFileSync(
    path.join(workspace, '.workforce-build-state.json'),
    JSON.stringify({ ownerChat: '15550009999' }),
  );
  process.env.OPENCLAW_OWNER_CHAT_ID = '15550009999';
  try {
    const flipped = await patch({ origin: ORIGIN, cookie: `${cookie}; ${session}` });
    assert.equal(flipped.status, 403, 'a re-pointed owner mapping must not renew');
    assert.equal((await flipped.json()).error, 'owner_session_renewal_refused');
    assert.equal(flipped.headers.get('set-cookie'), null, 'a refusal issues no session');
  } finally {
    process.env.OPENCLAW_OWNER_CHAT_ID = savedOwner;
    fs.writeFileSync(
      path.join(workspace, '.workforce-build-state.json'),
      JSON.stringify({ ownerChat: OWNER_CHAT }),
    );
  }
});

test('F2: PATCH refuses when no owner record resolves at all', async () => {
  const cookie = await antiForgeryCookie();
  const session = await sessionCookie(OWNER_SUBJECT);
  const patch = (headers: Record<string, string>) =>
    PATCH(new NextRequest(`${ORIGIN}/api/auth/owner-session`, { method: 'PATCH', headers: { host: HOST, ...headers } }));

  const savedOwner = process.env.OPENCLAW_OWNER_CHAT_ID;
  fs.writeFileSync(path.join(workspace, '.workforce-build-state.json'), JSON.stringify({}));
  delete process.env.OPENCLAW_OWNER_CHAT_ID;
  try {
    const removed = await patch({ origin: ORIGIN, cookie: `${cookie}; ${session}` });
    assert.equal(removed.status, 403, 'a removed owner mapping must not renew');
    assert.equal((await removed.json()).error, 'owner_session_renewal_refused');
    assert.equal(removed.headers.get('set-cookie'), null, 'a refusal issues no session');
  } finally {
    process.env.OPENCLAW_OWNER_CHAT_ID = savedOwner;
    fs.writeFileSync(
      path.join(workspace, '.workforce-build-state.json'),
      JSON.stringify({ ownerChat: OWNER_CHAT }),
    );
  }
});
