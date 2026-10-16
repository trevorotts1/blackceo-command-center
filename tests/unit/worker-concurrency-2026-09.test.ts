/**
 * worker-concurrency-2026-09.test.ts — the OPTIONAL per-agent ceiling.
 *
 * reserveExecution used to refuse a dispatch whenever the agent had ANY active
 * execution, and a UNIQUE partial index on task_executions(agent_id) enforced
 * the same one-at-a-time rule in the database. The gateway runs many concurrent
 * runs per agent, so the Command Center — not the runtime — was what serialized
 * a department to one card at a time. Migration 149 replaced that with
 * `agents.max_concurrent_executions`, defaulting to 1.
 *
 * Migration 150 then moved the DEFAULT limit off the agent entirely: capacity
 * is a property of the client's provider PLAN (provider-capacity-pools-2026-09
 * .test.ts covers the pools). `agents.max_concurrent_executions` survives as an
 * OPTIONAL pin — NULL means "no agent ceiling, the pool is the limit" — and
 * that pin is what this file covers. Every fixture agent therefore runs on a
 * DeepSeek Direct model, whose pool of 50 is never the binding constraint here.
 * The PER-TASK rule is untouched: one live execution per card, ever.
 *
 *   node --import tsx --test tests/unit/worker-concurrency-2026-09.test.ts
 */

import './_isolated-db'; // MUST be the first DB-reaching import (C8 guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { EXECUTION_SCHEMA_SQL } from '../../src/lib/execution-schema';
import {
  reserveExecution,
  workerConcurrencyLimit,
  executionSessionId,
  type DispatchSnapshot,
} from '../../src/lib/execution-attempts';

/** Mirrors the post-migration-150 shape: the agent ceiling is nullable and unset. */
function fixture() {
  const db = new Database(':memory:');
  db.exec(`
   CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,model TEXT,max_concurrent_executions INTEGER);
   INSERT INTO agents(id,name,model) VALUES('a','Marketing Lead','deepseek/deepseek-v4-flash'),('b','Ops Lead','deepseek/deepseek-v4-flash');
   CREATE TABLE tasks(id TEXT PRIMARY KEY,assigned_agent_id TEXT,assignment_version INTEGER DEFAULT 0,status TEXT,workspace_id TEXT,department TEXT,source TEXT,killed_at TEXT,archived_at TEXT,description TEXT,updated_at TEXT);
   CREATE TABLE openclaw_sessions(id TEXT PRIMARY KEY,agent_id TEXT,openclaw_session_id TEXT,channel TEXT,status TEXT,task_id TEXT,created_at TEXT,updated_at TEXT);
   CREATE TABLE events(id TEXT,type TEXT,task_id TEXT,agent_id TEXT,message TEXT,created_at TEXT);
   INSERT INTO tasks(id,assigned_agent_id,status,workspace_id,department) VALUES
     ('t1','a','assigned','ws','marketing'),('t2','a','assigned','ws','marketing'),
     ('t3','a','assigned','ws','marketing'),('t4','b','assigned','ws','ops');`);
  db.exec(EXECUTION_SCHEMA_SQL);
  return db;
}

const snap = (db: Database.Database, id: string) =>
  db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as DispatchSnapshot;
const claim = (db: Database.Database, id: string, eid: string) =>
  reserveExecution(
    snap(db, id),
    `agent:marketing:${executionSessionId(snap(db, id).assigned_agent_id!, eid)}`,
    eid,
    db,
  );
const setLimit = (db: Database.Database, agentId: string, n: number | null) =>
  db.prepare('UPDATE agents SET max_concurrent_executions=? WHERE id=?').run(n, agentId);

test('no ceiling is the default: an agent is bounded by its pool, not by itself', () => {
  const db = fixture();
  try {
    assert.equal(workerConcurrencyLimit('a', db), null, 'migration 150 leaves the pin unset');
    assert.ok(claim(db, 't1', 'e1').execution);
    assert.ok(claim(db, 't2', 'e2').execution, 'ONE agent, two live jobs');
    assert.ok(claim(db, 't3', 'e3').execution);
  } finally {
    db.close();
  }
});

test('a pin of 1: one live execution per worker, refused as worker_at_capacity', () => {
  const db = fixture();
  try {
    setLimit(db, 'a', 1);
    assert.equal(workerConcurrencyLimit('a', db), 1);
    assert.ok(claim(db, 't1', 'e1').execution);
    const refused = claim(db, 't2', 'e2');
    assert.equal(refused.execution, undefined);
    assert.equal(refused.reason, 'worker_at_capacity');
    assert.equal(refused.running, 1, 'the refusal names the queue depth');
    assert.equal(refused.limit, 1);
    // Another worker is unaffected by this one's capacity.
    assert.ok(claim(db, 't4', 'e4').execution);
  } finally {
    db.close();
  }
});

test('limit 2: a second execution is allowed, a third is queued', () => {
  const db = fixture();
  try {
    setLimit(db, 'a', 2);
    assert.equal(workerConcurrencyLimit('a', db), 2);
    assert.ok(claim(db, 't1', 'e1').execution, 'first slot');
    assert.ok(claim(db, 't2', 'e2').execution, 'second slot — the whole point of this change');
    const third = claim(db, 't3', 'e3');
    assert.equal(third.execution, undefined);
    assert.equal(third.reason, 'worker_at_capacity');
    assert.equal(third.running, 2);
    assert.equal(third.limit, 2);
  } finally {
    db.close();
  }
});

test('the per-task single-execution rule survives any limit', () => {
  const db = fixture();
  try {
    setLimit(db, 'a', 4);
    assert.ok(claim(db, 't1', 'e1').execution);
    const second = claim(db, 't1', 'e2');
    assert.equal(second.execution, undefined);
    assert.equal(second.reason, 'execution_or_worker_busy', 'one live attempt per CARD, never two');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM task_executions WHERE task_id='t1'").get() as { n: number }).n,
      1,
    );
  } finally {
    db.close();
  }
});

test('a legacy in_progress task only blocks the worker at limit 1', () => {
  const db = fixture();
  try {
    setLimit(db, 'a', 1);
    // A shared-session worker whose old card is still running, with no execution row.
    db.prepare("UPDATE tasks SET status='in_progress' WHERE id='t3'").run();
    assert.equal(claim(db, 't1', 'e1').reason, 'worker_busy_legacy_task');
    setLimit(db, 'a', 2);
    assert.ok(claim(db, 't1', 'e2').execution, 'sessions are per-execution above limit 1');
  } finally {
    db.close();
  }
});

test('WORKER_MAX_CONCURRENT_DEFAULT is the box-wide fallback for the pin, and is unset by default', () => {
  const db = fixture();
  try {
    db.exec('DROP TABLE agents; CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,model TEXT); INSERT INTO agents(id,name,model) VALUES(\'a\',\'Marketing Lead\',\'deepseek/deepseek-v4-flash\'),(\'b\',\'Ops Lead\',\'deepseek/deepseek-v4-flash\')');
    assert.equal(workerConcurrencyLimit('a', db), null, 'no column, no env → no agent ceiling (a pre-migration box dispatches, bounded by its pool)');
    process.env.WORKER_MAX_CONCURRENT_DEFAULT = '3';
    try {
      assert.equal(workerConcurrencyLimit('a', db), 3);
      assert.ok(claim(db, 't1', 'e1').execution);
      assert.ok(claim(db, 't2', 'e2').execution);
      assert.ok(claim(db, 't3', 'e3').execution);
      assert.equal(claim(db, 't4', 'e4').execution !== undefined, true, 'a different worker has its own budget');
    } finally {
      delete process.env.WORKER_MAX_CONCURRENT_DEFAULT;
    }
    assert.equal(workerConcurrencyLimit('a', db), null, 'unset → no ceiling');
  } finally {
    db.close();
  }
});
