/**
 * u083-task-done-requires-qc.test.ts — U083 regression guard.
 *
 * Proves the SCORE-ON-RECORD gate in src/app/api/tasks/[id]/route.ts: an
 * agent-originated review→done transition is REJECTED unless the task carries a
 * PASSING independent QC result (task_qc_results, scoring_path='llm', passed=1).
 * Being the right agent (master / dept QC) is authorisation, not evaluation —
 * authority must never stand in for assessment.
 *
 *   T1  master agent, NO QC result on record        → 403 (no passing score)
 *   T2  master agent, FAILING QC result (passed=0)  → 403 (cannot override a fail)
 *   T3  master agent, PASSING QC result (passed=1)  → 200, task reaches done
 *   T4  PASSING score but scoring_path='heuristic'  → 403 (heuristic is not a real judgement)
 *   T5  the task's OWN builder approves (self-grade) → 403 (independent-QC guard)
 *
 * Hermetic: isolated throwaway DB (./_isolated-db), no network, no real board.
 * Run: node --import tsx --test tests/unit/u083-task-done-requires-qc.test.ts
 */
import './_isolated-db'; // MUST precede any '@/lib/db' import.

import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

type DbModule = typeof import('../../src/lib/db');
type RouteModule = typeof import('../../src/app/api/tasks/[id]/route');

let db: DbModule;
let route: RouteModule;

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb(); // applies schema + full migration chain (role_type, task_qc_results, ...)
  route = await import('../../src/app/api/tasks/[id]/route');
  seedWorkspace();
});

test.after(() => {
  try { db.closeDb(); } catch { /* ignore */ }
});

const WS = `ws-${uuidv4()}`;
const now = () => new Date().toISOString();

function seedWorkspace(): void {
  db.run(
    `INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [WS, 'Marketing', 'marketing', now(), now()],
  );
}

function seedAgent(opts: { isMaster: boolean; roleType?: string }): string {
  const id = uuidv4();
  db.run(
    `INSERT INTO agents (id, name, role, is_master, workspace_id, role_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, opts.isMaster ? 'Master Orchestrator' : 'Builder', opts.isMaster ? 'master' : 'worker',
     opts.isMaster ? 1 : 0, WS, opts.roleType ?? null, now(), now()],
  );
  return id;
}

function seedReviewTask(builderId: string): string {
  const id = uuidv4();
  db.run(
    `INSERT INTO tasks (id, title, status, department, workspace_id, assigned_agent_id,
        created_by_agent_id, qc_reroute_attempts, created_at, updated_at)
     VALUES (?, ?, 'review', 'marketing', ?, ?, ?, 0, ?, ?)`,
    [id, 'U083 fixture task', WS, builderId, builderId, now(), now()],
  );
  return id;
}

// A registered, reachable deliverable so the COMPLETION-EVIDENCE gate (T0-01,
// which fires BEFORE the U083 gate) is satisfied — this test isolates the
// score-on-record gate, not the deliverable gate.
function seedDeliverable(taskId: string): void {
  db.run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at, updated_at)
     VALUES (?, ?, 'url', 'Deliverable', 'https://example.com/deliverable', ?, ?)`,
    [uuidv4(), taskId, now(), now()],
  );
}

function seedQC(taskId: string, opts: { passed: number; score: number; path: string }): void {
  db.run(
    `INSERT INTO task_qc_results (id, task_id, workspace_id, department_slug, score, passed,
        scoring_path, qc_agent_id, attempt, scored_at)
     VALUES (?, ?, ?, 'marketing', ?, ?, ?, NULL, 1, ?)`,
    [uuidv4(), taskId, WS, opts.score, opts.passed, opts.path, now()],
  );
}

function patchDone(taskId: string, agentId: string): Promise<Response> {
  return route.PATCH(
    new NextRequest(`http://localhost/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done', updated_by_agent_id: agentId }),
    }),
    { params: Promise.resolve({ id: taskId }) },
  ) as Promise<Response>;
}

test('T1: master agent, NO QC result on record → 403 (no passing independent score)', async () => {
  const master = seedAgent({ isMaster: true });
  const builder = seedAgent({ isMaster: false });
  const task = seedReviewTask(builder);
  seedDeliverable(task);

  const res = await patchDone(task, master);
  assert.equal(res.status, 403, 'a task with no QC result must be refused');
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /no passing independent QC score/i);
});

test('T2: master agent, FAILING QC result (passed=0) → 403 (cannot override a fail)', async () => {
  const master = seedAgent({ isMaster: true });
  const builder = seedAgent({ isMaster: false });
  const task = seedReviewTask(builder);
  seedDeliverable(task);
  seedQC(task, { passed: 0, score: 4.0, path: 'llm' });

  const res = await patchDone(task, master);
  assert.equal(res.status, 403, 'a failing QC score must be refused');
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /no passing independent QC score/i);
});

test('T3: master agent, PASSING QC result (passed=1) → 200, task reaches done', async () => {
  const master = seedAgent({ isMaster: true });
  const builder = seedAgent({ isMaster: false });
  const task = seedReviewTask(builder);
  seedDeliverable(task);
  seedQC(task, { passed: 1, score: 9.0, path: 'llm' });

  const res = await patchDone(task, master);
  assert.equal(res.status, 200, 'a passing independent QC score must allow review→done');
  const row = db.queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [task]);
  assert.equal(row?.status, 'done', 'the task must actually reach done');
});

test('T4: PASSING score but scoring_path=heuristic → 403 (heuristic is not a real judgement)', async () => {
  const master = seedAgent({ isMaster: true });
  const builder = seedAgent({ isMaster: false });
  const task = seedReviewTask(builder);
  seedDeliverable(task);
  seedQC(task, { passed: 1, score: 9.0, path: 'heuristic' });

  const res = await patchDone(task, master);
  assert.equal(res.status, 403, 'a heuristic (non-llm) score must not satisfy the gate');
});

test('T5: the task\'s OWN builder approves (self-grade) → 403 (independent-QC guard)', async () => {
  const builder = seedAgent({ isMaster: false });
  const task = seedReviewTask(builder); // builder is assigned + creator
  seedDeliverable(task);
  seedQC(task, { passed: 1, score: 9.0, path: 'llm' });

  const res = await patchDone(task, builder);
  assert.equal(res.status, 403, 'a builder must not approve its own work');
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /own builder cannot grade|self-grade/i);
});
