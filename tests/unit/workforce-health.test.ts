/**
 * workforce-health.test.ts — MR-08 fable-correction regression lock.
 *
 * Proves the /operator/health data layer (src/lib/operator/workforce-health.ts)
 * reports REAL numbers, not silent zeros:
 *
 *   1. Stuck-task age filters use parenthesised hour math —
 *      `(julianday('now') - julianday(updated_at)) * 24 > N`. The unparenthesised
 *      form `julianday('now') - julianday(updated_at) * 24` binds the *24 to
 *      julianday(updated_at) first (SQL precedence), producing a large negative
 *      number that is never > N, so dispatchStuck / reviewStuck / inProgressStale
 *      would report 0 forever — the exact bug this test locks out.
 *
 *   2. The dispatch sparkline counts the REAL failure event type written by
 *      task-dispatcher.ts ('task_dispatch_deferred'). The nonexistent
 *      'dispatch_failed' type would leave the failure series permanently 0.
 *
 * Runs on a throwaway, fully-migrated SQLite DB via _isolated-db.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'crypto';
import { getDb } from '../../src/lib/db';
import { getWorkforceHealth } from '../../src/lib/operator/workforce-health';

beforeAll(() => {
  const db = getDb();

  // agents.workspace_id defaults to 'default' and REFERENCES workspaces(id);
  // a fresh migrated DB is not guaranteed to have that row.
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, sort_order)
     VALUES ('default', 'Default', 'default', 0)`,
  ).run();

  db.prepare(
    `INSERT INTO agents (id, name, role, status, avatar_emoji)
     VALUES ('agt-1', 'Test Agent', 'engineer', 'working', '🤖')`,
  ).run();

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, title, status, assigned_agent_id, block_audience, updated_at)
     VALUES (?, ?, ?, 'agt-1', ?, datetime('now', ?))`,
  );

  // blocked 5h, OWNER audience → blocked + blockedByOwner; past the 4h
  // owner-re-ping SLA but not the 24h escalate SLA.
  insertTask.run('t-blocked', 'Blocked task', 'blocked', 'OWNER', '-5 hours');
  // pending_dispatch 3h → dispatchStuck (threshold 2h).
  insertTask.run('t-dispatch-stuck', 'Stuck in dispatch', 'pending_dispatch', null, '-3 hours');
  // pending_dispatch 1h → fresh, must NOT count.
  insertTask.run('t-dispatch-fresh', 'Fresh dispatch', 'pending_dispatch', null, '-1 hour');
  // review 25h with no llm QC result → reviewStuck (threshold 24h).
  insertTask.run('t-review-stuck', 'Stuck in review', 'review', null, '-25 hours');
  // review 30h but already scored → must NOT count.
  insertTask.run('t-review-scored', 'Scored review', 'review', null, '-30 hours');
  // in_progress 49h → inProgressStale (threshold 48h).
  insertTask.run('t-stale', 'Stale in-progress', 'in_progress', null, '-49 hours');
  // in_progress 1h → fresh, must NOT count.
  insertTask.run('t-fresh', 'Fresh in-progress', 'in_progress', null, '-1 hour');

  db.prepare(
    `INSERT INTO task_qc_results (id, task_id, score, passed, scoring_path)
     VALUES (?, 't-review-scored', 9.0, 1, 'llm')`,
  ).run(randomUUID());

  const insertEvent = db.prepare(
    `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
  );
  // Same hour bucket: one success + one failure.
  insertEvent.run(randomUUID(), 'task_dispatched', 'agt-1', 't-dispatch-fresh', 'ok', '-1 hour');
  insertEvent.run(randomUUID(), 'task_dispatch_deferred', 'agt-1', 't-dispatch-stuck', 'boom', '-1 hour');
  // Triad gate holds carry task_id only (agent_id NULL).
  insertEvent.run(randomUUID(), 'triad_gate_hold', null, 't-dispatch-stuck', 'held', '-2 hours');
});

describe('getWorkforceHealth (MR-08)', () => {
  it('counts stuck tasks with real age thresholds (parenthesised hour math)', () => {
    const { stuckTasks } = getWorkforceHealth();
    expect(stuckTasks.blocked).toBe(1);
    expect(stuckTasks.blockedByOwner).toBe(1);
    expect(stuckTasks.blockedSystem).toBe(0);
    // These three are the precedence-bug regression guards: the unparenthesised
    // SQL always yields 0 for all of them.
    expect(stuckTasks.dispatchStuck).toBe(1);
    expect(stuckTasks.reviewStuck).toBe(1);
    expect(stuckTasks.inProgressStale).toBe(1);
  });

  it('reports agent connectivity with live task counts', () => {
    const { agents } = getWorkforceHealth();
    // Migrations seed their own agent roster; locate ours by id.
    const a = agents.find((row) => row.agentId === 'agt-1');
    expect(a).toBeDefined();
    expect(a!.status).toBe('working');
    // pending_dispatch x2 + review x2 + in_progress x2 (blocked excluded).
    expect(a!.currentTaskCount).toBe(6);
    expect(a!.completedCount).toBe(0);
  });

  it('counts dispatch failures via the real task_dispatch_deferred event type', () => {
    const { dispatchSparkline } = getWorkforceHealth();
    const totals = dispatchSparkline.reduce(
      (acc, p) => ({
        dispatched: acc.dispatched + p.dispatched,
        failed: acc.failed + p.failed,
        held: acc.held + p.held,
      }),
      { dispatched: 0, failed: 0, held: 0 },
    );
    expect(totals.dispatched).toBe(1);
    expect(totals.failed).toBe(1); // would be 0 with the phantom 'dispatch_failed' type
    expect(totals.held).toBe(1);
  });

  it('flags SLA violations against default thresholds', () => {
    const { slaViolations } = getWorkforceHealth();
    expect(slaViolations.blockedPastOwnerReping).toBe(1); // 5h > 4h default
    expect(slaViolations.blockedPastEscalate).toBe(0); // 5h < 24h default
    expect(slaViolations.reviewPastUnscored).toBe(0); // 25h < 48h default
    expect(slaViolations.backlogPastNudge).toBe(0);
  });
});
