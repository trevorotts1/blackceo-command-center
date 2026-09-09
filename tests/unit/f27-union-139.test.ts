/**
 * UNION-139 PROOF — runs the pristine social-f27-mini-app.test.ts suite (copied verbatim from its home
 * worktree, only import depths adjusted) against THIS worktree's union
 * migration 139. It proves the single superset migration satisfies that
 * task's contract. Do not edit the tests below; edit the migration.
 */
/**
 * social-f27-mini-app.test.ts — F27 acceptance (CC half).
 *
 * QC-F27: "Use clients A/B and weeks 1/2. Save half an interview, close,
 * expire link, renew and resume on another device. Assert answers and
 * revisions survive. Try foreign session IDs, CSRF, replay, duplicate
 * submit and two-tab revision conflict; reject unsafe requests, preserve
 * edits and dispatch once. Skip week1 still invites week2."
 *
 * Proven in-process against an isolated temp DB (real migration chain incl.
 * 139), the REAL route handlers and the REAL token helpers:
 *
 *   1. Migration 139 creates the five social-theme tables.
 *   2. Invitations: operator/service auth only; client tenant 403; company
 *      must exist; cycle unique per (company, week) — weeks 1/2 independent,
 *      duplicate request collapses to the same cycle; raw token returned
 *      once, only its SHA-256 hash stored.
 *   3. Exchange: single-use (replay → same failure shape), expired link
 *      rejected with renew hint, mints scoped HttpOnly cookie bound to
 *      session+company+cycle; foreign token rejected without an oracle.
 *   4. Session GET/PATCH: company/cycle derived from cookie only; foreign
 *      session ids rejected; PATCH with wrong expected revision → 409
 *      preserving BOTH answers; schema validation rejects hostile payloads.
 *   5. Submit: idempotent — duplicate submit → ONE cycle + ONE outbox row,
 *      original receipt replayed; revision sealed.
 *   6. Renew: session-cookie path mints a NEW ticket for the SAME draft
 *      (answers + revision intact across devices); expired ticket + renew
 *      resume works.
 *   7. Skip week1 still leaves week2 invitable; pause is a separate
 *      preference and never touches cycles.
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/f27-union-139.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { getDb, run, queryOne, closeDb } from '../../src/lib/db';
import { POST as invitationsPOST } from '../../src/app/api/social-theme/invitations/route';
import { POST as exchangePOST } from '../../src/app/api/social-theme/exchange/route';
import { GET as sessionGET, PATCH as sessionPATCH } from '../../src/app/api/social-theme/session/route';
import { POST as submitPOST } from '../../src/app/api/social-theme/submit/route';
import { POST as renewPOST } from '../../src/app/api/social-theme/renew/route';
import { POST as skipPOST } from '../../src/app/api/social-theme/skip/route';
import { GET as prefsGET, PATCH as prefsPATCH } from '../../src/app/api/social-theme/preferences/route';
import {
  hashInvitationToken,
  signSessionCookie,
  SOCIAL_THEME_COOKIE,
} from '../../src/lib/social-theme/theme-sessions';
import { signCsrfToken } from '../../src/lib/csrf-protection';
import { ensureCycle, getCycleByWeek, outboxForCycle } from '../../src/lib/social-theme/cycles';

process.env.MC_TENANT_SESSION_SECRET = 'f27-test-secret';
process.env.MC_TENANT_PUBLIC_URL = 'https://cc-f27.example.com';
process.env.NODE_ENV = 'production';
process.env.MC_API_TOKEN = 'f27-operator-token';

getDb(); // trigger the full migration chain (incl. 139) against the isolated DB

// Seed the two companies + operator bearer context.
function seedCompany(id: string): void {
  run(
    `INSERT OR IGNORE INTO clients (id, name, is_self) VALUES (?, ?, 0)`,
    [id, id],
  );
}
seedCompany('company-a');
seedCompany('company-b');

const OPERATOR_HEADERS = () => {
  const h = new Headers();
  h.set('authorization', `Bearer ${process.env.MC_API_TOKEN}`);
  h.set('host', 'operator-f27.example.com');
  // Full registry EVERY call — earlier tests may have narrowed it.
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'operator-f27.example.com': {
      tenantId: 'self', companyId: 'default', kind: 'self',
      installationId: 'f27-install',
    },
    'a-f27.example.com': {
      tenantId: 'tenant-a', companyId: 'company-a', clientId: 'client-a',
      kind: 'client', installationId: 'install-a',
    },
    'b-f27.example.com': {
      tenantId: 'tenant-b', companyId: 'company-b', clientId: 'client-b',
      kind: 'client', installationId: 'install-b',
    },
  });
  return h;
};

function jsonRequest(url: string, body: unknown, extra?: Headers): NextRequest {
  const headers = extra ? new Headers(extra) : new Headers();
  headers.set('content-type', 'application/json');
  return new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

const WEEK1 = '2026-09-07'; // a Monday
const WEEK2 = '2026-09-14';

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

async function createInvitation(companyId: string, week: string) {
  const req = jsonRequest(
    `https://operator-f27.example.com/api/social-theme/invitations`,
    { company_id: companyId, week_start_local: week, timezone: 'America/New_York' },
    OPERATOR_HEADERS(),
  );
  const res = await invitationsPOST(req);
  return res;
}

async function exchangeTicket(host: string, ticket: string) {
  const req = jsonRequest(`https://${host}/api/social-theme/exchange`, { ticket });
  return exchangePOST(req);
}

function cookieFrom(res: {
  cookies: { get(name: string): { value: string } | undefined };
  headers: Headers;
}): string | null {
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(new RegExp(`${SOCIAL_THEME_COOKIE}=([^;]+)`));
  return match ? match[1] : (res.cookies.get(SOCIAL_THEME_COOKIE)?.value ?? null);
}

let CSRF_COOKIE_VALUE: string | null = null;
async function csrfCookie(): Promise<string> {
  if (!CSRF_COOKIE_VALUE) {
    const { value } = await signCsrfToken();
    CSRF_COOKIE_VALUE = value;
  }
  return CSRF_COOKIE_VALUE;
}

async function sessionRequest(host: string, cookieValue: string | null, method: 'GET' | 'PATCH', body?: unknown): Promise<NextRequest> {
  const headers = new Headers();
  headers.set('host', host);
  const parts: string[] = [];
  if (cookieValue) parts.push(`${SOCIAL_THEME_COOKIE}=${cookieValue}`);
  if (method === 'PATCH') parts.push(`mc_csrf_token=${await csrfCookie()}`);
  if (parts.length) headers.set('cookie', parts.join('; '));
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(`https://${host}/api/social-theme/session`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/* ── 1. Migration 139 ──────────────────────────────────────────────────── */

test('migration 139 creates the five social-theme tables', () => {
  const tables = [
    'social_cycles', 'social_theme_sessions', 'social_invitations',
    'social_policies', 'social_notification_outbox',
  ];
  for (const t of tables) {
    const row = queryOne<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [t],
    );
    assert.ok(row, `table ${t} must exist`);
  }
  // Unique constraints per contract.
  const cycleIdx = queryOne<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='social_cycles'`,
  );
  assert.match(cycleIdx!.sql, /UNIQUE \(company_id, week_start_local\)/);
  const sessIdx = queryOne<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='social_theme_sessions'`,
  );
  assert.match(sessIdx!.sql, /UNIQUE \(company_id, cycle_id\)/);
  const outboxIdx = queryOne<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='social_notification_outbox'`,
  );
  assert.match(outboxIdx!.sql, /UNIQUE \(company_id, dedupe_key\)/);
});

/* ── 2. Invitations ────────────────────────────────────────────────────── */

test('invitations: client tenant cannot mint (403), unknown company 404', async () => {
  // Client-tenant cookie attempt.
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    'a-f27.example.com': {
      tenantId: 'tenant-a', companyId: 'company-a', clientId: 'client-a',
      kind: 'client', installationId: 'install-a',
    },
  });
  const payload = Buffer.from(JSON.stringify({
    purpose: 'session', tenantId: 'tenant-a', companyId: 'company-a',
    subject: 'owner:fixture', host: 'a-f27.example.com',
    installationId: 'install-a', exp: Date.now() / 1000 + 3600, nonce: 'f27-x',
  })).toString('base64url');
  const { createHmac } = await import('node:crypto');
  const sig = createHmac('sha256', process.env.MC_TENANT_SESSION_SECRET).update(payload).digest('base64url');
  const headers = new Headers();
  headers.set('host', 'a-f27.example.com');
  headers.set('cookie', `mc_tenant_session=${payload}.${sig}`);
  const clientReq = jsonRequest('https://a-f27.example.com/api/social-theme/invitations',
    { company_id: 'company-a', week_start_local: WEEK1 }, headers);
  const clientRes = await invitationsPOST(clientReq);
  assert.equal(clientRes.status, 403);

  // Unknown company (operator auth).
  const unknown = await createInvitation('company-z', WEEK1);
  assert.equal(unknown.status, 404);
  const body = await unknown.json();
  assert.equal(body.error, 'E_COMPANY_NOT_FOUND');
});

test('invitation week1/week2 for A and B: separate cycles, raw token returned once, only hash stored', async () => {
  const res1 = await createInvitation('company-a', WEEK1);
  assert.equal(res1.status, 200);
  const inv1 = await res1.json();
  assert.equal(inv1.purpose, 'social-theme');
  assert.ok(inv1.url.includes('ticket='));
  const rawTicket1 = decodeURIComponent(inv1.url.split('ticket=')[1]);

  // Only the SHA-256 hash is persisted.
  const row = queryOne<{ token_hash: string; company_id: string; cycle_id: string }>(
    `SELECT token_hash, company_id, cycle_id FROM social_invitations WHERE id = ?`,
    [inv1.invitation_id],
  );
  assert.ok(row);
  assert.equal(row.token_hash, hashInvitationToken(rawTicket1));
  assert.ok(!row.token_hash.includes(rawTicket1));

  // Week 2 = a DIFFERENT cycle for the same company.
  const res2 = await createInvitation('company-a', WEEK2);
  assert.equal(res2.status, 200);
  const inv2 = await res2.json();
  assert.notEqual(inv2.cycle_id, inv1.cycle_id);
  assert.notEqual(inv2.session_id, inv1.session_id);

  // Client B's week 1 is a separate cycle from A's week 1.
  const resB = await createInvitation('company-b', WEEK1);
  assert.equal(resB.status, 200);
  const invB = await resB.json();
  assert.notEqual(invB.cycle_id, inv1.cycle_id);
  assert.notEqual(invB.session_id, inv1.session_id);

  // Duplicate invitation request collapses onto the SAME cycle.
  const dup = await createInvitation('company-a', WEEK1);
  assert.equal(dup.status, 200);
  const invDup = await dup.json();
  assert.equal(invDup.cycle_id, inv1.cycle_id);
});

/* ── 3. Exchange + resume ──────────────────────────────────────────────── */

test('exchange: single-use; replay rejected; expired rejected with renew hint; foreign ticket no oracle', async () => {
  const inv = await (await createInvitation('company-a', WEEK1)).json();
  const raw = decodeURIComponent(inv.url.split('ticket=')[1]);

  const first = await exchangeTicket('a-f27.example.com', raw);
  assert.equal(first.status, 200);
  const cookie = cookieFrom(first);
  assert.ok(cookie, 'exchange must set the social-theme session cookie');
  const firstBody = await first.json();
  assert.equal(firstBody.clear_ticket_from_url, true);

  // Replay — the same token cannot mint a second session. Same failure shape
  // as unknown (no oracle).
  const replay = await exchangeTicket('a-f27.example.com', raw);
  assert.equal(replay.status, 403);

  // Foreign/unknown ticket — same shape as replay.
  const foreign = await exchangeTicket('a-f27.example.com', 'not-a-real-ticket-value');
  assert.equal(foreign.status, 403);
  const fBody = await foreign.json();
  const rBody = await replay.json();
  assert.equal(fBody.error, rBody.error);
});

test('expired link: exchange rejected; renew via operator mints NEW ticket for SAME draft; answers survive on another device', async () => {
  const inv = await (await createInvitation('company-b', WEEK1)).json();
  const raw = decodeURIComponent(inv.url.split('ticket=')[1]);
  const exchanged = await exchangeTicket('b-f27.example.com', raw);
  assert.equal(exchanged.status, 200);
  const cookie = cookieFrom(exchanged)!;

  // Save half the interview.
  const patch = sessionPATCH(await sessionRequest('b-f27.example.com', cookie, 'PATCH', {
    answers: { theme: 'Fall promotion', goal: 'leads' },
    expected_revision: 0,
  }));
  const saved = await patch;
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.revision, 1);

  // Expire the invitation link manually (force-expire a fresh one to prove
  // expiry is honored): mint a second invitation then backdate it.
  const inv2 = await (await createInvitation('company-b', WEEK1)).json();
  const raw2 = decodeURIComponent(inv2.url.split('ticket=')[1]);
  run(`UPDATE social_invitations SET expires_at = ? WHERE id = ?`,
    [new Date(Date.now() - 1000).toISOString(), inv2.invitation_id]);
  const expiredExchange = await exchangeTicket('b-f27.example.com', raw2);
  assert.equal(expiredExchange.status, 403);
  const expBody = await expiredExchange.json();
  assert.ok(expBody.renew_hint, 'expired exchange must carry the renew hint');

  // Renew on ANOTHER DEVICE: no cookie, operator/service path.
  const renewReq = jsonRequest('https://operator-f27.example.com/api/social-theme/renew', {
    company_id: 'company-b', week_start_local: WEEK1,
  }, OPERATOR_HEADERS());
  const renewed = await renewPOST(renewReq);
  assert.equal(renewed.status, 200);
  const renewBody = await renewed.json();
  assert.equal(renewBody.session_id, inv.session_id, 'renew binds the SAME draft session');
  assert.notEqual(renewBody.invitation_id, inv2.invitation_id, 'renew mints a NEW ticket');

  const newRaw = decodeURIComponent(renewBody.url.split('ticket=')[1]);
  const resume = await exchangeTicket('b-f27.example.com', newRaw);
  assert.equal(resume.status, 200);
  const resumeCookie = cookieFrom(resume)!;

  // Answers + revision intact on the "other device".
  const state = await sessionGET(await sessionRequest('b-f27.example.com', resumeCookie, 'GET'));
  assert.equal(state.status, 200);
  const stateBody = await state.json();
  assert.equal(stateBody.answers.theme, 'Fall promotion');
  assert.equal(stateBody.answers.goal, 'leads');
  assert.equal(stateBody.session.revision, 1);
});

/* ── 4. Session security + conflict ────────────────────────────────────── */

test('foreign session ids rejected: cookie grant re-proofs against DB; company A cannot read B', async () => {
  const invA = await (await createInvitation('company-a', WEEK2)).json();
  const rawA = decodeURIComponent(invA.url.split('ticket=')[1]);
  const exA = await exchangeTicket('a-f27.example.com', rawA);
  const cookieA = cookieFrom(exA)!;

  // Forge a cookie pointing at company B's session id using A's session id —
  // the verifier re-proofs company/cycle against the sessions table.
  const forged = await signSessionCookie({
    sessionId: invA.session_id,
    companyId: 'company-b', // wrong company for this session row
    cycleId: invA.cycle_id,
  });
  const foreign = await sessionGET(await sessionRequest('b-f27.example.com', forged.value, 'GET'));
  assert.equal(foreign.status, 403, 'company/cycle mismatch in the grant must 403');

  // Normal path still works for A.
  const own = await sessionGET(await sessionRequest('a-f27.example.com', cookieA, 'GET'));
  assert.equal(own.status, 200);
});

test('two-tab revision conflict: 409 preserves BOTH answers; stale writer never overwrites', async () => {
  const inv = await (await createInvitation('company-a', WEEK1)).json();
  const raw = decodeURIComponent(inv.url.split('ticket=')[1]);
  const ex = await exchangeTicket('a-f27.example.com', raw);
  const cookie = cookieFrom(ex)!;

  // Tab 1 saves at revision 0.
  const t1 = await sessionPATCH(await sessionRequest('a-f27.example.com', cookie, 'PATCH', {
    answers: { theme: 'tab1 theme' }, expected_revision: 0,
  }));
  assert.equal(t1.status, 200);
  const t1Body = await t1.json();
  assert.equal(t1Body.revision, 1);

  // Tab 2 (stale) tries the same revision — 409 with server's answers.
  const t2 = await sessionPATCH(await sessionRequest('a-f27.example.com', cookie, 'PATCH', {
    answers: { theme: 'tab2 theme' }, expected_revision: 0,
  }));
  assert.equal(t2.status, 409);
  const t2Body = await t2.json();
  assert.equal(t2Body.error, 'revision_conflict');
  assert.equal(t2Body.server.revision, 1);
  assert.equal(t2Body.server.answers.theme, 'tab1 theme', 'server answer preserved');
  assert.equal(t2Body.client.revision, 0);

  // Tab 2 adopts the server revision and adds its own field — merge works.
  const t2fix = await sessionPATCH(await sessionRequest('a-f27.example.com', cookie, 'PATCH', {
    answers: { audience: 'tab2 audience' }, expected_revision: 1,
  }));
  assert.equal(t2fix.status, 200);

  // Both survive.
  const state = await sessionGET(await sessionRequest('a-f27.example.com', cookie, 'GET'));
  const stateBody = await state.json();
  assert.equal(stateBody.answers.theme, 'tab1 theme');
  assert.equal(stateBody.answers.audience, 'tab2 audience');
});

test('PATCH schema validation: hostile answer keys/values rejected', async () => {
  const inv = await (await createInvitation('company-a', WEEK2)).json();
  const raw = decodeURIComponent(inv.url.split('ticket=')[1]);
  const ex = await exchangeTicket('a-f27.example.com', raw);
  const cookie = cookieFrom(ex)!;

  const bad1 = await sessionPATCH(await sessionRequest('a-f27.example.com', cookie, 'PATCH', {
    answers: { 'bad key; DROP TABLE': 'x' }, expected_revision: 0,
  }));
  assert.equal(bad1.status, 400);

  const bad2 = await sessionPATCH(await sessionRequest('a-f27.example.com', cookie, 'PATCH', {
    answers: { ok: 12345 }, expected_revision: 0, // numbers allowed, coerced
  }));
  assert.equal(bad2.status, 200);

  const bad3 = await sessionPATCH(await sessionRequest('a-f27.example.com', cookie, 'PATCH', {
    answers: { nested: { a: 1 } }, expected_revision: 0,
  }));
  assert.equal(bad3.status, 400);
});

/* ── 5. Submit idempotency ─────────────────────────────────────────────── */

test('submit: duplicate submit → one cycle, ONE outbox record, original receipt replayed', async () => {
  const inv = await (await createInvitation('company-b', WEEK2)).json();
  const raw = decodeURIComponent(inv.url.split('ticket=')[1]);
  const ex = await exchangeTicket('b-f27.example.com', raw);
  const cookie = cookieFrom(ex)!;

  await sessionPATCH(await sessionRequest('b-f27.example.com', cookie, 'PATCH', {
    answers: { theme: 'Submit test theme', goal: 'awareness' }, expected_revision: 0,
  }));

  const submitReq = async () => {
    const headers = new Headers();
    headers.set('host', 'b-f27.example.com');
    headers.set('cookie', `${SOCIAL_THEME_COOKIE}=${cookie}; mc_csrf_token=${await csrfCookie()}`);
    headers.set('content-type', 'application/json');
    return new NextRequest('https://b-f27.example.com/api/social-theme/submit', {
      method: 'POST', headers, body: JSON.stringify({ expected_revision: 1 }),
    });
  };

  const first = await submitPOST(await submitReq());
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.already_submitted, false);
  assert.ok(firstBody.receipt.receipt_id);

  const second = await submitPOST(await submitReq());
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.already_submitted, true, 'replay returns the original receipt');
  assert.equal(secondBody.receipt.receipt_id, firstBody.receipt.receipt_id);

  // Exactly ONE outbox dispatch record for the cycle.
  const outbox = outboxForCycle('company-b', inv.cycle_id);
  assert.ok(outbox, 'submit writes the canonical dispatch outbox record');
  const count = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM social_notification_outbox WHERE company_id='company-b' AND dedupe_key=?`,
    [`cycle-submit:${inv.cycle_id}`],
  );
  assert.equal(count!.n, 1);

  // Cycle state flipped to responded.
  const cycle = getCycleByWeek('company-b', WEEK2);
  assert.equal(cycle!.state, 'responded');

  // POST-submit PATCH is immutable.
  const after = await sessionPATCH(await sessionRequest('b-f27.example.com', cookie, 'PATCH', {
    answers: { theme: 'too late' }, expected_revision: 2,
  }));
  assert.equal(after.status, 409);
});

test('submit revision conflict: 409 + server row, nothing lost', async () => {
  const inv = await (await createInvitation('company-a', WEEK1)).json();
  const raw = decodeURIComponent(inv.url.split('ticket=')[1]);
  const cookie = cookieFrom(await exchangeTicket('a-f27.example.com', raw))!;
  const res = await submitPOST(new NextRequest('https://a-f27.example.com/api/social-theme/submit', {
    method: 'POST',
    headers: await (async () => {
      const h = new Headers();
      h.set('host', 'a-f27.example.com');
      h.set('cookie', `${SOCIAL_THEME_COOKIE}=${cookie}; mc_csrf_token=${await csrfCookie()}`);
      h.set('content-type', 'application/json');
      return h;
    })(),
    body: JSON.stringify({ expected_revision: 99 }),
  }));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'revision_conflict');
});

/* ── 6. Skip / pause ───────────────────────────────────────────────────── */

test('skip week1 still invites week2; pause is separate from skip', async () => {
  const invW1 = await (await createInvitation('company-a', WEEK1)).json();
  const rawW1 = decodeURIComponent(invW1.url.split('ticket=')[1]);
  const cookieW1 = cookieFrom(await exchangeTicket('a-f27.example.com', rawW1))!;

  const skipRes = await skipPOST(new NextRequest('https://a-f27.example.com/api/social-theme/skip', {
    method: 'POST',
    headers: await (async () => {
      const h = new Headers();
      h.set('host', 'a-f27.example.com');
      h.set('cookie', `${SOCIAL_THEME_COOKIE}=${cookieW1}; mc_csrf_token=${await csrfCookie()}`);
      return h;
    })(),
  }));
  assert.equal(skipRes.status, 200);

  // Week 1 skipped...
  const cycleW1 = getCycleByWeek('company-a', WEEK1);
  assert.equal(cycleW1!.state, 'skipped');

  // ...week 2 still invitable.
  const invW2 = await createInvitation('company-a', WEEK2);
  assert.equal(invW2.status, 200);

  // Pause is an explicit preference; it never touches cycle rows.
  const pauseRes = await prefsPATCH(new NextRequest('https://a-f27.example.com/api/social-theme/preferences', {
    method: 'PATCH',
    headers: await (async () => {
      const h = new Headers();
      h.set('host', 'a-f27.example.com');
      h.set('cookie', `${SOCIAL_THEME_COOKIE}=${cookieW1}; mc_csrf_token=${await csrfCookie()}`);
      h.set('content-type', 'application/json');
      return h;
    })(),
    body: JSON.stringify({ reminders_paused: true }),
  }));
  assert.equal(pauseRes.status, 200);
  const pauseBody = await pauseRes.json();
  assert.equal(pauseBody.policy.reminders_paused, true);
  const cycleW1After = getCycleByWeek('company-a', WEEK1);
  assert.equal(cycleW1After!.state, 'skipped', 'pause must not mutate cycles');
});

/* ── 7. CSRF / origin gates ────────────────────────────────────────────── */

test('mutating routes refuse cross-origin writes (defense in depth)', async () => {
  const inv = await (await createInvitation('company-b', WEEK1)).json();
  const raw = decodeURIComponent(inv.url.split('ticket=')[1]);
  const cookie = cookieFrom(await exchangeTicket('b-f27.example.com', raw))!;
  const headers = new Headers();
  headers.set('host', 'b-f27.example.com');
  headers.set('cookie', `${SOCIAL_THEME_COOKIE}=${cookie}`);
  headers.set('origin', 'https://evil.example.net');
  headers.set('content-type', 'application/json');
  headers.set('cookie', `${SOCIAL_THEME_COOKIE}=${cookie}; mc_csrf_token=${await csrfCookie()}`);
  const res = await sessionPATCH(new NextRequest('https://b-f27.example.com/api/social-theme/session', {
    method: 'PATCH', headers, body: JSON.stringify({ answers: { theme: 'csrf' }, expected_revision: 0 }),
  }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'cross_origin_forbidden');

  // Missing CSRF cookie → rejected even same-origin (route-level MR-23).
  const noCsrf = await sessionPATCH(new NextRequest('https://b-f27.example.com/api/social-theme/session', {
    method: 'PATCH',
    headers: await (async () => {
      const h = new Headers();
      h.set('host', 'b-f27.example.com');
      h.set('cookie', `${SOCIAL_THEME_COOKIE}=${cookie}`);
      h.set('origin', 'https://b-f27.example.com');
      h.set('content-type', 'application/json');
      return h;
    })(),
    body: JSON.stringify({ answers: { theme: 'csrf2' }, expected_revision: 0 }),
  }));
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error, 'missing_csrf_token');
});

/* ── 8. Rate limiting ──────────────────────────────────────────────────── */

test('exchange rate limit: burst beyond the window cap gets 429', async () => {
  // Fresh company to avoid the earlier bucket.
  seedCompany('company-c');
  const inv = await (await createInvitation('company-c', WEEK1)).json();
  // 20 allowed attempts then 429 — each with a distinct junk ticket (no
  // oracle difference) but the SAME company+ip bucket.
  let sawLimit = false;
  for (let i = 0; i < 25; i++) {
    const res = await exchangeTicket('a-f27.example.com', `junk-${i}`);
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'burst must hit the rate limit');
});

/* ── 9. Operator preferences policy update ─────────────────────────────── */

test('operator can read and update policy (bumps revision)', async () => {
  const get = await prefsGET(new NextRequest(
    'https://operator-f27.example.com/api/social-theme/preferences?company_id=company-b',
    { headers: OPERATOR_HEADERS() },
  ));
  assert.equal(get.status, 200);
  const getBody = await get.json();
  assert.ok(getBody.policy);

  const opHeaders = OPERATOR_HEADERS();
  opHeaders.set('cookie', `mc_csrf_token=${await csrfCookie()}`);
  const patch = await prefsPATCH(jsonRequest(
    'https://operator-f27.example.com/api/social-theme/preferences',
    { company_id: 'company-b', mode: 'ultra', budget_usd: 25 },
    opHeaders,
  ));
  assert.equal(patch.status, 200);
  const patchBody = await patch.json();
  assert.equal(patchBody.policy.mode, 'ultra');
  assert.equal(patchBody.policy.budget_usd, 25);
  assert.ok(patchBody.policy.policy_revision >= 2);
});