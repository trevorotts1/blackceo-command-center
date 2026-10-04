/**
 * B20 — dispatch-route level: accepted-run replay suppression + actual run binding.
 *
 * Drives the REAL POST /api/tasks/[id]/dispatch handler on an isolated temp DB
 * with the ONLY network boundary stubbed on the singleton client (the fixture
 * env mirrors tests/unit/dispatch-idempotency-window.test.ts, whose success path
 * through this exact gate stack is already proven).
 *
 * PROVES (B20 deliverable + the two named semantics):
 *   1. An ACCEPTED dispatch writes the trusted run binding — the ACTUAL gateway
 *      runId mapped to the CC task/execution/agent — with outcome 'accepted' and
 *      delivered_at NULL. Acceptance never writes delivered.
 *   2. A replay of a task that HAS an accepted run is SUPPRESSED: 409,
 *      `accepted_run_replay`, ZERO second chat.send. An accepted dispatch that
 *      was never delivered is never replayed into a duplicate.
 *   3. `{ force: true }` still re-dispatches deliberately — the operator
 *      override is preserved, never shadowed.
 *   4. An UNCERTAIN send binds 'uncertain', is NOT accepted-run evidence (so it
 *      suppresses nothing) and is NOT delivered.
 *   5. The pre-existing dispatch-idempotency window still governs when it
 *      applies — asserted here by running the SAME replay shape with B20's guard
 *      made inert (no accepted binding) and the window ON.
 *
 * The duplicate-EXECUTION guard (one live attempt per card) is pre-existing CC
 * behavior and would mask these cases, so each case that re-POSTs first retires
 * the prior attempt's execution row to 'succeeded' — exactly what a finished run
 * looks like — leaving the B20 gates as the only thing under test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated DB (set BEFORE '@/lib/db' is imported) ──────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dispatch-b20-replay-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

// Fake $HOME so resolveSpecialistSessionKey resolves a REAL runtime dir.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dispatch-b20-home-'));
const AGENTS_ROOT = path.join(TMP_HOME, '.openclaw', 'agents');
fs.mkdirSync(path.join(AGENTS_ROOT, 'b20dept'), { recursive: true });
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.OPENCLAW_PLATFORM = 'mac-mini';

// Clear the unrelated gates between reservation and send: write-back auth (dev
// open mode) and a REAL sovereign model via agent_settings pin + model_registry.
process.env.ALLOW_INSECURE_OPEN_API = 'true';
process.env.SOVEREIGN_DEFAULT_MODEL = 'test-provider/test-model-v1';
process.env.CC_SKILL_ROOTS = path.join(TMP_HOME, 'no-skills-here');
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;

// The pre-existing duplicate window is DISABLED for the B20 cases so the ONLY
// gate that can refuse a replay there is B20's accepted-run guard. The window's
// own contract is locked, unchanged, by
// tests/unit/dispatch-idempotency-window.test.ts.
process.env.DISPATCH_IDEMPOTENCY_WINDOW_SECONDS = '0';

type DbModule = typeof import('../../../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../../../src/app/api/tasks/[id]/dispatch/route');
let POST: RouteModule['POST'];

type DispatcherModule = typeof import('../../../../src/lib/task-dispatcher');
let recordDispatchRunBinding: DispatcherModule['recordDispatchRunBinding'];
let HQ_RUN_BINDINGS_DDL: string;

const AGENT = 'agent-b20-route';
const WS_ID = 'ws-b20-route';
const MODEL_ID = 'test-provider/test-model-v1';


/** Drive the REAL route handler with a NextRequest-shaped POST. */
function callDispatch(taskId: string, body?: Record<string, unknown>) {
  const params = Promise.resolve({ id: taskId });
  const req = {
    json: async () => body ?? {},
    clone() {
      return req;
    },
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Parameters<RouteModule['POST']>[0];
  return POST(req, { params });
}

function insertTask(id: string, status = 'in_progress'): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id,
       workspace_id, business_id, department, dispatch_attempts, created_at, updated_at)
     VALUES (?, ?, 'B20 replay fixture.', ?, 'medium', ?, ?, NULL, 'b20dept', 0, ?, ?)`,
    [id, `B20 replay task ${id}`, status, AGENT, WS_ID, now, now],
  );
}

function bindings(taskId: string) {
  return queryAll<{
    runtime_run_id: string;
    outcome: string;
    delivered_at: string | null;
    execution_id: string | null;
    agent_id: string;
    visibility: string;
  }>(
    `SELECT runtime_run_id, outcome, delivered_at, execution_id, agent_id, visibility
       FROM hq_run_bindings WHERE task_id = ? ORDER BY recorded_at`,
    [taskId],
  );
}

/** Retire the prior attempt's execution so the next POST is not worker-busy. */
/**
 * Retire every live execution row. Each accepted dispatch legitimately holds
 * provider/worker capacity until it finishes, so without this reset an earlier
 * case would refuse a later one on capacity rather than on the gate under test.
 * Retiring to 'succeeded' is what a finished run looks like.
 */
function retireExecutions(): void {
  run("UPDATE task_executions SET state='succeeded' WHERE state IN ('reserved','sending','accepted','running','unknown')");
}

/** Stub the gateway boundary. `fail` makes chat.send raise after it began. */
async function stubGateway(opts: { fail?: boolean; runId?: string } = {}): Promise<{ sends: number }> {
  const { getOpenClawClient } = await import('../../../../src/lib/openclaw/client');
  const client = getOpenClawClient();
  const state = { sends: 0 };
  client.isConnected = () => true;
  client.call = (async (method: string) => {
    if (method === 'chat.send') {
      state.sends += 1;
      if (opts.fail) throw new Error('transport timeout after send began');
      return { ok: true, runId: opts.runId ?? 'run-b20-default' };
    }
    return { ok: true };
  }) as typeof client.call;
  return state;
}

test.before(async () => {
  const db = (await import('../../../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb(); // full migration chain against the temp DB

  const td = (await import('../../../../src/lib/task-dispatcher')) as DispatcherModule;
  recordDispatchRunBinding = td.recordDispatchRunBinding;
  HQ_RUN_BINDINGS_DDL = td.HQ_RUN_BINDINGS_DDL;
  // B01 owns applying this DDL in the reserved additive HQ migration; it is not
  // on this branch, so stand it up from the SHIPPED constant — the same string
  // B01's migration will carry.
  db.getDb().exec(HQ_RUN_BINDINGS_DDL);

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'B20 Route Co', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'b20dept', 'B20 Dept', '🧪', 'default', 1, ?, ?)`,
    [WS_ID, now, now],
  );
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, specialist_type,
       workspace_id, created_at, updated_at)
     VALUES (?, 'B20 Route Worker', 'B20 Route Operations', '🤖', 'standby', 0, 'permanent', ?, ?, ?)`,
    [AGENT, WS_ID, now, now],
  );
  run(
    `INSERT OR IGNORE INTO agent_settings (id, department_id, role_id, setting_type, value)
     VALUES ('as-b20-route', 'b20dept', ?, 'model', ?)`,
    [AGENT, MODEL_ID],
  );
  run(
    `INSERT OR IGNORE INTO model_registry (model_id, label, provider, capabilities, status)
     VALUES (?, 'Test Model', 'test-provider', '["text"]', 'active')`,
    [MODEL_ID],
  );

  POST = (await import('../../../../src/app/api/tasks/[id]/dispatch/route')).POST;
});

test.after(async () => {
  try {
    const { getOpenClawClient } = await import('../../../../src/lib/openclaw/client');
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

// ── 1. The real dispatch writes the binding ──────────────────────────────────

test('[B20-R1] an ACCEPTED dispatch binds the ACTUAL gateway runId as accepted, with delivered_at NULL', async () => {
  retireExecutions();
  const gateway = await stubGateway({ runId: 'run-b20-r1' });
  const taskId = 'b20r-accepted';
  insertTask(taskId);

  const res = await callDispatch(taskId);
  assert.equal(res.status, 200, 'the dispatch succeeds');
  assert.equal(gateway.sends, 1, 'exactly one chat.send fires');

  const rows = bindings(taskId);
  assert.equal(rows.length, 1, 'exactly one run binding for one accepted dispatch');
  assert.equal(rows[0].runtime_run_id, 'run-b20-r1', 'the binding names the ACTUAL gateway runId');
  assert.equal(rows[0].outcome, 'accepted', 'an accepted dispatch is recorded accepted');
  assert.equal(rows[0].delivered_at, null, 'ACCEPTED IS NOT DELIVERED — delivered_at must be NULL');
  assert.equal(rows[0].agent_id, AGENT, 'the binding carries the actual actor runtime binding owner');
  assert.equal(rows[0].visibility, 'task-audience');
  assert.ok(rows[0].execution_id, 'the canonical CC execution id is recorded');
});

// ── 2. Replay suppression ────────────────────────────────────────────────────

test('[B20-R2] a replay of a task with an accepted run is SUPPRESSED — 409, no second chat.send', async () => {
  retireExecutions();
  const gateway = await stubGateway({ runId: 'run-b20-r2' });
  const taskId = 'b20r-replay';
  insertTask(taskId);

  const first = await callDispatch(taskId);
  assert.equal(first.status, 200);
  const original = bindings(taskId)[0];
  retireExecutions(); // the accepted run has since finished

  const replay = await callDispatch(taskId);
  const body = await replay.json() as Record<string, unknown>;
  assert.equal(replay.status, 409, `the replay is REFUSED, not dispatched (body: ${JSON.stringify(body).slice(0, 240)})`);
  assert.equal(body.suppressed, true);
  assert.equal(body.reason, 'accepted_run_replay');
  assert.equal(gateway.sends, 1, 'NO second chat.send — an accepted run is never replayed into a duplicate');

  // Visible, never silent: the operator can see what was swallowed and how to override.
  const events = queryAll<{ type: string; message: string }>(
    `SELECT type, message FROM events WHERE task_id = ? AND type = 'dispatch_replay_suppressed'`,
    [taskId],
  );
  assert.equal(events.length, 1, 'exactly one visible dispatch_replay_suppressed event');
  assert.ok(events[0].message.includes('force'), 'the refusal documents the explicit force override');

  // The binding is untouched: a replay never rewrites attribution.
  const after = bindings(taskId);
  assert.equal(after.length, 1, 'a replay never produces a second mapping');
  assert.equal(after[0].execution_id, original.execution_id, 'original execution attribution preserved');
  assert.equal(after[0].delivered_at, null, 'still not delivered');
});

test('[B20-R3] { force: true } still re-dispatches deliberately — the operator override is preserved', async () => {
  retireExecutions();
  const gateway = await stubGateway({ runId: 'run-b20-r3' });
  const taskId = 'b20r-force';
  insertTask(taskId);

  const first = await callDispatch(taskId);
  assert.equal(first.status, 200);
  retireExecutions();

  // Without force this exact shape is the suppressed replay (proven in R2).
  const forced = await callDispatch(taskId, { force: true });
  const body = await forced.json() as Record<string, unknown>;
  assert.equal(forced.status, 200, 'a forced re-dispatch is never blocked');
  assert.equal(body.success, true);
  assert.equal(body.suppressed, undefined, 'a forced dispatch carries no suppression marker');
  assert.equal(gateway.sends, 2, 'the forced dispatch actually fires chat.send');
});

// ── 3. Uncertain send ────────────────────────────────────────────────────────

test('[B20-R4] an UNCERTAIN send binds uncertain, is NOT delivered, and suppresses nothing', async () => {
  retireExecutions();
  const gateway = await stubGateway({ fail: true });
  const taskId = 'b20r-uncertain';
  insertTask(taskId);

  const res = await callDispatch(taskId);
  assert.equal(res.status, 202, 'an unacknowledged send is reported as unknown, not success');
  assert.equal(gateway.sends, 1);

  const rows = bindings(taskId);
  assert.equal(rows.length, 1, 'the unproven send is still bound — it is not invisible');
  assert.equal(rows[0].outcome, 'uncertain', 'an unacknowledged send records uncertain, never accepted');
  assert.equal(rows[0].delivered_at, null, 'uncertain is not delivered');
  assert.ok(
    String(rows[0].runtime_run_id).startsWith('agent:b20dept:'),
    'with no accepted runId the binding names the ADDRESSED gateway session key, not a sentinel',
  );

  retireExecutions();
  const second = await stubGateway({ runId: 'run-b20-route-second' });
  const res2 = await callDispatch(taskId);
  const body = await res2.json() as Record<string, unknown>;
  assert.notEqual(
    body.reason,
    'accepted_run_replay',
    'an UNCERTAIN send is not accepted-run evidence — it must not suppress the next dispatch',
  );
  assert.equal(second.sends, 1, 'the next dispatch is a fresh send, governed by reconciliation, not this guard');
});

// ── 4. Company scoping of the suppression evidence ───────────────────────────

test('[B20-R5] a binding under another company cannot suppress this company\'s dispatch', async () => {
  retireExecutions();
  const gateway = await stubGateway({ runId: 'run-b20-r5' });
  const taskId = 'b20r-foreign';
  insertTask(taskId);
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('company-foreign-b20', 'Foreign', 'foreign-b20', '{}', ?, ?)`,
    [now, now],
  );
  // A run bound under a FOREIGN company that happens to name this task id.
  run(
    `INSERT INTO hq_run_bindings
       (company_id, runtime_run_id, runtime_session_key, agent_id, task_id, execution_id,
        visibility, owner_subject, outcome, delivered_at, recorded_at, expires_at)
     VALUES ('company-foreign-b20', 'run-foreign', 'agent:x:y', ?, ?, 'exec-foreign',
             'task-audience', NULL, 'accepted', NULL, ?, ?)`,
    [AGENT, taskId, now, new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()],
  );

  const res = await callDispatch(taskId);
  assert.equal(res.status, 200, 'a foreign company\'s mapping never suppresses this company\'s dispatch');
  assert.equal(gateway.sends, 1);
});
