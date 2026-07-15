/**
 * U58 (Skill 6 Blended-Persona Kanban v2, Stage 2 / exec-summary item 9) —
 * Individual-agent performance surface.
 *
 * Covers @/lib/agents/performance's on-read `tasks x task_qc_results` JOIN:
 *   1. QC-join math (avg score / pass rate / completed count, latest-attempt-
 *      wins on a re-scored task, tasks without a QC row excluded from the
 *      score/pass-rate but still counted in completedCount)
 *   2. Devil's-Advocate-trio exclusion (isTrioAgent + listPerformanceEligibleAgents)
 *   3. Empty-agent zero-state (agent exists, zero completed tasks → honest
 *      nulls/zeros, never a fabricated number)
 *   4. Idempotent weekly trend series (same DB state → byte-identical result
 *      across repeat calls; multi-week bucketing is real, not a single bucket)
 *
 * Isolation: `_isolated-db` (imported FIRST) points DATABASE_PATH at a unique
 * temp file per process, mirroring tests/unit/u57-dept-metric-unification.test.ts.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '../../src/lib/db';
import {
  getAgentPerformance,
  isTrioAgent,
  listPerformanceEligibleAgents,
} from '../../src/lib/agents/performance';

// A dedicated fixture workspace (agents.workspace_id / tasks.workspace_id are
// FK-constrained; this isolated DB's 'default' workspace is not guaranteed to
// exist — the branding-seed reseed aborts fail-closed on an unbranded
// company-config.json, mirroring tests/unit/u57-dept-metric-unification.test.ts's
// seedWorkspace() pattern).
const WORKSPACE_ID = `ws-u58-${uuidv4()}`;
run(
  `INSERT INTO workspaces (id, name, slug, description, icon) VALUES (?, ?, ?, ?, ?)`,
  [WORKSPACE_ID, 'U58 Fixture Dept', `u58-fixture-${uuidv4().slice(0, 8)}`, 'U58 test fixture', '🧪'],
);

function seedAgent(opts: { id: string; name: string; role: string; roleType?: string | null }): void {
  run(
    `INSERT INTO agents (id, name, role, role_type, avatar_emoji, status, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [opts.id, opts.name, opts.role, opts.roleType ?? null, '🤖', 'standby', WORKSPACE_ID],
  );
}

function seedCompletedTask(opts: { id: string; agentId: string; completedAt: string }): void {
  run(
    `INSERT INTO tasks (id, title, status, assigned_agent_id, workspace_id, created_at, updated_at, completed_at)
     VALUES (?, ?, 'done', ?, ?, ?, ?, ?)`,
    [opts.id, `Task ${opts.id}`, opts.agentId, WORKSPACE_ID, opts.completedAt, opts.completedAt, opts.completedAt],
  );
}

function seedQcResult(opts: {
  taskId: string;
  score: number;
  passed: boolean;
  scoredAt: string;
  attempt?: number;
}): void {
  run(
    `INSERT INTO task_qc_results (id, task_id, score, passed, scoring_path, attempt, scored_at)
     VALUES (?, ?, ?, ?, 'llm', ?, ?)`,
    [uuidv4(), opts.taskId, opts.score, opts.passed ? 1 : 0, opts.attempt ?? 1, opts.scoredAt],
  );
}

// ---------------------------------------------------------------------------
// 1. QC-join math
// ---------------------------------------------------------------------------

test('[U58] getAgentPerformance: QC-join math — avg score, pass rate, completed count', () => {
  const agentId = `agent-qcmath-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Nova', role: 'specialist' });

  // Same calendar day (guarantees a single weekly bucket, isolating the
  // score/pass-rate math from bucketing).
  const day = '2026-07-15T08:00:00.000Z';

  const t1 = `task-${uuidv4()}`;
  const t2 = `task-${uuidv4()}`;
  const t3 = `task-${uuidv4()}`;
  const t4 = `task-${uuidv4()}`; // completed, but never QC'd

  seedCompletedTask({ id: t1, agentId, completedAt: day });
  seedCompletedTask({ id: t2, agentId, completedAt: day });
  seedCompletedTask({ id: t3, agentId, completedAt: day });
  seedCompletedTask({ id: t4, agentId, completedAt: day });

  seedQcResult({ taskId: t1, score: 90, passed: true, scoredAt: day });
  seedQcResult({ taskId: t2, score: 80, passed: true, scoredAt: day });
  seedQcResult({ taskId: t3, score: 60, passed: false, scoredAt: day });
  // t4 intentionally has no task_qc_results row.

  const perf = getAgentPerformance(agentId);
  assert.ok(perf, 'agent must resolve');
  assert.equal(perf!.agentName, 'Nova');
  assert.equal(perf!.completedCount, 4, 'all 4 completed tasks count, QC or not');
  assert.equal(perf!.qcSampleSize, 3, 'only the 3 QC-graded tasks feed the score/pass-rate');
  assert.equal(perf!.avgQcScore, 76.67, '(90+80+60)/3 rounded to 2dp');
  assert.equal(perf!.passRate, 66.67, '2 of 3 QC-graded tasks passed, rounded to 2dp');
  assert.equal(perf!.trend.length, 1, 'all 4 tasks land in one ISO week');
  assert.equal(perf!.trend[0].completedCount, 4);
  assert.equal(perf!.throughputPerWeek, 4, 'completedCount / 1 bucket');
});

test('[U58] getAgentPerformance: a re-scored task counts only its LATEST LLM verdict', () => {
  const agentId = `agent-rescored-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Rescore Test Agent', role: 'specialist' });

  const day = '2026-07-15T08:00:00.000Z';
  const taskId = `task-${uuidv4()}`;
  seedCompletedTask({ id: taskId, agentId, completedAt: day });

  // First attempt failed at 55; re-scored attempt passed at 92. Ordered by
  // scored_at so the later timestamp is the "latest" verdict.
  seedQcResult({ taskId, score: 55, passed: false, scoredAt: '2026-07-14T08:00:00.000Z', attempt: 1 });
  seedQcResult({ taskId, score: 92, passed: true, scoredAt: '2026-07-15T08:00:00.000Z', attempt: 2 });

  const perf = getAgentPerformance(agentId);
  assert.ok(perf);
  assert.equal(perf!.qcSampleSize, 1, 'one task, one counted verdict — not two');
  assert.equal(perf!.avgQcScore, 92, 'the LATEST score wins, not the first attempt');
  assert.equal(perf!.passRate, 100, 'the LATEST passed=true wins');
});

// ---------------------------------------------------------------------------
// 2. Devil's-Advocate-trio exclusion
// ---------------------------------------------------------------------------

test('[U58] isTrioAgent: true for every trio role_type spelling, false for real performers', () => {
  assert.equal(isTrioAgent('qc'), true);
  assert.equal(isTrioAgent('research'), true);
  assert.equal(isTrioAgent('deep-research'), true, 'Skill-23 alias for research');
  assert.equal(isTrioAgent('devils-advocate'), true);
  assert.equal(isTrioAgent('specialist'), false);
  assert.equal(isTrioAgent('leadership'), false);
  assert.equal(isTrioAgent(null), false);
  assert.equal(isTrioAgent(undefined), false);
});

test('[U58] listPerformanceEligibleAgents: excludes the trio, includes real agents', () => {
  const suffix = uuidv4();
  const realAgentId = `agent-real-${suffix}`;
  const qcAgentId = `agent-qc-${suffix}`;
  const researchAgentId = `agent-research-${suffix}`;
  const daAgentId = `agent-da-${suffix}`;

  seedAgent({ id: realAgentId, name: `Real Performer ${suffix}`, role: 'specialist', roleType: 'specialist' });
  seedAgent({ id: qcAgentId, name: `QC Agent ${suffix}`, role: 'QC', roleType: 'qc' });
  seedAgent({ id: researchAgentId, name: `Research Agent ${suffix}`, role: 'Research', roleType: 'deep-research' });
  seedAgent({ id: daAgentId, name: `DA Agent ${suffix}`, role: "Devil's Advocate", roleType: 'devils-advocate' });

  const list = listPerformanceEligibleAgents();
  const ids = list.map((a) => a.id);

  assert.ok(ids.includes(realAgentId), 'the real performer must be listed');
  assert.equal(ids.includes(qcAgentId), false, 'qc trio agent must be excluded');
  assert.equal(ids.includes(researchAgentId), false, 'research trio agent (alias spelling) must be excluded');
  assert.equal(ids.includes(daAgentId), false, "Devil's Advocate trio agent must be excluded");
});

// ---------------------------------------------------------------------------
// 3. Empty-agent zero-state
// ---------------------------------------------------------------------------

test('[U58] getAgentPerformance: an agent with zero completed tasks returns an honest zero-state', () => {
  const agentId = `agent-empty-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Fresh Agent', role: 'specialist' });

  const perf = getAgentPerformance(agentId);
  assert.ok(perf);
  assert.equal(perf!.completedCount, 0);
  assert.equal(perf!.avgQcScore, null, 'never a fabricated 0 — null means no data');
  assert.equal(perf!.qcSampleSize, 0);
  assert.equal(perf!.passRate, null);
  assert.equal(perf!.throughputPerWeek, 0);
  assert.deepEqual(perf!.trend, []);
});

test('[U58] getAgentPerformance: a nonexistent agent id resolves to null', () => {
  const perf = getAgentPerformance(`agent-does-not-exist-${uuidv4()}`);
  assert.equal(perf, null);
});

// ---------------------------------------------------------------------------
// 4. Idempotent weekly trend series
// ---------------------------------------------------------------------------

test('[U58] getAgentPerformance: calling twice on unchanged data yields a byte-identical result', () => {
  const agentId = `agent-idempotent-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Idempotent Agent', role: 'specialist' });

  const t1 = `task-${uuidv4()}`;
  seedCompletedTask({ id: t1, agentId, completedAt: '2026-07-15T08:00:00.000Z' });
  seedQcResult({ taskId: t1, score: 88, passed: true, scoredAt: '2026-07-15T08:00:00.000Z' });

  const first = getAgentPerformance(agentId);
  const second = getAgentPerformance(agentId);
  assert.deepEqual(first, second, 'pure read — same DB state must produce the same result every call');
});

test('[U58] getAgentPerformance: tasks completed in different ISO weeks land in distinct ascending buckets', () => {
  const agentId = `agent-multiweek-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Multi Week Agent', role: 'specialist' });

  // Three completions 21 days apart guarantee three distinct ISO weeks
  // regardless of which day of the week the base date falls on.
  const week1 = `task-${uuidv4()}`;
  const week2 = `task-${uuidv4()}`;
  const week3 = `task-${uuidv4()}`;
  seedCompletedTask({ id: week1, agentId, completedAt: '2026-06-01T08:00:00.000Z' });
  seedCompletedTask({ id: week2, agentId, completedAt: '2026-06-22T08:00:00.000Z' });
  seedCompletedTask({ id: week3, agentId, completedAt: '2026-07-13T08:00:00.000Z' });

  const perf = getAgentPerformance(agentId);
  assert.ok(perf);
  assert.equal(perf!.completedCount, 3);
  assert.equal(perf!.trend.length, 3, 'three tasks 21 days apart must land in three distinct weekly buckets');
  // Ascending order.
  const starts = perf!.trend.map((p) => p.weekStart);
  const sorted = [...starts].sort();
  assert.deepEqual(starts, sorted, 'trend must be ascending by weekStart');
  perf!.trend.forEach((p) => assert.equal(p.completedCount, 1));
  assert.equal(perf!.throughputPerWeek, 1, '3 completed / 3 buckets');
});
