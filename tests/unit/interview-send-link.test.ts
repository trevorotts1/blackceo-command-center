import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

// Real routes, real SQLite, real gateway subprocess protocol against ONLY a
// synthetic executable. Neither a live gateway nor a client config is reachable.
const root = process.env.CC_TEST_FIXTURE_ROOT!;
const workspace = path.join(root, 'workspace');
const companyRoot = path.join(root, 'company');
const runtimeRoot = path.join(root, 'runtime');
const scripts = path.join(root, 'scripts');
const bin = path.join(root, 'bin');
const capture = path.join(root, 'synthetic-gateway-input.json');
const owner = '5550001234';
const token = 'fixture-operator-token';
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;
const statePath = path.join(workspace, '.workforce-build-state.json');
const shellReceipt = path.join(workspace, 'company-discovery', '.interview-link-sends.log.receipt.json');
const fresh = () => ({ tenantId: 'send-tenant', companyId: 'send-company', installationId: 'send-install',
  interviewComplete: false, buildType: 'legacy', buildId: 'fixture-build' });
Object.assign(process.env, { OPENCLAW_ROOT: runtimeRoot, OPENCLAW_WORKSPACE_ROOT: workspace,
  OPENCLAW_WORKSPACE_PATH: workspace, OPENCLAW_SKILL23_SCRIPTS: scripts,
  OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:1', MC_API_TOKEN: token,
  MC_COMPANY_ID: 'send-company', MC_INSTALLATION_ID: 'send-install',
  MC_TENANT_PUBLIC_URL: 'https://send.example', OPENCLAW_OWNER_CHAT_ID: owner });
process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({ 'send.example': {
  kind: 'self', tenantId: 'send-tenant', companyId: 'send-company', installationId: 'send-install',
} });
process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON = JSON.stringify({ 'send-company': {
  companyRoot, companyConfig: path.join(companyRoot, 'company-config.json'),
  companySlug: 'send-company', personaCatalog: path.join(companyRoot, 'catalog.json'),
} });
let db: typeof import('../../src/lib/db');
let POST: typeof import('../../src/app/api/interview/send-link/route')['POST'];
function req(body?: unknown, bearer: string | null = token, host = 'send.example') {
  return new NextRequest('http://127.0.0.1:4000/api/interview/send-link', { method: 'POST',
    headers: { host, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function stub(behavior = 'accept') {
  fs.writeFileSync(path.join(bin, 'openclaw'), `#!${process.execPath}\n` +
    `const fs=require('fs');const a=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(a));` +
    `fs.writeFileSync(${JSON.stringify(path.join(root, 'pre-dispatch-receipt.json'))},fs.readFileSync(${JSON.stringify(shellReceipt)}));` +
    (behavior === 'mirror-race' ? `fs.writeFileSync(${JSON.stringify(shellReceipt)},JSON.stringify({status:'sending',deliveryId:'another-attempt',companyId:'foreign'}));` : '') +
    (behavior === 'error' ? `process.stderr.write('synthetic failure '+a.join(' '));process.exit(1);` :
      `console.log(JSON.stringify({ok:true,payload:{messageId:'fixture-msg',chatId:${JSON.stringify(behavior === 'foreign' ? '5559999999' : owner)},channel:'telegram'}}));`),
    { mode: 0o700 });
}
function ledger() {
  return db.queryAll<{ metadata: string; message: string }>("SELECT metadata,message FROM events WHERE type='interview_link_delivery'");
}
function sentMessage() {
  const args: string[] = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(args[args.indexOf('--target') + 1], owner);
  return args[args.indexOf('--message') + 1];
}
test.before(async () => {
  for (const dir of [workspace, companyRoot, scripts, bin, path.join(runtimeRoot, 'agents/main/agent')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(companyRoot, 'company-config.json'), JSON.stringify({ companyId: 'send-company', companySlug: 'send-company' }));
  fs.writeFileSync(path.join(companyRoot, 'catalog.json'), JSON.stringify({ personas: { canonical: { name: 'Canonical Fixture' } } }));
  for (const file of ['update-interview-state.sh', 'record-dept-decision.sh', 'list-canonical-departments.py']) fs.writeFileSync(path.join(scripts, file), '# fixture\n');
  fs.writeFileSync(path.join(runtimeRoot, 'openclaw.json'), JSON.stringify({ agents: { entries: { main: { workspace, model: 'fixture/model' } } } }));
  globalThis.fetch = async () => { throw new Error('No network allowed'); };
  db = await import('../../src/lib/db'); db.getDb();
  db.run("INSERT INTO companies(id,name,slug) VALUES('send-company','Send Fixture','send-company')");
  db.run("INSERT INTO workspaces(id,name,slug,company_id) VALUES('send-ws','General Task','general-task','send-company')");
  ({ POST } = await import('../../src/app/api/interview/send-link/route'));
});
test.beforeEach(() => {
  db.run("DELETE FROM events WHERE type IN ('interview_link_delivery','interview_link_sent')");
  fs.writeFileSync(statePath, JSON.stringify(fresh()));
  fs.rmSync(capture, { force: true });
  fs.rmSync(shellReceipt, { force: true }); stub();
  process.env.PATH = bin; // real OpenClaw is impossible to execute
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  process.env.MC_API_TOKEN = token;
  process.env.MC_TENANT_PUBLIC_URL = 'https://send.example';
  process.env.OPENCLAW_OWNER_CHAT_ID = owner;
});
test.after(() => { process.env.PATH = originalPath; globalThis.fetch = originalFetch; db.closeDb(); });

test('operator auth remains mandatory with no token, wrong token, or unknown host', async () => {
  for (const request of [req(undefined, null), req(undefined, 'wrong'), req(undefined, token, 'foreign.example')]) {
    assert.equal((await POST(request)).status, 403);
  }
  delete process.env.MC_API_TOKEN;
  assert.equal((await POST(req())).status, 403);
  assert.equal(ledger().length, 0); assert.equal(fs.existsSync(capture), false);
});
test('fresh owner without Access gets a private 24-hour grant for configured public host; no ticket in response or ledger', async () => {
  const response = await POST(req());
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.mode, 'start'); assert.equal(body.bookmark, 'https://send.example/interview');
  const message = sentMessage();
  const url = new URL(message.match(/https:\/\/send\.example\/interview#enroll=\S+/)![0]);
  const ticket = decodeURIComponent(url.hash.slice('#enroll='.length));
  const { verifyTenantGrant } = await import('../../src/lib/auth/tenant-context');
  const grant = await verifyTenantGrant(ticket, 'send.example', 'enrollment');
  assert.equal(grant?.companyId, 'send-company');
  assert.ok(grant!.exp - Date.now() / 1000 > 86390);
  assert.match(message, /bookmark.*while you are signed in/);
  assert.ok(!JSON.stringify(body).includes(ticket));
  assert.ok(!JSON.stringify(ledger()).includes(ticket));
  assert.equal(JSON.parse(ledger()[0].metadata).status, 'accepted');
  const mirrored = JSON.parse(fs.readFileSync(shellReceipt, 'utf8'));
  assert.equal(mirrored.status, 'accepted');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'pre-dispatch-receipt.json'), 'utf8')).status, 'sending', 'shell fence was durable before gateway started');
  assert.equal(mirrored.messageId, 'fixture-msg', 'actual matched gateway acknowledgement');
  assert.equal(mirrored.invitationExpiresAt, body.expiresAt);
  assert.ok(!JSON.stringify(mirrored).includes(ticket));
  assert.equal(await verifyTenantGrant(ticket, 'foreign.example', 'enrollment'), null);
  const { POST: redeem } = await import('../../src/app/api/auth/interview-session/route');
  const enrollment = () => new NextRequest('https://send.example/api/auth/interview-session', {
    method: 'POST', headers: { host: 'send.example', 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  const entered = await redeem(enrollment());
  assert.equal(entered.status, 200, 'owner without Access can exchange delivered ticket');
  assert.match(entered.headers.get('set-cookie')!, /HttpOnly/i);
  assert.equal((await redeem(enrollment())).status, 409, 'one-use protection remains intact');
});
test('saved interview receives fresh enrollment with resume copy without resetting answers', async () => {
  const saved = { ...fresh(), buildCompletedAt: '2026-01-01', interviewSessionId: 'saved-session', interviewProgress: { lastQuestionNumber: 4 }, answers: { q1: 'Saved answer' } };
  fs.writeFileSync(statePath, JSON.stringify(saved)); const before = fs.readFileSync(statePath, 'utf8');
  const response = await POST(req()); assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'resume');
  assert.match(sentMessage(), /saved answers.*Continue your interview/);
  assert.match(sentMessage(), /#enroll=/); assert.ok(!sentMessage().includes('/onboarding/resume/'));
  assert.equal(fs.readFileSync(statePath, 'utf8'), before);
});
test('completed, foreign state, and unverified public origins never send', async () => {
  fs.writeFileSync(statePath, JSON.stringify({ ...fresh(), interviewComplete: true }));
  assert.equal((await POST(req())).status, 409);
  fs.writeFileSync(statePath, JSON.stringify({ ...fresh(), companyId: 'foreign' }));
  assert.equal((await POST(req())).status, 409);
  fs.writeFileSync(statePath, JSON.stringify(fresh())); process.env.MC_TENANT_PUBLIC_URL = 'https://foreign.example';
  assert.equal((await POST(req())).status, 409); assert.equal(fs.existsSync(capture), false);
});
test('concurrent triggers reserve once; confirmed cooldown needs explicit force', async () => {
  const responses = await Promise.all([POST(req()), POST(req())]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]); assert.equal(ledger().length, 1);
  const blocked = await POST(req()); assert.equal((await blocked.json()).error, 'cooldown');
  assert.equal((await POST(req({ force: true }))).status, 200); assert.equal(ledger().length, 2);
});
test('uncertain gateway error is redacted and never force-retried', async () => {
  stub('error'); const errors: unknown[][] = []; const savedError = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    const response = await POST(req()); assert.equal(response.status, 502);
    assert.equal((await response.json()).error, 'delivery_uncertain');
    assert.equal((await (await POST(req({ force: true }))).json()).error, 'delivery_uncertain');
    assert.equal(ledger().length, 1); assert.deepEqual(errors, []);
    const mirrored = JSON.parse(fs.readFileSync(shellReceipt, 'utf8'));
    assert.equal(mirrored.status, 'uncertain');
    assert.equal(mirrored.companyId, 'send-company');
    assert.equal(mirrored.recipientHash, createHash('sha256').update(owner).digest('hex'));
    assert.ok(!JSON.stringify(mirrored).includes('#enroll='));
    assert.equal(fs.statSync(shellReceipt).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(ledger()).includes('#enroll='));
  } finally { console.error = savedError; }
});
test('foreign acknowledgement stays uncertain and test suppression never dispatches', async () => {
  stub('foreign'); assert.equal((await (await POST(req())).json()).error, 'delivery_uncertain');
  db.run("DELETE FROM events WHERE type='interview_link_delivery'"); fs.rmSync(capture); fs.rmSync(shellReceipt);
  process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
  assert.equal((await POST(req())).status, 502); assert.equal(fs.existsSync(capture), false);
  assert.equal(JSON.parse(ledger()[0].metadata).status, 'not-dispatched');
});

test('owner change after binding refuses the private send without logging or escalation', async () => {
  const { notifyOwnerPrivate } = await import('../../src/lib/notify');
  process.env.OPENCLAW_OWNER_CHAT_ID = '5550005678';
  assert.deepEqual(await notifyOwnerPrivate({ companyId: 'send-company', expectedChatId: owner,
    message: 'synthetic-private-ticket' }), { status: 'not-dispatched' });
  assert.equal(fs.existsSync(capture), false);
});

function writeShellReceipt(overrides: Record<string, unknown> = {}) {
  fs.mkdirSync(path.dirname(shellReceipt), { recursive: true });
  fs.writeFileSync(shellReceipt, JSON.stringify({ companyId: 'send-company', tenantId: 'send-tenant',
    installationId: 'send-install', origin: 'https://send.example',
    recipientHash: createHash('sha256').update(owner).digest('hex'),
    status: 'accepted', messageId: 'fixture-shell-message', epoch: Math.floor(Date.now() / 1000),
    invitationExpiresAt: Math.floor(Date.now() / 1000) + 86400, ...overrides,
  }));
}
test('shell sending and uncertain receipts block even forced requests before mint or delivery', async () => {
  for (const status of ['sending', 'uncertain']) {
    writeShellReceipt({ status });
    for (const force of [false, true]) {
      const response = await POST(req({ force }));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'delivery_uncertain');
      assert.equal(ledger().length, 0); assert.equal(fs.existsSync(capture), false);
    }
  }
});
test('foreign, wrong-recipient and malformed shell receipts fail closed without disclosure', async () => {
  for (const field of ['companyId', 'tenantId', 'installationId', 'origin', 'recipientHash', 'status']) {
    writeShellReceipt({ [field]: 'foreign-fixture-value' });
    const response = await POST(req({ force: true }));
    assert.equal(response.status, 409);
    const text = await response.text(); assert.match(text, /delivery_receipt_unverified/);
    assert.ok(!text.includes('foreign-fixture-value'));
  }
  for (const data of ['{', 'null', '[]', '{}']) {
    fs.writeFileSync(shellReceipt, data);
    assert.equal((await POST(req({ force: true }))).status, 409);
  }
  writeShellReceipt({ epoch: 'bad-time' });
  assert.equal((await POST(req({ force: true }))).status, 409);
  assert.equal(ledger().length, 0); assert.equal(fs.existsSync(capture), false);
});
test('recent accepted shell receipt shares cooldown while deliberate or expired renewal remains usable', async () => {
  writeShellReceipt();
  assert.equal((await (await POST(req())).json()).error, 'cooldown');
  assert.equal(ledger().length, 0);
  assert.equal((await POST(req({ force: true }))).status, 200);
  db.run("DELETE FROM events WHERE type='interview_link_delivery'");
  writeShellReceipt({ invitationExpiresAt: Math.floor(Date.now() / 1000) - 1 });
  assert.equal((await POST(req())).status, 200);
});

test('changed receipt after gateway acknowledgement is preserved and DB reservation stays pending', async () => {
  stub('mirror-race');
  const response = await POST(req());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'delivery_uncertain');
  assert.equal(JSON.parse(ledger()[0].metadata).status, 'pending');
  assert.deepEqual(JSON.parse(fs.readFileSync(shellReceipt, 'utf8')),
    { status: 'sending', deliveryId: 'another-attempt', companyId: 'foreign' });
  assert.equal((await POST(req({ force: true }))).status, 409);
});
