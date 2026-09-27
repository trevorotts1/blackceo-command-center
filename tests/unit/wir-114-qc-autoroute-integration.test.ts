/**
 * WIR-114 — the A14+A16 acceptance gaps, closed against the REAL chain.
 *
 * D12 proved the fenced continuation POLICY with injected route/dispatch seams
 * (tests/unit/d12-auto-route-continuation.test.ts). The A16 gaps that survived:
 *   3. No test drives the ACTUAL QC-failure path — real `runQCOnReview` FAIL
 *      branch → its own in-process `autoRouteTask(taskId, task.workspace_id)`
 *      call → dispatch leg. Spec 1.1 s 5.5 line 543 forbids pure-helper-only
 *      proof; the seams D12 injects are exactly what that rule excludes.
 *   4. The normal-delegation control on that same REAL path (no preference
 *      row) — legitimate rerouting still works end to end.
 *   2. The explicit three-call production composition
 *      (readAutoRouteSnapshot → route → commitAutoRouteDecision) asserted to
 *      write/notify/dispatch NOTHING on a false verdict.
 *   1. `Yes, that audience is right.` classifies as `clarification_response`
 *      and the EXISTING durable confirm door (POST /api/tasks/[id]/audience)
 *      completes the pending confirmation with NO new card.
 *
 * Everything here runs with production defaults: no AutoRouteDeps seam is
 * injected on the QC path. The only thing stood down is the OpenClaw gateway
 * URL (an unroutable value), so the dispatch leg runs to its honest held
 * outcome — deterministically, locally, never a network send.
 *
 * Offline posture mirrors D12: isolated temp DB, keys cleared, fetch throws,
 * Telegram suppressed.
 */
import './_isolated-db'; // MUST be first: before any '@/lib/db' import.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wir114-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(root, 'fixture.db'),
  CC_TEST_FIXTURE_ROOT: root,
  OPENCLAW_ROOT: path.join(root, 'openclaw'),
  OPENCLAW_COMPANY_ROOT: path.join(root, 'company'),
  WORKSPACE_BASE_PATH: root,
  OPENCLAW_WORKSPACE_ROOT: root,
  BCC_DEVICE_IDENTITY_DIR: path.join(root, 'identity'),
  OPENCLAW_CLI_BIN: '/usr/bin/false',
  // The dispatch leg must reach its REAL gateway code path and fail there.
  OPENCLAW_GATEWAY_URL: 'not-a-valid-url',
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
  SOP_EMBEDDING_PROVIDER: 'openai',
  OPENAI_API_KEY: '',
  QC_MAX_REROUTES: '5',
});
for (const k of ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY']) {
  delete process.env[k];
}
// No model call may leave this process. The gateway client uses `ws`, so this
// guard only ever fires on a provider/embedding attempt — which must not happen.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('WIR-114 fixture forbids network'); };

type Db = typeof import('../../src/lib/db');
let db: Db;

const COMPANY = 'wir114-co';
const WS_ENG = 'ws-wir114-eng';
const WS_GEN = 'ws-wir114-gen';
const AGENT_PINNED = 'agent-wir114-pinned';
const AGENT_GT = 'agent-wir114-gt';
const ROSTER = [AGENT_PINNED, AGENT_GT];
const NOW = '2026-09-26T00:00:00.000Z';
let serial = 0;

function worker(id: string, ws: string, master: number, status = 'standby'): void {
  db.run(
    'INSERT INTO agents(id,name,role,workspace_id,is_master,status,specialist_type) VALUES(?,?,?,?,?,?,?)',
    [id, id, 'Specialist', ws, master, status, 'permanent'],
  );
}

/** A card in `review` with the authorized executor already on it. */
function seedReviewTask(): string {
  const id = `wir114-task-${++serial}`;
  db.run(
    `INSERT INTO tasks(id,title,description,priority,status,department,workspace_id,assigned_agent_id,
       assignment_version,routing_reason,qc_reroute_attempts,dispatch_hold,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, 'Fix the widget', 'The owner wants the widget fixed before launch.', 'medium', 'review',
      'Engineering', WS_ENG, AGENT_PINNED, 1, null, 0, 0, NOW, NOW],
  );
  return id;
}

/** Durable preference row, same DDL the writer's own transaction uses. */
function pinPreference(taskId: string, preference: string, executor: string): void {
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

/** A FAIL fixture whose gaps avoid classifyFailure's un-reroutable regexes. */
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

/** The scorer's autoRouteTask call is fire-and-forget: poll for its durable mark. */
async function waitForAssignment(taskId: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const n = db.queryOne<{ n: number }>(
      "SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'task_assigned'", [taskId])!.n;
    if (n > 0) return;
    if (Date.now() - start >= timeoutMs) return; // caller asserts — a timeout shows up as the real row state
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Poll for a specific events row (the dispatch leg is fire-and-forget too). */
async function waitForEvent(taskId: string, like: string, timeoutMs = 6000): Promise<number> {
  const start = Date.now();
  for (;;) {
    const n = db.queryOne<{ n: number }>(
      'SELECT COUNT(*) n FROM events WHERE task_id = ? AND message LIKE ?', [taskId, like])!.n;
    if (n > 0) return n;
    if (Date.now() - start >= timeoutMs) return 0;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The scorer's own .then() follow-through is async too — poll for its status write. */
async function waitForStatus(taskId: string, status: string, timeoutMs = 5000): Promise<string | null> {
  const start = Date.now();
  for (;;) {
    const row = db.queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
    if (row?.status === status) return row.status;
    if (Date.now() - start >= timeoutMs) return row?.status ?? null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [COMPANY, COMPANY, COMPANY]);
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [WS_ENG, 'Engineering', 'engineering', COMPANY]);
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [WS_GEN, 'General Task', 'general-task', COMPANY]);
  worker(AGENT_PINNED, WS_ENG, 0);
  worker(AGENT_GT, WS_GEN, 0);
  fs.mkdirSync(path.join(root, 'openclaw', 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'openclaw', 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'main' }] } }));
});

test.after(() => {
  globalThis.fetch = originalFetch;
  try { db?.closeDb(); } catch { /* ignore */ }
  fs.rmSync(root, { recursive: true, force: true });
});

// ── GAP 3: the REAL QC FAIL -> autoRouteTask -> dispatch leg ─────────────────

test('GAP 3: real runQCOnReview FAIL keeps the pinned executor (no injected seams)', async () => {
  const cleanup = withFailFixture();
  const id = seedReviewTask();
  pinPreference(id, 'named_worker', AGENT_PINNED);
  const tasksBefore = db.queryOne<{ n: number }>('SELECT COUNT(*) n FROM tasks')!.n;
  try {
    const { runQCOnReview } = await import('../../src/lib/qc-scorer');
    const result = await runQCOnReview(id);

    assert.ok(result, 'runQCOnReview returns a verdict');
    assert.equal(result!.pass, false, '7.0 is below the 8.5 pass threshold');
    assert.equal(result!.scoringPath, 'llm', 'the fixture drove the llm path');

    await waitForAssignment(id);
    const status = await waitForStatus(id, 'in_progress'); // the scorer's own success follow-through

    const row = db.queryOne<{
      assigned_agent_id: string | null; status: string; qc_reroute_attempts: number; assignment_version: number;
    }>('SELECT assigned_agent_id, status, qc_reroute_attempts, assignment_version FROM tasks WHERE id = ?', [id]);
    assert.equal(row?.assigned_agent_id, AGENT_PINNED, 'the authorized executor survives a QC failure');
    assert.equal(row?.qc_reroute_attempts, 1, 'the correction counts one attempt on the SAME row');
    assert.equal(row?.assignment_version, 2, 'exactly one fenced assignment advanced the revision');
    assert.equal(status, 'in_progress', 'the scorer moved the rerouted card out of backlog (the raw-writer successor)');

    // Durable authorization: the preference row. (`tasks.routing_reason` is
    // NULL here BY DESIGN — the migration-133 `tasks_routing_reconsider`
    // trigger clears it on any later status change; that is the catch-all
    // preservation rule, not a lost pin.)
    const pref = db.queryOne<{ preference: string; executor_agent_id: string; policy_revision: number }>(
      'SELECT preference, executor_agent_id, policy_revision FROM task_execution_preferences WHERE task_id = ?', [id]);
    assert.equal(pref?.preference, 'named_worker', 'preference provenance retained');
    assert.equal(pref?.executor_agent_id, AGENT_PINNED);
    assert.equal(pref?.policy_revision, 2, 'the commit advanced the policy revision exactly once');

    const assigned = db.queryOne<{ n: number; agent: string | null }>(
      `SELECT COUNT(*) n, MAX(agent_id) agent FROM events WHERE task_id = ? AND type = 'task_assigned'`, [id]);
    assert.equal(assigned?.n, 1, 'exactly one assignment event — no duplicate commit');
    assert.equal(assigned?.agent, AGENT_PINNED);
    // The event text is the durable provenance: routing_reason was consumed,
    // the assignment record keeps the owner-direct claim.
    assert.equal(
      db.queryOne<{ n: number }>(
        `SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'task_assigned' AND message LIKE '%[owner-direct]%'`, [id])?.n,
      1, 'the assignment event records the owner-direct authorization');
    assert.equal(
      db.queryOne<{ log: number }>(
        `SELECT COUNT(*) log FROM events WHERE task_id = ? AND type = 'qc_review' AND message LIKE '%[QC-REROUTE]%'`, [id])?.log,
      1, 'the reroute audit event exists on the same task id');
    assert.equal(db.queryOne<{ n: number }>('SELECT COUNT(*) n FROM tasks')!.n, tasksBefore,
      'the correction retained the task id — no new card was minted');

    // The dispatch leg reached its REAL gate offline: triad hold + deferred
    // retry (honest hold), never a network send and never a live execution.
    assert.equal(
      await waitForEvent(id, '%[triad_gate_hold]%'), 1,
      'the real dispatcher held the un-groomed card at its triad gate');
    assert.ok(await waitForEvent(id, '%backing off%') > 0, 'the hold scheduled an honest deferred retry');
    assert.equal(
      db.queryOne<{ n: number }>(
        "SELECT COUNT(*) n FROM task_executions WHERE task_id = ? AND state IN ('reserved','sending','accepted','running','unknown')", [id])?.n,
      0, 'offline: no execution was left live by the held dispatch');
  } finally {
    cleanup();
  }
});

// ── GAP 4: the control on the SAME REAL path ─────────────────────────────────

test('GAP 4 CONTROL: with no preference row the same real path reroutes by delegation', async () => {
  const cleanup = withFailFixture();
  const id = seedReviewTask();
  db.run('UPDATE tasks SET assigned_agent_id = NULL WHERE id = ?', [id]); // ordinary delegation start
  try {
    const { runQCOnReview } = await import('../../src/lib/qc-scorer');
    const result = await runQCOnReview(id);
    assert.equal(result!.pass, false);

    await waitForAssignment(id);
    await waitForStatus(id, 'in_progress');

    const row = db.queryOne<{ assigned_agent_id: string | null }>(
      'SELECT assigned_agent_id FROM tasks WHERE id = ?', [id]);
    assert.ok(row?.assigned_agent_id, 'a real worker took the card — routing still works');
    assert.ok(ROSTER.includes(row!.assigned_agent_id!), 'the worker is one of the eligible roster');
    const pref = db.queryOne<{ preference: string }>(
      'SELECT preference FROM task_execution_preferences WHERE task_id = ?', [id]);
    assert.equal(pref?.preference, 'normal_delegation', 'the commit records the delegation it performed');
    assert.equal(
      db.queryOne<{ n: number }>(
        `SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'task_assigned' AND message LIKE '%[owner-direct]%'`, [id])?.n,
      0, 'a normal-delegation reroute carries no owner-direct claim');
  } finally {
    cleanup();
  }
});

// ── GAP 2: the explicit three-call composition, false verdict ────────────────

test('GAP 2: stale verdict — snapshot -> route -> commit writes nothing, notifies nobody, dispatches nothing', async () => {
  const { readAutoRouteSnapshot, commitAutoRouteDecision } = await import('../../src/lib/routing/owner-direct-continuation');
  const { routeTaskDecision } = await import('../../src/lib/routing/department-router');

  const id = seedReviewTask();
  db.run("UPDATE tasks SET status = 'backlog', assigned_agent_id = NULL, routing_reason = NULL WHERE id = ?", [id]);

  // 1) snapshot BEFORE any routing — exactly the production order.
  const snapshot = readAutoRouteSnapshot(id);
  assert.ok(snapshot);

  // 2) the REAL routing call resolves…
  const decision = await routeTaskDecision({
    title: 'Fix the widget', priority: 'medium', workspace_id: WS_ENG, company_id: COMPANY,
  });
  assert.equal(decision.status, 'assigned');
  if (decision.status !== 'assigned') throw new Error('the fixture roster must be routable');
  assert.ok(ROSTER.includes(decision.routing.agentId));

  // …but an owner edit lands while it awaited, so the fence must refuse.
  db.run("UPDATE tasks SET department = 'General Task' WHERE id = ?", [id]);

  // The fence baseline is the row exactly as it stands when the stale result
  // comes back (the fixture's own seeding updates legitimately bumped the
  // revision trigger already — what must not move is the version FROM HERE).
  const versionBefore = db.queryOne<{ assignment_version: number }>(
    'SELECT assignment_version FROM tasks WHERE id = ?', [id])!.assignment_version;

  // 3) the production caller pattern: notice + dispatch ONLY on commit === true.
  let notices = 0;
  let dispatches = 0;
  const committed = commitAutoRouteDecision(snapshot!, {
    agentId: decision.routing.agentId, agentName: decision.routing.agentName,
    department: decision.routing.department, workspaceId: decision.routing.workspaceId,
    companyId: decision.routing.companyId, reason: decision.routing.reason,
    preference: 'normal_delegation', preferenceEvidence: null,
  });
  if (committed) { notices++; dispatches++; } // mirrors auto-route.ts lines 246-280
  assert.equal(committed, false, 'the stale verdict commits nothing');
  assert.equal(notices, 0, 'no assignment-success notice is emitted for a false verdict');
  assert.equal(dispatches, 0, 'no dispatch is fired from the stale result');

  const row = db.queryOne<{ assigned_agent_id: string | null; assignment_version: number; department: string }>(
    'SELECT assigned_agent_id, assignment_version, department FROM tasks WHERE id = ?', [id]);
  assert.equal(row?.assigned_agent_id, null, 'the row is untouched by the refused commit');
  assert.equal(row?.assignment_version, versionBefore, 'the refused commit advanced no revision');
  assert.equal(row?.department, 'General Task', "the owner's edit stands");
  assert.equal(
    db.queryOne<{ n: number }>("SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'task_assigned'", [id])?.n,
    0, 'no task_assigned event exists for the refused commit');
  assert.equal(
    db.queryOne<{ n: number }>('SELECT COUNT(*) n FROM task_execution_preferences WHERE task_id = ?', [id])?.n,
    0, 'no preference row was written by the refused commit');
});

// ── GAP 1: the audience callback + the EXISTING durable confirm door ─────────

test('GAP 1: "Yes, that audience is right." is a clarification with pending context, never a task', async () => {
  const { classifyLexical } = await import('../../src/lib/intake/classify');
  const ctx = classifyLexical('Yes, that audience is right.', { pendingConfirmation: true });
  assert.equal(ctx.intent, 'clarification_response');
  assert.notEqual(ctx.intent, 'task_request');
  assert.notEqual(ctx.intent, 'mixed_answer_and_task');
  // The pending-confirmation context is load-bearing, not a blanket "yes" rule.
  const noCtx = classifyLexical('Yes, that audience is right.');
  assert.notEqual(noCtx.intent, 'clarification_response');
  assert.notEqual(noCtx.intent, 'task_request');
  // Positive control on the same instrument: a real mixed ask still reads as one.
  assert.equal(
    classifyLexical('Create the campaign and explain why you chose that approach.').intent,
    'mixed_answer_and_task',
    'control: the classifier still reports real task asks as tasks',
  );
});

test('GAP 1: the durable confirm door completes the PENDING confirmation and creates no new card', async () => {
  const { persistPersonaBundle } = await import('../../src/lib/persona-selector');
  const { POST, GET } = await import('../../src/app/api/tasks/[id]/audience/route');

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

  // The gate demonstrably HOLDs before the callback.
  const before = (await (await GET(
    new NextRequest(`http://localhost/api/tasks/${id}/audience`),
    { params: Promise.resolve({ id }) },
  )).json()) as { hold: boolean; state: string };
  assert.equal(before.hold, true, 'the pending confirmation holds before the callback');
  assert.equal(before.state, 'pending');

  const tasksBefore = db.queryOne<{ n: number }>('SELECT COUNT(*) n FROM tasks')!.n;

  // Offline voice re-score fixture (same fixture seam d1-d4 uses).
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'audience-voice-persona', persona_name: 'Audience Voice', score: 2.5,
    interaction_mode: 'leadership', confirm_required: false,
    resolved_audience: {
      source: 'operator_confirmed', candidates: [{ label: 'Founders', audience_persona_id: 'audience-voice-persona', matched_tags: ['founders'] }],
      confidence: 'high', label: 'Founders',
    },
    voice: {
      audience_persona: { id: 'audience-voice-persona', why: 'confirmed audience voice' },
      topic_persona: { id: 'ogilvy-on-advertising', why: 'pricing craft' },
      collapsed: false, topic_as_task_guidance: true,
    },
    blend_directive: 'Write in the confirmed Founders audience voice; carry the topic persona expertise.',
    task_personas: [{ seq: 1, part: 'headline', persona_id: 'ogilvy-on-advertising' }],
    catalog_version: '1.3',
  });
  try {
    const res = await POST(
      new NextRequest(`http://localhost/api/tasks/${id}/audience`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audienceLabel: 'Founders' }),
      }),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(res.status, 200, 'the confirm lands through the existing door');
    const body = (await res.json()) as { success: boolean; rescored: boolean; task: { audience_label: string | null; audience_source: string | null } };
    assert.equal(body.success, true);
    assert.equal(body.task.audience_label, 'Founders', 'the EXISTING confirmation now carries the operator label');
    assert.equal(body.task.audience_source, 'operator_confirmed');
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }

  // The gate is released — the confirmation completed, not duplicated.
  const after = (await (await GET(
    new NextRequest(`http://localhost/api/tasks/${id}/audience`),
    { params: Promise.resolve({ id }) },
  )).json()) as { hold: boolean; state: string };
  assert.equal(after.hold, false, 'the durable confirm released the hold');
  assert.notEqual(after.state, 'pending');

  assert.equal(db.queryOne<{ n: number }>('SELECT COUNT(*) n FROM tasks')!.n, tasksBefore,
    'the callback updated the confirmation — it created NO new card');
});
