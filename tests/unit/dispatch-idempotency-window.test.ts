/**
 * DISPATCH-IDEMPOTENCY-WINDOW (2026-08-27) — duplicate manual dispatch
 * suppression regression lock.
 *
 * DEFECT (live, task f4a2de9a 2026-08-27): the manual "Send to Agent" route
 * (src/app/api/tasks/[id]/dispatch/route.ts) had NO status precondition except
 * `blocked`. A second POST 25s after a successful dispatch fired a FULL second
 * chat.send — the agent received the same task twice (live task_activities
 * rows 18:54:12.794Z and 18:54:37.814Z; model_runtime_confirmed events
 * 19:02:43 / 19:03:23). The gateway-side idempotencyKey (DISP-01) only
 * collapses CONCURRENT sends; two sends seconds apart both fire.
 *
 * CONTRACT under test (operator re-dispatch semantics preserved — the
 * intentional-re-dispatch comment on the route stays true):
 *   1. RAPID duplicate (same task, same agent, within the window) →
 *      SUPPRESSED with a VISIBLE `duplicate_dispatch_suppressed` events row +
 *      task_activities row. Never a silent drop, never a second chat.send.
 *   2. The SAME dispatch after the window elapses → dispatches normally.
 *   3. An EXPLICIT override ({ force: true } body) → ALWAYS dispatches, even
 *      inside the window.
 *   4. A REASSIGNMENT (dispatch event for a DIFFERENT agent) → never
 *      suppressed; assign-elsewhere-and-push keeps working flagless.
 *   5. BLOCKED-task behavior UNCHANGED: a blocked task without
 *      acknowledgeBlock still gets 409 blocked_requires_acknowledgement —
 *      the new gate sits AFTER the blocked/owner-killed gates and cannot
 *      shadow their refusals.
 *
 * Strategy: isolated temp DB + REAL route handler (import POST) + the one
 * network boundary stubbed on the singleton client (isConnected/call), the
 * exact pattern tests/unit/dispatch-canonical-alias-reverse-probe.test.ts
 * established for end-to-end dispatch proofs. Model sovereignty is cleared
 * with a REAL model_registry row + a role agent_settings pin; write-back auth
 * passes via ALLOW_INSECURE_OPEN_API.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts --test \
 *     tests/unit/dispatch-idempotency-window.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated DB (BEFORE any '@/lib/db' import) ───────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dispatch-idem-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Invalid gateway URL — connect() rejects synchronously in new URL(), zero
// open handles. The success-path tests stub the client below like
// dispatch-canonical-alias-reverse-probe.test.ts does.
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

// Fake $HOME so resolveSpecialistSessionKey resolves a REAL runtime dir. The
// workspace slug is 'testdept' (no hyphen → role slug 'dept-test-operations'
// never collides) and the dir is the workspace-slug bare form, which attempt 1
// probes second.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dispatch-idem-home-'));
const AGENTS_ROOT = path.join(TMP_HOME, '.openclaw', 'agents');
fs.mkdirSync(path.join(AGENTS_ROOT, 'testdept'), { recursive: true });
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.OPENCLAW_PLATFORM = 'mac-mini';

// Clear the UNRELATED gates between the new window and the send: write-back
// auth (dev open mode) and a REAL sovereign model via agent_settings pin +
// a model_registry row the sovereignty inventory can see.
process.env.ALLOW_INSECURE_OPEN_API = 'true';
process.env.SOVEREIGN_DEFAULT_MODEL = 'test-provider/test-model-v1';

// No skill roots → matchSkillsForTask degrades to [] (keyword path needs
// files; empty roots short-circuit before any network).
process.env.CC_SKILL_ROOTS = path.join(TMP_HOME, 'no-skills-here');

// Hermetic rescue webhook (notifySystem must never POST anywhere).
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/[id]/dispatch/route');
let POST: RouteModule['POST'];

const AGENT_A = 'agent-idem-a';
const AGENT_B = 'agent-idem-b';
const WS_ID = 'ws-idem-test';

const MODEL_ID = 'test-provider/test-model-v1';

/** Build a NextRequest-shaped POST body for the route handler. */
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

function insertTask(id: string, assignedAgent: string, status = 'in_progress'): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id,
       workspace_id, business_id, department, dispatch_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'medium', ?, ?, NULL, 'testdept', 0, ?, ?)`,
    [id, `Idempotency task ${id}`, 'Duplicate-dispatch regression task.', status, assignedAgent, WS_ID, now, now],
  );
}

/** Record a prior SUCCESSFUL dispatch event (the window's anchor). */
function insertDispatchEvent(taskId: string, agentId: string, ageMs: number): void {
  run(
    `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
     VALUES (?, 'task_dispatched', ?, ?, ?, ?)`,
    [
      `evt-${taskId}-${agentId}-${ageMs}`,
      agentId,
      taskId,
      `Task "${taskId}" dispatched to ${agentId}`,
      new Date(Date.now() - ageMs).toISOString(),
    ],
  );
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb(); // full migration chain against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, company_id) VALUES (?, 'testdept', 'Test Dept', 'default')`,
    [WS_ID],
  );
  for (const [id, name] of [
    [AGENT_A, 'Idem Agent A'],
    [AGENT_B, 'Idem Agent B'],
  ] as const) {
    run(
      `INSERT INTO agents (id, name, role, is_master, specialist_type, workspace_id, status, created_at, updated_at)
       VALUES (?, ?, 'Test Operations', 0, 'permanent', ?, 'standby', ?, ?)`,
      [id, name, WS_ID, now, now],
    );
    // Role-level model pin (Layer 2) — a REAL sovereign model, no free default.
    run(
      `INSERT INTO agent_settings (id, department_id, role_id, setting_type, value)
       VALUES (?, 'testdept', ?, 'model', ?)`,
      [`as-${id}`, id, MODEL_ID],
    );
  }
  // Sovereignty inventory: the pinned model must exist, be active, text-capable.
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

/** Stub the gateway boundary (same pattern as the alias-reverse-probe suite). */
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

test('[IDEM-1] rapid duplicate (same task, same agent, 5s after) is SUPPRESSED with a visible event — no second chat.send', async () => {
  const { sends } = await stubGateway();
  const taskId = 'idem-rapid-dup';
  insertTask(taskId, AGENT_A);
  // The first successful dispatch, 5 seconds ago — inside the 120s window.
  insertDispatchEvent(taskId, AGENT_A, 5_000);

  const { req, params } = postRequest(taskId);
  const res = await POST(req, { params });
  const body = await res.json() as Record<string, unknown>;

  assert.equal(res.status, 409, 'duplicate POST is refused (409), not dispatched');
  assert.equal(body.success, false);
  assert.equal(body.suppressed, true);
  assert.equal(body.reason, 'duplicate_within_idempotency_window');
  assert.equal(sends.length, 0, 'NO chat.send may fire for a suppressed duplicate');

  // VISIBLE: queryable events row.
  const events = queryAll<{ type: string; message: string }>(
    `SELECT type, message FROM events WHERE task_id = ? AND type = 'duplicate_dispatch_suppressed'`,
    [taskId],
  );
  assert.equal(events.length, 1, 'exactly one visible duplicate_dispatch_suppressed event');
  assert.ok(
    events[0].message.includes('force'),
    'the suppression message must document the explicit force override',
  );

  // VISIBLE: Activity tab row too.
  const acts = queryAll<{ activity_type: string }>(
    `SELECT activity_type FROM task_activities WHERE task_id = ? AND activity_type = 'duplicate_dispatch_suppressed'`,
    [taskId],
  );
  assert.equal(acts.length, 1, 'exactly one duplicate_dispatch_suppressed task_activities row');

  // The task status is untouched — suppression is a no-op, not a transition.
  const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(row?.status, 'in_progress');
});

test('[IDEM-2] the same dispatch AFTER the window elapses dispatches normally', async () => {
  const { sends } = await stubGateway();
  const taskId = 'idem-after-window';
  insertTask(taskId, AGENT_A);
  insertDispatchEvent(taskId, AGENT_A, 10 * 60_000); // 10 minutes ago — window long gone

  const { req, params } = postRequest(taskId);
  const res = await POST(req, { params });
  const body = await res.json() as Record<string, unknown>;

  assert.equal(res.status, 200, 'post-window re-dispatch succeeds');
  assert.equal(body.success, true, 'a plain re-POST after the window dispatches exactly as before');
  assert.equal(sends.filter((s) => s.method === 'chat.send').length, 1, 'exactly one chat.send fires');
  assert.equal(body.suppressed, undefined, 'a normal dispatch carries no suppression marker');

  const suppressed = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'duplicate_dispatch_suppressed'`,
    [taskId],
  );
  assert.equal(suppressed.length, 0, 'no suppression event for a legitimate post-window dispatch');
});

test('[IDEM-3] an explicit { force: true } override ALWAYS dispatches, even inside the window', async () => {
  const { sends } = await stubGateway();
  const taskId = 'idem-force-override';
  insertTask(taskId, AGENT_A);
  insertDispatchEvent(taskId, AGENT_A, 2_000); // 2s ago — deep inside the window

  const { req, params } = postRequest(taskId, { force: true });
  const res = await POST(req, { params });
  const body = await res.json() as Record<string, unknown>;

  assert.equal(res.status, 200);
  assert.equal(body.success, true, 'a deliberate force re-dispatch is never blocked');
  assert.equal(sends.filter((s) => s.method === 'chat.send').length, 1, 'chat.send fired for the forced dispatch');
  assert.equal(body.suppressed, undefined);

  const suppressed = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'duplicate_dispatch_suppressed'`,
    [taskId],
  );
  assert.equal(suppressed.length, 0, 'no suppression event when the operator forced the send');
});

test('[IDEM-4] a REASSIGNMENT (prior dispatch to a DIFFERENT agent) is never suppressed', async () => {
  const { sends } = await stubGateway();
  const taskId = 'idem-reassign';
  insertTask(taskId, AGENT_B);
  insertDispatchEvent(taskId, AGENT_A, 5_000); // prior send went to agent A

  const { req, params } = postRequest(taskId);
  const res = await POST(req, { params });
  const body = await res.json() as Record<string, unknown>;

  assert.equal(res.status, 200, 'assign-elsewhere-and-push works with no flag');
  assert.equal(body.success, true);
  assert.equal(sends.filter((s) => s.method === 'chat.send').length, 1, 'the reassignment dispatch actually fires');
});

test('[IDEM-6] BLOCKED-task behavior is UNCHANGED — acknowledgeBlock still required, suppression never shadows it', async () => {
  await stubGateway();
  const taskId = 'idem-blocked-task';
  insertTask(taskId, AGENT_A, 'blocked');
  // A very recent dispatch event would suppress any in_progress re-POST; the
  // blocked gate must still win because it runs FIRST.
  insertDispatchEvent(taskId, AGENT_A, 1_000);

  const { req, params } = postRequest(taskId); // no acknowledgeBlock body
  const res = await POST(req, { params });
  const body = await res.json() as Record<string, unknown>;

  assert.equal(res.status, 409, 'blocked task still refuses without acknowledgement');
  assert.equal(body.reason, 'blocked_requires_acknowledgement', 'refusal is the BLOCKED gate, not the idempotency window');
  assert.equal(body.suppressed, undefined, 'the blocked refusal must not be confused with a suppressed duplicate');

  const suppressed = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'duplicate_dispatch_suppressed'`,
    [taskId],
  );
  assert.equal(suppressed.length, 0, 'the blocked gate fires before any suppression bookkeeping');
});

test('[IDEM-5] env knob: DISPATCH_IDEMPOTENCY_WINDOW_SECONDS=0 disables the window entirely (rapid duplicate dispatches)', async () => {
  const { sends } = await stubGateway();
  process.env.DISPATCH_IDEMPOTENCY_WINDOW_SECONDS = '0';
  try {
    const taskId = 'idem-window-zero';
    insertTask(taskId, AGENT_A);
    insertDispatchEvent(taskId, AGENT_A, 5_000);

    const { req, params } = postRequest(taskId);
    const res = await POST(req, { params });
    const body = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 200, 'window=0 restores the pre-fix behavior (no suppression)');
    assert.equal(body.success, true);
    assert.equal(sends.filter((s) => s.method === 'chat.send').length, 1);
  } finally {
    delete process.env.DISPATCH_IDEMPOTENCY_WINDOW_SECONDS;
  }
});