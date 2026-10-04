/**
 * B12 — PRIVATE hq-chat REPORT-BACK BRANCH (SPEC S9, swarm-plan rev 4 task B12).
 *
 * THE DEFECT THIS PINS. SPEC S9: "The inspected trust engine otherwise
 * broadcasts ceo-chat report-back text company-wide, and unknown channels fall
 * back to Telegram. V07 therefore adds one scoped `hq-chat` branch to existing
 * trust-engine delivery BEFORE those branches ... no Telegram fallback and no
 * public transcript broadcast." A report whose session/task binding does not
 * validate must be REFUSED, not downgraded to a public path.
 *
 * Four required proofs, one test each:
 *   1. PRIVATE  — a bound hq-chat session reports back privately: a durable
 *                 task-scoped row is written, and NEITHER the company-wide chat
 *                 transcript NOR Telegram is touched.
 *   2. FOREIGN  — a session/task not bound to this branch is REFUSED: nothing is
 *                 delivered anywhere, the claim is released, and the refusal is
 *                 recorded honestly (`report_back_uncorrelated`).
 *   3. DURABLE  — the report survives the process that produced it (a fresh read
 *                 from the DB, through a re-opened handle, still finds it).
 *   4. REGRESSION — the pre-existing channels (telegram, session, ceo-chat) are
 *                 byte-for-byte unchanged for callers that used them before.
 *
 * Default `channel` on every pre-existing plan type is Telegram, so the
 * foreign cases below double as the "never falls through to Telegram" proof:
 * the Telegram double is asserted NOT called in every hq-chat case.
 *
 * MUST import _isolated-db FIRST. Mocks '@/lib/notify' and '@/lib/events' so no
 * test can reach a real gateway, transcript broadcast or phone.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── Transport doubles installed BEFORE the engine is imported ────────────────
const telegramCalls: Array<{ chatId: string; message: string }> = [];
const sessionCalls: Array<{ sessionKey: string; message: string }> = [];
const broadcastCalls: Array<unknown> = [];
const systemCalls: string[] = [];

const notifyModulePath = require.resolve('../../src/lib/notify.ts');
const eventsModulePath = require.resolve('../../src/lib/events.ts');

require.cache[notifyModulePath] = {
  id: notifyModulePath,
  filename: notifyModulePath,
  loaded: true,
  exports: {
    notifyTelegram: (args: { chatId: string; message: string }) => {
      telegramCalls.push(args);
      return true;
    },
    notifySession: (args: { sessionKey: string; message: string }) => {
      sessionCalls.push(args);
      return true;
    },
    notifySystem: (message: string) => {
      systemCalls.push(message);
      return true;
    },
    recordUndeliverable: () => {},
    resolveOperatorChatId: () => null,
    resolveOwnerChatId: () => null,
  },
} as NodeModule;

require.cache[eventsModulePath] = {
  id: eventsModulePath,
  filename: eventsModulePath,
  loaded: true,
  exports: {
    broadcast: (event: unknown) => {
      broadcastCalls.push(event);
    },
  },
} as NodeModule;

const { getDb, run, queryOne, queryAll, closeDb } = require('../../src/lib/db') as typeof import('../../src/lib/db');
type EngineModule = typeof import('../../src/lib/jobs/trust-engine');
const engine = require('../../src/lib/jobs/trust-engine') as EngineModule;
const { getCeoChatHistory } = require('../../src/lib/ceo-chat/store') as typeof import('../../src/lib/ceo-chat/store');

const RUN = Math.random().toString(36).slice(2, 10);
const COMPANY = `co-b12-${RUN}`;
const WORKSPACE = `ws-b12-${RUN}`;
/** A real server-minted per-turn HQ key: `agent:<runtimeId>:hq-<opaqueTurnId>`. */
const HQ_SESSION = `agent:head-${RUN}:hq-turn-${RUN}`;
const OTHER_HQ_SESSION = `agent:head-${RUN}:hq-turn-other-${RUN}`;
const FOREIGN_SESSION = `agent:main:webchat-${RUN}`;
const NOW = new Date('2026-08-27T15:00:00.000Z');

getDb();

// Schema the box always has; the company/workspace rows make the binding's
// company resolution real rather than an invented constant.
run(`INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)`, [
  COMPANY,
  `B12 Co ${RUN}`,
  `b12-co-${RUN}`,
]);
run(`INSERT INTO workspaces (id, name, slug, company_id) VALUES (?, ?, ?, ?)`, [
  WORKSPACE,
  `B12 WS ${RUN}`,
  `b12-ws-${RUN}`,
  COMPANY,
]);

function seedTask(id: string, over: Record<string, unknown> = {}) {
  const cols: Record<string, unknown> = {
    id,
    title: `task ${id}`,
    status: 'in_progress',
    workspace_id: WORKSPACE,
    requester_channel: engine.HQ_CHAT_CHANNEL,
    requester_chat_id: null,
    requester_session_key: HQ_SESSION,
    created_at: '2026-08-27T13:00:00.000Z',
    updated_at: '2026-08-27T13:00:00.000Z',
    ...over,
  };
  const names = Object.keys(cols);
  run(
    `INSERT INTO tasks (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    names.map((n) => cols[n]),
  );
}

function plan(taskId: string, chatId: string, channel: string): EngineModule['PlannedSend'] {
  return {
    chatId,
    channel,
    message: '🔄 "task" is in progress with Sales. Estimated completion: today.',
    stamps: [
      {
        taskId,
        guardColumn: 'progress_last_sent_at',
        extraSets: {},
        eventType: 'trust_progress',
        eventMessage: `trust_progress(hq-chat) -> ${chatId}: in progress`,
      },
    ],
    doneWithoutDeliverable: [],
    heldForMissingPostflight: [],
  };
}

function clearDoubles() {
  telegramCalls.length = 0;
  sessionCalls.length = 0;
  broadcastCalls.length = 0;
  systemCalls.length = 0;
}

// ── 1. PRIVATE CASE ──────────────────────────────────────────────────────────
test('private: a BOUND hq-chat session reports back privately — no Telegram, no company-wide broadcast', () => {
  clearDoubles();
  const taskId = `b12-private-${RUN}`;
  seedTask(taskId);

  const result = engine.executeSends([plan(taskId, HQ_SESSION, engine.HQ_CHAT_CHANNEL)], {
    now: NOW,
  });

  assert.equal(result.sent, 1, 'a bound hq-chat report must be DELIVERED');
  assert.equal(result.released, 0, 'a delivered report must keep its claim');

  // Durable task-scoped private report row, carrying the OPQUE turn reference.
  const rows = queryAll<{ activity_type: string; message: string; metadata: string }>(
    `SELECT activity_type, message, metadata FROM task_activities WHERE task_id = ?`,
    [taskId],
  );
  assert.equal(rows.length, 1, 'exactly one private report row');
  assert.equal(rows[0].activity_type, 'hq_chat_report');
  assert.match(rows[0].message, /in progress with Sales/);
  const metadata = JSON.parse(rows[0].metadata) as Record<string, unknown>;
  assert.equal(metadata.route, 'hq-chat');
  assert.equal(metadata.kind, 'trust_progress');
  assert.equal(metadata.turnRef, `hq-turn-${RUN}`, 'the opaque turn ref is recorded');
  assert.equal(metadata.companyId, COMPANY, 'the task company resolves through its workspace');

  // THE PRIVACY PROOF: nothing went public and nothing fell back to Telegram.
  assert.equal(telegramCalls.length, 0, 'NEVER Telegram');
  assert.equal(broadcastCalls.length, 0, 'NEVER a company-wide broadcast');
  assert.equal(sessionCalls.length, 0, 'never the webchat session lane');
  assert.equal(getCeoChatHistory(HQ_SESSION).length, 0, 'never the ceo-chat transcript');

  // The stamp is durable (idempotency guard) — the row will not re-plan.
  const stamped = queryOne<{ progress_last_sent_at: string | null }>(
    'SELECT progress_last_sent_at FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.ok(stamped?.progress_last_sent_at, 'the claim stamp is written');
});

// ── 2. FOREIGN CASES ─────────────────────────────────────────────────────────
test('foreign: a session NOT bound to this branch is REFUSED — nothing delivered anywhere', () => {
  clearDoubles();
  const taskId = `b12-foreign-session-${RUN}`;
  seedTask(taskId); // bound to HQ_SESSION

  const result = engine.executeSends([plan(taskId, FOREIGN_SESSION, engine.HQ_CHAT_CHANNEL)], {
    now: NOW,
  });

  assert.equal(result.sent, 0, 'a foreign session must not be delivered');
  assert.equal(result.released, 1, 'the claim must be RELEASED so nothing reads as sent');

  assert.equal(telegramCalls.length, 0, 'REFUSED, never downgraded to Telegram');
  assert.equal(broadcastCalls.length, 0, 'REFUSED, never downgraded to a broadcast');
  assert.equal(sessionCalls.length, 0, 'REFUSED, never downgraded to the session lane');
  assert.equal(
    queryAll(`SELECT id FROM task_activities WHERE task_id = ?`, [taskId]).length,
    0,
    'a refused report writes NO private report row',
  );
  const released = queryOne<{ progress_last_sent_at: string | null }>(
    'SELECT progress_last_sent_at FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(released?.progress_last_sent_at, null, 'the claim was released');

  // The refusal is durable and honest (SPEC S9 `report_back_uncorrelated`).
  const refusals = queryAll<{ type: string; message: string }>(
    `SELECT type, message FROM events WHERE task_id = ? AND type = 'report_back_uncorrelated'`,
    [taskId],
  );
  assert.equal(refusals.length, 1, 'the refusal is recorded, not silent');
  assert.match(refusals[0].message, /session_not_bound/);
});

test('foreign: a FOREIGN CHANNEL cannot use the private branch (class boundary)', () => {
  clearDoubles();
  const taskId = `b12-foreign-channel-${RUN}`;
  // Bound to the private session key, but the task's channel is NOT hq-chat.
  seedTask(taskId, { requester_channel: 'telegram', requester_chat_id: '551234567' });

  const result = engine.executeSends([plan(taskId, HQ_SESSION, engine.HQ_CHAT_CHANNEL)], {
    now: NOW,
  });

  assert.equal(result.sent, 0, 'a non-hq-chat task is not deliverable through the private branch');
  assert.equal(result.released, 1);
  assert.equal(telegramCalls.length, 0, 'and it must NOT fall through to Telegram either');
  const refusals = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'report_back_uncorrelated'`,
    [taskId],
  );
  assert.equal(refusals.length, 1);
  assert.match(refusals[0].message, /foreign_channel/);
});

test('foreign: a non-hq session key stored as the binding is refused, never trusted as an address', () => {
  clearDoubles();
  const taskId = `b12-weird-binding-${RUN}`;
  // A producer run id (not a gateway key at all) sits in requester_session_key.
  seedTask(taskId, { requester_session_key: `pres-mta0y199-${RUN}` });

  const result = engine.executeSends([plan(taskId, `pres-mta0y199-${RUN}`, engine.HQ_CHAT_CHANNEL)], {
    now: NOW,
  });

  assert.equal(result.sent, 0);
  assert.equal(result.released, 1);
  assert.equal(telegramCalls.length, 0);
  const refusals = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'report_back_uncorrelated'`,
    [taskId],
  );
  assert.equal(refusals.length, 1);
  assert.match(refusals[0].message, /foreign_session/);
});

test('foreign: validateHqChatReport refuses an unknown task and an unbound-but-identical-looking pair', () => {
  const missing = engine.validateHqChatReport({ taskId: `nope-${RUN}`, sessionId: HQ_SESSION });
  assert.deepEqual(missing, { ok: false, reason: 'unknown_task' });

  const noTask = engine.validateHqChatReport({ taskId: null, sessionId: HQ_SESSION });
  assert.deepEqual(noTask, { ok: false, reason: 'no_task' });

  const taskId = `b12-unbound-${RUN}`;
  seedTask(taskId, { requester_session_key: null });
  assert.deepEqual(engine.validateHqChatReport({ taskId, sessionId: HQ_SESSION }), {
    ok: false,
    reason: 'no_bound_session',
  });

  // The POSITIVE CONTROL for the same instrument: the bound pair validates.
  const okTask = `b12-bound-${RUN}`;
  seedTask(okTask);
  const ok = engine.validateHqChatReport({ taskId: okTask, sessionId: HQ_SESSION });
  assert.equal(ok.ok, true, 'the bound pair validates — the check discriminates');
  if (ok.ok) {
    assert.equal(ok.binding.taskId, okTask);
    assert.equal(ok.binding.sessionId, HQ_SESSION);
    assert.equal(ok.binding.companyId, COMPANY);
  }
});

// ── 3. DURABLE RESULT ────────────────────────────────────────────────────────
test('durable: the report outlives the process that produced it (fresh handle, fresh read)', () => {
  clearDoubles();
  const taskId = `b12-durable-${RUN}`;
  seedTask(taskId);
  engine.executeSends([plan(taskId, HQ_SESSION, engine.HQ_CHAT_CHANNEL)], { now: NOW });

  const dbPath = require('../../src/lib/db').getDbPath() as string;
  closeDb();

  // A brand-new connection — nothing of the producing process is in memory.
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const reopened = new Database(dbPath, { readonly: true });
  try {
    const row = reopened
      .prepare(
        `SELECT activity_type, message, metadata FROM task_activities WHERE task_id = ?`,
      )
      .get(taskId) as { activity_type: string; message: string; metadata: string } | undefined;
    assert.ok(row, 'the private report survived the process that wrote it');
    assert.equal(row.activity_type, 'hq_chat_report');
    assert.match(row.message, /in progress with Sales/);
    assert.equal((JSON.parse(row.metadata) as { turnRef: string }).turnRef, `hq-turn-${RUN}`);
  } finally {
    reopened.close();
  }
  getDb(); // restore the shared handle for any later test in this file
});

// ── 4. EXISTING-CHANNEL REGRESSION ───────────────────────────────────────────
test('regression: telegram, session and ceo-chat callers are unchanged', () => {
  clearDoubles();

  // (a) telegram — default channel, chat id, exactly as before.
  const tgTask = `b12-reg-tg-${RUN}`;
  seedTask(tgTask, {
    requester_channel: 'telegram',
    requester_chat_id: '551234567',
    requester_session_key: null,
  });
  const tg = engine.executeSends([plan(tgTask, '551234567', 'telegram')], { now: NOW });
  assert.equal(tg.sent, 1);
  assert.deepEqual(telegramCalls, [
    { chatId: '551234567', message: '🔄 "task" is in progress with Sales. Estimated completion: today.' },
  ]);
  assert.equal(
    queryAll(`SELECT id FROM task_activities WHERE task_id = ?`, [tgTask]).length,
    0,
    'the telegram lane still writes NO task_activities row (hq-chat only)',
  );

  // (b) session — the webchat requester lane, unchanged.
  clearDoubles();
  const sessTask = `b12-reg-sess-${RUN}`;
  seedTask(sessTask, {
    requester_channel: null,
    requester_chat_id: null,
    requester_session_key: FOREIGN_SESSION,
  });
  const sess = engine.executeSends([plan(sessTask, FOREIGN_SESSION, 'session')], { now: NOW });
  assert.equal(sess.sent, 1);
  assert.deepEqual(sessionCalls, [
    { sessionKey: FOREIGN_SESSION, message: '🔄 "task" is in progress with Sales. Estimated completion: today.' },
  ]);

  // (c) ceo-chat — still the transcript + broadcast path, unchanged.
  clearDoubles();
  const ceoTask = `b12-reg-ceo-${RUN}`;
  seedTask(ceoTask, {
    requester_channel: 'ceo-chat',
    requester_chat_id: null,
    requester_session_key: null,
  });
  const sid = `ceochat-b12-${RUN}`;
  const ceo = engine.executeSends([plan(ceoTask, sid, 'ceo-chat')], { now: NOW });
  assert.equal(ceo.sent, 1);
  const history = getCeoChatHistory(sid);
  assert.equal(history.length, 1, 'ceo-chat still writes its transcript row');
  assert.equal(history[0].role, 'trust');
  assert.equal(history[0].task_id, ceoTask);
  assert.equal(broadcastCalls.length, 1, 'ceo-chat still broadcasts on the existing bus');
  assert.equal(telegramCalls.length, 0);
});

// ── 5. ROUTE RESOLUTION (the branch is chosen before chat-id precedence) ─────
test('resolveRequesterRoute: hq-chat wins over a stale chat id, and never degrades to chat/session', () => {
  const route = engine.resolveRequesterRoute({
    requester_channel: engine.HQ_CHAT_CHANNEL,
    // A stale/other id that the OLD ordering would have preferred.
    requester_chat_id: '551234567',
    requester_session_key: HQ_SESSION,
  });
  assert.deepEqual(route, {
    address: HQ_SESSION,
    channel: engine.HQ_CHAT_CHANNEL,
    route: 'hq-chat',
  });

  // Missing binding => still an hq-chat route with an empty address, so delivery
  // REFUSES at the bound-session check rather than downgrading.
  const unbound = engine.resolveRequesterRoute({
    requester_channel: engine.HQ_CHAT_CHANNEL,
    requester_chat_id: '551234567',
    requester_session_key: null,
  });
  assert.deepEqual(unbound, { address: '', channel: engine.HQ_CHAT_CHANNEL, route: 'hq-chat' });

  // POSITIVE CONTROLS for the unchanged precedence rules.
  assert.deepEqual(
    engine.resolveRequesterRoute({
      requester_channel: 'telegram',
      requester_chat_id: '551234567',
      requester_session_key: HQ_SESSION,
    }),
    { address: '551234567', channel: 'telegram', route: 'chat' },
  );
  assert.deepEqual(
    engine.resolveRequesterRoute({
      requester_channel: null,
      requester_chat_id: null,
      requester_session_key: FOREIGN_SESSION,
    }),
    { address: FOREIGN_SESSION, channel: 'session', route: 'session' },
  );
});

test('the sweep finds an hq-chat task whose binding is MISSING, so it is refused on the record', () => {
  clearDoubles();
  const taskId = `b12-sweep-unbound-${RUN}`;
  seedTask(taskId, { requester_session_key: null, ack_sent_at: null });

  const rows = engine.loadCandidateTasks(taskId);
  assert.equal(rows.length, 1, 'an unbound hq-chat task is a candidate, not invisible');
  assert.equal(engine.resolveRequesterRoute(rows[0])?.route, 'hq-chat');

  const result = engine.runTrustEngineSweep({ now: NOW });
  assert.ok(result.scanned >= 1);
  const refusals = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'report_back_uncorrelated'`,
    [taskId],
  );
  assert.equal(refusals.length, 1, 'the missing binding is refused, not skipped silently');
  assert.match(refusals[0].message, /no_bound_session/);

  // Scope the "never Telegram / never session" claim to THIS task: a full sweep
  // legitimately reports on unrelated pre-existing candidates (the tasks seeded
  // by earlier cases still owe their own ACK/phase messages), so the honest
  // assertion is that none of those sends is THIS task's. Its address is the
  // empty string, so a downgrade would surface either as an empty address or as
  // a message naming its title — both are checked, on both transports.
  const taskTitle = `task ${taskId}`;
  const mentions = (call: { chatId?: string; sessionKey?: string; message: string }) =>
    (call.chatId ?? call.sessionKey ?? '').trim() === '' || call.message.includes(taskTitle);
  assert.deepEqual(
    telegramCalls.filter(mentions),
    [],
    'the unbound hq-chat task never reaches Telegram',
  );
  assert.deepEqual(
    sessionCalls.filter(mentions),
    [],
    'the unbound hq-chat task never reaches the session lane',
  );
  assert.equal(
    queryAll(`SELECT id FROM task_activities WHERE task_id = ?`, [taskId]).length,
    0,
    'and writes no private report row',
  );
});
