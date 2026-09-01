/**
 * WEBCHAT-REQUESTER-ROUTE — capture + delivery for a requester who has no chat id.
 *
 * THE DEFECT THIS PINS (live, task f4a2de9a on the operator box): a task created
 * from a WEBCHAT session had `requester_chat_id` NULL — a Telegram-only field.
 * The `requester_chat_id_missing` warning fired correctly and then NOTHING could
 * close the gap: the trust engine's candidate query filtered the task out
 * entirely, `sendRequesterAudienceAsk` returned 'none', and owner re-pings fell
 * back to operator channels. The requester sat unreachable in a live gateway
 * session the box knew about (its key survived only as PROSE in the task
 * description — the one place nothing can read it).
 *
 * FAIL-FIRST: against the pre-fix tree `tasks.requester_session_key` and
 * migration 127 do not exist, `resolveRequesterRoute` / `notifySession` are not
 * exported, and every capture + delivery assertion below fails.
 *
 * Covers:
 *   1. Migration 127 adds the column + its partial index on a fresh DB.
 *   2. Ingest captures an explicit `requester_session_key`, falls back to
 *      `external_session_id` when that carries a real gateway key, and REFUSES a
 *      producer run id (which is provenance, not an address).
 *   3. The chat id still WINS whenever both are present — no task that reports
 *      today changes lane.
 *   4. The planner routes a chat-id-less task over the session lane, the executor
 *      dispatches it through the mocked transport seam, and the telemetry event
 *      names the route that carried it.
 *   5. `sendRequesterAudienceAsk` reaches a webchat requester and reports
 *      'session' — the string the caller writes verbatim into
 *      `audience_confirm_ask_sent`.
 *   6. A session key (which CONTAINS colons) never leaks into the Activity UI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-webchat-route-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
// Nothing in this file may reach a real gateway or a real phone.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';

const WEBHOOK_SECRET = 'test-webhook-secret-webchat-route';
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const SALES_WS_ID = `ws-sales-${RUN_ID}`;
const CEO_WS_ID = `ws-ceo-${RUN_ID}`;
const GENERAL_WS_ID = `ws-general-${RUN_ID}`;

/** A real gateway session key: `agent:<agentId>:<peer>`. */
const SESSION_KEY = `agent:main:webchat-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/ingest/route');
let POST: RouteModule['POST'];

type EngineModule = typeof import('../../src/lib/jobs/trust-engine');
let engine: EngineModule;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

function callIngest(payload: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const req = new NextRequest('http://localhost/api/tasks/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': sign(rawBody),
    },
    body: rawBody,
  });
  return POST(req) as unknown as Promise<Response>;
}

interface RequesterCols {
  requester_chat_id: string | null;
  requester_channel: string | null;
  requester_session_key: string | null;
}

function requesterCols(taskId: string): RequesterCols {
  const row = queryOne<RequesterCols>(
    'SELECT requester_chat_id, requester_channel, requester_session_key FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.ok(row, `created task ${taskId} must exist`);
  return row!;
}

async function ingestTask(payload: Record<string, unknown>): Promise<string> {
  const res = await callIngest(payload);
  assert.equal(res.status, 201, `ingest must create the task (got ${res.status})`);
  const body = (await res.json()) as { task_id: string };
  return body.task_id;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb(); // runs the FULL migration chain (incl. 127) against the fresh temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'sales', 'Sales', '💰', 'default', 1, ?, ?)`,
    [SALES_WS_ID, now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'master-orchestrator', 'CEO', '🤖', 'default', 0, ?, ?)`,
    [CEO_WS_ID, now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'general-task', 'General Task', '📋', 'default', 99, ?, ?)`,
    [GENERAL_WS_ID, now, now],
  );

  POST = ((await import('../../src/app/api/tasks/ingest/route')) as RouteModule).POST;
  engine = (await import('../../src/lib/jobs/trust-engine')) as EngineModule;
});

test.after(() => {
  try {
    if (typeof closeDb === 'function') closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── 1. Schema: migration 127 on a fresh DB ───────────────────────────────────

test('migration 127 adds tasks.requester_session_key on a fresh database', () => {
  const cols = queryAll<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
    'PRAGMA table_info(tasks)',
    [],
  );
  const col = cols.find((c) => c.name === 'requester_session_key');
  assert.ok(col, 'tasks.requester_session_key must exist after the migration chain');
  assert.equal(col!.type, 'TEXT');
  assert.equal(col!.notnull, 0, 'the column must be NULLABLE — it is additive on live boxes');
  assert.equal(col!.dflt_value, null, 'no DEFAULT — an ALTER with one can fail on existing data');
});

test('migration 127 creates the partial index the sweep now needs', () => {
  const idx = queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_requester_session'",
    [],
  );
  assert.ok(idx, 'idx_tasks_requester_session must exist (mirrors idx_tasks_requester_chat)');
});

test('migration 127 is recorded exactly once in _migrations', () => {
  const rows = queryAll<{ id: string }>("SELECT id FROM _migrations WHERE id = '127'", []);
  assert.equal(rows.length, 1, 'migration 127 must be applied and recorded once');
});

// ── 2. Capture at the ingest front door ──────────────────────────────────────

test('ingest captures an explicit requester_session_key with NO chat id (the webchat case)', async () => {
  const taskId = await ingestTask({
    title: `Webchat capture ${RUN_ID}`,
    department_slug: 'sales',
    source: 'webchat',
    requester_session_key: SESSION_KEY,
    idempotency_key: `wc-a-${RUN_ID}`,
  });
  const cols = requesterCols(taskId);
  assert.equal(cols.requester_session_key, SESSION_KEY, 'the session key must land on the row');
  assert.equal(cols.requester_chat_id, null, 'a webchat requester genuinely has no chat id');
});

test('ingest falls back to external_session_id when it carries a real gateway key', async () => {
  const taskId = await ingestTask({
    title: `Webchat external ${RUN_ID}`,
    department_slug: 'sales',
    source: 'agent',
    external_session_id: `agent:main:direct-${RUN_ID}`,
    idempotency_key: `wc-b-${RUN_ID}`,
  });
  assert.equal(
    requesterCols(taskId).requester_session_key,
    `agent:main:direct-${RUN_ID}`,
    'the documented session-key field must be honoured as a capture source',
  );
});

test('ingest REFUSES a producer run id in external_session_id as a requester address', async () => {
  // This is what external_session_id actually carries in most live traffic
  // (`pres-mta0y199-qj40j3`, `<task-id>:P4-COPY`). Nothing can be DELIVERED to
  // one, so storing it would convert honest silence into a guaranteed failed send.
  const taskId = await ingestTask({
    title: `Producer run ${RUN_ID}`,
    department_slug: 'sales',
    source: 'agent',
    external_session_id: `pres-run-${RUN_ID}`,
    idempotency_key: `wc-c-${RUN_ID}`,
  });
  assert.equal(
    requesterCols(taskId).requester_session_key,
    null,
    'a non-addressable run id must NOT be stamped as a requester address',
  );
});

test('ingest captures the session key alongside a chat id, regardless of channel', async () => {
  const taskId = await ingestTask({
    title: `Both addresses ${RUN_ID}`,
    department_slug: 'sales',
    source: 'telegram',
    requester_chat_id: '551234567',
    requester_session_key: SESSION_KEY,
    idempotency_key: `wc-d-${RUN_ID}`,
  });
  const cols = requesterCols(taskId);
  assert.equal(cols.requester_chat_id, '551234567');
  assert.equal(cols.requester_session_key, SESSION_KEY, 'capture is not gated on the chat id being absent');
  assert.equal(cols.requester_channel, 'telegram');
});

test('a session-routed task is NOT reported as an unreachable requester', async () => {
  const taskId = await ingestTask({
    title: `Reachable via session ${RUN_ID}`,
    department_slug: 'sales',
    source: 'webchat',
    requester_session_key: SESSION_KEY,
    idempotency_key: `wc-e-${RUN_ID}`,
  });
  const missing = queryAll<{ id: string }>(
    "SELECT id FROM events WHERE task_id = ? AND type = 'requester_chat_id_missing'",
    [taskId],
  );
  assert.equal(missing.length, 0, 'the gap is CLOSED — warning about it would be false');
  const captured = queryAll<{ message: string }>(
    "SELECT message FROM events WHERE task_id = ? AND type = 'requester_session_route_captured'",
    [taskId],
  );
  assert.equal(captured.length, 1, 'the route that closed the gap must be queryable');
});

test('a task with NEITHER address still raises the missing-requester warning', async () => {
  const taskId = await ingestTask({
    title: `No address at all ${RUN_ID}`,
    department_slug: 'sales',
    source: 'telegram',
    idempotency_key: `wc-f-${RUN_ID}`,
  });
  const missing = queryAll<{ id: string }>(
    "SELECT id FROM events WHERE task_id = ? AND type = 'requester_chat_id_missing'",
    [taskId],
  );
  assert.equal(missing.length, 1, 'a genuinely unreachable task must still be flagged');
});

// ── 3. Route precedence ──────────────────────────────────────────────────────

test('resolveRequesterRoute: the chat id always wins when both addresses exist', () => {
  const route = engine.resolveRequesterRoute({
    requester_channel: 'telegram',
    requester_chat_id: '551234567',
    requester_session_key: SESSION_KEY,
  });
  assert.deepEqual(route, { address: '551234567', channel: 'telegram', route: 'chat' });
});

test('resolveRequesterRoute: falls through to the session key when there is no chat id', () => {
  const route = engine.resolveRequesterRoute({
    requester_channel: null,
    requester_chat_id: null,
    requester_session_key: SESSION_KEY,
  });
  assert.deepEqual(route, { address: SESSION_KEY, channel: 'session', route: 'session' });
});

test('resolveRequesterRoute: null when the task has no requester address at all', () => {
  assert.equal(
    engine.resolveRequesterRoute({
      requester_channel: 'telegram',
      requester_chat_id: null,
      requester_session_key: null,
    }),
    null,
  );
});

// ── 4. Delivery: the planner + executor over the session lane ────────────────

/** The fixed planner clock. Midday, so quiet hours are never in play. */
const PLAN_NOW = new Date('2026-08-27T15:00:00.000Z');

function mkSessionTask(over: Record<string, unknown> = {}) {
  return {
    id: `sess-task-${RUN_ID}`,
    title: 'Build the keynote',
    // Backlog + two hours before PLAN_NOW: past ACK_BACKLOG_GRACE_MS, so the ACK
    // branch is the one that fires (an in_progress task would take the PROGRESS
    // branch first). The age is measured against PLAN_NOW, never the wall clock.
    status: 'backlog',
    department: 'presentations',
    assigned_agent_name: 'Deck Architect',
    created_at: '2026-08-27T13:00:00.000Z',
    requester_channel: null,
    requester_chat_id: null,
    requester_session_key: SESSION_KEY,
    ack_sent_at: null,
    progress_last_sent_at: null,
    completion_sent_at: null,
    block_audience: null,
    block_needs: null,
    blocked_notice_sent_at: null,
    phase_progress_sent_at: null,
    last_reported_phase_label: null,
    process_certificate_sha: null,
    source: 'webchat',
    ...over,
  } as import('../../src/lib/jobs/trust-engine').TrustTaskRow;
}

test('planSends routes a chat-id-less task over the session lane', () => {
  const plans = engine.planSends([mkSessionTask()], {
    now: PLAN_NOW,
    deliverableFor: () => null,
    isNight: false,
  });
  assert.equal(plans.length, 1, 'a webchat requester must now be planned for, not skipped');
  assert.equal(plans[0].chatId, SESSION_KEY, 'the session key is the address');
  assert.equal(plans[0].channel, 'session', 'the lane must be the session transport');
});

test('the telemetry event records WHICH route delivered', () => {
  const [sessionPlan] = engine.planSends([mkSessionTask()], {
    now: PLAN_NOW,
    deliverableFor: () => null,
    isNight: false,
  });
  assert.match(
    sessionPlan.stamps[0].eventMessage,
    /^trust_ack\(session\) -> /,
    'a session-delivered ack must say so in its durable event',
  );

  const [chatPlan] = engine.planSends(
    [mkSessionTask({ requester_chat_id: '551234567', requester_channel: 'telegram' })],
    { now: PLAN_NOW, deliverableFor: () => null, isNight: false },
  );
  assert.match(
    chatPlan.stamps[0].eventMessage,
    /^trust_ack\(chat\) -> /,
    'the chat lane must name its route too — the trail is only useful if both do',
  );
});

test('executeSends dispatches the session plan through the transport seam', () => {
  const now = PLAN_NOW;
  const taskId = `exec-sess-${RUN_ID}`;
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, department,
                        requester_chat_id, requester_session_key, created_at, updated_at)
     VALUES (?, ?, 'in_progress', 'medium', ?, 'sales', NULL, ?, ?, ?)`,
    [taskId, 'Session delivery', SALES_WS_ID, SESSION_KEY, now.toISOString(), now.toISOString()],
  );

  const captured: Array<{ chatId: string; message: string; channel?: string }> = [];
  const plans = engine.planSends([mkSessionTask({ id: taskId })], {
    now,
    deliverableFor: () => null,
    isNight: false,
  });
  const result = engine.executeSends(plans, {
    now,
    send: (chatId, message, channel) => {
      captured.push({ chatId, message, channel });
      return true;
    },
  });

  assert.equal(result.sent, 1, 'the send must be DISPATCHED, not skipped');
  assert.equal(result.released, 0, 'a dispatched send must not release its claim');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].chatId, SESSION_KEY);
  assert.equal(captured[0].channel, 'session', 'the executor must hand the lane to the transport');

  const stamped = queryOne<{ ack_sent_at: string | null }>(
    'SELECT ack_sent_at FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.ok(stamped?.ack_sent_at, 'the durable stamp must be written (idempotency guard)');
});

test('loadCandidateTasks now finds a task addressable ONLY by session key', () => {
  const taskId = `cand-sess-${RUN_ID}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, department,
                        requester_chat_id, requester_session_key, created_at, updated_at)
     VALUES (?, ?, 'in_progress', 'medium', ?, 'sales', NULL, ?, ?, ?)`,
    [taskId, 'Candidate by session', SALES_WS_ID, SESSION_KEY, now, now],
  );
  const rows = engine.loadCandidateTasks(taskId);
  assert.equal(rows.length, 1, 'the candidate query previously filtered this task out entirely');
  assert.equal(rows[0].requester_session_key, SESSION_KEY);
});

// ── 5. The audience-confirmation ask ─────────────────────────────────────────

test('sendRequesterAudienceAsk reaches a webchat requester and reports the session route', () => {
  const taskId = `ask-sess-${RUN_ID}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, department,
                        requester_chat_id, requester_session_key, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', ?, 'sales', NULL, ?, ?, ?)`,
    [taskId, 'Audience ask via session', SALES_WS_ID, SESSION_KEY, now, now],
  );

  const sessionSends: Array<{ sessionKey: string; message: string }> = [];
  const delivery = engine.sendRequesterAudienceAsk(
    taskId,
    'Who is this for?',
    () => {
      throw new Error('the Telegram lane must NOT be used when there is no chat id');
    },
    (opts) => {
      sessionSends.push(opts);
      return true;
    },
  );

  assert.equal(delivery, 'session', 'the delivery string is the durable record of the route');
  assert.equal(sessionSends.length, 1);
  assert.equal(sessionSends[0].sessionKey, SESSION_KEY);
  assert.equal(sessionSends[0].message, 'Who is this for?');
});

test('sendRequesterAudienceAsk still prefers the chat id when the task has one', () => {
  const taskId = `ask-chat-${RUN_ID}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, department,
                        requester_chat_id, requester_session_key, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', ?, 'sales', '551234567', ?, ?, ?)`,
    [taskId, 'Audience ask via chat', SALES_WS_ID, SESSION_KEY, now, now],
  );

  const delivery = engine.sendRequesterAudienceAsk(
    taskId,
    'Who is this for?',
    () => true,
    () => {
      throw new Error('the session lane must never pre-empt a real chat id');
    },
  );
  assert.equal(delivery, 'telegram');
});

test('sendRequesterAudienceAsk reports the honest none when there is no address of either kind', () => {
  const taskId = `ask-none-${RUN_ID}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, department,
                        requester_chat_id, requester_session_key, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', ?, 'sales', NULL, NULL, ?, ?)`,
    [taskId, 'Audience ask unreachable', SALES_WS_ID, now, now],
  );
  assert.equal(
    engine.sendRequesterAudienceAsk(taskId, 'Who is this for?', () => true, () => true),
    'none (no requester_chat_id)',
  );
});

// ── 6. No id leak into the Activity UI ───────────────────────────────────────

test('a colon-bearing session key never leaks into the client-facing activity message', async () => {
  const { extractClientMessage } = await import('../../src/lib/trust-activity');
  const raw = `trust_ack(session) -> ${SESSION_KEY}: ✅ Got it — "Build the keynote" was assigned.`;
  const body = extractClientMessage(raw);
  assert.equal(body, '✅ Got it — "Build the keynote" was assigned.');
  assert.ok(!body.includes('agent:'), 'the session key must be stripped like any other address');
  assert.ok(!body.includes(RUN_ID), 'no fragment of the address may survive');
});

test('the existing chat-lane prefix stripping is unchanged', async () => {
  const { extractClientMessage } = await import('../../src/lib/trust-activity');
  assert.equal(extractClientMessage('trust_ack -> 55512345: Got it.'), 'Got it.');
  assert.equal(extractClientMessage('trust_ack(chat) -> 55512345: Got it.'), 'Got it.');
  assert.equal(extractClientMessage('trust_ack -> 55512345:'), '');
  assert.equal(extractClientMessage('a plain message with: a colon'), 'a plain message with: a colon');
});
