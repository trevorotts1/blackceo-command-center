/**
 * FLEET-01 — global agent-dispatch concurrency ceiling: manual "Send to
 * Agent" route (POST /api/tasks/[id]/dispatch) integration coverage.
 *
 * See tests/unit/agent-dispatch-concurrency-limit.test.ts (probe unit tests)
 * and tests/unit/agent-dispatch-concurrency-ceiling-auto.test.ts (the
 * auto-advance sweep's GUARD 9) for the rest of this feature's coverage. This
 * suite proves the SAME ceiling is enforced on the manual dispatch route —
 * and, unlike the auto path (which quietly HOLDS a card for the next tick),
 * an operator-triggered manual dispatch that would blow the ceiling is
 * REFUSED outright with a clear, named reason:
 *
 *   (1) [MANDATORY] env var UNSET → manual dispatch behaves exactly as
 *       today, dispatching normally even with the board deeply
 *       oversubscribed on in_progress tasks.
 *   (2) ceiling=3, 3 in flight → a manual dispatch of a 4th task is REFUSED
 *       (429, reason 'dispatch_concurrency_limit', message names the
 *       ceiling) — and, critically, chat.send is NEVER called (the refusal
 *       is a true pre-send hold, not a queue-then-fail).
 *   (3) ceiling=3, under capacity → manual dispatch proceeds normally.
 *
 * Strategy: identical harness to dispatch-idempotency-window.test.ts — real
 * route handler (import POST), isolated temp DB, a fake $HOME with a real
 * per-department OpenClaw runtime dir, a real sovereign model pin, and the
 * ONE network boundary (the OpenClaw client singleton) stubbed so
 * isConnected()/call() never touch a socket.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts --test \
 *     tests/unit/agent-dispatch-concurrency-ceiling-manual.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated DB (BEFORE any '@/lib/db' import) ───────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fleet01-manual-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fleet01-manual-home-'));
const AGENTS_ROOT = path.join(TMP_HOME, '.openclaw', 'agents');
fs.mkdirSync(path.join(AGENTS_ROOT, 'testdept'), { recursive: true });
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.OPENCLAW_PLATFORM = 'mac-mini';

process.env.ALLOW_INSECURE_OPEN_API = 'true';
process.env.SOVEREIGN_DEFAULT_MODEL = 'test-provider/test-model-v1';
process.env.CC_SKILL_ROOTS = path.join(TMP_HOME, 'no-skills-here');
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/[id]/dispatch/route');
let POST: RouteModule['POST'];

const AGENT_ID = 'agent-fleet01-manual';
const WS_ID = 'ws-fleet01-manual';
const MODEL_ID = 'test-provider/test-model-v1';

function postRequest(taskId: string, body?: Record<string, unknown>) {
  const params = Promise.resolve({ id: taskId });
  const req = {
    json: async () => body ?? {},
    clone() {
      return req;
    },
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Parameters<RouteModule['POST']>[0];
  return { req, params };
}

let seedCounter = 0;

/** A fully-groomed, dispatchable-in-one-POST task (mirrors the fixture shape
 * dispatch-idempotency-window.test.ts uses to reach a real chat.send). */
function seedDispatchableTask(status = 'backlog'): string {
  const id = `fleet01-manual-${seedCounter++}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id,
       workspace_id, business_id, department, dispatch_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'medium', ?, ?, NULL, 'testdept', 0, ?, ?)`,
    [id, `FLEET-01 manual task ${id}`, 'A fully-groomed FLEET-01 manual-dispatch test task.', status, AGENT_ID, WS_ID, now, now],
  );
  return id;
}

/** A bare in_progress task occupying a global concurrency slot. */
function seedInFlightTask(): string {
  const id = `fleet01-manual-inflight-${seedCounter++}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'seed', 'in_progress', 'high', NULL, NULL, ?, ?)`,
    [id, `In-flight ${id}`, now, now],
  );
  return id;
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb();

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, company_id) VALUES (?, 'testdept', 'Test Dept', 'default')`,
    [WS_ID],
  );
  run(
    `INSERT INTO agents (id, name, role, is_master, specialist_type, workspace_id, status, created_at, updated_at)
     VALUES (?, ?, 'Test Operations', 0, 'permanent', ?, 'standby', ?, ?)`,
    [AGENT_ID, 'FLEET-01 Manual Agent', WS_ID, now, now],
  );
  run(
    `INSERT INTO agent_settings (id, department_id, role_id, setting_type, value)
     VALUES (?, 'testdept', ?, 'model', ?)`,
    [`as-${AGENT_ID}`, AGENT_ID, MODEL_ID],
  );
  run(
    `INSERT INTO model_registry (model_id, label, provider, capabilities, status)
     VALUES (?, 'Test Model', 'test-provider', '["text"]', 'active')`,
    [MODEL_ID],
  );

  POST = (await import('../../src/app/api/tasks/[id]/dispatch/route')).POST;
});

test.after(async () => {
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try {
    const g = globalThis as Record<string, NodeJS.Timeout | undefined>;
    const timer = g['__openclaw_cache_cleanup_timer__'];
    if (timer) { clearInterval(timer); delete g['__openclaw_cache_cleanup_timer__']; }
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

test.beforeEach(() => {
  delete process.env.AGENT_DISPATCH_MAX_CONCURRENT;
  // Deterministic per-test in-flight count (same rationale as the auto-path
  // suite): retire any in_progress rows a PRIOR test in this file left behind.
  run(`UPDATE tasks SET status = 'done' WHERE status = 'in_progress'`);
});

/** Stub the gateway boundary (same pattern as dispatch-idempotency-window.test.ts). */
async function stubGateway(): Promise<{ sends: Array<{ method: string; params: Record<string, unknown> | undefined }> }> {
  const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
  const client = getOpenClawClient();
  const sends: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  client.isConnected = () => true;
  client.call = (async (method: string, params?: Record<string, unknown>) => {
    sends.push({ method, params: params ?? {} });
    return { ok: true };
  }) as typeof client.call;
  return { sends };
}

// ── (1) MANDATORY: env unset → manual dispatch unaffected, any load ─────────

test('[FLEET-01 mandatory] env var UNSET: manual dispatch succeeds normally, even with the board deeply oversubscribed', async () => {
  delete process.env.AGENT_DISPATCH_MAX_CONCURRENT;
  const { sends } = await stubGateway();
  for (let i = 0; i < 10; i++) seedInFlightTask();

  const taskId = seedDispatchableTask();
  const { req, params } = postRequest(taskId);
  const res = await POST(req, { params });
  const body = (await res.json()) as Record<string, unknown>;

  assert.equal(res.status, 200, 'with the env var unset, manual dispatch must succeed exactly as today, no matter the load');
  assert.equal(body.success, true);
  assert.equal(sends.filter((s) => s.method === 'chat.send').length, 1, 'chat.send fires normally');
  assert.notEqual(body.reason, 'dispatch_concurrency_limit');
});

// ── (2) ceiling=3, 3 in flight → manual dispatch REFUSED, chat.send never fires ──

test('[FLEET-01] ceiling=3 with 3 in flight: manual dispatch of a 4th task is REFUSED (429) naming the ceiling — chat.send never fires', async () => {
  process.env.AGENT_DISPATCH_MAX_CONCURRENT = '3';
  const { sends } = await stubGateway();
  for (let i = 0; i < 3; i++) seedInFlightTask();

  const taskId = seedDispatchableTask();
  const { req, params } = postRequest(taskId);
  const res = await POST(req, { params });
  const body = (await res.json()) as Record<string, unknown>;

  assert.equal(res.status, 429, 'a manual dispatch that would blow the ceiling is refused, not silently queued');
  assert.equal(body.success, false);
  assert.equal(body.held, true);
  assert.equal(body.reason, 'dispatch_concurrency_limit');
  assert.match(body.message as string, /3\/3/, 'the refusal message names the exact in-flight\/ceiling counts');
  assert.match(body.message as string, /AGENT_DISPATCH_MAX_CONCURRENT/, 'the refusal message names the governing env var');
  assert.equal(sends.filter((s) => s.method === 'chat.send').length, 0, 'chat.send must NEVER fire for a refused dispatch');

  // The task itself is left untouched — a true pre-send refusal, not a
  // queue-then-roll-back.
  const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(row?.status, 'backlog', 'the refused task keeps its original status');

  // Refused attempt is recorded for operator visibility (mirrors the
  // wip_limit_in_progress precedent immediately above this gate in the route).
  const failEvents = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'task_dispatch_deferred'`,
    [taskId],
  );
  assert.ok(
    failEvents.some((e) => /dispatch_concurrency_limit/.test(e.message)),
    'the refusal is recorded as a queryable, classified deferred-attempt event',
  );
});

// ── (3) ceiling=3, under capacity → manual dispatch proceeds normally ──────

test('[FLEET-01] ceiling=3 with 2 in flight: manual dispatch proceeds normally (under capacity)', async () => {
  process.env.AGENT_DISPATCH_MAX_CONCURRENT = '3';
  const { sends } = await stubGateway();
  for (let i = 0; i < 2; i++) seedInFlightTask();

  const taskId = seedDispatchableTask();
  const { req, params } = postRequest(taskId);
  const res = await POST(req, { params });
  const body = (await res.json()) as Record<string, unknown>;

  assert.equal(res.status, 200, 'under the ceiling, manual dispatch is unaffected');
  assert.equal(body.success, true);
  assert.equal(sends.filter((s) => s.method === 'chat.send').length, 1);
  assert.notEqual(body.reason, 'dispatch_concurrency_limit');
});
