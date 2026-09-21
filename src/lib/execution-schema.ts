/**
 * States in which an execution still OWNS capacity — the task's slot, its
 * worker's slot and its provider pool's slot. `unknown` is in the set because an
 * unacknowledged send may still be running remotely; absence of an
 * acknowledgement is never evidence that remote work did not start.
 *
 * Kept here, in the dependency-free schema module, because both
 * `execution-attempts.ts` and `capacity/provider-pools.ts` count against this
 * same set and neither should have to import the other to agree on it. It is a
 * SQL fragment so it can be interpolated straight into an `IN (...)` clause;
 * it contains only literals this file writes.
 */
export const ACTIVE_EXECUTION_STATES_SQL = "('reserved','sending','accepted','running','unknown')";

/** Additive schema used by migration 132 and isolated failure-injection tests. */
export const EXECUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_executions (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 assignment_version INTEGER NOT NULL,
 agent_id TEXT NOT NULL REFERENCES agents(id),
 workspace_id TEXT,
 generation INTEGER NOT NULL,
  worker_context TEXT NOT NULL DEFAULT '[]',
 session_key TEXT NOT NULL UNIQUE,
 session_id TEXT NOT NULL UNIQUE,
 remote_run_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('reserved','sending','accepted','running','succeeded','failed','unknown')),
 lease_owner TEXT NOT NULL,
 lease_expires_at TEXT NOT NULL,
 heartbeat_at TEXT,
 progress_at TEXT,
 idempotency_key TEXT NOT NULL UNIQUE,
 error_code TEXT,
 -- PROVIDER POOL (migration 150): the provider prefix of the runtime model this
 -- execution was dispatched on, denormalised onto the row so reserveExecution can
 -- count a pool inside BEGIN IMMEDIATE without joining back through agents and
 -- re-reading openclaw.json on every reserve. NULL on rows written before the
 -- column existed; those count toward no pool.
 provider TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(task_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_execution_active_task ON task_executions(task_id)
 WHERE state IN ('reserved','sending','accepted','running','unknown');
-- Worker capacity is COUNTED, not uniquely indexed: agents.max_concurrent_executions
-- (migration 149) may allow more than one live execution per worker, which a UNIQUE
-- index cannot express. reserveExecution does the count inside BEGIN IMMEDIATE.
-- Migration 149 drops the old unique index on databases that already have it.
CREATE INDEX IF NOT EXISTS idx_task_executions_agent_state ON task_executions(agent_id, state);
-- Provider capacity is counted the same way, against the same ACTIVE set.
CREATE INDEX IF NOT EXISTS idx_task_executions_provider_state ON task_executions(provider, state);
-- A provider that answered 429 is shut for PROVIDER_COOLDOWN_MS. One row per
-- pool; a past 'until' means the pool is open.
CREATE TABLE IF NOT EXISTS provider_cooldowns (
 provider TEXT PRIMARY KEY,
 until TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduler_leases (
 job_name TEXT PRIMARY KEY,
 owner TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
`;
