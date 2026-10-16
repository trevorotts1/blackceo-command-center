import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-podcast-engine-owned-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];
type DispatcherModule = typeof import('../../src/lib/task-dispatcher');
let autoDispatchTask: DispatcherModule['autoDispatchTask'];

const AGENT_ID = 'agent-podcast-engine-owned';

test.before(async () => {
  const db: DbModule = await import('../../src/lib/db');
  run = db.run; queryOne = db.queryOne; queryAll = db.queryAll;
  closeDb = db.closeDb; getDb = db.getDb;
  getDb();
  run(`INSERT INTO agents (id, name, role, is_master, workspace_id) VALUES (?, ?, ?, 0, NULL)`,
    [AGENT_ID, 'Podcast Engine Owned Test Agent', 'specialist']);
  const dispatcher: DispatcherModule = await import('../../src/lib/task-dispatcher');
  autoDispatchTask = dispatcher.autoDispatchTask;
});

test.after(async () => {
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try {
    const g = globalThis as Record<string, NodeJS.Timeout | undefined>;
    const timer = g['__openclaw_cache_cleanup_timer__'];
    if (timer) { clearInterval(timer); delete g['__openclaw_cache_cleanup_timer__']; }
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedEngineCard(id: string, source: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks
       (id, title, description, status, priority, assigned_agent_id, workspace_id, business_id,
        sop_id, persona_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', ?, NULL, NULL, NULL, 'hormozi-100m-offers', ?, ?, ?)`,
    [id, `Engine card ${id}`, 'seeded engine-owned card', AGENT_ID, source, now, now],
  );
}

test('[podcast-engine-owned] podcast-engine card is held, never dispatched, with owning-engine message', async () => {
  const taskId = 'task-podcast-engine-owned';
  seedEngineCard(taskId, 'podcast-engine');
  const res = await autoDispatchTask(taskId, 'test');
  assert.equal(res.status, 'held');
  assert.equal(res.reason, 'dispatch_precondition');
  const status = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])?.status;
  assert.equal(status, 'backlog');
  const holds = queryAll<{ message: string }>(
    "SELECT message FROM events WHERE task_id = ? AND type = 'engine_owned_card_not_dispatched' ORDER BY created_at", [taskId]);
  assert.equal(holds.length, 1);
  assert.match(holds[0].message, /owning engine is the single executor/);
});

test('[podcast-engine-owned] engineSourceLabel names the Podcast Engine producer', async () => {
  const { engineSourceLabel } = await import('../../src/components/TaskOverviewPanels');
  assert.equal(engineSourceLabel({ source: 'podcast-engine', description: null }), 'the Podcast Engine');
});
