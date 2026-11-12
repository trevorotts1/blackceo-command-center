/**
 * Chat approvals: the owner's yes from Telegram / the chat app.
 *
 * Builds a REAL-SHAPED gateway state database (the plugin_state_entries table and
 * the telegram.message-cache key/value shape read from an OpenClaw 2026.11
 * gateway) and drives the REAL route handler. Command Center must mint only from
 * a message it finds there itself.
 */
import './_isolated-db';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';

const HOST = 'cc.chat.test';
const TOKEN = 'agent-token-for-chat-test';
const OWNER_CHAT = '7000000001';
const BOT_ID = 8323980632;
const PLAN = 'cd34ef56'.padEnd(64, 'a');
const LOCATION = 'loc_CHAT1';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gw-state-'));
const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gw-agents-'));
let msgSeq = 1000;

function openState() {
  return new Database(path.join(stateDir, 'openclaw.sqlite'));
}

function seedStore() {
  const db = openState();
  db.exec(`CREATE TABLE IF NOT EXISTS plugin_state_entries (
    plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, entry_key TEXT NOT NULL, value_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER, PRIMARY KEY (plugin_id, namespace, entry_key)) STRICT`);
  db.close();
}

interface Msg { chat?: string; from?: number; isBot?: boolean; atMs?: number; text: string; replyTo?: { id: number; fromBot: boolean; text: string } }
/** Writes one row exactly as the gateway's telegram.message-cache does; returns the message id. */
function cacheMessage(m: Msg): string {
  const id = ++msgSeq;
  const chat = m.chat ?? OWNER_CHAT;
  const from = m.from ?? Number(OWNER_CHAT);
  const atMs = m.atMs ?? Date.now() + 2000;
  const value = {
    version: 1,
    sourceMessage: {
      message_id: id, from: { id: from, is_bot: m.isBot ?? false, first_name: 'X' }, chat: { id: Number(chat) },
      date: Math.floor(atMs / 1000), text: m.text,
      ...(m.replyTo ? { reply_to_message: { message_id: m.replyTo.id, from: { id: BOT_ID, is_bot: m.replyTo.fromBot }, chat: { id: Number(chat) }, date: Math.floor(atMs / 1000) - 5, text: m.replyTo.text } } : {}),
    },
    botUserId: BOT_ID, historyEligible: true,
  };
  const db = openState();
  db.prepare('INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at) VALUES (?,?,?,?,?)')
    .run('telegram', 'telegram.message-cache', `57ad8c4952559d1f2c03854b:default:${chat}:${id}`, JSON.stringify(value), atMs);
  db.close();
  return String(id);
}

function req(url: string, init: { bearer?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { host: HOST, 'content-type': 'application/json' };
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return new NextRequest(`http://${HOST}${url}`, {
    method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const createBody = (over: Record<string, unknown> = {}) => ({
  kind: 'publish', location_id: LOCATION, action: 'publish', object_key: 'social:chat-' + Math.random(),
  plan_sha256: PLAN, title: 'Social plan', summary: 'Seven posts.', requested_by: 'agent', ...over,
});
async function create(over: Record<string, unknown> = {}) {
  const { POST } = await import('../../src/app/api/approval-requests/route');
  const res = await POST(req('/api/approval-requests', { method: 'POST', bearer: TOKEN, body: createBody(over) }));
  return (await res.json()) as { request_id: string; short_code: string; approve_by: string[] };
}
async function chat(id: string, body: unknown, bearer: string | undefined = TOKEN) {
  const { POST } = await import('../../src/app/api/approval-requests/[requestId]/chat-decision/route');
  const res = await POST(req(`/api/approval-requests/${id}/chat-decision`, { method: 'POST', bearer, body }), { params: Promise.resolve({ requestId: id }) } as never);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
async function fetchRequest(id: string) {
  const { GET } = await import('../../src/app/api/approval-requests/[requestId]/route');
  return (await GET(req(`/api/approval-requests/${id}`, { bearer: TOKEN }), { params: Promise.resolve({ requestId: id }) } as never)).json();
}
const tg = (decision: 'approve' | 'changes', mid: string, chatId = OWNER_CHAT) =>
  ({ decision, channel: 'telegram', source_message_ref: `telegram:${chatId}:${mid}` });
const approvals = () => (getDb().prepare('SELECT COUNT(*) n FROM launch_approvals').get() as { n: number }).n;
/** Clear pending requests so "the only pending request" is controllable per test. */
const clearPending = () => getDb().prepare(`UPDATE approval_requests SET status='changes_requested' WHERE status='pending'`).run();

beforeAll(() => {
  process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
    [HOST]: { tenantId: 'tenant-c', companyId: 'default', kind: 'self', installationId: 'install-c', subjects: ['owner@client.test'] },
  });
  process.env.MC_TENANT_SESSION_SECRET = 'chat-test-session-secret';
  process.env.MC_API_TOKEN = TOKEN;
  process.env.OPENCLAW_OWNER_CHAT_ID = OWNER_CHAT;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_AGENTS_DIR = agentsDir;
  getDb();
  seedStore();
});
beforeEach(() => { clearPending(); });

describe('request shape', () => {
  it('exposes short_code and approve_by on create and on GET', async () => {
    const made = await create();
    expect(made.short_code).toBe(made.request_id.slice(0, 6));
    expect(made.approve_by).toEqual(['command_center', 'telegram', 'chat_app']);
    expect(await fetchRequest(made.request_id)).toMatchObject({ short_code: made.short_code, approve_by: ['command_center', 'telegram', 'chat_app'] });
  });
});

describe('Telegram approval from the gateway record', () => {
  it('mints from a real-shaped owner message and records the chat approver and message ref', async () => {
    const made = await create();
    const mid = cacheMessage({ text: 'Approve it' });
    const before = approvals();
    const out = await chat(made.request_id, tg('approve', mid));
    expect(out.status).toBe(200);
    expect(out.json.status).toBe('approved');
    expect(out.json.approval_id).toBeTruthy();
    expect(approvals()).toBe(before + 1);
    const { GET } = await import('../../src/app/api/launch-approvals/[approvalId]/route');
    const rec = await (await GET(req(`/api/launch-approvals/${out.json.approval_id}`, { bearer: TOKEN }), { params: Promise.resolve({ approvalId: out.json.approval_id }) } as never)).json();
    expect(rec).toMatchObject({
      verification_class: 'authenticated_platform_record', approver: `telegram:${OWNER_CHAT}`,
      kind: 'publish', location_id: LOCATION, action: 'publish', plan_sha256: PLAN, request_id: made.request_id, revoked: false, active: true,
    });
    expect(rec.source_message_ref).toBe(`approval-request:${made.request_id}:chat:telegram:${OWNER_CHAT}:${mid}`);
  });

  it('is idempotent: the same message again returns the same approval_id and mints nothing new', async () => {
    const made = await create();
    const mid = cacheMessage({ text: 'yes' });
    const a = await chat(made.request_id, tg('approve', mid));
    const n = approvals();
    const b = await chat(made.request_id, tg('approve', mid));
    expect(b.status).toBe(200);
    expect(b.json.approval_id).toBe(a.json.approval_id);
    expect(approvals()).toBe(n);
  });

  it('refuses a bot-authored message and mints nothing', async () => {
    const made = await create();
    const mid = cacheMessage({ text: 'Approved', from: BOT_ID, isBot: true });
    const before = approvals();
    const out = await chat(made.request_id, tg('approve', mid));
    expect([403, 409]).toContain(out.status);
    expect(out.json.error).toBe('not_from_owner');
    expect(approvals()).toBe(before);
    const bot2 = cacheMessage({ text: 'Approved', isBot: true });
    expect((await chat(made.request_id, tg('approve', bot2))).json.error).toBe('sender_is_bot');
  });

  it('refuses a message from a different chat id (wrong owner) even if the agent names it', async () => {
    const made = await create();
    const mid = cacheMessage({ text: 'approve', chat: '999000111', from: 999000111 });
    const out = await chat(made.request_id, tg('approve', mid, '999000111'));
    expect(out.status).toBe(403);
    expect(out.json.error).toBe('not_from_owner');
    expect(approvals()).toBeGreaterThanOrEqual(0);
    expect((await fetchRequest(made.request_id)).status).toBe('pending');
  });

  it('refuses a message that does not exist in the gateway record (agent hallucinated a ref)', async () => {
    const made = await create();
    const out = await chat(made.request_id, tg('approve', '424242'));
    expect(out.status).toBe(403);
    expect(out.json.error).toBe('message_not_found');
    expect((await fetchRequest(made.request_id)).approval_id).toBeNull();
  });

  it('refuses a message sent before the request was created', async () => {
    const mid = cacheMessage({ text: 'yes', atMs: Date.now() - 3_600_000 });
    const made = await create();
    const out = await chat(made.request_id, tg('approve', mid));
    expect(out.status).toBe(403);
    expect(out.json.error).toBe('message_before_request');
    expect((await fetchRequest(made.request_id)).status).toBe('pending');
  });

  it('does not treat "no" as approval, and a claimed decision must match the words', async () => {
    const made = await create();
    const no = cacheMessage({ text: 'no' });
    const asApprove = await chat(made.request_id, tg('approve', no));
    expect(asApprove.status).toBe(409);
    expect(asApprove.json.error).toBe('text_does_not_match_decision');
    const dont = cacheMessage({ text: "don't do it yet" });
    expect((await chat(made.request_id, tg('approve', dont))).json.error).toBe('text_not_a_decision');
    const chatty = cacheMessage({ text: 'yes but change the second post' });
    expect((await chat(made.request_id, tg('approve', chatty))).status).toBe(409);
    expect((await fetchRequest(made.request_id)).status).toBe('pending');
  });

  it('turns a change request into changes_requested with the owner words as the note', async () => {
    const made = await create();
    const mid = cacheMessage({ text: 'Please change the Tuesday post' });
    const out = await chat(made.request_id, { ...tg('changes', mid) });
    expect(out.status).toBe(200);
    expect(out.json.status).toBe('changes_requested');
    expect(out.json.decision_note).toContain('Tuesday');
    expect(out.json.approval_id).toBeNull();
  });

  it('refuses an ambiguous yes when several requests are pending, accepts it with the code or a reply', async () => {
    const a = await create();
    const b = await create();
    const yes = cacheMessage({ text: 'yes' });
    const amb = await chat(a.request_id, tg('approve', yes));
    expect(amb.status).toBe(409);
    expect(amb.json.error).toBe('ambiguous_request');
    expect(amb.json.detail).toContain('2 approvals');
    const withCode = cacheMessage({ text: `approve ${b.short_code.toUpperCase()}` });
    expect((await chat(b.request_id, tg('approve', withCode))).status).toBe(200);
    // a message carrying B's code cannot approve A
    const wrong = await chat(a.request_id, tg('approve', withCode));
    expect(wrong.status).toBe(409);
    const reply = cacheMessage({ text: 'ok', replyTo: { id: 7, fromBot: true, text: `Approve the plan?\nCode: ${a.short_code}` } });
    expect((await chat(a.request_id, tg('approve', reply))).status).toBe(200);
  });

  it('refuses a reply to an approval message that carries a different request code', async () => {
    const a = await create();
    await create();
    const reply = cacheMessage({ text: 'ok', replyTo: { id: 8, fromBot: true, text: 'Approve?\nCode: 123abc' } });
    const out = await chat(a.request_id, tg('approve', reply));
    expect(out.status).toBe(409);
    expect(out.json.error).toBe('message_for_other_request');
  });

  it('accepts an inline-button callback naming the full request id, and refuses one naming another id', async () => {
    const a = await create();
    const b = await create();
    const cb = cacheMessage({ text: `callback_data: apr:${a.request_id}:approve` });
    expect((await chat(b.request_id, tg('approve', cb))).json.error).toBe('message_for_other_request');
    expect((await chat(a.request_id, tg('approve', cb))).status).toBe(200);
  });

  it('one message cannot answer two requests', async () => {
    const a = await create();
    const mid = cacheMessage({ text: 'yes' });
    expect((await chat(a.request_id, tg('approve', mid))).status).toBe(200);
    const b = await create();
    const out = await chat(b.request_id, tg('approve', mid));
    expect(out.status).toBe(409);
    expect(out.json.error).toBe('message_already_used');
  });
});

describe('the agent token cannot mint without a verifiable message', () => {
  it('refuses with no gateway store at all', async () => {
    const made = await create();
    const prior = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), 'cc-no-such-state-dir');
    const before = approvals();
    const out = await chat(made.request_id, tg('approve', '1'));
    process.env.OPENCLAW_STATE_DIR = prior;
    expect(out.status).toBe(403);
    expect(out.json.error).toBe('inbound_record_unavailable');
    expect(approvals()).toBe(before);
  });

  it('refuses a missing/garbage ref, an unknown field, no bearer, and the old web-only fields', async () => {
    const made = await create();
    expect((await chat(made.request_id, { decision: 'approve', channel: 'telegram' })).status).toBe(400);
    expect((await chat(made.request_id, { ...tg('approve', '1'), approval_id: 'x' })).status).toBe(400);
    expect((await chat(made.request_id, { decision: 'approve', channel: 'telegram', source_message_ref: 'webchat:a:b' })).status).toBe(400);
    expect((await chat(made.request_id, tg('approve', '1'), undefined)).status).toBe(403);
    expect((await chat('00000000-0000-4000-8000-000000000000', tg('approve', '1'))).status).toBe(404);
  });
});

describe('webchat', () => {
  function transcript(session: string, entries: object[]) {
    const dir = path.join(agentsDir, 'main', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  const wc = (decision: 'approve' | 'changes', session: string, mid: string) =>
    ({ decision, channel: 'webchat', source_message_ref: `webchat:${session}:${mid}` });

  it('mints from a user turn in the owner session transcript and refuses an assistant turn', async () => {
    const made = await create();
    const t = new Date().toISOString();
    transcript('sess-owner-1', [
      { type: 'message', id: 'u1abc123', timestamp: t, message: { role: 'user', content: [{ type: 'text', text: 'looks good, approve' }] } },
      { type: 'message', id: 'a1abc123', timestamp: t, message: { role: 'assistant', content: [{ type: 'text', text: 'approve' }] } },
    ]);
    expect((await chat(made.request_id, wc('approve', 'sess-owner-1', 'a1abc123'))).json.error).toBe('sender_is_bot');
    const ok = await chat(made.request_id, wc('approve', 'sess-owner-1', 'u1abc123'));
    expect(ok.status).toBe(200);
    expect(ok.json.approval_id).toBeTruthy();
    const row = getDb().prepare('SELECT client_identity_ref r FROM launch_approvals WHERE approval_id = ?').get(ok.json.approval_id) as { r: string };
    expect(row.r).toBe('webchat:sess-owner-1');
  });

  it('refuses a path-traversing session id and a turn routed in from another channel', async () => {
    const made = await create();
    expect((await chat(made.request_id, wc('approve', '../../etc/passwd', 'x'))).status).toBe(400);
    transcript('sess-owner-2', [
      { type: 'message', id: 'u2abc123', timestamp: new Date().toISOString(), channel: 'telegram', message: { role: 'user', content: 'yes' } },
    ]);
    expect((await chat(made.request_id, wc('approve', 'sess-owner-2', 'u2abc123'))).status).toBe(403);
  });
});
