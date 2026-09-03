/**
 * fix-dispatch-counter-intake-advance.test.ts — FIX-DISPATCH-COUNTER.
 *
 * The defect: intake-advance-sweep.ts incremented its `dispatched` counter on
 * every `await autoDispatchTask(...)` call, regardless of whether anything
 * durable actually happened. autoDispatchTask returns void and has 20+ silent
 * early-return guards (already-terminal, QC cap, owner-killed, backoff
 * window, SOP-authoring HOLD, model-sovereignty block, gateway-down, ...) that
 * resolve successfully without dispatching anything — so the `[cron]
 * intake-advance: scanned N, routed N, dispatched N` log line asserted work
 * that never happened (live evidence: task c39b4a5e sat `in_progress` 2h+
 * with zero task_events/task_activities while the log claimed dispatched=1).
 *
 * The fix: only count a dispatch when the task's status actually reached
 * `in_progress` — the ONE place DISP-02's CAS claim writes, and the module's
 * own definition of "advanced" (see intake-advance-sweep.ts's file header).
 *
 * autoDispatchTask itself is mocked here (module boundary) rather than driven
 * for real: no unit test in this repo drives a live chat.send (see
 * agent-dispatch-concurrency-ceiling-auto.test.ts's header) — a real CAS claim
 * to in_progress requires a live/successful gateway send. The mock lets this
 * suite assert EXACTLY the property the fix is about — does the counter
 * observe the task's actual post-call status — independent of
 * autoDispatchTask's own (separately, extensively tested) internal guards.
 *
 *   npx vitest run tests/unit/fix-dispatch-counter-intake-advance.test.ts
 */
import './_isolated-db';
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_NOTIFY_DISABLED = '1';
process.env.CAMPAIGN_BOARD_FEED_DISABLED = '1';
process.env.INTAKE_ADVANCE_GRACE_SECONDS = '0';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.INTAKE_ADVANCE_SWEEP_ENABLED;

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ── Mock autoDispatchTask at the module boundary — see file header. ────────
// Scripted per-test: 'noop' leaves the task exactly as-is (models the 20+
// silent guards); 'dispatch' performs the ONE write DISP-02's real CAS claim
// performs (status -> in_progress) so the counting logic under test sees a
// REAL status transition, not a stub flag.
const dispatchScript = vi.hoisted(() => ({ mode: 'noop' as 'noop' | 'dispatch' }));

vi.mock('../../src/lib/task-dispatcher', () => ({
  autoDispatchTask: async (taskId: string) => {
    if (dispatchScript.mode === 'dispatch') {
      const { run } = await import('../../src/lib/db');
      run(`UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?`, [new Date().toISOString(), taskId]);
    }
    // 'noop': exactly what autoDispatchTask's guards do — resolve without
    // throwing and without touching the row. Never claim the CAS.
  },
}));

import { getDb } from '../../src/lib/db';
import { runIntakeAdvanceSweep } from '../../src/lib/jobs/intake-advance-sweep';

let workspaceId: string;

function isoSecondsAgo(s: number): string {
  return new Date(Date.now() - s * 1000).toISOString();
}

function seedAgent(): string {
  const id = uuidv4();
  getDb().prepare(
    `INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, 'standby')`,
  ).run(id, 'FIX-DISPATCH-COUNTER Builder', 'builder', workspaceId);
  return id;
}

function seedBacklogTask(agentId: string): string {
  const id = `fdc-${uuidv4()}`;
  getDb().prepare(
    `INSERT INTO tasks (id, title, status, priority, assigned_agent_id, workspace_id, department, updated_at)
     VALUES (?, ?, 'backlog', 'high', ?, ?, 'engineering', ?)`,
  ).run(id, 'Ship the thing', agentId, workspaceId, isoSecondsAgo(5));
  return id;
}

function statusOf(taskId: string): string {
  return (getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status;
}

beforeAll(() => {
  if (!getDb().prepare('SELECT id FROM companies WHERE id = ?').get('default')) {
    getDb().prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)').run('default', 'Default Company', 'default');
  }
  const slug = `fdc-eng-${uuidv4().slice(0, 8)}`;
  workspaceId = `fdc-ws-${uuidv4()}`;
  getDb().prepare('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 940)').run(workspaceId, 'FDC Engineering', slug);
});

describe('FIX-DISPATCH-COUNTER — dispatched only counts a REAL advance', () => {
  it('autoDispatchTask no-ops (a silent guard fires) → dispatched stays 0, even though the call succeeded', async () => {
    dispatchScript.mode = 'noop';
    const agentId = seedAgent();
    const taskId = seedBacklogTask(agentId);

    const result = await runIntakeAdvanceSweep();

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.dispatched).toBe(0);
    // Live-evidence lock: the task must NOT be left claiming in_progress
    // while nothing actually happened — it stays exactly where it was.
    expect(statusOf(taskId)).toBe('backlog');

    // Still `backlog` (an ADVANCEABLE status) — clean it up so it does not
    // get re-selected by a LATER test's sweep call in this file (all tests
    // share one process-lifetime isolated DB; see _isolated-db.ts).
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });

  it('autoDispatchTask actually claims the task (status -> in_progress) → dispatched counts it', async () => {
    dispatchScript.mode = 'dispatch';
    const agentId = seedAgent();
    const taskId = seedBacklogTask(agentId);

    const result = await runIntakeAdvanceSweep();

    expect(result.dispatched).toBe(1);
    expect(statusOf(taskId)).toBe('in_progress');
  });
});
