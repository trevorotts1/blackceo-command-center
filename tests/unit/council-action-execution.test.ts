/**
 * CWE-036 execution guard tests (directive Sections 17.6, 19.5, 19.7,
 * 25; Section 35 contract T095).
 *
 * Plan approval is never an execution credential. These tests prove:
 * - with no standing execution grant (the fail-closed default port),
 *   assembly creates every task held and releases nothing;
 * - with a grant that resolves active AND admits the exact operation,
 *   a task releases only when its own source conditions carry
 *   committed verification evidence and its dependencies are done;
 * - release is per task, never a blanket unhold: a dependent stays
 *   held until its dependency reaches done through the official
 *   lifecycle (with the completion-evidence gate), and a grant that
 *   admits only one operation releases only that task;
 * - a satisfied condition without evidence is refused at record time
 *   (Section 19.7: verification method plus actual evidence, never a
 *   model assertion); an owner waiver on record also verifies;
 * - an unsupported handler is rejected, never coerced;
 * - foreign destination references fail assembly readiness and leave
 *   every created task held;
 * - a cross-company principal cannot see or release another
 *   company's plan.
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
let transitionFn: typeof import('../../src/lib/task-lifecycle').transition;
let closeDbFn: () => void;

const OWNER = 'owner-1';

function principal(subject: string, company = 'company-a', tenant = 'tenant-a', inst = 'inst-a'): CouncilPrincipal {
  return {
    subject,
    tenantKind: 'client',
    channel: 'browser',
    supportAccess: false,
    scope: {
      tenant_id: tenant,
      company_id: company,
      installation_id: inst,
      owner_subject: null,
    },
    tenant: {
      tenantId: tenant,
      companyId: company,
      clientId: `client-${company}`,
      kind: 'client',
      subject,
      host: 'council-a.test',
      installationId: inst,
    },
  } as CouncilPrincipal;
}

/** A Section 25.6 port fixture: one active grant, admitting a chosen set. */
class FixtureGrantPort implements CouncilRunAuthorizationPort {
  admitAll = false;
  admittedOperations = new Set<string>();

  async previewRun(_input: RunScopeRef): Promise<RunPreview> {
    throw new Error('previewRun is not part of this fixture');
  }

  async approveRun(_input: RunScopeRef & { preview_sha256: string }): Promise<RunGrantReference> {
    throw new Error('approveRun is not part of this fixture');
  }

  async resolveRunGrant(input: RunScopeRef & { grant_ref?: string | null }): Promise<RunGrantResolution> {
    return {
      status: 'active',
      grant_ref: 'grant-fixture-1',
      session_id: input.session_id,
      scope_sha256: 'fixture-scope',
    };
  }

  async revokeRunGrant(): Promise<{ revoked: boolean }> {
    return { revoked: true };
  }

  async admitOperation(input: RunScopeRef & { grant_ref: string; operation_id: string }): Promise<{ admitted: boolean }> {
    return { admitted: this.admitAll || this.admittedOperations.has(input.operation_id) };
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

function taskRow(taskId: string): { status: string; dispatch_hold: number | null; routing_reason: string | null; assigned_agent_id: string | null } {
  return db
    .prepare(`SELECT status, dispatch_hold, routing_reason, assigned_agent_id FROM tasks WHERE id = ?`)
    .get(taskId) as {
      status: string;
      dispatch_hold: number | null;
      routing_reason: string | null;
      assigned_agent_id: string | null;
    };
}

function journalActions(sessionId: string): string[] {
  const rows = db
    .prepare(
      `SELECT payload_json FROM council_events
        WHERE tenant_id = 'tenant-a' AND company_id = 'company-a' AND session_id = ?
        ORDER BY sequence ASC`,
    )
    .all(sessionId) as Array<{ payload_json: string }>;
  return rows.map((row) => {
    try {
      return (JSON.parse(row.payload_json) as { action?: string }).action ?? '';
    } catch {
      return '';
    }
  });
}

/** Drive a released task to done through the official lifecycle. */
async function completeTask(taskId: string): Promise<void> {
  await transitionFn(taskId, 'in_progress', { actor: 'test-operator', operatorOverride: true });
  db.prepare(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path)
     VALUES (?, ?, 'url', 'Completion evidence', 'https://example.test/evidence')`,
  ).run(`deliverable-${taskId}`, taskId);
  await transitionFn(taskId, 'review', { actor: 'test-operator', operatorOverride: true });
  await transitionFn(taskId, 'done', { actor: 'test-operator', operatorOverride: true });
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
  transitionFn = (await import('../../src/lib/task-lifecycle')).transition;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run('company-a', 'Company A', 'company-a', now, now);
});

after(() => {
  closeDbFn();
});

test('T095: without a standing grant every task stays held and nothing releases', async () => {
  const plan = await approvedPlan('sess-guard-nogrant', [
    makeAction('sess-guard-nogrant', 'act-1'),
    makeAction('sess-guard-nogrant', 'act-2', { depends_on_action_ids: ['act-1'] }),
  ]);
  const assembly = new Assembly({ repositories, db });
  const result = await assembly.assemblePlan(principal(OWNER), 'sess-guard-nogrant', plan.plan_id);
  assert.equal(result.kind, 'assembled');
  if (result.kind !== 'assembled') return;
  assert.equal(result.releases.length, 2);
  for (const release of result.releases) {
    assert.equal(release.released, false);
    assert.equal(release.decision.checks.grant_active, false);
    assert.equal(release.decision.grant_status, 'missing');
    assert.ok(
      release.decision.reasons.some((reason) => reason.includes('plan approval alone never authorizes execution')),
      'the refusal names the missing grant, not a generic failure',
    );
    assert.equal(taskRow(release.task_id).dispatch_hold, 1, 'the task stays held');
  }
  assert.ok(!journalActions('sess-guard-nogrant').includes('action_task_released'));
});

test('T095: release requires verified conditions, then done dependencies, per task', async () => {
  const plan = await approvedPlan('sess-guard-flow', [
    makeAction('sess-guard-flow', 'act-1', { source_condition_ids: ['con-1'] }),
    makeAction('sess-guard-flow', 'act-2', { depends_on_action_ids: ['act-1'] }),
  ]);
  const port = new FixtureGrantPort();
  port.admitAll = true;
  const guard = new Guard({ repositories, db, runAuthorization: port });
  const assembly = new Assembly({ repositories, db, executionGuard: guard });
  const result = await assembly.assemblePlan(principal(OWNER), 'sess-guard-flow', plan.plan_id);
  assert.equal(result.kind, 'assembled');
  if (result.kind !== 'assembled') return;
  const taskByAction = new Map(result.links.map((link) => [link.action_id, link.task_id]));

  // Grant active and admitting, but con-1 is unverified: nothing releases.
  for (const release of result.releases) {
    assert.equal(release.released, false);
  }
  const act1Decision = result.releases.find((r) => r.action_id === 'act-1')!.decision;
  assert.equal(act1Decision.checks.grant_active, true);
  assert.equal(act1Decision.checks.operation_admitted, true);
  assert.equal(act1Decision.checks.prerequisites_verified, false);

  // A satisfied record without evidence is refused at record time.
  await assert.rejects(
    guard.recordConditionVerification(principal(OWNER), 'sess-guard-flow', {
      condition_id: 'con-1',
      status: 'satisfied',
      verification_method: 'document_review',
      evidence_refs: [],
    }),
    (err: unknown) => (err as { code?: string }).code === 'COUNCIL_CONDITION_EVIDENCE_INVALID',
  );

  // With method and evidence committed, act-1 releases; act-2's
  // dependency is not done, so act-2 stays held (never a blanket unhold).
  await guard.recordConditionVerification(principal(OWNER), 'sess-guard-flow', {
    condition_id: 'con-1',
    status: 'satisfied',
    verification_method: 'document_review',
    evidence_refs: ['https://example.test/evidence/con-1'],
  });
  const second = await guard.releaseReadyTasks(principal(OWNER), 'sess-guard-flow', plan.plan_id);
  const act1 = second.find((o) => o.action_id === 'act-1')!;
  const act2 = second.find((o) => o.action_id === 'act-2')!;
  assert.equal(act1.released, true);
  assert.equal(taskRow(taskByAction.get('act-1')!).dispatch_hold, 0);
  assert.equal(taskRow(taskByAction.get('act-1')!).routing_reason, null);
  assert.equal(taskRow(taskByAction.get('act-1')!).assigned_agent_id, null, 'release never assigns an agent');
  assert.equal(act2.released, false);
  assert.equal(act2.decision.checks.dependencies_satisfied, false);
  assert.equal(taskRow(taskByAction.get('act-2')!).dispatch_hold, 1);

  // Complete act-1 through the official lifecycle; only then may
  // act-2 release.
  await completeTask(taskByAction.get('act-1')!);
  assert.equal(taskRow(taskByAction.get('act-1')!).status, 'done');
  const third = await guard.releaseReadyTasks(principal(OWNER), 'sess-guard-flow', plan.plan_id);
  const act2Now = third.find((o) => o.action_id === 'act-2')!;
  assert.equal(act2Now.released, true);
  assert.equal(taskRow(taskByAction.get('act-2')!).dispatch_hold, 0);
  const act1Again = third.find((o) => o.action_id === 'act-1')!;
  assert.equal(act1Again.already_released, true, 'a released task is reported, not re-released');
});

test('T095: a grant that does not admit the exact operation releases nothing', async () => {
  const plan = await approvedPlan('sess-guard-admission', [
    makeAction('sess-guard-admission', 'act-1'),
    makeAction('sess-guard-admission', 'act-2'),
  ]);
  const port = new FixtureGrantPort();
  const guard = new Guard({ repositories, db, runAuthorization: port });
  const assembly = new Assembly({ repositories, db, executionGuard: guard });

  // Admit only act-1's operation.
  const constants = await import('../../src/lib/council/kanban/constants');
  port.admittedOperations.add(
    constants.councilActionOperationId({
      sessionId: 'sess-guard-admission',
      verdictRevision: 1,
      actionId: 'act-1',
      planHash: plan.plan_hash,
    }),
  );
  const result = await assembly.assemblePlan(principal(OWNER), 'sess-guard-admission', plan.plan_id);
  assert.equal(result.kind, 'assembled');
  if (result.kind !== 'assembled') return;
  const act1 = result.releases.find((r) => r.action_id === 'act-1')!;
  const act2 = result.releases.find((r) => r.action_id === 'act-2')!;
  assert.equal(act1.released, true, 'the admitted operation releases');
  assert.equal(act2.released, false, 'the non-admitted operation stays held');
  assert.equal(act2.decision.checks.grant_active, true);
  assert.equal(act2.decision.checks.operation_admitted, false);
  assert.equal(taskRow(act2.task_id).dispatch_hold, 1);
});

test('T095: an owner waiver on record verifies a condition; a failed condition blocks', async () => {
  const plan = await approvedPlan('sess-guard-waiver', [
    makeAction('sess-guard-waiver', 'act-1', { source_condition_ids: ['con-waived'] }),
    makeAction('sess-guard-waiver', 'act-2', { source_condition_ids: ['con-failed'] }),
  ]);
  const port = new FixtureGrantPort();
  port.admitAll = true;
  const guard = new Guard({ repositories, db, runAuthorization: port });
  const assembly = new Assembly({ repositories, db, executionGuard: guard });
  await guard.recordConditionVerification(principal(OWNER), 'sess-guard-waiver', {
    condition_id: 'con-waived',
    status: 'waived_by_owner',
    verification_method: 'owner_attestation',
    evidence_refs: [],
  });
  await guard.recordConditionVerification(principal(OWNER), 'sess-guard-waiver', {
    condition_id: 'con-failed',
    status: 'failed',
    verification_method: 'document_review',
    evidence_refs: ['https://example.test/evidence/con-failed'],
  });
  const result = await assembly.assemblePlan(principal(OWNER), 'sess-guard-waiver', plan.plan_id);
  assert.equal(result.kind, 'assembled');
  if (result.kind !== 'assembled') return;
  assert.equal(result.releases.find((r) => r.action_id === 'act-1')!.released, true);
  const act2 = result.releases.find((r) => r.action_id === 'act-2')!;
  assert.equal(act2.released, false);
  assert.equal(act2.decision.checks.prerequisites_verified, false);
});

test('T095: an unsupported handler is rejected, never coerced', async () => {
  const plan = await approvedPlan('sess-guard-handler', [makeAction('sess-guard-handler', 'act-1')]);
  const port = new FixtureGrantPort();
  port.admitAll = true;
  const guard = new Guard({ repositories, db, runAuthorization: port });
  const assembly = new Assembly({ repositories, db, executionGuard: guard });
  const result = await assembly.assemblePlan(principal(OWNER), 'sess-guard-handler', plan.plan_id);
  assert.equal(result.kind, 'assembled');
  if (result.kind !== 'assembled') return;
  const taskId = result.links[0].task_id;
  assert.equal(result.releases[0].released, true, 'baseline: the untampered task releases');

  // Re-hold the task the way the barrier would, then tamper its
  // handler line: the guard must refuse, not coerce it back.
  db.prepare(
    `UPDATE tasks SET dispatch_hold = 1, routing_reason = 'council_plan_assembling',
            routing_wait_owner = 'SYSTEM',
            description = REPLACE(description, 'Handler: council_action', 'Handler: department_dispatch')
      WHERE id = ?`,
  ).run(taskId);
  const decision = await guard.evaluateTaskRelease(principal(OWNER), 'sess-guard-handler', plan.plan_id, 'act-1');
  assert.equal(decision.checks.handler_supported, false);
  assert.equal(decision.releasable, false);
  const outcome = await guard.releaseTask(principal(OWNER), 'sess-guard-handler', plan.plan_id, 'act-1');
  assert.equal(outcome.released, false);
  assert.equal(taskRow(taskId).dispatch_hold, 1, 'the tampered task stays held');
});

test('T095: foreign destination references fail readiness and leave tasks held', async () => {
  const plan = await approvedPlan('sess-guard-readiness', [
    makeAction('sess-guard-readiness', 'act-1', { assigned_agent_id: 'agent-foreign-404' }),
  ]);
  const assembly = new Assembly({ repositories, db });
  await assert.rejects(
    assembly.assemblePlan(principal(OWNER), 'sess-guard-readiness', plan.plan_id),
    (err: unknown) => (err as { code?: string }).code === 'COUNCIL_ASSEMBLY_READINESS_FAILED',
  );
  const links = db
    .prepare(`SELECT task_id FROM council_task_links WHERE session_id = 'sess-guard-readiness'`)
    .all() as Array<{ task_id: string }>;
  assert.equal(links.length, 1, 'the task was created before readiness ran');
  assert.equal(taskRow(links[0].task_id).dispatch_hold, 1, 'and it stays held');
  assert.ok(journalActions('sess-guard-readiness').includes('assembly_readiness_failed'));
  assert.ok(!journalActions('sess-guard-readiness').includes('action_task_released'));
});

test('T095: a known SOP reference passes readiness (positive control)', async () => {
  const sop = db.prepare(`SELECT id FROM sops LIMIT 1`).get() as { id: string } | undefined;
  assert.ok(sop, 'the seeded SOP library exists in this fixture database');
  const plan = await approvedPlan('sess-guard-sop', [
    makeAction('sess-guard-sop', 'act-1', { sop_id: sop!.id }),
  ]);
  const assembly = new Assembly({ repositories, db });
  const result = await assembly.assemblePlan(principal(OWNER), 'sess-guard-sop', plan.plan_id);
  assert.equal(result.kind, 'assembled');
});

test('T095: a cross-company principal cannot evaluate or release another company\'s plan', async () => {
  const plan = await approvedPlan('sess-guard-scope', [makeAction('sess-guard-scope', 'act-1')]);
  const assembly = new Assembly({ repositories, db });
  const result = await assembly.assemblePlan(principal(OWNER), 'sess-guard-scope', plan.plan_id);
  assert.equal(result.kind, 'assembled');
  if (result.kind !== 'assembled') return;
  const taskId = result.links[0].task_id;

  const foreign = principal('owner-9', 'company-b', 'tenant-b', 'inst-b');
  const port = new FixtureGrantPort();
  port.admitAll = true;
  const foreignGuard = new Guard({ repositories, db, runAuthorization: port });
  await assert.rejects(
    foreignGuard.releaseReadyTasks(foreign, 'sess-guard-scope', plan.plan_id),
    (err: unknown) => (err as { code?: string }).code === 'COUNCIL_SESSION_NOT_FOUND',
  );
  assert.equal(taskRow(taskId).dispatch_hold, 1, 'the task is untouched by the foreign attempt');
});
