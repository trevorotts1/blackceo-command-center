/**
 * writeback-pipeline-e2e.test.ts — END-TO-END proof of the write-back-401 defect
 * and its fix, walked as one narrative against the real lib + isolated DB:
 *
 *   STEP 0  the pipeline is written against the REAL status enum — `delivered`
 *           is NOT a status (a PATCH to it is a 400); `done`/`review` are.
 *   STEP 1  the FAIL-LOUD dispatch preflight refuses to dispatch a task when a
 *           dispatched agent could not authenticate its write-backs (no more
 *           silent-401 trap); with MC_API_TOKEN present, dispatch is allowed.
 *   STEP 2  the loop closes: a task that FINISHED (output on disk) but whose
 *           write-back 401'd is RECOVERED to `review` (its on-disk output
 *           redelivered) by the sweep — instead of being blocked/discarded.
 *
 *   node --import tsx --test tests/unit/writeback-pipeline-e2e.test.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

// getProjectsPath() (used by the disk-recovery gate) reads PROJECTS_PATH at call
// time — point it at a temp projects root before importing anything.
const PROJECTS = mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-proj-'));
process.env.PROJECTS_PATH = PROJECTS;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
process.env.STUCK_IN_PROGRESS_MINUTES = '45';

import './_isolated-db'; // MUST be first (after env setup).
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { UpdateTaskSchema } from '../../src/lib/validation';
import { checkTaskWriteAuth } from '../../src/lib/mc-auth';
import { runStuckInProgressSweep } from '../../src/lib/jobs/stuck-in-progress-sweep';

getDb();

const SAVED_ENV = {
  MC_API_TOKEN: process.env.MC_API_TOKEN,
  ALLOW_INSECURE_OPEN_API: process.env.ALLOW_INSECURE_OPEN_API,
  NODE_ENV: process.env.NODE_ENV,
};
function restoreEnv() {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string>)[k] = v;
  }
}

test('E2E-0: pipeline uses the real status enum — `delivered` is rejected, done/review accepted', () => {
  assert.equal(UpdateTaskSchema.safeParse({ status: 'delivered' }).success, false,
    '`delivered` is a notification, not a status — a PATCH to it must 400');
  assert.equal(UpdateTaskSchema.safeParse({ status: 'done' }).success, true);
  assert.equal(UpdateTaskSchema.safeParse({ status: 'review' }).success, true);
  assert.equal(UpdateTaskSchema.safeParse({ status: 'in_progress' }).success, true);
});

test('E2E-1: fail-loud preflight refuses dispatch when write-back auth is unprovisioned', () => {
  try {
    delete process.env.MC_API_TOKEN;
    delete process.env.ALLOW_INSECURE_OPEN_API;
    process.env.NODE_ENV = 'production';
    const blocked = checkTaskWriteAuth();
    assert.equal(blocked.ok, false, 'no token in prod → dispatch is HELD, not sent into a silent-401 trap');
    assert.match(blocked.reason, /MC_API_TOKEN/);

    process.env.MC_API_TOKEN = 'e2e-token';
    assert.equal(checkTaskWriteAuth().ok, true, 'token present → agent write-backs will authenticate → dispatch allowed');
  } finally {
    restoreEnv();
  }
});

test('E2E-2: finished work trapped in_progress by a 401 is recovered to review (on-disk redelivered)', async () => {
  // A dispatched agent finished — output is on disk — but its write-back 401'd,
  // so the card is still in_progress with no registered deliverable.
  const wsId = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [wsId, 'Presentations', `pres-${uuidv4().slice(0, 8)}`]);
  const agentId = uuidv4();
  run('INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)', [
    agentId, 'Deck Designer', 'Department Head', wsId, 'working',
  ]);
  const taskId = uuidv4();
  const old = new Date(Date.now() - 90 * 60_000).toISOString();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, assigned_agent_id, updated_at, last_progress_at)
     VALUES (?, ?, 'in_progress', ?, ?, ?, ?)`,
    [taskId, `Client deck ${uuidv4()}`, wsId, agentId, old, old],
  );

  // The finished output on disk that the 401'd write-back never registered.
  const artDir = path.join(PROJECTS, 'artifacts', taskId);
  mkdirSync(artDir, { recursive: true });
  writeFileSync(path.join(artDir, 'presentation.html'), '<html>finished deck</html>');

  const result = await runStuckInProgressSweep();
  assert.ok(result.recoveredIds.includes(taskId), 'the finished-but-trapped task is recovered, not blocked');
  assert.ok(!result.blockedIds.includes(taskId), 'finished work is never blocked');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, 'review', 'recovered forward to review for QC — the real terminal-adjacent status');

  const del = queryOne<{ n: number; p: string }>(
    'SELECT COUNT(*) AS n, MAX(path) AS p FROM task_deliverables WHERE task_id = ?',
    [taskId],
  );
  assert.ok((del?.n ?? 0) >= 1, 'the on-disk output was redelivered as a deliverable');
  assert.equal(del?.p, artDir, 'the recovered deliverable points at the real on-disk output dir');

  const agent = queryOne<{ status: string }>('SELECT status FROM agents WHERE id = ?', [agentId]);
  assert.equal(agent?.status, 'standby', 'the wedged agent is freed');
});
