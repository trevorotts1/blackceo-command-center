/**
 * JEV-012 CC auto-route + fenced continuation tests (spec 1.1, s 5.5).
 *
 * Offline: isolated temp DB (own module row, no shared mission-control.db),
 * zero network (fetch throws), zero model keys, Telegram sends suppressed.
 * The DB helper runs real migrations, so tasks/workspaces/agents/companies/
 * task_executions/events tables behave like production.
 *
 * A16-style: the REAL QC-failure -> autoRouteTask() -> dispatch path. The
 * QC correction retains task ID + preference provenance (same task row, same
 * preference row, qc_reroute_attempts + 1) and the executor stays the
 * explicitly requested assistant/worker. A normal-delegation case proves
 * legitimate rerouting still works.
 *
 * A64-style: an owner edit + kill/archive + another execution reservation
 * raced against an awaited route result. The stale commit loses the fence:
 * no assignment write, no assignment-success notice, no dispatch from the
 * stale result.
 *
 * Never a bare `owner_direct` boolean from text: authorization comes only
 * from the durable preference row / server-side routing marker. Caller text
 * is never consulted (no such input exists on this path at all).
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-d12-autoroute-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(root, 'fixture.db'),
  CC_TEST_FIXTURE_ROOT: root,
  OPENCLAW_ROOT: path.join(root, 'openclaw'),
  OPENCLAW_COMPANY_ROOT: path.join(root, 'company'),
  WORKSPACE_BASE_PATH: root,
  OPENCLAW_WORKSPACE_ROOT: root,
  BCC_DEVICE_IDENTITY_DIR: path.join(root, 'identity'),
  OPENCLAW_CLI_BIN: '/usr/bin/false',
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
  SOP_EMBEDDING_PROVIDER: 'openai',
  OPENAI_API_KEY: '',
  QC_MAX_REROUTES: '5',
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('D12 fixture forbids network'); };

type Db = typeof import('../../src/lib/db');
type AutoRoute = typeof import('../../src/lib/routing/auto-route');
type Seam = typeof import('../../src/lib/routing/owner-direct-continuation');
type Router = typeof import('../../src/lib/routing/department-router');

let db: Db;
let autoRouteTask: AutoRoute['autoRouteTask'];
let readAutoRouteSnapshot: Seam['readAutoRouteSnapshot'];
let commitAutoRouteDecision: Seam['commitAutoRouteDecision'];
let markOwnerDirectReason: Seam['markOwnerDirectReason'];
let routeTaskDecision: Router['routeTaskDecision'];

const COMPANY = 'd12-co';
const WS_ENG = 'ws-d12-eng';
const WS_GEN = 'ws-d12-gen';
const AGENT_WORKER = 'agent-d12-worker';
const AGENT_OTHER = 'agent-d12-other';
const NOW = '2026-09-25T00:00:00.000Z';
let serial = 0;

function worker(id: string, ws: string, master: number, status = 'standby'): void {
  db.run(
    'INSERT INTO agents(id,name,role,workspace_id,is_master,status,specialist_type) VALUES(?,?,?,?,?,?,?)',
    [id, id, 'Specialist', ws, master, status, 'permanent'],
  );
}

function makeTask(over: Record<string, unknown> = {}): string {
  const id = `d12-task-${++serial}`;
  db.run(
    `INSERT INTO tasks(id,title,description,priority,status,department,workspace_id,assigned_agent_id,
       assignment_version,routing_reason,qc_reroute_attempts,dispatch_hold,updated_at,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, over.title ?? 'Fix the widget', over.description ?? 'owner wants the widget fixed',
      'medium', over.status ?? 'backlog', over.department ?? 'Engineering',
      over.workspace_id ?? WS_ENG, over.assigned_agent_id ?? null,
      over.assignment_version ?? 1, over.routing_reason ?? null,
      over.qc_reroute_attempts ?? 0, over.dispatch_hold ?? 0, NOW, NOW,
    ],
  );
  return id;
}

function pinPreference(taskId: string, preference: 'current_assistant' | 'named_worker', executor: string): void {
  // Additive DDL: CREATE TABLE IF NOT EXISTS inside the writer's own
  // transaction in production (ensurePreferenceTable); IF NOT EXISTS here so
  // the test never depends on migration order.
  db.run(
    `CREATE TABLE IF NOT EXISTS task_execution_preferences (
       task_id TEXT PRIMARY KEY, preference TEXT NOT NULL, executor_agent_id TEXT,
       evidence TEXT, policy_revision INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`, [],
  );
  db.run(
    `INSERT INTO task_execution_preferences(task_id,preference,executor_agent_id,evidence,policy_revision,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?)`,
    [taskId, preference, executor, 'owner instruction evidence', 1, NOW, NOW],
  );
}

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  ({ autoRouteTask } = await import('../../src/lib/routing/auto-route'));
  ({ readAutoRouteSnapshot, commitAutoRouteDecision, markOwnerDirectReason } =
    await import('../../src/lib/routing/owner-direct-continuation'));
  ({ routeTaskDecision } = await import('../../src/lib/routing/department-router'));
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [COMPANY, COMPANY, COMPANY]);
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [WS_ENG, 'Engineering', 'engineering', COMPANY]);
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [WS_GEN, 'General Task', 'general-task', COMPANY]);
  worker(AGENT_WORKER, WS_ENG, 0);
  worker(AGENT_OTHER, WS_GEN, 0);
  fs.mkdirSync(path.join(root, 'openclaw', 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'openclaw', 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'main' }] } }));
});

test.after(() => {
  globalThis.fetch = originalFetch;
  db?.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Snapshot reader: fences load BEFORE routing ──────────────────────────────

test('snapshot reads preference, revisions, and ownership before routing', () => {
  const id = makeTask({ assigned_agent_id: AGENT_WORKER });
  pinPreference(id, 'named_worker', AGENT_WORKER);
  const snap = readAutoRouteSnapshot(id);
  assert.ok(snap);
  assert.equal(snap.preference, 'named_worker');
  assert.equal(snap.prefExecutorAgentId, AGENT_WORKER);
  assert.equal(snap.assignedAgentId, AGENT_WORKER);
  assert.equal(snap.assignmentVersion, 1);
  assert.equal(snap.activeExecution, null);
  assert.equal(snap.killed, false);
});

test('snapshot on an unmarked task is normal delegation', () => {
  const snap = readAutoRouteSnapshot(makeTask());
  assert.ok(snap);
  assert.equal(snap.preference, 'normal_delegation');
});

test('snapshot sees a live execution and kill/archive state', () => {
  const live = makeTask();
  db.run(
    `INSERT INTO task_executions(id,task_id,assignment_version,agent_id,workspace_id,generation,session_key,session_id,
       state,lease_owner,lease_expires_at,idempotency_key,created_at,updated_at)
     VALUES(?,?,?,?,?,1,?,?, 'running','fixture','2099-01-01',?,?,?)`,
    [`ex-${live}`, live, 1, AGENT_WORKER, WS_ENG, `sk-${live}`, `sid-${live}`, `idem-${live}`, NOW, NOW],
  );
  assert.equal(readAutoRouteSnapshot(live)?.activeExecution?.state, 'running');
  const killed = makeTask({ description: 'OWNER KILLED by owner' });
  assert.equal(readAutoRouteSnapshot(killed)?.killed, true);
});

// ── Fenced commit: one transaction, stale writes nothing ─────────────────────

test('commit writes executor + preference + event atomically', () => {
  const id = makeTask();
  const snap = readAutoRouteSnapshot(id)!;
  const ok = commitAutoRouteDecision(snap, {
    agentId: AGENT_WORKER, agentName: AGENT_WORKER, department: 'Engineering',
    workspaceId: WS_ENG, companyId: COMPANY, reason: 'keyword match',
    preference: 'normal_delegation', preferenceEvidence: null,
  });
  assert.equal(ok, true);
  const row = db.queryOne<{ assigned_agent_id: string; assignment_version: number }>(
    'SELECT assigned_agent_id, assignment_version FROM tasks WHERE id = ?', [id]);
  assert.equal(row?.assigned_agent_id, AGENT_WORKER);
  assert.equal(row?.assignment_version, 2);
  assert.equal(
    db.queryOne<{ n: number }>(
      "SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'task_assigned'", [id])?.n, 1);
  assert.equal(
    db.queryOne<{ preference: string }>(
      'SELECT preference FROM task_execution_preferences WHERE task_id = ?', [id])?.preference,
    'normal_delegation');
});

test('stale assignment_version loses: no write, no event', () => {
  const id = makeTask();
  const snap = readAutoRouteSnapshot(id)!;
  db.run('UPDATE tasks SET assigned_agent_id = ?, assignment_version = assignment_version + 1 WHERE id = ?',
    [AGENT_OTHER, id]); // owner edit lands while routing awaited
  const ok = commitAutoRouteDecision(snap, {
    agentId: AGENT_WORKER, agentName: AGENT_WORKER, department: 'Engineering',
    workspaceId: WS_ENG, companyId: COMPANY, reason: 'stale result',
    preference: 'normal_delegation', preferenceEvidence: null,
  });
  assert.equal(ok, false);
  assert.equal(
    db.queryOne<{ assigned_agent_id: string }>(
      'SELECT assigned_agent_id FROM tasks WHERE id = ?', [id])?.assigned_agent_id, AGENT_OTHER);
  assert.equal(
    db.queryOne<{ n: number }>('SELECT COUNT(*) n FROM events WHERE task_id = ?', [id])?.n, 0);
});

test('kill/archive and live execution each refuse the commit', () => {
  const killed = makeTask();
  db.run('UPDATE tasks SET killed_at = ? WHERE id = ?', [NOW, killed]);
  const killedSnap = { ...readAutoRouteSnapshot(killed)!, killed: true };
  assert.equal(commitAutoRouteDecision(killedSnap, {
    agentId: AGENT_WORKER, agentName: AGENT_WORKER, department: 'Engineering',
    workspaceId: WS_ENG, companyId: COMPANY, reason: 'x',
    preference: 'normal_delegation', preferenceEvidence: null,
  }), false);

  const live = makeTask();
  db.run(
    `INSERT INTO task_executions(id,task_id,assignment_version,agent_id,workspace_id,generation,session_key,session_id,
       state,lease_owner,lease_expires_at,idempotency_key,created_at,updated_at)
     VALUES(?,?,?,?,?,1,?,?, 'unknown','fixture','2099-01-01',?, ?,?)`,
    [`ex-${live}`, live, 1, AGENT_WORKER, WS_ENG, `sk-${live}`, `sid-${live}`, `idem-${live}`, NOW, NOW],
  );
  assert.equal(commitAutoRouteDecision(readAutoRouteSnapshot(live)!, {
    agentId: AGENT_WORKER, agentName: AGENT_WORKER, department: 'Engineering',
    workspaceId: WS_ENG, companyId: COMPANY, reason: 'x',
    preference: 'normal_delegation', preferenceEvidence: null,
  }), false);
});

test('offline and foreign-company executors are refused', () => {
  const id = makeTask();
  db.run("UPDATE agents SET status = 'offline' WHERE id = ?", [AGENT_OTHER]);
  try {
    assert.equal(commitAutoRouteDecision(readAutoRouteSnapshot(id)!, {
      agentId: AGENT_OTHER, agentName: AGENT_OTHER, department: 'General Task',
      workspaceId: WS_GEN, companyId: COMPANY, reason: 'x',
      preference: 'normal_delegation', preferenceEvidence: null,
    }), false);
  } finally {
    db.run("UPDATE agents SET status = 'standby' WHERE id = ?", [AGENT_OTHER]);
  }
  assert.equal(commitAutoRouteDecision(readAutoRouteSnapshot(id)!, {
    agentId: AGENT_WORKER, agentName: AGENT_WORKER, department: 'Engineering',
    workspaceId: WS_ENG, companyId: 'foreign-co', reason: 'x',
    preference: 'normal_delegation', preferenceEvidence: null,
  }), false);
});

// ── A16-style: real QC-failure -> autoRouteTask() -> dispatch/resume ─────────
// The task below is ALREADY QC-failed (qc_reroute_attempts bumped, back in
// backlog, preference row intact) — exactly the row the scorer hands over —
// and autoRouteTask runs end to end with injected route/dispatch seams so no
// model call or gateway send happens, while the ORDER (snapshot -> route with
// preference -> fenced commit -> notice + dispatch only on commit) is the
// production one.

test('A16: QC failure keeps the pinned executor through autoRouteTask', async () => {
  const id = makeTask({
    status: 'backlog', assigned_agent_id: AGENT_WORKER,
    assignment_version: 2, routing_reason: markOwnerDirectReason('owner named worker'),
    qc_reroute_attempts: 1,
  });
  pinPreference(id, 'named_worker', AGENT_WORKER);
  let dispatched = 0;
  let notified: string | null = null;
  const result = await autoRouteTask(id, WS_ENG, {
    routeTask: (async (t: { target_agent?: string | null }) => {
      assert.equal(t.target_agent, AGENT_WORKER); // preference passed through to routing
      const decision = await routeTaskDecision({
        title: 'Fix the widget', priority: 'medium',
        workspace_id: WS_ENG, company_id: COMPANY, target_agent: AGENT_WORKER,
      });
      assert.equal(decision.status, 'assigned');
      if (decision.status !== 'assigned') throw new Error('pin must resolve');
      return decision.routing;
    }) as never,
    dispatch: async () => { dispatched++; return { status: 'acknowledged', reason: 'fixture' }; },
    notifyAssigned: (taskId) => { notified = taskId; },
  });
  assert.equal(result.routed, true);
  if (!result.routed) return;
  assert.equal(result.agentId, AGENT_WORKER); // executor stays the requested worker
  assert.ok(result.reason.startsWith('[owner-direct]'));
  const row = db.queryOne<{ assigned_agent_id: string; department: string; qc_reroute_attempts: number }>(
    'SELECT assigned_agent_id, department, qc_reroute_attempts FROM tasks WHERE id = ?', [id]);
  assert.equal(row?.assigned_agent_id, AGENT_WORKER);
  assert.equal(row?.qc_reroute_attempts, 1); // correction retains ID + provenance
  assert.equal(
    db.queryOne<{ preference: string }>(
      'SELECT preference FROM task_execution_preferences WHERE task_id = ?', [id])?.preference,
    'named_worker');
  assert.equal(dispatched, 1);
  assert.equal(notified, id);
});

test('A16 companion: normal delegation still reroutes to the best worker', async () => {
  const id = makeTask({ status: 'backlog', qc_reroute_attempts: 1 });
  let dispatched = 0;
  const result = await autoRouteTask(id, WS_ENG, {
    routeTask: (async () => {
      const decision = await routeTaskDecision({
        title: 'Fix the widget', priority: 'medium',
        workspace_id: WS_ENG, company_id: COMPANY,
      });
      assert.equal(decision.status, 'assigned');
      if (decision.status !== 'assigned') throw new Error('must route');
      return decision.routing;
    }) as never,
    dispatch: async () => { dispatched++; return { status: 'acknowledged', reason: 'fixture' }; },
    notifyAssigned: () => {},
  });
  assert.equal(result.routed, true);
  if (!result.routed) return;
  assert.ok(!result.reason.startsWith('[owner-direct]'));
  assert.equal(
    db.queryOne<{ assigned_agent_id: string }>(
      'SELECT assigned_agent_id FROM tasks WHERE id = ?', [id])?.assigned_agent_id,
    result.agentId);
  assert.equal(dispatched, 1);
});

test('A16: QC cap holds on the auto-route path', async () => {
  const id = makeTask({ status: 'backlog', qc_reroute_attempts: 5 });
  const result = await autoRouteTask(id, WS_ENG, {
    dispatch: async () => { throw new Error('must not dispatch'); },
    notifyAssigned: () => { throw new Error('must not notify'); },
  });
  assert.equal(result.routed, false);
  if (result.routed) return;
  assert.match(result.reason, /cap/i);
});

test('A16: unavailable pinned executor holds, never silently delegates', async () => {
  const id = makeTask({ status: 'backlog', qc_reroute_attempts: 1 });
  pinPreference(id, 'named_worker', 'agent-d12-gone');
  let routeCalls = 0;
  const result = await autoRouteTask(id, WS_ENG, {
    routeTask: (async () => { routeCalls++; return null; }) as never,
    dispatch: async () => { throw new Error('must not dispatch'); },
    notifyAssigned: () => { throw new Error('must not notify'); },
  });
  assert.equal(result.routed, false);
  assert.equal(routeCalls, 1); // routing ran; the pin refusal is explicit, not a skip
  assert.equal(
    db.queryOne<{ assigned_agent_id: string | null }>(
      'SELECT assigned_agent_id FROM tasks WHERE id = ?', [id])?.assigned_agent_id, null);
});

// ── A64-style: owner edit + kill/archive + reservation vs awaited result ─────

test('A64: owner edit during routing -> stale result writes nothing', async () => {
  const id = makeTask({ status: 'backlog' });
  const snap = readAutoRouteSnapshot(id)!;
  let resolveRoute!: (v: { agentId: string; agentName: string; department: string; score: number; reason: string; workspaceId: string; companyId: string }) => void;
  const gate = new Promise<typeof snap extends never ? never : {
    agentId: string; agentName: string; department: string; score: number;
    reason: string; workspaceId: string; companyId: string;
  }>((res) => { resolveRoute = res; });
  let dispatched = 0;
  const flight = autoRouteTask(id, WS_ENG, {
    routeTask: (() => gate) as never,
    dispatch: async () => { dispatched++; return { status: 'acknowledged', reason: 'fixture' }; },
    notifyAssigned: () => { throw new Error('stale result must not notify'); },
  });
  db.run('UPDATE tasks SET department = ? WHERE id = ?', ['General Task', id]); // owner edit wins
  resolveRoute({
    agentId: AGENT_WORKER, agentName: AGENT_WORKER, department: 'Engineering',
    score: 1, reason: 'stale classification', workspaceId: WS_ENG, companyId: COMPANY,
  });
  const result = await flight;
  assert.equal(result.routed, false);
  if (result.routed) return;
  assert.equal(result.failure, 'assignment-race');
  assert.equal(
    db.queryOne<{ assigned_agent_id: string | null }>(
      'SELECT assigned_agent_id FROM tasks WHERE id = ?', [id])?.assigned_agent_id, null);
  assert.equal(dispatched, 0);
});

test('A64: kill/archive during routing -> stale result writes nothing', async () => {
  for (const kill of [true, false]) {
    const id = makeTask({ status: 'backlog' });
    let dispatched = 0;
    const flight = autoRouteTask(id, WS_ENG, {
      routeTask: (async () => {
        await new Promise((r) => setTimeout(r, 5)); // routing awaits; the kill lands first
        return {
          agentId: AGENT_WORKER, agentName: AGENT_WORKER, department: 'Engineering',
          score: 1, reason: 'stale classification', workspaceId: WS_ENG, companyId: COMPANY,
        };
      }) as never,
      dispatch: async () => { dispatched++; return { status: 'acknowledged', reason: 'fixture' }; },
      notifyAssigned: () => { throw new Error('stale result must not notify'); },
    });
    if (kill) db.run('UPDATE tasks SET killed_at = ? WHERE id = ?', [NOW, id]);
    else db.run('UPDATE tasks SET archived_at = ? WHERE id = ?', [NOW, id]);
    const result = await flight;
    assert.equal(result.routed, false, kill ? 'killed' : 'archived');
    assert.equal(dispatched, 0);
  }
});

test('A64: competing reservation during routing -> stale result writes nothing', async () => {
  const id = makeTask({ status: 'backlog' });
  let dispatched = 0;
  const flight = autoRouteTask(id, WS_ENG, {
    routeTask: (async () => {
      await new Promise((r) => setTimeout(r, 5));
      return {
        agentId: AGENT_WORKER, agentName: AGENT_WORKER, department: 'Engineering',
        score: 1, reason: 'stale classification', workspaceId: WS_ENG, companyId: COMPANY,
      };
    }) as never,
    dispatch: async () => { dispatched++; return { status: 'acknowledged', reason: 'fixture' }; },
    notifyAssigned: () => { throw new Error('stale result must not notify'); },
  });
  db.run(
    `INSERT INTO task_executions(id,task_id,assignment_version,agent_id,workspace_id,generation,session_key,session_id,
       state,lease_owner,lease_expires_at,idempotency_key,created_at,updated_at)
     VALUES(?,?,?,?,?,1,?,?, 'reserved','fixture','2099-01-01',?, ?,?)`,
    [`ex-${id}`, id, 1, AGENT_OTHER, WS_GEN, `sk-${id}`, `sid-${id}`, `idem-${id}`, NOW, NOW],
  ); // another reservation wins while routing awaited
  const result = await flight;
  assert.equal(result.routed, false);
  assert.equal(dispatched, 0);
  assert.equal(
    db.queryOne<{ assigned_agent_id: string | null }>(
      'SELECT assigned_agent_id FROM tasks WHERE id = ?', [id])?.assigned_agent_id, null);
  assert.equal(
    db.queryOne<{ n: number }>(
      "SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'task_assigned'", [id])?.n, 0);
});
