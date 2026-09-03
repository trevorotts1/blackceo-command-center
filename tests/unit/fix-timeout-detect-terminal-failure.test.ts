/**
 * fix-timeout-detect-terminal-failure.test.ts — FIX-TIMEOUT-DETECT.
 *
 * The defect: a dispatched agent's turn can die WITHOUT ever emitting a
 * `TASK_COMPLETE:` marker (a hung tool call kills the turn with
 * `openclaw:prompt-error` / "chat run timed out" recorded only in the
 * OpenClaw session transcript). Before this fix, execution-watcher's
 * reconcile treated "no marker" identically whether the task was still
 * genuinely working or already dead — the card sat `in_progress` invisibly
 * (zero task_events, zero task_activities, zero QC) until the
 * stuck-in-progress sweep's silence-based timer (default 180/720 min)
 * eventually caught it.
 *
 * This suite drives the REAL runExecutionCompletionReconcile() end to end
 * against an isolated DB, with the OpenClaw gateway transport mocked at the
 * module boundary (no network) — the same technique
 * fix25-review-artifact-gate.test.ts already established for this exact
 * pipeline, extended to also script the raw chat.history transport
 * (findTerminalFailureMarker reads via readSessionHistory, not
 * getMessagesFromOpenClaw).
 *
 * Proves:
 *   1. a terminal-failure marker (no TASK_COMPLETE) → the card leaves
 *      in_progress PROMPTLY (same tick), to `blocked`, with the agent freed
 *      and a durable, structured event trail (task_block_events + a
 *      qc_escalation SYSTEM event) — not the 45/180-min silent wait.
 *   2. a healthy completing run (TASK_COMPLETE present) is BYTE-IDENTICAL to
 *      today — the new code path is never reached, the card still advances
 *      to review via the untouched TASK_COMPLETE path (fleet-safety
 *      regression guard).
 *   3. the detector does not depend on chat.history being healthy: a
 *      chat.history call that throws/times out (simulating the RPC failures
 *      already observed in production) degrades gracefully — no crash, task
 *      simply stays in_progress this tick, exactly like today when the
 *      probe is unreachable.
 *   4. no new bounce loop: once blocked, repeated reconcile ticks leave the
 *      card stable — never re-selected (status left in_progress), never
 *      re-blocked, never re-alerted, dispatch_attempts left untouched.
 *
 *   npx vitest run tests/unit/fix-timeout-detect-terminal-failure.test.ts
 */
import './_isolated-db';
process.env.DISABLE_QC_AUTO_SCORER = '1';
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_NOTIFY_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ── Mock the two transports the reconcile touches — no network. ────────────
// getMessagesFromOpenClaw backs the EXISTING TASK_COMPLETE scan (assistant-
// role, array-of-blocks content). getOpenClawClient backs readSessionHistory
// (role-agnostic, string content) which the NEW terminal-failure scan reads.
// Kept as two independently-scriptable channels so a test can prove the two
// paths are genuinely decoupled (e.g. TASK_COMPLETE present on one, absent on
// the other).
const gatewayScript = vi.hoisted(() => ({
  taskCompleteMessages: [] as Array<{ role: string; content: string }>,
  rawHistory: [] as Array<{ role: string; content: string }>,
  throwOnRawHistory: false,
}));

vi.mock('../../src/lib/planning-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/planning-utils')>();
  return {
    ...actual,
    getMessagesFromOpenClaw: async () => gatewayScript.taskCompleteMessages,
  };
});

vi.mock('../../src/lib/openclaw/client', () => ({
  getOpenClawClient: () => ({
    isConnected: () => true,
    connect: async () => {},
    call: async (method: string) => {
      if (method === 'chat.history') {
        if (gatewayScript.throwOnRawHistory) {
          throw new Error('Request timeout: chat.history');
        }
        return { messages: gatewayScript.rawHistory };
      }
      return {};
    },
  }),
}));

import { getDb } from '../../src/lib/db';

function statusOf(taskId: string): string {
  return (getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status;
}

function agentStatusOf(agentId: string): string {
  return (getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string }).status;
}

function blockEventCount(taskId: string): number {
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM task_block_events WHERE task_id = ?').get(taskId) as { n: number };
  return r.n;
}

function qcEscalationCount(taskId: string): number {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'qc_escalation' AND task_id = ?").get(taskId) as { n: number };
  return r.n;
}

let workspaceId: string;
let fixtureDir: string;

function seedAgent(status = 'working'): string {
  const id = uuidv4();
  getDb().prepare(
    `INSERT INTO agents (id, name, role, status, workspace_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, 'FIX-TIMEOUT-DETECT Builder', 'builder', status, workspaceId);
  return id;
}

function seedInProgressTask(agentId: string, opts: { description?: string | null } = {}): string {
  const id = `ftd-${uuidv4()}`;
  getDb().prepare(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id, department, dispatch_attempts)
     VALUES (?, ?, ?, 'in_progress', 'high', ?, ?, 'engineering', 0)`,
  ).run(id, 'Investigate the flaky deploy', opts.description ?? 'Original task description', agentId, workspaceId);
  return id;
}

function seedActiveSession(agentId: string, taskId: string, sessionId: string): void {
  getDb().prepare(
    `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id)
     VALUES (?, ?, ?, 'mission-control', 'active', ?)`,
  ).run(`ftd-sess-${uuidv4()}`, agentId, sessionId, taskId);
}

function seedDeliverable(taskId: string, diskPath: string): void {
  getDb().prepare(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path) VALUES (?, ?, 'file', 'Artifact', ?)`,
  ).run(`ftd-d-${uuidv4()}`, taskId, diskPath);
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftd-'));
  if (!getDb().prepare('SELECT id FROM companies WHERE id = ?').get('default')) {
    getDb().prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)').run('default', 'Default Company', 'default');
  }
  const slug = `ftd-eng-${uuidv4().slice(0, 8)}`;
  workspaceId = `ftd-ws-${uuidv4()}`;
  getDb().prepare('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 950)').run(workspaceId, 'FTD Engineering', slug);
});

afterEach(() => {
  gatewayScript.taskCompleteMessages = [];
  gatewayScript.rawHistory = [];
  gatewayScript.throwOnRawHistory = false;
});

describe('FIX-TIMEOUT-DETECT — terminal-failure marker (openclaw:prompt-error / "chat run timed out")', () => {
  it('blocks the card promptly, frees the agent, and writes a durable audit trail', async () => {
    const agentId = seedAgent('working');
    const taskId = seedInProgressTask(agentId);
    seedActiveSession(agentId, taskId, 'agent:main:' + agentId);

    // No TASK_COMPLETE anywhere; the raw session transcript carries the
    // terminal-failure signal on a NON-assistant role — proving the detector
    // is role-agnostic (getMessagesFromOpenClaw would have missed this).
    gatewayScript.taskCompleteMessages = [];
    gatewayScript.rawHistory = [
      { role: 'system', content: 'turn aborted: openclaw:prompt-error — chat run timed out' },
    ];

    const { runExecutionCompletionReconcile } = await import('../../src/lib/jobs/execution-watcher');
    await runExecutionCompletionReconcile();

    expect(statusOf(taskId)).toBe('blocked');
    expect(agentStatusOf(agentId)).toBe('standby');
    expect(blockEventCount(taskId)).toBe(1);
    expect(qcEscalationCount(taskId)).toBe(1);

    const row = getDb().prepare(
      'SELECT block_reason, block_audience, blocked_on_human, ask, description, dispatch_attempts FROM tasks WHERE id = ?',
    ).get(taskId) as {
      block_reason: string | null; block_audience: string | null; blocked_on_human: string | null;
      ask: string | null; description: string | null; dispatch_attempts: number | null;
    };
    expect(row.block_reason).toBe('agent_turn_terminal_failure');
    expect(row.block_audience).toBe('SYSTEM'); // operator concern — never the client's channel
    expect(row.blocked_on_human).toBe('operator');
    expect(row.ask).toBeTruthy();
    // The original description is preserved (appended to, not overwritten) —
    // blockTaskForQC's description write must never destroy task content.
    expect(row.description).toContain('Original task description');
    // Not a QC failure — the dispatch/QC attempt counters are untouched.
    expect(row.dispatch_attempts ?? 0).toBe(0);
  });

  it('no new bounce loop: repeated ticks leave the blocked card stable', async () => {
    const agentId = seedAgent('working');
    const taskId = seedInProgressTask(agentId);
    seedActiveSession(agentId, taskId, 'agent:main:' + agentId);
    gatewayScript.rawHistory = [{ role: 'system', content: 'openclaw:prompt-error' }];

    const { runExecutionCompletionReconcile } = await import('../../src/lib/jobs/execution-watcher');
    await runExecutionCompletionReconcile();
    expect(statusOf(taskId)).toBe('blocked');
    expect(blockEventCount(taskId)).toBe(1);

    // Two more ticks with the SAME scripted transcript still in place: the
    // task is no longer `in_progress`, so the reconcile's own SELECT excludes
    // it — it must never be re-selected, re-blocked, or re-alerted.
    await runExecutionCompletionReconcile();
    await runExecutionCompletionReconcile();

    expect(statusOf(taskId)).toBe('blocked');
    expect(blockEventCount(taskId)).toBe(1);
    expect(qcEscalationCount(taskId)).toBe(1);
    const agent = agentStatusOf(agentId);
    expect(agent).toBe('standby');
  });

  it('degrades gracefully when chat.history itself is unhealthy (times out) — no crash, no false block', async () => {
    const agentId = seedAgent('working');
    const taskId = seedInProgressTask(agentId);
    seedActiveSession(agentId, taskId, 'agent:main:' + agentId);
    gatewayScript.throwOnRawHistory = true; // simulates the real "Request timeout: chat.history" failures

    const { runExecutionCompletionReconcile } = await import('../../src/lib/jobs/execution-watcher');
    await expect(runExecutionCompletionReconcile()).resolves.toBeUndefined(); // never throws
    // No positive evidence was obtainable this tick — the card is left exactly
    // where it was (still in_progress), never falsely blocked on an RPC error.
    expect(statusOf(taskId)).toBe('in_progress');
    expect(blockEventCount(taskId)).toBe(0);

    // This task is DELIBERATELY left in_progress (that is what the test just
    // proved) — clean it up so it does not leak into a later test's reconcile
    // tick in this file (all tests share one process-lifetime isolated DB).
    // Children first (FK-referenced by task_id).
    getDb().prepare('DELETE FROM openclaw_sessions WHERE task_id = ?').run(taskId);
    getDb().prepare('DELETE FROM events WHERE task_id = ?').run(taskId);
    getDb().prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId);
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });
});

describe('FIX-TIMEOUT-DETECT — regression guard: a healthy completing run is unaffected', () => {
  it('TASK_COMPLETE present → advances to review exactly as before; the new detector never fires', async () => {
    const agentId = seedAgent('working');
    const taskId = seedInProgressTask(agentId);
    seedActiveSession(agentId, taskId, 'agent:main:' + agentId);

    const realFile = path.join(fixtureDir, `${taskId}.txt`);
    fs.writeFileSync(realFile, 'real deliverable bytes', 'utf-8');
    seedDeliverable(taskId, realFile);

    gatewayScript.taskCompleteMessages = [
      { role: 'assistant', content: 'TASK_COMPLETE: fixed the flaky deploy' },
    ];
    // Even if the RAW transport also carried a failure-shaped string, a FOUND
    // TASK_COMPLETE must win — this scan never even runs once `match` is set.
    gatewayScript.rawHistory = [{ role: 'system', content: 'openclaw:prompt-error (stale, from an earlier retry)' }];

    const { runExecutionCompletionReconcile } = await import('../../src/lib/jobs/execution-watcher');
    await runExecutionCompletionReconcile();

    expect(statusOf(taskId)).toBe('review');
    expect(agentStatusOf(agentId)).toBe('standby');
    // The terminal-failure path must NOT have fired: no block event, no
    // agent_turn_terminal_failure block_reason.
    expect(blockEventCount(taskId)).toBe(0);
    const row = getDb().prepare('SELECT block_reason FROM tasks WHERE id = ?').get(taskId) as { block_reason: string | null };
    expect(row.block_reason).toBeFalsy();
  });
});
