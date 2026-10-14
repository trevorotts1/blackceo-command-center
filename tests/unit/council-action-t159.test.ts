/**
 * CWE-036 T159 race proof (directive Sections 17.6, 19.6; Section 35
 * contract T159): "A dispatcher sweep between every plan-assembly
 * step cannot execute a dependent or unapproved action before the
 * barrier is released."
 *
 * The assembly exposes a step hook after every assembly step (verify
 * approval, persist the barrier, each task create, each edge
 * resolution, readiness confirmation, assembly completion, each
 * per-task release evaluation). These tests inject the repository's
 * REAL dispatcher machinery at every one of those points:
 * autoDispatchTask on every council task of the session,
 * normalizeIntakeForDispatch on every one, and the dispatch-intent
 * sweep. After each injection they assert, from the database:
 *
 * - no task that has not been released through the execution guard
 *   has any task_executions row, any agent assignment, a cleared
 *   hold, or a status other than backlog;
 * - the council parent task is never dispatched either.
 *
 * Variants: no grant at all; an admitting grant (the independent task
 * releases at the final step and only then leaves the barrier's
 * scope; its dependent never releases and never executes); and a
 * cancel delivered mid-assembly, after which every created task ends
 * visibly blocked through the official lifecycle, never deleted and
 * never dispatched.
 */
import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;

import type { ActionProposal, Verdict } from '../../src/lib/council/contracts';
import type { CouncilPrincipal } from '../../src/lib/council/auth';
import type { CouncilRepositories, CouncilStoredSession } from '../../src/lib/council/store';
import type {
  CouncilRunAuthorizationPort,
  RunGrantReference,
  RunGrantResolution,
  RunPreview,
  RunScopeRef,
} from '../../src/lib/council/kanban/run-authorization-port';
import type { AssemblyStepEvent } from '../../src/lib/council/kanban/action-assembly';

type Db = import('better-sqlite3').Database;

let db: Db;
let repositories: CouncilRepositories;
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let SCHEMA_VERSIONS: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let planService: InstanceType<typeof import('../../src/lib/council/kanban/plan-service').CouncilActionPlanService>;
let Assembly: typeof import('../../src/lib/council/kanban/action-assembly').CouncilPlanAssembly;
let Guard: typeof import('../../src/lib/council/kanban/action-execution').CouncilActionExecutionGuard;
let autoDispatchTaskFn: typeof import('../../src/lib/task-dispatcher').autoDispatchTask;
let normalizeIntakeForDispatchFn: typeof import('../../src/lib/jobs/intake-advance-sweep').normalizeIntakeForDispatch;
let runDispatchIntentSweepFn: typeof import('../../src/lib/jobs/dispatch-intents').runDispatchIntentSweep;
let closeDbFn: () => void;

const OWNER = 'owner-1';

function principal(subject: string): CouncilPrincipal {
  return {
    subject,
    tenantKind: 'client',
    channel: 'browser',
    supportAccess: false,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'inst-a',
      owner_subject: null,
    },
    tenant: {
      tenantId: 'tenant-a',
      companyId: 'company-a',
      clientId: 'client-a',
      kind: 'client',
      subject,
      host: 'council-a.test',
      installationId: 'inst-a',
    },
  } as CouncilPrincipal;
}

class AdmittingGrantPort implements CouncilRunAuthorizationPort {
  async previewRun(_input: RunScopeRef): Promise<RunPreview> {
    throw new Error('previewRun is not part of this fixture');
  }

  async approveRun(_input: RunScopeRef & { preview_sha256: string }): Promise<RunGrantReference> {
    throw new Error('approveRun is not part of this fixture');
  }

  async resolveRunGrant(input: RunScopeRef & { grant_ref?: string | null }): Promise<RunGrantResolution> {
    return {
      status: 'active',
      grant_ref: 'grant-t159',
      session_id: input.session_id,
      scope_sha256: 'fixture-scope',
    };
  }

  async revokeRunGrant(): Promise<{ revoked: boolean }> {
    return { revoked: true };
  }

  async admitOperation(): Promise<{ admitted: boolean }> {
    return { admitted: true };
  }

  async recordConsumption(): Promise<{ recorded: boolean }> {
    return { recorded: true };
  }
}

function makeStoredSession(sessionId: string): CouncilStoredSession {
  const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.visibility = 'company';
  spec.brief_sha256 = canonicalHashFn(brief);
  const stored: CouncilStoredSession = {
    spec,
    brief,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'inst-a',
      owner_subject: null,
    },
    state: {
      schema_version: 'wise-elders.session-state/v1',
      session_id: sessionId,
      mode: spec.mode,
      state: 'DRAFT',
      state_version: 0,
      brief_revision: brief.revision,
      resume_phase: null,
      cancel_generation: 0,
      revocation_generation: 0,
      attempt: 1,
      lease_epoch: 0,
      archived: false,
      updated_at: spec.created_at,
    },
    sample: false,
  };
  const envelope = envelopeFromScopeFn(stored.scope, OWNER, 'owner', 'write');
  repositories.createSession(envelope, stored);
  return stored;
}

function makeAction(sessionId: string, actionId: string, overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    action_id: actionId,
    session_id: sessionId,
    verdict_revision: 1,
    title: `Carry out ${actionId}`,
    description: `Description for ${actionId}.`,
    rationale: 'The council advised this bounded step.',
    source_condition_ids: [],
    department_id: null,
    assigned_agent_id: null,
    sop_id: null,
    persona_id: null,
    acceptance_criteria: ['The step is complete and evidenced.'],
    budget_limit: { amount_minor: 5000, currency: 'USD' },
    due_at: null,
    depends_on_action_ids: [],
    risk_class: 'medium',
    execution_authorization_required: true,
    ...overrides,
  };
}

function makeVerdict(session: CouncilStoredSession, actions: ActionProposal[]): Verdict {
  const base = {
    schema_version: SCHEMA_VERSIONS.verdict,
    result_kind: 'scored' as const,
    session_id: session.spec.session_id,
    verdict_revision: 1,
    recommended_option_id: 'B',
    label: 'WAIT' as const,
    option_scores: [],
    active_weights: {},
    evidence_strength: 'medium' as const,
    hard_constraint_findings: [],
    main_reasons: ['Fixture reason.'],
    strongest_dissent: null,
    accepted_amendments: [],
    rejected_amendments: [],
    critical_unknowns: [],
    prerequisites: [],
    action_proposals: actions,
    cheapest_informative_test: null,
    stop_criteria: [],
    review_criteria: [],
    resolution_support: null,
    validation_status: 'valid' as const,
    ratification_status: 'ratified' as const,
    brief_sha256: session.spec.brief_sha256,
  };
  return { ...base, content_sha256: canonicalHashFn(base) } as Verdict;
}

async function approvedPlan(sessionId: string, actions: ActionProposal[]): Promise<{ plan_id: string; plan_hash: string }> {
  const session = makeStoredSession(sessionId);
  const verdict = makeVerdict(session, actions);
  const envelope = envelopeFromScopeFn(session.scope, OWNER, 'owner', 'write');
  repositories.saveVerdict(envelope, verdict);
  const proposed = await planService.proposePlan(principal(OWNER), sessionId, verdict);
  for (const item of proposed.items) {
    await planService.decidePlanItem(principal(OWNER), sessionId, proposed.plan_id, item.action_id, 'approved');
  }
  return { plan_id: proposed.plan_id, plan_hash: proposed.plan_hash };
}

interface SessionTaskRow {
  id: string;
  status: string;
  dispatch_hold: number | null;
  assigned_agent_id: string | null;
}

function sessionTasks(sessionId: string): SessionTaskRow[] {
  return db
    .prepare(
      `SELECT id, status, dispatch_hold, assigned_agent_id FROM tasks
        WHERE description LIKE ? ORDER BY created_at, id`,
    )
    .all(`%source-session:${sessionId}%`) as SessionTaskRow[];
}

function releasedTaskIds(sessionId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT payload_json FROM council_events
        WHERE tenant_id = 'tenant-a' AND company_id = 'company-a' AND session_id = ?`,
    )
    .all(sessionId) as Array<{ payload_json: string }>;
  const released = new Set<string>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as { action?: string; task_id?: string };
      if (payload.action === 'action_task_released' && typeof payload.task_id === 'string') {
        released.add(payload.task_id);
      }
    } catch {
      // Non-JSON payloads carry no release record.
    }
  }
  return released;
}

function executionCount(taskId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM task_executions WHERE task_id = ?`).get(taskId) as { n: number }).n;
}

/** The real dispatcher machinery, run over every council task. */
async function dispatcherSweep(sessionId: string): Promise<void> {
  for (const task of sessionTasks(sessionId)) {
    await autoDispatchTaskFn(task.id);
    normalizeIntakeForDispatchFn(task.id);
  }
  await runDispatchIntentSweepFn();
}

/**
 * The barrier invariant, checked after every injected sweep: any
 * task the guard has not released is still held, still unassigned,
 * has never executed, and sits in a non-working state (backlog, or
 * visibly blocked when a cancel landed; never a state in which work
 * runs).
 */
function assertBarrier(sessionId: string, label: string): void {
  const released = releasedTaskIds(sessionId);
  for (const task of sessionTasks(sessionId)) {
    assert.equal(
      executionCount(task.id),
      0,
      `${label}: task ${task.id} has an execution record`,
    );
    if (released.has(task.id)) continue;
    assert.equal(task.dispatch_hold, 1, `${label}: unreleased task ${task.id} lost its hold`);
    assert.ok(
      task.status === 'backlog' || task.status === 'blocked',
      `${label}: unreleased task ${task.id} reached a working state (${task.status})`,
    );
    assert.equal(task.assigned_agent_id, null, `${label}: unreleased task ${task.id} gained an agent`);
  }
}

function sweepHook(sessionId: string, steps: string[]): (event: AssemblyStepEvent) => Promise<void> {
  return async (event) => {
    const label = event.action_id ? `${event.step}:${event.action_id}` : event.step;
    steps.push(label);
    await dispatcherSweep(sessionId);
    assertBarrier(sessionId, `after ${label}`);
  };
}

before(async () => {
  const dbModule = await import('../../src/lib/db');
  db = dbModule.getDb();
  closeDbFn = dbModule.closeDb;
  const store = await import('../../src/lib/council/store');
  repositories = new store.CouncilRepositories();
  envelopeFromScopeFn = store.envelopeFromScope;
  const contracts = await import('../../src/lib/council/contracts');
  canonicalHashFn = contracts.canonicalHash;
  SCHEMA_VERSIONS = contracts.SCHEMA_VERSIONS;
  fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  const planModule = await import('../../src/lib/council/kanban/plan-service');
  planService = new planModule.CouncilActionPlanService({ repositories, db });
  Assembly = (await import('../../src/lib/council/kanban/action-assembly')).CouncilPlanAssembly;
  Guard = (await import('../../src/lib/council/kanban/action-execution')).CouncilActionExecutionGuard;
  autoDispatchTaskFn = (await import('../../src/lib/task-dispatcher')).autoDispatchTask;
  normalizeIntakeForDispatchFn = (await import('../../src/lib/jobs/intake-advance-sweep')).normalizeIntakeForDispatch;
  runDispatchIntentSweepFn = (await import('../../src/lib/jobs/dispatch-intents')).runDispatchIntentSweep;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run('company-a', 'Company A', 'company-a', now, now);
});

after(() => {
  closeDbFn();
});

test('T159: a sweep between every assembly step executes nothing when no grant exists', async () => {
  const sessionId = 'sess-t159-nogrant';
  const plan = await approvedPlan(sessionId, [
    makeAction(sessionId, 'act-1'),
    makeAction(sessionId, 'act-2', { depends_on_action_ids: ['act-1'] }),
  ]);
  const steps: string[] = [];
  const assembly = new Assembly({ repositories, db });
  const result = await assembly.assemblePlan(principal(OWNER), sessionId, plan.plan_id, {
    onStep: sweepHook(sessionId, steps),
  });
  assert.equal(result.kind, 'assembled');
  assert.deepEqual(steps, [
    'approval_verified',
    'barrier_persisted',
    'task_created:act-1',
    'task_created:act-2',
    'edges_resolved:act-1',
    'edges_resolved:act-2',
    'readiness_confirmed',
    'assembly_completed',
    'task_release_evaluated:act-1',
    'task_release_evaluated:act-2',
  ]);
  await dispatcherSweep(sessionId);
  assertBarrier(sessionId, 'final sweep');
  assert.equal(sessionTasks(sessionId).length, 3, 'parent plus two children, all present');
});

test('T159: with an admitting grant, sweeps never execute the dependent or the unreleased', async () => {
  const sessionId = 'sess-t159-grant';
  const plan = await approvedPlan(sessionId, [
    makeAction(sessionId, 'act-1'),
    makeAction(sessionId, 'act-2', { depends_on_action_ids: ['act-1'] }),
  ]);
  const port = new AdmittingGrantPort();
  const guard = new Guard({ repositories, db, runAuthorization: port });
  const assembly = new Assembly({ repositories, db, executionGuard: guard });
  const steps: string[] = [];
  const result = await assembly.assemblePlan(principal(OWNER), sessionId, plan.plan_id, {
    onStep: sweepHook(sessionId, steps),
  });
  assert.equal(result.kind, 'assembled');
  if (result.kind !== 'assembled') return;
  const taskByAction = new Map(result.links.map((link) => [link.action_id, link.task_id]));

  // act-1 released at the final step; act-2 (dependent, dependency
  // not done) never released and never executed at any interleaving,
  // which assertBarrier verified after every step.
  const released = releasedTaskIds(sessionId);
  assert.ok(released.has(taskByAction.get('act-1')!), 'act-1 was released by the guard');
  assert.ok(!released.has(taskByAction.get('act-2')!), 'act-2 was never released');
  const act2 = sessionTasks(sessionId).find((t) => t.id === taskByAction.get('act-2'))!;
  assert.equal(act2.dispatch_hold, 1);
  assert.equal(executionCount(taskByAction.get('act-2')!), 0);

  await dispatcherSweep(sessionId);
  assert.equal(executionCount(taskByAction.get('act-2')!), 0, 'the dependent still cannot execute');
  const act2After = sessionTasks(sessionId).find((t) => t.id === taskByAction.get('act-2'))!;
  assert.equal(act2After.dispatch_hold, 1);
  assert.equal(act2After.assigned_agent_id, null);
});

test('T159: cancelling mid-assembly leaves tasks visibly blocked, never deleted, never dispatched', async () => {
  const sessionId = 'sess-t159-cancel';
  const plan = await approvedPlan(sessionId, [
    makeAction(sessionId, 'act-1'),
    makeAction(sessionId, 'act-2'),
  ]);
  const assembly = new Assembly({ repositories, db });
  const steps: string[] = [];
  let cancelFired = false;
  const result = await assembly.assemblePlan(principal(OWNER), sessionId, plan.plan_id, {
    onStep: async (event) => {
      const label = event.action_id ? `${event.step}:${event.action_id}` : event.step;
      steps.push(label);
      await dispatcherSweep(sessionId);
      assertBarrier(sessionId, `after ${label}`);
      if (!cancelFired && event.step === 'task_created' && event.action_id === 'act-1') {
        cancelFired = true;
        // The cancel lands mid-assembly, between creates.
        const midCancel = await assembly.cancelAssembly(principal(OWNER), sessionId, plan.plan_id);
        assert.equal(midCancel.outcomes.length, 1, 'only the first task exists at cancel time');
        assert.equal(midCancel.outcomes[0].outcome, 'blocked');
        await dispatcherSweep(sessionId);
        const firstLink = db
          .prepare(`SELECT task_id FROM council_task_links WHERE session_id = ? AND action_id = 'act-1'`)
          .get(sessionId) as { task_id: string } | undefined;
        assert.ok(firstLink, 'the first task link exists at cancel time');
        const first = sessionTasks(sessionId).find((t) => t.id === firstLink!.task_id);
        assert.ok(first, 'the first task still exists after the mid-assembly cancel');
        assert.equal(first!.status, 'blocked');
        assert.equal(first!.dispatch_hold, 1);
        assert.equal(executionCount(first!.id), 0);
      }
    },
  });
  assert.equal(result.kind, 'assembled');
  assert.ok(cancelFired, 'the cancel actually fired mid-assembly');
  if (result.kind !== 'assembled') return;

  // The operator's cancel completes after the in-flight assembly
  // settles: every created action task ends visibly blocked, the
  // rows all still exist, and no sweep can dispatch any of them.
  const finalCancel = await assembly.cancelAssembly(principal(OWNER), sessionId, plan.plan_id);
  assert.deepEqual(
    finalCancel.outcomes.map((o) => o.outcome).sort(),
    ['already_blocked', 'blocked'],
  );
  await dispatcherSweep(sessionId);
  const links = db
    .prepare(`SELECT task_id FROM council_task_links WHERE session_id = ? ORDER BY action_id`)
    .all(sessionId) as Array<{ task_id: string }>;
  assert.equal(links.length, 2, 'both created tasks still exist; nothing was deleted');
  for (const link of links) {
    const row = db
      .prepare(`SELECT status, dispatch_hold, assigned_agent_id FROM tasks WHERE id = ?`)
      .get(link.task_id) as SessionTaskRow;
    assert.equal(row.status, 'blocked');
    assert.equal(row.dispatch_hold, 1);
    assert.equal(row.assigned_agent_id, null);
    assert.equal(executionCount(link.task_id), 0);
  }
});
