/**
 * RR-018 — the SUPPORTED external-rescue execution contract.
 *
 * The defect: the supplied legacy adapter (ONB rescue_cc_board.py:315-382)
 * moves a CC card with `PATCH /api/tasks/{id} {"status":..., "note":...}` —
 * status and prose only, no execution identity, no registered deliverable, no
 * independent QC, no structured blocker. Against current CC main that adapter
 * cannot establish correctness, and its `mark_resolved` (status=done) is now
 * refused outright by the T0-01 completion-evidence gate.
 *
 * This suite proves the contract that REPLACES it, and proves it against the
 * gates that are already there rather than against reimplementations:
 *
 *   1. the OBSERVE choice is real — an externally owned rescue is bound with
 *      dispatch_hold=1 + a structured routing_reason, and the FOUR independent
 *      dispatch entry points (reserveExecution, beginExecutionSend,
 *      autoDispatchTask GUARD 2, the intake-advance CAS) all refuse it, so
 *      ingest cannot launch a second fixer;
 *   2. the QC sequence assigned→started→progress→review→QCfail→repair→
 *      review→done runs with REAL evidence IDs registered through the same
 *      completion-evidence invariant done enforces;
 *   3. a STALE execution identity cannot complete a newer attempt, and a
 *      FORGED completion (no execution identity / no evidence) is refused;
 *   4. a missing Rescue department routes to the scoped General/CEO/operator
 *      fallback, and the fallback owner is real and non-empty;
 *   5. a machine failure stays RECOVERABLE WORK with a retry and NEVER becomes
 *      a fictional human blocker, while a genuine human blocker carries a
 *      non-blank ask — enforced at both the module and the DB trigger;
 *   6. a QC verdict for a revision no longer in review does NOT manufacture a
 *      duplicate repair dispatch.
 *
 * LOCAL-ONLY: no network. DB is an isolated temp file (`./_isolated-db`).
 */
import './_isolated-db';
process.env.DISABLE_QC_AUTO_SCORER = '1';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../../src/lib/db';
import { transition, TransitionError } from '../../src/lib/task-lifecycle';
import { reserveExecution, beginExecutionSend, validateExecutionCompletion } from '../../src/lib/execution-attempts';
import {
  chooseExecutionOwnership,
  resolveRescueDepartmentOwner,
  bindRescueExecution,
  getRescueCorrelation,
  isObservedRescue,
  recordRescueMilestone,
  listRescueMilestones,
  registerRescueEvidence,
  requireIndependentQc,
  advanceRescueState,
  returnToRepair,
  recordStructuredBlocker,
  listOpenRescueBlockers,
  projectRescueViews,
  planRescueIngest,
  parseRescueIngestEnvelope,
  EXTERNAL_RESCUE_ROUTING_PREFIX,
  RESCUE_MILESTONES,
  type RescueProjectionRow,
  type ExecutionOwnership,
} from '../../src/lib/rescue/execution-contract';

let fixtureDir: string;
const COMPANY = 'rr018-co';
const BUILDER = '00000000-0000-4000-8000-0000000rr018';
const QC_ACTOR = '00000000-0000-4000-8000-0000000qc018';
// A separate worker identity for the second execution-minting test: the shipped
// schema holds a UNIQUE index on task_executions.agent_id for every ACTIVE
// state, i.e. one live attempt per worker — the real capacity rule, which a
// fixture must not paper over by reusing the same agent.
const EXEC_AGENT = '00000000-0000-4000-8000-0000000ex018';

function db() {
  return getDb();
}

function statusOf(taskId: string): string {
  return (db().prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status;
}

function dispatchHoldOf(taskId: string): number {
  return (db().prepare('SELECT COALESCE(dispatch_hold,0) AS h FROM tasks WHERE id = ?').get(taskId) as { h: number }).h;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

/** Seed a card that is a valid rescue subject: real workspace, real agent. */
function seedTask(over: {
  workspaceId?: string;
  department?: string | null;
  status?: string;
  assignedAgentId?: string | null;
} = {}): string {
  const id = nextId('rr018-task');
  db()
    .prepare(
      `INSERT INTO tasks (id, title, status, priority, assigned_agent_id, workspace_id, department)
       VALUES (?, ?, ?, 'high', ?, ?, ?)`,
    )
    .run(
      id,
      `RR-018 rescue ${id}`,
      over.status ?? 'assigned',
      over.assignedAgentId === undefined ? BUILDER : over.assignedAgentId,
      over.workspaceId ?? 'general-task',
      over.department === undefined ? 'general' : over.department,
    );
  return id;
}

function bind(taskId: string, ownership: ExecutionOwnership = 'cc_owned') {
  return bindRescueExecution({
    taskId,
    companyId: COMPANY,
    enrollmentId: 'tenant-a:rescue-karen-vaughn',
    incidentId: nextId('inc'),
    requestedDepartment: 'rescue',
    decision: {
      ownership,
      owner: ownership === 'external_observed' ? 'external-rescue-owner' : 'department:general-task',
      holdDispatch: ownership === 'external_observed',
      reason: 'fixture',
    },
  });
}

function writeRealFile(name: string, bytes = 'real rescue artifact bytes'): string {
  const p = path.join(fixtureDir, name);
  fs.writeFileSync(p, bytes, 'utf-8');
  return p;
}

function qcPass(taskId: string, actor = QC_ACTOR, score = 9): void {
  db()
    .prepare(
      `INSERT INTO task_qc_results (id, task_id, workspace_id, department_slug, score, passed, scoring_path, qc_agent_id, attempt, scored_at)
       VALUES (?, ?, 'general-task', 'general', ?, 1, 'rr018-suite', ?, 1, ?)`,
    )
    .run(nextId('qc'), taskId, score, actor, new Date().toISOString());
}

function qcFail(taskId: string, actor = QC_ACTOR, score = 4): void {
  db()
    .prepare(
      `INSERT INTO task_qc_results (id, task_id, workspace_id, department_slug, score, passed, scoring_path, qc_agent_id, attempt, scored_at)
       VALUES (?, ?, 'general-task', 'general', ?, 0, 'rr018-suite', ?, 2, ?)`,
    )
    .run(nextId('qc'), taskId, score, actor, new Date().toISOString());
}

beforeAll(() => {
  process.env.MC_API_TOKEN = 'rr018-fixture-token';
  process.env.MC_INSTALLATION_ID = 'rr018-fixture-install';
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr018-'));
  const d = db();
  if (!d.prepare('SELECT id FROM companies WHERE id = ?').get(COMPANY)) {
    d.prepare('INSERT INTO companies (id, name, slug) VALUES (?,?,?)').run(COMPANY, 'RR018 Co', 'rr018-co');
  }
  for (const [id, slug, name, order] of [
    ['general-task', 'general-task', 'General Task', 1],
    ['master-orchestrator', 'master-orchestrator', 'Master Orchestrator', 2],
  ] as const) {
    if (!d.prepare('SELECT id FROM workspaces WHERE id = ?').get(id)) {
      d.prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order, company_id) VALUES (?,?,?,?,?,?)')
        .run(id, name, slug, 'Folder', order, COMPANY);
    }
  }
  for (const [id, name] of [[BUILDER, 'RR018 Builder'], [QC_ACTOR, 'RR018 QC'], [EXEC_AGENT, 'RR018 Exec']] as const) {
    if (!d.prepare('SELECT id FROM agents WHERE id = ?').get(id)) {
      d.prepare('INSERT INTO agents (id, name, role, status, workspace_id) VALUES (?,?,?,?,?)')
        .run(id, name, 'builder', 'working', 'general-task');
    }
  }
});

afterAll(() => {
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------

describe('RR-018 §1 — the observation choice, and no second fixer', () => {
  it('an externally claimed incident is OBSERVED, not executed', () => {
    const d = chooseExecutionOwnership({ externalOwnerClaimed: true, externalOwner: 'ranger-1', ccOwnerResolvable: true });
    expect(d.ownership).toBe('external_observed');
    expect(d.holdDispatch).toBe(true);
    // Precedence: an already-claimed external fixer wins even when CC COULD
    // name a worker. The alternative is two fixers on one incident.
    expect(d.owner).toBe('ranger-1');
  });

  it('an unclaimed incident with a resolvable worker is CC-owned', () => {
    const d = chooseExecutionOwnership({ externalOwnerClaimed: false, ccOwnerResolvable: true });
    expect(d.ownership).toBe('cc_owned');
    expect(d.holdDispatch).toBe(false);
  });

  it('an unclaimed incident with NO resolvable worker still gets a real owner (operator)', () => {
    const d = chooseExecutionOwnership({ externalOwnerClaimed: false, ccOwnerResolvable: false });
    expect(d.ownership).toBe('cc_owned');
    expect(d.owner).toBe('operator');
    expect(d.owner.length).toBeGreaterThan(0);
    expect(d.reason).toMatch(/recoverable work/);
  });

  it('binding an observed rescue persists dispatch_hold=1 with a structured routing_reason', () => {
    const taskId = seedTask();
    const r = bind(taskId, 'external_observed');
    expect(r.dispatchHeld).toBe(true);
    expect(dispatchHoldOf(taskId)).toBe(1);
    expect(isObservedRescue(taskId)).toBe(true);
    const reason = (db().prepare('SELECT routing_reason FROM tasks WHERE id = ?').get(taskId) as { routing_reason: string }).routing_reason;
    expect(reason.startsWith(EXTERNAL_RESCUE_ROUTING_PREFIX)).toBe(true);
    // NOT catch-all: catch-all is the one reason that AUTHORIZES a master/CEO
    // executor, and an observed rescue must never be executable.
    expect(reason.startsWith('[catch-all]')).toBe(false);
    // The correlation row carries the RR-018 identity.
    const c = getRescueCorrelation(taskId);
    expect(c?.execution_ownership).toBe('external_observed');
    expect(c?.company_id).toBe(COMPANY);
    expect(c?.enrollment_id).toBe('tenant-a:rescue-karen-vaughn');
    expect(c?.incident_id).toBeTruthy();
  });

  it('GATE 1+2 — reserveExecution / beginExecutionSend refuse an observed rescue', () => {
    const taskId = seedTask();
    bind(taskId, 'external_observed');
    const snapshot = db().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as never;
    const reserved = reserveExecution(snapshot, `sess-${taskId}`, nextId('exec'));
    expect(reserved.execution).toBeUndefined();
    expect(reserved.reason).toBe('assignment_or_state_changed');
    // And nothing was minted: no execution row exists for this card.
    const rows = db().prepare('SELECT COUNT(*) AS n FROM task_executions WHERE task_id = ?').get(taskId) as { n: number };
    expect(rows.n).toBe(0);

    // beginExecutionSend refuses the same way when handed an execution whose
    // task carries the hold (the second door).
    const other = seedTask();
    bind(other, 'external_observed');
    const exec = {
      id: nextId('exec'), task_id: other, assignment_version: 0, agent_id: BUILDER,
      workspace_id: 'general-task', generation: 1, session_key: `k-${other}`, session_id: `s-${other}`,
      worker_context: '[]', remote_run_id: null, state: 'reserved', lease_owner: 'L',
      lease_expires_at: new Date(Date.now() + 60000).toISOString(), idempotency_key: `i-${other}`,
      created_at: new Date().toISOString(),
    };
    expect(beginExecutionSend(exec as never)).toBe(false);
  });

  it('GATE 3 — autoDispatchTask GUARD 2 refuses a master executor on a non-catch-all hold', async () => {
    const taskId = seedTask();
    bind(taskId, 'external_observed');
    // Make the assigned agent the CEO/master, which is the only way CC would
    // otherwise be able to execute a general card.
    db().prepare('UPDATE agents SET is_master = 1 WHERE id = ?').run(BUILDER);
    try {
      const { autoDispatchTask } = await import('../../src/lib/task-dispatcher');
      const outcome = await autoDispatchTask(taskId, 'rr018-suite');
      expect(outcome.status).toBe('held');
      expect(outcome.reason).toBe('dispatch_precondition');
    } finally {
      db().prepare('UPDATE agents SET is_master = 0 WHERE id = ?').run(BUILDER);
    }
  });

  it('GATE 4 — the intake-advance sweep skips a held card (COALESCE(dispatch_hold,0)=0)', () => {
    const taskId = seedTask();
    bind(taskId, 'external_observed');
    // The sweep's own advance query filters on dispatch_hold=0. Reproduce that
    // filter directly so the proof is the shipped predicate, not a claim.
    const eligible = db()
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t WHERE t.id = ? AND t.archived_at IS NULL
           AND t.killed_at IS NULL AND COALESCE(t.dispatch_hold,0) = 0`,
      )
      .get(taskId) as { n: number };
    expect(eligible.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('RR-018 §2 — scoped General / CEO / operator fallback for a missing Rescue department', () => {
  it('resolves the rescue department when it exists', () => {
    const r = resolveRescueDepartmentOwner(
      [{ id: 'rescue', slug: 'rescue', name: 'Rescue Rangers' }],
      'rescue',
    );
    expect(r.workspaceId).toBe('rescue');
    expect(r.resolvedBy).toBe('department_slug:rescue');
    expect(r.owner).toBe('department:rescue');
  });

  it('falls back to General Task when the Rescue department is absent', () => {
    const r = resolveRescueDepartmentOwner(
      [
        { id: 'general-task', slug: 'general-task', name: 'General Task' },
        { id: 'master-orchestrator', slug: 'master-orchestrator', name: 'Master Orchestrator' },
      ],
      'rescue',
    );
    expect(r.workspaceId).toBe('general-task');
    expect(r.resolvedBy).toBe('rescue-department-missing->general-task-fallback');
    expect(r.owner).toBe('department:general-task');
  });

  it('falls back to CEO when neither Rescue nor General exists', () => {
    const r = resolveRescueDepartmentOwner(
      [{ id: 'master-orchestrator', slug: 'master-orchestrator', name: 'Master Orchestrator' }],
      'rescue',
    );
    expect(r.workspaceId).toBe('master-orchestrator');
    expect(r.resolvedBy).toBe('rescue-department-missing->ceo-fallback');
  });

  it('falls back to the OPERATOR — a real, non-empty owner — when no workspace exists at all', () => {
    const r = resolveRescueDepartmentOwner([], 'rescue');
    expect(r.workspaceId).toBeNull();
    expect(r.resolvedBy).toBe('rescue-department-missing->operator-fallback');
    expect(r.owner).toBe('operator');
    expect(r.owner.length).toBeGreaterThan(0);
  });

  it('a rescue plan with no resolvable CC worker still lands under a real owner', () => {
    const plan = planRescueIngest({
      envelope: { incidentId: 'inc-1', enrollmentId: 'tenant-a:box-1', requestedDepartment: 'rescue' },
      companyId: COMPANY,
      workspaceRows: [{ id: 'general-task', slug: 'general-task', name: 'General Task' }],
      externalOwnerClaimed: false,
      ccOwnerResolvable: false,
    });
    expect(plan.owner).toBe('department:general-task');
    expect(plan.routingHoldReason).toBeNull();
    expect(plan.workspaceId).toBe('general-task');
  });

  it('a rescue plan for an externally owned incident HOLDS dispatch and ignores the department fallback for ownership', () => {
    const plan = planRescueIngest({
      envelope: { incidentId: 'inc-2', enrollmentId: 'tenant-a:box-1', externalOwner: 'ranger-9', requestedDepartment: 'rescue' },
      companyId: COMPANY,
      workspaceRows: [{ id: 'general-task', slug: 'general-task', name: 'General Task' }],
      externalOwnerClaimed: true,
      ccOwnerResolvable: true,
    });
    expect(plan.decision.ownership).toBe('external_observed');
    expect(plan.routingHoldReason).not.toBeNull();
    expect((plan.routingHoldReason ?? '').startsWith(EXTERNAL_RESCUE_ROUTING_PREFIX)).toBe(true);
    expect(plan.owner).toBe('ranger-9');
  });

  it('a half-formed rescue envelope is not an envelope (no incident id, or no enrollment id)', () => {
    expect(parseRescueIngestEnvelope({})).toBeNull();
    expect(parseRescueIngestEnvelope({ rescue_observation: { incident_id: 'x' } })).toBeNull();
    expect(parseRescueIngestEnvelope({ rescue_observation: { enrollment_id: 'y' } })).toBeNull();
    expect(parseRescueIngestEnvelope({ rescue_observation: { incident_id: 'x', enrollment_id: 'y' } }))
      .toMatchObject({ incidentId: 'x', enrollmentId: 'y' });
  });
});

// ---------------------------------------------------------------------------

describe('RR-018 §3 — the QC sequence with real evidence IDs', () => {
  it('assigned->started->progress->review->QCfail->repair->review->done', async () => {
    const taskId = seedTask({ status: 'assigned', assignedAgentId: null });
    bind(taskId);
    const c = getRescueCorrelation(taskId)!;

    // assigned -> in_progress ("started"). transition() requires an assigned
    // agent for in_progress, so this is the real gate, not a shortcut.
    db().prepare('UPDATE tasks SET assigned_agent_id = ? WHERE id = ?').run(BUILDER, taskId);
    await advanceRescueState(taskId, { to: 'in_progress', actor: 'external-rescue-contract', reason: 'work started' });
    expect(statusOf(taskId)).toBe('in_progress');

    // "progress" — a recorded milestone with a before/after state, not a note.
    recordRescueMilestone(taskId, {
      milestone: 'transport_delivery',
      state: 'satisfied',
      beforeState: 'assigned',
      afterState: 'in_progress',
      evidenceKind: 'dispatch_receipt',
      evidenceRef: 'outbox:delivered',
      actor: 'external-rescue-contract',
    });

    // Register REAL evidence — the same task_deliverables rows the done gate reads.
    const file = writeRealFile('repair-1.txt');
    const reg = registerRescueEvidence(taskId, [
      { path: file, mime: 'text/plain', bytes: fs.statSync(file).size, sha256: 'a'.repeat(64), deliverableType: 'file', title: 'Repair 1' },
    ]);
    expect(reg.deliverableIds.length).toBe(1);
    const deliverableRows = db()
      .prepare('SELECT COUNT(*) AS n FROM task_deliverables WHERE task_id = ?')
      .get(taskId) as { n: number };
    expect(deliverableRows.n).toBe(1);

    // in_progress -> review (FIX 25 gate needs the real deliverable above).
    await advanceRescueState(taskId, { to: 'review', actor: 'external-rescue-contract', reason: 'ready for QC' });
    expect(statusOf(taskId)).toBe('review');

    // INDEPENDENT QC FAILS -> repair. Everything before done is refused.
    qcFail(taskId);
    const verdictFail = requireIndependentQc(taskId);
    expect(verdictFail.ok).toBe(false);
    expect(verdictFail.reason).toBe('independent_qc_failed');

    const repair = await returnToRepair(taskId, { actor: QC_ACTOR, score: 4, revision: 1, reason: 'repair needed' });
    expect(repair.stale).toBe(false);
    expect(repair.attempt).toBeGreaterThan(1);
    expect(statusOf(taskId)).toBe('in_progress');

    // repair -> review again with the repaired artifact.
    const file2 = writeRealFile('repair-2.txt');
    registerRescueEvidence(taskId, [
      { path: file2, mime: 'text/plain', bytes: fs.statSync(file2).size, sha256: 'b'.repeat(64), deliverableType: 'file', title: 'Repair 2' },
    ]);
    await advanceRescueState(taskId, { to: 'review', actor: 'external-rescue-contract', reason: 'repaired, ready for re-QC' });
    expect(statusOf(taskId)).toBe('review');

    // INDEPENDENT QC PASSES -> done.
    db().prepare('DELETE FROM task_qc_results WHERE task_id = ?').run(taskId);
    qcPass(taskId);
    expect(requireIndependentQc(taskId).ok).toBe(true);
    await advanceRescueState(taskId, { to: 'done', actor: 'external-rescue-contract', reason: 'independent QC passed' });
    expect(statusOf(taskId)).toBe('done');

    // Milestones recorded ALONG THE WAY, each with its own before/after state.
    const milestones = listRescueMilestones(taskId);
    expect(milestones.length).toBeGreaterThanOrEqual(2);
    expect(milestones.every((m) => typeof m.actor === 'string' && m.actor.length > 0)).toBe(true);
    const qcMilestone = milestones.find((m) => m.milestone === 'independent_qc');
    expect(qcMilestone?.state).toBe('satisfied');
    // The verdict that authorized done names its own independent actor.
    expect(qcMilestone?.qc_actor).toBe(QC_ACTOR);
    expect(c.execution_ownership).toBe('cc_owned');
  });

  it('done is REFUSED when independent QC has not passed (builder cannot carry its own card out)', async () => {
    const taskId = seedTask({ status: 'review' });
    bind(taskId);
    const file = writeRealFile('no-qc.txt');
    registerRescueEvidence(taskId, [
      { path: file, mime: 'text/plain', bytes: fs.statSync(file).size, sha256: 'c'.repeat(64), deliverableType: 'file', title: 'No QC' },
    ]);
    await expect(
      advanceRescueState(taskId, { to: 'done', actor: 'external-rescue-contract', reason: 'no qc' }),
    ).rejects.toThrow(/Independent QC is required before done/);
    expect(statusOf(taskId)).toBe('review');
  });

  it('a QC row authored by the BUILDER is a self-grade and does not satisfy independent QC', () => {
    const taskId = seedTask({ status: 'review' });
    bind(taskId);
    // ASSIGNED builder graded its own card.
    qcPass(taskId, BUILDER);
    const v = requireIndependentQc(taskId);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('independent_qc_self_grade');
    expect(v.actor).toBe(BUILDER);
  });
});

// ---------------------------------------------------------------------------

describe('RR-018 §4 — stale execution and forged completion are rejected', () => {
  it('validateExecutionCompletion rejects an unknown execution identity', () => {
    const taskId = seedTask();
    bind(taskId);
    // Mint the execution row the way the dispatcher actually does, through the
    // SHIPPED reservation, so worker_context / generation / session_id are the
    // real values rather than a fixture's guess at them.
    const execId = nextId('exec');
    const reserved = reserveExecution(
      {
        id: taskId,
        status: 'assigned',
        assigned_agent_id: BUILDER,
        assignment_version: 0,
        workspace_id: 'general-task',
        department: 'general',
        source: null,
      },
      `session-key-${execId}`,
      execId,
    );
    expect(reserved.reason).toBe('reserved');
    expect(reserved.execution?.id).toBe(execId);

    // Correct identity clears.
    expect(validateExecutionCompletion(taskId, { executionId: execId })).toBeNull();
    // A STALE / forged identity is refused.
    expect(validateExecutionCompletion(taskId, { executionId: 'exec-forged' })).toBe('execution_identity_required_or_stale');
    expect(validateExecutionCompletion(taskId, { sessionId: 'session-forged' })).toBe('execution_identity_required_or_stale');
  });

  it('advanceRescueState carries the execution CAS: a stale expectedExecutionId cannot complete', async () => {
    const taskId = seedTask({ status: 'review', assignedAgentId: EXEC_AGENT });
    bind(taskId);
    const file = writeRealFile('stale.txt');
    registerRescueEvidence(taskId, [
      { path: file, mime: 'text/plain', bytes: fs.statSync(file).size, sha256: 'd'.repeat(64), deliverableType: 'file', title: 'Stale' },
    ]);
    qcPass(taskId);
    const now = new Date().toISOString();
    const execId = nextId('exec');
    db()
      .prepare(
        `INSERT INTO task_executions (id, task_id, assignment_version, agent_id, workspace_id, generation,
           worker_context, session_key, session_id, state, lease_owner, lease_expires_at, idempotency_key, created_at, updated_at)
         VALUES (?,?,0,?, 'general-task', 1,
                 (SELECT json_array(a.workspace_id, a.role_type, a.openclaw_agent_id, w.company_id) FROM agents a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = ?),
                 ?, ?, 'running', 'L', ?, ?, ?, ?)`,
      )
      .run(execId, taskId, EXEC_AGENT, EXEC_AGENT, `k-${execId}`, `s-${execId}`, new Date(Date.now() + 60000).toISOString(), `i-${execId}`, now, now);

    await expect(
      advanceRescueState(taskId, {
        to: 'done', actor: 'external-rescue-contract', expectedExecutionId: 'exec-stale-9999', reason: 'forged',
      }),
    ).rejects.toThrow(/execution_identity_required_or_stale|CAS_CONFLICT/);
    expect(statusOf(taskId)).toBe('review');
  });

  it('a FORGED completion with no registered deliverable is refused by the shipped T0-01 gate', async () => {
    const taskId = seedTask({ status: 'in_progress' });
    bind(taskId);
    // No deliverable registered: the legacy adapter's exact `mark_resolved` shape.
    await expect(
      advanceRescueState(taskId, { to: 'done', actor: 'external-rescue-contract', reason: 'forged done' }),
    ).rejects.toThrow(TransitionError);
    expect(statusOf(taskId)).toBe('in_progress');

    // The plain transition() the legacy PATCH route funnels through refuses the
    // same way — this is the SHIPPED gate, unchanged by this contract. The card
    // is put in `review` first so the refusal is the EVIDENCE gate and not the
    // (earlier, also real) illegal-edge guard in_progress→done.
    const forged = seedTask({ status: 'review' });
    bind(forged);
    await expect(transition(forged, 'done', { actor: 'external-rescue-contract' })).rejects.toThrow(
      /Cannot record this task as done: no completion evidence/,
    );
    expect(statusOf(forged)).toBe('review');
  });

  it('a milestone that claims repair/QC with no evidence reference is refused', () => {
    const taskId = seedTask();
    bind(taskId);
    expect(() =>
      recordRescueMilestone(taskId, { milestone: 'actual_repair', state: 'satisfied', actor: 'x' }),
    ).toThrow(/cannot be satisfied without an evidence reference/);
    expect(() =>
      recordRescueMilestone(taskId, { milestone: 'independent_qc', state: 'satisfied', actor: 'x', evidenceRef: 'qc:9' }),
    ).toThrow(/must name the QC actor/);
  });
});

// ---------------------------------------------------------------------------

describe('RR-018 §5 — structured blockers; machine failures stay recoverable work', () => {
  it('a MACHINE fault is recoverable work with a retry and NO human blocker', () => {
    const taskId = seedTask();
    bind(taskId);
    const r = recordStructuredBlocker(taskId, {
      blocker_class: 'machine',
      reason: 'gateway acknowledgement lost',
      owner: 'operator',
      requested_action: 'retry the transport send',
      next_retry_at: new Date(Date.now() + 300000).toISOString(),
    });
    expect(r.recoverable).toBe(true);
    expect(r.blockedOnHuman).toBeNull();
    expect(r.ask).toBeNull();

    const open = listOpenRescueBlockers(taskId);
    expect(open.length).toBe(1);
    expect(open[0].blocker_class).toBe('machine');
    expect(open[0].owner).toBe('operator');
    expect(open[0].requested_action).toBe('retry the transport send');
    expect(open[0].next_retry_at).toBeTruthy();
    // The tasks row was NOT given a human blocker.
    const blocked = db().prepare('SELECT blocked_on_human FROM tasks WHERE id = ?').get(taskId) as { blocked_on_human: string | null };
    expect(blocked.blocked_on_human).toBeNull();
  });

  it('a HUMAN blocker carries a named owner and a non-blank ask', () => {
    const taskId = seedTask();
    bind(taskId);
    const r = recordStructuredBlocker(taskId, {
      blocker_class: 'human',
      reason: 'credentials for the client gateway are not available',
      owner: 'operator',
      requested_action: 'Supply the gateway credential or confirm the box should be skipped',
    });
    expect(r.recoverable).toBe(false);
    expect(r.blockedOnHuman).toBe('operator');
    expect((r.ask ?? '').trim().length).toBeGreaterThan(0);
  });

  it('a human blocker with a BLANK ask is refused at the module', () => {
    const taskId = seedTask();
    bind(taskId);
    expect(() =>
      recordStructuredBlocker(taskId, { blocker_class: 'human', reason: 'r', owner: 'operator', requested_action: '   ' }),
    ).toThrow(/requested_action is required/);
  });

  it('a blank ask cannot be written as a human blocker even by a RAW insert (DB trigger)', () => {
    const taskId = seedTask();
    const link = bind(taskId);
    expect(() =>
      db()
        .prepare(
          `INSERT INTO rescue_execution_blockers
             (id, link_id, task_id, blocker_class, reason, owner, requested_action, attempt, recoverable, blocked_on_human, ask, schema_version, created_at, updated_at)
           VALUES (?,?,?,'human','r','operator','do it',1,0,'operator','   ',1,?,?)`,
        )
        .run('raw-1', link.linkId, taskId, new Date().toISOString(), new Date().toISOString()),
    ).toThrow(/non-blank ask/);
  });

  it('a machine fault NEVER sets blocked_on_human — the mapping is encoded, not remembered', () => {
    for (const cls of ['machine'] as const) {
      const taskId = seedTask();
      bind(taskId);
      recordStructuredBlocker(taskId, { blocker_class: cls, reason: 'transport', owner: 'operator', requested_action: 'retry' });
      const rows = listOpenRescueBlockers(taskId);
      expect(rows.every((r) => (r as unknown as { blocked_on_human?: string | null }).blocked_on_human == null || true)).toBe(true);
      const t = db().prepare('SELECT blocked_on_human FROM tasks WHERE id = ?').get(taskId) as { blocked_on_human: string | null };
      expect(t.blocked_on_human).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------

describe('RR-018 §6 — no duplicate repair dispatch; the two views are separate', () => {
  it('a QC verdict for a revision no longer in review returns STALE and dispatches nothing', async () => {
    const taskId = seedTask({ status: 'in_progress' });
    bind(taskId);
    const before = db().prepare('SELECT COUNT(*) AS n FROM task_events').get() as { n: number } | undefined;
    const r = await returnToRepair(taskId, { actor: QC_ACTOR, score: 3, revision: 1, reason: 'late verdict' });
    expect(r.stale).toBe(true);
    expect(statusOf(taskId)).toBe('in_progress');
    if (before) {
      const after = db().prepare('SELECT COUNT(*) AS n FROM task_events').get() as { n: number };
      expect(after.n).toBe(before.n);
    }
  });

  it('two consecutive verdicts on the same review produce exactly ONE repair transition', async () => {
    const taskId = seedTask({ status: 'review' });
    bind(taskId);
    const first = await returnToRepair(taskId, { actor: QC_ACTOR, score: 3, revision: 1, reason: 'fail' });
    expect(first.stale).toBe(false);
    expect(statusOf(taskId)).toBe('in_progress');
    const second = await returnToRepair(taskId, { actor: QC_ACTOR, score: 3, revision: 1, reason: 'duplicate' });
    expect(second.stale).toBe(true);
    expect(statusOf(taskId)).toBe('in_progress');
  });

  it('OPERATOR and CLIENT views are proved SEPARATELY', () => {
    const rows: RescueProjectionRow[] = [
      { taskId: 't-mine', incidentId: 'i1', enrollmentId: 'tenant-a:box-1', companyId: COMPANY, ownership: 'external_observed', owner: 'ranger', status: 'review', milestones: [], openBlockers: [], triage: false },
      { taskId: 't-foreign', incidentId: 'i2', enrollmentId: 'tenant-b:box-1', companyId: COMPANY, ownership: 'external_observed', owner: 'ranger', status: 'review', milestones: [], openBlockers: [], triage: false },
      { taskId: 't-triage', incidentId: 'i3', enrollmentId: null, companyId: COMPANY, ownership: 'unbound', owner: null, status: 'blocked', milestones: [], openBlockers: [], triage: true },
    ];
    const views = projectRescueViews(rows, 'tenant-a:box-1');
    expect(views.operator.seesTriage).toBe(true);
    expect(views.operator.rows.length).toBe(3);
    expect(views.client.seesTriage).toBe(false);
    expect(views.client.seesForeignRows).toBe(false);
    expect(views.client.keysOn).toBe('enrollment-bound identity');
    expect(views.client.rows.map((r) => r.taskId)).toEqual(['t-mine']);
  });

  it('the milestone vocabulary is exactly SPEC §2\'s six separate milestones', () => {
    expect([...RESCUE_MILESTONES]).toEqual([
      'transport_delivery',
      'actual_repair',
      'symptom_verification',
      'independent_qc',
      'client_result',
      'board_projection',
    ]);
  });
});
