/**
 * JGT-106 — General Task laneless fallback.
 *
 * createTaskCore's in-process routing (src/lib/tasks.ts, the
 * `else if (decision.status !== 'assigned')` branch) previously only stamped
 * routing_reason/routing_wait_owner/routing_next_action when no worker could
 * be found — a card created with no workspace and no department stayed
 * workspace_id NULL forever: lane-less, invisible under every department
 * column. This proves the fix against the REAL createTaskCore write path
 * (never a reimplementation of the routing/park SQL):
 *
 *   1. A company with a general-task workspace but no eligible agents and no
 *      master -> the card lands with workspace_id = the general-task
 *      workspace, still unassigned (no agent invented).
 *   2. A company with NO general-task workspace at all -> unchanged behavior:
 *      workspace_id stays NULL.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-jgt106-laneless-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
delete process.env.OPENCLAW_GATEWAY_TOKEN;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type TasksModule = typeof import('../../src/lib/tasks');
let createTaskCore: TasksModule['createTaskCore'];

const RUN_ID = Math.random().toString(36).slice(2, 10);
const COMPANY_WITH_GENERAL = `jgt106-with-general-${RUN_ID}`;
const COMPANY_WITHOUT_GENERAL = `jgt106-without-general-${RUN_ID}`;
const GENERAL_WS_ID = `ws-general-${RUN_ID}`;
const UNRELATED_WS_ID = `ws-unrelated-${RUN_ID}`;

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // full migration chain

  const now = new Date().toISOString();
  for (const companyId of [COMPANY_WITH_GENERAL, COMPANY_WITHOUT_GENERAL]) {
    run(
      `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)`,
      [companyId, companyId, companyId, now, now],
    );
  }

  // Company A: carries a general-task workspace, but NO agents at all — no
  // eligible worker, no master/CEO to escalate to.
  run(
    `INSERT INTO workspaces (id, name, slug, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'General Task', 'general-task', '🗂️', ?, 99999, ?, ?)`,
    [GENERAL_WS_ID, COMPANY_WITH_GENERAL, now, now],
  );

  // Company B: carries some OTHER workspace but never a general-task one, and
  // also no agents — the "unchanged behavior" control.
  run(
    `INSERT INTO workspaces (id, name, slug, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'Marketing', 'marketing', '📣', ?, 1, ?, ?)`,
    [UNRELATED_WS_ID, COMPANY_WITHOUT_GENERAL, now, now],
  );

  const tasks = (await import('../../src/lib/tasks')) as TasksModule;
  createTaskCore = tasks.createTaskCore;
});

test.after(() => {
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
});

test('JGT-106: no workspace, no department, no eligible worker -> parked in the company\'s general-task lane, still unassigned', async () => {
  const title = `Untriaged request ${RUN_ID}`;
  const result = await createTaskCore(
    {
      title,
      idempotency_company_id: COMPANY_WITH_GENERAL,
      skipWindowDedup: true,
    },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const row = queryOne<{ workspace_id: string | null; assigned_agent_id: string | null }>(
    'SELECT workspace_id, assigned_agent_id FROM tasks WHERE id = ?',
    [result!.task.id],
  );
  assert.ok(row, 'task row must exist');
  assert.equal(row!.workspace_id, GENERAL_WS_ID, 'a lane-less card must be parked in the company general-task workspace, never left NULL');
  assert.equal(row!.assigned_agent_id, null, 'no agent may be invented — the card stays unassigned');
});

test('JGT-106: no general-task workspace in the company -> unchanged behavior, workspace_id stays NULL', async () => {
  const title = `Untriaged request no-general ${RUN_ID}`;
  const result = await createTaskCore(
    {
      title,
      idempotency_company_id: COMPANY_WITHOUT_GENERAL,
      skipWindowDedup: true,
    },
    { notifyGateway: false },
  );
  assert.ok(result, 'task must be created');
  const row = queryOne<{ workspace_id: string | null; assigned_agent_id: string | null }>(
    'SELECT workspace_id, assigned_agent_id FROM tasks WHERE id = ?',
    [result!.task.id],
  );
  assert.ok(row, 'task row must exist');
  assert.equal(row!.workspace_id, null, 'with no general-task workspace to park in, behavior is unchanged: workspace_id stays NULL');
  assert.equal(row!.assigned_agent_id, null);
});
