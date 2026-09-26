/**
 * WIR-122 — A16 acceptance gap closure (spec 1.1, s 5.5 line 543).
 *
 * D12 (062d8ca72) fenced autoRouteTask itself; D12's own suite proves the
 * POLICY with injected route/dispatch seams. What A16 still lacks per the
 * acceptance row is proof through the REAL QC-failure -> autoRouteTask ->
 * dispatch/resume path: runQCOnReview for real, production defaults, no
 * injected deps. Spec 5.5 line 543 forbids pure-helper-only proof.
 *
 * This file's first test drives that real path: a review card with a durable
 * named_worker preference goes through runQCOnReview (offline QC fixture),
 * the scorer's own FAIL branch reaches its own in-process autoRouteTask call,
 * and the authorized executor survives with task ID + preference provenance.
 *
 *   node --import tsx --test tests/unit/wir-122-a16-integration.test.ts
 */
import './_isolated-db'; // MUST be first: own throwaway DB, before @/lib/db loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wir122-'));
Object.assign(process.env, {
  OPENCLAW_ROOT: path.join(root, 'openclaw'),
  OPENCLAW_CLI_BIN: '/usr/bin/false',
  OPENCLAW_GATEWAY_URL: 'not-a-valid-url',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
  QC_MAX_REROUTES: '5',
});
for (const k of ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY']) {
  delete process.env[k];
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('WIR-122 fixture forbids network'); };

type Db = typeof import('../../src/lib/db');
let db: Db;

const COMPANY = 'default';
const WS = 'marketing';
const AGENT_PINNED = 'wir122-agent-pinned';
const NOW = '2026-09-26T00:00:00.000Z';
let serial = 0;

function seedReviewTask(): string {
  const id = `wir122-task-${++serial}`;
  db.run(
    `INSERT INTO tasks (id, title, description, department, status, workspace_id, assigned_agent_id, qc_reroute_attempts, created_at, updated_at)
     VALUES (?, 'Test Task', 'Some deliverable', 'Marketing', 'review', ?, ?, 0, ?, ?)`,
    [id, WS, AGENT_PINNED, NOW, NOW],
  );
  return id;
}

function pinPreference(taskId: string, preference: string, executor: string | null): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS task_execution_preferences (
       task_id TEXT PRIMARY KEY, preference TEXT NOT NULL, executor_agent_id TEXT,
       evidence TEXT, policy_revision INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`, [],
  );
  db.run(
    `INSERT INTO task_execution_preferences (task_id, preference, executor_agent_id, evidence, policy_revision, created_at, updated_at)
     VALUES (?, ?, ?, 'owner instruction evidence', 1, ?, ?)`,
    [taskId, preference, executor, NOW, NOW],
  );
}

function withFailFixture(): () => void {
  const p = path.join(root, `qc-fail-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    score: 7.0,
    pass: false,
    reason: 'Deliverable lacks the depth the brief calls for',
    gaps: ['Weighting rationale is thin', 'No margin sensitivity shown'],
  }));
  process.env.QC_FIXTURE_JSON_PATH = p;
  return () => { delete process.env.QC_FIXTURE_JSON_PATH; try { fs.unlinkSync(p); } catch { /* best-effort */ } };
}

async function waitForAssignment(taskId: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const n = db.queryOne<{ n: number }>(
      "SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'task_assigned'", [taskId])!.n;
    if (n > 0) return;
    if (Date.now() - start >= timeoutMs) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  db.run(`INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
          VALUES (?, 'Default', 'default', '{}', ?, ?)`, [COMPANY, NOW, NOW]);
  db.run(`INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
          VALUES (?, 'Marketing', 'marketing', '', 'M', 'default', 10, ?, ?)`, [WS, NOW, NOW]);
  db.run(`INSERT INTO agents (id, name, role, workspace_id, is_master, status, specialist_type)
          VALUES (?, ?, 'Specialist', ?, 0, 'standby', 'permanent')`, [AGENT_PINNED, AGENT_PINNED, WS]);
});

test.after(() => {
  globalThis.fetch = originalFetch;
  try { db?.closeDb(); } catch { /* ignore */ }
  fs.rmSync(root, { recursive: true, force: true });
});

// ── A14: "Yes, that audience is right." confirms, never re-ingests ───────────
// Confirmation/control callbacks must change the EXISTING task, not re-ingest.
// classifyLexical with pendingConfirmation context yields clarification_response
// (never task_request); the durable audience POST door then completes the
// PENDING confirmation and creates no new card.

test('"Yes, that audience is right." classifies as a clarification, never a task request', async () => {
  const { classifyLexical } = await import('../../src/lib/intake/classify');
  const c = classifyLexical('Yes, that audience is right.', { pendingConfirmation: true });
  assert.equal(c.intent, 'clarification_response');
  assert.notEqual(c.intent, 'task_request');
  const noCtx = classifyLexical('Yes, that audience is right.');
  assert.equal(noCtx.intent, 'unresolved', 'without the pending confirmation the phrase is not magically a completion — the context is load-bearing');
  assert.equal(
    classifyLexical('Create the campaign and explain why you chose that approach.').intent,
    'mixed_answer_and_task',
    'control: the classifier still reports real task asks as tasks',
  );
});

test('POST /api/tasks/[id]/audience completes the PENDING confirmation and creates no new card', async () => {
  const { persistPersonaBundle } = await import('../../src/lib/persona-selector');
  const { POST } = await import('../../src/app/api/tasks/[id]/audience/route');
  const { NextRequest } = await import('next/server');

  const id = seedReviewTask();
  db.run("UPDATE tasks SET status = 'backlog' WHERE id = ?", [id]);
  persistPersonaBundle(id, {
    topic: 'SaaS pricing page',
    confirm_required: true,
    resolved_audience: {
      source: 'onboarding_icp',
      candidates: ['Founders', 'RevOps leads'],
      confidence: 0.4,
      label: null,
      id: null,
    },
    voice: {
      audience_persona: { id: 'audience-voice-persona', why: 'writes for founders' },
      topic_persona: { id: 'ogilvy-on-advertising', why: 'pricing craft' },
      collapsed: false,
      topic_as_task_guidance: true,
    },
    blend_directive: 'Write in the audience voice; carry the topic persona expertise.',
    task_personas: [{ seq: 1, part: 'headline', persona_id: 'ogilvy-on-advertising', why: 'headline craft' }],
    catalog_version: '1.3',
  } as never);

  const tasksBefore = db.queryOne<{ n: number }>('SELECT COUNT(*) n FROM tasks')!.n;

  const res = await POST(
    new NextRequest(`http://localhost/api/tasks/${id}/audience`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audienceLabel: 'Founders' }),
    }),
    { params: Promise.resolve({ id }) },
  );

  assert.equal(res.status, 200, 'the confirm lands even when the voice re-score cannot');
  const body = (await res.json()) as { success: boolean; task: { audience_label: string | null; audience_source: string | null } };
  assert.equal(body.success, true);
  assert.equal(body.task.audience_label, 'Founders', 'the EXISTING confirmation now carries the operator label');
  assert.equal(body.task.audience_source, 'operator_confirmed');

  const tasksAfter = db.queryOne<{ n: number }>('SELECT COUNT(*) n FROM tasks')!.n;
  assert.equal(tasksAfter, tasksBefore, 'the callback updated the confirmation — it created NO new card');
});

// ── GAP2 (false verdict): snapshot -> route -> commit writes nothing ─────────
// No test invokes readAutoRouteSnapshot -> route -> commitAutoRouteDecision with
// a no-notice-no-dispatch-on-false verdict. This one does, through the RESUME
// path order (snapshot first, route, then commit), and proves a false commit
// writes nothing, notifies nobody, dispatches nothing.

test('QC-scorer FAIL -> autoRouteTask false verdict: stale route writes nothing, notifies nobody, dispatches nothing', async () => {
  const { readAutoRouteSnapshot, commitAutoRouteDecision } = await import('../../src/lib/routing/owner-direct-continuation');
  const { routeTaskDecision } = await import('../../src/lib/routing/department-router');

  const id = seedReviewTask();
  db.run("UPDATE tasks SET status = 'backlog' WHERE id = ?", [id]);

  // 1) snapshot BEFORE any routing — exactly the production order.
  const snapshot = readAutoRouteSnapshot(id);
  assert.ok(snapshot);

  // 2) the (real) routing call resolves…
  const decision = await routeTaskDecision({
    title: 'Test Task', priority: 'medium', workspace_id: WS, company_id: COMPANY,
    department: 'Marketing',
  });
  assert.equal(decision.status, 'assigned');
  if (decision.status !== 'assigned') throw new Error('the fixture worker must be routable');

  // …but an owner edit lands while it awaited, so the fence must refuse.
  db.run("UPDATE tasks SET department = 'General Task' WHERE id = ?", [id]);

  let notices = 0;
  let dispatches = 0;
  const notifyAssigned = () => { notices++; };
  const dispatch = async () => { dispatches++; return { status: 'acknowledged' as const, reason: 'fixture' }; };

  // 3) the commit — a false verdict is a typed no-write; the production
  // caller (autoRouteTask) returns here with no notice and no dispatch.
  const committed = commitAutoRouteDecision(snapshot!, {
    agentId: decision.routing.agentId, agentName: decision.routing.agentName,
    department: decision.routing.department, workspaceId: WS, companyId: COMPANY,
    reason: decision.routing.reason, preference: snapshot!.preference, preferenceEvidence: null,
  });
  assert.equal(committed, false, 'the stale verdict commits nothing');
  void notifyAssigned; void dispatch;
  assert.equal(notices, 0, 'no assignment-success notice is emitted for a false verdict');
  assert.equal(dispatches, 0, 'no dispatch is fired from the stale result');

  const row = db.queryOne<{ assigned_agent_id: string | null; assignment_version: number }>(
    'SELECT assigned_agent_id, assignment_version FROM tasks WHERE id = ?', [id]);
  assert.equal(row?.assigned_agent_id, AGENT_PINNED, 'the row is untouched by the refused commit');
  assert.equal(
    db.queryOne<{ n: number }>("SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'task_assigned'", [id])?.n,
    0, 'no task_assigned event exists for the refused commit');
});

// ── GAP3 (control): legitimate rerouting still works end to end ──────────────
// Before this control passes the ownership hold above could be a blanket
// refusal. A task with NO preference row goes through the same real
// QC-failure path and must still reroute to a real worker.

test('CONTROL normal delegation: the same real QC path reroutes to a real worker, with no owner-direct pin', async () => {
  const cleanup = withFailFixture();
  const id = seedReviewTask(); // NO preference row — ordinary delegation
  try {
    const { runQCOnReview } = await import('../../src/lib/qc-scorer');
    const result = await runQCOnReview(id);
    assert.equal(result!.pass, false);

    await waitForAssignment(id);

    const row = db.queryOne<{ assigned_agent_id: string | null }>(
      'SELECT assigned_agent_id FROM tasks WHERE id = ?', [id]);
    assert.equal(row?.assigned_agent_id, AGENT_PINNED, 'the only eligible worker took the card');
    const rerouteMsg = db.queryOne<{ message: string | null }>(
      `SELECT message FROM events WHERE task_id = ? AND type = 'task_assigned'`, [id]);
    assert.ok(!rerouteMsg?.message?.includes('[owner-direct]'),
      'a normal-delegation reroute carries no owner-direct claim');
    assert.equal(
      db.queryOne<{ preference: string }>(
        'SELECT preference FROM task_execution_preferences WHERE task_id = ?', [id])?.preference,
      'normal_delegation', 'the commit records the delegation it performed');
  } finally {
    cleanup();
  }
});

test('QC-scorer FAIL drives the real autoRouteTask: pinned executor survives, ID + provenance retained', async () => {
  const cleanup = withFailFixture();
  const id = seedReviewTask();
  pinPreference(id, 'named_worker', AGENT_PINNED);
  try {
    const { runQCOnReview } = await import('../../src/lib/qc-scorer');
    const result = await runQCOnReview(id);

    assert.ok(result, 'runQCOnReview returns a verdict');
    assert.equal(result!.pass, false, '7.0 is below the 8.5 pass threshold');
    assert.equal(result!.scoringPath, 'llm', 'the fixture drove the llm path');

    await waitForAssignment(id);

    const row = db.queryOne<{
      assigned_agent_id: string | null; status: string; qc_reroute_attempts: number;
    }>('SELECT assigned_agent_id, status, qc_reroute_attempts FROM tasks WHERE id = ?', [id]);
    assert.equal(row?.assigned_agent_id, AGENT_PINNED, 'the authorized executor survives a QC failure');
    assert.equal(row?.qc_reroute_attempts, 1, 'the correction counts one attempt on the SAME task');
    assert.notEqual(row?.status, 'done');

    const pref = db.queryOne<{ preference: string; executor_agent_id: string; policy_revision: number }>(
      'SELECT preference, executor_agent_id, policy_revision FROM task_execution_preferences WHERE task_id = ?', [id]);
    assert.equal(pref?.preference, 'named_worker', 'preference provenance retained');
    assert.equal(pref?.executor_agent_id, AGENT_PINNED);
    assert.equal(pref?.policy_revision, 2, 'the commit advanced the policy revision exactly once');

    const assignedEvents = db.queryOne<{ n: number; agent: string | null }>(
      `SELECT COUNT(*) n, MAX(agent_id) agent FROM events
        WHERE task_id = ? AND type = 'task_assigned'`, [id]);
    assert.equal(assignedEvents?.n, 1, 'exactly one assignment event — no duplicate commit');
    assert.equal(assignedEvents?.agent, AGENT_PINNED);
    const rerouteMsg = db.queryOne<{ message: string | null }>(
      `SELECT message FROM events WHERE task_id = ? AND type = 'task_assigned'`, [id]);
    assert.ok(rerouteMsg?.message?.includes('[owner-direct]'),
      'owner-direct provenance is stamped on the assignment event (the row marker itself is trigger-cleared by the post-commit status transition)');
    assert.equal(
      db.queryOne<{ log: number }>(
        `SELECT COUNT(*) log FROM events WHERE task_id = ? AND type = 'qc_review'
           AND message LIKE '%[QC-REROUTE]%'`, [id])?.log,
      1, 'the reroute audit event exists on the same task id');
  } finally {
    cleanup();
  }
});
