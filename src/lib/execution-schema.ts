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
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(task_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_execution_active_task ON task_executions(task_id)
 WHERE state IN ('reserved','sending','accepted','running','unknown');
CREATE UNIQUE INDEX IF NOT EXISTS task_execution_worker_capacity ON task_executions(agent_id)
 WHERE state IN ('reserved','sending','accepted','running','unknown');
CREATE TABLE IF NOT EXISTS scheduler_leases (
 job_name TEXT PRIMARY KEY,
 owner TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
`;
