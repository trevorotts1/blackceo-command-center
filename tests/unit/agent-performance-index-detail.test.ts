/**
 * U58 (Skill 6 Blended-Persona Kanban v2, Stage 2 / exec-summary item 9) —
 * route + lib-level shape proof for the index/detail data the
 * /agents and /agents/[agentId] pages render.
 *
 *   • GET /api/agents/[agentId]/performance (src/app/api/agents/[agentId]/
 *     performance/route.ts) — the exact JSON shape AgentPerformanceDetailPage
 *     consumes, for both a real agent and a 404 on an unknown id.
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
import { GET as performanceGET } from '../../src/app/api/agents/[agentId]/performance/route';
import { listPerformanceEligibleAgents } from '../../src/lib/agents/performance';

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

function seedCompletedTask(opts: { id: string; agentId: string; completedAt: string }): void {
  run(
    `INSERT INTO tasks (id, title, status, assigned_agent_id, workspace_id, created_at, updated_at, completed_at)
     VALUES (?, ?, 'done', ?, ?, ?, ?, ?)`,
    [opts.id, `Task ${opts.id}`, opts.agentId, WORKSPACE_ID, opts.completedAt, opts.completedAt, opts.completedAt],
  );
}

function seedQcResult(opts: { taskId: string; score: number; passed: boolean; scoredAt: string }): void {
  run(
    `INSERT INTO task_qc_results (id, task_id, score, passed, scoring_path, attempt, scored_at)
     VALUES (?, ?, ?, ?, 'llm', 1, ?)`,
    [uuidv4(), opts.taskId, opts.score, opts.passed ? 1 : 0, opts.scoredAt],
  );
}

function callPerformanceRoute(agentId: string): Promise<Response> {
  return performanceGET(new NextRequest(`http://localhost/api/agents/${agentId}/performance`), {
    params: Promise.resolve({ agentId }),
  }) as unknown as Promise<Response>;
}

// ---------------------------------------------------------------------------
// Detail route data shape
// ---------------------------------------------------------------------------

test('[U58] GET /api/agents/[agentId]/performance: 200 with the exact detail-page shape for a real agent', async () => {
  const agentId = `agent-shape-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Shape Test Agent', role: 'specialist' });

  const taskId = `task-${uuidv4()}`;
  const when = '2026-07-15T08:00:00.000Z';
  seedCompletedTask({ id: taskId, agentId, completedAt: when });
  seedQcResult({ taskId, score: 95, passed: true, scoredAt: when });

  const res = await callPerformanceRoute(agentId);
  assert.equal(res.status, 200);
  const body = await res.json();

  // Field presence + type — exactly what AgentPerformanceDetailPage reads.
  assert.equal(typeof body.agentId, 'string');
  assert.equal(body.agentId, agentId);
  assert.equal(typeof body.agentName, 'string');
  assert.equal(body.agentName, 'Shape Test Agent');
  assert.equal(typeof body.agentRole, 'string');
  assert.equal(typeof body.completedCount, 'number');
  assert.equal(body.completedCount, 1);
  assert.equal(typeof body.avgQcScore, 'number');
  assert.equal(body.avgQcScore, 95);
  assert.equal(typeof body.qcSampleSize, 'number');
  assert.equal(typeof body.passRate, 'number');
  assert.equal(body.passRate, 100);
  assert.equal(typeof body.throughputPerWeek, 'number');
  assert.ok(Array.isArray(body.trend));
  assert.equal(body.trend.length, 1);
  const point = body.trend[0];
  assert.equal(typeof point.weekStart, 'string');
  assert.match(point.weekStart, /^\d{4}-\d{2}-\d{2}$/, 'weekStart must be a plain ISO date');
  assert.equal(typeof point.completedCount, 'number');
  assert.equal(point.completedCount, 1);
  assert.equal(point.avgQcScore, 95);
});

test('[U58] GET /api/agents/[agentId]/performance: an agent that exists but never completed anything renders honest nulls, not 404', async () => {
  const agentId = `agent-shape-empty-${uuidv4()}`;
  seedAgent({ id: agentId, name: 'Never Completed Anything', role: 'specialist' });

  const res = await callPerformanceRoute(agentId);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.completedCount, 0);
  assert.equal(body.avgQcScore, null);
  assert.equal(body.passRate, null);
  assert.equal(body.throughputPerWeek, 0);
  assert.deepEqual(body.trend, []);
});

test('[U58] GET /api/agents/[agentId]/performance: unknown agent id → 404 with an error field, never a crash', async () => {
  const res = await callPerformanceRoute(`agent-unknown-${uuidv4()}`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
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
