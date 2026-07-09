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
import { seedCompanyGuarded } from './branding-seed';
import {
  dedupeCanonicalWorkspaces,
  reapDuplicateOpenAuthoringTasks,
  findCanonicalWorkspaceId,
} from './task-dedup';

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
  /**
   * INGEST-07: when true, this migration performs a DESTRUCTIVE data operation
   * (row dedup / reap / merge) that must NOT run during the request-time schema
   * self-heal path — that path races data mutations against live ingest. When
   * `OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY` is set (the self-heal sets it for
   * the duration of its one-shot migrate), the runner DEFERS these migrations:
   * it neither runs `up` nor records them as applied, so they stay pending and
   * run normally on the next controlled boot. Only additive schema DDL should
   * be applied during self-heal.
   */
  deferInAdditiveSelfHeal?: boolean;
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
      // were the trigger for the migration-034 FK breakage on a client
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
      // Durable "CEO / master-orchestrator is department #1" guarantee.
      // Migration 014 pinned CEO=1 at column-add time but only matched the
      // legacy slug 'ceo'; the canonical post-051 slug is 'master-orchestrator',
      // so those rows landed at the default sort_order (1000).
      //
      // This re-pin sets ALL CEO/master-orchestrator rows to sort_order = 0
      // so the board always shows them first regardless of prior data or
      // slug migration state. Matches slug 'master-orchestrator', 'ceo',
      // 'dept-ceo' and the name variants 'ceo' / 'master orchestrator'.
      // Safe to re-run (idempotent — already-0 rows are no-op).
      console.log('[Migration 046] Pinning CEO / master-orchestrator department to sort_order = 0...');
      try {
        const result = db
          .prepare(
            `UPDATE workspaces
                SET sort_order = 0
              WHERE lower(slug) IN ('master-orchestrator', 'ceo', 'dept-ceo')
                 OR lower(name) IN ('ceo', 'master orchestrator')`
          )
          .run();
        console.log(`[Migration 046] Re-pinned ${result.changes} CEO/master-orchestrator workspace row(s) to sort_order = 0`);
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
        console.log('[Migration 058] tasks.archived_at column added');
      } else {
        console.log('[Migration 058] tasks.archived_at already present, skipping column add');
      }
      // Index must be created unconditionally (outside the column-absence guard):
      // schema.ts already defines archived_at on fresh installs, so the ALTER TABLE
      // branch above is skipped there — but the index still needs to exist.
      // IF NOT EXISTS makes this safe/idempotent on every database, old or new.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_archived_at ON tasks(archived_at)`);
      console.log('[Migration 058] idx_tasks_archived_at index ready');
    },
  },

  // ── Migration 059 — Pin General Task department to the BOTTOM of the board ─
  {
    id: '059',
    name: 'pin_general_task_department_last',
    up: (db) => {
      // Board layout guarantee (CC layout, not agent behavior):
      //   CEO / master-orchestrator → FIRST  (migration 046 owns sort_order = 0)
      //   General Tasks (general-task) → LAST
      //   All other depts → between
      //
      // We set general-task to sort_order = 99999 so it sorts below everything
      // regardless of how many operational departments are added. Matches slug
      // 'general-task' and name variants 'general tasks' / 'general task'.
      // Idempotent: already-99999 rows are a no-op. Non-fatal when no row yet.
      console.log('[Migration 059] Pinning general-task department to sort_order = 99999...');
      try {
        const result = db
          .prepare(
            `UPDATE workspaces
                SET sort_order = 99999
              WHERE lower(slug) = 'general-task'
                 OR lower(name) IN ('general tasks', 'general task')`
          )
          .run();
        console.log(`[Migration 059] Pinned ${result.changes} general-task workspace row(s) to sort_order = 99999`);
      } catch (e) {
        // Non-fatal — row may not exist yet on a fresh install.
        console.log('[Migration 059] Skipped:', (e as Error).message);
      }
    },
  },

  // ── Migration 061 — Add tasks.qc_reroute_attempts for QC loop guard ────────
  {
    id: '061',
    name: 'add_tasks_qc_reroute_attempts',
    // Adds tasks.qc_reroute_attempts INTEGER column used by the QC scorer
    // (v4.12.0) to track how many times a task has been returned to backlog
    // after failing QC. When the count reaches QC_MAX_REROUTES (default 3),
    // the scorer stops re-dispatching, sets the task to `blocked`, and writes
    // a CEO-addressed event to surface the loop for human review.
    // Additive + idempotent: safe against any existing DB.
    up: (db) => {
      console.log('[Migration 061] Adding tasks.qc_reroute_attempts for QC loop guard...');
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('qc_reroute_attempts')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN qc_reroute_attempts INTEGER DEFAULT 0`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_qc_reroute ON tasks(qc_reroute_attempts) WHERE qc_reroute_attempts > 0`);
        console.log('[Migration 061] tasks.qc_reroute_attempts + index added');
      } else {
        console.log('[Migration 061] tasks.qc_reroute_attempts already present, skipping');
      }
    },
  },

  // ── Migration 062 — Add clients.brand_secondary_color (v4.13.0) ────────────
  {
    id: '062',
    name: 'add_clients_brand_secondary_color',
    // Adds clients.brand_secondary_color TEXT column used by the company
    // settings form (v4.13.0) to persist the operator-chosen secondary brand
    // color. When set, BrandTheme emits it as --bcc-secondary / --brand-secondary-*
    // CSS variables so the secondary accent cascades app-wide independently of
    // the auto-derived analogous shade. Additive + idempotent.
    up: (db) => {
      console.log('[Migration 062] Adding clients.brand_secondary_color...');
      const cols = (db.prepare('PRAGMA table_info(clients)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('brand_secondary_color')) {
        db.exec(`ALTER TABLE clients ADD COLUMN brand_secondary_color TEXT`);
        console.log('[Migration 062] clients.brand_secondary_color added');
      } else {
        console.log('[Migration 062] clients.brand_secondary_color already present, skipping');
      }
    },
  },

  // ── Migration 060 — Per-department QC Specialist agents ────────────────────
  {
    id: '060',
    name: 'add_role_type_and_seed_qc_agents',
    up: (db) => {
      // PR-B: Per-department QC Specialist gates move-to-DONE.
      //
      // Schema change: add agents.role_type TEXT column.
      //   NULL   = standard agent (default)
      //   'qc'   = the department's QC Specialist
      //
      // Seeding: for each workspace that doesn't already have a QC Specialist,
      // insert one. The QC agent is associated with the workspace's id as
      // workspace_id, marked is_master=0, specialist_type='permanent',
      // role_type='qc'. Name: "<workspace.name> QC Specialist".
      //
      // Idempotent: column add is guarded by PRAGMA table_info check; agent seed
      // is INSERT OR IGNORE keyed on the deterministic id 'qc-agent-<workspace.id>'.
      console.log('[Migration 060] Adding agents.role_type column + seeding per-dept QC Specialist agents...');

      // 1. Add role_type column to agents (idempotent)
      const agentCols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(c => c.name);
      if (!agentCols.includes('role_type')) {
        db.exec(`ALTER TABLE agents ADD COLUMN role_type TEXT`);
        console.log('[Migration 060] Added agents.role_type column');
      } else {
        console.log('[Migration 060] agents.role_type already present, skipping column add');
      }

      // 2. Seed one QC Specialist per workspace (idempotent via INSERT OR IGNORE)
      //    Only seed if workspaces exist; deferred on truly empty installs.
      const workspaces = db.prepare('SELECT id, name FROM workspaces').all() as { id: string; name: string }[];
      if (workspaces.length === 0) {
        console.log('[Migration 060] No workspaces yet — QC agent seeding deferred to next boot');
        return;
      }

      const insertQC = db.prepare(`
        INSERT OR IGNORE INTO agents
          (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
           specialist_type, role_type, created_at, updated_at)
        VALUES (?, ?, 'QC Specialist', ?, '🔍', 'standby', 0, ?, 'permanent', 'qc', datetime('now'), datetime('now'))
      `);

      let seeded = 0;
      for (const ws of workspaces) {
        const agentId = `qc-agent-${ws.id}`;
        const agentName = `${ws.name} QC Specialist`;
        const description = `Quality control specialist for the ${ws.name} department. Reviews completed tasks against SOP success criteria and decides whether work moves to Done or back to In Progress.`;
        insertQC.run(agentId, agentName, description, ws.id);
        seeded++;
      }
      console.log(`[Migration 060] Seeded/verified ${seeded} QC Specialist agent(s) across ${workspaces.length} workspace(s)`);
    },
  },

  // ── Migration 065 — Department Trio: research + devil's-advocate agents (PRD 2.11) ──
  {
    id: '065',
    name: 'seed_research_and_devils_advocate_agents',
    up: (db) => {
      // PRD 2.11 (CC side): seed the trio agent rows per department.
      //
      // Every operational department must have THREE specialist agents with
      // distinct role_type values:
      //   'qc'               — QC Specialist (seeded by migration 060)
      //   'research'         — Deep-Research Specialist (seeded here)
      //   'devils-advocate'  — Devil's Advocate (seeded here)
      //
      // Devil's Advocate is an INTERNAL role: it is auto-created and NEVER
      // surfaced to client-facing UI (is_client_facing = 0 by convention;
      // the resolver and dispatch logic filter it by role_type only, never
      // by name). It is deliberately absent from any persona/agent picker
      // that shows up in the client board view.
      //
      // Idempotent: INSERT OR IGNORE on deterministic ids
      //   research agent id:        'research-agent-<workspace.id>'
      //   devils-advocate agent id: 'da-agent-<workspace.id>'
      //
      // Deferred: if no workspaces exist yet, this migration records a log
      // message and returns cleanly. The autoSeedFromDepartmentsJson path
      // (which runs after migrations on every boot) also seeds the trio for
      // any workspace created after migration time, so no workspace is ever
      // left without its trio.
      console.log('[Migration 065] Seeding per-dept Research + Devil\'s Advocate agents (PRD 2.11)...');

      // Guard: role_type column must exist (added by migration 060).
      const agentCols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(c => c.name);
      if (!agentCols.includes('role_type')) {
        console.warn('[Migration 065] agents.role_type column missing — migration 060 may not have run yet; skipping');
        return;
      }

      const workspaces = db.prepare('SELECT id, name FROM workspaces').all() as { id: string; name: string }[];
      if (workspaces.length === 0) {
        console.log('[Migration 065] No workspaces yet — trio seeding deferred to next boot');
        return;
      }

      const insertResearch = db.prepare(`
        INSERT OR IGNORE INTO agents
          (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
           specialist_type, role_type, created_at, updated_at)
        VALUES (?, ?, 'Research Specialist', ?, '🔬', 'standby', 0, ?, 'permanent', 'research', datetime('now'), datetime('now'))
      `);

      const insertDA = db.prepare(`
        INSERT OR IGNORE INTO agents
          (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
           specialist_type, role_type, created_at, updated_at)
        VALUES (?, ?, 'Devil''s Advocate', ?, '😈', 'standby', 0, ?, 'permanent', 'devils-advocate', datetime('now'), datetime('now'))
      `);

      let researchSeeded = 0;
      let daSeeded = 0;

      for (const ws of workspaces) {
        const researchId = `research-agent-${ws.id}`;
        const daId = `da-agent-${ws.id}`;

        const researchName = `${ws.name} Research Specialist`;
        const researchDesc = `Deep-research specialist for the ${ws.name} department. Applies the Tier-1 research mandate (McKinsey, Harvard Business Review, IBISWorld, Statista citations required) to discover, synthesise, and validate information needed by the department's specialists and SOP library.`;
        insertResearch.run(researchId, researchName, researchDesc, ws.id);
        researchSeeded++;

        const daName = `${ws.name} Devil's Advocate`;
        // DA is internal: description is intentionally operator-facing only —
        // it never appears in client-facing UI.
        const daDesc = `[INTERNAL — not surfaced to client] Devil's Advocate for the ${ws.name} department. Stress-tests plans, decisions, and deliverables by surfacing assumptions, edge cases, and counter-arguments BEFORE they become problems. Reports findings only to the department's QC Specialist and the master orchestrator.`;
        insertDA.run(daId, daName, daDesc, ws.id);
        daSeeded++;
      }

      console.log(
        `[Migration 065] Seeded/verified ${researchSeeded} Research + ${daSeeded} Devil's Advocate agent(s)` +
        ` across ${workspaces.length} workspace(s)`,
      );
    },
  },

  // ── Migration 063 — SOP embeddings model-drift index (PRD 1.8c) ─────────────
  {
    id: '063',
    name: 'sop_embeddings_model_drift_index',
    // Adds an index on sop_embeddings.embedding_model to make stale-row detection
    // (countStaleGoogleEmbeddings) efficient at scale.
    //
    // Background: gemini-embedding-001 is retired 2026-07-14. Any rows carrying
    // that model slug are stale and must be re-embedded with gemini-embedding-2.
    // countStaleGoogleEmbeddings() runs a WHERE embedding_model = ? query; without
    // an index this is a full table scan over potentially 2,578+ rows on every
    // semantic search request.
    //
    // Idempotent: CREATE INDEX IF NOT EXISTS.
    up: (db) => {
      console.log('[Migration 063] Adding idx_sop_embeddings_model for model-drift detection...');
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sop_embeddings_model
           ON sop_embeddings(embedding_model)`
      );
      console.log('[Migration 063] idx_sop_embeddings_model ready');
    },
  },
  {
    id: '066',
    name: 'add_tasks_sop_authoring_link',
    // PRD 2.12-cc: links the "Author SOP" sub-task back to the original task
    // that triggered the fast-loop authoring. Additive + idempotent.
    // For existing databases this migration adds the column; schema.ts carries
    // the column definition for fresh installs (noted there with a migration-066
    // comment per the 050/060 convention).
    up: (db) => {
      console.log('[Migration 066] Adding tasks.sop_authoring_for_task_id (PRD 2.12-cc)...');
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (!cols.includes('sop_authoring_for_task_id')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN sop_authoring_for_task_id TEXT`);
        console.log('[Migration 066] Added tasks.sop_authoring_for_task_id');
      } else {
        console.log('[Migration 066] tasks.sop_authoring_for_task_id already present, skipping');
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_tasks_sop_authoring ON tasks(sop_authoring_for_task_id)`,
      );
      console.log('[Migration 066] idx_tasks_sop_authoring ready');
    },
  },
  {
    id: '064',
    name: 'seed_default_company_sentinel',
    // BUG FIX (v4.22.0): POST /api/workspaces INSERT omits company_id and
    // relies on the column DEFAULT 'default', but workspaces.company_id has
    // a FK reference to companies(id) and no row with id='default' exists on a
    // clean install → SQLITE_CONSTRAINT_FOREIGNKEY → 500 on every POST /api/workspaces
    // request from a fresh DB.
    //
    // Root cause: migration 012 deliberately chose not to seed a default company
    // ("No default company seeded. Client's company is created by seed-workspaces.py")
    // but the FK + DEFAULT combo still requires the sentinel row to be present for
    // the DEFAULT path to work without an explicit company_id.
    //
    // Fix strategy (belt-AND-suspenders):
    //   1. Seed a sentinel row (id='default', slug='default') so the FK is satisfied
    //      whenever the workspaces INSERT falls through to the DEFAULT value.
    //   2. Use INSERT OR IGNORE so re-running this migration on an existing DB that
    //      already has a real company row is completely safe — no overwrite, no crash.
    //   3. The workspaces route.ts also accepts company_id from the POST body (added
    //      separately), but the seed is the canonical fix for all callers.
    up: (db) => {
      console.log('[Migration 064] Seeding sentinel default company row (BUG 4 fix)...');
      // Guard: companies table must exist. On very old DBs that pre-date migration 012
      // the table may not yet be present; let migration 012 create it first.
      const hasTable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='companies'"
      ).get() as { name: string } | undefined;
      if (!hasTable) {
        console.log('[Migration 064] companies table not yet present — skipping (will run again after 012)');
        return;
      }
      // INSERT OR IGNORE: idempotent on every subsequent boot.
      const result = db.prepare(`
        INSERT OR IGNORE INTO companies (id, name, slug, config)
        VALUES ('default', 'Default', 'default', '{}')
      `).run();
      if (result.changes > 0) {
        console.log("[Migration 064] Inserted sentinel companies row id='default'");
      } else {
        console.log("[Migration 064] Sentinel companies row already present, skipping");
      }
    },
  },
  {
    id: '067',
    name: 'expand_sop_proposals_status_auto_authored',
    // PRD 2.12-cc: dispatch-time authoring files proposals with
    // status='auto-authored-filed'. The CHECK on sop_proposals only went up to
    // 'escalated' (migration 025). Expand it via table-rebuild (SQLite cannot
    // ALTER…DROP CONSTRAINT). Idempotent: no-op if already expanded.
    up: (db) => {
      console.log('[Migration 067] Expanding sop_proposals.status CHECK to include auto-authored-filed...');
      const tableSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sop_proposals'").get() as
          | { sql: string }
          | undefined
      )?.sql ?? '';

      // Already includes the new status → nothing to do.
      if (tableSql.includes("'auto-authored-filed'")) {
        console.log('[Migration 067] CHECK already includes auto-authored-filed, skipping rebuild');
        return;
      }

      // Defensive: if the table doesn't exist yet (extremely old DB), skip —
      // migration 025 will create it with the old CHECK and this migration will
      // then run next boot to fix it.
      if (!tableSql) {
        console.log('[Migration 067] sop_proposals table not found yet, skipping');
        return;
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS sop_proposals_m067_new (
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
        INSERT OR IGNORE INTO sop_proposals_m067_new
          SELECT id, proposed_name, proposed_department, draft_steps, based_on_task_ids,
                 evidence_summary, status, created_at, reviewed_at, reviewed_by,
                 approved_sop_id, replaces_sop_id, confidence, auto_research_attempts, research_sources
          FROM sop_proposals;
        DROP TABLE sop_proposals;
        ALTER TABLE sop_proposals_m067_new RENAME TO sop_proposals;
        CREATE INDEX IF NOT EXISTS idx_sop_proposals_status ON sop_proposals(status);
        CREATE INDEX IF NOT EXISTS idx_sop_proposals_created ON sop_proposals(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sop_proposals_replaces ON sop_proposals(replaces_sop_id);
      `);
      console.log('[Migration 067] sop_proposals rebuilt with expanded status CHECK');
    },
  },

  // ── Migration 068 — Add task_qc_results for grading module (PRD 2.10) ──────
  {
    id: '068',
    name: 'add_task_qc_results',
    // Persists one structured row per QC scoring event so grading.ts can compute
    // real per-department QC pass-rates against the 8.5 gate without parsing
    // free-text event messages.
    //
    // scoring_path discriminates:
    //   'llm'         → real LLM-graded outcome, counts toward qcPassRate
    //   'heuristic'   → structural heuristic (no LLM key), NOT a graded outcome
    //   'no-criteria' → no SOP assigned, NOT a graded outcome
    //
    // Additive + idempotent: uses CREATE TABLE IF NOT EXISTS. Safe on all existing DBs.
    up: (db) => {
      console.log('[Migration 068] Creating task_qc_results table for grading module...');
      db.exec(`
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
      `);
      console.log('[Migration 068] task_qc_results table + indexes ready');
    },
  },
  {
    // PRD 2.14: Lean Six Sigma control-review history table.
    // Stores the monthly control-review artifact (defect/rework/waste summary +
    // narrative markdown + department breakdown). Additive + idempotent.
    // SAFE to declare here AND in schema.ts — CREATE TABLE IF NOT EXISTS.
    id: '069',
    name: 'add_lss_control_reviews',
    up: (db) => {
      console.log('[Migration 069] Creating lss_control_reviews table...');
      db.exec(`
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
      `);
      console.log('[Migration 069] lss_control_reviews table + index ready');
    },
  },

  // §3 — task_events structured audit trail + task_deliverables extended columns
  {
    id: '070',
    name: 'task_events_artifact_contract',
    up: (db) => {
      console.log('[Migration 070] Creating task_events table + artifact columns on task_deliverables...');

      // task_events: structured audit trail written by task-lifecycle.ts transition()
      db.exec(`
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
      `);

      // Extend task_deliverables with mime_type, file_size_bytes, sha256 columns
      // (idempotent via ALTER TABLE … IF NOT EXISTS is not supported in older SQLite;
      //  we guard with a PRAGMA check instead)
      const cols = (db.prepare('PRAGMA table_info(task_deliverables)').all() as { name: string }[]).map((c) => c.name);

      if (!cols.includes('mime_type')) {
        db.exec(`ALTER TABLE task_deliverables ADD COLUMN mime_type TEXT`);
      }
      if (!cols.includes('file_size_bytes')) {
        db.exec(`ALTER TABLE task_deliverables ADD COLUMN file_size_bytes INTEGER`);
      }
      if (!cols.includes('sha256')) {
        db.exec(`ALTER TABLE task_deliverables ADD COLUMN sha256 TEXT`);
      }

      console.log('[Migration 070] task_events table + task_deliverables columns ready');
    },
  },

  // T3-001 -- Bug Tickets (dedicated lifecycle table for the Bugs Department)
  // CREATE TABLE IF NOT EXISTS is idempotent -- safe on fresh DBs that already
  // ran schema.ts, and on existing DBs that haven't seen these tables yet.
  {
    id: '071',
    name: 'add_bug_tickets',
    up: (db) => {
      console.log('[Migration 071] Creating bug_tickets + bug_ticket_events tables...');

      db.exec(`
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
      `);

      console.log('[Migration 071] bug_tickets + bug_ticket_events tables ready');
    },
  },

  {
    id: '072',
    name: 'blocked_fields_and_last_progress_at',
    up: (db) => {
      // Blocked-column gate (N36 / SOP-01-Blocked-vs-Return).
      //
      // Three new tasks columns enforce the doctrine that Blocked = human-only:
      //   blocked_reason:     one of {decision,approval,credential,payment} -- the ONLY
      //                       four qualifying human-only categories.
      //   blocked_on_human:   "owner" or "operator" -- who is being waited on.
      //   ask:                one-line string -- exactly what that human must do.
      //
      // A task PATCH to status=blocked is rejected by the API gate (400) unless
      // all three are present AND the requesting agent is the master orchestrator.
      //
      // last_progress_at:    timestamp bumped on any status change, any logged
      //                      event/activity, any deliverable added, or any human
      //                      action on a Blocked card.  The stale-task sweep reads
      //                      this column to decide when a card has gone stale.
      //                      Backfilled to updated_at for all existing tasks.
      console.log('[Migration 072] Adding blocked fields + last_progress_at to tasks...');

      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);

      if (!cols.includes('blocked_reason')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN blocked_reason TEXT CHECK (blocked_reason IN ('decision','approval','credential','payment') OR blocked_reason IS NULL)`);
      }
      if (!cols.includes('blocked_on_human')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN blocked_on_human TEXT CHECK (blocked_on_human IN ('owner','operator') OR blocked_on_human IS NULL)`);
      }
      if (!cols.includes('ask')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN ask TEXT`);
      }
      if (!cols.includes('last_progress_at')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN last_progress_at TEXT`);
        // Backfill: set to updated_at for all existing rows so the stale sweep
        // does not immediately flag every existing card as stale.
        db.exec(`UPDATE tasks SET last_progress_at = updated_at WHERE last_progress_at IS NULL`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_last_progress ON tasks(last_progress_at)`);
      }

      console.log('[Migration 072] blocked fields + last_progress_at ready');
    },
  },
  {
    // RENUMBERED 072 → 075: the id '072' collided with
    // 'blocked_fields_and_last_progress_at' above. The runner builds its
    // in-memory applied-set ONCE (runMigrations, top of loop), so on a fresh DB
    // the second '072' still passed the applied.has() guard, ran, and its
    // `INSERT INTO _migrations (id, ...)` hit the PRIMARY KEY →
    // "UNIQUE constraint failed: _migrations.id" (crashed seed before 074).
    // In production whichever 072 ran first claimed the id, so THIS migration's
    // schema change never applied; id 075 (> current max 074) makes it apply.
    //
    // REVERSIBILITY — this framework has no auto-down field; documented manual
    // rollback, mirroring the migration-074 convention:
    //   DROP INDEX IF EXISTS idx_sops_model_pin;
    //   ALTER TABLE sops DROP COLUMN model_pin;   -- SQLite >= 3.35 (better-sqlite3 12.x bundles >= 3.45)
    //   DELETE FROM _migrations WHERE id = '075';
    //   (the agent_settings / tasks.model_id NULL-backfills below are data-only
    //    and not auto-reversible; re-pin via the task-time selector if required.)
    id: '075',
    name: 'intelligent_model_selector',
    up: (db) => {
      // Intelligent Model Selector — AF-MODEL-SOVEREIGNTY (PLAN.md §5, §7)
      //
      // 1. sops.model_pin TEXT  — SOP author's explicit model pin; wins over
      //    the task-time selector in the precedence cascade.
      // 2. agent_settings.dept_selector_model TEXT  — the last model the
      //    task-time selector chose for this dept default slot; informational,
      //    updated on each successful selector resolution.
      // 3. Backfill dept defaults: any agent_settings row whose value is
      //    'openrouter/free' or null has its value set to NULL so the resolver
      //    falls through to the task-time selector instead of the rejected literal.
      console.log('[Migration 075] Intelligent Model Selector schema...');

      const sopCols = (db.prepare('PRAGMA table_info(sops)').all() as { name: string }[]).map((c) => c.name);
      if (!sopCols.includes('model_pin')) {
        db.exec(`ALTER TABLE sops ADD COLUMN model_pin TEXT`);
      }
      // Ensure the partial index whether the column was just added or already
      // existed (idempotent: IF NOT EXISTS). model_pin is guaranteed present here.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sops_model_pin ON sops(model_pin) WHERE model_pin IS NOT NULL`);

      // Backfill: purge 'openrouter/free' defaults so the selector takes over
      db.exec(
        `UPDATE agent_settings
         SET value = NULL
         WHERE setting_type = 'model'
           AND (value = 'openrouter/free' OR value = '' OR value IS NULL)`,
      );
      // Delete the NULL rows — a NULL model value row is useless and confusing
      db.exec(
        `DELETE FROM agent_settings
         WHERE setting_type = 'model' AND (value IS NULL OR value = '')`,
      );

      // tasks.model_id: clear out any existing 'openrouter/free' pins so they
      // are re-resolved by the selector on next dispatch.
      const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
      if (taskCols.includes('model_id')) {
        db.exec(`UPDATE tasks SET model_id = NULL WHERE model_id = 'openrouter/free'`);
      }

      console.log('[Migration 075] Intelligent Model Selector schema ready');
    },
  },
  {
    id: '073',
    name: 'block_transparency_fields',
    up: (db) => {
      // Block transparency (v4.44.0 — BLOCK-TRANSPARENCY-001).
      //
      // Adds three columns to `tasks` so the QC scorer can populate WHY a task
      // is blocked, what specific gaps caused the failure, what action resolves
      // it, and whether the ball is in the owner's court or the system's court.
      //
      //   block_gaps     TEXT  — JSON-encoded string[] of specific QC failure reasons
      //   block_needs    TEXT  — The single human-readable resolving action
      //   block_audience TEXT  — 'OWNER' | 'SYSTEM' — who must act; CHECK constraint
      //                          enforced at the DB layer.
      //
      // These columns are additive and nullable — existing blocked tasks will
      // have NULL in all three until they next transition through the QC scorer.
      console.log('[Migration 073] Adding block transparency columns to tasks...');

      const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);

      if (!taskCols.includes('block_gaps')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN block_gaps TEXT`);
        console.log('[Migration 073] Added tasks.block_gaps');
      }
      if (!taskCols.includes('block_needs')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN block_needs TEXT`);
        console.log('[Migration 073] Added tasks.block_needs');
      }
      if (!taskCols.includes('block_audience')) {
        // SQLite does not enforce CHECK on ALTER TABLE ADD COLUMN in all versions,
        // but the app layer validates the value before writing.
        db.exec(`ALTER TABLE tasks ADD COLUMN block_audience TEXT CHECK (block_audience IN ('OWNER', 'SYSTEM'))`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_block_audience ON tasks(block_audience) WHERE block_audience IS NOT NULL`);
        console.log('[Migration 073] Added tasks.block_audience');
      }

      console.log('[Migration 073] Block transparency columns ready');
    },
  },
  {
    id: '074',
    name: 'add_tasks_stage_slug_for_ad_campaigns',
    up: (db) => {
      // Ad-campaign assembly-line cards (Skill 48 → board): stage_slug identifies
      // each stage card within a campaign. campaign_id ALREADY EXISTS from
      // migration 017 (REFERENCES campaigns(id)); the ONLY net-new column here is
      // stage_slug. Additive + nullable — non-ad tasks keep stage_slug NULL, so
      // this never touches existing rows or routes.
      //
      // REVERSIBILITY (this framework has no auto-down; it is purely additive so
      // leaving it in place is always safe). Manual rollback if ever required:
      //   DROP INDEX IF EXISTS idx_tasks_campaign_stage;
      //   DROP INDEX IF EXISTS idx_tasks_stage_slug;
      //   ALTER TABLE tasks DROP COLUMN stage_slug;   -- SQLite >= 3.35 (better-sqlite3 12.x bundles >= 3.45)
      //   DELETE FROM _migrations WHERE id = '074';
      console.log('[Migration 074] Adding tasks.stage_slug + ad-campaign indexes...');
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('stage_slug')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN stage_slug TEXT`);
      }
      // One card per (campaign_id, stage_slug); NULLs excluded so normal tasks never collide.
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_campaign_stage
               ON tasks(campaign_id, stage_slug)
               WHERE campaign_id IS NOT NULL AND stage_slug IS NOT NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_stage_slug
               ON tasks(stage_slug) WHERE stage_slug IS NOT NULL`);
      console.log('[Migration 074] tasks.stage_slug ready');
    },
  },
  {
    id: '076',
    name: 'widen_tasks_status_check_to_10_board_statuses',
    // LOCKSTEP FIX (VERIFY-B / kanban push-through): the base tasks table CHECK
    // (schema.ts) only permits 5 statuses — backlog, in_progress, review,
    // blocked, done. The 10-status board model (TaskStatus in src/lib/types.ts,
    // LEGAL_TRANSITIONS in task-lifecycle.ts, TaskStatus z.enum in validation.ts)
    // adds inbox, planning, pending_dispatch, assigned, testing. WITHOUT this
    // migration, any write of one of those 5 new statuses throws
    // SQLITE_CONSTRAINT at runtime (tsc is clean — a CHECK is a runtime gate, not
    // a compile-time one). Real, exercised write paths hit exactly this:
    //   • MissionQueue drag-to-todo  → UPDATE tasks SET status='assigned'  (FAILS)
    //   • planning poll / retry      → UPDATE tasks SET status='pending_dispatch'
    //   • recommendation intake      → status='inbox'
    // i.e. cards COULD NOT leave backlog — the exact "cards stall at the start"
    // failure. This brings the DB CHECK into lockstep with the type/validation
    // layer so jobs actually move backlog→…→done.
    //
    // SQLite cannot ALTER a CHECK, so we run the official 12-step table rebuild.
    // It is column-set-agnostic: it reads the LIVE CREATE TABLE sql from
    // sqlite_master and string-replaces ONLY the CHECK clause, so every column
    // added by earlier migrations (workspace_id, planning_*, campaign_id,
    // stage_slug, qc_reroute_attempts, …) is preserved automatically. Data is
    // copied via a dynamic column list (PRAGMA table_info) so old==new shape.
    // PRAGMA foreign_keys must be toggled OUTSIDE a transaction → no outer txn.
    useOuterTransaction: false,
    up: (db) => {
      const LEGACY_CHECK =
        "CHECK (status IN ('backlog', 'in_progress', 'review', 'blocked', 'done'))";
      const WIDENED_CHECK =
        "CHECK (status IN ('backlog', 'inbox', 'planning', 'pending_dispatch', 'assigned', 'in_progress', 'review', 'testing', 'blocked', 'done'))";

      const liveSql =
        (
          db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'",
            )
            .get() as { sql: string } | undefined
        )?.sql || '';

      // Idempotent + defensive: nothing to do if the legacy CHECK is already gone
      // (e.g. a future schema.ts ships the widened CHECK, or this already ran).
      if (!liveSql.includes(LEGACY_CHECK)) {
        console.log(
          '[Migration 076] tasks CHECK already widened (or table absent) — skip',
        );
        return;
      }

      console.log(
        '[Migration 076] Widening tasks.status CHECK to the 10 board statuses (12-step rebuild)...',
      );

      // Build the new table SQL: rename target to tasks_new in the header, widen
      // the CHECK. Both `CREATE TABLE tasks (` and `CREATE TABLE IF NOT EXISTS
      // tasks (` are handled.
      const newTableSql = liveSql
        .replace(/CREATE TABLE (IF NOT EXISTS )?tasks\b/, 'CREATE TABLE $1tasks_new')
        .replace(LEGACY_CHECK, WIDENED_CHECK);

      // Capture explicit indexes (named, with sql) + triggers so we can recreate
      // them on the rebuilt table. Auto-indexes (PK/UNIQUE) come back with the
      // CREATE TABLE itself.
      const indexes = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND sql IS NOT NULL",
          )
          .all() as { sql: string }[]
      ).map((r) => r.sql);
      const triggers = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='tasks' AND sql IS NOT NULL",
          )
          .all() as { sql: string }[]
      ).map((r) => r.sql);

      const cols = (
        db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
      ).map((c) => `"${c.name}"`);
      const colList = cols.join(', ');

      // 12-step ALTER (https://sqlite.org/lang_altertable.html#otheralter):
      db.exec('PRAGMA foreign_keys=OFF;');
      const tx = db.transaction(() => {
        db.exec(newTableSql);
        db.exec(`INSERT INTO tasks_new (${colList}) SELECT ${colList} FROM tasks;`);
        db.exec('DROP TABLE tasks;');
        db.exec('ALTER TABLE tasks_new RENAME TO tasks;');
        for (const sql of indexes) db.exec(sql + ';');
        for (const sql of triggers) db.exec(sql + ';');
        // foreign_key_check must pass before we re-enable enforcement.
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(
            `[Migration 076] foreign_key_check found ${violations.length} violation(s) after tasks rebuild — aborting`,
          );
        }
      });
      tx();
      db.exec('PRAGMA foreign_keys=ON;');

      console.log(
        '[Migration 076] tasks.status CHECK widened to 10 statuses; all columns + indexes preserved',
      );
    },
  },
  {
    id: '077',
    name: 'add_dispatch_attempt_accounting',
    up: (db) => {
      // W8.2 anti-furnace: per-task dispatch attempt-accounting so an
      // unadvanceable task is NEVER re-fired every 2-5 min forever.
      //   dispatch_attempts        — incremented on every FAILED advance attempt
      //                              (gateway down / sovereignty / no-runtime);
      //                              reset to 0 on a successful advance.
      //   last_dispatch_attempt_at — wall-clock of the most recent attempt.
      //   next_dispatch_eligible_at — exponential-backoff gate; a task is not
      //                              re-selected/re-fired until now >= this.
      // All additive + nullable; non-dispatch rows keep them NULL. The
      // intake-advance / backlog-redispatch sweeps filter on these so the
      // furnace can't reignite.
      console.log('[Migration 077] Adding tasks dispatch attempt-accounting columns...');
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('dispatch_attempts')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN dispatch_attempts INTEGER DEFAULT 0`);
      }
      if (!cols.includes('last_dispatch_attempt_at')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN last_dispatch_attempt_at TEXT`);
      }
      if (!cols.includes('next_dispatch_eligible_at')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN next_dispatch_eligible_at TEXT`);
      }
      // Partial index so the sweeps' "eligible now" scan stays cheap.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_next_dispatch_eligible
               ON tasks(next_dispatch_eligible_at) WHERE next_dispatch_eligible_at IS NOT NULL`);
      console.log('[Migration 077] dispatch attempt-accounting columns ready');
    },
  },
  {
    id: '078',
    name: 'add_block_reason',
    up: (db) => {
      // W8 fix (v4.55.1): recordDispatchFailure's block-on-N UPDATE path and the
      // QC-scorer's QC-BLOCKED UPDATE path both write `block_reason = ?`. Migration
      // 077 added the three dispatch-attempt-accounting columns but omitted
      // block_reason. Without this column the UPDATE throws SQLITE_ERROR "no such
      // column: block_reason"; the throw is caught and swallowed → the task is
      // NEVER transitioned to 'blocked', NEVER notifies the owner, and the attempt
      // counter stalls at MAX_DISPATCH_ATTEMPTS - 1 causing an infinite re-loop on
      // every backoff window.
      //
      // Idempotent: PRAGMA table_info guard before ALTER so this is safe on fresh
      // installs (schema.ts may pre-create the column in future) AND on existing
      // DBs that already ran migration 077.
      console.log('[Migration 078] Adding tasks.block_reason column...');
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('block_reason')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN block_reason TEXT`);
        console.log('[Migration 078] block_reason column added');
      } else {
        console.log('[Migration 078] block_reason already present — skipping');
      }
    },
  },
  {
    id: '079',
    name: 'ensure_tasks_stage_slug',
    up: (db) => {
      // Self-heal for a migration-ID-074 collision. An earlier source revision
      // numbered a now-removed migration as id '074'; the current source assigns
      // id '074' to `add_tasks_stage_slug_for_ad_campaigns`. Because the runner
      // keys applied-state on id alone (`_migrations.id`), any DB that recorded
      // the OLD 074 will SKIP the current 074 forever — so `tasks.stage_slug`
      // (and its two indexes) never get created on those DBs.
      //
      // The visible failure is identical in class to migration 056 (sop_id) and
      // 078 (block_reason): the ad-campaign assembly-line INSERT in
      // `src/lib/ad-campaigns.ts` writes `stage_slug`, so on an affected DB it
      // throws SQLITE_ERROR "table tasks has no column named stage_slug" → the
      // ad-run card-create path 500s.
      //
      // This migration carries a NEW id (079) so it always runs on the affected
      // DBs, and is fully idempotent (PRAGMA table_info guard + IF NOT EXISTS on
      // both indexes) so it is a no-op on DBs that already have the column from
      // migration 074. Additive + nullable — never touches existing rows/routes.
      // Mirrors migration 074's body exactly.
      console.log('[Migration 079] Ensuring tasks.stage_slug column + ad-campaign indexes exist...');
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('stage_slug')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN stage_slug TEXT`);
        console.log('[Migration 079] tasks.stage_slug column added (074 id-collision repaired)');
      } else {
        console.log('[Migration 079] tasks.stage_slug already present — ensuring indexes only');
      }
      // One card per (campaign_id, stage_slug); NULLs excluded so normal tasks never collide.
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_campaign_stage
               ON tasks(campaign_id, stage_slug)
               WHERE campaign_id IS NOT NULL AND stage_slug IS NOT NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_stage_slug
               ON tasks(stage_slug) WHERE stage_slug IS NOT NULL`);
      console.log('[Migration 079] tasks.stage_slug ready');
    },
  },
  {
    id: '080',
    name: 'add_tasks_process_certificate_sha',
    up: (db) => {
      // FIX C (CC done-gate): the Presentations no-skip proof certificate
      // (`prove-deck.py` → PROCESS-CERTIFICATE.json) is enforced at the board by
      // requiring a matching `process_certificate_sha` before a presentations
      // task may move to done/delivered (see src/app/api/tasks/[id]/route.ts).
      // This column STORES the certificate sha registered with the deck run so
      // the gate can both require it and verify the mover presents the same one.
      //
      // Additive + nullable: every non-presentations task and every legacy row
      // keeps NULL and is unaffected. Idempotent PRAGMA guard so it is a no-op on
      // fresh installs and on DBs that already have it.
      console.log('[Migration 080] Adding tasks.process_certificate_sha column...');
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('process_certificate_sha')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN process_certificate_sha TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_process_cert
                 ON tasks(process_certificate_sha) WHERE process_certificate_sha IS NOT NULL`);
        console.log('[Migration 080] process_certificate_sha column added');
      } else {
        console.log('[Migration 080] process_certificate_sha already present — skipping');
      }
    },
  },
  {
    id: '081',
    name: 'dedupe_canonical_workspaces',
    // INGEST-07: destructive workspace merge — defer during additive-only self-heal.
    deferInAdditiveSelfHeal: true,
    up: (db) => {
      // FM-6 (board single-source): de-dup workspace rows that canonicalize to the
      // SAME department (e.g. `ceo` + `master-orchestrator`, `app-development` +
      // `engineering`). Each duplicate split one department across two Kanban
      // columns and two agent rosters. The keeper is the canonical-slug row;
      // agents/tasks/all workspace_id-bearing rows are reassigned to it and the
      // duplicate rows are deleted. Idempotent — a clean board is left untouched.
      console.log('[Migration 081] De-duplicating canonical workspace rows...');
      const r = dedupeCanonicalWorkspaces(db);
      console.log(
        `[Migration 081] merged ${r.groups_merged} group(s), deleted ${r.rows_deleted} duplicate row(s), reassigned ${r.rows_reassigned} referencing row(s)`,
      );
    },
  },
  {
    id: '082',
    name: 'reap_duplicate_open_authoring_tasks',
    // INGEST-07: destructive task reap — defer during additive-only self-heal.
    deferInAdditiveSelfHeal: true,
    up: (db) => {
      // FM-6b (furnace heal): collapse the duplicate open "Author SOP: …" sub-tasks
      // the SOP-authoring fast loop re-created on every dispatch sweep (300+ stuck
      // in_progress on the affected box). Keeps the oldest of each group and
      // FK-safely deletes the spurious clones. The matching RUNTIME idempotency
      // guard (src/lib/sop-authoring.ts) prevents new duplicates from forming.
      console.log('[Migration 082] Reaping duplicate open "Author SOP" tasks...');
      const r = reapDuplicateOpenAuthoringTasks(db);
      console.log(`[Migration 082] reaped ${r.deleted} duplicate task(s) across ${r.groups} group(s)`);
    },
  },
  {
    id: '083',
    name: 'add_task_persona_fallback',
    up: (db) => {
      // Point 10 fix 1: resolvePersonaAndPin now pins a deterministic
      // department-default persona when the selector exhausts its attempts, so
      // no task is ever personaless. This boolean flags those defaulted pins for
      // audit (vs a genuine matched persona). Idempotent ADD COLUMN.
      const tasksInfo = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
      if (!tasksInfo.find((c) => c.name === 'persona_fallback')) {
        db.prepare('ALTER TABLE tasks ADD COLUMN persona_fallback INTEGER DEFAULT 0').run();
      }
      console.log('[Migration 083] tasks.persona_fallback audit column ready');
    },
  },
  {
    id: '084',
    name: 'add_task_redispatch_count',
    up: (db) => {
      // Point 6 fix 2: backlog-redispatch-sweep counts its own cheap retries here
      // so a permanently-stuck-in-backlog task (config problem / SOP-authoring hold
      // that never clears — paths that never go through recordDispatchFailure) is
      // eventually escalated to `blocked` after REDISPATCH_MAX_ATTEMPTS retries over
      // REDISPATCH_ESCALATE_HOURS, instead of re-looping forever. Idempotent.
      const tasksInfo = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
      if (!tasksInfo.find((c) => c.name === 'redispatch_count')) {
        db.prepare('ALTER TABLE tasks ADD COLUMN redispatch_count INTEGER DEFAULT 0').run();
      }
      console.log('[Migration 084] tasks.redispatch_count accounting column ready');
    },
  },
  {
    id: '085',
    name: 'create_sop_feedback',
    up: (db) => {
      // ISSUE #5 (audit 2026-07-03): the SOP feedback/learning loop was dead on
      // arrival — src/app/api/sops/feedback/route.ts and src/lib/sop-learning.ts
      // read/write `sop_feedback`, but no CREATE TABLE existed anywhere, so the
      // endpoint 500'd with "no such table: sop_feedback" and recordFeedback ->
      // detectPatternsAndPropose never fired.
      //
      // Columns are the EXACT set the code touches:
      //   recordFeedback INSERT (sop-learning.ts:110): id, sop_id, task_id, rating, notes, agent_id
      //   SOPFeedbackRow (sop-learning.ts:20-28):      + created_at
      //   route.ts:27 validates rating in [1, -1, 0]  -> rating is an INTEGER
      //     (1 = thumbs up, -1 = thumbs down, 0 = skip), NOT a text enum.
      // created_at is not written by recordFeedback, so it carries a DEFAULT.
      // Idempotent: IF NOT EXISTS so this is safe on fresh installs and re-runs.
      console.log('[Migration 085] Creating sop_feedback table...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS sop_feedback (
          id TEXT PRIMARY KEY,
          sop_id TEXT NOT NULL REFERENCES sops(id) ON DELETE CASCADE,
          task_id TEXT,
          agent_id TEXT,
          rating INTEGER NOT NULL CHECK (rating IN (1, -1, 0)),
          notes TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
      // computePerformance() filters `WHERE sop_id = ? AND created_at >= ?` and
      // the GET route orders by created_at DESC — a (sop_id, created_at) index
      // covers both. task_id is filtered alone by the GET dedupe check.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sop_feedback_sop ON sop_feedback(sop_id, created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sop_feedback_task ON sop_feedback(task_id)`);
      console.log('[Migration 085] sop_feedback table + indexes ready');
    },
  },
  {
    id: '086',
    name: 'remove_demo_seed_rows',
    up: (db) => {
      // ISSUE #1 (audit 2026-07-03): older installs (and every pre-fix
      // `--update-only` pass) ran the unguarded seed which (a) inserted a NEW
      // master Orchestrator every time and (b) defaulted to demo agents/tasks/
      // conversations on the client's real board. seed.ts is now guarded +
      // demo-opt-in, but boxes provisioned before the fix already carry the
      // contamination. This migration cleans it up idempotently.
      //
      // Safe to re-run: after the first pass there is exactly one master and no
      // demo rows, so every subsequent run is a no-op. Wrapped section-by-section
      // in try/catch (mirrors migration 030) so an edge case can never brick
      // app startup.
      console.log('[Migration 086] De-duping masters + removing legacy demo seed rows...');

      // Discover every column that FK-references agents(id), with its ON DELETE
      // action, so we can repoint/detach robustly instead of hardcoding a list
      // that drifts as the schema grows.
      const agentRefs: { table: string; column: string; onDelete: string }[] = [];
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[];
        for (const t of tables) {
          const fks = db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as {
            table: string;
            from: string;
            on_delete: string;
          }[];
          for (const fk of fks) {
            if (fk.table === 'agents') {
              agentRefs.push({ table: t.name, column: fk.from, onDelete: (fk.on_delete || '').toUpperCase() });
            }
          }
        }
      } catch (e) {
        console.log('[Migration 086] FK discovery skipped:', (e as Error).message);
      }

      // Repoint every reference to `fromId` onto `toId`. OR IGNORE survives the
      // handful of refs with a UNIQUE/PK on the agent column (e.g.
      // conversation_participants PK, agent_memory_logs UNIQUE); any row that
      // could not be repointed still points at fromId and is cleaned up by the
      // subsequent DELETE (those refs are ON DELETE CASCADE).
      const repointAgent = (fromId: string, toId: string) => {
        for (const r of agentRefs) {
          db.prepare(`UPDATE OR IGNORE "${r.table}" SET "${r.column}" = ? WHERE "${r.column}" = ?`).run(toId, fromId);
        }
      };

      // Detach an agent about to be deleted: NULL out only the RESTRICT/NO ACTION
      // refs (those columns are all nullable). CASCADE / SET NULL / SET DEFAULT
      // refs are handled by the DB on DELETE.
      const detachAgent = (id: string) => {
        for (const r of agentRefs) {
          if (r.onDelete === 'CASCADE' || r.onDelete === 'SET NULL' || r.onDelete === 'SET DEFAULT') continue;
          db.prepare(`UPDATE "${r.table}" SET "${r.column}" = NULL WHERE "${r.column}" = ?`).run(id);
        }
      };

      // 1) De-dupe masters — keep the OLDEST is_master=1 'Orchestrator', re-point
      //    every FK from the duplicates onto the keeper, then delete the dupes.
      try {
        const masters = db
          .prepare(
            "SELECT id FROM agents WHERE is_master = 1 AND name = 'Orchestrator' ORDER BY datetime(created_at) ASC, id ASC"
          )
          .all() as { id: string }[];
        if (masters.length > 1) {
          const keeper = masters[0].id;
          for (const dup of masters.slice(1)) {
            repointAgent(dup.id, keeper);
            db.prepare('DELETE FROM agents WHERE id = ?').run(dup.id);
          }
          console.log(`[Migration 086] Collapsed ${masters.length} masters -> 1 (kept ${keeper})`);
        } else {
          console.log('[Migration 086] Master orchestrator already unique — nothing to de-dupe');
        }
      } catch (e) {
        console.log('[Migration 086] Master de-dupe skipped:', (e as Error).message);
      }

      // 2) Remove demo content — ONLY when a real (non-placeholder) company row
      //    exists, so a genuine demo deployment is left untouched. Same
      //    real-company predicate as migration 030.
      try {
        const real = db
          .prepare(
            "SELECT COUNT(*) AS c FROM companies WHERE slug NOT IN ('default','command-center') AND slug NOT LIKE 'acme-%'"
          )
          .get() as { c: number };
        if (real.c > 0) {
          // 2a) Demo agents (Developer/Researcher/Writer/Designer, on-call,
          //     non-master) that never did real work (no completed tasks).
          const demoAgentNames = ['Developer', 'Researcher', 'Writer', 'Designer'];
          let removedAgents = 0;
          for (const name of demoAgentNames) {
            const rows = db
              .prepare("SELECT id FROM agents WHERE name = ? AND specialist_type = 'on-call' AND is_master = 0")
              .all(name) as { id: string }[];
            for (const row of rows) {
              const done = db
                .prepare("SELECT COUNT(*) AS c FROM tasks WHERE assigned_agent_id = ? AND status = 'done'")
                .get(row.id) as { c: number };
              if (done.c > 0) continue; // has real completed work — keep it
              detachAgent(row.id);
              db.prepare('DELETE FROM agents WHERE id = ?').run(row.id);
              removedAgents++;
            }
          }

          // 2b) The 4 seeded demo tasks — scoped to the demo business_id so a
          //     real client task that happens to share a title is never touched.
          const demoTaskTitles = [
            'Set up development environment',
            'Create project documentation',
            'Research competitor features',
            'Design new dashboard layout',
          ];
          let removedTasks = 0;
          for (const title of demoTaskTitles) {
            const res = db
              .prepare("DELETE FROM tasks WHERE title = ? AND business_id = 'default'")
              .run(title);
            removedTasks += res.changes;
          }

          // 2c) The demo "Team Chat" group conversation (+ its messages and
          //     participant rows).
          let removedConvos = 0;
          const convos = db
            .prepare("SELECT id FROM conversations WHERE title = 'Team Chat' AND type = 'group'")
            .all() as { id: string }[];
          for (const c of convos) {
            db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.id);
            db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ?').run(c.id);
            db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
            removedConvos++;
          }

          console.log(
            `[Migration 086] Real company present — removed ${removedAgents} demo agent(s), ${removedTasks} demo task(s), ${removedConvos} demo conversation(s)`
          );
        } else {
          console.log('[Migration 086] No real company yet — leaving any demo content in place');
        }
      } catch (e) {
        console.log('[Migration 086] Demo cleanup skipped:', (e as Error).message);
      }
    },
  },
  {
    id: '087',
    name: 'add_interview_sessions',
    up: (db) => {
      // Wave 5 (AI Workforce Interview APP): a READ-MIRROR / fast-UI index for the
      // /interview surface. The FILES stay the single source of truth — the three
      // canonical artifacts (.workforce-build-state.json, workforce-interview-
      // answers.md, interview-handoff.md) are written ONLY through the Skill-23
      // shell scripts. These two tables are NEVER a write authority for
      // interviewComplete or for canonicalReconciliation.decisions; they only
      // cache what the canonical files already say so the UI can render progress /
      // an answer list without re-parsing on every request. If the mirror and the
      // files ever disagree, the FILES WIN (same posture as department-floor.py) —
      // src/lib/interview/store.ts reconciles from the files, never the reverse.
      console.log('[Migration 087] Adding interview_sessions + interview_answers mirror tables...');

      // interview_sessions — one row per interviewSessionId (the stable id the
      // seam persists into build-state). status/phase/percent are UI-facing mirror
      // fields derived from the handoff + build-state; NONE of them is authoritative.
      db.exec(`
        CREATE TABLE IF NOT EXISTS interview_sessions (
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
        )
      `);

      // interview_answers — a mirror of the Q/A blocks that live (canonically) in
      // workforce-interview-answers.md. `provenance` mirrors any provenance note
      // (e.g. confirmed-from-context / updated-on) captured in the file. UNIQUE on
      // (session_id, question_number) so a re-answer/edit upserts the same row
      // rather than duplicating it.
      db.exec(`
        CREATE TABLE IF NOT EXISTS interview_answers (
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
        )
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_interview_sessions_status ON interview_sessions(status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_interview_sessions_client ON interview_sessions(client_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_interview_answers_session ON interview_answers(session_id, question_number)`);

      console.log('[Migration 087] interview_sessions + interview_answers ready');
    },
  },
  {
    id: '088',
    name: 'add_task_subtask_persona',
    up: (db) => {
      // DEP-5 / findings F3.7 + F3.9 — wire multi-persona decomposition into the CC.
      //
      // `decompose-task.py --combined` (the matcher-side engine) picks a best-fit
      // persona PER sub-task and writes one row per sub-task into
      // `task_subtask_persona`, keyed (task_id, seq). The table is the row source
      // the kanban card (slot chips) and the dispatcher (PERSONA PLAN block) read.
      //
      // Schema is EXACTLY `_SUBTASK_PERSONA_DDL` (decompose-task.py) plus:
      //   - a `slot` column (F3.9 SOP persona slots — which declared slot filled
      //     this sub-task; NULL for pure text-decomposition sub-tasks), and
      //   - an index on task_id (the only lookup key the readers use).
      //
      // The decompose script ships its OWN defensive `CREATE TABLE IF NOT EXISTS`
      // (with the base columns, no `slot`) for hand-run CLI use, so the table may
      // already exist on a box where someone ran the CLI before this migration.
      // We therefore (a) CREATE IF NOT EXISTS with the full schema for a fresh DB,
      // then (b) ALTER-add `slot` when an older CLI-created table lacks it. Both
      // steps are idempotent — the DDL tolerates a table with extra columns and the
      // script's explicit-column INSERT never writes `slot`, so the two converge.
      console.log('[Migration 088] Adding task_subtask_persona (multi-persona plan rows)...');

      db.exec(`
        CREATE TABLE IF NOT EXISTS task_subtask_persona (
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
        )
      `);

      // Older CLI-created table (script DDL has no `slot`) → add it. Additive,
      // nullable, never touches existing rows.
      const cols = db.prepare("PRAGMA table_info(task_subtask_persona)").all() as { name: string }[];
      if (!cols.some((c) => c.name === 'slot')) {
        db.prepare('ALTER TABLE task_subtask_persona ADD COLUMN slot TEXT').run();
      }

      db.prepare('CREATE INDEX IF NOT EXISTS idx_subtask_persona_task ON task_subtask_persona(task_id)').run();

      console.log('[Migration 088] task_subtask_persona + idx_subtask_persona_task ready');
    },
  },
];

/**
 * Run all pending migrations
 */
// DATA-02: id of the migration that most recently threw inside runMigrations().
// Set only in the per-migration catch below; reset to null at the start of every
// runMigrations() pass (a run either completes fully or throws). The DB barrel
// (getDbInitFailure) and the /api/health route read this to surface a precise
// "migration <N> failed" 503 instead of a generic degraded state.
let lastFailedMigrationId: string | null = null;

/**
 * The id of the migration that failed during the most recent runMigrations()
 * pass, or null if migrations last completed cleanly (or never ran). Exported
 * via the db barrel (src/lib/db/index.ts) so the health surface can name the
 * exact failing migration. DATA-02.
 */
export function getLastFailedMigrationId(): string | null {
  return lastFailedMigrationId;
}

export function runMigrations(db: Database.Database): void {
  // DATA-02: clear any prior failure marker — this pass either completes fully
  // or re-sets it in the catch below.
  lastFailedMigrationId = null;

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

  // INGEST-07: the request-time schema self-heal sets this flag so ONLY additive
  // schema DDL is applied — destructive data migrations (dedup/reap/merge) that
  // would race live ingest are DEFERRED (skipped without recording) and run on
  // the next controlled boot.
  const additiveOnlySelfHeal =
    process.env.OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY === '1';

  for (const migration of ordered) {
    if (applied.has(migration.id)) {
      continue;
    }

    if (additiveOnlySelfHeal && migration.deferInAdditiveSelfHeal) {
      console.warn(
        `[DB] Migration ${migration.id} (${migration.name}) DEFERRED — ` +
          `OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY set (destructive migration not run during ` +
          `request-time self-heal; stays pending for the next controlled boot).`,
      );
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
      // DATA-02: record WHICH migration failed before re-throwing so getDb()'s
      // failure capture (and the /api/health 503) can name it precisely.
      lastFailedMigrationId = migration.id;
      console.error(`[DB] Migration ${migration.id} failed:`, error);
      throw error;
    }
  }

  // Auto-seed from departments.json if workspaces table is empty
  autoSeedFromDepartmentsJson(db);

  // PRD 2.11: Ensure the trio (QC + research + DA) exists for every workspace.
  // This covers the case where migration 065 ran before any workspaces existed
  // (autoSeedFromDepartmentsJson may have just created them above). Idempotent.
  autoSeedTrioAgents(db);

  // Auto-seed the starter SOP library (B6). Chained here — the same first-boot /
  // DB-init path where the Skill-23 workspace auto-seed runs — so the role
  // library (workspaces/agents) AND the SOPs load together exactly where the
  // client runs Skill 23. Previously the SOPs loaded ONLY via the manual
  // `npm run db:seed:sops` script, so a fresh box had an empty SOP table and the
  // Triad Rule silently blocked every task. seedStarterSOPs is idempotent
  // (skips existing slugs) so it is safe on every boot.
  autoSeedStarterSOPs(db);
}

/**
 * Auto-seed the department trio (QC + research + Devil's Advocate) for every
 * workspace that does not yet have all three role_type rows.
 *
 * PRD 2.11 (CC side): called from runMigrations() (after migration 065) AND
 * from autoSeedFromDepartmentsJson() so that any workspace created on first-boot
 * also gets its trio immediately, even when migration 065 ran before workspaces
 * existed.
 *
 * Idempotent: INSERT OR IGNORE on deterministic ids.
 * Non-fatal: any error is logged but never crashes app startup.
 *
 * Devil's Advocate invariant: role_type='devils-advocate' agents are INTERNAL.
 * They are seeded here but are NEVER returned by any client-facing query; the
 * resolveTrioAgents() function in qc-scorer.ts is the only resolver, and
 * dispatch logic that needs the DA must call that function, not query agents
 * directly, to preserve the "never surface to client" contract.
 */
export function autoSeedTrioAgents(db: Database.Database): void {
  try {
    // Guard: role_type column must exist (migration 060).
    const agentCols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(c => c.name);
    if (!agentCols.includes('role_type')) {
      // Pre-migration-060 DB — trio will seed when migration 060 + 065 run.
      return;
    }

    const workspaces = db.prepare('SELECT id, name FROM workspaces').all() as { id: string; name: string }[];
    if (workspaces.length === 0) return;

    const insertResearch = db.prepare(`
      INSERT OR IGNORE INTO agents
        (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
         specialist_type, role_type, created_at, updated_at)
      VALUES (?, ?, 'Research Specialist', ?, '🔬', 'standby', 0, ?, 'permanent', 'research', datetime('now'), datetime('now'))
    `);

    const insertDA = db.prepare(`
      INSERT OR IGNORE INTO agents
        (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
         specialist_type, role_type, created_at, updated_at)
      VALUES (?, ?, 'Devil''s Advocate', ?, '😈', 'standby', 0, ?, 'permanent', 'devils-advocate', datetime('now'), datetime('now'))
    `);

    let count = 0;
    for (const ws of workspaces) {
      const researchName = `${ws.name} Research Specialist`;
      const researchDesc = `Deep-research specialist for the ${ws.name} department. Applies the Tier-1 research mandate (McKinsey, Harvard Business Review, IBISWorld, Statista citations required) to discover, synthesise, and validate information needed by the department's specialists and SOP library.`;
      insertResearch.run(`research-agent-${ws.id}`, researchName, researchDesc, ws.id);

      const daName = `${ws.name} Devil's Advocate`;
      // DA description is intentionally operator-facing only — never shown in client UI.
      const daDesc = `[INTERNAL — not surfaced to client] Devil's Advocate for the ${ws.name} department. Stress-tests plans, decisions, and deliverables by surfacing assumptions, edge cases, and counter-arguments BEFORE they become problems. Reports findings only to the department's QC Specialist and the master orchestrator.`;
      insertDA.run(`da-agent-${ws.id}`, daName, daDesc, ws.id);
      count++;
    }

    if (count > 0) {
      console.log(`[Auto-seed Trio] Seeded/verified Research + Devil's Advocate for ${count} workspace(s)`);
    }
  } catch (err) {
    // Non-fatal: log and continue.
    console.log('[Auto-seed Trio] Skipped:', (err as Error).message);
  }
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

// ── departments.json / departments-tree resolution (G12-FLOOR-CC-SEED) ───────
// The historic reader path-list (below) only checked a handful of hard-coded
// install locations and EXCLUDED (a) the running Command Center's own root and
// (b) the canonical Zero-Human-Company company folder the floor materializes to
// (~/clawd/zero-human-company/<slug>/ and the master_files mirror). On a freshly
// built client box that meant converge found NO departments.json, seeded ZERO
// workspaces, and every job stalled on the CEO in backlog (no depts → routeTask
// had nothing to route to). These resolvers add a robust, ADDITIVE candidate set
// so converge finds whatever the writer (Skill-23 build-workforce.py) dropped.
//
// The env-var names below are coordinated with the writer:
//   BLACKCEO_COMMAND_CENTER_ROOT — the writer's copy_departments_to_command_center()
//                                  drops departments.json into <root>/config.
//   ZERO_HUMAN_COMPANY_DIR        — absolute path to the active company's ZHC
//                                  folder (<…>/zero-human-company/<slug>).
//   MASTER_FILES_DIR              — the writer's canonical master-files root.

const DEPARTMENTS_JSON = 'departments.json';

function isExistingFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExistingDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Legacy hard-coded install locations (preserved verbatim, additive). */
function legacyConfigCandidates(): string[] {
  return [
    path.join(os.homedir(), 'clawd', 'projects', 'blackceo-command-center', 'config', DEPARTMENTS_JSON),
    path.join(os.homedir(), 'projects', 'mission-control', 'config', DEPARTMENTS_JSON),
    path.join(os.homedir(), 'Downloads', 'openclaw-master-files', 'company-discovery', DEPARTMENTS_JSON),
    path.join('/opt', 'mission-control', 'config', DEPARTMENTS_JSON),
  ];
}

/** Parent roots the writer materializes per-company ZHC folders under. */
export function zeroHumanCompanyRoots(): string[] {
  const roots: string[] = [];
  const masterFiles = (process.env.MASTER_FILES_DIR || '').trim();
  if (masterFiles) roots.push(path.join(masterFiles, 'zero-human-company'));
  roots.push(
    path.join(os.homedir(), 'Downloads', 'openclaw-master-files', 'zero-human-company'),
    '/data/openclaw-master-files/zero-human-company',
    path.join(os.homedir(), 'clawd', 'zero-human-company')
  );
  return roots;
}

/**
 * Find the newest <root>/<slug>/<rel> across every ZHC root (by mtime). This is
 * what lets a freshly-built client box converge even when the writer could not
 * reach the CC config dir — the company folder is always written.
 */
function newestZhcChild(rel: string): string | null {
  let best: { p: string; mtime: number } | null = null;
  for (const root of zeroHumanCompanyRoots()) {
    let slugs: string[];
    try {
      slugs = fs.readdirSync(root);
    } catch {
      continue; // root absent
    }
    for (const slug of slugs) {
      const candidate = path.join(root, slug, rel);
      let st: fs.Stats;
      try {
        st = fs.statSync(candidate);
      } catch {
        continue;
      }
      if (!best || st.mtimeMs > best.mtime) best = { p: candidate, mtime: st.mtimeMs };
    }
  }
  return best ? best.p : null;
}

/**
 * Resolve the active departments.json from the robust candidate set. Returns the
 * first existing file from the ordered candidate list, else null.
 *
 * Priority order (highest → lowest):
 *   1. ZERO_HUMAN_COMPANY_DIR env — explicit active-company folder.
 *   2. BLACKCEO_COMMAND_CENTER_ROOT env — explicit CC root.
 *   3. Newest ZHC company build discovered on disk — a real client's
 *      departments.json written by the build process; preferred over the
 *      repo-committed template so a freshly-built client never seeds the
 *      17-demo generic defaults.
 *   4. process.cwd()/config (or /data) — the repo-committed template; only
 *      wins when no real company build exists on disk.
 *   5. Legacy hard-coded install locations (preserved verbatim).
 */
export function resolveDepartmentsConfigPath(): string | null {
  const explicitCompany = (process.env.ZERO_HUMAN_COMPANY_DIR || '').trim();
  const ccRoot = (process.env.BLACKCEO_COMMAND_CENTER_ROOT || '').trim();
  const candidates: string[] = [];

  // 1. Explicit active-company folder — the strongest signal of the live client.
  if (explicitCompany) candidates.push(path.join(explicitCompany, DEPARTMENTS_JSON));
  // 2. Explicit Command Center root (same env the writer's CC copy honors).
  if (ccRoot) {
    candidates.push(
      path.join(ccRoot, 'config', DEPARTMENTS_JSON),
      path.join(ccRoot, 'data', DEPARTMENTS_JSON),
      path.join(ccRoot, DEPARTMENTS_JSON)
    );
  }
  // 3. Discovered real ZHC company build — probed BEFORE the repo-committed
  //    template so the newest client departments.json takes precedence over
  //    the 17-demo config/departments.json checked into the repo.
  const zhcBuild = newestZhcChild(DEPARTMENTS_JSON);
  if (zhcBuild) candidates.push(zhcBuild);
  // 4. The running Command Center itself (process.cwd() === CC root in prod).
  //    Falls AFTER the real company build so the repo template is only a
  //    last-resort fallback, never shadowing a real client's departments.json.
  candidates.push(
    path.join(process.cwd(), 'config', DEPARTMENTS_JSON),
    path.join(process.cwd(), 'data', DEPARTMENTS_JSON)
  );
  // 5. Legacy hard-coded install locations (preserved verbatim).
  candidates.push(...legacyConfigCandidates());

  for (const p of candidates) {
    if (isExistingFile(p)) return p;
  }
  return null;
}

/**
 * The on-disk departments/ TREE (role how-to.md files) that pairs with the
 * resolved departments.json, so converge imports SOPs from the SAME company the
 * workspaces seed from (keeps Gap C workspaces and Gap D SOPs in lockstep).
 * Returns null when no tree is found (the caller then falls back to the
 * role-library importer's own OPENCLAW_WORKSPACE_PATH default — never throws).
 */
export function resolveDepartmentsTreePath(): string | null {
  const explicitCompany = (process.env.ZERO_HUMAN_COMPANY_DIR || '').trim();
  if (explicitCompany) {
    const tree = path.join(explicitCompany, 'departments');
    if (isExistingDir(tree)) return tree;
  }
  // Sibling of the resolved departments.json: <company>/departments.json →
  // <company>/departments. (For CC-config / company-discovery locations the
  // sibling won't exist, so this falls through harmlessly.)
  const cfg = resolveDepartmentsConfigPath();
  if (cfg) {
    const sibling = path.join(path.dirname(cfg), 'departments');
    if (isExistingDir(sibling)) return sibling;
  }
  const newest = newestZhcChild('departments');
  if (newest && isExistingDir(newest)) return newest;
  return null;
}

/**
 * Is this departments.json entry EXPLICITLY opted out?
 *
 * The floor invariant is: displayed departments == chosen manifest MINUS any
 * explicitly opted-out department. A client can decline a department the
 * interview otherwise offered (the interview seam calls these "declined"); when
 * that decision is carried into the manifest as an explicit flag rather than by
 * omission, the seed MUST NOT give it a Kanban lane. This predicate recognises
 * every explicit opt-out spelling so the seed and the QC gate agree:
 *   { optOut: true } | { opted_out: true } | { enabled: false } | { active: false }
 *   | { status: "opted-out" | "opted_out" | "declined" | "disabled" | "inactive" }
 * A plain manifest entry (no flag) is NOT opted out — omission is the usual path.
 */
export function isDepartmentOptedOut(dept: unknown): boolean {
  if (!dept || typeof dept !== 'object') return false;
  const d = dept as Record<string, unknown>;
  if (d.optOut === true || d.opted_out === true) return true;
  if (d.enabled === false || d.active === false) return true;
  const status = typeof d.status === 'string' ? d.status.trim().toLowerCase() : '';
  if (['opted-out', 'opted_out', 'declined', 'disabled', 'inactive'].includes(status)) return true;
  return false;
}

/**
 * Re-seed workspaces from departments.json + build-state — the SINGLE idempotent
 * upsert used by BOTH the every-boot path (autoSeedFromDepartmentsJson) and the
 * converge endpoint (POST /api/system/converge). Runs on every boot/converge so
 * manifest GROWTH (a department added after first boot) re-syncs instead of being
 * stranded by a first-boot-only guard.
 *
 * Floor invariant (enforced here + at the board query in /api/workspaces):
 *   for the active company, displayed departments == chosen manifest − opt-outs.
 *
 * Guarantees:
 *   • Idempotent UPSERT keyed on dept id — re-running never duplicates a lane.
 *   • Additive / NON-DESTRUCTIVE — INSERT missing depts, UPDATE display fields +
 *     company_id; NEVER deletes a workspace or any task/agent data.
 *   • Company attribution — every chosen dept is (re-)homed to the ACTIVE company
 *     resolved by seedCompanyGuarded (mirrors sync-departments-from-build-state.py),
 *     so the active-company board filter never hides a chosen lane.
 *   • Fail-closed — a template / partial company-config aborts the reseed rather
 *     than mis-attributing departments to a bogus fallback company.
 *   • Opt-outs honored — an explicitly opted-out dept never gets a lane.
 *
 * Returns counts of created + updated rows.
 */
export function reseedWorkspacesFromConfig(
  db: Database.Database,
  opts: { force: boolean } = { force: true }
): { created: number; updated: number } {
  void opts; // reserved; the upsert is always idempotent so `force` is a no-op today
  let created = 0;
  let updated = 0;

  try {
    const configPath = resolveDepartmentsConfigPath();

    if (!configPath) {
      console.warn('[reseed] No departments.json found — skipping workspace reseed');
      return { created, updated };
    }
    console.log('[reseed] Using departments.json:', configPath);

    const depts = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!Array.isArray(depts) || depts.length === 0) return { created, updated };

    // Ensure company row exists / resolve the ACTIVE company. seedCompanyGuarded
    // returns partial-config for a blank OR unpopulated-template ("Your Company")
    // company-config — in which case we FAIL CLOSED: do not seed departments under
    // a fallback company (that is the attribution-drift bug this guards against).
    const seedResult = seedCompanyGuarded(db);
    if (seedResult.reason === 'partial-config') {
      console.warn('[reseed] Aborting workspace reseed: partial/template company config (fail-closed, no mis-attribution)');
      return { created, updated };
    }
    // Pin every seeded dept to the resolved active company id (re-homes rows that
    // were created under the pre-064 'default' sentinel or a stale company_id).
    const companyId = seedResult.companyId ?? 'default';

    const upsertStmt = db.prepare(`
      INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        slug = excluded.slug,
        icon = excluded.icon,
        company_id = excluded.company_id,
        sort_order = excluded.sort_order
    `);

    const existsCheck = db.prepare('SELECT id FROM workspaces WHERE id = ?');

    for (const dept of depts) {
      // Robustness guard (mirrors autoSeedFromDepartmentsJson): a bare-string or
      // slug/id-less entry would throw and abort the whole reseed, dropping every
      // department that follows it. Skip malformed entries, seed the rest.
      if (!dept || typeof dept !== 'object' || (!dept.id && !dept.slug)) {
        console.log('[reseed] Skipping malformed departments.json entry (no slug/id):', JSON.stringify(dept).slice(0, 80));
        continue;
      }

      // Floor invariant: an EXPLICITLY opted-out department never gets a lane.
      if (isDepartmentOptedOut(dept)) {
        console.log(`[reseed] Skipping "${dept.id || dept.slug}" — explicitly opted out (honored decline)`);
        continue;
      }

      const slugLower = String(dept.slug || dept.id || '').toLowerCase();
      const isCeo = slugLower === 'master-orchestrator' || slugLower === 'ceo' || slugLower === 'dept-ceo' || dept.id === 'ceo';
      const isGeneralTask = slugLower === 'general-task';
      const sortOrder = isCeo ? 0 : isGeneralTask ? 99999 : 1000;

      // Slug-uniqueness guard (FM-6): never (re)create a SECOND workspace whose
      // slug canonicalizes to a department a DIFFERENT row already represents
      // (e.g. seeding `ceo` when `master-orchestrator` exists). Skip the dupe so
      // converge can't re-split a department across two Kanban columns. NOTE: as of
      // 2026-07-08 'app-development' and 'engineering' are DISTINCT canonical slugs
      // (the destructive app-development→engineering alias was removed), so two
      // chosen depts App Development + Engineering no longer collide here.
      const canonOwner = findCanonicalWorkspaceId(db, dept.slug || dept.id);
      if (canonOwner && canonOwner !== dept.id) {
        console.log(`[reseed] Skipping "${dept.id}" — department already represented by workspace "${canonOwner}"`);
        continue;
      }

      const existing = existsCheck.get(dept.id);
      upsertStmt.run(
        dept.id,
        dept.name,
        dept.slug || dept.id,
        dept.name + ' department workspace',
        dept.emoji || '📁',
        companyId,
        sortOrder
      );
      if (existing) {
        updated++;
      } else {
        created++;
      }
    }

    // Re-seed trio agents and starter SOPs (both idempotent)
    autoSeedTrioAgents(db);
    autoSeedStarterSOPs(db);

    console.log(`[reseed] workspaces: created=${created} updated=${updated} company=${companyId}`);
  } catch (err) {
    console.error('[reseed] Failed:', (err as Error).message);
    throw err; // Re-throw so converge endpoint can FAIL LOUD
  }

  return { created, updated };
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

// Auto-seed company + workspaces from config/departments.json on EVERY boot.
//
// Historically this ran ONLY on first boot: it early-returned the moment the
// workspaces table had any row, so a manifest that GREW after the first boot (a
// department added post-build) never re-synced and the board stayed short of the
// client's chosen count. It is now an idempotent, additive, opt-out-honoring,
// company-attributed UPSERT delegated to reseedWorkspacesFromConfig() — the SAME
// function the converge endpoint uses — so boot and converge enforce the floor
// invariant identically. reseedWorkspacesFromConfig re-throws on error (so
// converge can fail loud); here we swallow so a seed hiccup never crashes app
// startup, exactly as the previous first-boot seeder did.
function autoSeedFromDepartmentsJson(db: Database.Database) {
  try {
    const { created, updated } = reseedWorkspacesFromConfig(db, { force: true });
    if (created > 0 || updated > 0) {
      console.log(`[Auto-seed] Departments synced on boot — created=${created} updated=${updated}`);
    }
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
