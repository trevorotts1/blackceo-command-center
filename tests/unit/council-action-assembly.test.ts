/**
 * CWE-036 approved action-plan creation tests (directive Sections
 * 17.5, 17.6, 19.5, 19.6; Section 35 contracts T091, T092, T093,
 * T094).
 *
 * - T091: approval binds the exact plan hash, selected actions, scope,
 *   per-item budgets, and the approving principal. A hash the client
 *   did not see in preview is refused before any approval row exists.
 * - Creation requires the committed approval; an approval never
 *   transfers to a superseded plan revision.
 * - T092: a double click, a timeout retry with a different key, a
 *   concurrent double submission, and a renamed action title cannot
 *   duplicate an action task; identity comes from the durable
 *   Section 19.6 operation keys, never from titles.
 * - T093: a mid-assembly crash resumes by creating only the missing
 *   actions; already-created task IDs are preserved.
 * - T094: dependencies resolve to real edges between real task IDs;
 *   cycles, self-dependencies, unknown references, and impossible
 *   dates are refused before any task exists.
 * - Parity: the assembly's per-step materialization produces exactly
 *   the tasks CWE-035's materializePlanTasks produces.
 */
import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;

import type { ActionProposal, Verdict } from '../../src/lib/council/contracts';
import type { CouncilPrincipal } from '../../src/lib/council/auth';
import type { CouncilRepositories, CouncilStoredSession } from '../../src/lib/council/store';
import type { CouncilRouteContext } from '../../src/lib/council/api/foundation';

type Db = import('better-sqlite3').Database;

let db: Db;
let repositories: CouncilRepositories;
let Approvals: typeof import('../../src/lib/council/approvals');
let Foundation: typeof import('../../src/lib/council/api/foundation');
let envelopeFromScopeFn: typeof import('../../src/lib/council/store').envelopeFromScope;
let canonicalHashFn: typeof import('../../src/lib/council/contracts').canonicalHash;
let SCHEMA_VERSIONS: typeof import('../../src/lib/council/contracts').SCHEMA_VERSIONS;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let planService: InstanceType<typeof import('../../src/lib/council/kanban/plan-service').CouncilActionPlanService>;
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

function commitVerdict(session: CouncilStoredSession, verdict: Verdict): void {
  const envelope = envelopeFromScopeFn(session.scope, OWNER, 'owner', 'write');
  repositories.saveVerdict(envelope, verdict);
}

function ctxFor(subject: string): CouncilRouteContext {
  return {
    principal: principal(subject),
    requestId: 'fixture-request',
    repositories,
    store: { handle: () => db } as CouncilRouteContext['store'],
  };
}

async function approveViaFacade(
  sessionId: string,
  planHash: string,
  key: string,
  selections?: string[],
): Promise<{ plan_id: string; replayed: boolean }> {
  const ctx = ctxFor(OWNER);
  const authorized = Foundation.authorizeSessionMutate(ctx, sessionId);
  const result = await Approvals.approveActionPlan(
    ctx,
    authorized,
    sessionId,
    {
      verdict_revision: 1,
      plan_hash: planHash,
      idempotency_key: key,
      ...(selections ? { selected_action_ids: selections } : {}),
    },
    key,
  );
  return { plan_id: result.plan_id, replayed: result.replayed };
}

async function createViaFacade(sessionId: string, planId: string, planHash: string, key: string) {
  const ctx = ctxFor(OWNER);
  const authorized = Foundation.authorizeSessionMutate(ctx, sessionId);
  return Approvals.createActionPlan(
    ctx,
    authorized,
    sessionId,
    {
      plan_id: planId,
      plan_hash: planHash,
      idempotency_key: key,
    },
    key,
  );
}

function childrenOf(sessionId: string): Array<{ id: string; status: string; dispatch_hold: number | null; title: string }> {
  // The tasks table carries no company_id column (company scoping is
  // via workspaces); the source-session tag in the description is the
  // unique per-session marker both the parent and the action tasks
  // carry.
  return db
    .prepare(
      `SELECT id, status, dispatch_hold, title FROM tasks
        WHERE description LIKE ?
        ORDER BY created_at, id`,
    )
    .all(`%source-session:${sessionId}%`) as Array<{
      id: string;
      status: string;
      dispatch_hold: number | null;
      title: string;
    }>;
}

function approvalRows(sessionId: string): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT * FROM council_approvals WHERE tenant_id = 'tenant-a' AND session_id = ? ORDER BY id`,
    )
    .all(sessionId) as Array<Record<string, unknown>>;
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
  Approvals = await import('../../src/lib/council/approvals');
  Foundation = await import('../../src/lib/council/api/foundation');
  const planModule = await import('../../src/lib/council/kanban/plan-service');
  planService = new planModule.CouncilActionPlanService({ repositories, db });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run('company-a', 'Company A', 'company-a', now, now);
});

after(() => {
  closeDbFn();
});

test('T091: approve binds the exact hash, principal, scope, and per-item budgets', async () => {
  const session = makeStoredSession('sess-approve-bind');
  const verdict = makeVerdict(session, [
    makeAction('sess-approve-bind', 'act-1'),
    makeAction('sess-approve-bind', 'act-2', { budget_limit: { amount_minor: 7500, currency: 'USD' } }),
  ]);
  commitVerdict(session, verdict);
  const proposed = await planService.proposePlan(principal(OWNER), 'sess-approve-bind', verdict);

  const approved = await approveViaFacade('sess-approve-bind', proposed.plan_hash, 'approve-bind-1');
  assert.equal(approved.replayed, false);

  const rows = approvalRows('sess-approve-bind');
  assert.equal(rows.length, 2, 'one committed approval row per plan item');
  for (const row of rows) {
    assert.equal(row.actor_subject, OWNER, 'the approving principal is bound on the row');
    assert.equal(row.tenant_id, 'tenant-a');
    assert.equal(row.company_id, 'company-a');
    assert.equal(row.status, 'active');
    const proof = JSON.parse(row.scope_proof as string) as Record<string, unknown>;
    assert.equal(proof.decision, 'approved');
    assert.equal(proof.approved_by_principal, OWNER);
    assert.equal(proof.plan_hash, proposed.plan_hash, 'the approved hash is bound in the scope proof');
    assert.equal(proof.plan_id, proposed.plan_id);
    assert.equal(proof.session_id, 'sess-approve-bind');
  }
  const budgets = rows
    .map((r) => ({ max: r.max_cost_minor, currency: r.currency }))
    .sort((a, b) => Number(a.max) - Number(b.max));
  assert.deepEqual(budgets, [
    { max: 5000, currency: 'USD' },
    { max: 7500, currency: 'USD' },
  ]);
  const view = await planService.getPlan(principal(OWNER), 'sess-approve-bind', proposed.plan_id);
  assert.deepEqual(view.plan.required_execution_grant.budgets, [
    { currency: 'USD', amount_minor: 12500 },
  ]);
});

test('T091: approve with a hash the client never saw is refused before any approval row', async () => {
  const session = makeStoredSession('sess-approve-mismatch');
  commitVerdict(session, makeVerdict(session, [makeAction('sess-approve-mismatch', 'act-1')]));
  const ctx = ctxFor(OWNER);
  const authorized = Foundation.authorizeSessionMutate(ctx, 'sess-approve-mismatch');
  await assert.rejects(
    Approvals.approveActionPlan(ctx, authorized, 'sess-approve-mismatch', {
      verdict_revision: 1,
      plan_hash: '0'.repeat(64),
      idempotency_key: 'approve-mismatch-1',
    }),
    (err: unknown) => (err as { code?: string }).code === 'COUNCIL_PLAN_HASH_MISMATCH',
  );
  assert.equal(approvalRows('sess-approve-mismatch').length, 0);
});

test('T091: an approve replay returns the committed record without new approval rows', async () => {
  const session = makeStoredSession('sess-approve-replay');
  const verdict = makeVerdict(session, [makeAction('sess-approve-replay', 'act-1')]);
  commitVerdict(session, verdict);
  const proposed = await planService.proposePlan(principal(OWNER), 'sess-approve-replay', verdict);
  const first = await approveViaFacade('sess-approve-replay', proposed.plan_hash, 'approve-replay-1');
  const second = await approveViaFacade('sess-approve-replay', proposed.plan_hash, 'approve-replay-1');
  assert.equal(second.plan_id, first.plan_id);
  assert.equal(second.replayed, true);
  assert.equal(approvalRows('sess-approve-replay').length, 1);
});

test('create requires the committed approval and creates nothing without it', async () => {
  const session = makeStoredSession('sess-create-needs-approval');
  const verdict = makeVerdict(session, [makeAction('sess-create-needs-approval', 'act-1')]);
  commitVerdict(session, verdict);
  const proposed = await planService.proposePlan(principal(OWNER), 'sess-create-needs-approval', verdict);
  await assert.rejects(
    createViaFacade('sess-create-needs-approval', proposed.plan_id, proposed.plan_hash, 'create-noapproval-1'),
    (err: unknown) => (err as { code?: string }).code === 'COUNCIL_PLAN_NOT_FULLY_APPROVED',
  );
  assert.equal(childrenOf('sess-create-needs-approval').length, 0, 'no task exists without approval coverage');

  // Partial approval is also not coverage.
  await planService.decidePlanItem(
    principal(OWNER),
    'sess-create-needs-approval',
    proposed.plan_id,
    'act-1',
    'rejected',
  );
  await assert.rejects(
    createViaFacade('sess-create-needs-approval', proposed.plan_id, proposed.plan_hash, 'create-rejected-1'),
    (err: unknown) => (err as { code?: string }).code === 'COUNCIL_PLAN_NOT_FULLY_APPROVED',
  );
  assert.equal(childrenOf('sess-create-needs-approval').length, 0);
});

test('T092: double click, retry with a fresh key, and concurrent create cannot duplicate tasks', async () => {
  const session = makeStoredSession('sess-create-idempotent');
  const verdict = makeVerdict(session, [
    makeAction('sess-create-idempotent', 'act-1'),
    makeAction('sess-create-idempotent', 'act-2', { depends_on_action_ids: ['act-1'] }),
  ]);
  commitVerdict(session, verdict);
  const proposed = await planService.proposePlan(principal(OWNER), 'sess-create-idempotent', verdict);
  await approveViaFacade('sess-create-idempotent', proposed.plan_hash, 'approve-idem-1');

  const first = await createViaFacade('sess-create-idempotent', proposed.plan_id, proposed.plan_hash, 'create-idem-1');
  assert.equal(first.tasks.length, 2);
  assert.ok(first.parent_task_id);
  const children1 = childrenOf('sess-create-idempotent');
  assert.equal(children1.length, 3, 'parent plus two children');
  for (const row of children1) {
    assert.equal(row.dispatch_hold, 1, 'every created task is born held');
    assert.equal(row.status, 'backlog');
  }
  for (const task of first.tasks) {
    assert.equal(task.created, true);
    assert.equal(task.released, false, 'no grant exists, so nothing released');
  }

  // Double click / timeout retry with the SAME key: pure replay.
  const replayed = await createViaFacade('sess-create-idempotent', proposed.plan_id, proposed.plan_hash, 'create-idem-1');
  assert.equal(replayed.replayed, true);
  assert.deepEqual(
    replayed.tasks.map((t) => t.task_id).sort(),
    first.tasks.map((t) => t.task_id).sort(),
  );

  // Retry with a DIFFERENT key: the assembly itself is idempotent on
  // the durable operation keys.
  const retried = await createViaFacade('sess-create-idempotent', proposed.plan_id, proposed.plan_hash, 'create-idem-2');
  assert.deepEqual(
    retried.tasks.map((t) => t.task_id).sort(),
    first.tasks.map((t) => t.task_id).sort(),
  );
  assert.ok(retried.tasks.every((t) => t.created === false));

  // Concurrent double submission at the assembly level.
  const assemblyModule = await import('../../src/lib/council/kanban/action-assembly');
  const assembly = new assemblyModule.CouncilPlanAssembly({ repositories, db });
  const [a, b] = await Promise.all([
    assembly.assemblePlan(principal(OWNER), 'sess-create-idempotent', proposed.plan_id),
    assembly.assemblePlan(principal(OWNER), 'sess-create-idempotent', proposed.plan_id),
  ]);
  assert.equal(a.kind, 'assembled');
  assert.equal(b.kind, 'assembled');
  if (a.kind !== 'assembled' || b.kind !== 'assembled') return;
  assert.deepEqual(
    a.links.map((t) => t.task_id).sort(),
    b.links.map((t) => t.task_id).sort(),
  );
  assert.equal(childrenOf('sess-create-idempotent').length, 3, 'still exactly parent plus two children');
  const links = db
    .prepare(`SELECT COUNT(*) AS n FROM council_task_links WHERE session_id = 'sess-create-idempotent'`)
    .get() as { n: number };
  assert.equal(links.n, 2);
});

test('T092/T093: a renamed title and a mid-assembly crash preserve created task identity', async () => {
  const actions = [
    makeAction('sess-create-resume', 'act-1'),
    makeAction('sess-create-resume', 'act-2'),
    makeAction('sess-create-resume', 'act-3'),
  ];
  const session = makeStoredSession('sess-create-resume');
  const verdict = makeVerdict(session, actions);
  commitVerdict(session, verdict);
  const proposed = await planService.proposePlan(principal(OWNER), 'sess-create-resume', verdict);
  await approveViaFacade('sess-create-resume', proposed.plan_hash, 'approve-resume-1');

  // Simulate the crash: only act-1's task and link exist, exactly as
  // a crashed assembly would have left them (same construction the
  // assembly itself uses, stopped after the first create).
  const kanbanConstants = await import('../../src/lib/council/kanban/constants');
  const tasksModule = await import('../../src/lib/tasks');
  const identityModule = await import('../../src/lib/task-request-identity');
  const parentModule = await import('../../src/lib/council/kanban/parent-task');
  const adapter = new parentModule.CanonicalParentTaskAdapter({ repositories, db });
  const parent = await adapter.ensureParentTask(principal(OWNER), 'sess-create-resume');
  assert.notEqual(parent.kind, 'none');
  if (parent.kind === 'none') return;
  const item1 = proposed.items.find((i) => i.action_id === 'act-1')!;
  const operationId = kanbanConstants.councilActionOperationId({
    sessionId: 'sess-create-resume',
    verdictRevision: 1,
    actionId: 'act-1',
    planHash: proposed.plan_hash,
  });
  const description = [
    '[council-source-session:sess-create-resume]',
    'Handler: council_action',
    'Session: /council/sessions/sess-create-resume',
    `Plan: ${proposed.plan_hash}`,
    `Operation: ${operationId}`,
    'Action: act-1 (revision 1)',
    '',
    'Description for act-1.',
    '',
    'Rationale: The council advised this bounded step.',
    '',
    'Acceptance criteria:',
    '- The step is complete and evidenced.',
    '',
    'Execution authorization required: yes. This task is held behind ' +
      'council_plan_assembling and dispatches only under a separate ' +
      'execution grant; council approval alone never executes it.',
  ].join('\n');
  const seeded = await tasksModule.createTaskCore({
    title: 'Carry out act-1',
    description,
    source: 'council',
    parent_task_id: parent.task_id,
    routing_hold_reason: 'council_plan_assembling',
    idempotency_company_id: 'company-a',
    idempotency_key: operationId,
    idempotency_payload_hash: identityModule.taskRequestFingerprint({
      kind: 'council_action_task',
      operation_id: operationId,
      plan_hash: proposed.plan_hash,
      item_sha256: item1.item_sha256,
    }),
    skipWindowDedup: true,
  });
  assert.ok(seeded);
  if (!seeded) return;
  assert.equal(seeded.deduped, false);
  db.prepare(
    `INSERT INTO council_task_links
       (tenant_id, company_id, session_id, id, parent_session_task_id, action_proposal_id,
        action_id, plan_hash, operation_id, task_id, task_board_ref, created_at)
     VALUES ('tenant-a', 'company-a', 'sess-create-resume', ?, ?, ?, 'act-1', ?, ?, ?, 'backlog', ?)`,
  ).run(
    `link-${operationId}`,
    parent.task_id,
    proposed.plan_id,
    proposed.plan_hash,
    operationId,
    seeded.task.id,
    new Date().toISOString(),
  );

  // Resume: only act-2 and act-3 are created; act-1 keeps its ID.
  const created = await createViaFacade('sess-create-resume', proposed.plan_id, proposed.plan_hash, 'create-resume-1');
  assert.equal(created.tasks.length, 3);
  const byAction = new Map(created.tasks.map((t) => [t.action_id, t]));
  assert.equal(byAction.get('act-1')!.task_id, seeded.task.id, 'the crashed run task ID is preserved');
  assert.equal(byAction.get('act-1')!.created, false);
  assert.equal(byAction.get('act-2')!.created, true);
  assert.equal(byAction.get('act-3')!.created, true);
  assert.equal(childrenOf('sess-create-resume').length, 4, 'parent plus three children, no duplicates');

  // Rename an action title after creation: the plan revision is new
  // work. Its approval is stranded, and create on the revised plan is
  // refused until the revised plan itself is approved; the original
  // completed create still replays its original receipt and creates
  // nothing new.
  const revised = await planService.revisePlanItem(
    principal(OWNER),
    'sess-create-resume',
    proposed.plan_id,
    'act-2',
    { title: 'Renamed act-2 after the fact' },
  );
  await assert.rejects(
    createViaFacade('sess-create-resume', revised.plan_id, revised.plan_hash, 'create-resume-renamed'),
    (err: unknown) => (err as { code?: string }).code === 'COUNCIL_PLAN_NOT_CURRENT' ||
      (err as { code?: string }).code === 'COUNCIL_PLAN_NOT_FULLY_APPROVED',
  );
  const replayed = await createViaFacade('sess-create-resume', proposed.plan_id, proposed.plan_hash, 'create-resume-1');
  assert.equal(replayed.replayed, true);
  assert.deepEqual(
    replayed.tasks.map((t) => t.task_id).sort(),
    created.tasks.map((t) => t.task_id).sort(),
  );
  assert.equal(childrenOf('sess-create-resume').length, 4, 'the rename created no duplicate task');
});

test('T094: invalid dependency graphs are refused before any task exists', async () => {
  const cases: Array<{
    suffix: string;
    actions: ActionProposal[];
    label: string;
  }> = [
    {
      suffix: 'cycle',
      label: 'a cycle',
      actions: [
        makeAction('x', 'act-1', { depends_on_action_ids: ['act-2'] }),
        makeAction('x', 'act-2', { depends_on_action_ids: ['act-1'] }),
      ],
    },
    {
      suffix: 'self',
      label: 'a self-dependency',
      actions: [makeAction('x', 'act-1', { depends_on_action_ids: ['act-1'] })],
    },
    {
      suffix: 'unknown',
      label: 'an unknown dependency',
      actions: [makeAction('x', 'act-1', { depends_on_action_ids: ['act-ghost'] })],
    },
    {
      suffix: 'dates',
      label: 'a due date earlier than its dependency',
      actions: [
        makeAction('x', 'act-1', { due_at: '2026-12-01T00:00:00.000Z' }),
        makeAction('x', 'act-2', {
          depends_on_action_ids: ['act-1'],
          due_at: '2026-11-01T00:00:00.000Z',
        }),
      ],
    },
  ];
  for (const c of cases) {
    const sessionId = `sess-graph-${c.suffix}`;
    const session = makeStoredSession(sessionId);
    const verdict = makeVerdict(session, c.actions.map((a) => ({ ...a, session_id: sessionId })));
    commitVerdict(session, verdict);
    const proposed = await planService.proposePlan(principal(OWNER), sessionId, verdict);
    await approveViaFacade(sessionId, proposed.plan_hash, `approve-graph-${c.suffix}`);
    await assert.rejects(
      createViaFacade(sessionId, proposed.plan_id, proposed.plan_hash, `create-graph-${c.suffix}`),
      (err: unknown) => {
        const code = (err as { code?: string }).code;
        assert.equal(code, 'COUNCIL_DEPENDENCY_INVALID', `${c.label}: got ${code}`);
        return true;
      },
    );
    assert.equal(childrenOf(sessionId).length, 0, `${c.label}: no task, not even the parent, exists`);
  }
});

test('T094: dependencies resolve to real edges between real task IDs', async () => {
  const session = makeStoredSession('sess-graph-edges');
  const verdict = makeVerdict(session, [
    makeAction('sess-graph-edges', 'act-1'),
    makeAction('sess-graph-edges', 'act-2', { depends_on_action_ids: ['act-1'] }),
    makeAction('sess-graph-edges', 'act-3', { depends_on_action_ids: ['act-1', 'act-2'] }),
  ]);
  commitVerdict(session, verdict);
  const proposed = await planService.proposePlan(principal(OWNER), 'sess-graph-edges', verdict);
  await approveViaFacade('sess-graph-edges', proposed.plan_hash, 'approve-edges-1');
  const created = await createViaFacade('sess-graph-edges', proposed.plan_id, proposed.plan_hash, 'create-edges-1');
  const byAction = new Map(created.tasks.map((t) => [t.action_id, t.task_id]));
  assert.deepEqual(created.edges, [
    {
      action_id: 'act-2',
      task_id: byAction.get('act-2'),
      depends_on_action_id: 'act-1',
      depends_on_task_id: byAction.get('act-1'),
    },
    {
      action_id: 'act-3',
      task_id: byAction.get('act-3'),
      depends_on_action_id: 'act-1',
      depends_on_task_id: byAction.get('act-1'),
    },
    {
      action_id: 'act-3',
      task_id: byAction.get('act-3'),
      depends_on_action_id: 'act-2',
      depends_on_task_id: byAction.get('act-2'),
    },
  ]);
  for (const taskId of byAction.values()) {
    const row = db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(taskId) as { id: string } | undefined;
    assert.ok(row, 'every edge endpoint is a real task row');
  }
});

test('parity: assembly materialization matches CWE-035 materializePlanTasks exactly', async () => {
  const makePair = async (sessionId: string) => {
    const session = makeStoredSession(sessionId);
    const verdict = makeVerdict(session, [
      makeAction(sessionId, 'act-1'),
      makeAction(sessionId, 'act-2', { depends_on_action_ids: ['act-1'] }),
    ]);
    commitVerdict(session, verdict);
    const proposed = await planService.proposePlan(principal(OWNER), sessionId, verdict);
    await approveViaFacade(sessionId, proposed.plan_hash, `approve-parity-${sessionId}`);
    return proposed;
  };
  const viaAssembly = await makePair('sess-parity-assembly');
  const viaService = await makePair('sess-parity-service');

  const assemblyResult = await createViaFacade(
    'sess-parity-assembly',
    viaAssembly.plan_id,
    viaAssembly.plan_hash,
    'create-parity-assembly',
  );
  const serviceResult = await planService.materializePlanTasks(
    principal(OWNER),
    'sess-parity-service',
    viaService.plan_id,
  );
  assert.equal(serviceResult.kind, 'materialized');
  if (serviceResult.kind !== 'materialized') return;
  assert.equal(assemblyResult.tasks.length, serviceResult.links.length);
  const strip = (sessionId: string, text: string) => text.split(sessionId).join('<S>');
  const rowOf = (taskId: string) =>
    db
      .prepare(`SELECT title, description, dispatch_hold, routing_reason, status FROM tasks WHERE id = ?`)
      .get(taskId) as {
        title: string;
        description: string;
        dispatch_hold: number | null;
        routing_reason: string | null;
        status: string;
      };
  for (const actionId of ['act-1', 'act-2']) {
    const a = assemblyResult.tasks.find((t) => t.action_id === actionId)!;
    const s = serviceResult.links.find((t) => t.action_id === actionId)!;
    assert.equal(
      a.operation_id.split('sess-parity-assembly').join('<S>').split(viaAssembly.plan_hash).join('<H>'),
      s.operation_id.split('sess-parity-service').join('<S>').split(viaService.plan_hash).join('<H>'),
    );
    const aRow = rowOf(a.task_id);
    const sRow = rowOf(s.task_id);
    assert.equal(aRow.title, sRow.title);
    // The descriptions embed each session's own plan hash (the Plan:
    // line and the operation identity), which legitimately differs
    // across sessions because the hash binds each session's verdict.
    assert.equal(
      strip('sess-parity-assembly', aRow.description).split(viaAssembly.plan_hash).join('<H>'),
      strip('sess-parity-service', sRow.description).split(viaService.plan_hash).join('<H>'),
    );
    assert.equal(aRow.dispatch_hold, sRow.dispatch_hold);
    assert.equal(aRow.routing_reason, sRow.routing_reason);
    assert.equal(aRow.status, sRow.status);
  }
});
