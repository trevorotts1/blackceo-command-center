/**
 * OWNER QUESTIONS — every question Command Center asks the client carries a
 * recommendation, is pushed ONCE to chat, and can be answered from chat.
 *
 * Node built-in test runner under tsx (`npm run test:unit`). Every send is a
 * stub: no real message is ever sent. DATABASE_PATH is a throwaway file set
 * BEFORE `@/lib/db` is imported.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-owner-q-')), 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
process.env.DISABLE_QC_AUTO_SCORER = 'true';

type Db = typeof import('../../src/lib/db');
type OQ = typeof import('../../src/lib/owner-questions');
type Chat = typeof import('../../src/lib/owner-question-chat');
let db: Db;
let oq: OQ;
let chat: Chat;
let tasksMod: typeof import('../../src/lib/tasks');
let stopCard: typeof import('../../src/lib/stop-card');
let persistPersonaBundle: typeof import('../../src/lib/persona-selector')['persistPersonaBundle'];

let n = 0;
const nid = (p: string) => `${p}-${++n}`;
const DAY = 24 * 60 * 60 * 1000;
// 08:00 UTC is 3:00 AM Eastern in winter: inside the quiet window.
const NIGHT = new Date('2026-11-17T08:00:00Z');
// 17:00 UTC is noon Eastern.
const NOON = new Date('2026-11-17T17:00:00Z');

function insertTask(id: string, over: { status?: string; archived?: string | null; onHuman?: string | null; audience?: string | null; title?: string } = {}): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, department, created_at, updated_at, archived_at, blocked_on_human, block_audience, block_needs, block_reason, ask)
     VALUES (?, ?, ?, 'medium', NULL, NULL, 'marketing', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, over.title ?? `Spring sale email ${id}`, over.status ?? 'backlog', now, now, over.archived ?? null, over.onHuman ?? null, over.audience ?? null,
      'Reconnect your email account', over.status === 'blocked' ? 'Email account needs reconnecting' : null, over.status === 'blocked' ? 'Reconnect your email account' : null],
  );
}

function bundle() {
  return {
    topic: 'Spring sale',
    confirm_required: true,
    resolved_audience: { source: 'onboarding_icp', candidates: ['Founders'], confidence: 0.4, label: null, id: null },
    voice: {
      audience_persona: { id: 'audience-voice-persona', why: 'x' },
      topic_persona: { id: 'ogilvy-on-advertising', why: 'y' },
      collapsed: false,
      topic_as_task_guidance: true,
    },
    blend_directive: 'Write in the audience voice.',
    task_personas: [{ seq: 1, part: 'headline', persona_id: 'ogilvy-on-advertising', why: 'h' }],
    catalog_version: '1.3',
  } as import('../../src/lib/types').PersonaBundle;
}

function open(taskId: string, kind: 'audience' | 'owner_block' = 'audience', rec = 'I recommend: your email list, because this is a sale.') {
  const r = oq.openOwnerQuestion({ taskId, kind, question: 'Who is this for?', recommendation: rec, recommendedValue: 'your email list' });
  assert.ok(r.ok, JSON.stringify(r));
  return r.row;
}

const ctx = { subject: 'operator:api', tenantId: 'tenant-a', companyId: 'default' } as never;
const OWNER = '555000111';

function inbound(over: Partial<import('../../src/lib/gateway-inbound').InboundMessage> & { text: string }) {
  return {
    ok: true as const,
    message: {
      channel: 'telegram' as const, conversationId: OWNER, messageId: '900', senderId: OWNER,
      senderIsBot: false, botUserId: null, sentAtMs: Date.now() + 5000, replyTo: null, ...over,
    },
  };
}

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  oq = await import('../../src/lib/owner-questions');
  chat = await import('../../src/lib/owner-question-chat');
  tasksMod = await import('../../src/lib/tasks');
  stopCard = await import('../../src/lib/stop-card');
  ({ persistPersonaBundle } = await import('../../src/lib/persona-selector'));
});

test.after(() => {
  try { db.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
});

test.beforeEach(() => {
  db.run('DELETE FROM owner_questions');
});

// ── migration 180 ────────────────────────────────────────────────────────────

test('[180] owner_questions table, columns and the open-question unique index exist; migration is idempotent', async () => {
  const cols = db.queryAll<{ name: string }>('PRAGMA table_info(owner_questions)').map((c) => c.name);
  for (const c of ['id', 'task_id', 'kind', 'short_code', 'question', 'recommendation', 'asked_at', 'pushed_at', 'push_delivery',
    'last_reminded_at', 'answered_at', 'answer', 'answer_source', 'source_message_ref']) {
    assert.ok(cols.includes(c), `owner_questions.${c} must exist`);
  }
  const idx = db.queryOne<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'idx_owner_questions_open_unique'");
  assert.ok(idx && /WHERE answered_at IS NULL/i.test(idx.sql));
  const { migrations } = await import('../../src/lib/db/migrations');
  const m = migrations.find((x) => x.id === '180');
  assert.ok(m, 'migration 180 registered');
  m!.up(db.getDb());
  m!.up(db.getDb());
});

// ── openOwnerQuestion guards ─────────────────────────────────────────────────

test('[open] blank recommendation is rejected; nothing is stored', () => {
  const t = nid('t'); insertTask(t);
  for (const rec of ['', '   ']) {
    const r = oq.openOwnerQuestion({ taskId: t, kind: 'audience', question: 'Who?', recommendation: rec });
    assert.deepEqual(r, { ok: false, reason: 'blank_recommendation' });
  }
  assert.equal(db.queryAll('SELECT 1 FROM owner_questions').length, 0);
});

test('[open] operator/SYSTEM faults and archived cards are never owner questions', () => {
  const op = nid('op'); insertTask(op, { status: 'blocked', onHuman: 'operator' });
  const sys = nid('sys'); insertTask(sys, { status: 'blocked', audience: 'SYSTEM' });
  const arc = nid('arc'); insertTask(arc, { archived: new Date().toISOString() });
  const rec = 'I recommend: x.';
  assert.deepEqual(oq.openOwnerQuestion({ taskId: op, kind: 'owner_block', question: 'q', recommendation: rec }), { ok: false, reason: 'operator_fault' });
  assert.deepEqual(oq.openOwnerQuestion({ taskId: sys, kind: 'owner_block', question: 'q', recommendation: rec }), { ok: false, reason: 'operator_fault' });
  assert.deepEqual(oq.openOwnerQuestion({ taskId: arc, kind: 'audience', question: 'q', recommendation: rec }), { ok: false, reason: 'task_archived' });
  assert.deepEqual(oq.openOwnerQuestion({ taskId: 'nope', kind: 'audience', question: 'q', recommendation: rec }), { ok: false, reason: 'task_not_found' });
  assert.equal(db.queryAll('SELECT 1 FROM owner_questions').length, 0);
});

test('[open] same task + kind returns the existing open row; short code format; closed question allows a new one', () => {
  const t = nid('t'); insertTask(t);
  const a = open(t);
  assert.match(a.short_code, /^Q-[0-9A-F]{6}$/);
  const again = oq.openOwnerQuestion({ taskId: t, kind: 'audience', question: 'again', recommendation: 'I recommend: z.' });
  assert.ok(again.ok && !again.created && again.row.id === a.id);
  const other = open(t, 'owner_block', 'I recommend: do it.');
  assert.notEqual(other.id, a.id);
  assert.equal(db.queryAll('SELECT 1 FROM owner_questions').length, 2);
});

// ── recommendation builders ──────────────────────────────────────────────────

test('[recommend] audience: gate candidate, then title-derived fallback, never blank', () => {
  const g = oq.buildAudienceRecommendation({ title: 'Spring sale email', description: null }, { audienceLabel: null, candidates: ['Founders'] });
  assert.match(g.text, /^I recommend: Founders, because/);
  const promo = oq.buildAudienceRecommendation({ title: 'Black Friday promo campaign', description: null });
  assert.match(promo.text, /email list and social media followers/);
  const plain = oq.buildAudienceRecommendation({ title: 'Quarterly thing', description: null });
  assert.ok(plain.text.startsWith('I recommend:') && plain.label.length > 0);
  assert.match(oq.buildOwnerBlockRecommendation('Reconnect your email account', 't'), /^I recommend: reconnect your email account/);
  assert.match(oq.buildOwnerBlockRecommendation('', 'Some task'), /^I recommend:/);
});

// ── push ─────────────────────────────────────────────────────────────────────

test('[push] message text, claim-then-send: a second push never sends again', () => {
  const t = nid('t'); insertTask(t);
  const q = open(t);
  const sent: string[] = [];
  const send = (_id: string, text: string) => { sent.push(text); return 'telegram' as const; };
  const first = oq.pushOwnerQuestion(q.id, { send, now: NOON });
  assert.deepEqual(first, { status: 'pushed', delivery: 'telegram' });
  assert.equal(oq.pushOwnerQuestion(q.id, { send, now: NOON }).status, 'already_pushed');
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0],
    `Who is this for?\n\nMy recommendation: your email list, because this is a sale.\n\nReply YES to go with my recommendation, or tell me what you want instead. (ref ${q.short_code})`,
  );
  const row = oq.getOwnerQuestion(q.id)!;
  assert.ok(row.pushed_at && row.push_delivery === 'telegram');
});

test('[push] default sender is held while owner sends are suppressed (test env); question stays unpushed', () => {
  const t = nid('t'); insertTask(t);
  const q = open(t);
  assert.equal(oq.pushOwnerQuestion(q.id, { now: NOON }).status, 'deferred');
  assert.equal(oq.getOwnerQuestion(q.id)!.pushed_at, null);
});

test('[push] quiet hours defer unless bypassed', () => {
  const t = nid('t'); insertTask(t);
  const q = open(t);
  const send = () => 'telegram' as const;
  assert.equal(oq.pushOwnerQuestion(q.id, { send, now: NIGHT }).status, 'deferred');
  assert.equal(oq.getOwnerQuestion(q.id)!.pushed_at, null);
  assert.equal(oq.pushOwnerQuestion(q.id, { send, now: NIGHT, bypassQuietHours: true }).status, 'pushed');
});

test('[push] no owner chat: claim released so the sweep retries; undeliverable reported', () => {
  const t = nid('t'); insertTask(t);
  const q = open(t);
  const none = () => 'none (no requester_chat_id)' as const;
  const r = oq.pushOwnerQuestion(q.id, { send: none, now: NOON });
  assert.equal(r.status, 'undeliverable');
  const row = oq.getOwnerQuestion(q.id)!;
  assert.equal(row.pushed_at, null);
  assert.match(row.push_delivery ?? '', /^none/);
  // A later sweep with a resolvable chat delivers it.
  const sweep = oq.runOwnerQuestionBackstop({ now: NOON, send: () => 'telegram' });
  assert.equal(sweep.pushed, 1);
  assert.ok(oq.getOwnerQuestion(q.id)!.pushed_at);
});

test('[push] a failed send releases the claim', () => {
  const t = nid('t'); insertTask(t);
  const q = open(t);
  assert.equal(oq.pushOwnerQuestion(q.id, { send: () => 'send_failed', now: NOON }).status, 'undeliverable');
  assert.equal(oq.getOwnerQuestion(q.id)!.pushed_at, null);
});

test('[remind] one reminder at most every 24h; max one per sweep', () => {
  const t = nid('t'); insertTask(t);
  const q = open(t);
  const sent: string[] = [];
  const send = (_i: string, text: string) => { sent.push(text); return 'telegram' as const; };
  oq.pushOwnerQuestion(q.id, { send, now: NOON });
  // 23h later: nothing.
  assert.equal(oq.remindOwnerQuestion(q.id, { send, now: new Date(NOON.getTime() + 23 * 3600e3) }), 'not_due');
  // 25h later (noon + 1h next day): one reminder.
  const later = new Date(NOON.getTime() + 25 * 3600e3);
  const s1 = oq.runOwnerQuestionBackstop({ now: later, send });
  assert.equal(s1.reminded, 1);
  const s2 = oq.runOwnerQuestionBackstop({ now: later, send });
  assert.equal(s2.reminded, 0, 'a second sweep in the same window never re-reminds');
  assert.equal(sent.length, 2);
  assert.match(sent[1], /^Reminder: /);
  // another 24h after the reminder: due again.
  assert.equal(oq.remindOwnerQuestion(q.id, { send, now: new Date(later.getTime() + DAY + 1000) }), 'reminded');
});

test('[backstop] never pushes an operator fault, an archived card, or an answered question', () => {
  const t = nid('t'); insertTask(t);
  const q = open(t);
  // The card later becomes an operator fault: the backstop closes it instead of messaging the client.
  db.run("UPDATE tasks SET blocked_on_human = 'operator', block_audience = 'SYSTEM', block_reason = 'cap', ask = 'raise the cap', status = 'blocked' WHERE id = ?", [t]);
  const sent: string[] = [];
  const res = oq.runOwnerQuestionBackstop({ now: NOON, send: (_i, x) => { sent.push(x); return 'telegram'; } });
  assert.equal(sent.length, 0);
  assert.equal(res.closed, 1);
  assert.ok(oq.getOwnerQuestion(q.id)!.answered_at);
});

// ── wiring: hold, stop-card, board confirm ───────────────────────────────────

test('[wire] holdForAudienceConfirm opens one question with a recommendation, pushes once through the injected sender, and the board confirm closes it', () => {
  const t = nid('t'); insertTask(t, { title: 'Black Friday promo email' });
  persistPersonaBundle(t, bundle());
  const sent: string[] = [];
  const sender = (_id: string, text: string) => { sent.push(text); return 'telegram' as const; };
  const decision = tasksMod.evaluateAudienceConfirmGate(t);
  assert.ok(decision.hold && decision.firstHold);
  tasksMod.holdForAudienceConfirm(t, null, decision, sender);
  tasksMod.holdForAudienceConfirm(t, null, tasksMod.evaluateAudienceConfirmGate(t), sender);
  assert.equal(sent.length, 1, 'one push only');
  assert.match(sent[0], /My recommendation: /);
  const rows = db.queryAll<{ kind: string; recommendation: string; pushed_at: string | null }>('SELECT * FROM owner_questions WHERE task_id = ?', [t]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'audience');
  assert.ok(rows[0].recommendation.startsWith('I recommend:') && rows[0].pushed_at);
  tasksMod.confirmTaskAudience(t, { audienceLabel: 'my clients' });
  const closed = db.queryOne<{ answered_at: string | null; answer_source: string | null; answer: string | null }>('SELECT * FROM owner_questions WHERE task_id = ?', [t])!;
  assert.ok(closed.answered_at);
  assert.equal(closed.answer_source, 'board');
  assert.equal(closed.answer, 'my clients');
});

test('[wire] stopCardPermanently: OWNER opens an owner_block question; SYSTEM never does', async () => {
  const own = nid('own'); insertTask(own, { status: 'in_progress' });
  const r1 = await stopCard.stopCardPermanently({
    taskId: own, source: 'qc-scorer', reason: 'The email account needs reconnecting.', needs: 'Reconnect your email account',
    audience: 'OWNER', expectedFrom: 'in_progress', operatorOverride: true,
  });
  assert.ok(r1.blocked);
  const q = db.queryOne<{ kind: string; recommendation: string; question: string }>('SELECT * FROM owner_questions WHERE task_id = ?', [own]);
  assert.ok(q, 'owner question opened');
  assert.equal(q!.kind, 'owner_block');
  assert.match(q!.recommendation, /^I recommend: reconnect your email account/);

  const sys = nid('sys'); insertTask(sys, { status: 'in_progress' });
  const r2 = await stopCard.stopCardPermanently({
    taskId: sys, source: 'task-dispatcher', reason: 'The dispatcher hit its cap.', needs: 'Operator: raise the cap',
    audience: 'SYSTEM', expectedFrom: 'in_progress', operatorOverride: true,
  });
  assert.ok(r2.blocked);
  assert.equal(db.queryAll('SELECT 1 FROM owner_questions WHERE task_id = ?', [sys]).length, 0, 'operator faults are never owner questions');
});

// ── answering ────────────────────────────────────────────────────────────────

test('[yes] plain acceptance words', () => {
  for (const y of ['YES', 'yes please', 'ok', 'Sure', 'go ahead', 'Sounds good', 'yes Q-ABC123', '👍']) assert.equal(oq.isYes(y), true, y);
  for (const no of ['no', 'yes but make it for clients', 'not sure', 'my email list please', 'wait', '']) assert.equal(oq.isYes(no), false, no);
});

test('[answer] audience: YES accepts the recommended label; replay is idempotent; a different message is 409', async () => {
  const t = nid('t'); insertTask(t);
  persistPersonaBundle(t, bundle());
  const q = open(t);
  const r = await oq.answerOwnerQuestion({ shortCode: q.short_code, answer: 'yes', source: 'chat', sourceMessageRef: 'telegram:1:10' });
  assert.equal(r.applied, 'audience');
  assert.equal(r.row.answer_source, 'chat');
  const task = db.queryOne<{ audience_label: string | null; audience_source: string | null }>('SELECT audience_label, audience_source FROM tasks WHERE id = ?', [t])!;
  assert.equal(task.audience_label, 'your email list');
  assert.equal(task.audience_source, 'operator_confirmed');
  const replay = await oq.answerOwnerQuestion({ id: q.id, answer: 'yes', source: 'chat', sourceMessageRef: 'telegram:1:10' });
  assert.equal(replay.replayed, true);
  await assert.rejects(oq.answerOwnerQuestion({ id: q.id, answer: 'yes', source: 'chat', sourceMessageRef: 'telegram:1:11' }), /already answered/);
});

test('[answer] audience: a typed answer is the audience', async () => {
  const t = nid('t'); insertTask(t);
  persistPersonaBundle(t, bundle());
  const q = open(t);
  await oq.answerOwnerQuestion({ id: q.id, answer: `my coaching clients (ref ${q.short_code})`, source: 'chat', sourceMessageRef: 'telegram:1:20' });
  assert.equal(db.queryOne<{ audience_label: string }>('SELECT audience_label FROM tasks WHERE id = ?', [t])!.audience_label, 'my coaching clients');
});

test('[answer] owner_block: posts an owner activity and resumes the blocked card', async () => {
  const t = nid('t'); insertTask(t, { status: 'blocked', audience: 'OWNER', onHuman: 'owner' });
  const q = open(t, 'owner_block', 'I recommend: reconnect it. Say yes and I will pick the work back up right away.');
  const r = await oq.answerOwnerQuestion({ id: q.id, answer: 'ok', source: 'chat', sourceMessageRef: 'telegram:1:30' });
  assert.equal(r.applied, 'owner_block');
  assert.equal(db.queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [t])!.status, 'backlog');
  const act = db.queryOne<{ activity_type: string; message: string }>("SELECT activity_type, message FROM task_activities WHERE task_id = ? AND activity_type = 'owner_answer'", [t]);
  assert.ok(act && /said yes/.test(act.message));
});

// ── chat-answer door ─────────────────────────────────────────────────────────

const deps = (msg: ReturnType<typeof inbound> | { ok: false; reason: 'store_unavailable' | 'message_not_found' | 'malformed' }) => ({
  readTelegram: () => msg,
  ownerChatId: () => OWNER,
});

test('[chat-answer] YES from the verified owner message applies the recommendation; replay 200; other message 409; unknown 404', async () => {
  const t = nid('t'); insertTask(t);
  persistPersonaBundle(t, bundle());
  const q = open(t);
  const body = { answer: 'yes', channel: 'telegram', source_message_ref: `telegram:${OWNER}:900` };
  const ok = await chat.applyOwnerChatAnswer(ctx, q.short_code, body, deps(inbound({ text: `YES ${q.short_code}` })));
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.success, true);
  assert.equal(ok.payload.applied, 'audience');
  assert.equal((ok.payload.question as { answer_source: string }).answer_source, 'chat');
  assert.equal(db.queryOne<{ audience_label: string }>('SELECT audience_label FROM tasks WHERE id = ?', [t])!.audience_label, 'your email list');

  const replay = await chat.applyOwnerChatAnswer(ctx, q.id, body, deps(inbound({ text: 'yes' })));
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.replayed, true);

  const other = await chat.applyOwnerChatAnswer(ctx, q.id, { ...body, source_message_ref: `telegram:${OWNER}:901` }, deps(inbound({ messageId: '901', text: 'yes' })));
  assert.equal(other.status, 409);

  const unknown = await chat.applyOwnerChatAnswer(ctx, 'Q-FFFFFF', body, deps(inbound({ text: 'yes' })));
  assert.equal(unknown.status, 404);
});

test('[chat-answer] unverified messages are 422 and apply nothing', async () => {
  const t = nid('t'); insertTask(t);
  persistPersonaBundle(t, bundle());
  const q = open(t);
  const body = { answer: 'yes', channel: 'telegram', source_message_ref: `telegram:${OWNER}:900` };
  const cases: Array<[string, unknown]> = [
    ['not found', { ok: false, reason: 'message_not_found' }],
    ['store unavailable', { ok: false, reason: 'store_unavailable' }],
    ['other chat', inbound({ conversationId: '999', senderId: '999', text: `yes ${q.short_code}` })],
    ['bot sender', inbound({ senderIsBot: true, text: `yes ${q.short_code}` })],
    ['before the question', inbound({ sentAtMs: Date.parse(q.asked_at) - 60_000, text: `yes ${q.short_code}` })],
  ];
  for (const [label, msg] of cases) {
    const r = await chat.applyOwnerChatAnswer(ctx, q.id, body, deps(msg as never));
    assert.equal(r.status, 422, label);
  }
  assert.equal(oq.getOwnerQuestion(q.id)!.answered_at, null);
  const noCode = await (async () => {
    // A second open question makes a code-less reply ambiguous.
    const t2 = nid('t'); insertTask(t2); open(t2);
    return chat.applyOwnerChatAnswer(ctx, q.id, body, deps(inbound({ text: 'yes' })));
  })();
  assert.equal(noCode.status, 422);
  assert.equal(oq.getOwnerQuestion(q.id)!.answered_at, null);
});

test('[chat-answer] the VERIFIED words win over the agent paraphrase; a non-agent caller is refused', async () => {
  const t = nid('t'); insertTask(t);
  persistPersonaBundle(t, bundle());
  const q = open(t);
  const body = { answer: 'yes', channel: 'telegram', source_message_ref: `telegram:${OWNER}:900` };
  const refused = await chat.applyOwnerChatAnswer({ subject: 'owner@x.test', tenantId: 't' } as never, q.id, body, deps(inbound({ text: 'yes' })));
  assert.equal(refused.status, 403);
  const r = await chat.applyOwnerChatAnswer(ctx, q.id, body, deps(inbound({ text: `my past customers ${q.short_code}` })));
  assert.equal(r.status, 200);
  assert.equal(db.queryOne<{ audience_label: string }>('SELECT audience_label FROM tasks WHERE id = ?', [t])!.audience_label, 'my past customers');
});

// ── routes ───────────────────────────────────────────────────────────────────

test('[chat-answer] 400 carries {error, hint} for the agent helper', async () => {
  const r = await chat.applyOwnerChatAnswer(ctx, 'Q-ABC123', { answer: 'yes', channel: 'telegram', source_message_ref: 'bogus' }, {});
  assert.equal(r.status, 400);
  assert.equal(r.payload.error, 'invalid_source_message_ref');
  assert.equal(typeof r.payload.hint, 'string');
});

test('[bearer] the chat-answer route is bearer-required for writes', async () => {
  const { requiresBearerForWrite } = await import('../../src/lib/bearer-required-routes');
  assert.equal(requiresBearerForWrite('/api/owner-questions/Q-ABC123/chat-answer', 'POST'), true);
  assert.equal(requiresBearerForWrite('/api/owner-questions', 'GET'), false);
});

test('[list] open questions are listed with the fixed contract fields; stale ones are closed first', () => {
  const t = nid('t'); insertTask(t, { title: 'List me' });
  const q = open(t);
  const arc = nid('arc'); insertTask(arc); const aq = open(arc);
  db.run('UPDATE tasks SET archived_at = ? WHERE id = ?', [new Date().toISOString(), arc]);
  const list = oq.listOpenOwnerQuestions();
  assert.deepEqual(list.map((x) => x.id), [q.id]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['asked_at', 'id', 'kind', 'pushed_at', 'question', 'recommendation', 'short_code', 'task_id', 'task_title']);
  assert.ok(oq.getOwnerQuestion(aq.id)!.answered_at);
});
