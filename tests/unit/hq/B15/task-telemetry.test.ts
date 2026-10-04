/**
 * B15 — task create/lifecycle telemetry (SPEC S5 capture boundaries).
 *
 * Proves the four things the B15 card actually claims, against the REAL write
 * paths (`createTaskCore`, `transition`, `recordStatusEvent`) on a throwaway DB:
 *
 *   1. Observer failure does not lose the business write — a throwing HQ
 *      observer leaves the task created and the transition committed.
 *   2. Capture carries the AUTHORITATIVE source audit id: the
 *      `transition:<task_events.id>` / `activity:<taskId>` that the business
 *      write really produced, not a fresh id minted for the observer.
 *   3. Assignment is recorded distinctly: an unassigned task is captured as
 *      unassigned, and NO handoff actor is invented when the source names none.
 *   4. There is exactly ONE writer: the SSE broadcast after the transaction can
 *      never add a second captured event.
 *
 * The observer is injected by intercepting the module `require` for
 * '@/lib/hq/activity' — the same seam the lifecycle funnel resolves — so the
 * real production code path runs unmodified with no mock shipped in src/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-b15-telemetry-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'mission-control.test.db');
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
delete process.env.OPENCLAW_GATEWAY_TOKEN;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

type DbModule = typeof import('../../../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type TasksModule = typeof import('../../../../src/lib/tasks');
type LifecycleModule = typeof import('../../../../src/lib/task-lifecycle');
let createTaskCore: TasksModule['createTaskCore'];
let transition: LifecycleModule['transition'];
let captureHqTaskEvent: LifecycleModule['captureHqTaskEvent'];

const RUN_ID = Math.random().toString(36).slice(2, 10);
const COMPANY = `b15-company-${RUN_ID}`;
const WS_ID = `b15-ws-${RUN_ID}`;
const AGENT_ID = `b15-agent-${RUN_ID}`;

/** Captured observer inputs for the current test. */
let captured: Array<Record<string, unknown>> = [];
/** When set, the fake observer throws after recording — proves observer failure is survivable. */
let observerThrows = false;

/**
 * Install the fake '@/lib/hq/activity' observer.
 *
 * `task-lifecycle.ts` resolves the observer with `require('@/lib/hq/activity')`.
 * Patching `Module._load` here intercepts exactly that request for every
 * subsequent call, without touching any repository source.
 */
function installObserver(): void {
  const load = (Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load;
  (Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load = function patched(
    request: string, parent: unknown, isMain: boolean,
  ) {
    if (request === '@/lib/hq/activity') {
      return {
        captureHqTaskEvent(input: Record<string, unknown>) {
          captured.push(input);
          if (observerThrows) throw new Error('observer exploded (B15 test)');
          return true;
        },
      };
    }
    return load.call(this as unknown, request, parent, isMain);
  };
}

test.before(async () => {
  installObserver();
  const db = (await import('../../../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // full migration chain on the throwaway DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)`,
    [COMPANY, COMPANY, COMPANY, now, now],
  );
  run(
    `INSERT INTO workspaces (id, name, slug, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'Marketing', 'marketing', 'M', ?, 1, ?, ?)`,
    [WS_ID, COMPANY, now, now],
  );
  // One real worker in that department: the "distinct real assignment" side.
  run(
    `INSERT INTO agents (id, name, role, workspace_id, status, is_master, created_at, updated_at)
     VALUES (?, 'B15 Specialist', 'specialist', ?, 'standby', 0, ?, ?)`,
    [AGENT_ID, WS_ID, now, now],
  );

  const tasks = (await import('../../../../src/lib/tasks')) as TasksModule;
  createTaskCore = tasks.createTaskCore;
  const lifecycle = (await import('../../../../src/lib/task-lifecycle')) as LifecycleModule;
  transition = lifecycle.transition;
  captureHqTaskEvent = lifecycle.captureHqTaskEvent;
});

test.after(() => {
  try { if (typeof closeDb === 'function') closeDb(); } catch { /* best-effort */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test('B15: task creation records the authoritative source audit id', async () => {
  captured = [];
  observerThrows = false;
  const result = await createTaskCore(
    { title: `B15 capture ${RUN_ID}`, idempotency_company_id: COMPANY, workspaceId: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const taskId = result!.task.id;

  const creation = captured.find((entry) => entry.sourceKey === `activity:${taskId}`);
  assert.ok(creation, 'creation must be captured with the S5 source key activity:<taskId>');
  assert.equal(creation!.taskId, taskId);
  assert.equal(creation!.companyId, COMPANY, 'the owning company is resolved from the row, not from the caller');

  // The audit id must be the id of a real `events` row written for THIS task.
  const auditId = creation!.auditId as string;
  const eventRow = queryOne<{ id: string; task_id: string; type: string }>(
    'SELECT id, task_id, type FROM events WHERE id = ?', [auditId],
  );
  assert.ok(eventRow, 'the captured audit id must name a row that really exists');
  assert.equal(eventRow!.task_id, taskId, 'the audit row must belong to the created task');
  assert.equal(eventRow!.type, 'task_created');
});

test('B15: unassigned creation is captured unassigned; no handoff actor is invented', async () => {
  captured = [];
  observerThrows = false;
  const result = await createTaskCore(
    { title: `B15 unassigned ${RUN_ID}`, idempotency_company_id: COMPANY, workspaceId: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const taskId = result!.task.id;
  const row = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?', [taskId],
  );
  assert.equal(row!.assigned_agent_id, null, 'precondition: this creation names no assignee');

  const creation = captured.find((entry) => entry.sourceKey === `activity:${taskId}`);
  assert.ok(creation, 'creation must be captured');
  assert.equal(creation!.actor, null, 'an unnamed creator must stay null, never a synthesized actor');
});

test('B15: a transition captures transition:<task_events.id> — the id actually written', async () => {
  captured = [];
  observerThrows = false;
  const result = await createTaskCore(
    { title: `B15 transition ${RUN_ID}`, idempotency_company_id: COMPANY, workspaceId: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const taskId = result!.task.id;
  captured = [];

  await transition(taskId, 'planning', { actor: 'b15-test-actor', reason: 'B15 capture proof', operatorOverride: true });

  const transitionCapture = captured.find((entry) => String(entry.sourceKey).startsWith('transition:'));
  assert.ok(transitionCapture, 'the transition must be captured under the transition:<auditId> source key');
  const auditId = String(transitionCapture!.sourceKey).slice('transition:'.length);
  assert.equal(transitionCapture!.auditId, auditId);

  const auditRow = queryOne<{ id: string; task_id: string; from_status: string; to_status: string; actor: string | null }>(
    'SELECT id, task_id, from_status, to_status, actor FROM task_events WHERE id = ?', [auditId],
  );
  assert.ok(auditRow, 'the captured audit id must name the task_events row that was really inserted');
  assert.equal(auditRow!.task_id, taskId);
  assert.equal(auditRow!.to_status, 'planning');
  assert.equal(auditRow!.actor, 'b15-test-actor', 'the real actor is carried verbatim from the source audit row');
  assert.equal(transitionCapture!.actor, 'b15-test-actor');
});

test('B15: observer failure does not lose the business write (create and transition both survive)', async () => {
  captured = [];
  observerThrows = true;

  // Creation with a throwing observer.
  const created = await createTaskCore(
    { title: `B15 observer-failure ${RUN_ID}`, idempotency_company_id: COMPANY, workspaceId: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(created, 'the task must still be created when the observer throws');
  const taskId = created!.task.id;
  const taskRow = queryOne<{ id: string; status: string }>('SELECT id, status FROM tasks WHERE id = ?', [taskId]);
  assert.ok(taskRow, 'the business write must survive: the task row exists');

  // Transition with the same throwing observer.
  const before = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])!.status;
  await transition(taskId, 'planning', { actor: 'b15-test-actor', operatorOverride: true });
  const after = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])!.status;
  assert.equal(before, 'backlog');
  assert.equal(after, 'planning', 'the transition must commit even though the observer threw');
  const audit = queryOne<{ id: string }>(
    `SELECT id FROM task_events WHERE task_id = ? AND to_status = 'planning' ORDER BY created_at DESC LIMIT 1`,
    [taskId],
  );
  assert.ok(audit, 'the audit row must still be written');

  // And the failure is REPORTED, not swallowed silently.
  const degraded = captureHqTaskEvent({
    sourceKey: 'transition:direct-probe', auditId: 'direct-probe', taskId, companyId: COMPANY,
    fromStatus: 'planning', toStatus: 'planning', actor: null, occurredAt: new Date().toISOString(),
  });
  assert.equal(degraded, 'observer_failed', 'a failing observer must be reported as degraded capture');

  observerThrows = false;
});

test('B15: the observer is the only writer — the post-transaction SSE broadcast adds no second capture', async () => {
  captured = [];
  observerThrows = false;
  const result = await createTaskCore(
    { title: `B15 single-writer ${RUN_ID}`, idempotency_company_id: COMPANY, workspaceId: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const taskId = result!.task.id;
  captured = [];

  await transition(taskId, 'planning', { actor: 'b15-test-actor', operatorOverride: true });

  const forThisTask = captured.filter((entry) => entry.taskId === taskId);
  assert.equal(forThisTask.length, 1, 'exactly one capture per transition — broadcast() must not add a second');
  assert.equal(forThisTask[0].toStatus, 'planning');
});

test('B15: a real assignment is recorded distinctly from an unassigned task', async () => {
  const assigned = await createTaskCore(
    { title: `B15 assigned ${RUN_ID}`, idempotency_company_id: COMPANY, workspaceId: WS_ID, assigned_agent_id: AGENT_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(assigned, 'assigned task must be created');
  const assignedId = assigned!.task.id;
  const assignedRow = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?', [assignedId],
  );
  assert.equal(assignedRow!.assigned_agent_id, AGENT_ID, 'precondition: the assignee really is stored');

  const assignedCapture = captured.find((entry) => entry.sourceKey === `activity:${assignedId}`);
  assert.ok(assignedCapture, 'assigned creation must be captured');
  assert.equal(assignedCapture!.assignedAgentId, AGENT_ID, 'the capture must carry the REAL stored assignee');

  // Unassigned sibling: same code path, no assignee, and the two must differ.
  captured = [];
  const unassigned = await createTaskCore(
    { title: `B15 unassigned sibling ${RUN_ID}`, idempotency_company_id: COMPANY, workspaceId: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(unassigned, 'unassigned task must be created');
  const unassignedId = unassigned!.task.id;
  const unassignedCapture = captured.find((entry) => entry.sourceKey === `activity:${unassignedId}`);
  assert.ok(unassignedCapture, 'unassigned creation must be captured');
  assert.equal(unassignedCapture!.assignedAgentId, null, 'an unassigned task is captured as unassigned, never credited to an invented actor');
  assert.notEqual(
    assignedCapture!.assignedAgentId,
    unassignedCapture!.assignedAgentId,
    'a real assignment must be DISTINCT from an unassigned task in the captured record',
  );
});

test('B15: a transition that assigns records the real post-transition assignee; an unrelated transition does not invent one', async () => {
  captured = [];
  const result = await createTaskCore(
    { title: `B15 assign-transition ${RUN_ID}`, idempotency_company_id: COMPANY, workspaceId: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const taskId = result!.task.id;
  captured = [];

  // The transition itself carries the assignment (extraColumns is how the real
  // conversion pattern assigns inside the same atomic UPDATE).
  await transition(taskId, 'assigned', {
    actor: 'b15-test-actor',
    operatorOverride: true,
    extraColumns: { assigned_agent_id: AGENT_ID },
  });

  const capture = captured.find((entry) => entry.taskId === taskId);
  assert.ok(capture, 'the assignment transition must be captured');
  assert.equal(capture!.assignedAgentId, AGENT_ID, 'the capture must state the assignment that actually committed');

  const stored = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?', [taskId],
  );
  assert.equal(stored!.assigned_agent_id, capture!.assignedAgentId, 'capture and stored row must agree — no invented assignee');

  // Control: a LATER transition that changes nothing about ownership must not
  // credit the card to anyone. Silence about the actor is correct; a carried-over
  // or synthesized handoff actor would be the invented one this proves against.
  captured = [];
  await transition(taskId, 'in_progress', { actor: 'b15-test-actor', operatorOverride: true });
  const laterCapture = captured.find((entry) => entry.taskId === taskId);
  assert.ok(laterCapture, 'the later transition must still be captured');
  assert.equal(laterCapture!.assignedAgentId, AGENT_ID, 'the unchanged real assignee is carried — not re-invented, not cleared');
});
