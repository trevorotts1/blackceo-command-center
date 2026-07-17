/**
 * Regression test — task-dispatcher.ts resolveSpecialistSessionKey()
 * canonical-slug alias probing must be SYMMETRIC.
 *
 * BUG (found by U36's judge, 2026-07-16):
 *   The alias-fallback block in resolveSpecialistSessionKey guarded probing
 *   with `canonicalSlug !== candidateSlug` — so a workspace slug that is
 *   ALREADY canonical (e.g. `billing-finance`, which is a member of
 *   CANONICAL_SLUGS in src/lib/routing/canonical-slug.ts) skipped the whole
 *   alias-fallback block. Resolution only ever ran alias → canonical
 *   (`webdev` → `web-development`), never canonical → alias.
 *
 *   Concretely: a box with workspace slug `billing-finance` and an
 *   OpenClaw runtime directory provisioned under the shorter LEGACY alias
 *   name `dept-billing` (not `dept-billing-finance`) could never dispatch —
 *   resolveSpecialistSessionKey returned null, autoDispatchTask HELD the
 *   task as 'routed_but_not_dispatched', and nothing errored. Silent stall.
 *
 * FIX:
 *   Probe every alias slug that maps to the same canonical department
 *   (`expandDeptSlugAliases`, the documented inverse of `canonicalDeptSlug`,
 *   already exported from canonical-slug.ts but previously unused here) —
 *   not just the single forward-computed canonical slug — so BOTH
 *   directions resolve: legacy-alias-slug → canonical runtime dir, AND
 *   canonical-slug → legacy-alias runtime dir.
 *
 * FAIL-FIRST: against pre-fix task-dispatcher.ts, resolveSpecialistSessionKey
 * returns `null` for this exact shape (workspace slug already canonical,
 * runtime dir only exists under a legacy alias name) — the assertion below
 * fails for that reason (documented in the failure message), not a random
 * crash. Post-fix it returns `agent:dept-billing:<sessionId>`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolated DB (set BEFORE @/lib/db is imported) ────────────────────────────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dispatch-alias-reverse-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// ── Isolated fake $HOME/.openclaw/agents/ tree — the ONLY runtime dir that
// exists is `dept-billing` (the legacy alias form), mirroring the exact live
// shape the judge described: canonical workspace slug `billing-finance`,
// runtime dir `dept-billing`. `dept-billing-finance` (the canonical dir) is
// deliberately absent.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dispatch-alias-home-'));
const AGENTS_ROOT = path.join(TMP_HOME, '.openclaw', 'agents');
fs.mkdirSync(path.join(AGENTS_ROOT, 'dept-billing'), { recursive: true });
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
// Force mac-mini path resolution (HOME-relative), never the VPS Docker
// `/data/.openclaw` branch, regardless of what host this runs on.
process.env.OPENCLAW_PLATFORM = 'mac-mini';

// ── autoDispatchTask end-to-end fixture env ───────────────────────────────
// Clears the gates that sit BETWEEN GUARD 7 and resolveSpecialistSessionKey
// so the second (orchestration-level) test below can prove the task record
// itself advances, not just the isolated resolver function. None of these
// touch the bug under test — they clear UNRELATED gates (model sovereignty,
// write-back auth) so the run reaches the alias-resolution code path.
process.env.SOVEREIGN_DEFAULT_MODEL = 'openrouter/deepseek/deepseek-chat';
process.env.ALLOW_INSECURE_OPEN_API = 'true';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];

type TaskDispatcherModule = typeof import('../../src/lib/task-dispatcher');
let resolveSpecialistSessionKey: TaskDispatcherModule['resolveSpecialistSessionKey'];
let autoDispatchTask: TaskDispatcherModule['autoDispatchTask'];

type AgentType = import('../../src/lib/types').Agent;

const WS_ID = 'ws-billing-finance-reverse-probe';
const AGENT_ID = 'agent-billing-finance-reverse-probe';
const SOP_ID = 'sop-billing-finance-reverse-probe';

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  closeDb = db.closeDb;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  db.getDb(); // runs the full migration chain against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  // Workspace slug is ALREADY the ZHC canonical bare slug — the exact
  // precondition the guard mishandled (CANONICAL_SLUGS has 'billing-finance').
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'billing-finance', 'Billing & Finance', '💰', 'default', 1, ?, ?)`,
    [WS_ID, now, now],
  );
  // A real agents row (autoDispatchTask JOINs agents) — needed for the
  // orchestration-level (autoDispatchTask) test below.
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, specialist_type, workspace_id, created_at, updated_at)
     VALUES (?, 'Finance Ops Bot', 'Finance Operations', '🤖', 'standby', 0, 'permanent', ?, ?, ?)`,
    [AGENT_ID, WS_ID, now, now],
  );
  // A real SOP row so the Triad gate (GUARD 7) clears.
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, steps, success_criteria, department, created_at, updated_at)
     VALUES (?, 'Reverse Probe Test SOP', 'reverse-probe-test-sop', 'Step 1.', 'Done.', 'billing-finance', ?, ?)`,
    [SOP_ID, now, now],
  );

  const td = (await import('../../src/lib/task-dispatcher')) as TaskDispatcherModule;
  resolveSpecialistSessionKey = td.resolveSpecialistSessionKey;
  autoDispatchTask = td.autoDispatchTask;
});

test.after(async () => {
  // Matches this suite's convention (tests/unit/u33-c-02-dispatch-triad-gate.test.ts):
  // close the OpenClaw client's shared, non-unref'd periodic timer so the
  // process can exit cleanly.
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try {
    const g = globalThis as Record<string, NodeJS.Timeout | undefined>;
    const timer = g['__openclaw_cache_cleanup_timer__'];
    if (timer) { clearInterval(timer); delete g['__openclaw_cache_cleanup_timer__']; }
  } catch { /* ignore */ }
  try {
    if (typeof closeDb === 'function') closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test('resolveSpecialistSessionKey finds a legacy-alias runtime dir (dept-billing) for an ALREADY-canonical workspace slug (billing-finance)', () => {
  // Role/name are deliberately NON-matching so attempts 2 and 3 (role slug,
  // name slug) cannot accidentally resolve this before the alias-fallback
  // block under test ever runs — this test must exercise attempt 1b, not a
  // later fallback attempt.
  const agent: AgentType = {
    id: AGENT_ID,
    name: 'Finance Ops Bot',
    role: 'Finance Operations',
    avatar_emoji: '🤖',
    status: 'standby',
    is_master: false,
    workspace_id: WS_ID,
    specialist_type: 'permanent',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const key = resolveSpecialistSessionKey(agent, 'mission-control-finance-ops-bot', WS_ID, 'test-reverse-probe');

  assert.equal(
    key,
    'agent:dept-billing:mission-control-finance-ops-bot',
    'resolveSpecialistSessionKey must find the legacy-alias runtime dir "dept-billing" for a ' +
      'workspace whose slug is ALREADY the canonical "billing-finance" — pre-fix this returns ' +
      'null (the alias-fallback block never runs because canonicalSlug === candidateSlug), which ' +
      'is exactly the silent-stall bug: a task routed to this agent would be HELD forever as ' +
      '"routed_but_not_dispatched" despite the dept-billing runtime existing on disk.',
  );
});

// ── Orchestration-level (autoDispatchTask) end-to-end proof ─────────────────
//
// The unit test above proves the resolver function directly. This test drives
// the REAL autoDispatchTask() — the actual production orchestrator, not a
// stand-in — against a REAL task row in the REAL temp DB, with the SAME
// billing-finance/dept-billing shape, and proves the TASK RECORD ITSELF now
// advances where it previously could not: pre-fix it is silently HELD
// (`routed_but_not_dispatched`, status frozen in 'backlog' forever, nothing
// throws — exactly the reported symptom); post-fix it clears that gate
// entirely and reaches `chat.send`, flipping the task to 'in_progress'.
//
// The only stub is the OpenClaw gateway network boundary itself
// (isConnected/call on the singleton client) — every other gate (Triad, model
// sovereignty, write-back auth) is cleared with REAL rows / documented env
// flags, not bypassed, so this test still exercises the genuine dispatch
// pipeline around the fix.
test('autoDispatchTask actually dispatches a task in the billing-finance/dept-billing shape (task advances to in_progress)', async () => {
  const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
  const client = getOpenClawClient();
  // Skip the real connect() entirely (no network activity, no timers) —
  // isConnected() lying true is the ONLY thing that lets us reach the
  // alias-resolution code path without a live gateway.
  client.isConnected = () => true;
  // Stub the one external call this path makes past the fix: chat.send.
  client.call = (async () => ({ ok: true })) as typeof client.call;

  const taskId = 'task-billing-finance-reverse-probe-e2e';
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks
       (id, title, description, status, priority, assigned_agent_id, workspace_id, department,
        sop_id, persona_id, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', ?, ?, 'billing-finance', ?, ?, ?, ?)`,
    [
      taskId,
      'Reverse probe E2E dispatch task',
      'A fully-groomed task proving dispatch reaches the alias-resolved runtime.',
      AGENT_ID,
      WS_ID,
      SOP_ID,
      'hormozi-100m-offers',
      now,
      now,
    ],
  );

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test-reverse-probe-e2e'));

  const taskRow = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(
    taskRow?.status,
    'in_progress',
    'the task must advance to in_progress — pre-fix it is HELD forever in backlog by the ' +
      'RESOLVER-DISPATCH gate (routed_but_not_dispatched) because resolveSpecialistSessionKey ' +
      'returns null for this exact billing-finance/dept-billing shape',
  );

  const heldEvents = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'routed_but_not_dispatched'`,
    [taskId],
  );
  assert.equal(
    heldEvents.length,
    0,
    'no routed_but_not_dispatched event may exist — the task must never be HELD for ' +
      '"no_specialist_runtime" once the alias-fallback block is symmetric',
  );

  const dispatchedEvents = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'task_dispatched'`,
    [taskId],
  );
  assert.equal(dispatchedEvents.length, 1, 'exactly one task_dispatched event must be written');
});
