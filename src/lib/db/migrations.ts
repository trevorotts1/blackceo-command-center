/**
 * Database Migrations System
 * 
 * Handles schema changes in a production-safe way:
 * 1. Tracks which migrations have been applied
 * 2. Runs new migrations automatically on startup
 * 3. Never runs the same migration twice
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { seedStarterSOPs } from '../sops-seed';

interface Migration {
  id: string;
  name: string;
  up: (db: Database.Database) => void;
  /**
   * If true (default), the migration runner wraps `up` in a single
   * `db.transaction()`. If false, the runner runs `up` directly and the
   * migration is responsible for its own transaction boundary and any
   * constraint-deferral PRAGMAs.
   *
   * Required for migrations that need to toggle `PRAGMA foreign_keys`
   * around a 12-step rebuild — that pragma is blocked inside an open
   * transaction. (Bug 1, v4.0.2.)
   */
  useOuterTransaction?: boolean;
}

// All migrations in order - NEVER remove or reorder existing migrations
const migrations: Migration[] = [
  {
    id: '001',
    name: 'initial_schema',
    up: (db) => {
      // Core tables - these are created in schema.ts on fresh databases
      // This migration exists to mark the baseline for existing databases
      console.log('[Migration 001] Baseline schema marker');
    }
  },
  {
    id: '002',
    name: 'add_workspaces',
    up: (db) => {
      console.log('[Migration 002] Adding workspaces table and columns...');
      
      // Create workspaces table if not exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT,
          icon TEXT DEFAULT '📁',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
      
      // No default workspace seeded. Workspaces are created by seed-workspaces.py
      // or auto-seed from departments.json.

      // Add workspace_id to tasks if not exists
      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!tasksInfo.some(col => col.name === 'workspace_id')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id)`);
        console.log('[Migration 002] Added workspace_id to tasks');
      }
      
      // Add workspace_id to agents if not exists
      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      if (!agentsInfo.some(col => col.name === 'workspace_id')) {
        db.exec(`ALTER TABLE agents ADD COLUMN workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id)`);
        console.log('[Migration 002] Added workspace_id to agents');
      }
    }
  },
  {
    id: '003',
    name: 'add_planning_tables',
    up: (db) => {
      console.log('[Migration 003] Adding planning tables...');
      
      // Create planning_questions table if not exists
      db.exec(`
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
      `);
      
      // Create planning_specs table if not exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS planning_specs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          spec_markdown TEXT NOT NULL,
          locked_at TEXT NOT NULL,
          locked_by TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
      
      // Create index
      db.exec(`CREATE INDEX IF NOT EXISTS idx_planning_questions_task ON planning_questions(task_id, sort_order)`);
      
      // Note: Task status values have been updated to new 5-column Kanban format
      // 'backlog', 'in_progress', 'review', 'blocked', 'done'
      // Migration for existing databases is handled in migration 008
    }
  },
  {
    id: '004',
    name: 'add_planning_session_columns',
    up: (db) => {
      console.log('[Migration 004] Adding planning session columns to tasks...');

      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];

      // Add planning_session_key column
      if (!tasksInfo.some(col => col.name === 'planning_session_key')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_session_key TEXT`);
        console.log('[Migration 004] Added planning_session_key');
      }

      // Add planning_messages column (stores JSON array of messages)
      if (!tasksInfo.some(col => col.name === 'planning_messages')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_messages TEXT`);
        console.log('[Migration 004] Added planning_messages');
      }

      // Add planning_complete column
      if (!tasksInfo.some(col => col.name === 'planning_complete')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_complete INTEGER DEFAULT 0`);
        console.log('[Migration 004] Added planning_complete');
      }

      // Add planning_spec column (stores final spec JSON)
      if (!tasksInfo.some(col => col.name === 'planning_spec')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_spec TEXT`);
        console.log('[Migration 004] Added planning_spec');
      }

      // Add planning_agents column (stores generated agents JSON)
      if (!tasksInfo.some(col => col.name === 'planning_agents')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_agents TEXT`);
        console.log('[Migration 004] Added planning_agents');
      }
    }
  },
  {
    id: '005',
    name: 'add_agent_model_field',
    up: (db) => {
      console.log('[Migration 005] Adding model field to agents...');

      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];

      // Add model column
      if (!agentsInfo.some(col => col.name === 'model')) {
        db.exec(`ALTER TABLE agents ADD COLUMN model TEXT`);
        console.log('[Migration 005] Added model to agents');
      }
    }
  },
  {
    id: '006',
    name: 'add_planning_dispatch_error_column',
    up: (db) => {
      console.log('[Migration 006] Adding planning_dispatch_error column to tasks...');

      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];

      // Add planning_dispatch_error column
      if (!tasksInfo.some(col => col.name === 'planning_dispatch_error')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_dispatch_error TEXT`);
        console.log('[Migration 006] Added planning_dispatch_error to tasks');
      }
    }
  },
  {
    id: '007',
    name: 'add_agent_tools_memory_and_daily_logs',
    up: (db) => {
      console.log('[Migration 007] Adding tools_md, memory_md to agents; user_md to workspaces; agent_memory_logs table...');

      // Add tools_md to agents
      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      if (!agentsInfo.some(col => col.name === 'tools_md')) {
        db.exec(`ALTER TABLE agents ADD COLUMN tools_md TEXT`);
        console.log('[Migration 007] Added tools_md to agents');
      }

      // Add memory_md to agents
      if (!agentsInfo.some(col => col.name === 'memory_md')) {
        db.exec(`ALTER TABLE agents ADD COLUMN memory_md TEXT`);
        console.log('[Migration 007] Added memory_md to agents');
      }

      // Add user_md to workspaces (shared across all agents in workspace)
      const workspacesInfo = db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
      if (!workspacesInfo.some(col => col.name === 'user_md')) {
        db.exec(`ALTER TABLE workspaces ADD COLUMN user_md TEXT`);
        console.log('[Migration 007] Added user_md to workspaces');
      }

      // Create agent_memory_logs table for daily logs per agent
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_memory_logs (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          log_date TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(agent_id, log_date)
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_memory_logs_agent ON agent_memory_logs(agent_id, log_date DESC)`);
      console.log('[Migration 007] Created agent_memory_logs table');
    }
  },
  {
    id: '008',
    // Placeholder. Historical: an in-progress migration was renumbered or
    // dropped before merge. Filling the slot with a no-op so future strict
    // sequence checks don't trip, and the QC rubric stops warning on the
    // gap. Wave 6 housekeeping (2026-05-19).
    name: 'placeholder_for_legacy_gap',
    up: (db) => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
      ).get();
      if (row) {
        console.log('[Migration 008] no-op placeholder for legacy gap');
      }
    }
  },
  {
    id: '010',
    name: 'add_execution_queue',
    up: (db) => {
      console.log('[Migration 010] Adding execution_queue table...');

      db.exec(`
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
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_execution_queue_status ON execution_queue(status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_execution_queue_queued ON execution_queue(queued_at DESC)`);
      console.log('[Migration 010] Created execution_queue table');
    }
  },
  {
    id: '009',
    name: 'add_effectiveness_tracking',
    up: (db) => {
      console.log('[Migration 009] Adding effectiveness tracking...');

      // Add columns to recommendations if missing
      const recCols = db.prepare("PRAGMA table_info(recommendations)").all() as { name: string }[];
      const colNames = new Set(recCols.map(c => c.name));

      if (!colNames.has('approved_at')) {
        db.exec(`ALTER TABLE recommendations ADD COLUMN approved_at TEXT`);
      }
      if (!colNames.has('effectiveness_score')) {
        db.exec(`ALTER TABLE recommendations ADD COLUMN effectiveness_score INTEGER`);
      }
      if (!colNames.has('measured_at')) {
        db.exec(`ALTER TABLE recommendations ADD COLUMN measured_at TEXT`);
      }
      if (!colNames.has('outcome_notes')) {
        db.exec(`ALTER TABLE recommendations ADD COLUMN outcome_notes TEXT`);
      }

      // Create recommendation_outcomes table
      db.exec(`
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
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_outcomes_rec ON recommendation_outcomes(recommendation_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_outcomes_measured ON recommendation_outcomes(measured_at DESC)`);

      console.log('[Migration 009] Effectiveness tracking columns and outcomes table created');
    }
  },
  {
    id: '011',
    name: 'add_dept_memory',
    up: (db) => {
      console.log('[Migration 011] Adding dept_memory table...');

      db.exec(`
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
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_dept_memory_workspace ON dept_memory(workspace_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_dept_memory_type ON dept_memory(memory_type)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_dept_memory_importance ON dept_memory(importance DESC)`);
      console.log('[Migration 011] Created dept_memory table');
    }
  },
  {
    id: '012',
    name: 'add_companies_table',
    up: (db) => {
      console.log('[Migration 012] Adding companies table and company_id to workspaces...');

      // Create companies table
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug)`);

      // No default company seeded. Client's company is created by seed-workspaces.py
      // from Skill 23 interview answers.

      // Add company_id to workspaces if not exists
      const workspacesInfo = db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
      if (!workspacesInfo.some(col => col.name === 'company_id')) {
        db.exec(`ALTER TABLE workspaces ADD COLUMN company_id TEXT DEFAULT 'default'`);
        console.log('[Migration 012] Added company_id to workspaces');
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_workspaces_company ON workspaces(company_id)`);

      // No seed data. Companies and workspaces are created dynamically
      // from the client's Skill 23 (AI Workforce Blueprint) interview answers.
      // The seed-workspaces.py script reads config/departments.json which
      // Skill 23 generates based on the client's chosen departments.
      console.log('[Migration 012] Schema ready. Workspaces populated by Skill 23 + seed script.');
    }
  },
  {
    id: '013',
    name: 'add_agent_settings',
    up: (db) => {
      console.log('[Migration 013] Adding agent_settings table...');

      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_settings (
          id TEXT PRIMARY KEY,
          department_id TEXT NOT NULL,
          role_id TEXT,
          setting_type TEXT NOT NULL CHECK (setting_type IN ('model', 'persona')),
          value TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_settings_dept ON agent_settings(department_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_settings_role ON agent_settings(role_id)`);

      // Create unique index (check if exists first to be safe)
      try {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_settings_unique ON agent_settings(department_id, role_id, setting_type)`);
      } catch {
        // Index may already exist
      }

      console.log('[Migration 013] Created agent_settings table');
    }
  },
  {
    id: '014',
    name: 'add_workspace_sort_order',
    up: (db) => {
      console.log('[Migration 014] Adding sort_order to workspaces...');

      const workspacesInfo = db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
      if (!workspacesInfo.some(col => col.name === 'sort_order')) {
        db.exec(`ALTER TABLE workspaces ADD COLUMN sort_order INTEGER DEFAULT 1000`);
        console.log('[Migration 014] Added sort_order column');

        // Set sensible default order:
        // CEO = 1, Master Orchestration = 2, BlackCEO Operations = 3
        // Everything else alphabetically starting at 10 (gap for future inserts)
        const workspaces = db.prepare('SELECT id, name, slug FROM workspaces ORDER BY name').all() as { id: string; name: string; slug: string }[];

        let sortOrder = 10;
        for (const ws of workspaces) {
          const lower = ws.name.toLowerCase();
          const slugLower = ws.slug.toLowerCase();
          if (lower === 'ceo' || slugLower === 'ceo') {
            db.prepare('UPDATE workspaces SET sort_order = 1 WHERE id = ?').run(ws.id);
          } else if (lower.includes('master orchestration') || slugLower.includes('master-orchestration')) {
            db.prepare('UPDATE workspaces SET sort_order = 2 WHERE id = ?').run(ws.id);
          } else if (lower.includes('blackceo operations') || slugLower.includes('blackceo-operations') || lower.includes('operations')) {
            db.prepare('UPDATE workspaces SET sort_order = 3 WHERE id = ?').run(ws.id);
          } else {
            db.prepare('UPDATE workspaces SET sort_order = ? WHERE id = ?').run(sortOrder, ws.id);
            sortOrder += 10;
          }
        }

        console.log(`[Migration 014] Set default sort_order for ${workspaces.length} workspaces`);
      } else {
        console.log('[Migration 014] sort_order column already exists, skipping');
      }
    }
  },
  {
    id: '015',
    name: 'add_specialist_type_to_agents',
    up: (db) => {
      console.log('[Migration 015] Adding specialist_type column to agents...');

      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      if (!agentsInfo.some(col => col.name === 'specialist_type')) {
        db.exec(`ALTER TABLE agents ADD COLUMN specialist_type TEXT DEFAULT 'on-call' CHECK (specialist_type IN ('permanent', 'on-call'))`);
        console.log('[Migration 015] Added specialist_type column');

        // Backfill: master agents and department heads (non-default workspace) are permanent.
        // Only dynamically spawned sub-agents should be on-call.
        const result = db.prepare(`
          UPDATE agents SET specialist_type = CASE
            WHEN is_master = 1 THEN 'permanent'
            WHEN workspace_id IS NOT NULL AND workspace_id != '' AND workspace_id != 'default' THEN 'permanent'
            ELSE 'on-call'
          END
        `).run();
        console.log(`[Migration 015] Backfilled specialist_type for ${result.changes} agents`);
      } else {
        console.log('[Migration 015] specialist_type column already exists, skipping');
      }
    }
  },

  // ============================================================
  // v2.1 wave 2 — Zero-Human Company spec migrations
  // ============================================================
  {
    id: '016',
    name: 'add_task_persona_fields',
    up: (db) => {
      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      const columnNames = tasksInfo.map((c) => c.name);
      const adds: Record<string, string> = {
        persona_id: 'TEXT',
        persona_name: 'TEXT',
        persona_mode: 'TEXT',
        persona_score: 'REAL',
        persona_selected_at: 'TEXT',
      };
      for (const [col, type] of Object.entries(adds)) {
        if (!columnNames.includes(col)) {
          db.prepare(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`).run();
        }
      }
      db.prepare(`
        CREATE TABLE IF NOT EXISTS persona_selection_log (
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
        )
      `).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_persona_log_task ON persona_selection_log(task_id)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_persona_log_dept ON persona_selection_log(department_id)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_persona_log_persona ON persona_selection_log(persona_id)`).run();
      console.log('[Migration 016] Persona fields + persona_selection_log table ready');
    }
  },
  {
    id: '017',
    name: 'add_campaigns_and_campaign_id',
    up: (db) => {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS campaigns (
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
        )
      `).run();
      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!tasksInfo.find((c) => c.name === 'campaign_id')) {
        db.prepare(`ALTER TABLE tasks ADD COLUMN campaign_id TEXT REFERENCES campaigns(id)`).run();
      }
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_campaign ON tasks(campaign_id)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_campaign_workspace ON campaigns(workspace_id)`).run();
      console.log('[Migration 017] Campaigns table + tasks.campaign_id ready');
    }
  },
  {
    id: '018',
    name: 'add_persona_performance',
    up: (db) => {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS persona_performance (
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
        )
      `).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_perf_persona ON persona_performance(persona_id)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_perf_dept_task ON persona_performance(department_id, task_category)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_perf_completed ON persona_performance(completed_at)`).run();

      db.prepare(`
        CREATE TABLE IF NOT EXISTS persona_weight_overrides (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          persona_id TEXT NOT NULL,
          department_id TEXT,
          task_category TEXT,
          adjustment_factor REAL NOT NULL,
          reason TEXT,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TEXT
        )
      `).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_override_persona ON persona_weight_overrides(persona_id)`).run();
      console.log('[Migration 018] persona_performance + persona_weight_overrides ready');
    }
  },
  {
    id: '019',
    name: 'add_persona_assignment_and_version',
    up: (db) => {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS persona_assignment (
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
        )
      `).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_assign_dept ON persona_assignment(department_id)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_assign_persona ON persona_assignment(persona_id)`).run();

      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!tasksInfo.find((c) => c.name === 'persona_version')) {
        db.prepare(`ALTER TABLE tasks ADD COLUMN persona_version INTEGER`).run();
      }
      console.log('[Migration 019] persona_assignment + tasks.persona_version ready');
    }
  },
  {
    id: '020',
    name: 'add_da_challenges',
    up: (db) => {
      // Defensive: if a legacy da_challenges table is already present
      // (from an old schema.ts shape) the canonical indexes below would
      // 500 with "no such column: task_id". Migration 024 owns the
      // legacy → canonical reconciliation; here we just no-op and let
      // 024 do the work on the next pass.
      const existing = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='da_challenges'`
      ).get() as { name: string } | undefined;
      if (existing) {
        const cols = db.prepare(`PRAGMA table_info(da_challenges)`).all() as { name: string }[];
        const hasTaskId = cols.some((c) => c.name === 'task_id');
        if (!hasTaskId) {
          console.log('[Migration 020] legacy da_challenges detected — deferring to migration 024');
          return;
        }
      }
      db.prepare(`
        CREATE TABLE IF NOT EXISTS da_challenges (
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
        )
      `).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_da_task ON da_challenges(task_id)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_da_status ON da_challenges(status)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_da_severity ON da_challenges(severity)`).run();
      console.log('[Migration 020] da_challenges table ready');
    }
  },
  {
    id: '021',
    name: 'add_hybrid_task_secondary_persona',
    up: (db) => {
      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      const columnNames = tasksInfo.map((c) => c.name);
      const adds: Record<string, string> = {
        secondary_persona_id: 'TEXT',
        secondary_persona_name: 'TEXT',
        secondary_persona_score: 'REAL',
      };
      for (const [col, type] of Object.entries(adds)) {
        if (!columnNames.includes(col)) {
          db.prepare(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`).run();
        }
      }
      console.log('[Migration 021] Hybrid task secondary persona fields ready');
    }
  },
  {
    id: '026',
    name: 'add_skill_35_publish_queue',
    up: (db) => {
      // Skill 35 publish queue — backs the Marketing "Publish" button.
      // Each row is one publish intent queued from the dashboard; a downstream
      // worker / OpenClaw orchestrator picks it up and runs the 5-phase cycle
      // via 35-social-media-planner/scripts/run-publishing-cycle.sh.
      const sqlCreate = [
        'CREATE TABLE IF NOT EXISTS publish_queue (',
        '  id TEXT PRIMARY KEY,',
        '  task_id TEXT,',
        '  topic TEXT NOT NULL,',
        '  platforms TEXT NOT NULL,',
        '  schedule TEXT DEFAULT \'auto\',',
        '  status TEXT NOT NULL DEFAULT \'queued\',',
        '  run_id TEXT,',
        '  requested_by TEXT,',
        '  error TEXT,',
        '  created_at TEXT DEFAULT (datetime(\'now\')),',
        '  updated_at TEXT DEFAULT (datetime(\'now\')),',
        '  started_at TEXT,',
        '  completed_at TEXT',
        ')',
      ].join('\n');
      db.prepare(sqlCreate).run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_publish_queue_status ON publish_queue(status)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_publish_queue_task ON publish_queue(task_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_publish_queue_created ON publish_queue(created_at DESC)').run();
      console.log('[Migration 026] publish_queue table ready (Skill 35)');
    }
  },
  // ============================================================
  // Track S — Auto-research + auto-replace deleted SOPs
  // ============================================================
  // NOTE: migration 024 is reserved by PR #11 (da_challenges shape
  // reconciliation). Track S takes 025.
  // ============================================================
  // v3.7.0 — Eval v2.0 backlog clearance migrations
  // ============================================================
  {
    id: '027',
    name: 'add_task_completed_at_and_history',
    up: (db) => {
      console.log('[Migration 027] Adding completed_at + task_history...');
      const info = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!info.some((c) => c.name === 'completed_at')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN completed_at TEXT`);
        // Backfill existing 'done' tasks with updated_at as completed_at.
        db.exec(`UPDATE tasks SET completed_at = updated_at WHERE status = 'done' AND completed_at IS NULL`);
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS task_history (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          status_from TEXT,
          status_to TEXT NOT NULL,
          changed_at TEXT NOT NULL DEFAULT (datetime('now')),
          changed_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          agent_name TEXT
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id, changed_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_history_changed ON task_history(changed_at DESC)`);

      // Trigger to set completed_at when status transitions to 'done'.
      db.exec(`DROP TRIGGER IF EXISTS trg_tasks_completed_at`);
      db.exec(`
        CREATE TRIGGER trg_tasks_completed_at
        AFTER UPDATE OF status ON tasks
        FOR EACH ROW
        WHEN NEW.status = 'done' AND (OLD.status IS NULL OR OLD.status <> 'done')
        BEGIN
          UPDATE tasks SET completed_at = datetime('now') WHERE id = NEW.id;
        END;
      `);

      console.log('[Migration 027] completed_at + task_history ready');
    }
  },
  {
    id: '028',
    name: 'add_workspace_head_agent',
    up: (db) => {
      console.log('[Migration 028] Adding head_agent_id to workspaces...');
      const info = db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
      if (!info.some((c) => c.name === 'head_agent_id')) {
        db.exec(`ALTER TABLE workspaces ADD COLUMN head_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL`);
      }

      const wsRows = db.prepare(
        "SELECT id FROM workspaces WHERE head_agent_id IS NULL OR head_agent_id = ''"
      ).all() as { id: string }[];
      const updateHead = db.prepare('UPDATE workspaces SET head_agent_id = ? WHERE id = ?');
      for (const ws of wsRows) {
        const firstAgent = db.prepare(
          'SELECT id FROM agents WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1'
        ).get(ws.id) as { id: string } | undefined;
        if (firstAgent) {
          updateHead.run(firstAgent.id, ws.id);
        }
      }
      console.log('[Migration 028] head_agent_id added + backfilled');
    }
  },
  {
    id: '029',
    name: 'add_agent_settings_lock_protocol',
    up: (db) => {
      console.log('[Migration 029] Adding model lock protocol columns to agent_settings...');
      const info = db.prepare("PRAGMA table_info(agent_settings)").all() as { name: string }[];
      const cols = new Set(info.map((c) => c.name));
      if (!cols.has('locked_by')) {
        db.exec(`ALTER TABLE agent_settings ADD COLUMN locked_by TEXT`);
      }
      if (!cols.has('lock_reason')) {
        db.exec(`ALTER TABLE agent_settings ADD COLUMN lock_reason TEXT`);
      }
      if (!cols.has('locked_at')) {
        db.exec(`ALTER TABLE agent_settings ADD COLUMN locked_at TEXT`);
      }
      if (!cols.has('lock_token')) {
        db.exec(`ALTER TABLE agent_settings ADD COLUMN lock_token TEXT`);
      }
      console.log('[Migration 029] agent_settings lock protocol ready');
    }
  },
  {
    id: '030',
    name: 'cleanup_demo_company_row',
    up: (db) => {
      console.log('[Migration 030] Cleaning up stray placeholder company row...');
      try {
        const realCount = db.prepare(
          "SELECT COUNT(*) as c FROM companies WHERE slug NOT IN ('default','command-center') AND slug NOT LIKE 'acme-%'"
        ).get() as { c: number };
        if (realCount.c > 0) {
          const result = db.prepare(
            "DELETE FROM companies WHERE slug IN ('default','command-center') OR name = 'Command Center'"
          ).run();
          console.log(`[Migration 030] Removed ${result.changes} placeholder company row(s)`);
        } else {
          console.log('[Migration 030] No real company yet, leaving placeholder in place');
        }
      } catch (e) {
        console.log('[Migration 030] Skipped:', (e as Error).message);
      }
    }
  },
  {
    id: '025',
    name: 'sop_proposals_auto_replace_fields',
    up: (db) => {
      console.log('[Migration 025] Adding auto-replace fields to sop_proposals...');

      // Defensive: on a truly fresh install the sop_proposals table may not
      // exist yet (its CREATE was historically in a migration that pre-dates
      // the locally-tracked 022/023/024 slots — those numbers are reserved
      // in the comments above but not present in this file). Create the
      // canonical shape lazily so this migration succeeds on a brand-new DB.
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sop_proposals'"
      ).get();
      if (!tableExists) {
        db.exec(`
          CREATE TABLE sop_proposals (
            id TEXT PRIMARY KEY,
            proposed_name TEXT NOT NULL,
            proposed_department TEXT,
            draft_steps TEXT NOT NULL,
            based_on_task_ids TEXT NOT NULL,
            evidence_summary TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'auto-generated-pending-review', 'escalated')),
            created_at TEXT DEFAULT (datetime('now')),
            reviewed_at TEXT,
            reviewed_by TEXT,
            approved_sop_id TEXT REFERENCES sops(id),
            replaces_sop_id TEXT REFERENCES sops(id),
            confidence REAL,
            auto_research_attempts INTEGER DEFAULT 0,
            research_sources TEXT
          );
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sop_proposals_status ON sop_proposals(status)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sop_proposals_created ON sop_proposals(created_at DESC)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sop_proposals_replaces ON sop_proposals(replaces_sop_id)`);
        console.log('[Migration 025] sop_proposals table created from scratch (fresh-install path)');
        return;
      }

      const info = db.prepare("PRAGMA table_info(sop_proposals)").all() as { name: string }[];
      const cols = new Set(info.map((c) => c.name));

      if (!cols.has('replaces_sop_id')) {
        db.exec(`ALTER TABLE sop_proposals ADD COLUMN replaces_sop_id TEXT REFERENCES sops(id)`);
      }
      if (!cols.has('confidence')) {
        db.exec(`ALTER TABLE sop_proposals ADD COLUMN confidence REAL`);
      }
      if (!cols.has('auto_research_attempts')) {
        db.exec(`ALTER TABLE sop_proposals ADD COLUMN auto_research_attempts INTEGER DEFAULT 0`);
      }
      if (!cols.has('research_sources')) {
        db.exec(`ALTER TABLE sop_proposals ADD COLUMN research_sources TEXT`);
      }

      // Expand the status CHECK to include the auto-research statuses.
      // SQLite cannot ALTER ... DROP CONSTRAINT — rebuild the table when the
      // legacy CHECK is still in place.
      const tableSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sop_proposals'").get() as { sql: string } | undefined
      )?.sql || '';
      const hasLegacyCheck = tableSql.includes("CHECK (status IN ('pending', 'approved', 'rejected'))");
      if (hasLegacyCheck) {
        db.exec(`
          CREATE TABLE sop_proposals_new (
            id TEXT PRIMARY KEY,
            proposed_name TEXT NOT NULL,
            proposed_department TEXT,
            draft_steps TEXT NOT NULL,
            based_on_task_ids TEXT NOT NULL,
            evidence_summary TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'auto-generated-pending-review', 'escalated')),
            created_at TEXT DEFAULT (datetime('now')),
            reviewed_at TEXT,
            reviewed_by TEXT,
            approved_sop_id TEXT REFERENCES sops(id),
            replaces_sop_id TEXT REFERENCES sops(id),
            confidence REAL,
            auto_research_attempts INTEGER DEFAULT 0,
            research_sources TEXT
          );
        `);
        db.exec(`
          INSERT INTO sop_proposals_new
            (id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
             evidence_summary, status, created_at, reviewed_at, reviewed_by, approved_sop_id,
             replaces_sop_id, confidence, auto_research_attempts, research_sources)
          SELECT id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
                 evidence_summary, status, created_at, reviewed_at, reviewed_by, approved_sop_id,
                 replaces_sop_id, confidence,
                 COALESCE(auto_research_attempts, 0), research_sources
          FROM sop_proposals;
        `);
        db.exec(`DROP TABLE sop_proposals;`);
        db.exec(`ALTER TABLE sop_proposals_new RENAME TO sop_proposals;`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sop_proposals_status ON sop_proposals(status)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sop_proposals_created ON sop_proposals(created_at DESC)`);
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_sop_proposals_replaces ON sop_proposals(replaces_sop_id)`);

      console.log('[Migration 025] sop_proposals auto-replace fields ready');
    }
  },
  {
    id: '031',
    name: 'add_model_registry',
    up: (db) => {
      console.log('[Migration 031] Adding model_registry table for the dynamic model catalog...');
      // PRD Section 5.1 schema. Replaces the hardcoded AVAILABLE_MODELS array.
      // Provider connectors populate this table on the weekly refresh job.
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_registry (
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_model_registry_provider ON model_registry(provider)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_model_registry_status ON model_registry(status)`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS model_registry_refresh_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_at TEXT DEFAULT (datetime('now')),
          provider TEXT NOT NULL,
          success INTEGER NOT NULL,
          models_added INTEGER DEFAULT 0,
          models_updated INTEGER DEFAULT 0,
          models_deprecated INTEGER DEFAULT 0,
          error_message TEXT
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_model_registry_refresh_log_run_at ON model_registry_refresh_log(run_at DESC)`);

      console.log('[Migration 031] model_registry + model_registry_refresh_log ready');
    }
  },
  {
    id: '032',
    name: 'add_cloudflare_access_config',
    up: (db) => {
      console.log('[Migration 032] Adding cloudflare_access_config table...');
      // Tracks per-deployment Cloudflare Access settings. allowed_email_domains
      // is a JSON array of strings (for example, ["acme.com", "example.org"]).
      db.exec(`
        CREATE TABLE IF NOT EXISTS cloudflare_access_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          enabled INTEGER NOT NULL DEFAULT 0,
          team_domain TEXT,
          audience TEXT,
          allowed_email_domains TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
      console.log('[Migration 032] cloudflare_access_config ready');
    }
  },
  {
    id: '033',
    name: 'add_system_status_snapshots',
    up: (db) => {
      console.log('[Migration 033] Adding system_status_snapshots time-series table...');
      // PRD Section 3.12. Time-series probe results for the System Status Panel.
      // status accepts both the new six-state vocabulary (live/working/busy/
      // degraded/offline/unknown) and the simpler ok/down tokens listed in the
      // brief for backward compatibility with simpler probes.
      db.exec(`
        CREATE TABLE IF NOT EXISTS system_status_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          probed_at TEXT NOT NULL DEFAULT (datetime('now')),
          component TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('live', 'working', 'busy', 'degraded', 'offline', 'unknown', 'ok', 'down')),
          latency_ms INTEGER,
          error TEXT,
          metadata TEXT DEFAULT '{}'
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_system_status_component_probed ON system_status_snapshots(component, probed_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_system_status_probed_at ON system_status_snapshots(probed_at DESC)`);
      console.log('[Migration 033] system_status_snapshots ready');
    }
  },
  {
    id: '034',
    name: 'expand_agents_status_busy_degraded',
    // Bug 1 (v4.0.2): own the transaction boundary so we can toggle
    // PRAGMA foreign_keys (blocked inside an open transaction). The
    // previous defer_foreign_keys approach was silently overridden by the
    // runner's wrapper transaction, producing FOREIGN KEY constraint
    // failed at COMMIT even when foreign_key_check returned clean.
    useOuterTransaction: false,
    up: (db) => {
      console.log('[Migration 034] Expanding agents.status CHECK to include busy and degraded...');
      // SQLite cannot ALTER a CHECK constraint in place. Rebuild via the
      // official 12-step procedure (https://sqlite.org/lang_altertable.html).
      // FK references from the 9 dependent tables (workspaces.head_agent_id,
      // tasks.assigned_agent_id, tasks.created_by_agent_id,
      // task_history.changed_by_agent_id, agent_activity, sub_agent_sessions
      // and agent_messages, kpi_snapshots.agent_id, recommendations,
      // agent_daily_logs) resolve by table name in SQLite, so dropping the old
      // table and renaming the new one to agents keeps them valid.
      const tableSqlRow = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'"
      ).get() as { sql: string } | undefined;
      const currentSql = tableSqlRow?.sql || '';
      if (currentSql.includes("'busy'") && currentSql.includes("'degraded'")) {
        console.log('[Migration 034] agents.status already includes busy and degraded, nothing to do');
        return;
      }

      // Step 1: capture prior FK enforcement so we can restore it.
      const fkPriorRow = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
      const fkWasOn = fkPriorRow?.foreign_keys === 1;

      // Step 2: turn FK enforcement OFF (must be outside any open txn).
      db.exec('PRAGMA foreign_keys = OFF');

      try {
        // Snapshot the column list so we copy whatever the live table actually
        // has, in case later migrations added columns we cannot predict here.
        const cols = (db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map(c => c.name);
        const colList = cols.join(', ');

        // Run the rebuild inside an explicit transaction so it is atomic.
        const rebuild = db.transaction(() => {
          db.exec(`
            CREATE TABLE agents_new (
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
            );
          `);

          db.exec(`INSERT INTO agents_new (${colList}) SELECT ${colList} FROM agents;`);
          db.exec('DROP TABLE agents;');
          db.exec('ALTER TABLE agents_new RENAME TO agents;');
          db.exec('CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status)');
        });
        rebuild();

        // Step 3: verify FK integrity AFTER the rebuild, before turning FKs back on.
        const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
        if (violations.length > 0) {
          throw new Error(`[Migration 034] foreign_key_check returned ${violations.length} violation(s) after rebuild`);
        }
      } finally {
        // Step 4: restore FK enforcement (always, even on failure).
        if (fkWasOn) {
          db.exec('PRAGMA foreign_keys = ON');
        }
      }

      console.log('[Migration 034] agents.status now accepts standby, working, busy, degraded, offline');
    }
  },
  {
    id: '035',
    name: 'add_client_platform',
    up: (db) => {
      console.log('[Migration 035] Adding client_platform single-row config table...');
      // One row (id=1) describing the deployment target. Written by the
      // platform detector on first boot. Reading the DB is the canonical way
      // for code paths that should not re-run filesystem detection on every
      // request.
      db.exec(`
        CREATE TABLE IF NOT EXISTS client_platform (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          platform TEXT NOT NULL CHECK (platform IN ('mac-mini', 'vps-docker')),
          config_path TEXT,
          vault_root TEXT,
          scratch_root TEXT,
          detected_at TEXT DEFAULT (datetime('now'))
        );
      `);
      console.log('[Migration 035] client_platform ready');
    }
  },
  {
    id: '036',
    name: 'add_operator_workspaces',
    up: (db) => {
      console.log('[Migration 036] Adding operator_workspaces table...');
      // Per-agent scratch directory registry for the Bridge sub-module.
      // agent_id is the CLI agent slug (claude, codex, antigravity, hermes,
      // gemini, fcc, openclaw), not a workforce agent. No FK to agents table.
      db.exec(`
        CREATE TABLE IF NOT EXISTS operator_workspaces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_operator_workspaces_agent ON operator_workspaces(agent_id)`);
      console.log('[Migration 036] operator_workspaces ready');
    }
  },
  {
    id: '037',
    name: 'add_operator_console_tables',
    up: (db) => {
      console.log('[Migration 037] Adding operator_goals, operator_journal_entries, operator_chat_sessions, operator_chat_messages...');
      // Four tables backing the Operator Console sub-modules (PRD Section 4.7).
      // operator_goals is the DB-canonical store; the markdown file at
      // [vault]/goals.md (or per-category subfiles) is a human-editable mirror.
      db.exec(`
        CREATE TABLE IF NOT EXISTS operator_goals (
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_operator_goals_category ON operator_goals(category)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_operator_goals_completed ON operator_goals(completed)`);

      // One journal row per day. Mirrored to [vault]/journal/YYYY/MM/YYYY-MM-DD.md.
      db.exec(`
        CREATE TABLE IF NOT EXISTS operator_journal_entries (
          id TEXT PRIMARY KEY,
          entry_date TEXT NOT NULL UNIQUE,
          body TEXT NOT NULL DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_operator_journal_entry_date ON operator_journal_entries(entry_date DESC)`);

      // Bridge chat sessions plus their messages. PRD says one session per
      // (agent, day, topic) by convention; the runner is responsible for
      // picking or creating. No DB constraint enforces uniqueness because the
      // operator may want multiple parallel topics with the same agent.
      db.exec(`
        CREATE TABLE IF NOT EXISTS operator_chat_sessions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          title TEXT,
          scratch_dir TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_operator_chat_sessions_agent ON operator_chat_sessions(agent_id, updated_at DESC)`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS operator_chat_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES operator_chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
          content TEXT NOT NULL,
          metadata TEXT DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_operator_chat_messages_session ON operator_chat_messages(session_id, created_at)`);

      console.log('[Migration 037] operator console tables ready');
    }
  },
  {
    id: '038',
    name: 'add_provider_credentials_and_usage',
    up: (db) => {
      console.log('[Migration 038] Adding provider_credentials and provider_usage tables...');
      // PRD Section 5.1. api_key_env_var names the env var to read at runtime.
      // We deliberately do NOT persist the key itself in the DB. base_url lets
      // self-hosted or proxied providers override the default endpoint.
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_credentials (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT UNIQUE NOT NULL,
          api_key_env_var TEXT,
          base_url TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
          metric TEXT NOT NULL,
          value REAL NOT NULL,
          raw_response TEXT
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_provider_usage_lookup ON provider_usage(provider, metric, snapshot_at DESC)`);

      console.log('[Migration 038] provider_credentials + provider_usage ready');
    }
  },
  {
    id: '039',
    name: 'add_agent_settings_lock_flag',
    up: (db) => {
      console.log('[Migration 039] Adding lock flag column to agent_settings...');
      // Migration 029 already added the full lock protocol (locked_by,
      // lock_reason, locked_at, lock_token). This migration adds the simple
      // boolean lock flag requested in the Depth 0 brief so callers can SELECT
      // lock without parsing the protocol columns. Both stay: lock is the
      // simple flag, the protocol columns carry the audit trail.
      const info = db.prepare("PRAGMA table_info(agent_settings)").all() as { name: string }[];
      const cols = new Set(info.map(c => c.name));
      if (!cols.has('lock')) {
        db.exec(`ALTER TABLE agent_settings ADD COLUMN "lock" INTEGER NOT NULL DEFAULT 0`);
        // Backfill from the protocol: if lock_token or locked_by is set, the
        // row is currently locked.
        if (cols.has('lock_token') || cols.has('locked_by')) {
          db.exec(`
            UPDATE agent_settings
            SET "lock" = 1
            WHERE (lock_token IS NOT NULL AND lock_token <> '')
               OR (locked_by IS NOT NULL AND locked_by <> '')
          `);
        }
      }
      console.log('[Migration 039] agent_settings.lock ready');
    }
  },
  {
    id: '040',
    name: 'add_notebooks_and_notebook_sources',
    up: (db) => {
      console.log('[Migration 040] Adding notebooks and notebook_sources tables...');
      // PRD Section 4.6. Backs the Notebook sub-module (NotebookLM client).
      // backend selects between Google NotebookLM (default) and the
      // Gemini-CLI-driven local fallback when NotebookLM credentials are
      // missing.
      db.exec(`
        CREATE TABLE IF NOT EXISTS notebooks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          backend TEXT NOT NULL DEFAULT 'notebooklm' CHECK (backend IN ('notebooklm', 'gemini-local')),
          remote_id TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_notebooks_updated ON notebooks(updated_at DESC)`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS notebook_sources (
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_notebook_sources_notebook ON notebook_sources(notebook_id)`);

      console.log('[Migration 040] notebooks + notebook_sources ready');
    }
  },
  {
    id: '041',
    name: 'add_cli_install_registry',
    up: (db) => {
      console.log('[Migration 041] Adding cli_install_registry table...');
      // PRD Section 6.4. Tracks the install state of each operator CLI on this
      // deployment. The bootstrap script writes here on success; runtime
      // probes and the System Status Panel read it as the source of truth for
      // CLI paths.
      db.exec(`
        CREATE TABLE IF NOT EXISTS cli_install_registry (
          cli_name TEXT PRIMARY KEY,
          binary_path TEXT,
          version TEXT,
          installed_at TEXT,
          last_verified_at TEXT,
          install_method TEXT
        );
      `);
      console.log('[Migration 041] cli_install_registry ready');
    }
  },
  {
    id: '042',
    name: 'add_research_searches',
    up: (db) => {
      console.log('[Migration 042] Adding research_searches table (Track B7 Research sub-module)...');
      // SCOPE-ADDITION Section 5.3. Backs the Operator Console Research sub-module
      // (xAI Grok Live Search). result_markdown holds the full grounded answer;
      // search_metadata is a JSON blob (depth, token counts, source urls, etc).
      // The same markdown is mirrored to vault/research/YYYY/MM/YYYY-MM-DD-<slug>.md
      // by the route handler so it shows up in Memory search (Track B6) and the
      // All Searches bucket (Addition 2 / Track B3).
      db.exec(`
        CREATE TABLE IF NOT EXISTS research_searches (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          model TEXT NOT NULL,
          result_markdown TEXT NOT NULL,
          search_metadata TEXT DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_research_searches_created ON research_searches(created_at DESC)`);
      console.log('[Migration 042] research_searches ready');
    }
  },
  {
    id: '043',
    name: 'add_web_agent_sessions',
    up: (db) => {
      console.log('[Migration 043] Adding web_agent_sessions table (Track B9 Web Agent sub-module)...');
      // SCOPE-ADDITION Section 7.4. Backs the Operator Console Web Agent
      // sub-module (Anthropic Computer Use + Playwright). result_markdown
      // holds the final task report; action_log is a JSON array of the
      // tool-call timeline the agent executed (click, type, screenshot,
      // navigate). The same markdown is mirrored to
      // vault/web-agent/YYYY/MM/YYYY-MM-DD-<slug>.md by the route handler
      // so it shows up in Memory search (Track B6) and the All Searches
      // bucket (Addition 2 / Track B3). screenshots_dir is the on-disk
      // location of the per-session PNG stream used by the live SSE view
      // and any post-hoc audit.
      db.exec(`
        CREATE TABLE IF NOT EXISTS web_agent_sessions (
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_web_agent_sessions_created ON web_agent_sessions(created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_web_agent_sessions_status ON web_agent_sessions(status)`);
      console.log('[Migration 043] web_agent_sessions ready');
    }
  },
  {
    id: '044',
    name: 'add_task_model_id',
    up: (db) => {
      console.log('[Migration 044] Adding model_id column to tasks (v4.0.1 P0-7)...');
      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!tasksInfo.some((c) => c.name === 'model_id')) {
        // Note: SQLite cannot ALTER ADD COLUMN with a FK constraint on an
        // existing table, so we add the column unconstrained. The intent is
        // that model_id references model_registry(model_id); we enforce that
        // at the application layer (dispatch route writes a model_id that
        // was just resolved from model_registry).
        db.exec(`ALTER TABLE tasks ADD COLUMN model_id TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_model_id ON tasks(model_id)`);
        console.log('[Migration 044] Added model_id to tasks');
      } else {
        console.log('[Migration 044] model_id already present, skipping');
      }
    }
  },
  {
    id: '045',
    name: 'cleanup_persona_log_orphans',
    up: (db) => {
      // Bug 3 cleanup (v4.0.2): deletes orphan rows in persona_selection_log
      // whose task_id is null/empty/sentinel/no-longer-exists. These rows
      // were the trigger for the migration-034 FK breakage on the Evelyn
      // canary deploy.
      console.log('[Migration 045] Cleaning persona_selection_log orphans...');
      const info = db.prepare(`SELECT COUNT(*) as c FROM persona_selection_log`).get() as { c: number } | undefined;
      if (!info || info.c === 0) {
        console.log('[Migration 045] persona_selection_log is empty, nothing to clean');
        return;
      }
      const result = db.prepare(`
        DELETE FROM persona_selection_log
        WHERE task_id IS NULL
           OR task_id = ''
           OR task_id = '(no-task-id)'
           OR task_id NOT IN (SELECT id FROM tasks)
      `).run();
      console.log(`[Migration 045] Deleted ${result.changes} orphan rows from persona_selection_log`);
    }
  },
  {
    id: '046',
    name: 'pin_ceo_department_first',
    up: (db) => {
      // Durable "CEO is department #1" guarantee. Migration 014 pinned CEO=1 at
      // column-add time, but only ran once and only when the row already
      // existed; an auto-seeded or later-created CEO row could land elsewhere.
      // This idempotent re-pin sets the CEO workspace to sort_order = 0 (below
      // 014's CEO=1) so it sorts above everything regardless of prior data.
      //
      // Keys on slug='ceo' (the stable ordering key) OR a case-insensitive
      // name match (POST /api/workspaces auto-generates slug from name, so a
      // CEO row created through the API carries slug 'ceo' anyway; the name
      // fallback covers rows seeded before this convention). Safe to re-run.
      console.log('[Migration 046] Pinning CEO department to sort_order = 0...');
      try {
        const result = db
          .prepare(
            `UPDATE workspaces
                SET sort_order = 0
              WHERE lower(slug) = 'ceo'
                 OR lower(name) = 'ceo'`
          )
          .run();
        console.log(`[Migration 046] Re-pinned ${result.changes} CEO workspace row(s) to sort_order = 0`);
      } catch (e) {
        // Universal-template installs may have no CEO row yet — non-fatal.
        console.log('[Migration 046] Skipped:', (e as Error).message);
      }
    }
  },
  {
    id: '047',
    name: 'add_kpi_snapshots',
    up: (db) => {
      // Fleet-wide latent bug fix: the kpi_snapshots table is consumed by three
      // code paths — GET/POST /api/kpi-snapshots, GET /api/kpi-history, and the
      // seed-kpi-history.ts seeder — but no migration ever created it and
      // schema.ts does not define it. Every deployment therefore threw
      // "no such table: kpi_snapshots" the moment a KPI page was touched.
      //
      // Columns are derived directly from the consumers (the source of truth):
      //   - SELECT lists in kpi-snapshots/route.ts (GET) + kpi-history/route.ts:
      //       id, department_id, kpi_id, kpi_name, value, target, unit,
      //       snapshot_date, created_at
      //   - INSERT in kpi-snapshots/route.ts (POST) + seed-kpi-history.ts:
      //       id, department_id, kpi_id, kpi_name, value, target, unit,
      //       snapshot_date   (created_at defaulted)
      // POST defaults unit to 'count' and department_id to 'company'; target is
      // nullable (POST passes `target ?? null`); value is always a number.
      //
      // CREATE TABLE IF NOT EXISTS so boxes whose live DB already has the table
      // (e.g. a hand-repaired install) are untouched — this migration only
      // self-heals the boxes that are missing it.
      console.log('[Migration 047] Creating kpi_snapshots table (fleet-wide latent-bug fix)...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS kpi_snapshots (
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_dept_date ON kpi_snapshots(department_id, snapshot_date)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_kpi ON kpi_snapshots(kpi_id)`);
      console.log('[Migration 047] kpi_snapshots table ready');
    }
  },
  {
    id: '048',
    name: 'add_clients_tenant_table',
    up: (db) => {
      // SINGLE-TENANT → PER-CLIENT foundation.
      //
      // Root cause this fixes: the Command Center previously read its OWN host
      // for every OpenClaw / key / memory / analytics call and had no concept
      // of a "selected client". This table is the tenant registry: one row per
      // managed box (the operator's own local box + every remote client Mac/VPS
      // reached over a Cloudflare Access tunnel).
      //
      // Connection fields:
      //   - gateway_url           wss://... (remote) or ws://127.0.0.1:18789 (self)
      //   - gateway_token         OpenClaw gateway token for that box
      //   - cf_access_client_id / cf_access_client_secret
      //                           Cloudflare Access service-token header pair,
      //                           sent as CF-Access-Client-Id / -Secret on the
      //                           WS upgrade for remote clients. NULL for self.
      //   - workspace_root        absolute FS root on that box (used by
      //                           resolveClientPath; local for self, remote
      //                           descriptor path for clients reached over ssh)
      //   - ssh_target            user@host (or ssh config alias) for tunneled
      //                           filesystem reads on remote clients.
      //   - interview_complete    per-client AI Workforce interview flag (E3).
      //   - is_self               1 for exactly one row — the operator's own box.
      //
      // NOTE: secrets (gateway_token, cf_access_client_secret) live in this
      // local SQLite the same way provider keys are referenced elsewhere; they
      // are never sent to the browser (the API routes strip them — see
      // src/lib/clients.ts toPublicClient()).
      console.log('[Migration 048] Adding clients tenant table + seeding the self row...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS clients (
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
        );
      `);
      // At most one self row. Partial unique index keeps the invariant without
      // blocking multiple remote (is_self=0) clients.
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_single_self ON clients(is_self) WHERE is_self = 1`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_clients_is_self ON clients(is_self)`);

      // Seed the operator's own local box as the self row. Idempotent: only
      // inserts when no self row exists yet. gateway_url/token mirror the
      // historical loopback defaults the OpenClaw client used.
      const existingSelf = db
        .prepare('SELECT id FROM clients WHERE is_self = 1 LIMIT 1')
        .get() as { id: string } | undefined;
      if (!existingSelf) {
        db.prepare(`
          INSERT INTO clients
            (id, name, gateway_url, gateway_token, workspace_root, is_self, interview_complete)
          VALUES (?, ?, ?, ?, ?, 1, 0)
        `).run(
          'self',
          'This Box (Operator)',
          'ws://127.0.0.1:18789',
          process.env.OPENCLAW_GATEWAY_TOKEN || null,
          null
        );
        console.log('[Migration 048] Seeded self client row');
      } else {
        console.log('[Migration 048] Self client row already present, skipping seed');
      }
      console.log('[Migration 048] clients tenant table ready');
    }
  },
  {
    id: '049',
    name: 'add_client_branding_columns',
    up: (db) => {
      // PER-CLIENT BRANDING (D1–D3).
      //
      // Adds two nullable columns to the clients tenant table so each managed
      // box carries its OWN brand identity instead of inheriting the hardcoded
      // BlackCEO green / logo:
      //
      //   - brand_color   the client's PRIMARY brand color as a #RRGGBB hex.
      //                   Collected in the AI Workforce interview (D1): the
      //                   client gives a hex if they know it, otherwise a color
      //                   NAME which is resolved to hex automatically (see
      //                   src/lib/branding.ts resolveBrandColor). NULL → the UI
      //                   falls back to BlackCEO green (#43A047). The full
      //                   complementary/analogous palette is DERIVED from this
      //                   single primary at render time (D2) — we store only the
      //                   primary so re-theming logic stays in one place.
      //   - logo_url      a public URL to the client's logo (D3). When set, the
      //                   Header swaps the BlackCEO logo for the client's. The
      //                   logo-upload route mirrors this into the client's
      //                   GoHighLevel media library and writes back the hosted
      //                   storage.googleapis.com/msgsndr URL it returns.
      //
      // Additive + idempotent: NULL defaults preserve the v4.2.0 look for every
      // existing row (self + remote) until a brand is set. Never edits 048.
      console.log('[Migration 049] Adding brand_color + logo_url columns to clients...');

      const cols = (db.prepare(`PRAGMA table_info(clients)`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (!cols.includes('brand_color')) {
        db.exec(`ALTER TABLE clients ADD COLUMN brand_color TEXT`);
        console.log('[Migration 049] Added clients.brand_color');
      } else {
        console.log('[Migration 049] clients.brand_color already present, skipping');
      }
      if (!cols.includes('logo_url')) {
        db.exec(`ALTER TABLE clients ADD COLUMN logo_url TEXT`);
        console.log('[Migration 049] Added clients.logo_url');
      } else {
        console.log('[Migration 049] clients.logo_url already present, skipping');
      }
      console.log('[Migration 049] client branding columns ready');
    }
  },
  {
    id: '050',
    name: 'add_sops_role_and_source',
    up: (db) => {
      // ROLE-LIBRARY BRIDGE.
      //
      // The Command Center `sops` table was department-keyed only (the 23
      // starter SOPs in sops-seed.ts each carry a `department` but no role),
      // while the Skill-23 on-disk library lives at
      //   departments/<dept>/<NN-role>/how-to.md
      // i.e. it IS role-resolved. Those two SOP layers shared no key, so the
      // rich per-role how-to.md docs the agents actually run never appeared on
      // the CC SOP board (audit gap SOP-1 / SOP-2).
      //
      // This adds the two columns the importer (/api/sops/import-role-library)
      // needs to mirror the on-disk library into the DB without colliding with
      // the department-keyed starter SOPs:
      //   - role     the role-folder slug a SOP belongs to (NULL for the
      //              department-level starter SOPs). Lets multiple role-specific
      //              SOPs coexist in one department.
      //   - source   provenance: 'role-library' for imported on-disk how-to.md
      //              docs, NULL for hand-authored / starter / learning-loop
      //              SOPs. The importer ONLY ever upserts/replaces rows where
      //              source='role-library', so user-authored SOPs are never
      //              touched or deleted.
      //
      // Additive + idempotent: NULL defaults preserve every existing row's
      // behavior (department matching in scoreSOPForTask is unchanged).
      console.log('[Migration 050] Adding role + source columns to sops...');

      const cols = (db.prepare(`PRAGMA table_info(sops)`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (!cols.includes('role')) {
        db.exec(`ALTER TABLE sops ADD COLUMN role TEXT`);
        console.log('[Migration 050] Added sops.role');
      } else {
        console.log('[Migration 050] sops.role already present, skipping');
      }
      if (!cols.includes('source')) {
        db.exec(`ALTER TABLE sops ADD COLUMN source TEXT`);
        console.log('[Migration 050] Added sops.source');
      } else {
        console.log('[Migration 050] sops.source already present, skipping');
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sops_role ON sops(role)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sops_source ON sops(source)`);
      console.log('[Migration 050] sops role/source columns ready');
    }
  },
  // ============================================================
  // v4.1.0 — Command Center routing + SOP pipeline fixes
  // ============================================================

  {
    id: '051',
    name: 'canonical_department_slug_migration',
    // IDEMPOTENT + REVERSIBLE.
    // Three incompatible slug schemes existed across the codebase:
    //   1. Router DEFAULT_DEPARTMENTS ids  (marketing, web-development, ceo-com)
    //   2. Live workspace slugs from seed  (dept-marketing, dept-webdev, dept-ceo)
    //   3. ZHC canonical bare slugs        (marketing, app-development, billing-finance)
    //
    // This migration rewrites workspaces.slug (and workspaces.id) to the
    // canonical scheme, preserving the original value in workspaces.original_slug
    // so it can be reverted if needed.  It also updates:
    //   - agents.workspace_id references
    //   - tasks.workspace_id references
    //   - tasks.department
    //   - persona_assignment.department_id
    //
    // Safe to re-run: all writes are guarded by "WHERE original_slug IS NULL"
    // or by comparing the canonical value to what's already stored.
    //
    // NOTE: SQLite FKs are OFF for the reshape because we are updating PK/FK
    // pairs in concert.  We turn them back on and verify afterward.
    useOuterTransaction: false,
    up: (db) => {
      console.log('[Migration 051] Canonical department slug migration...');

      // Add original_slug preservation column to workspaces if missing
      const wsCols = (db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map(c => c.name);
      if (!wsCols.includes('original_slug')) {
        db.exec(`ALTER TABLE workspaces ADD COLUMN original_slug TEXT`);
        console.log('[Migration 051] Added workspaces.original_slug');
      }

      // Inline canonical mapping (mirrors canonical-slug.ts without import)
      const canonicalize = (slug: string | null | undefined): string => {
        if (!slug) return '';
        let s = slug.trim().toLowerCase();
        if (s.startsWith('dept-')) s = s.slice(5);
        const map: Record<string, string> = {
          'ceo': 'master-orchestrator',
          'ceo-com': 'master-orchestrator',
          'com': 'master-orchestrator',
          'central-operations': 'master-orchestrator',
          'billing': 'billing-finance',
          'webdev': 'web-development',
          'web-dev': 'web-development',
          'web': 'web-development',
          'appdev': 'app-development',
          'app-dev': 'app-development',
          'mobile': 'app-development',
          'video-production': 'video',
          'audio-production': 'audio',
          'legal-compliance': 'legal',
          'compliance': 'legal',
          'support': 'customer-support',
          'customer-service': 'customer-support',
          'social': 'social-media',
          'paid-ads': 'paid-advertisement',
          'paid-advertising': 'paid-advertisement',
          'openclaw': 'openclaw-maintenance',
        };
        return map[s] ?? s;
      };

      // Turn off FK enforcement so we can update PK + FKs together
      const fkRow = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
      const fkWasOn = fkRow?.foreign_keys === 1;
      db.exec('PRAGMA foreign_keys = OFF');

      try {
        const reshapeTx = db.transaction(() => {
          const workspaces = db.prepare('SELECT id, slug, original_slug FROM workspaces').all() as { id: string; slug: string; original_slug: string | null }[];

          for (const ws of workspaces) {
            const oldSlug = ws.slug || ws.id;
            const newSlug = canonicalize(oldSlug);
            const oldId = ws.id;
            const newId = canonicalize(oldId);

            // Nothing to do if already canonical
            if (oldSlug === newSlug && oldId === newId) continue;

            // Preserve original (idempotent: only write once)
            if (!ws.original_slug) {
              db.prepare('UPDATE workspaces SET original_slug = ? WHERE id = ?').run(oldSlug, oldId);
            }

            // Update workspace id when it differs (the workspace id = slug by convention)
            if (newId !== oldId) {
              // Update FK references first
              db.prepare('UPDATE agents SET workspace_id = ? WHERE workspace_id = ?').run(newId, oldId);
              db.prepare('UPDATE tasks SET workspace_id = ? WHERE workspace_id = ?').run(newId, oldId);
              // Update the workspace row id itself
              db.prepare('UPDATE workspaces SET id = ? WHERE id = ?').run(newId, oldId);
            }

            // Update slug
            if (newSlug !== oldSlug) {
              const targetId = (newId !== oldId) ? newId : oldId;
              db.prepare('UPDATE workspaces SET slug = ? WHERE id = ?').run(newSlug, targetId);
            }
          }

          // Canonicalize tasks.department
          const taskDepts = db.prepare('SELECT DISTINCT department FROM tasks WHERE department IS NOT NULL').all() as { department: string }[];
          for (const { department } of taskDepts) {
            const canon = canonicalize(department);
            if (canon !== department) {
              db.prepare('UPDATE tasks SET department = ? WHERE department = ?').run(canon, department);
            }
          }

          // Canonicalize sops.department
          const sopDepts = db.prepare('SELECT DISTINCT department FROM sops WHERE department IS NOT NULL').all() as { department: string }[];
          for (const { department } of sopDepts) {
            const canon = canonicalize(department);
            if (canon !== department) {
              db.prepare('UPDATE sops SET department = ? WHERE department = ?').run(canon, department);
            }
          }

          // Canonicalize persona_assignment.department_id
          const hasPa = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='persona_assignment'").get();
          if (hasPa) {
            const paDepts = db.prepare('SELECT DISTINCT department_id FROM persona_assignment WHERE department_id IS NOT NULL').all() as { department_id: string }[];
            for (const { department_id } of paDepts) {
              const canon = canonicalize(department_id);
              if (canon !== department_id) {
                db.prepare('UPDATE persona_assignment SET department_id = ? WHERE department_id = ?').run(canon, department_id);
              }
            }
          }
        });
        reshapeTx();

        // Verify FK integrity after reshape
        const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
        if (violations.length > 0) {
          console.error(`[Migration 051] foreign_key_check found ${violations.length} violation(s) after canonical slug reshape`);
        } else {
          console.log('[Migration 051] Canonical slug reshape complete — FK check passed');
        }
      } finally {
        if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
      }
    }
  },

  {
    id: '052',
    name: 'backfill_is_master_master_orchestrator',
    // Idempotent. Sets is_master=1 for the agent(s) in the master-orchestrator
    // / CEO workspace.  Previously createDepartmentInDbDirect hard-coded is_master=0
    // for ALL agents, which broke the comDispatch master-fallback (masters list
    // was empty so fallback returned null).
    up: (db) => {
      console.log('[Migration 052] Backfilling is_master=1 for master-orchestrator agents...');
      const result = db.prepare(`
        UPDATE agents
        SET is_master = 1
        WHERE is_master = 0
          AND workspace_id IN (
            SELECT id FROM workspaces
            WHERE lower(id) IN ('master-orchestrator', 'ceo', 'ceo-com')
               OR lower(slug) IN ('master-orchestrator', 'ceo', 'ceo-com')
          )
      `).run();
      console.log(`[Migration 052] Set is_master=1 on ${result.changes} agent(s)`);
    }
  },

  {
    id: '053',
    name: 'backfill_sop_id_on_backlog_tasks',
    // Idempotent. Assigns the best-scoring SOP to existing backlog tasks where
    // sop_id IS NULL, so the Triad gate stops permanently blocking.
    // Uses a simple keyword+department match (same logic as getBestSOPForTask).
    //
    // IMPORTANT: tasks.sop_id is added by migration 056 (add_tasks_sop_id).
    // Because the runner executes in NUMERIC order, 053 runs BEFORE 056 on any
    // database that has never had the column added by hand.  This guard detects
    // that situation and no-ops safely; 056 will add the column, and because
    // _migrations already records 053 as applied the backfill simply never runs
    // on that database.  On databases where sop_id already exists (either added
    // by 056 on a prior run, or hand-patched), the migration proceeds normally.
    up: (db) => {
      console.log('[Migration 053] Backfilling sop_id on backlog tasks with sop_id IS NULL...');

      // Guard: if sop_id column is missing, the backfill SQL would throw.
      // Migration 056 (add_tasks_sop_id) owns the column creation; it runs
      // after this migration in numeric order.  Skip here — 056 will add the
      // column, and the backfill is intentionally deferred to future task
      // updates (the Triad gate re-evaluates on every status change).
      const tasksColInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!tasksColInfo.some((c) => c.name === 'sop_id')) {
        console.log('[Migration 053] tasks.sop_id column not yet present (will be added by migration 056) — skipping backfill');
        return;
      }

      const hasSOPs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sops'").get();
      if (!hasSOPs) {
        console.log('[Migration 053] sops table not present yet, skipping');
        return;
      }
      const sopCount = (db.prepare('SELECT COUNT(*) as c FROM sops WHERE deleted_at IS NULL').get() as { c: number }).c;
      if (sopCount === 0) {
        console.log('[Migration 053] sops table is empty, skipping backfill');
        return;
      }

      const tasks = db.prepare(
        "SELECT id, title, description, department, workspace_id FROM tasks WHERE sop_id IS NULL AND status = 'backlog'"
      ).all() as { id: string; title: string; description: string | null; department: string | null; workspace_id: string | null }[];

      const sops = db.prepare(
        'SELECT id, department, task_keywords FROM sops WHERE deleted_at IS NULL'
      ).all() as { id: string; department: string | null; task_keywords: string | null }[];

      const canonicalize = (slug: string | null | undefined): string => {
        if (!slug) return '';
        let s = slug.trim().toLowerCase();
        if (s.startsWith('dept-')) s = s.slice(5);
        const map: Record<string, string> = {
          'ceo': 'master-orchestrator', 'ceo-com': 'master-orchestrator',
          'billing': 'billing-finance', 'webdev': 'web-development',
          'appdev': 'app-development', 'video-production': 'video',
          'audio-production': 'audio', 'legal-compliance': 'legal',
          'support': 'customer-support', 'social': 'social-media',
          'paid-ads': 'paid-advertisement', 'openclaw': 'openclaw-maintenance',
        };
        return map[s] ?? s;
      };

      let assigned = 0;
      const updateStmt = db.prepare('UPDATE tasks SET sop_id = ? WHERE id = ?');

      for (const task of tasks) {
        const taskDeptCanon = canonicalize(task.department || task.workspace_id || '');
        const haystack = `${task.title || ''} ${task.description || ''}`.toLowerCase();

        let best: { id: string; score: number } | null = null;
        for (const sop of sops) {
          let score = 0;
          const sopDeptCanon = canonicalize(sop.department || '');
          if (sopDeptCanon && taskDeptCanon && sopDeptCanon === taskDeptCanon) score += 0.5;
          if (sop.task_keywords) {
            const kws = sop.task_keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
            const hits = kws.filter(k => haystack.includes(k));
            score += Math.min(0.5, hits.length * 0.1);
          }
          if (score >= 0.5 && (!best || score > best.score)) {
            best = { id: sop.id, score };
          }
        }
        if (best) {
          updateStmt.run(best.id, task.id);
          assigned++;
        }
      }

      console.log(`[Migration 053] Backfilled sop_id on ${assigned} of ${tasks.length} backlog tasks`);
    }
  },

  // ── TIER 2: persona column + dispatch_rules table ──────────────────────────
  {
    id: '054',
    name: 'add_persona_column_and_dispatch_rules',
    // Tier 2 item 8.
    // Adds agents.persona TEXT column and dispatch_rules table.
    // Both are additive + idempotent.
    up: (db) => {
      console.log('[Migration 054] Adding agents.persona + dispatch_rules table...');

      // agents.persona
      const agentCols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(c => c.name);
      if (!agentCols.includes('persona')) {
        db.exec(`ALTER TABLE agents ADD COLUMN persona TEXT`);
        console.log('[Migration 054] Added agents.persona');
      }

      // dispatch_rules
      db.exec(`
        CREATE TABLE IF NOT EXISTS dispatch_rules (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
          department_slug TEXT NOT NULL,
          task_keywords TEXT,
          sop_id TEXT REFERENCES sops(id) ON DELETE SET NULL,
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          priority INTEGER DEFAULT 5,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_rules_dept ON dispatch_rules(department_slug)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_rules_sop ON dispatch_rules(sop_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_rules_agent ON dispatch_rules(agent_id)`);

      // Seed from existing SOPs: one dispatch rule per SOP row that has
      // both task_keywords and a department.
      const sops = db.prepare(
        'SELECT id, department, task_keywords FROM sops WHERE task_keywords IS NOT NULL AND department IS NOT NULL AND deleted_at IS NULL'
      ).all() as { id: string; department: string; task_keywords: string }[];

      const insert = db.prepare(`
        INSERT OR IGNORE INTO dispatch_rules (id, department_slug, task_keywords, sop_id)
        VALUES (lower(hex(randomblob(8))), ?, ?, ?)
      `);
      // Only seed if rules table is empty to avoid duplicates on re-run
      const existingCount = (db.prepare('SELECT COUNT(*) as c FROM dispatch_rules').get() as { c: number }).c;
      if (existingCount === 0) {
        for (const sop of sops) {
          insert.run(sop.department, sop.task_keywords, sop.id);
        }
        console.log(`[Migration 054] Seeded ${sops.length} dispatch_rules from SOPs`);
      } else {
        console.log('[Migration 054] dispatch_rules already populated, skipping seed');
      }

      console.log('[Migration 054] agents.persona + dispatch_rules ready');
    }
  },
  {
    id: '055',
    name: 'add_workspace_purpose_for_intelligent_routing',
    // Ensures workspaces.description exists and is available for intelligent routing.
    // Idempotent: uses PRAGMA table_info guard before every ALTER TABLE.
    up: (db) => {
      console.log('[Migration 055] Ensuring workspaces.description column for intelligent routing...');

      const wsCols = (db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (!wsCols.includes('description')) {
        db.exec(`ALTER TABLE workspaces ADD COLUMN description TEXT`);
        console.log('[Migration 055] Added workspaces.description');
      } else {
        console.log('[Migration 055] workspaces.description already present — skipping');
      }

      console.log('[Migration 055] Workspace purpose columns ready for intelligent routing');
    },
  },


  // ── Migration 056 — Add tasks.sop_id (column-creation fix) ─────────────────
  {
    id: '056',
    name: 'add_tasks_sop_id',
    up: (db) => {
      console.log('[Migration 056] Ensuring tasks.sop_id column exists...');

      const tasksColInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!tasksColInfo.some((c) => c.name === 'sop_id')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN sop_id TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_sop_id ON tasks(sop_id)`);
        console.log('[Migration 056] Added tasks.sop_id column + index');
      } else {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_sop_id ON tasks(sop_id)`);
        console.log('[Migration 056] tasks.sop_id already present — ensured index, nothing else to do');
      }
    }
  },
  {
    id: '057',
    name: 'add_sop_embeddings_table',
    // Semantic SOP search (feat/semantic-sop-search).
    // Stores OpenAI text-embedding-3-small (1536-dim) vectors for every SOP.
    // Idempotent: CREATE TABLE IF NOT EXISTS + index IF NOT EXISTS.
    up: (db) => {
      console.log('[Migration 057] Creating sop_embeddings table...');

      db.exec(`
        CREATE TABLE IF NOT EXISTS sop_embeddings (
          sop_id         TEXT PRIMARY KEY REFERENCES sops(id) ON DELETE CASCADE,
          embedding      BLOB NOT NULL,
          embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
          embedding_dims  INTEGER NOT NULL DEFAULT 1536,
          embedded_at    TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sop_embeddings_embedded_at ON sop_embeddings(embedded_at)`);

      console.log('[Migration 057] sop_embeddings table ready');
    }
  },
  {
    id: '058',
    name: 'add_task_archived_at',
    // Adds tasks.archived_at TEXT column for the weekly Done-clear job.
    // archived_at IS NOT NULL = task has been soft-archived; IS NULL = live.
    // Additive + idempotent: safe to run against any existing DB.
    // Renumbered from 055 (fix/board-and-analytics PR #45) to avoid collision
    // with 055 add_workspace_purpose_for_intelligent_routing.
    up: (db) => {
      console.log('[Migration 058] Adding tasks.archived_at for weekly Done-clear...');
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('archived_at')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN archived_at TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_archived_at ON tasks(archived_at)`);
        console.log('[Migration 058] tasks.archived_at + index added');
      } else {
        console.log('[Migration 058] tasks.archived_at already present, skipping');
      }
    },
  },
];

/**
 * Run all pending migrations
 */
export function runMigrations(db: Database.Database): void {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
  
  // Get already applied migrations
  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map(m => m.id)
  );

  // Run pending migrations in NUMERIC ID order — never trust file declaration order.
  // (Today's deploy disaster was caused by file-order vs numerical-order mismatch.
  //  Sorting here ensures a missing/renumbered slot can't snake-jump the queue.)
  const ordered = [...migrations].sort((a, b) => {
    const an = parseInt(a.id, 10);
    const bn = parseInt(b.id, 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn;
    return a.id.localeCompare(b.id);
  });

  for (const migration of ordered) {
    if (applied.has(migration.id)) {
      continue;
    }
    
    console.log(`[DB] Running migration ${migration.id}: ${migration.name}`);

    const useOuter = migration.useOuterTransaction !== false;

    try {
      if (useOuter) {
        // Run migration in a transaction (default for backwards compat).
        db.transaction(() => {
          migration.up(db);
          db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name);
        })();
      } else {
        // Migration owns its own transaction boundary. Runner only records
        // the apply (in a tiny independent txn) AFTER up succeeds.
        migration.up(db);
        db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name);
      }

      console.log(`[DB] Migration ${migration.id} completed`);
    } catch (error) {
      console.error(`[DB] Migration ${migration.id} failed:`, error);
      throw error;
    }
  }

  // Auto-seed from departments.json if workspaces table is empty
  autoSeedFromDepartmentsJson(db);

  // Auto-seed the starter SOP library (B6). Chained here — the same first-boot /
  // DB-init path where the Skill-23 workspace auto-seed runs — so the role
  // library (workspaces/agents) AND the SOPs load together exactly where the
  // client runs Skill 23. Previously the SOPs loaded ONLY via the manual
  // `npm run db:seed:sops` script, so a fresh box had an empty SOP table and the
  // Triad Rule silently blocked every task. seedStarterSOPs is idempotent
  // (skips existing slugs) so it is safe on every boot.
  autoSeedStarterSOPs(db);
}

// Auto-seed starter SOPs on boot (B6). Non-fatal: a missing `sops` table or any
// seed error never blocks app startup — it just logs.
function autoSeedStarterSOPs(db: Database.Database) {
  try {
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sops'")
      .get();
    if (!hasTable) {
      console.log('[Auto-seed SOPs] Skipped: sops table not present yet');
      return;
    }
    const result = seedStarterSOPs(db);
    if (result.inserted > 0) {
      console.log(
        `[Auto-seed SOPs] Seeded starter SOP library: inserted ${result.inserted}, skipped ${result.skipped} (of ${result.total})`
      );
    }
    // Loud warning if a department workspace exists but the SOP table is empty —
    // the Triad Rule would otherwise silently block the whole board.
    const sopCount = (db.prepare('SELECT COUNT(*) as c FROM sops WHERE deleted_at IS NULL').get() as { c: number } | undefined)?.c ?? 0;
    const wsCount = (db.prepare('SELECT COUNT(*) as c FROM workspaces').get() as { c: number } | undefined)?.c ?? 0;
    if (wsCount > 0 && sopCount === 0) {
      console.warn('[Auto-seed SOPs] WARNING: workspaces exist but SOP table is EMPTY — the Triad Rule will block every task. Run `npm run db:seed:sops`.');
    }
  } catch (err) {
    console.log('[Auto-seed SOPs] Skipped:', (err as Error).message);
  }
}

/**
 * Get migration status
 */
export function getMigrationStatus(db: Database.Database): { applied: string[]; pending: string[] } {
  const applied = (db.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: string }[]).map(m => m.id);
  const sorted = [...migrations].sort((a, b) => {
    const an = parseInt(a.id, 10);
    const bn = parseInt(b.id, 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn;
    return a.id.localeCompare(b.id);
  });
  const pending = sorted.filter(m => !applied.includes(m.id)).map(m => m.id);
  return { applied, pending };
}

// Auto-seed company + workspaces from config/departments.json on first boot
function autoSeedFromDepartmentsJson(db: Database.Database) {
  try {
    // Check if workspaces table is empty
    const count = db.prepare('SELECT COUNT(*) as c FROM workspaces').get() as { c: number } | undefined;
    if (count && count.c > 0) return; // Already has data

    // Look for departments.json
    const configPaths = [
      path.join(process.cwd(), 'config', 'departments.json'),
      path.join(os.homedir(), 'clawd', 'projects', 'blackceo-command-center', 'config', 'departments.json'),
      path.join(os.homedir(), 'projects', 'mission-control', 'config', 'departments.json'),
      path.join(os.homedir(), 'Downloads', 'openclaw-master-files', 'company-discovery', 'departments.json'),
      path.join('/opt', 'mission-control', 'config', 'departments.json'),
    ];
    
    let configPath: string | null = null;
    for (const p of configPaths) {
      if (fs.existsSync(p)) {
        configPath = p;
        break;
      }
    }
    
    if (!configPath) return;

    const depts = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!Array.isArray(depts) || depts.length === 0) return;

    console.log('[Auto-seed] Found departments.json with', depts.length, 'departments');

    // Get company name from env, interview answers, or use placeholder
    const companyName = findCompanyName();
    const companySlug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-company';

    // Create company entry first
    db.prepare(
      'INSERT OR IGNORE INTO companies (id, name, slug, industry, config) VALUES (?, ?, ?, ?, ?)'
    ).run(companySlug, companyName, companySlug, '', '{}');
    console.log('[Auto-seed] Created company:', companyName);

    for (const dept of depts) {
      // CEO must seed at sort_order = 0 so it sorts above everything; without
      // this an auto-seeded CEO would inherit the schema default (1000) and
      // land last (then get re-pinned only on the next boot by migration 046).
      // The CEO key is the slug 'ceo' or id 'dept-ceo' (display name is free
      // text — e.g. the client's main-agent persona — so we never match on it).
      const slugLower = String(dept.slug || dept.id || '').toLowerCase();
      const isCeo = slugLower === 'ceo' || slugLower === 'dept-ceo' || dept.id === 'ceo';
      const sortOrder = isCeo ? 0 : 1000;
      db.prepare(
        'INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        dept.id,
        dept.name,
        dept.slug || dept.id,
        dept.name + ' department workspace',
        dept.emoji || '📁',
        companySlug,
        sortOrder
      );
      console.log('[Auto-seed] Created workspace:', dept.id, dept.name, isCeo ? '(CEO → sort_order 0)' : '');
    }

    console.log('[Auto-seed] Done. Seeded company +', depts.length, 'workspaces');
  } catch (err) {
    console.log('[Auto-seed] Skipped:', (err as Error).message);
  }
}

// Find company name from env var, interview answers file, or default
function findCompanyName(): string {
  // 1. Check COMPANY_NAME env var first
  const envName = process.env.COMPANY_NAME?.trim();
  if (envName) return envName;

  // 2. Try to find from Skill 23 interview answers
  const answerFiles = [
    path.join(os.homedir(), 'Downloads', 'openclaw-master-files', 'company-discovery', 'workforce-interview-answers.md'),
    path.join(os.homedir(), '.openclaw', 'workspace', 'company-discovery', 'workforce-interview-answers.md'),
  ];

  for (const f of answerFiles) {
    if (fs.existsSync(f)) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        // Look for patterns like "Company Name: XYZ" or "## Company Name\nXYZ"
        const patterns = [
          /(?:company|business)\s*name\s*[:\-]\s*(.+?)(?:\n|$)/i,
          /#+\s*(?:company|business)\s*name\s*\n+(.+?)(?:\n|$)/i,
        ];
        for (const pattern of patterns) {
          const match = content.match(pattern);
          if (match && match[1]) {
            const name = match[1].trim();
            if (name) return name;
          }
        }
      } catch {
        // Continue to next file
      }
    }
  }

  // 3. Default fallback
  return 'Command Center';
}
