-- GENUINE v4.72.0-era Command Center database schema.
--
-- Generated from the repo's OWN history, NOT hand-written and NOT copied from any
-- client box:
--     git worktree add --detach <wt> v4.72.0
--     (cd <wt> && DATABASE_PATH=old.db npx tsx -e "import{getDb,closeDb}from'./src/lib/db/index';getDb();closeDb()")
--     sqlite3 old.db .schema  +  the 87 _migrations rows it recorded
--
-- This is the exact shape a box stuck on v4.72.0 has:
--   * workspaces has NO archived_at / archived_reason column
--   * tasks DOES have archived_at (migration 058)
--   * _migrations holds 87 rows, last applied = 090
-- Migrations 091-095 have never run. Upgrading such a box to v5.14.0-v5.16.0
-- deadlocked: schema.ts indexed workspaces(archived_at) before migration 095
-- could add the column. See tests/unit/db-upgrade-migration-ordering.test.ts.

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  industry TEXT,
  logo_url TEXT,
  config TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_companies_slug ON companies(slug);
CREATE TABLE workspaces (
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
, original_slug TEXT);
CREATE INDEX idx_workspaces_company ON workspaces(company_id);
CREATE TABLE tasks (
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
  -- Immutable board-producer provenance (migration 089 / INGEST-10). Stamped
  -- ONLY at creation from the validated ingest 'source' field; never exposed
  -- on UpdateTaskSchema / the PATCH surface. /api/tasks/[id]/status uses this
  -- (never the caller-editable description) as the authoritative scope gate.
  source TEXT,
  -- Persona-blend + audience-confirm mirror columns (migration 090 owns these for
  -- existing DBs; this base CREATE covers fresh installs). Nullable + additive:
  -- the resolved VOICE decision (voice_persona_id / topic_persona_id / voice_collapsed
  -- / blend_directive) and the confirmed audience (audience_id / label / source). The
  -- full bundle lives in task_persona_bundle; tasks.persona_id/name/mode stay the
  -- back-compat mirror of the resolved VOICE persona.
  voice_persona_id TEXT,
  topic_persona_id TEXT,
  audience_id TEXT,
  audience_label TEXT,
  audience_source TEXT,
  voice_collapsed INTEGER,
  blend_directive TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
, persona_id TEXT, persona_name TEXT, persona_mode TEXT, persona_score REAL, persona_selected_at TEXT, campaign_id TEXT REFERENCES campaigns(id), persona_version INTEGER, secondary_persona_id TEXT, secondary_persona_name TEXT, secondary_persona_score REAL, model_id TEXT, blocked_reason TEXT CHECK (blocked_reason IN ('decision','approval','credential','payment') OR blocked_reason IS NULL), blocked_on_human TEXT CHECK (blocked_on_human IN ('owner','operator') OR blocked_on_human IS NULL), ask TEXT, last_progress_at TEXT, block_gaps TEXT, block_needs TEXT, block_audience TEXT CHECK (block_audience IN ('OWNER', 'SYSTEM')), process_certificate_sha TEXT);
CREATE TABLE task_persona_bundle (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  bundle_json TEXT,
  catalog_version TEXT,
  confirm_state TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_task_persona_bundle_task ON task_persona_bundle(task_id);
CREATE INDEX idx_task_persona_bundle_confirm ON task_persona_bundle(confirm_state);
CREATE TABLE task_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status_from TEXT,
  status_to TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  changed_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  agent_name TEXT
);
CREATE INDEX idx_task_history_task ON task_history(task_id, changed_at DESC);
CREATE INDEX idx_task_history_changed ON task_history(changed_at DESC);
CREATE TABLE planning_questions (
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
CREATE TABLE planning_specs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  spec_markdown TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  locked_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'task')),
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE conversation_participants (
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, agent_id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  sender_agent_id TEXT REFERENCES agents(id),
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'task_update', 'file')),
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE openclaw_sessions (
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
CREATE TABLE task_activities (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id),
  activity_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE task_deliverables (
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
CREATE TABLE task_events (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status  TEXT NOT NULL,
  actor      TEXT,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_events_task_id ON task_events(task_id, created_at);
CREATE TABLE agent_memory_logs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_id, log_date)
);
CREATE TABLE recommendations (
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
CREATE INDEX idx_recommendations_status ON recommendations(status);
CREATE INDEX idx_recommendations_category ON recommendations(category);
CREATE INDEX idx_recommendations_department ON recommendations(department_id);
CREATE TABLE recommendation_outcomes (
  id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  measured_at TEXT DEFAULT (datetime('now')),
  before_score INTEGER NOT NULL,
  after_score INTEGER NOT NULL,
  improvement_pct REAL NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_outcomes_rec ON recommendation_outcomes(recommendation_id);
CREATE INDEX idx_outcomes_measured ON recommendation_outcomes(measured_at DESC);
CREATE TABLE execution_queue (
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
CREATE INDEX idx_execution_queue_status ON execution_queue(status);
CREATE INDEX idx_execution_queue_queued ON execution_queue(queued_at DESC);
CREATE TABLE dept_memory (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  memory_type TEXT NOT NULL CHECK (memory_type IN ('decision', 'context', 'lesson', 'goal', 'constraint')),
  content TEXT NOT NULL,
  created_by TEXT DEFAULT 'system',
  importance INTEGER DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_dept_memory_workspace ON dept_memory(workspace_id);
CREATE INDEX idx_dept_memory_type ON dept_memory(memory_type);
CREATE INDEX idx_dept_memory_importance ON dept_memory(importance DESC);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_agent_id);
CREATE INDEX idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_events_created ON events(created_at DESC);
CREATE INDEX idx_activities_task ON task_activities(task_id, created_at DESC);
CREATE INDEX idx_deliverables_task ON task_deliverables(task_id);
CREATE INDEX idx_openclaw_sessions_task ON openclaw_sessions(task_id);
CREATE INDEX idx_planning_questions_task ON planning_questions(task_id, sort_order);
CREATE INDEX idx_agent_memory_logs_agent ON agent_memory_logs(agent_id, log_date DESC);
CREATE TABLE agent_settings (
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
, "lock" INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_agent_settings_dept ON agent_settings(department_id);
CREATE INDEX idx_agent_settings_role ON agent_settings(role_id);
CREATE UNIQUE INDEX idx_agent_settings_unique ON agent_settings(department_id, role_id, setting_type);
CREATE TABLE sops (
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
, role TEXT, source TEXT, model_pin TEXT);
CREATE INDEX idx_sops_department ON sops(department);
CREATE INDEX idx_sops_slug ON sops(slug);
CREATE INDEX idx_sops_deleted ON sops(deleted_at);
CREATE TABLE task_qc_results (
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
CREATE INDEX idx_qc_results_task ON task_qc_results(task_id, scored_at DESC);
CREATE INDEX idx_qc_results_dept ON task_qc_results(department_slug, scored_at DESC);
CREATE INDEX idx_qc_results_workspace ON task_qc_results(workspace_id, scored_at DESC);
CREATE TABLE lss_control_reviews (
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
CREATE INDEX idx_lss_reviews_period ON lss_control_reviews(period_end DESC);
CREATE TABLE bug_tickets (
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
CREATE INDEX idx_bug_tickets_status ON bug_tickets(status);
CREATE INDEX idx_bug_tickets_workspace ON bug_tickets(workspace_id);
CREATE INDEX idx_bug_tickets_dedup ON bug_tickets(dedup_of);
CREATE TABLE bug_ticket_events (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES bug_tickets(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bug_ticket_events_bug ON bug_ticket_events(bug_id, created_at);
CREATE TABLE _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    );
CREATE TABLE persona_selection_log (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          task_id TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          persona_name TEXT,
          mode TEXT,
          score REAL,
          layer_scores TEXT,
          department_id TEXT,
          selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
CREATE INDEX idx_persona_log_task ON persona_selection_log(task_id);
CREATE INDEX idx_persona_log_dept ON persona_selection_log(department_id);
CREATE INDEX idx_persona_log_persona ON persona_selection_log(persona_id);
CREATE TABLE campaigns (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          name TEXT NOT NULL,
          description TEXT,
          status TEXT DEFAULT 'planning' CHECK(status IN ('planning', 'active', 'review', 'complete', 'archived')),
          department_ids TEXT,
          start_date TEXT,
          target_date TEXT,
          workspace_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
CREATE INDEX idx_tasks_campaign ON tasks(campaign_id);
CREATE INDEX idx_campaign_workspace ON campaigns(workspace_id);
CREATE TABLE persona_performance (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          task_id TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          persona_version INTEGER NOT NULL DEFAULT 1,
          department_id TEXT,
          task_category TEXT,
          mode TEXT,
          score_at_selection REAL,
          owner_rating INTEGER CHECK(owner_rating IN (-1, 0, 1)),
          owner_feedback_note TEXT,
          revision_count INTEGER DEFAULT 0,
          time_to_complete_seconds INTEGER,
          kpi_attribution TEXT,
          completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
CREATE INDEX idx_perf_persona ON persona_performance(persona_id);
CREATE INDEX idx_perf_dept_task ON persona_performance(department_id, task_category);
CREATE INDEX idx_perf_completed ON persona_performance(completed_at);
CREATE TABLE persona_weight_overrides (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          persona_id TEXT NOT NULL,
          department_id TEXT,
          task_category TEXT,
          adjustment_factor REAL NOT NULL,
          reason TEXT,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TEXT
        );
CREATE INDEX idx_override_persona ON persona_weight_overrides(persona_id);
CREATE TABLE persona_assignment (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          department_id TEXT NOT NULL,
          task_category TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          persona_name TEXT,
          persona_mode TEXT,
          persona_version INTEGER DEFAULT 1,
          last_score REAL,
          last_assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          switch_count INTEGER DEFAULT 0,
          UNIQUE (department_id, task_category)
        );
CREATE INDEX idx_assign_dept ON persona_assignment(department_id);
CREATE INDEX idx_assign_persona ON persona_assignment(persona_id);
CREATE TABLE da_challenges (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          task_id TEXT,
          campaign_id TEXT,
          trigger_type TEXT NOT NULL,
          challenge TEXT NOT NULL,
          specific_concern TEXT,
          assumptions TEXT,
          severity TEXT CHECK(severity IN ('low', 'medium', 'high')),
          confidence REAL,
          status TEXT DEFAULT 'open' CHECK(status IN ('open', 'accepted', 'dismissed', 'overridden')),
          dismissal_reason TEXT,
          outcome TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at TEXT
        );
CREATE INDEX idx_da_task ON da_challenges(task_id);
CREATE INDEX idx_da_status ON da_challenges(status);
CREATE INDEX idx_da_severity ON da_challenges(severity);
CREATE TABLE publish_queue (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  topic TEXT NOT NULL,
  platforms TEXT NOT NULL,
  schedule TEXT DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'queued',
  run_id TEXT,
  requested_by TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX idx_publish_queue_status ON publish_queue(status);
CREATE INDEX idx_publish_queue_task ON publish_queue(task_id);
CREATE INDEX idx_publish_queue_created ON publish_queue(created_at DESC);
CREATE TRIGGER trg_tasks_completed_at
        AFTER UPDATE OF status ON tasks
        FOR EACH ROW
        WHEN NEW.status = 'done' AND (OLD.status IS NULL OR OLD.status <> 'done')
        BEGIN
          UPDATE tasks SET completed_at = datetime('now') WHERE id = NEW.id;
        END;
CREATE TABLE model_registry (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model_id TEXT UNIQUE NOT NULL,
          label TEXT NOT NULL,
          provider TEXT NOT NULL,
          family TEXT,
          context_window INTEGER,
          input_cost_per_million REAL,
          output_cost_per_million REAL,
          pricing_model TEXT DEFAULT 'per_token' CHECK (pricing_model IN ('per_token', 'flat_rate_plan', 'free')),
          pricing_source TEXT DEFAULT 'auto',
          capabilities TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'preview', 'unavailable')),
          added_at TEXT DEFAULT (datetime('now')),
          last_seen_at TEXT DEFAULT (datetime('now')),
          raw_metadata TEXT DEFAULT '{}'
        );
CREATE INDEX idx_model_registry_provider ON model_registry(provider);
CREATE INDEX idx_model_registry_status ON model_registry(status);
CREATE TABLE model_registry_refresh_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_at TEXT DEFAULT (datetime('now')),
          provider TEXT NOT NULL,
          success INTEGER NOT NULL,
          models_added INTEGER DEFAULT 0,
          models_updated INTEGER DEFAULT 0,
          models_deprecated INTEGER DEFAULT 0,
          error_message TEXT
        );
CREATE INDEX idx_model_registry_refresh_log_run_at ON model_registry_refresh_log(run_at DESC);
CREATE TABLE cloudflare_access_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          enabled INTEGER NOT NULL DEFAULT 0,
          team_domain TEXT,
          audience TEXT,
          allowed_email_domains TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT DEFAULT (datetime('now'))
        );
CREATE TABLE system_status_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          probed_at TEXT NOT NULL DEFAULT (datetime('now')),
          component TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('live', 'working', 'busy', 'degraded', 'offline', 'unknown', 'ok', 'down')),
          latency_ms INTEGER,
          error TEXT,
          metadata TEXT DEFAULT '{}'
        );
CREATE INDEX idx_system_status_component_probed ON system_status_snapshots(component, probed_at DESC);
CREATE INDEX idx_system_status_probed_at ON system_status_snapshots(probed_at DESC);
CREATE TABLE IF NOT EXISTS "agents" (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              role TEXT NOT NULL,
              description TEXT,
              avatar_emoji TEXT DEFAULT '🤖',
              status TEXT DEFAULT 'standby' CHECK (status IN ('standby', 'working', 'busy', 'degraded', 'offline')),
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
            , persona TEXT, role_type TEXT);
CREATE INDEX idx_agents_status ON agents(status);
CREATE TABLE client_platform (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          platform TEXT NOT NULL CHECK (platform IN ('mac-mini', 'vps-docker')),
          config_path TEXT,
          vault_root TEXT,
          scratch_root TEXT,
          detected_at TEXT DEFAULT (datetime('now'))
        );
CREATE TABLE operator_workspaces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
CREATE INDEX idx_operator_workspaces_agent ON operator_workspaces(agent_id);
CREATE TABLE operator_goals (
          id TEXT PRIMARY KEY,
          category TEXT,
          title TEXT NOT NULL,
          body TEXT,
          completed INTEGER NOT NULL DEFAULT 0,
          completed_at TEXT,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
CREATE INDEX idx_operator_goals_category ON operator_goals(category);
CREATE INDEX idx_operator_goals_completed ON operator_goals(completed);
CREATE TABLE operator_journal_entries (
          id TEXT PRIMARY KEY,
          entry_date TEXT NOT NULL UNIQUE,
          body TEXT NOT NULL DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
CREATE INDEX idx_operator_journal_entry_date ON operator_journal_entries(entry_date DESC);
CREATE TABLE operator_chat_sessions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          title TEXT,
          scratch_dir TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
CREATE INDEX idx_operator_chat_sessions_agent ON operator_chat_sessions(agent_id, updated_at DESC);
CREATE TABLE operator_chat_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES operator_chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
          content TEXT NOT NULL,
          metadata TEXT DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now'))
        );
CREATE INDEX idx_operator_chat_messages_session ON operator_chat_messages(session_id, created_at);
CREATE TABLE provider_credentials (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT UNIQUE NOT NULL,
          api_key_env_var TEXT,
          base_url TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
CREATE TABLE provider_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
          metric TEXT NOT NULL,
          value REAL NOT NULL,
          raw_response TEXT
        );
CREATE INDEX idx_provider_usage_lookup ON provider_usage(provider, metric, snapshot_at DESC);
CREATE TABLE notebooks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          backend TEXT NOT NULL DEFAULT 'notebooklm' CHECK (backend IN ('notebooklm', 'gemini-local')),
          remote_id TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
CREATE INDEX idx_notebooks_updated ON notebooks(updated_at DESC);
CREATE TABLE notebook_sources (
          id TEXT PRIMARY KEY,
          notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL CHECK (source_type IN ('pdf', 'text', 'markdown', 'url', 'audio', 'video')),
          title TEXT,
          path TEXT,
          url TEXT,
          remote_id TEXT,
          byte_size INTEGER,
          created_at TEXT DEFAULT (datetime('now'))
        );
CREATE INDEX idx_notebook_sources_notebook ON notebook_sources(notebook_id);
CREATE TABLE cli_install_registry (
          cli_name TEXT PRIMARY KEY,
          binary_path TEXT,
          version TEXT,
          installed_at TEXT,
          last_verified_at TEXT,
          install_method TEXT
        );
CREATE TABLE research_searches (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          model TEXT NOT NULL,
          result_markdown TEXT NOT NULL,
          search_metadata TEXT DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
CREATE INDEX idx_research_searches_created ON research_searches(created_at DESC);
CREATE TABLE web_agent_sessions (
          id TEXT PRIMARY KEY,
          task TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','running','completed','failed','cancelled')),
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          result_markdown TEXT,
          action_log TEXT DEFAULT '[]',
          screenshots_dir TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
CREATE INDEX idx_web_agent_sessions_created ON web_agent_sessions(created_at DESC);
CREATE INDEX idx_web_agent_sessions_status ON web_agent_sessions(status);
CREATE INDEX idx_tasks_model_id ON tasks(model_id);
CREATE TABLE kpi_snapshots (
          id TEXT PRIMARY KEY,
          department_id TEXT NOT NULL DEFAULT 'company',
          kpi_id TEXT NOT NULL,
          kpi_name TEXT NOT NULL,
          value REAL NOT NULL,
          target REAL,
          unit TEXT NOT NULL DEFAULT 'count',
          snapshot_date TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
CREATE INDEX idx_kpi_snapshots_dept_date ON kpi_snapshots(department_id, snapshot_date);
CREATE INDEX idx_kpi_snapshots_kpi ON kpi_snapshots(kpi_id);
CREATE TABLE clients (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          gateway_url TEXT NOT NULL DEFAULT 'ws://127.0.0.1:18789',
          gateway_token TEXT,
          cf_access_client_id TEXT,
          cf_access_client_secret TEXT,
          workspace_root TEXT,
          ssh_target TEXT,
          interview_complete INTEGER NOT NULL DEFAULT 0,
          is_self INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        , brand_color TEXT, logo_url TEXT, brand_secondary_color TEXT);
CREATE UNIQUE INDEX idx_clients_single_self ON clients(is_self) WHERE is_self = 1;
CREATE INDEX idx_clients_is_self ON clients(is_self);
CREATE INDEX idx_sops_role ON sops(role);
CREATE INDEX idx_sops_source ON sops(source);
CREATE TABLE dispatch_rules (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
          department_slug TEXT NOT NULL,
          task_keywords TEXT,
          sop_id TEXT REFERENCES sops(id) ON DELETE SET NULL,
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          priority INTEGER DEFAULT 5,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
CREATE INDEX idx_dispatch_rules_dept ON dispatch_rules(department_slug);
CREATE INDEX idx_dispatch_rules_sop ON dispatch_rules(sop_id);
CREATE INDEX idx_dispatch_rules_agent ON dispatch_rules(agent_id);
CREATE INDEX idx_tasks_sop_id ON tasks(sop_id);
CREATE TABLE sop_embeddings (
          sop_id         TEXT PRIMARY KEY REFERENCES sops(id) ON DELETE CASCADE,
          embedding      BLOB NOT NULL,
          embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
          embedding_dims  INTEGER NOT NULL DEFAULT 1536,
          embedded_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
CREATE INDEX idx_sop_embeddings_embedded_at ON sop_embeddings(embedded_at);
CREATE INDEX idx_tasks_archived_at ON tasks(archived_at);
CREATE INDEX idx_sop_embeddings_model
           ON sop_embeddings(embedding_model);
CREATE INDEX idx_tasks_sop_authoring ON tasks(sop_authoring_for_task_id);
CREATE TABLE IF NOT EXISTS "sop_proposals" (
          id TEXT PRIMARY KEY,
          proposed_name TEXT NOT NULL,
          proposed_department TEXT,
          draft_steps TEXT NOT NULL,
          based_on_task_ids TEXT NOT NULL,
          evidence_summary TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
            'pending', 'approved', 'rejected',
            'auto-generated-pending-review', 'escalated',
            'auto-authored-filed'
          )),
          created_at TEXT DEFAULT (datetime('now')),
          reviewed_at TEXT,
          reviewed_by TEXT,
          approved_sop_id TEXT REFERENCES sops(id),
          replaces_sop_id TEXT REFERENCES sops(id),
          confidence REAL,
          auto_research_attempts INTEGER DEFAULT 0,
          research_sources TEXT
        );
CREATE INDEX idx_sop_proposals_status ON sop_proposals(status);
CREATE INDEX idx_sop_proposals_created ON sop_proposals(created_at DESC);
CREATE INDEX idx_sop_proposals_replaces ON sop_proposals(replaces_sop_id);
CREATE INDEX idx_tasks_last_progress ON tasks(last_progress_at);
CREATE INDEX idx_tasks_block_audience ON tasks(block_audience) WHERE block_audience IS NOT NULL;
CREATE UNIQUE INDEX idx_tasks_campaign_stage
               ON tasks(campaign_id, stage_slug)
               WHERE campaign_id IS NOT NULL AND stage_slug IS NOT NULL;
CREATE INDEX idx_tasks_stage_slug
               ON tasks(stage_slug) WHERE stage_slug IS NOT NULL;
CREATE INDEX idx_sops_model_pin ON sops(model_pin) WHERE model_pin IS NOT NULL;
CREATE INDEX idx_tasks_next_dispatch_eligible
               ON tasks(next_dispatch_eligible_at) WHERE next_dispatch_eligible_at IS NOT NULL;
CREATE INDEX idx_tasks_process_cert
                 ON tasks(process_certificate_sha) WHERE process_certificate_sha IS NOT NULL;
CREATE TABLE sop_feedback (
          id TEXT PRIMARY KEY,
          sop_id TEXT NOT NULL REFERENCES sops(id) ON DELETE CASCADE,
          task_id TEXT,
          agent_id TEXT,
          rating INTEGER NOT NULL CHECK (rating IN (1, -1, 0)),
          notes TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
CREATE INDEX idx_sop_feedback_sop ON sop_feedback(sop_id, created_at DESC);
CREATE INDEX idx_sop_feedback_task ON sop_feedback(task_id);
CREATE TABLE interview_sessions (
          id TEXT PRIMARY KEY,
          client_id TEXT,
          owner_id TEXT,
          channel TEXT NOT NULL DEFAULT 'web',
          status TEXT NOT NULL DEFAULT 'in_progress',
          phase TEXT,
          last_question_number INTEGER,
          percent INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
CREATE TABLE interview_answers (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          question_number INTEGER,
          phase TEXT,
          question TEXT,
          answer TEXT,
          provenance TEXT,
          asked_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (session_id, question_number)
        );
CREATE INDEX idx_interview_sessions_status ON interview_sessions(status);
CREATE INDEX idx_interview_sessions_client ON interview_sessions(client_id);
CREATE INDEX idx_interview_answers_session ON interview_answers(session_id, question_number);
CREATE TABLE task_subtask_persona (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          task_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          subtask_text TEXT,
          persona_id TEXT,
          persona_name TEXT,
          score REAL,
          department TEXT,
          task_category TEXT,
          slot TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
CREATE INDEX idx_subtask_persona_task ON task_subtask_persona(task_id);

-- _migrations: 87 rows, last applied 090 (091-095 never ran)
INSERT INTO _migrations (id,name,applied_at) VALUES ('001','initial_schema','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('002','add_workspaces','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('003','add_planning_tables','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('004','add_planning_session_columns','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('005','add_agent_model_field','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('006','add_planning_dispatch_error_column','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('007','add_agent_tools_memory_and_daily_logs','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('008','placeholder_for_legacy_gap','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('009','add_effectiveness_tracking','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('010','add_execution_queue','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('011','add_dept_memory','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('012','add_companies_table','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('013','add_agent_settings','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('014','add_workspace_sort_order','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('015','add_specialist_type_to_agents','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('016','add_task_persona_fields','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('017','add_campaigns_and_campaign_id','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('018','add_persona_performance','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('019','add_persona_assignment_and_version','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('020','add_da_challenges','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('021','add_hybrid_task_secondary_persona','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('025','sop_proposals_auto_replace_fields','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('026','add_skill_35_publish_queue','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('027','add_task_completed_at_and_history','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('028','add_workspace_head_agent','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('029','add_agent_settings_lock_protocol','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('030','cleanup_demo_company_row','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('031','add_model_registry','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('032','add_cloudflare_access_config','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('033','add_system_status_snapshots','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('034','expand_agents_status_busy_degraded','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('035','add_client_platform','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('036','add_operator_workspaces','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('037','add_operator_console_tables','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('038','add_provider_credentials_and_usage','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('039','add_agent_settings_lock_flag','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('040','add_notebooks_and_notebook_sources','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('041','add_cli_install_registry','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('042','add_research_searches','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('043','add_web_agent_sessions','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('044','add_task_model_id','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('045','cleanup_persona_log_orphans','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('046','pin_ceo_department_first','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('047','add_kpi_snapshots','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('048','add_clients_tenant_table','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('049','add_client_branding_columns','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('050','add_sops_role_and_source','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('051','canonical_department_slug_migration','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('052','backfill_is_master_master_orchestrator','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('053','backfill_sop_id_on_backlog_tasks','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('054','add_persona_column_and_dispatch_rules','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('055','add_workspace_purpose_for_intelligent_routing','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('056','add_tasks_sop_id','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('057','add_sop_embeddings_table','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('058','add_task_archived_at','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('059','pin_general_task_department_last','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('060','add_role_type_and_seed_qc_agents','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('061','add_tasks_qc_reroute_attempts','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('062','add_clients_brand_secondary_color','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('063','sop_embeddings_model_drift_index','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('064','seed_default_company_sentinel','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('065','seed_research_and_devils_advocate_agents','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('066','add_tasks_sop_authoring_link','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('067','expand_sop_proposals_status_auto_authored','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('068','add_task_qc_results','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('069','add_lss_control_reviews','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('070','task_events_artifact_contract','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('071','add_bug_tickets','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('072','blocked_fields_and_last_progress_at','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('073','block_transparency_fields','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('074','add_tasks_stage_slug_for_ad_campaigns','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('075','intelligent_model_selector','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('076','widen_tasks_status_check_to_10_board_statuses','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('077','add_dispatch_attempt_accounting','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('078','add_block_reason','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('079','ensure_tasks_stage_slug','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('080','add_tasks_process_certificate_sha','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('081','dedupe_canonical_workspaces','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('082','reap_duplicate_open_authoring_tasks','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('083','add_task_persona_fallback','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('084','add_task_redispatch_count','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('085','create_sop_feedback','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('086','remove_demo_seed_rows','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('087','add_interview_sessions','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('088','add_task_subtask_persona','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('089','add_tasks_source_column','2026-07-11 17:49:08');
INSERT INTO _migrations (id,name,applied_at) VALUES ('090','add_persona_blend_bundle','2026-07-11 17:49:08');
