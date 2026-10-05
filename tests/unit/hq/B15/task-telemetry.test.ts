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
 *
 * ANTI-MIRROR-MOCK: the fake below is B05's REAL contract —
 * `appendHqActivity(db, {companyId, installationId, event})` returning B05's
 * status union — and every captured `event` is validated against P01's frozen
 * `hqProducerEventSchema`. An earlier revision of this file mocked a B15-private
 * `captureHqTaskEvent(input)` shape that no module provides, so the seam was
 * only ever proven against itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-b15-telemetry-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'mission-control.test.db');
process.env.OPENCLAW_ROOT = path.join(TMP_DIR, 'openclaw-root');
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
type HqTypesModule = typeof import('../../../../src/lib/hq/types');
let createTaskCore: TasksModule['createTaskCore'];
let transition: LifecycleModule['transition'];
let captureHqTaskEvent: LifecycleModule['captureHqTaskEvent'];
let hqProducerEventSchema: HqTypesModule['hqProducerEventSchema'];

const RUN_ID = Math.random().toString(36).slice(2, 10);
const COMPANY = `b15-company-${RUN_ID}`;
const WS_ID = `b15-ws-${RUN_ID}`;
const AGENT_ID = `b15-agent-${RUN_ID}`;
/**
 * A SECOND company whose workspace has NO agent in it. The repo's creation-time
 * router assigns any card it can route, which is correct production behaviour —
 * so the "stays genuinely unassigned" cases run against a company with nothing
 * to route to, instead of asserting against a fixture the router is right to
 * fill.
 */
const QUIET_COMPANY = `b15-quiet-company-${RUN_ID}`;
const QUIET_WS_ID = `b15-quiet-ws-${RUN_ID}`;
const INSTALLATION = 'b15-install-1';

/**
 * Captured B05-call inputs for the current test. `event` is the frozen S7
 * producer envelope; `companyId`/`installationId` are the B05 `HqAppendInput`
 * trusted fields.
 */
let captured: Array<{ companyId: string; installationId: string; event: Record<string, unknown> }> = [];
/** When set, the fake observer throws after recording — proves observer failure is survivable. */
let observerThrows = false;
/** When set, the fake observer answers with a B05-shaped non-throwing REFUSAL. */
let observerRefusal: { status: string; code: string } | null = null;
/** Minimal shape of the handle B05 receives as its first argument. */
type WriterHandle = { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } };

/**
 * Install the fake '@/lib/hq/activity' writer, shaped exactly like B05's:
 * `appendHqActivity(db, input)` returning the `HqAppendResult` union.
 *
 * `task-lifecycle.ts` resolves the writer with `require('@/lib/hq/activity')`.
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
        appendHqActivity(
          _db: unknown,
          input: { companyId: string; installationId: string; event: Record<string, unknown> },
        ) {
          captured.push(input);
          if (observerThrows) throw new Error('observer exploded (B15 test)');
          if (observerRefusal) {
            // B05 records the bounded capture-health failure BEFORE returning a
            // refusal (SPEC S5), inside the caller's savepoint. Reproduced here,
            // against the real production DB, so the test can assert what
            // survives the caller's savepoint teardown. Best-effort by design,
            // exactly like B05's own markCaptureDegraded: a failure to record a
            // failure must not become a new failure.
            try {
              (_db as WriterHandle).prepare(
                `INSERT INTO hq_activity_state (company_id, high_seq, pruned_through_seq, capture_state, updated_at)
                 VALUES (?, 0, 0, 'degraded', ?)
                 ON CONFLICT(company_id) DO UPDATE SET capture_state = 'degraded', updated_at = excluded.updated_at`,
              ).run(input.companyId, new Date().toISOString());
            } catch { /* swallow — see comment above */ }
            return observerRefusal;
          }
          return { status: 'appended', duplicate: false, eventId: input.event.eventId, seq: captured.length, evictedThroughSeq: null };
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

  // B01 migration 169 DDL verbatim: the table B05 writes its bounded
  // capture-health failure into (SPEC S5). Created here because B01 is not on
  // this base yet; without it B05's marker write has nowhere to land and the
  // refusal-persistence question is unobservable.
  getDb().exec(
    `CREATE TABLE IF NOT EXISTS hq_activity_state (
       company_id TEXT PRIMARY KEY,
       high_seq INTEGER NOT NULL,
       pruned_through_seq INTEGER NOT NULL,
       capture_state TEXT NOT NULL,
       retained_bytes INTEGER NOT NULL DEFAULT 0,
       updated_at TEXT NOT NULL
     )`,
  );

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)`,
    [QUIET_COMPANY, QUIET_COMPANY, QUIET_COMPANY, now, now],
  );
  run(
    `INSERT INTO workspaces (id, name, slug, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'Quiet', 'quiet', 'Q', ?, 1, ?, ?)`,
    [QUIET_WS_ID, QUIET_COMPANY, now, now],
  );
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
  // The agent is inserted AFTER the first fixture so the assignment side of the
  // test has a real worker while the earlier unassigned cases already ran
  // against the agent-less company.
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
  const hqTypes = (await import('../../../../src/lib/hq/types')) as HqTypesModule;
  hqProducerEventSchema = hqTypes.hqProducerEventSchema;
});

test.after(() => {
  try { if (typeof closeDb === 'function') closeDb(); } catch { /* best-effort */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Every captured envelope must satisfy the frozen S7 contract P01 owns. */
function assertFrozenEnvelope(
  input: { companyId: string; installationId: string; event: Record<string, unknown> },
  expectedCompany: string = COMPANY,
): void {
  const parsed = hqProducerEventSchema.safeParse(input.event);
  assert.ok(
    parsed.success,
    `captured event must satisfy the frozen S7 envelope: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
  );
  assert.equal(parsed.data.kind, 'task');
  assert.equal(input.event.installationId, input.installationId, 'event and input must name the same trusted installation');
  assert.equal(input.companyId, expectedCompany, 'the trusted company is resolved from the row, not from the caller');
}

test('B15: task creation records the authoritative source audit id', async () => {
  captured = [];
  observerThrows = false;
  observerRefusal = null;
  const result = await createTaskCore(
    { title: `B15 capture ${RUN_ID}`, idempotency_company_id: COMPANY, workspace_id: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const taskId = result!.task.id;

  const creation = captured.find((entry) => entry.event.sourceKey === `activity:${taskId}`);
  assert.ok(creation, 'creation must be captured with the S5 source key activity:<taskId>');
  assertFrozenEnvelope(creation!);
  assert.equal(creation!.event.taskId, taskId);
  assert.equal(creation!.event.phase, 'created');

  // S5 freezes the creation source key as `activity:<taskId>` — the canonical
  // INSERT id of the row this write really created, never a re-minted one.
  const namedId = String(creation!.event.sourceKey).slice('activity:'.length);
  assert.equal(namedId, taskId, 'the creation source key names the row this write actually inserted');
  const eventRow = queryOne<{ id: string; task_id: string; type: string }>(
    `SELECT id, task_id, type FROM events WHERE task_id = ? AND type = 'task_created' ORDER BY rowid DESC LIMIT 1`,
    [taskId],
  );
  assert.ok(eventRow, 'the creation audit row really exists for this task');
  assert.equal(eventRow!.task_id, taskId, 'the audit row must belong to the created task');
});

test('B15: the captured event is B05-shaped — the seam calls appendHqActivity(db, input)', async () => {
  captured = [];
  observerThrows = false;
  observerRefusal = null;
  const result = await createTaskCore(
    { title: `B15 seam ${RUN_ID}`, idempotency_company_id: COMPANY, workspace_id: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const creation = captured.find((entry) => entry.event.sourceKey === `activity:${result!.task.id}`);
  assert.ok(creation, 'creation must be captured');
  // B05's HqAppendInput: trusted companyId + installationId beside the envelope,
  // never inside it, and the envelope carries every S7 key (null, not omission).
  assert.equal(typeof creation!.companyId, 'string');
  assert.equal(typeof creation!.installationId, 'string');
  for (const key of [
    'eventId', 'sourceKey', 'installationId', 'companyId', 'issuedAt', 'occurredAt', 'taskId',
    'actorRuntimeId', 'recipientRuntimeId', 'fromWorkspaceId', 'toWorkspaceId', 'exchangeId',
    'kind', 'phase', 'payload',
  ]) {
    assert.ok(key in creation!.event, `S7 envelope key present: ${key}`);
  }
  assert.deepEqual(creation!.event.payload, { status: 'backlog', previousStatus: null });
});

test('B15: unassigned creation is captured unassigned; no handoff actor is invented', async () => {
  captured = [];
  observerThrows = false;
  observerRefusal = null;
  const result = await createTaskCore(
    { title: `B15 unassigned ${RUN_ID}`, idempotency_company_id: QUIET_COMPANY, workspace_id: QUIET_WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const taskId = result!.task.id;
  const row = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?', [taskId],
  );
  assert.equal(row!.assigned_agent_id, null, 'precondition: this creation names no assignee');
  assert.equal(row!.assigned_agent_id ?? null, null, 'precondition: an unassigned card stays unassigned');

  const creation = captured.find((entry) => entry.event.sourceKey === `activity:${taskId}`);
  assert.ok(creation, 'creation must be captured');
  assertFrozenEnvelope(creation!, QUIET_COMPANY);
  // The envelope's owner claim carries the committed row's assignee, and this
  // card has none: null is the honest value, and the phase it earns is
  // 'created' — never an assignment the row does not record.
  assert.equal(creation!.event.actorRuntimeId, null, 'an unassigned card claims no owner binding, never a synthesized one');
  assert.equal(creation!.event.phase, 'created', 'a creation that assigns nobody never claims an assignment phase');
});

test('B15: a transition captures transition:<task_events.id> — the id actually written', async () => {
  captured = [];
  observerThrows = false;
  observerRefusal = null;
  const result = await createTaskCore(
    { title: `B15 transition ${RUN_ID}`, idempotency_company_id: COMPANY, workspace_id: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const taskId = result!.task.id;
  captured = [];

  await transition(taskId, 'planning', { actor: 'b15-test-actor', reason: 'B15 capture proof', operatorOverride: true });

  const transitionCapture = captured.find((entry) => String(entry.event.sourceKey).startsWith('transition:'));
  assert.ok(transitionCapture, 'the transition must be captured under the transition:<auditId> source key');
  assertFrozenEnvelope(transitionCapture!);
  assert.equal(transitionCapture!.event.phase, 'status_changed');
  assert.deepEqual(transitionCapture!.event.payload, { status: 'planning', previousStatus: 'backlog' });

  const auditId = String(transitionCapture!.event.sourceKey).slice('transition:'.length);
  const auditRow = queryOne<{ id: string; task_id: string; from_status: string; to_status: string; actor: string | null }>(
    'SELECT id, task_id, from_status, to_status, actor FROM task_events WHERE id = ?', [auditId],
  );
  assert.ok(auditRow, 'the captured audit id must name the task_events row that was really inserted');
  assert.equal(auditRow!.task_id, taskId);
  assert.equal(auditRow!.to_status, 'planning');
  assert.equal(auditRow!.actor, 'b15-test-actor', 'the real actor is carried verbatim from the source audit row');
});

test('B15: observer failure does not lose the business write (create and transition both survive)', async () => {
  captured = [];
  observerThrows = true;

  // Creation with a throwing observer.
  const created = await createTaskCore(
    { title: `B15 observer-failure ${RUN_ID}`, idempotency_company_id: COMPANY, workspace_id: WS_ID, skipWindowDedup: true },
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

test('B15: a NON-THROWING refusal is reported, never counted as a capture', async () => {
  captured = [];
  observerThrows = false;
  observerRefusal = { status: 'capture_failed', code: 'capture_failed' };

  // The refusal is returned as a degraded reason naming B05's status/code.
  const refused = captureHqTaskEvent({
    sourceKey: 'transition:refusal-probe', auditId: 'refusal-probe', taskId: 'b15-refusal-probe', companyId: COMPANY,
    fromStatus: 'planning', toStatus: 'planning', actor: null, occurredAt: new Date().toISOString(),
  });
  assert.equal(refused, 'capture_failed', 'a non-throwing refusal must be surfaced, not reported as success');
  assert.equal(captured.length, 1, 'the refusal arm really reached the writer');

  // The same refusal on the real business path must not lose the write either.
  const created = await createTaskCore(
    { title: `B15 refusal ${RUN_ID}`, idempotency_company_id: COMPANY, workspace_id: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(created, 'a refused capture must not roll back the business write');
  assert.equal(
    queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [created!.task.id])!.status,
    'backlog',
    'the created row survives a refused capture',
  );

  observerRefusal = null;
});

test('B15: a refusal leaves B05\'s durable capture-health record intact (the caller must not erase it)', async () => {
  captured = [];
  observerThrows = false;
  // Clear any marker a previous case left, so the assertion below is unambiguous.
  run('DELETE FROM hq_activity_state WHERE company_id = ?', [COMPANY]);
  assert.equal(
    queryOne<{ capture_state: string }>('SELECT capture_state FROM hq_activity_state WHERE company_id = ?', [COMPANY]),
    undefined,
    'precondition: no capture-health row before the refusal',
  );

  observerRefusal = { status: 'receipt_capacity', code: 'receipt_capacity' };
  const refused = captureHqTaskEvent({
    sourceKey: 'transition:refusal-durability', auditId: 'refusal-durability', taskId: 'b15-refusal-durability',
    companyId: COMPANY, fromStatus: 'planning', toStatus: 'planning', actor: null, occurredAt: new Date().toISOString(),
  });
  assert.equal(refused, 'receipt_capacity', 'the refusal code is surfaced as the degraded reason');

  // SPEC S5: B05's refusal is not silent — it recorded the bounded
  // capture-health failure before returning. That record is the ONLY durable
  // evidence the capture was refused; a caller that rolls its savepoint back
  // erases it and leaves a refused capture looking clean.
  const state = queryOne<{ capture_state: string }>(
    'SELECT capture_state FROM hq_activity_state WHERE company_id = ?', [COMPANY],
  );
  assert.ok(state, 'the capture-health row B05 wrote for the refusal must still exist after the caller returns');
  assert.equal(state!.capture_state, 'degraded', 'the refusal must leave a durable degraded capture-health marker');

  // Control: an accepted capture leaves no degraded marker (the instrument
  // discriminates between the two arms rather than always reporting degraded).
  run('DELETE FROM hq_activity_state WHERE company_id = ?', [COMPANY]);
  observerRefusal = null;
  const ok = captureHqTaskEvent({
    sourceKey: 'transition:accepted-control', auditId: 'accepted-control', taskId: 'b15-accepted-control',
    companyId: COMPANY, fromStatus: 'planning', toStatus: 'planning', actor: null, occurredAt: new Date().toISOString(),
  });
  assert.equal(ok, null, 'control: the accepted arm still reports success');
  assert.equal(
    queryOne<{ capture_state: string }>('SELECT capture_state FROM hq_activity_state WHERE company_id = ?', [COMPANY]),
    undefined,
    'control: an accepted capture writes no degraded marker of its own',
  );
});

test('B15: the observer is the only writer — the post-transaction SSE broadcast adds no second capture', async () => {
  captured = [];
  observerThrows = false;
  observerRefusal = null;
  const result = await createTaskCore(
    { title: `B15 single-writer ${RUN_ID}`, idempotency_company_id: COMPANY, workspace_id: WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const taskId = result!.task.id;
  captured = [];

  await transition(taskId, 'planning', { actor: 'b15-test-actor', operatorOverride: true });

  const forThisTask = captured.filter((entry) => entry.event.taskId === taskId);
  assert.equal(forThisTask.length, 1, 'exactly one capture per transition — broadcast() must not add a second');
  assert.equal(forThisTask[0].event.phase, 'status_changed');
  assert.deepEqual(forThisTask[0].event.payload, { status: 'planning', previousStatus: 'backlog' });
});

test('B15: a real assignment is recorded distinctly from an unassigned task', async () => {
  captured = [];
  observerRefusal = null;
  const assigned = await createTaskCore(
    { title: `B15 assigned ${RUN_ID}`, idempotency_company_id: COMPANY, workspace_id: WS_ID, assigned_agent_id: AGENT_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(assigned, 'assigned task must be created');
  const assignedId = assigned!.task.id;
  const assignedRow = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?', [assignedId],
  );
  assert.equal(assignedRow!.assigned_agent_id, AGENT_ID, 'precondition: the assignee really is stored');

  const assignedCapture = captured.find((entry) => entry.event.sourceKey === `activity:${assignedId}`);
  assert.ok(assignedCapture, 'assigned creation must be captured');
  // The frozen S7 envelope is the only shape B05 accepts; `actorRuntimeId` is
  // where a task event's owner claim rides, and it carries the REAL committed
  // assignee (never the audit row's display actor, which names no runtime).
  assert.equal(
    assignedCapture!.event.actorRuntimeId,
    AGENT_ID,
    'the real committed assignee is what a task event claims as its owner binding',
  );

  // Unassigned sibling: same code path, no assignee, and the two must differ.
  captured = [];
  const unassigned = await createTaskCore(
    { title: `B15 unassigned sibling ${RUN_ID}`, idempotency_company_id: QUIET_COMPANY, workspace_id: QUIET_WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(unassigned, 'unassigned task must be created');
  const unassignedId = unassigned!.task.id;
  const unassignedCapture = captured.find((entry) => entry.event.sourceKey === `activity:${unassignedId}`);
  assert.ok(unassignedCapture, 'unassigned creation must be captured');
  const assignedStored = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?', [assignedId],
  )!.assigned_agent_id;
  const unassignedStored = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?', [unassignedId],
  )!.assigned_agent_id;
  assert.ok(assignedStored, 'the assigned card really is assigned in the row');
  assert.equal(unassignedStored, null, 'the sibling really is unassigned in the row');
  assert.notEqual(
    assignedStored,
    unassignedStored,
    'a real assignment must be DISTINCT from an unassigned task in the stored record',
  );
});

test('B15: a transition that assigns names the assigned phase; an unrelated transition does not', async () => {
  captured = [];
  observerRefusal = null;
  // Created in the agent-less company so the creation-time router genuinely
  // cannot assign it: this card must still be UNASSIGNED when the transition
  // below assigns it, or the phase being proven would be unobservable.
  const result = await createTaskCore(
    { title: `B15 assign-transition ${RUN_ID}`, idempotency_company_id: QUIET_COMPANY, workspace_id: QUIET_WS_ID, skipWindowDedup: true },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const taskId = result!.task.id;
  assert.equal(
    queryOne<{ assigned_agent_id: string | null }>('SELECT assigned_agent_id FROM tasks WHERE id = ?', [taskId])!.assigned_agent_id,
    null,
    'precondition: the card really is unassigned before the assignment transition',
  );
  // The worker that transition assigns, in the same company — a cross-company
  // binding would be refused by B05's own same-company check on the real base.
  const quietAgentId = `b15-quiet-agent-${RUN_ID}`;
  run(
    `INSERT INTO agents (id, name, role, workspace_id, status, is_master, created_at, updated_at)
     VALUES (?, 'B15 Quiet Specialist', 'specialist', ?, 'standby', 0, ?, ?)`,
    [quietAgentId, QUIET_WS_ID, new Date().toISOString(), new Date().toISOString()],
  );
  captured = [];

  // The transition itself carries the assignment (extraColumns is how the real
  // conversion pattern assigns inside the same atomic UPDATE).
  await transition(taskId, 'assigned', {
    actor: 'b15-test-actor',
    operatorOverride: true,
    extraColumns: { assigned_agent_id: quietAgentId },
  });

  const capture = captured.find((entry) => entry.event.taskId === taskId);
  assert.ok(capture, 'the assignment transition must be captured');
  assertFrozenEnvelope(capture!, QUIET_COMPANY);
  assert.equal(capture!.event.phase, 'assigned', 'a proven ownership change is phase assigned');
  assert.equal(capture!.event.actorRuntimeId, quietAgentId, 'the envelope carries the assignee the row now records');
  assert.equal(
    queryOne<{ assigned_agent_id: string | null }>('SELECT assigned_agent_id FROM tasks WHERE id = ?', [taskId])!.assigned_agent_id,
    quietAgentId,
    'the stored row really carries that assignee — the phase states a committed change, not an invented one',
  );

  // Control: a LATER transition that changes nothing about ownership must not
  // claim an assignment phase. The unchanged real assignee is what is carried.
  captured = [];
  await transition(taskId, 'in_progress', { actor: 'b15-test-actor', operatorOverride: true });
  const laterCapture = captured.find((entry) => entry.event.taskId === taskId);
  assert.ok(laterCapture, 'the later transition must still be captured');
  assert.equal(laterCapture!.event.phase, 'status_changed', 'an unrelated transition is a status change, never an assignment');
  assert.equal(
    queryOne<{ assigned_agent_id: string | null }>('SELECT assigned_agent_id FROM tasks WHERE id = ?', [taskId])!.assigned_agent_id,
    quietAgentId,
    'the unchanged real assignee is carried — not re-invented, not cleared',
  );
});
