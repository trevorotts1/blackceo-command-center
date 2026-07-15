/**
 * U58 (Skill 6 Blended-Persona Kanban v2, Stage 2 / exec-summary item 9) —
 * route + lib-level shape proof for the index/detail data the
 * /agents and /agents/[agentId] pages render.
 *
 *   • GET /api/agents/[id]/performance?window= (src/app/api/agents/[id]/
 *     performance/route.ts, backed by @/lib/agents/performance's
 *     getAgentGrade) — the windowed, gated, DepartmentGrade-shaped
 *     ({inputs, score, grade, sufficientData}) JSON AgentPerformanceDetailPage
 *     consumes: letter grade, the `?window=` parameter, windowed completion,
 *     blocked count + the list of blocking tasks, and velocity as a distinct
 *     metric — plus the honesty gate proof (QC fix-loop, U58 re-QC): below
 *     each gated input's minimum sample, the endpoint returns `score: null`
 *     + a labeled `detail` reason, NEVER a fabricated number (never a bare
 *     100% from n=1, never a bare '—' with no reason at n=0). The API
 *     segment is named [id], not [agentId], to match the pre-existing
 *     sibling routes under src/app/api/agents/[id]/ — Next.js forbids mixed
 *     dynamic-segment names at the same path position (getSortedRoutes
 *     hard-fails `next build` for the whole app otherwise). The page route
 *     src/app/agents/[agentId]/ is a separate, unrelated route tree.
 *   • listPerformanceEligibleAgents() (@/lib/agents/performance) — the exact
 *     shape AgentsIndexPage consumes (id/name/role/avatarEmoji/status),
 *     proving the trio-excluded list is what actually reaches the index page.
 *
 * Isolation: `_isolated-db` (imported FIRST) points DATABASE_PATH at a unique
 * temp file per process, mirroring tests/unit/u57-dept-metric-unification.test.ts
 * and tests/unit/task-status-transition.test.ts's `params: Promise.resolve(...)`
 * route-invocation convention.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { run } from '../../src/lib/db';
import { GET as performanceGET } from '../../src/app/api/agents/[id]/performance/route';
import { getAgentGrade, listPerformanceEligibleAgents } from '../../src/lib/agents/performance';

// A dedicated fixture workspace — see the matching comment in
// agent-performance-endpoint.test.ts (agents/tasks.workspace_id are
// FK-constrained; this isolated DB's 'default' workspace is not seeded).
const WORKSPACE_ID = `ws-u58-shape-${uuidv4()}`;
run(
  `INSERT INTO workspaces (id, name, slug, description, icon) VALUES (?, ?, ?, ?, ?)`,
  [WORKSPACE_ID, 'U58 Shape Fixture Dept', `u58-shape-fixture-${uuidv4().slice(0, 8)}`, 'U58 test fixture', '🧪'],
);

function seedAgent(opts: { id: string; name: string; role: string; roleType?: string | null }): void {
  run(
    `INSERT INTO agents (id, name, role, role_type, avatar_emoji, status, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [opts.id, opts.name, opts.role, opts.roleType ?? null, '🧭', 'working', WORKSPACE_ID],
  );
}

/** now-relative ISO timestamp `daysAgo` days in the past — keeps fixtures inside/outside
 *  a `windowDays` filter deterministically instead of hardcoding a calendar date. */
function daysAgoIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function seedTask(opts: {
  id: string;
  agentId: string;
  status: 'done' | 'in_progress' | 'blocked';
  createdDaysAgo: number;
  completedDaysAgo?: number;
  blockReason?: string;
}): void {
  const createdAt = daysAgoIso(opts.createdDaysAgo);
  const completedAt = opts.status === 'done' ? daysAgoIso(opts.completedDaysAgo ?? opts.createdDaysAgo) : null;
  run(
    `INSERT INTO tasks (id, title, status, assigned_agent_id, workspace_id, created_at, updated_at, completed_at, block_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [opts.id, `Task ${opts.id}`, opts.status, opts.agentId, WORKSPACE_ID, createdAt, completedAt ?? createdAt, completedAt, opts.blockReason ?? null],
  );
}

function seedQcResult(opts: { taskId: string; score: number; passed: boolean; scoredDaysAgo: number }): void {
  run(
    `INSERT INTO task_qc_results (id, task_id, score, passed, scoring_path, attempt, scored_at)
     VALUES (?, ?, ?, ?, 'llm', 1, ?)`,
    [uuidv4(), opts.taskId, opts.score, opts.passed ? 1 : 0, daysAgoIso(opts.scoredDaysAgo)],
  );
}

function callPerformanceRoute(agentId: string, windowDays?: number): Promise<Response> {
  const url = windowDays
    ? `http://localhost/api/agents/${agentId}/performance?window=${windowDays}`
    : `http://localhost/api/agents/${agentId}/performance`;
  return performanceGET(new NextRequest(url), {
    params: Promise.resolve({ id: agentId }),
  }) as unknown as Promise<Response>;
}

// ---------------------------------------------------------------------------
// Sufficient-data fixture: grade + window + every BINARY-acceptance-(2) field,
// asserted against hand-computed fixture truth.
// ---------------------------------------------------------------------------

test('[U58] GET /api/agents/[id]/performance: sufficient-data fixture renders grade, window, throughput, windowed completion, gated QC pass rate, blocked count + list, and velocity', async () => {
  const agentId = `agent-sufficient-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Sufficient Data Agent', role: 'specialist' });

  // 5 tasks created inside the default 30-day window: 4 done, 1 blocked.
  // Hand-computed truth: created=5, completed=4 -> throughput denom = max(5,4) = 5,
  // score = round(4/5*100) = 80%. windowedCompletionRate = round(4/5*100) = 80%.
  const done = [uuidv4(), uuidv4(), uuidv4(), uuidv4()].map((id) => `task-${id}`);
  const blockedId = `task-${uuidv4()}`;

  done.forEach((id, i) => seedTask({ id, agentId, status: 'done', createdDaysAgo: 10, completedDaysAgo: 10 - i }));
  seedTask({ id: blockedId, agentId, status: 'blocked', createdDaysAgo: 5, blockReason: 'Waiting on client asset' });

  // 4 LLM-graded QC results, all inside the window: 90, 80, 70(fail), 100 -> 3/4 passed = 75%.
  seedQcResult({ taskId: done[0], score: 90, passed: true, scoredDaysAgo: 10 });
  seedQcResult({ taskId: done[1], score: 80, passed: true, scoredDaysAgo: 9 });
  seedQcResult({ taskId: done[2], score: 70, passed: false, scoredDaysAgo: 8 });
  seedQcResult({ taskId: done[3], score: 100, passed: true, scoredDaysAgo: 7 });

  const res = await callPerformanceRoute(agentId);
  assert.equal(res.status, 200);
  const body = await res.json();

  // {inputs, score, grade, sufficientData} — mirrors DepartmentGrade's shape exactly.
  assert.ok('inputs' in body);
  assert.ok('score' in body);
  assert.ok('grade' in body);
  assert.ok('sufficientData' in body);

  // window parameter — default 30, echoed back.
  assert.equal(body.windowDays, 30);

  // throughput input — hand-computed: 4 completed of 5 created = 80%.
  assert.equal(body.inputs.throughput.score, 80);
  assert.equal(body.inputs.throughput.sampleSize, 5);

  // windowed completion — distinct field from the throughput input, same
  // hand-computed truth here (completed/created, no denom clamp needed since
  // completed <= created is structurally guaranteed by the window query).
  assert.equal(body.windowedCompletionRate, 80);

  // QC pass rate input — computed through the J.0.4 join, hand-computed:
  // 3 of 4 LLM-graded results passed = 75%.
  assert.equal(body.inputs.qcPassRate.score, 75);
  assert.equal(body.inputs.qcPassRate.sampleSize, 4);

  // letter grade — sufficientData true (throughput + qcPassRate both present,
  // >= MIN_GRADED_INPUTS) and a real letter, never null.
  assert.equal(body.sufficientData, true);
  assert.ok(['A', 'B', 'C', 'D', 'F'].includes(body.grade), `grade must be a real letter, got ${body.grade}`);
  assert.equal(typeof body.score, 'number');

  // blocked count + the actual blocking tasks listed — length always equals the count.
  assert.equal(body.blockedCount, 1);
  assert.equal(body.blockedTasks.length, 1);
  assert.equal(body.blockedTasks[0].id, blockedId);
  assert.equal(body.blockedTasks[0].reason, 'Waiting on client asset');

  // velocity — a distinct metric from throughput (completed-per-week rate, not a %).
  assert.equal(typeof body.velocity, 'number');
  assert.ok(body.velocity !== null);

  // trend series still present (all-time weekly buckets, unchanged behavior).
  assert.ok(Array.isArray(body.trend));
  assert.ok(body.trend.length > 0);
});

// ---------------------------------------------------------------------------
// Below-gate fixture (BINARY acceptance 3): every gated metric renders
// "Insufficient data" (score: null) + a labeled reason — NEVER a number.
// ---------------------------------------------------------------------------

test('[U58] GET /api/agents/[id]/performance: a single QC\'d task (n=1) never renders a hard pass-rate — gated null + labeled reason', async () => {
  const agentId = `agent-n1-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Single Sample Agent', role: 'specialist' });

  const taskId = `task-${uuidv4()}`;
  seedTask({ id: taskId, agentId, status: 'done', createdDaysAgo: 5 });
  seedQcResult({ taskId, score: 95, passed: true, scoredDaysAgo: 5 });

  const res = await callPerformanceRoute(agentId);
  assert.equal(res.status, 200);
  const body = await res.json();

  // n=1 QC result is below MIN_QC_RESULTS (3) -> score MUST be null, never 100.
  assert.equal(body.inputs.qcPassRate.score, null, 'a single QC result must never render a hard pass-rate');
  assert.equal(body.inputs.qcPassRate.sampleSize, 1);
  assert.equal(typeof body.inputs.qcPassRate.detail, 'string');
  assert.ok(body.inputs.qcPassRate.detail.length > 0, 'the null state must carry a labeled reason');

  // n=1 created task is below MIN_TASKS_FOR_THROUGHPUT (3) -> also gated null.
  assert.equal(body.inputs.throughput.score, null);
  assert.ok(body.inputs.throughput.detail.length > 0, 'the null state must carry a labeled reason');

  // Fewer than MIN_GRADED_INPUTS (2) inputs have data (sopCoverage/kpiAttainment
  // are also insufficient here) -> overall score/grade are null, not a fabricated letter.
  assert.equal(body.sufficientData, false);
  assert.equal(body.score, null);
  assert.equal(body.grade, null);
});

test('[U58] GET /api/agents/[id]/performance: n=0 (agent exists, never completed anything) — every gated metric null with a labeled reason, never a bare dash', async () => {
  const agentId = `agent-n0-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Zero Sample Agent', role: 'specialist' });

  const res = await callPerformanceRoute(agentId);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.inputs.qcPassRate.score, null);
  assert.equal(body.inputs.qcPassRate.sampleSize, 0);
  assert.match(body.inputs.qcPassRate.detail, /\d\+/, 'the reason must name the required sample size');

  assert.equal(body.inputs.throughput.score, null);
  assert.equal(body.inputs.throughput.sampleSize, 0);
  assert.match(body.inputs.throughput.detail, /\d\+/);

  assert.equal(body.windowedCompletionRate, null, 'zero tasks created in the window -> null, never a fabricated 0%');
  assert.equal(body.blockedCount, 0);
  assert.deepEqual(body.blockedTasks, []);
  assert.equal(body.velocity, null, 'an agent with zero tasks ever gets null velocity, never a fabricated 0');
  assert.equal(body.completedCount, 0);
  assert.deepEqual(body.trend, []);

  assert.equal(body.sufficientData, false);
  assert.equal(body.score, null);
  assert.equal(body.grade, null);
});

// ---------------------------------------------------------------------------
// The `?window=` query parameter actually filters (BINARY acceptance 1's
// "spec mandates GET /api/agents/[id]/performance?window=30 windowed
// metrics" — proven by a QC result that falls outside a narrow window but
// inside a wide one).
// ---------------------------------------------------------------------------

test('[U58] GET /api/agents/[id]/performance?window=: a QC result outside the window is excluded; the same result is included once the window widens', async () => {
  const agentId = `agent-windowed-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Windowed Agent', role: 'specialist' });

  // 3 tasks/QC results 40 days ago -> outside a 30-day window, inside a 90-day one.
  const taskIds = [uuidv4(), uuidv4(), uuidv4()].map((id) => `task-${id}`);
  taskIds.forEach((id) => seedTask({ id, agentId, status: 'done', createdDaysAgo: 40 }));
  taskIds.forEach((id, i) => seedQcResult({ taskId: id, score: 85 + i, passed: true, scoredDaysAgo: 40 }));

  const narrow = await callPerformanceRoute(agentId, 30);
  const narrowBody = await narrow.json();
  assert.equal(narrowBody.windowDays, 30);
  assert.equal(narrowBody.inputs.qcPassRate.score, null, 'a 40-day-old result must not count inside a 30-day window');
  assert.equal(narrowBody.inputs.qcPassRate.sampleSize, 0);

  const wide = await callPerformanceRoute(agentId, 90);
  const wideBody = await wide.json();
  assert.equal(wideBody.windowDays, 90);
  assert.equal(wideBody.inputs.qcPassRate.score, 100, 'all 3 results pass -> 100% once they are inside the window');
  assert.equal(wideBody.inputs.qcPassRate.sampleSize, 3);
});

test('[U58] GET /api/agents/[id]/performance: an invalid ?window= falls back to the 30-day default instead of crashing', async () => {
  const agentId = `agent-badwindow-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Bad Window Agent', role: 'specialist' });

  const res = await performanceGET(
    new NextRequest(`http://localhost/api/agents/${agentId}/performance?window=not-a-number`),
    { params: Promise.resolve({ id: agentId }) },
  ) as unknown as Response;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.windowDays, 30);
});

// ---------------------------------------------------------------------------
// 404 + lib-level parity
// ---------------------------------------------------------------------------

test('[U58] GET /api/agents/[id]/performance: unknown agent id → 404 with an error field, never a crash', async () => {
  const res = await callPerformanceRoute(`agent-unknown-${uuidv4()}`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});

test('[U58] getAgentGrade: a nonexistent agent id resolves to null (same convention as getAgentPerformance)', () => {
  assert.equal(getAgentGrade(`agent-does-not-exist-${uuidv4()}`), null);
});

// ---------------------------------------------------------------------------
// Index list data shape (trio excluded, matches AgentsIndexPage's render)
// ---------------------------------------------------------------------------

test('[U58] listPerformanceEligibleAgents: index-page shape (id/name/role/avatarEmoji/status), trio absent', () => {
  const suffix = uuidv4();
  const realId = `agent-index-real-${suffix}`;
  const daId = `agent-index-da-${suffix}`;

  seedAgent({ id: realId, name: `Index Shape Agent ${suffix}`, role: 'specialist', roleType: 'specialist' });
  seedAgent({ id: daId, name: `Index DA ${suffix}`, role: "Devil's Advocate", roleType: 'devils-advocate' });

  const list = listPerformanceEligibleAgents();
  const entry = list.find((a) => a.id === realId);
  assert.ok(entry, 'the real agent must be present in the index list');
  assert.equal(typeof entry!.id, 'string');
  assert.equal(typeof entry!.name, 'string');
  assert.equal(typeof entry!.role, 'string');
  assert.equal(typeof entry!.avatarEmoji, 'string');
  assert.equal(typeof entry!.status, 'string');
  assert.equal(entry!.name, `Index Shape Agent ${suffix}`);
  assert.equal(entry!.avatarEmoji, '🧭');

  assert.equal(
    list.some((a) => a.id === daId),
    false,
    'the trio agent must never reach the index-page data shape',
  );
});
