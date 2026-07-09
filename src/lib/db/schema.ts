/**
 * Database Schema for Command Center
 * 
 * This defines the current desired schema state.
 * For existing databases, migrations handle schema updates.
 * 
 * IMPORTANT: When adding new tables or columns:
 * 1. Add them here for new databases
 * 2. Create a migration in migrations.ts for existing databases
 */

export const schema = `
-- Companies table (Multi-company support)
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  industry TEXT,
  logo_url TEXT,
  config TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Index for companies
CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);

-- Workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT DEFAULT '📁',
  company_id TEXT DEFAULT 'default' REFERENCES companies(id),
  user_md TEXT,
  sort_order INTEGER DEFAULT 1000,
  head_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Index for workspaces by company
CREATE INDEX IF NOT EXISTS idx_workspaces_company ON workspaces(company_id);

-- Agents table
-- NOTE: agents.role_type TEXT column is added by migration 060.
-- It is intentionally NOT declared here to avoid a conflict with migration 034's
-- table-rebuild path (migration 034 uses colList from PRAGMA table_info at
-- run-time to INSERT rows into agents_new; if schema.ts added role_type before
-- migration 034 ran, agents_new would lack it and the INSERT would fail on fresh DBs).
-- Fresh DBs run schema.ts (without role_type) → migration 034 rebuilds cleanly
-- → migration 060 adds role_type. Existing DBs skip schema.ts entirely for this
-- table (CREATE TABLE IF NOT EXISTS is a no-op) and migration 060 does ALTER ADD.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT,
  avatar_emoji TEXT DEFAULT '🤖',
  status TEXT DEFAULT 'standby' CHECK (status IN ('standby', 'working', 'offline')),
  is_master INTEGER DEFAULT 0,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  soul_md TEXT,
  user_md TEXT,
  agents_md TEXT,
  tools_md TEXT,
  memory_md TEXT,
  model TEXT,
  specialist_type TEXT DEFAULT 'on-call' CHECK (specialist_type IN ('permanent', 'on-call')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Tasks table (Mission Queue)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  -- 10-status board model, in lockstep with TaskStatus (src/lib/types.ts) and
  -- validation.ts. Fresh databases get the widened CHECK directly; existing
  -- databases were rebuilt by migration 076, which detects this widened form
  -- and skips (its explicit "a future schema.ts ships the widened CHECK" path).
  status TEXT DEFAULT 'backlog' CHECK (status IN ('backlog', 'inbox', 'planning', 'pending_dispatch', 'assigned', 'in_progress', 'review', 'testing', 'blocked', 'done')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  assigned_agent_id TEXT REFERENCES agents(id),
  created_by_agent_id TEXT REFERENCES agents(id),
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  business_id TEXT DEFAULT 'default',
  department TEXT,
  due_date TEXT,
  planning_session_key TEXT,
  planning_messages TEXT,
  planning_complete INTEGER DEFAULT 0,
  planning_spec TEXT,
  planning_agents TEXT,
  planning_dispatch_error TEXT,
  sop_id TEXT,
  completed_at TEXT,
  archived_at TEXT,
  -- QC loop guard (migration 061): counts how many times this task has been
  -- returned to backlog by the QC scorer. Capped at QC_MAX_REROUTES (default 3)
  -- before the task is set to blocked status and the CEO is notified.
  qc_reroute_attempts INTEGER DEFAULT 0,
  -- PRD 2.12-cc dispatch-time SOP authoring link (migration 066 owns this for
  -- existing DBs; this base CREATE covers fresh installs). When set, this task
  -- is the "Author SOP" sub-task for the referenced original task. The fast-loop
  -- recursion guard skips SOP authoring for any task with this column set.
  sop_authoring_for_task_id TEXT,
  -- Ad-campaign assembly-line stage slug (migration 074). Identifies each stage
  -- card within an ad-run campaign; NULL for all non-ad tasks. The supporting
  -- partial indexes live ONLY in migration 074 because they reference
  -- campaign_id, which is added by migration 017 (not present in this base
  -- CREATE on a fresh DB before migrations run).
  stage_slug TEXT,
  -- DATA-01: dispatch/board attempt-accounting columns. These are read by HOT
  -- runtime paths (task-dispatcher.ts, the intake-advance / backlog-redispatch /
  -- stale-task sweeps) on every board tick. They were previously added ONLY by
  -- late ALTERs (migrations 077/078/083/084), so a fresh install that began
  -- serving traffic before those migrations completed would throw
  -- "no such column" on the very first dispatch read. Declaring them in the base
  -- CREATE makes a fresh DB self-sufficient. Existing DBs still receive them via
  -- the (idempotent, PRAGMA-guarded) migrations — this CREATE is a no-op there.
  -- NOTE: no CREATE INDEX for these is added to this base schema — schema.ts runs
  -- BEFORE migrations, so an index referencing one of these columns would throw
  -- on a pre-migration existing DB. Migration 077 creates
  -- idx_tasks_next_dispatch_eligible unconditionally (safe on both paths).
  dispatch_attempts INTEGER DEFAULT 0,        -- migration 077
  last_dispatch_attempt_at TEXT,              -- migration 077
  next_dispatch_eligible_at TEXT,             -- migration 077 (backoff gate)
  block_reason TEXT,                          -- migration 078
  redispatch_count INTEGER DEFAULT 0,         -- migration 084
  persona_fallback INTEGER DEFAULT 0,         -- migration 083 (defaulted-pin audit flag)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Task history table — every status transition is recorded here for
-- performance analytics (avg completion time, throughput, agent attribution).
CREATE TABLE IF NOT EXISTS task_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status_from TEXT,
  status_to TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  changed_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  agent_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_history_changed ON task_history(changed_at DESC);

-- Auto-set completed_at when a task transitions into 'done'.
CREATE TRIGGER IF NOT EXISTS trg_tasks_completed_at
AFTER UPDATE OF status ON tasks
FOR EACH ROW
WHEN NEW.status = 'done' AND (OLD.status IS NULL OR OLD.status <> 'done')
BEGIN
  UPDATE tasks SET completed_at = datetime('now') WHERE id = NEW.id;
END;

-- Planning questions table
CREATE TABLE IF NOT EXISTS planning_questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  question_type TEXT DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'text', 'yes_no')),
  options TEXT,
  answer TEXT,
  answered_at TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Planning specs table (locked specifications)
CREATE TABLE IF NOT EXISTS planning_specs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  spec_markdown TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  locked_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Conversations table (agent-to-agent or task-related)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'task')),
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Conversation participants
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, agent_id)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  sender_agent_id TEXT REFERENCES agents(id),
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'task_update', 'file')),
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Events table (for live feed)
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Businesses/Workspaces table (legacy - kept for compatibility)
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- OpenClaw session mapping
CREATE TABLE IF NOT EXISTS openclaw_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  openclaw_session_id TEXT NOT NULL,
  channel TEXT,
  status TEXT DEFAULT 'active',
  session_type TEXT DEFAULT 'persistent',
  task_id TEXT REFERENCES tasks(id),
  ended_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Task activities table (for real-time activity log)
CREATE TABLE IF NOT EXISTS task_activities (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id),
  activity_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Task deliverables table (files, URLs, artifacts)
-- NOTE: mime_type, file_size_bytes, sha256 added by migration 070 on existing DBs.
CREATE TABLE IF NOT EXISTS task_deliverables (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  deliverable_type TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT,
  description TEXT,
  mime_type TEXT,
  file_size_bytes INTEGER,
  sha256 TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- §3 task_events: structured audit trail for every lifecycle transition.
-- Written atomically with the DB update by task-lifecycle.ts transition().
-- The legacy events table remains for backwards compat; this table gives
-- the board and feed a clean query surface without parsing message strings.
CREATE TABLE IF NOT EXISTS task_events (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status  TEXT NOT NULL,
  actor      TEXT,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id, created_at);

-- Agent daily memory logs
CREATE TABLE IF NOT EXISTS agent_memory_logs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_id, log_date)
);

-- Recommendations table (Proactive Intelligence)
CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('do-more', 'stop', 'watch', 'try')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  supporting_data TEXT,
  confidence REAL DEFAULT 0.7,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed', 'saved')),
  approved_at TEXT,
  effectiveness_score INTEGER,
  measured_at TEXT,
  outcome_notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Index for recommendations
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
CREATE INDEX IF NOT EXISTS idx_recommendations_category ON recommendations(category);
CREATE INDEX IF NOT EXISTS idx_recommendations_department ON recommendations(department_id);

-- Recommendation outcomes table (Effectiveness Tracking)
CREATE TABLE IF NOT EXISTS recommendation_outcomes (
  id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  measured_at TEXT DEFAULT (datetime('now')),
  before_score INTEGER NOT NULL,
  after_score INTEGER NOT NULL,
  improvement_pct REAL NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_outcomes_rec ON recommendation_outcomes(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_measured ON recommendation_outcomes(measured_at DESC);

-- DA Challenges table (Devil's Advocate Feed) is created in migration 020.
-- The legacy shape that used to live here drifted from migration 020 and
-- broke fresh installs (see migration 024 for the reconciliation path).

-- Execution Queue table (Out-of-Hours Task Queue)
CREATE TABLE IF NOT EXISTS execution_queue (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  recommendation_id TEXT REFERENCES recommendations(id) ON DELETE SET NULL,
  task_name TEXT NOT NULL,
  department TEXT,
  queued_at TEXT DEFAULT (datetime('now')),
  scheduled_window TEXT DEFAULT 'evening' CHECK (scheduled_window IN ('evening', 'overnight', 'morning')),
  status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  started_at TEXT,
  completed_at TEXT,
  result_notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Index for execution queue
CREATE INDEX IF NOT EXISTS idx_execution_queue_status ON execution_queue(status);
CREATE INDEX IF NOT EXISTS idx_execution_queue_queued ON execution_queue(queued_at DESC);

-- Department Memory table
CREATE TABLE IF NOT EXISTS dept_memory (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  memory_type TEXT NOT NULL CHECK (memory_type IN ('decision', 'context', 'lesson', 'goal', 'constraint')),
  content TEXT NOT NULL,
  created_by TEXT DEFAULT 'system',
  importance INTEGER DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dept_memory_workspace ON dept_memory(workspace_id);
CREATE INDEX IF NOT EXISTS idx_dept_memory_type ON dept_memory(memory_type);
CREATE INDEX IF NOT EXISTS idx_dept_memory_importance ON dept_memory(importance DESC);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_activities_task ON task_activities(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverables_task ON task_deliverables(task_id);
CREATE INDEX IF NOT EXISTS idx_openclaw_sessions_task ON openclaw_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_planning_questions_task ON planning_questions(task_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_agent_memory_logs_agent ON agent_memory_logs(agent_id, log_date DESC);

-- Agent Settings table (Intelligence Settings - model/persona per department/role)
CREATE TABLE IF NOT EXISTS agent_settings (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  role_id TEXT,
  setting_type TEXT NOT NULL CHECK (setting_type IN ('model', 'persona')),
  value TEXT NOT NULL,
  locked_by TEXT,
  lock_reason TEXT,
  locked_at TEXT,
  lock_token TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_settings_dept ON agent_settings(department_id);
CREATE INDEX IF NOT EXISTS idx_agent_settings_role ON agent_settings(role_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_settings_unique ON agent_settings(department_id, role_id, setting_type);

-- SOPs table (Hybrid SOP system — Triad Rule: Task + SOP + Persona)
CREATE TABLE IF NOT EXISTS sops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  department TEXT,
  task_keywords TEXT,
  steps TEXT NOT NULL,
  success_criteria TEXT,
  persona_hints TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
-- NOTE: the role + source columns and their indexes (idx_sops_role,
-- idx_sops_source) are intentionally NOT declared in this base CREATE TABLE.
-- They are added by migration 050 (add_sops_role_and_source) for BOTH fresh and
-- existing databases. If they lived here, db.exec(schema) on every getDb() call
-- would run CREATE INDEX ... ON sops(role) against a pre-existing legacy sops
-- table (CREATE TABLE IF NOT EXISTS is a no-op on it), throwing
-- "no such column: role" before migration 050 could add the column -- crashing
-- the upgrade path for every database created before v4.3.0.
CREATE INDEX IF NOT EXISTS idx_sops_department ON sops(department);
CREATE INDEX IF NOT EXISTS idx_sops_slug ON sops(slug);
CREATE INDEX IF NOT EXISTS idx_sops_deleted ON sops(deleted_at);

-- Task QC Results table (PRD 2.10 — migration 068 also creates this for existing DBs)
-- Persists each scored QC result so the grading module can compute real pass-rates
-- without parsing free-text event messages. One row per scoring event; scoring_path
-- discriminates LLM results (gradeable) from heuristic/no-criteria (not graded).
-- SAFE to declare here AND in migration 068 — CREATE TABLE IF NOT EXISTS is idempotent.
CREATE TABLE IF NOT EXISTS task_qc_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id TEXT,
  department_slug TEXT,
  score REAL NOT NULL,
  passed INTEGER NOT NULL,
  scoring_path TEXT NOT NULL,
  qc_agent_id TEXT,
  attempt INTEGER DEFAULT 1,
  scored_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_qc_results_task ON task_qc_results(task_id, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_qc_results_dept ON task_qc_results(department_slug, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_qc_results_workspace ON task_qc_results(workspace_id, scored_at DESC);

-- LSS Control Reviews table (PRD 2.14 — migration 069 also creates this for existing DBs)
-- Persists monthly Lean Six Sigma control-review artifacts: company score/grade,
-- defect/rework/waste summary, per-dept breakdown, and narrative markdown.
-- SAFE to declare here AND in migration 069 — CREATE TABLE IF NOT EXISTS is idempotent.
CREATE TABLE IF NOT EXISTS lss_control_reviews (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  company_score REAL,
  company_grade TEXT,
  defect_rate REAL,
  rework_rate REAL,
  waste_summary TEXT,
  department_breakdown TEXT,
  narrative TEXT,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lss_reviews_period ON lss_control_reviews(period_end DESC);

-- Bug Tickets (ZHC Bugs Department -- dedicated lifecycle, NOT tasks.status)
-- Migration 071 also creates these for existing DBs (CREATE TABLE IF NOT EXISTS is idempotent).
CREATE TABLE IF NOT EXISTS bug_tickets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT DEFAULT 'bugs' REFERENCES workspaces(id),
  reporter_department TEXT NOT NULL,
  reporter_specialist TEXT,
  reporter_run_id TEXT,
  symptom TEXT NOT NULL,
  severity TEXT DEFAULT 'P1 degraded' CHECK (severity IN ('P0 run-dead','P1 degraded','P2 cosmetic or latent','P3 improvement')),
  suspected_layer TEXT,
  client_slug TEXT,
  status TEXT DEFAULT 'REPORTED' CHECK (status IN ('REPORTED','TRIAGED','HEALING','VERIFYING','HEALED','REGRESSION WATCH','CLOSED')),
  assigned_healer_agent_id TEXT REFERENCES agents(id),
  dedup_of TEXT,
  recurrence_count INTEGER DEFAULT 0,
  evidence_paths TEXT,
  regression_watch_until TEXT,
  root_cause TEXT,
  fix_summary TEXT,
  healing_report_path TEXT,
  reported_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bug_tickets_status ON bug_tickets(status);
CREATE INDEX IF NOT EXISTS idx_bug_tickets_workspace ON bug_tickets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_bug_tickets_dedup ON bug_tickets(dedup_of);

-- Bug ticket lane-transition audit trail (mirrors task_events shape)
CREATE TABLE IF NOT EXISTS bug_ticket_events (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES bug_tickets(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bug_ticket_events_bug ON bug_ticket_events(bug_id, created_at);
`;
