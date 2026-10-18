/**
 * WER-024 verdict -> intended action-task set tests (v2.4 plan).
 *
 * Runner (the repo's own Node + tsx unit convention):
 *   node --import tsx --test src/lib/council/kanban/verdict-handoff.test.ts
 *
 * Proves, against the REAL host surface on an isolated database:
 * - one validated verdict converts into exactly ONE intended action-task
 *   set bound to the right company, the ONE session parent and the exact
 *   verdict revision;
 * - 27 advisor cards never become 27 tasks: only the verdict's own
 *   action proposals are planned;
 * - conversion alone creates no action task, and advisory/plan approval
 *   is not an execution credential (materialized tasks stay held);
 * - replay and export create zero tasks; repeated materialization does
 *   not duplicate tasks.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const SANDBOX = fs.mkdtempSync('/tmp/cc-W08-U002-handoff-');
process.env.DATABASE_PATH = path.join(SANDBOX, 'council.db');
process.env.CC_TEST_FIXTURE_ROOT = path.join(SANDBOX, 'fixtures');
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
delete process.env.OPENAI_API_KEY;

import type { ActionProposal, Verdict } from '../contracts';
import type { CouncilPrincipal } from '../auth';
import type { CouncilRepositories, CouncilStoredSession } from '../store';
import type { CouncilVerdictHandoff } from './verdict-handoff';
import type { CouncilActionPlanService } from './plan-service';

type Db = import('better-sqlite3').Database;

const OWNER = 'owner-1';
const SESSION_ID = 'sess-handoff-1';

let db: Db;
let closeDbFn: () => void;
let repositories: CouncilRepositories;
let handoff: CouncilVerdictHandoff;
let planService: CouncilActionPlanService;
let session: CouncilStoredSession;
let verdict: Verdict;

let canonicalHashFn: typeof import('../contracts').canonicalHash;
let SCHEMA_VERSIONS: typeof import('../contracts').SCHEMA_VERSIONS;
let fixtures: typeof import('../contracts/fixtures/examples');

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

function makeStoredSession(): CouncilStoredSession {
  const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
  spec.session_id = SESSION_ID;
  brief.session_id = SESSION_ID;
  spec.visibility = 'company';
  spec.brief_sha256 = canonicalHashFn(brief);
  const stored: CouncilStoredSession = {
    spec,
    brief,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'inst-a',
      owner_subject: OWNER,
    },
    state: {
      schema_version: 'wise-elders.session-state/v1',
      session_id: SESSION_ID,
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
  const { envelopeFromScope } = requireStore();
  repositories.createSession(
    envelopeFromScope(stored.scope, OWNER, 'owner', 'write'),
    stored,
  );
  return stored;
}

let storeModule: typeof import('../store');
function requireStore(): typeof import('../store') {
  return storeModule;
}

function makeAction(actionId: string, overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    action_id: actionId,
    session_id: SESSION_ID,
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

function makeVerdict(actions: ActionProposal[]): Verdict {
  const base = {
    schema_version: SCHEMA_VERSIONS.verdict,
    result_kind: 'scored' as const,
    session_id: SESSION_ID,
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

function insertAdvisorCards(count: number): void {
  const seats = [
    'simon-sinek',
    'td-jakes',
    'oprah-winfrey',
    'tiffany-aliche',
    'russell-brunson',
    'michelle-obama',
    'brene-brown',
    'dennis-kimbro',
    'les-brown',
  ];
  const now = new Date().toISOString();
  for (let i = 0; i < count; i += 1) {
    const hash = canonicalHashFn({ card: i });
    db.prepare(
      `INSERT INTO council_cards
         (tenant_id, company_id, session_id, id, kind, seat_id, round, brief_revision,
          operation_id, payload_fingerprint, card_json, canonical_hash, model_receipt_json,
          validation, created_at)
       VALUES ('tenant-a', 'company-a', ?, ?, 'advisor', ?, 1, 1, ?, ?, ?, ?, NULL, 'valid', ?)`,
    ).run(
      SESSION_ID,
      `card-${i}`,
      seats[i % seats.length],
      `card-op-${i}`,
      hash,
      JSON.stringify({ strongest_objection: `Objection ${i}` }),
      hash,
      now,
    );
  }
}

function totalTasks(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
}

function tasksForSession(): Array<{ id: string; status: string; dispatch_hold: number; routing_reason: string | null; parent_task_id: string | null }> {
  return db
    .prepare(
      `SELECT id, status, dispatch_hold, routing_reason, parent_task_id
         FROM tasks WHERE description LIKE ?`,
    )
    .all(`%[council-source-session:${SESSION_ID}]%`) as Array<{
    id: string;
    status: string;
    dispatch_hold: number;
    routing_reason: string | null;
    parent_task_id: string | null;
  }>;
}

before(async () => {
  const dbModule = await import('../../db');
  db = dbModule.getDb();
  closeDbFn = dbModule.closeDb;
  storeModule = await import('../store');
  repositories = new storeModule.CouncilRepositories();
  const contracts = await import('../contracts');
  canonicalHashFn = contracts.canonicalHash;
  SCHEMA_VERSIONS = contracts.SCHEMA_VERSIONS;
  fixtures = await import('../contracts/fixtures/examples');
  const parentModule = await import('../kanban/parent-task');
  const planModule = await import('../kanban/plan-service');
  const handoffModule = await import('../kanban/verdict-handoff');
  const parentAdapter = new parentModule.CanonicalParentTaskAdapter({ repositories, db });
  planService = new planModule.CouncilActionPlanService({ repositories, db, parentAdapter });
  handoff = new handoffModule.CouncilVerdictHandoff({
    repositories,
    db,
    planService,
    parentAdapter,
  });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('company-a', 'Company A', 'company-a', '{}', ?, ?)`,
  ).run(now, now);

  session = makeStoredSession();
  verdict = makeVerdict([makeAction('action-1'), makeAction('action-2')]);
  insertAdvisorCards(27);
});

after(() => {
  closeDbFn();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test('one verdict converts to ONE intended set bound to company, parent and verdict revision', async () => {
  const owner = principal(OWNER);
  const before = totalTasks();
  const receipt = await handoff.intendActionTaskSet(owner, SESSION_ID, verdict);

  assert.equal(receipt.session_id, SESSION_ID);
  assert.equal(receipt.tenant_id, 'tenant-a');
  assert.equal(receipt.company_id, 'company-a');
  assert.equal(receipt.verdict_revision, 1);
  assert.equal(receipt.verdict_sha256, verdict.content_sha256);
  assert.deepEqual(receipt.action_ids, ['action-1', 'action-2']);
  assert.equal(receipt.action_item_count, 2, 'only verdict action proposals are planned, never advisor cards');
  assert.equal(receipt.execution_authorized, false);
  assert.equal(receipt.creates_tasks, 0);
  assert.ok(receipt.parent_task_id, 'the ONE session parent is linked');

  const plans = db
    .prepare(`SELECT COUNT(*) AS n FROM council_action_proposals WHERE session_id = ?`)
    .get(SESSION_ID) as { n: number };
  assert.equal(plans.n, 1, 'exactly one intended task set');
  const links = db
    .prepare(`SELECT COUNT(*) AS n FROM council_kanban_links WHERE session_id = ?`)
    .get(SESSION_ID) as { n: number };
  assert.equal(links.n, 1, 'exactly one session parent');
  assert.equal(totalTasks(), before + 1, 'conversion creates the parent only, no action tasks');
  const tagged = tasksForSession();
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].id, receipt.parent_task_id);
});

test('replay returns the same receipt and creates no second plan, parent or task', async () => {
  const owner = principal(OWNER);
  const first = await handoff.exportIntendedActionTaskSet(
    owner,
    SESSION_ID,
    (db.prepare(`SELECT id FROM council_action_proposals WHERE session_id = ?`).get(SESSION_ID) as { id: string }).id,
  );
  const tasksBefore = totalTasks();
  const replay = await handoff.intendActionTaskSet(owner, SESSION_ID, verdict);
  assert.equal(replay.replayed, true);
  assert.equal(replay.handoff_id, first.handoff_id);
  assert.equal(replay.plan_id, first.plan_id);
  assert.equal(replay.parent_task_id, first.parent_task_id);
  const plans = db
    .prepare(`SELECT COUNT(*) AS n FROM council_action_proposals WHERE session_id = ?`)
    .get(SESSION_ID) as { n: number };
  assert.equal(plans.n, 1);
  const links = db
    .prepare(`SELECT COUNT(*) AS n FROM council_kanban_links WHERE session_id = ?`)
    .get(SESSION_ID) as { n: number };
  assert.equal(links.n, 1);
  assert.equal(totalTasks(), tasksBefore, 'replay creates zero tasks');
});

test('export and list create zero tasks', async () => {
  const owner = principal(OWNER);
  const planId = (db.prepare(`SELECT id FROM council_action_proposals WHERE session_id = ?`).get(SESSION_ID) as { id: string }).id;
  const tasksBefore = totalTasks();
  const exported = await handoff.exportIntendedActionTaskSet(owner, SESSION_ID, planId);
  assert.equal(exported.plan_id, planId);
  assert.equal(exported.action_item_count, 2);
  const listed = await handoff.listIntendedActionTaskSets(owner, SESSION_ID);
  assert.equal(listed.length, 1);
  assert.equal(totalTasks(), tasksBefore, 'export/replay creates zero tasks');
});

test('plan approval is not execution authority and materialization refuses without the separate approval', async () => {
  const owner = principal(OWNER);
  const planId = (db.prepare(`SELECT id FROM council_action_proposals WHERE session_id = ?`).get(SESSION_ID) as { id: string }).id;
  const tasksBefore = totalTasks();
  await assert.rejects(
    () => handoff.materializeApprovedActionTasks(owner, SESSION_ID, planId),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === 'COUNCIL_PLAN_NOT_FULLY_APPROVED',
  );
  assert.equal(totalTasks(), tasksBefore, 'no task before the action-plan approval');
});

test('after the separate action-plan approval, exactly two HELD tasks exist under the ONE parent', async () => {
  const owner = principal(OWNER);
  const planId = (db.prepare(`SELECT id FROM council_action_proposals WHERE session_id = ?`).get(SESSION_ID) as { id: string }).id;
  await planService.decidePlanItem(owner, SESSION_ID, planId, 'action-1', 'approved');
  await planService.decidePlanItem(owner, SESSION_ID, planId, 'action-2', 'approved');

  const materialized = await handoff.materializeApprovedActionTasks(owner, SESSION_ID, planId);
  assert.equal(materialized.kind, 'materialized');
  if (materialized.kind !== 'materialized') return;
  assert.equal(materialized.created_count, 2);
  assert.equal(materialized.links.length, 2);
  assert.equal(materialized.released_count, 0, 'plan approval never releases or executes');

  const tagged = tasksForSession();
  assert.equal(tagged.length, 3, 'ONE parent + exactly two action tasks; 27 advisor cards create none');
  const parent = tagged.find((task) => task.id === materialized.parent_task_id);
  assert.ok(parent, 'the parent task is among them');
  const children = tagged.filter((task) => task.id !== materialized.parent_task_id);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.status, 'backlog');
    assert.equal(child.dispatch_hold, 1, 'born held behind the council assembly hold');
    assert.equal(child.routing_reason, 'council_plan_assembling');
    assert.equal(child.parent_task_id, materialized.parent_task_id, 'bound to the ONE session parent');
  }

  const released = db
    .prepare(
      `SELECT COUNT(*) AS n FROM council_events
        WHERE session_id = ? AND payload_json LIKE '%action_task_released%'`,
    )
    .get(SESSION_ID) as { n: number };
  assert.equal(released.n, 0, 'nothing was released or dispatched');

  const tasksBefore = totalTasks();
  const replayed = await handoff.materializeApprovedActionTasks(owner, SESSION_ID, planId);
  assert.equal(replayed.kind, 'materialized');
  if (replayed.kind === 'materialized') {
    assert.equal(replayed.created_count, 0);
    assert.equal(replayed.linked_count, 2);
    assert.deepEqual(
      replayed.links.map((link) => link.task_id).sort(),
      materialized.links.map((link) => link.task_id).sort(),
      'replay reuses the same task IDs',
    );
  }
  assert.equal(totalTasks(), tasksBefore, 'replay creates zero tasks');
});
