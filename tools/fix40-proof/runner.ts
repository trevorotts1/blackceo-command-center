import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'node:os';
import path from 'node:path';

// C8 HARD-ISOLATION GUARD - must be first import
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'fix40-proof-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Import DB AFTER env is set
const db = await import('../../src/lib/db');
const run = db.run;
const queryOne = db.queryOne;
const queryAll = db.queryAll;
const closeDb = db.closeDb;

// Helper to seed events
async function seedScenarioA() {
  const now = new Date().toISOString();
  // 1. Create a task with idempotency key K (this will be the archived task)
  const taskId = 'task-archived';
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, created_by_agent_id, created_at, updated_at, archived_at)
     VALUES (?, ?, 'backlog', 'medium', 'ws-ceo', 'agent-ceo', ?, ?, ?)`,
    ['task-archived', 'Test task', 'medium', 'ws-ceo', 'agent-ceo', now, now, now]
  );
  // 2. Create a task_created event for the archived task (key K)
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'task_created', ?, 'ingest:K', ?)`,
    ['evt-archived', taskId, 'ingest:K', now]
  );
  // 3. Create a second task_created event with same key K (this will be the live task)
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'task_created', ?, 'ingest:K', ?)`,
    ['evt-live', taskId, 'ingest:K', now]
  );
}

async function seedScenarioB() {
  const now = new Date().toISOString();
  // Only archived events - no live match
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'task_created', 'task-archived-2', 'ingest:K', ?)`,
    ['evt-archived-2', 'ingest:K', now]
  );
}

test('FIX 40: dedupe onto newest LIVE task when live match exists', async () => {
  await seedScenarioA();
  // Simulate createTaskCore call with idempotency_key "K"
  const input = {
    title: 'Test task',
    workspace_id: 'ws-ceo',
    status: 'backlog',
    priority: 'medium',
    idempotency_key: 'K',
    eventMessage: 'ingest:K',
  };
  const result = await import('../../src/lib/tasks').then(m => m.createTaskCore(input));
  assert.ok(result, 'should return task');
  assert.equal(result.deduped, true, 'must dedupe to existing live task');
  assert.equal(result.task.id, 'task-archived', 'must return the live task id');
});

test('FIX 40: fall through to Layer 2 when no live match (only archived events)', async () => {
  await seedScenarioB();
  const input = {
    title: 'Test task 2',
    workspace_id: 'ws-ceo',
    status: 'backlog',
    priority: 'medium',
    idempotency_key: 'K',
    eventMessage: 'ingest:K',
  };
  const result = await import('../../src/lib/tasks').then(m => m.createTaskCore(input));
  assert.ok(result, 'should return task');
  assert.equal(result.deduped, false, 'no live match should NOT dedupe');
  assert.ok(result.task.id, 'must create new task');
});

test('FIX 40: idempotency_key still dedupes across title window (Layer 1 intact)', async () => {
  // Reuse scenario A - same key "K" but different titles
  await seedScenarioA();
  const input = {
    title: 'Another test task',
    workspace_id: 'ws-ceo',
    status: 'backlog',
    priority: 'medium',
    idempotency_key: 'K',
    eventMessage: 'ingest:K',
  };
  const result = await import('../../src/lib/tasks').then(m => m.createTaskCore(input));
  assert.ok(result, 'should succeed');
  assert.equal(result.deduped, true, 'same idempotency_key must dedupe');
  assert.equal(result.task.id, 'task-archived', 'must return existing task');
});

test('FIX 40: idempotency_key with different key → 2 tasks', async () => {
  await seedScenarioA();
  const input = {
    title: 'Test task 2',
    workspace_id: 'ws-ceo',
    status: 'backlog',
    priority: 'medium',
    idempotency_key: 'K2',  // different key
    eventMessage: 'ingest:K2',
  };
  const result = await import('../../src/lib/tasks').then(m => m.createTaskCore(input));
  assert.ok(result, 'should succeed');
  assert.equal(result.deduped, false, 'different key must NOT dedupe');
  assert.ok(result.task.id, 'must create new task');
});

test('FIX 40: keyless same-title within window still dedups (Layer 2 intact)', async () => {
  // Scenario B: no idempotency_key, same title within dedup window
  await seedScenarioB();
  const input = {
    title: 'Keyless same-title',
    workspace_id: 'ws-ceo',
    status: 'backlog',
    priority: 'medium',
    idempotency_key: null,
    eventMessage: 'ingest:K',
  };
  const result = await import('../../src/lib/tasks').then(m => m.createTaskCore(input));
  assert.ok(result, 'should succeed');
  assert.equal(result.deduped, true, 'keyless same-title must dedupe via Layer 2');
  assert.equal(result.task.id, 'task-archived-2', 'must return existing task');
});
