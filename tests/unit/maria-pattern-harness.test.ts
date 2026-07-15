/**
 * maria-pattern-harness.test.ts — U32 / C-01 (MASTER SPEC v2, C+I.2).
 *
 * "Maria-pattern proof harness: reproduce all four stuck states on the
 * operator box and prove each net fires." Seeds one fixture card per
 * stuck state (S1 backlog, S2 not-assigned in BOTH flavors, S3 not-QC'd,
 * S4 not-Done), runs the REAL production jobs against them on a throwaway
 * DB, and asserts the documented remedy fires for each — DB-backed, no
 * live gateway, no live GHL, no client box touched.
 *
 * Stuck-state definitions (C+I.1):
 *   S1 stuck-in-Backlog    — created, never leaves `backlog`
 *   S2 stuck-not-assigned  — no agent ever attaches, OR the attached
 *                            "agent" does not actually exist/run
 *   S3 stuck-not-QC'd      — reaches `review`, never gets a verdict
 *   S4 stuck-not-Done      — passes (or should pass) review, never `done`
 *
 * BINARY acceptance mapped to test names below:
 *   (a) S1/S3/S4 remedies — 'S1 stuck-in-Backlog', 'S3 stuck-not-QCd',
 *       'S4a'+'S4b' (done-block 403 + QC promote)
 *   (b) S2-phantom flip — 'S2a stuck-not-assigned (phantom id)': C-03
 *       (skill6-v2 U34) + its mutual dependency C-04 (U35) have shipped, so
 *       this now asserts the POST-fix half of the documented flip — a
 *       `phantom_agent_healed` event (reason `assigned_agent_missing`) is
 *       written and the phantom id is cleared, instead of the old
 *       zero-events silent skip (task-dispatcher.ts's former bare
 *       console.warn+return).
 *   (c) fixture-guard — 'fixture-guard:' tests at the top and bottom of
 *       this file, mirroring src/lib/fixture-guard.ts's own
 *       hard-fail-on-danger pattern (never a real mission-control.db).
 *
 * S2 ("not-assigned") is seeded in BOTH named flavors per the spec's
 * "what": phantom-id (S2a) and no-runtime (S2b). S2b tests
 * resolveSpecialistSessionKey() DIRECTLY rather than driving the full
 * autoDispatchTask() path — see that test's own comment for why (a live
 * OpenClaw gateway WebSocket is not something an automated unit-test
 * harness may depend on).
 *
 * Runs via the Node built-in test runner under tsx, matching every sibling
 * DB-backed job-execution test in this directory (board-hygiene.test.ts,
 * stuck-in-progress-sweep.test.ts, task-status-transition.test.ts,
 * cc-board-dedup-reaper.test.ts) — none of those use vitest; vitest in this
 * repo is reserved for files needing vi.mock/module-isolation
 * (vitest.config.ts's own header comment), which nothing here needs.
 *
 *   node --import tsx --test tests/unit/maria-pattern-harness.test.ts
 *   (or: npm run test:unit, which globs this file in automatically)
 */

// ── env: suppress notify shell-outs, force heuristic-only QC, keep every
// filesystem write inside a throwaway dir. Mirrors board-hygiene.test.ts +
// stuck-in-progress-sweep.test.ts exactly (proven-safe precedent).
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.QC_JUDGE_MODEL;
delete process.env.OLLAMA_CLOUD_API_KEY;
delete process.env.OLLAMA_API_KEY;
delete process.env.DISABLE_BOARD_HYGIENE;
delete process.env.DISABLE_QC_AUTO_SCORER;
delete process.env.INTAKE_ADVANCE_SWEEP_ENABLED;
delete process.env.DISABLE_STALE_TASK_SWEEP;
delete process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP;
delete process.env.QC_FIXTURE_JSON_PATH;
delete process.env.QC_SIMULATE_PROVIDER_DOWN;
delete process.env.OPENCLAW_PLATFORM;
delete process.env.MC_API_TOKEN;
delete process.env.WEBHOOK_SECRET;
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';
// Env-tunable thresholds (board-hygiene.ts:65-79, stale-task-sweep.ts:39-46)
// pinned explicitly — literal compliance with the C-01 "what": "with
// shortened env thresholds (all are env-tunable)". Fixtures below are
// back-dated well past these (same technique board-hygiene.test.ts and
// stuck-in-progress-sweep.test.ts already use and prove reliable).
process.env.STUCK_IN_PROGRESS_MINUTES = '45';
process.env.BOARD_HYGIENE_STALE_BACKLOG_NUDGE_DAYS = '21';
process.env.BOARD_HYGIENE_REVIEW_UNSCORED_HOURS = '24';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(
  path.join(os.tmpdir(), 'cc-maria-harness-workspace-'),
);

import './_isolated-db'; // MUST be first DB-touching import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { getDb, run, queryOne, queryAll } from '../../src/lib/db';
import { runIntakeAdvanceSweep } from '../../src/lib/jobs/intake-advance-sweep';
import { runStaleTaskSweep } from '../../src/lib/jobs/stale-task-sweep';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';
import { runStuckInProgressSweep } from '../../src/lib/jobs/stuck-in-progress-sweep';
import { runQCOnReview } from '../../src/lib/qc-scorer';
import { resolveSpecialistSessionKey } from '../../src/lib/task-dispatcher';
import type { Agent } from '../../src/lib/types';

const db = getDb(); // applies the full migration chain against the throwaway DB

// ── fixture-guard (BINARY acceptance (c)) ───────────────────────────────────
// Mirrors src/lib/fixture-guard.ts's own hard-fail-on-danger pattern: this
// harness must NEVER be able to write to a real box's mission-control.db.
// _isolated-db.ts pins DATABASE_PATH before any other module in this file
// loads (it is the first import); this assertion proves that pin held, both
// before any fixture is seeded and after the whole suite has run.
function assertIsolatedFixtureDatabase(label: string): void {
  const p = process.env.DATABASE_PATH || '';
  assert.ok(p.length > 0, `[fixture-guard:${label}] DATABASE_PATH must be explicitly set to a throwaway fixture file`);
  assert.ok(
    p.startsWith(os.tmpdir()) && p.includes('cc-isolated-'),
    `[fixture-guard:${label}] DATABASE_PATH must be the _isolated-db.ts throwaway path — got "${p}"`,
  );
  assert.ok(
    !p.endsWith('/mission-control.db') && !p.endsWith('\\mission-control.db'),
    `[fixture-guard:${label}] DATABASE_PATH must never resolve to the real production filename`,
  );
}

// ── time helpers ─────────────────────────────────────────────────────────────
function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}
function hoursAgo(h: number): string {
  return minutesAgo(h * 60);
}
function daysAgo(d: number): string {
  return hoursAgo(d * 24);
}

// ── shared fixture builders (mirror stuck-in-progress-sweep.test.ts /
// cc-board-dedup-reaper.test.ts's seedWorkspace, board-hygiene.test.ts's
// seedSopWithCriteria) ───────────────────────────────────────────────────────
function seedWorkspace(slug: string, name = slug): string {
  const id = `${slug}-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [id, name, slug]);
  return id;
}

function seedSopWithCriteria(): string {
  const id = uuidv4();
  run(
    `INSERT INTO sops (id, name, slug, steps, success_criteria, department)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      'Vendor Ledger Reconciliation (Maria harness)',
      `maria-harness-sop-${id.slice(0, 8)}`,
      'Step 1: pull the vendor statement. Step 2: match line items.',
      'Every line item is matched or flagged with a discrepancy note.',
      'finance-accounting',
    ],
  );
  return id;
}

function eventsFor(taskId: string, type: string) {
  return queryAll<{ message: string; created_at: string }>(
    'SELECT message, created_at FROM events WHERE task_id = ? AND type = ? ORDER BY created_at',
    [taskId, type],
  );
}

function taskStatus(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

// ============================================================================
test('fixture-guard: this suite runs ONLY against a throwaway DATABASE_PATH (start)', () => {
  assertIsolatedFixtureDatabase('start');
});

// ============================================================================
// S1 — stuck-in-Backlog: board-hygiene rule 5's 21-day stale-backlog nudge
// (board-hygiene.ts:425-511) must fire. This net is already SHIPPED at HEAD —
// C-01's job is to prove it fires, not to build it (C-02 is the day-0..21
// dead-zone / Triad-stall closure, a separate unit).
// ============================================================================
test('S1 stuck-in-Backlog: a 22-day-old ungroomed card gets the stale-backlog nudge', async () => {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, business_id, updated_at, last_progress_at)
     VALUES (?, ?, 'backlog', NULL, NULL, ?, ?)`,
    [id, 'S1 fixture: draft the vendor onboarding checklist', daysAgo(22), daysAgo(22)],
  );

  const result = await runBoardHygiene();

  assert.ok(result.staleNudgedIds.includes(id), 'S1: the 22-day backlog card must be nudged (board-hygiene rule 5)');
  assert.equal(taskStatus(id), 'backlog', 'S1: nudging never changes status');
  const nudgeEvt = eventsFor(id, 'board_hygiene_stale_nudged');
  assert.equal(nudgeEvt.length, 1, 'S1: exactly one stale-backlog nudge event fires');
});

// ============================================================================
// S2a — stuck-not-assigned, PHANTOM-ID flavor: autoDispatchTask's silent skip.
//
// POST-C-03 state (this is the flip): task-dispatcher.ts's agent-not-found
// branch (see the `healPhantomAgentAssignment` call inside the `if (!agent)`
// guard) used to console.warn and return — ZERO event, ZERO
// recordDispatchFailure, ZERO backoff, ZERO operator alert. That was the
// exact defect the spec names as THE fake-agent root cause (C+I.1 row 4).
// This assertion IS the flip the C-01 spec text predicted verbatim: "the
// harness lands FIRST and encodes today's silent-skip as an expected-failure
// to prove the defect exists, then flips with C-03." C-03 (skill6-v2 U34)
// and its mutual dependency C-04 (U35, the phantom healer shared primitive —
// src/lib/jobs/heal-phantom-assignments.ts) have now shipped together, so
// this test asserts the POST-fix half: a `phantom_agent_healed` event is
// written (reason `assigned_agent_missing`) and the phantom id is cleared —
// never left to re-select and re-skip forever.
// ============================================================================
test('S2a stuck-not-assigned (phantom id): C-03 heals it LOUDLY — the silent skip is gone (post-C-03 flip)', async () => {
  const wsId = seedWorkspace(`s2a-ghost-dept-${uuidv4().slice(0, 8)}`);
  const phantomAgentId = uuidv4(); // deliberately has NO row in `agents`
  const id = uuidv4();

  // A phantom assigned_agent_id can only exist via one of the three mechanisms
  // C+I.1 row 4 names: (i) a `tasks` table that predates the REFERENCES clause,
  // (ii) a migration window with `PRAGMA foreign_keys = OFF`
  // (db/migrations.ts:1140), or (iii) raw SQL bypassing the API route. We
  // reproduce mechanism (ii) directly: toggle foreign_keys OFF for exactly
  // this one INSERT (this DB's schema.ts already bakes the REFERENCES clause
  // in, so without this toggle the phantom insert would itself be rejected).
  db.pragma('foreign_keys = OFF');
  try {
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, business_id, assigned_agent_id, updated_at, last_progress_at)
       VALUES (?, ?, 'assigned', ?, 'default', ?, ?, ?)`,
      [id, 'S2a fixture: phantom-assignee card', wsId, phantomAgentId, hoursAgo(1), hoursAgo(1)],
    );
  } finally {
    db.pragma('foreign_keys = ON');
  }

  await runIntakeAdvanceSweep();

  // Healing (C-03/C-04) never itself advances board status — that remains
  // autoDispatchTask's CAS claim / QC territory, untouched by this fix.
  assert.equal(
    taskStatus(id),
    'assigned',
    'S2a (post-C-03): healing the phantom id does not itself change task status',
  );

  const healedEvents = queryAll<{ message: string; metadata: string | null }>(
    `SELECT message, metadata FROM events WHERE task_id = ? AND type = 'phantom_agent_healed'`,
    [id],
  );
  assert.equal(
    healedEvents.length,
    1,
    'S2a (post-C-03): exactly one phantom_agent_healed event must be written — the silent skip is gone',
  );
  const metadata = JSON.parse(healedEvents[0].metadata ?? '{}');
  assert.equal(metadata.reason, 'assigned_agent_missing', 'S2a (post-C-03): reason must be assigned_agent_missing');
  assert.equal(metadata.dead_agent_id, phantomAgentId, 'S2a (post-C-03): the event must name the dead agent id');
  assert.ok(
    healedEvents[0].message.includes(phantomAgentId),
    'S2a (post-C-03): the event message must name the dead id verbatim',
  );

  const nowAssignedAgentId = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?',
    [id],
  )?.assigned_agent_id;
  assert.notEqual(
    nowAssignedAgentId,
    phantomAgentId,
    'S2a (post-C-03): the phantom id must be healed (cleared, or re-routed by the same C-04 sweep-tail pass) — never left stuck forever',
  );
});

// ============================================================================
// S2b — stuck-not-assigned, NO-RUNTIME flavor: resolveSpecialistSessionKey
// REFUSES the silent `agent:main` fallback and returns null (C+I.1 row 5).
//
// We test the resolver DIRECTLY rather than driving the full autoDispatchTask
// path: past the agent-exists check, autoDispatchTask opens a REAL WebSocket
// to the OpenClaw gateway (src/lib/openclaw/client.ts connect()) — that is
// unsafe/non-deterministic for an automated unit-test harness (no gateway is
// guaranteed reachable in CI; a hung connect() would make the suite flaky or
// hang rather than fail cleanly). The mechanism this stuck state actually
// depends on IS resolveSpecialistSessionKey's refusal — proving it directly,
// isolated from network state, is a faithful, deterministic reproduction.
// Surfacing this hold ON the card (vs. only in task_activities/events) is
// C-06's job, not C-01's. Precedent: tests/unit/cc-board-dedup-reaper.test.ts
// already exercises this exact function the same way (HOME override).
// ============================================================================
test('S2b stuck-not-assigned (no runtime): resolveSpecialistSessionKey refuses the silent agent:main fallback', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-maria-harness-home-'));
  // Deliberately create NO ~/.openclaw/agents/* directory — an entirely
  // unwired department, isolated from whatever runtime dirs happen to exist
  // on the box actually running this test.
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const wsId = seedWorkspace(`s2b-ghost-dept-${uuidv4().slice(0, 8)}`);
    const agentId = uuidv4();
    run(
      'INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)',
      [agentId, 'Ghost Agent (no runtime)', 'Nonexistent Specialist Role', wsId, 'standby'],
    );
    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
    assert.ok(agent, 'S2b: fixture agent row must exist');

    const key = resolveSpecialistSessionKey(agent as Agent, 'sess-maria-harness', wsId, 'maria-harness-test');
    assert.equal(
      key,
      null,
      'S2b: no ~/.openclaw/agents/<dept-slug>/ exists for this department — resolver MUST return null (refuse the agent:main fallback), never a fabricated key',
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ============================================================================
// S3 — stuck-not-QC'd: board-hygiene rule 3 force-scores an unscored review
// card past 24h and surfaces qc_starved (no client judge configured in this
// suite -> heuristic no-key path, which is capped in [6.0, 8.0] and can never
// auto-pass the 8.5 gate). Mirrors board-hygiene.test.ts's proven
// reviewUnscored25h fixture.
// ============================================================================
test("S3 stuck-not-QC'd: a 25h-unscored review card gets force-scored and surfaces qc_starved", async () => {
  const sopId = seedSopWithCriteria();
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, business_id, updated_at, last_progress_at, sop_id)
     VALUES (?, ?, 'review', NULL, NULL, ?, ?, ?)`,
    [id, 'S3 fixture: reconcile the Q4 vendor invoice ledger', hoursAgo(25), hoursAgo(25), sopId],
  );

  const result = await runBoardHygiene();

  assert.ok(result.reviewForceScoredIds.includes(id), "S3: the 25h-unscored review card must be force-scored");
  assert.ok(result.qcStarvedIds.includes(id), 'S3: no client judge configured -> qc_starved must surface');
  const qcEvents = eventsFor(id, 'qc_review');
  assert.ok(qcEvents.length >= 1, 'S3: a qc_review event/verdict must now exist');
  assert.equal(taskStatus(id), 'review', 'S3: a no-key heuristic score never auto-advances the task out of review');
});

// ============================================================================
// S4 — stuck-not-Done, TWO halves on the SAME fixture card:
//   (a) the done-block: the Skill-6 status CONSUMER route 403s status="done"
//       unconditionally, before the DB is even touched (task-lifecycle
//       ground truth, C+I.0 point 7).
//   (b) the QC promote: the ONLY legal path (runQCOnReview PASS >=8.5) DOES
//       advance review -> done via the audited transition() lifecycle.
// ============================================================================
let s4TaskId = '';

test('S4a stuck-not-Done (a): POST /api/tasks/[id]/status status=done -> 403, no mutation', async () => {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, business_id, updated_at, last_progress_at)
     VALUES (?, ?, 'review', NULL, NULL, ?, ?)`,
    [id, 'S4 fixture: file the signed vendor agreement', hoursAgo(1), hoursAgo(1)],
  );

  // MC_API_TOKEN / WEBHOOK_SECRET are explicitly unset in this suite (top of
  // file) -> both auth layers are skipped (the route's own documented
  // dev/same-origin path), and FORBIDDEN_STATUSES is checked BEFORE auth,
  // scope, and DB existence — so this alone proves the universal 403,
  // matching the dedicated route regression tests/unit/task-status-transition
  // .test.ts case 6 (that file additionally proves the signed-auth matrix;
  // this harness does not duplicate that — it proves the done-block is real).
  const { POST } = await import('../../src/app/api/tasks/[id]/status/route');
  const rawBody = JSON.stringify({ status: 'done' });
  const res = (await POST(
    new NextRequest(`http://localhost/api/tasks/${id}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    }),
    { params: Promise.resolve({ id }) },
  )) as unknown as Response;

  assert.equal(res.status, 403, 'S4a: status=done must always 403, regardless of auth/scope');
  assert.equal(taskStatus(id), 'review', 'S4a: the rejected write must never touch the DB');

  s4TaskId = id; // hand off to S4b: same card, still untouched in `review`.
});

test('S4b stuck-not-Done (b): the ONLY legal promote path (QC PASS) advances review -> done, audited', async () => {
  assert.ok(s4TaskId, 'S4b depends on S4a having seeded + verified the fixture card first');

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-maria-qc-fixture-'));
  const fixturePath = path.join(fixtureDir, 'pass.json');
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({ score: 9.0, pass: true, reason: 'Maria-harness fixture PASS', gaps: [] }),
  );
  // QC_FIXTURE_JSON_PATH (src/lib/fixture-guard.ts's own documented test seam)
  // forces a deterministic verdict with zero live-model cost — the SAME seam
  // fixture-guard.ts hard-fails on if ever set in NODE_ENV=production. We are
  // NOT in production (asserted/forced at the top of this file), so this is
  // exactly the sanctioned test path, not a bypass of anything real.
  process.env.QC_FIXTURE_JSON_PATH = fixturePath;
  try {
    const result = await runQCOnReview(s4TaskId);
    assert.ok(result, 'S4b: runQCOnReview must return a verdict');
    assert.equal(result?.pass, true, 'S4b: the fixture-forced verdict must PASS');
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  assert.equal(taskStatus(s4TaskId), 'done', 'S4b: a genuine PASS verdict is the ONLY thing that may promote review -> done');

  const auditRow = queryOne<{ from_status: string; to_status: string; actor: string }>(
    'SELECT from_status, to_status, actor FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
    [s4TaskId],
  );
  assert.equal(auditRow?.from_status, 'review', 'S4b: task_events must record review as the origin');
  assert.equal(auditRow?.to_status, 'done', 'S4b: task_events must record done as the destination');
  assert.equal(auditRow?.actor, 'qc-auto-scorer', 'S4b: the audited actor is the QC auto-scorer, never the builder itself');

  const qcEvents = eventsFor(s4TaskId, 'qc_review');
  assert.ok(qcEvents.length >= 1, 'S4b: a qc_review event records the PASS verdict');
});

// ============================================================================
// Coverage: the remaining two named jobs (runStaleTaskSweep,
// runStuckInProgressSweep) run cleanly against a healthy control fixture —
// completing the full 5-job set the C-01 spec's "what" names ("runs the real
// jobs: runIntakeAdvanceSweep, runStaleTaskSweep, runBoardHygiene,
// runQCOnReview, stuck-in-progress sweep"), without entangling them with the
// S1/S3/S4 aging windows above (the stale-sweep's own review-hold-exclusion
// regression is C-07's named assertion, not C-01's — C+I.0 point 8 already
// confirms that exclusion is BUILT and VERIFIED at this commit).
// ============================================================================
test('coverage: runStaleTaskSweep + runStuckInProgressSweep run cleanly and leave a fresh card alone', async () => {
  const wsId = seedWorkspace(`coverage-dept-${uuidv4().slice(0, 8)}`);
  const agentId = uuidv4();
  run('INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)', [
    agentId, 'Fresh Control Agent', 'Department Head', wsId, 'working',
  ]);
  const freshInProgress = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, business_id, assigned_agent_id, updated_at, last_progress_at)
     VALUES (?, ?, 'in_progress', ?, 'default', ?, ?, ?)`,
    [freshInProgress, 'Coverage fixture: fresh in_progress control', wsId, agentId, minutesAgo(5), minutesAgo(5)],
  );

  const staleResult = await runStaleTaskSweep();
  const stuckResult = await runStuckInProgressSweep();

  assert.equal(
    taskStatus(freshInProgress),
    'in_progress',
    'coverage: a fresh (5-min-old) in_progress control card is left alone by both sweeps',
  );
  assert.ok(typeof staleResult.scanned === 'number', 'coverage: runStaleTaskSweep completes and returns a result');
  assert.ok(typeof stuckResult.scanned === 'number', 'coverage: runStuckInProgressSweep completes and returns a result');
});

// ============================================================================
test('fixture-guard: this suite ran end-to-end against ONLY the throwaway DATABASE_PATH (end)', () => {
  assertIsolatedFixtureDatabase('end');
});
