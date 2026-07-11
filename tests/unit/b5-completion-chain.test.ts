/**
 * b5-completion-chain.test.ts — fragile completion chain fixes (finding B5).
 *
 * Covers:
 *   1. registerDeliverable() no longer names the `updated_at` column, so it works
 *      on live DBs created BEFORE updated_at was added to schema.ts (migration 070
 *      never ADDs it) — the exact defect that made every registerDeliverable()
 *      throw and silently broke the completion chain. Proven by DROPPING the
 *      column and asserting the insert still succeeds.
 *   2. deterministicOpenclawSessionId() is a stable pure function of the agent
 *      name (the id the dispatcher stores + the webhook/watcher re-derive).
 *   3. sessionIdForTask() derives that id when the DB row is missing.
 *   4. upsertActiveSession() inserts then updates the single active row.
 *
 *   node --import tsx --test tests/unit/b5-completion-chain.test.ts
 */

import './_isolated-db'; // MUST be first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { registerDeliverable } from '../../src/lib/task-lifecycle';
import { deterministicOpenclawSessionId } from '../../src/lib/task-dispatcher';
import { sessionIdForTask, upsertActiveSession } from '../../src/lib/jobs/execution-watcher';

const db = getDb();

// The reseed aborts on this box's template config, so no workspace id='default'
// exists — and tasks.workspace_id defaults to 'default' (a REFERENCES workspaces
// FK). Seed one real workspace and reference it explicitly to avoid the FK trip.
const WS_ID = `ws-${uuidv4()}`;
run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 900)', [WS_ID, 'B5 WS', `b5-${uuidv4().slice(0, 8)}`]);

function seedTask(): string {
  const id = uuidv4();
  run('INSERT INTO tasks (id, title, status, workspace_id) VALUES (?, ?, ?, ?)', [id, 'B5 task', 'in_progress', WS_ID]);
  return id;
}

test('B5: registerDeliverable succeeds on a schema WITHOUT the updated_at column', () => {
  // Simulate the live box: task_deliverables exists but has NO updated_at column
  // (created before it was added; migration 070 only adds mime/size/sha).
  const cols = (db.prepare('PRAGMA table_info(task_deliverables)').all() as { name: string }[]).map((c) => c.name);
  if (cols.includes('updated_at')) {
    db.exec('ALTER TABLE task_deliverables DROP COLUMN updated_at');
  }
  const after = (db.prepare('PRAGMA table_info(task_deliverables)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!after.includes('updated_at'), 'precondition: updated_at column is absent');

  const taskId = seedTask();
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b5-')), 'artifact.txt');
  fs.writeFileSync(tmpFile, 'hello deliverable');

  // Before the fix this threw "table task_deliverables has no column named updated_at".
  let id = '';
  assert.doesNotThrow(() => {
    id = registerDeliverable(taskId, { path: tmpFile, mime: 'text/plain', bytes: 17, sha256: 'deadbeef' });
  }, 'registerDeliverable must not reference a nonexistent column');
  assert.ok(id, 'returns a deliverable id');

  const rowCount = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM task_deliverables WHERE task_id = ?', [taskId]);
  assert.equal(rowCount?.n, 1, 'exactly one deliverable row persisted');

  // Idempotent: same task_id + path returns the existing id, no duplicate row.
  const id2 = registerDeliverable(taskId, { path: tmpFile, mime: 'text/plain', bytes: 17, sha256: 'deadbeef' });
  assert.equal(id2, id, 'idempotent on (task_id, path)');
});

test('B5: deterministicOpenclawSessionId is a stable pure function of the name', () => {
  assert.equal(deterministicOpenclawSessionId('Director of Communications'), 'mission-control-director-of-communications');
  assert.equal(deterministicOpenclawSessionId('Engineering'), 'mission-control-engineering');
  // Stable across calls (the property that lets the webhook/watcher re-derive it).
  assert.equal(deterministicOpenclawSessionId('Sales Lead'), deterministicOpenclawSessionId('Sales Lead'));
});

test('B5: sessionIdForTask derives the id when the openclaw_sessions row is missing', () => {
  assert.equal(
    sessionIdForTask({ openclaw_session_id: null, assigned_agent_name: 'Engineering' }),
    'mission-control-engineering',
    'derives from agent name when no stored id',
  );
  assert.equal(
    sessionIdForTask({ openclaw_session_id: 'mission-control-stored', assigned_agent_name: 'Engineering' }),
    'mission-control-stored',
    'prefers the stored id when present',
  );
  assert.equal(
    sessionIdForTask({ openclaw_session_id: null, assigned_agent_name: null }),
    null,
    'null when nothing to derive from',
  );
});

test('B5: upsertActiveSession inserts once then updates the single active row', () => {
  const agentId = uuidv4();
  run('INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)', [agentId, 'Engineering', 'Head', WS_ID, 'working']);
  const taskA = seedTask();
  const taskB = seedTask();

  upsertActiveSession(agentId, 'mission-control-engineering', taskA);
  let rows = db.prepare("SELECT openclaw_session_id, task_id FROM openclaw_sessions WHERE agent_id = ? AND status='active'").all(agentId) as {
    openclaw_session_id: string;
    task_id: string;
  }[];
  assert.equal(rows.length, 1, 'one active session inserted');
  assert.equal(rows[0].task_id, taskA, 'bound to task A');

  // Second call updates (does NOT create a duplicate active row).
  upsertActiveSession(agentId, 'mission-control-engineering', taskB);
  rows = db.prepare("SELECT openclaw_session_id, task_id FROM openclaw_sessions WHERE agent_id = ? AND status='active'").all(agentId) as {
    openclaw_session_id: string;
    task_id: string;
  }[];
  assert.equal(rows.length, 1, 'still exactly one active session (upsert, not duplicate)');
  assert.equal(rows[0].task_id, taskB, 're-bound to task B');
});
