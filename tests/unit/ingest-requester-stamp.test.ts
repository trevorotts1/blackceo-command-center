/**
 * P1-04 — /api/tasks/ingest HTTP-route parsing of requester_chat_id /
 * requester_channel (the trust-engine requester stamp), end-to-end.
 *
 * The trust engine can only report acknowledge -> in-progress -> done back to a
 * client if the ORIGINATING chat id survives the ingest front door onto the
 * tasks row. This drives the REAL POST handler (a signed NextRequest, exactly as
 * the CEO's mc-route helper posts it) and then reads the created row from the DB
 * to prove the two columns were parsed, normalized, and persisted:
 *
 *   A. chat id + explicit channel      -> both stamped verbatim
 *   B. chat id, NO channel named       -> channel DEFAULTS to 'telegram'
 *   C. no chat id at all               -> both NULL (operator/internal task)
 *   D. whitespace-only chat id         -> trimmed to empty -> both NULL
 *
 * FAIL-FIRST: against the pre-P1-04 ingest route (origin/main) the handler never
 * reads body.requester_chat_id and createTaskCore never accepts it, so cases A/B
 * would persist NULL and their assertions fail. With the fix they pass.
 *
 * Strategy mirrors task-status-transition.test.ts: point DATABASE_PATH at a
 * throwaway temp DB and set WEBHOOK_SECRET BEFORE `@/lib/db` and the route module
 * load; run the full migration chain (so the migration-098 columns exist), seed
 * the target department workspace, then invoke the real signed POST handler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

// ── Isolated DB + auth secret (set BEFORE @/lib/db / route are imported) ──────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ingest-requester-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const WEBHOOK_SECRET = 'test-webhook-secret-ingest-req';
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
// Keep the ingest handler's best-effort owner notification from touching a gateway.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';

const RUN_ID = Math.random().toString(36).slice(2, 10);
const SALES_WS_ID = `ws-sales-${RUN_ID}`;
const CEO_WS_ID = `ws-ceo-${RUN_ID}`;
const GENERAL_WS_ID = `ws-general-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/ingest/route');
let POST: RouteModule['POST'];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Correct HMAC-SHA256 hex signature over the exact raw body bytes. */
function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

/** POST a signed ingest payload through the real handler. */
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

function requesterCols(taskId: string): { requester_chat_id: string | null; requester_channel: string | null } {
  const row = queryOne<{ requester_chat_id: string | null; requester_channel: string | null }>(
    'SELECT requester_chat_id, requester_channel FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.ok(row, `created task ${taskId} must exist`);
  return row!;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain (incl. migration 098) against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  // The department the CEO routes into, plus CEO + general-task fallbacks.
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

  const route = (await import('../../src/app/api/tasks/ingest/route')) as RouteModule;
  POST = route.POST;
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

// ── A. chat id + explicit channel → both stamped verbatim ────────────────────
test('ingest with requester_chat_id + requester_channel stamps BOTH on the task', async () => {
  const res = await callIngest({
    title: `Requester A ${RUN_ID}`,
    department_slug: 'sales',
    source: 'telegram',
    requester_chat_id: '999888777',
    requester_channel: 'telegram',
    idempotency_key: `req-a-${RUN_ID}`,
  });
  assert.equal(res.status, 201, 'a fresh signed ingest must return 201');
  const body = (await res.json()) as { task_id: string };
  const cols = requesterCols(body.task_id);
  assert.equal(cols.requester_chat_id, '999888777', 'requester_chat_id must persist verbatim');
  assert.equal(cols.requester_channel, 'telegram', 'requester_channel must persist verbatim');
});

// ── B. chat id, NO channel → channel DEFAULTS to 'telegram' ──────────────────
test('ingest with requester_chat_id and NO channel defaults requester_channel to telegram', async () => {
  const res = await callIngest({
    title: `Requester B ${RUN_ID}`,
    department_slug: 'sales',
    source: 'telegram',
    requester_chat_id: '555444',
    idempotency_key: `req-b-${RUN_ID}`,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { task_id: string };
  const cols = requesterCols(body.task_id);
  assert.equal(cols.requester_chat_id, '555444', 'requester_chat_id must persist');
  assert.equal(
    cols.requester_channel,
    'telegram',
    'a chat id with no explicit channel must default the channel to telegram',
  );
});

// ── C. no chat id → both NULL (operator/internal task, never reported on) ─────
test('ingest with NO requester_chat_id leaves both columns NULL', async () => {
  const res = await callIngest({
    title: `Requester C ${RUN_ID}`,
    department_slug: 'sales',
    source: 'ingest',
    idempotency_key: `req-c-${RUN_ID}`,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { task_id: string };
  const cols = requesterCols(body.task_id);
  assert.equal(cols.requester_chat_id, null, 'no chat id => requester_chat_id NULL');
  assert.equal(
    cols.requester_channel,
    null,
    'no chat id => requester_channel NULL even if a channel string leaks in',
  );
});

// ── D. whitespace-only chat id → trimmed to empty → both NULL ────────────────
test('ingest with a whitespace-only requester_chat_id is trimmed away to NULL', async () => {
  const res = await callIngest({
    title: `Requester D ${RUN_ID}`,
    department_slug: 'sales',
    source: 'ingest',
    requester_chat_id: '   ',
    requester_channel: 'telegram',
    idempotency_key: `req-d-${RUN_ID}`,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { task_id: string };
  const cols = requesterCols(body.task_id);
  assert.equal(cols.requester_chat_id, null, 'a whitespace-only chat id must trim to NULL');
  assert.equal(
    cols.requester_channel,
    null,
    'with no real chat id the channel must NOT be stamped (never report on a phantom chat)',
  );
});
