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
import { canonicalDeptSlug } from '../routing/canonical-slug';
import {
  safeReaddirNames,
  safeReadFileUtf8,
  safeIsFile,
  safeIsDir,
  safeStatSync,
} from '../fs/safe-fs';
import { seedCompanyGuarded } from './branding-seed';
import { BLOCKED_ASK_TRIGGER_SQL } from '../blocked-ask';
import {
  dedupeCanonicalWorkspaces,
  reapDuplicateOpenAuthoringTasks,
  findCanonicalWorkspaceId,
} from './task-dedup';
import {
  TEST_RESIDUE_SOP_DEPARTMENTS,
  TEST_RESIDUE_WORKSPACE_SLUGS,
  TEST_RESIDUE_COMPANY_SLUGS,
  isTestResidueSlug,
  isTestResidueIngestSlug,
} from '../test-residue';

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

// ---------------------------------------------------------------------------
// DATA-01 / DISPATCH-LEDGER — the ONE source of truth for the tasks columns +
// index the dispatch/board HOT paths read on every tick (intake-advance /
// backlog-redispatch / stale sweeps, task-dispatcher). Migrations 077 + 078 own
// them for existing DBs; schema.ts owns them for fresh installs. Used by THREE
// things so they can never drift: migration 097 (reconcile), the post-migration
// self-verification in runMigrations (fail loud), and checkDispatchSchemaHealth
// (inspect the LIVE schema, NEVER the ledger).
// ---------------------------------------------------------------------------
const CRITICAL_TASKS_DISPATCH_COLUMNS: { name: string; ddl: string; owner: string }[] = [
  { name: 'dispatch_attempts', ddl: 'ALTER TABLE tasks ADD COLUMN dispatch_attempts INTEGER DEFAULT 0', owner: '077' },
  { name: 'last_dispatch_attempt_at', ddl: 'ALTER TABLE tasks ADD COLUMN last_dispatch_attempt_at TEXT', owner: '077' },
  { name: 'next_dispatch_eligible_at', ddl: 'ALTER TABLE tasks ADD COLUMN next_dispatch_eligible_at TEXT', owner: '077' },
  { name: 'block_reason', ddl: 'ALTER TABLE tasks ADD COLUMN block_reason TEXT', owner: '078' },
];

const CRITICAL_TASKS_DISPATCH_INDEXES: { name: string; column: string; ddl: string; owner: string }[] = [
  {
    name: 'idx_tasks_next_dispatch_eligible',
    column: 'next_dispatch_eligible_at',
    ddl: `CREATE INDEX IF NOT EXISTS idx_tasks_next_dispatch_eligible
          ON tasks(next_dispatch_eligible_at) WHERE next_dispatch_eligible_at IS NOT NULL`,
    owner: '077',
  },
];

/** DATA-01: the LIVE-schema health of the dispatch/board columns + index. */
export interface DispatchSchemaHealth {
  /** True only when every critical dispatch column AND its index are genuinely present. */
  ok: boolean;
  tasksTablePresent: boolean;
  /** Critical tasks columns absent from the LIVE schema (PRAGMA table_info). */
  missingColumns: string[];
  /** Critical indexes absent from the LIVE schema (their column exists but the index does not). */
  missingIndexes: string[];
  /** Migration id(s) the _migrations ledger CLAIMS applied while their columns are absent — the falsely-healed tell. */
  ledgerClaimsAppliedButAbsent: string[];
}

// All migrations in order - NEVER remove or reorder existing migrations
// Exported (additive — runMigrations remains the only caller in app code) so a
// single migration can be unit-tested in isolation against a fixture database.
// Applying the whole array to a bare fixture is not a viable test: later
// migrations depend on tables an isolated fixture has no reason to carry, so a
// test that wants to prove ONE migration's data mapping must be able to reach
// that migration's own `up`.
export const migrations: Migration[] = [
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
        console.log('[Migration 002] Added workspace_id to tasks');
      }

      // Add workspace_id to agents if not exists
      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      if (!agentsInfo.some(col => col.name === 'workspace_id')) {
        db.exec(`ALTER TABLE agents ADD COLUMN workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id)`);
        console.log('[Migration 002] Added workspace_id to agents');
      }

      // v5.16.1: these two indexes USED to live in schema.ts. They cannot — schema.ts
      // runs BEFORE migrations, so indexing workspace_id there deadlocks any database
      // that predates this migration (the idx_workspaces_archived_at class). They are
      // created here, UNCONDITIONALLY and OUTSIDE the ALTER guards above: on a fresh
      // install schema.ts already declared workspace_id, so the guards skip the ALTER —
      // if the CREATE INDEX sat inside the guard (as it used to), a fresh database would
      // silently never get the index at all.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id)`);
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
  // U59 [JM/U55] — the da_challenges shape reconciliation migration 020
  // explicitly defers to. Reserved by PR #11 and never implemented; the
  // slot sat empty while migration 020's own comment ("Migration 024 owns
  // the legacy -> canonical reconciliation; here we just no-op and let 024
  // do the work on the next pass") promised it, and the index-repair
  // migration's comment ("migration 020 defers a legacy da_challenges to
  // 024, which reconciles the table") assumed it had landed. Neither was
  // true. Consequences this closes, both VERIFIED against the operator's
  // live database this pass:
  //   1. On a CANONICAL box (020 created the table fresh — the normal
  //      case), GET /api/da-challenges seeded demo rows naming columns
  //      department_id / challenge_text / response_text / response_deadline
  //      that migration 020 never creates. Reproduced exactly against a
  //      byte-copy of the live DB: "table da_challenges has no column named
  //      department_id" -> the route's own try/catch turns it into HTTP 500.
  //      The Devil's Advocate feed has therefore NEVER rendered on a
  //      canonically-migrated box.
  //   2. On a LEGACY box (a pre-020 da_challenges already present), 020
  //      no-ops forever waiting for a 024 that does not exist, so the table
  //      keeps a shape no current code targets.
  // This migration reconciles BOTH shapes onto one canonical table and
  // adopts the PRD status lifecycle per decision D15 (D-J1) sub-part (ii).
  //
  // Rebuild (not ALTER): SQLite cannot alter a CHECK constraint in place,
  // and the status CHECK must change. A rebuild drops every index on the
  // table (the exact hazard the index-repair migration documents), so the
  // three canonical indexes are replayed explicitly at the end.
  // deferInAdditiveSelfHeal: a rebuild is not additive-only DDL — it must
  // never run during a request-time self-heal racing live traffic.
  {
    id: '024',
    name: 'reconcile_da_challenges_shape',
    deferInAdditiveSelfHeal: true,
    up: (db) => {
      const RECONCILED = `
        CREATE TABLE da_challenges_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          task_id TEXT,
          campaign_id TEXT,
          department_id TEXT,
          trigger_type TEXT NOT NULL,
          challenge TEXT NOT NULL,
          specific_concern TEXT,
          assumptions TEXT,
          severity TEXT CHECK(severity IN ('low', 'medium', 'high')),
          confidence REAL,
          raw_response TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'approved', 'rejected', 'escalated')),
          dismissal_reason TEXT,
          outcome TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at TEXT
        )
      `;

      const replayIndexes = () => {
        db.prepare('CREATE INDEX IF NOT EXISTS idx_da_task ON da_challenges(task_id)').run();
        db.prepare('CREATE INDEX IF NOT EXISTS idx_da_status ON da_challenges(status)').run();
        db.prepare('CREATE INDEX IF NOT EXISTS idx_da_severity ON da_challenges(severity)').run();
        db.prepare(
          'CREATE INDEX IF NOT EXISTS idx_da_department ON da_challenges(department_id)',
        ).run();
      };

      const existing = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='da_challenges'`)
        .get() as { name: string } | undefined;

      // No table at all (a box where 020 has not run yet): create the
      // reconciled shape directly. 020's CREATE TABLE IF NOT EXISTS then
      // no-ops behind us, and numeric ordering means 020 runs first anyway
      // on a fresh box — this branch is belt-and-braces, never the hot path.
      if (!existing) {
        db.prepare(RECONCILED).run();
        db.prepare('ALTER TABLE da_challenges_new RENAME TO da_challenges').run();
        replayIndexes();
        console.log('[Migration 024] da_challenges created in reconciled shape (no prior table)');
        return;
      }

      const cols = (
        db.prepare(`PRAGMA table_info(da_challenges)`).all() as { name: string }[]
      ).map((c) => c.name);

      // Already reconciled (idempotent re-entry guard): the two columns this
      // migration adds are both present AND the status CHECK already names
      // the PRD lifecycle. Nothing to do.
      const ddl =
        (
          db
            .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='da_challenges'`)
            .get() as { sql: string } | undefined
        )?.sql ?? '';
      if (
        cols.includes('department_id') &&
        cols.includes('raw_response') &&
        ddl.includes("'pending'")
      ) {
        replayIndexes();
        console.log('[Migration 024] da_challenges already reconciled — indexes verified');
        return;
      }

      const has = (c: string) => cols.includes(c);
      const isCanonical = has('task_id');

      // THREE distinct status vocabularies, declared across FOUR sites:
      //   1. PRD (D15 (ii), the target)      : pending | approved | rejected | escalated
      //   2. open | responded | escalated    — declared TWICE:
      //        - legacy schema.ts CHECK, a REAL constraint (last carried at 5bd9ba3)
      //        - route.ts's TypeScript interface (mirrors it)
      //   3. canonical migration-020 CHECK   : open | accepted | dismissed | overridden
      //
      // NOTE for the record: D15's own text framed sub-part (ii) as "the code's
      // open/responded/escalated (route line 13)" vs the PRD's four, and so
      // missed vocabulary 3 entirely — the constraint actually enforced on
      // every canonically migrated box. Its mapping (open->pending,
      // responded->approved) only ever covered vocabulary 2.
      //
      // Correcting an earlier note in this branch's own history, which claimed
      // open/responded/escalated was "the TypeScript interface, never a DB
      // constraint": that was WRONG. It IS a real CHECK on a legacy box —
      // verified in schema.ts at 5bd9ba3. The accurate count is three distinct
      // vocabularies across four declaration sites, not four vocabularies:
      // sites 2a and 2b declare the identical set. Both real constraints are
      // mapped below so neither box class loses a row.
      const statusExpr = isCanonical
        ? `CASE status
             WHEN 'open' THEN 'pending'
             WHEN 'accepted' THEN 'approved'
             WHEN 'dismissed' THEN 'rejected'
             WHEN 'overridden' THEN 'escalated'
             ELSE 'pending'
           END`
        : `CASE status
             WHEN 'open' THEN 'pending'
             WHEN 'responded' THEN 'approved'
             WHEN 'escalated' THEN 'escalated'
             ELSE 'pending'
           END`;

      // Build the SELECT defensively from the columns that actually exist —
      // a legacy table's exact shape is not guaranteed across boxes.
      const pick = (c: string, fallback = 'NULL') => (has(c) ? c : fallback);
      const challengeExpr = has('challenge')
        ? 'challenge'
        : has('challenge_text')
          ? 'challenge_text'
          : `''`;
      // trigger_type is NOT NULL; legacy rows carry none.
      const triggerExpr = has('trigger_type') ? `COALESCE(trigger_type, 'legacy_import')` : `'legacy_import'`;
      // A legacy response_text is a human reply to the challenge — the
      // closest canonical home is outcome, not a dropped column.
      const outcomeExpr = has('outcome') ? 'outcome' : has('response_text') ? 'response_text' : 'NULL';

      db.prepare(RECONCILED).run();
      db.prepare(
        `INSERT INTO da_challenges_new
           (id, task_id, campaign_id, department_id, trigger_type, challenge,
            specific_concern, assumptions, severity, confidence, raw_response,
            status, dismissal_reason, outcome, created_at, resolved_at)
         SELECT
           id,
           ${pick('task_id')},
           ${pick('campaign_id')},
           ${pick('department_id')},
           ${triggerExpr},
           ${challengeExpr},
           ${pick('specific_concern')},
           ${pick('assumptions')},
           ${pick('severity')},
           ${pick('confidence')},
           ${pick('raw_response')},
           ${has('status') ? statusExpr : `'pending'`},
           ${pick('dismissal_reason')},
           ${outcomeExpr},
           ${has('created_at') ? `COALESCE(created_at, datetime('now'))` : `datetime('now')`},
           ${pick('resolved_at')}
         FROM da_challenges`,
      ).run();

      const moved = (
        db.prepare('SELECT COUNT(*) AS n FROM da_challenges_new').get() as { n: number }
      ).n;

      db.prepare('DROP TABLE da_challenges').run();
      db.prepare('ALTER TABLE da_challenges_new RENAME TO da_challenges').run();
      replayIndexes();

      console.log(
        `[Migration 024] da_challenges reconciled from ${isCanonical ? 'canonical' : 'legacy'} ` +
          `shape -> PRD lifecycle (D15/D-J1 (ii)); ${moved} row(s) carried over; indexes replayed`,
      );
    },
  },
  // ============================================================
  // Track S — Auto-research + auto-replace deleted SOPs
  // ============================================================
  // Track S takes 025. (Migration 024 above is the da_challenges shape
  // reconciliation formerly reserved by PR #11 — now implemented.)
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
          // DROP TABLE agents destroyed EVERY index on it. Recreate all of them.
          // v5.16.1: idx_agents_workspace was missing from this list. It survived only
          // because schema.ts re-ran `CREATE INDEX ... idx_agents_workspace` on every
          // getDb() call — an accidental, load-bearing self-heal. The moment that index
          // moved out of schema.ts (it had to: workspace_id is ALTER-added by migration
          // 002, so indexing it in the pre-migration schema deadlocks old databases),
          // this rebuild silently dropped it for good. A rebuild MUST replay its indexes.
          db.exec('CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status)');
          db.exec('CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id)');
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
      // were the trigger for the migration-034 FK breakage on a staged
      // client deploy. (D20 wording fix, U93 — same incident, retired-term
      // vocabulary swapped for plain language; no behavior change.)
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
        console.log('[Migration 061] tasks.qc_reroute_attempts column added');
      } else {
        console.log('[Migration 061] tasks.qc_reroute_attempts already present, skipping column add');
      }
      // v5.16.1: this CREATE INDEX used to live INSIDE the guard above. schema.ts
      // already declares qc_reroute_attempts in the base tasks CREATE, so on a FRESH
      // install the guard is skipped — and the index was therefore never created. Every
      // client box is a fresh install, so idx_tasks_qc_reroute was missing FLEET-WIDE,
      // and because 061 is recorded in _migrations it could never come back. Creating
      // it unconditionally (IF NOT EXISTS) is correct on both paths. Migration 096
      // back-fills the boxes that already recorded 061 as applied.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_qc_reroute ON tasks(qc_reroute_attempts) WHERE qc_reroute_attempts > 0`);
      console.log('[Migration 061] idx_tasks_qc_reroute index ready');
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
      // Idempotent on the ROLE, not on the id (C3). This originally used
      // `INSERT OR IGNORE` keyed on its own deterministic ids
      // ('research-agent-<ws.id>' / 'da-agent-<ws.id>'), which only suppresses a
      // PRIMARY-KEY collision. Skill 23 had already seeded the same roles under hex
      // ids, so the insert did not collide — it DUPLICATED. seedTrioForWorkspaces()
      // now skips any role slot already filled by any agent, under any id and any
      // alias spelling ('deep-research' == 'research').
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

      const seeded = seedTrioForWorkspaces(db, workspaces);
      console.log(
        `[Migration 065] Seeded ${seeded.research} Research + ${seeded.devilsAdvocate} Devil's Advocate ` +
        `(+${seeded.qc} QC) agent(s) across ${workspaces.length} workspace(s); ` +
        `${seeded.skipped} role slot(s) already filled`,
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
  {
    id: '089',
    name: 'add_tasks_source_column',
    up: (db) => {
      // INGEST-10 — the board-producer scope gate in
      // /api/tasks/[id]/status/route.ts (resolveBoardSource) was designed to key
      // off an IMMUTABLE, server-stamped `tasks.source` column, but that column
      // never actually landed: it existed only as a comment referencing "a future
      // migration". Until now `task.source` was always undefined, so the resolver
      // silently fell through to its legacy fallback — a "Source: <value>" line
      // matched out of the CALLER-EDITABLE `description` field — which a PATCH
      // caller can forge on any task to grant itself board-producer scope.
      //
      // This migration adds the column (idempotent, additive, nullable — existing
      // rows get NULL and keep using the legacy description-marker fallback,
      // exactly as resolveBoardSource already handles). The write side
      // (createTaskCore / src/app/api/tasks/ingest/route.ts) now stamps this
      // column from the VALIDATED ingest `source` at creation time only; it is
      // NOT on UpdateTaskSchema and the PATCH route never writes it, so it stays
      // non-forgeable after creation.
      console.log('[Migration 089] Adding tasks.source column (INGEST-10 authoritative scope column)...');
      const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'source')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN source TEXT`);
        console.log('[Migration 089] Added tasks.source');
      } else {
        console.log('[Migration 089] tasks.source already present, skipping');
      }
    },
  },
  {
    id: '090',
    name: 'add_persona_blend_bundle',
    up: (db) => {
      // PERSONA-BLEND / AUDIENCE-CONFIRM — persist the matcher's persona-bundle
      // SUPERSET so the CC can (a) render the audience-voice / topic-expertise blend
      // directive at dispatch and (b) gate the write on operator audience confirmation.
      //
      // Two additive changes, both idempotent:
      //   1. New mirror columns on `tasks` (nullable) — the resolved VOICE decision
      //      + the confirmed audience, so the board + dispatcher read them without
      //      re-parsing bundle_json. tasks.persona_id/name/mode remain the mirror of
      //      the resolved VOICE persona (back-compat with buildPersonaBlock).
      //   2. New table `task_persona_bundle` — one row per task holding the full
      //      bundle JSON, the catalog schemaVersion it was reasoned over, and the
      //      audience confirm lifecycle state (pending gates dispatch).
      //
      // ADDITIVE ONLY — never drops/renames a column or persona key. A pre-089 row
      // simply lacks these columns/rows and the CC degrades to its prior behaviour.
      console.log('[Migration 090] Adding persona-blend mirror columns + task_persona_bundle...');

      const tasksInfo = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
      const columnNames = tasksInfo.map((c) => c.name);
      const adds: Record<string, string> = {
        voice_persona_id: 'TEXT',
        topic_persona_id: 'TEXT',
        audience_id: 'TEXT',
        audience_label: 'TEXT',
        audience_source: 'TEXT',
        voice_collapsed: 'INTEGER',
        blend_directive: 'TEXT',
      };
      for (const [col, type] of Object.entries(adds)) {
        if (!columnNames.includes(col)) {
          db.prepare(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`).run();
        }
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS task_persona_bundle (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          bundle_json TEXT,
          catalog_version TEXT,
          confirm_state TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_task_persona_bundle_task ON task_persona_bundle(task_id)',
      ).run();
      db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_task_persona_bundle_confirm ON task_persona_bundle(confirm_state)',
      ).run();

      console.log('[Migration 090] persona-blend columns + task_persona_bundle ready');
    },
  },
  {
    id: '091',
    name: 'rekey_and_purge_ghost_sops',
    // DESTRUCTIVE data cleanup (re-key + soft-delete + hard-delete). Defer during
    // request-time additive self-heal so it never races live ingest; it runs on
    // the next controlled boot instead.
    deferInAdditiveSelfHeal: true,
    up: (db) => {
      // C2 — the CC SOP library was a "ghost": the pre-C2 starter seed keyed rows
      // to LEGACY alias slugs (webdev, support, comms, billing, appdev, openclaw,
      // social, paid-ads) and to DEPRECATED departments (ceo, security, hr-people,
      // finance-accounting, operations, data-analytics, executive-assistant), and
      // test harnesses that wrote to the LIVE DB left ~30 `test-dept` residue rows.
      // A `/api/sops?department=<canonical>` query could never match the alias-keyed
      // rows, so the library read as empty even with 54 rows on disk.
      //
      // This migration, on an existing DB, brings those rows into line with the
      // rewritten canonical sops-seed.ts:
      //   1. PURGE the test-dept residue (exact slug — never pattern-match).
      //   2. SOFT-DELETE the deprecated-department rows (deleted_at set) by their
      //      ORIGINAL department value, BEFORE re-key, so 'ceo' is retired rather
      //      than silently rescued to master-orchestrator.
      //   3. RE-KEY every remaining active row to its canonical slug via
      //      canonicalDeptSlug(), PRESERVING each sop id — dispatch_rules.sop_id
      //      and Triad matching key off the id, so the id must never change.
      // Idempotent + safe on a fresh DB (sops empty → all three steps no-op, then
      // autoSeedStarterSOPs seeds the 16 canonical starter SOPs).
      console.log('[Migration 091] Re-keying legacy SOP rows + purging ghost residue (C2)...');
      const r = rekeyAndPurgeGhostSops(db);
      console.log(
        `[Migration 091] re-keyed ${r.rekeyed} row(s) to canonical slugs, ` +
          `retired ${r.deprecatedRetired} deprecated-dept row(s), ` +
          `purged ${r.testPurged} test-dept row(s)`,
      );
    },
  },

  // ── Migration 092 — C3: de-duplicate trio agents + reap headless workspaces ──
  {
    id: '092',
    name: 'dedupe_trio_agents_and_materialize_heads',
    // DESTRUCTIVE data cleanup (deletes duplicate agent rows and repoints foreign
    // keys). Defer during request-time additive self-heal so it never races a live
    // dispatch; it runs on the next controlled boot instead. Same posture as 091.
    deferInAdditiveSelfHeal: true,
    up: (db) => {
      // C3 — provisioning multiplied agents and left workspaces headless.
      //
      // Duplicates: migration 065 / autoSeedTrioAgents seeded the trio with
      // INSERT OR IGNORE on their OWN ids, so the Skill-23 rows (hex ids, and the
      // 'deep-research' alias) never collided and every re-provision added another
      // copy. This collapses each workspace/role slot to ONE agent, repointing all
      // foreign keys onto the survivor first. Non-trio roles are untouched —
      // 'specialist' departments legitimately hold many agents.
      //
      // Headless: migration 028 backfilled head_agent_id ONCE, so every workspace
      // created afterwards was born headless and stayed that way. This materialises
      // a head for each, and ensureWorkspaceHeadAgents() now runs on every boot so
      // the condition cannot re-accumulate.
      console.log('[Migration 092] De-duplicating trio agents + materialising department heads (C3)...');

      const d = dedupeTrioAgents(db);
      console.log(
        `[Migration 092] normalised ${d.aliasesNormalized} role_type alias(es); ` +
          `found ${d.groupsFound} duplicated role slot(s); ` +
          `repointed ${d.referencesRepointed} reference(s); ` +
          `removed ${d.agentsRemoved} duplicate agent(s); ` +
          `kept ${d.groupsSkipped} duplicate(s) whose references could not be repointed`,
      );

      const h = ensureWorkspaceHeadAgents(db);
      console.log(
        `[Migration 092] promoted ${h.promoted} existing agent(s) to head, ` +
          `materialised ${h.created} new head agent(s), ` +
          `${h.stillHeadless} workspace(s) still headless`,
      );
    },
  },
  {
    id: '093',
    name: 'purge_test_residue_workspaces',
    // DESTRUCTIVE data cleanup (hard delete of exact-slug fixture workspaces +
    // their fixture agents/tasks). Same rationale as migration 091: defer during
    // request-time additive self-heal so it never races live ingest, and run on
    // the next controlled boot instead.
    deferInAdditiveSelfHeal: true,
    up: (db) => {
      // C8 — the same un-isolated QC/smoke-test harness that left ~30 test-dept
      // SOP rows (migration 091 / C2) also left fixture WORKSPACES behind:
      // smoke-test-dept and no-script-dept, 7 synthetic agents each. Purge them
      // by EXACT slug — never a pattern match (see ../test-residue.ts) — and
      // ONLY when every task referencing the workspace is itself test-shaped,
      // so this can never delete real client work. Idempotent: a fresh DB or a
      // box that never had the residue is a total no-op.
      console.log('[Migration 093] Purging test/fixture-residue workspaces (C8)...');
      const r = purgeTestResidueWorkspaces(db);
      console.log(
        `[Migration 093] purged ${r.workspacesPurged.length} test workspace(s)` +
          `${r.workspacesPurged.length ? ` (${r.workspacesPurged.join(', ')})` : ''}, ` +
          `skipped ${r.workspacesSkipped.length} (non-test task refs or FK conflict — left for manual review)`,
      );
    },
  },
  {
    id: '094',
    name: 'purge_test_residue_companies',
    // DESTRUCTIVE data cleanup (hard delete of the exact-slug `testco` fixture
    // company). Deferred out of request-time additive self-heal for the same
    // reason as 091/093 — run on the next controlled boot, never racing live
    // ingest.
    //
    // MUST run AFTER 093: the fixture workspaces 093 purges may still carry
    // company_id = testco, and purgeTestResidueCompanies refuses (correctly) to
    // delete a company any workspace still references. Array order IS run order.
    deferInAdditiveSelfHeal: true,
    up: (db) => {
      // C8 — the un-isolated QC harness that left test-dept SOPs (091) and
      // fixture workspaces (093) also left a `testco` COMPANY row, and until now
      // NOTHING deleted it: converge detected it, returned 500, and told the
      // operator to run 091/092 — neither of which touches `companies`. The
      // remediation the error text prescribed provably did not work, so converge
      // stayed bricked. This migration makes that advice true.
      console.log('[Migration 094] Purging test/fixture-residue companies (C8)...');
      const r = purgeTestResidueCompanies(db);
      console.log(
        `[Migration 094] purged ${r.companiesPurged.length} test company row(s)` +
          `${r.companiesPurged.length ? ` (${r.companiesPurged.join(', ')})` : ''}, ` +
          `skipped ${r.companiesSkipped.length} (still referenced by a workspace — left for manual review)`,
      );
    },
  },
  {
    // NOTE ON NUMBERING (merge-train serialization): 092 = cc-c3-dedup; 093 and
    // 094 = cc-c8-c10 (purge_test_residue_workspaces / _companies). Both landed
    // ahead of this branch, so the '094' this branch originally authored now
    // COLLIDES with cc-c8-c10's purge_test_residue_companies. Renumbered to 095
    // on rebase onto main @ v5.13.0. The DATA-03 duplicate-id fail-fast below is
    // exactly what would have rejected the clash at module load.
    id: '095',
    name: 'add_workspace_archived_at',
    // Purely ADDITIVE (two nullable columns + an index). No data is moved or
    // destroyed, so it is safe to apply during request-time additive self-heal.
    up: (db) => {
      // C6 / AUD-16 — the ELIMINATE path.
      //
      // A department the owner provenance-DECLINED kept its workspace row and kept
      // rendering as a live Kanban column: canonical_decline.py (C1) classified the
      // NO correctly, but nothing on the read side ever consumed the honored
      // declined set. This column is what lets a decline actually take a department
      // OFF the board — SOFT: the row and all its history are PRESERVED, exactly as
      // tasks.archived_at (migration 058) does for cards. A decline is a display
      // decision, not a data-destruction decision; the owner can flip NO → YES and
      // the department comes back intact.
      //
      // It is ALSO the row `delete-guard.ts` (B8 / AUD-46) reads to refuse a hard
      // DELETE of a workspace that was never archived first.
      console.log('[Migration 095] Adding workspaces.archived_at / archived_reason (C6)...');

      const cols = (db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map(
        (c) => c.name,
      );

      // schema.ts declares both columns on fresh installs, so the ALTERs are
      // guarded — this migration only heals an EXISTING pre-095 database.
      if (!cols.includes('archived_at')) {
        db.exec(`ALTER TABLE workspaces ADD COLUMN archived_at TEXT`);
        console.log('[Migration 095] workspaces.archived_at added');
      } else {
        console.log('[Migration 095] workspaces.archived_at already present, skipping');
      }

      if (!cols.includes('archived_reason')) {
        db.exec(`ALTER TABLE workspaces ADD COLUMN archived_reason TEXT`);
        console.log('[Migration 095] workspaces.archived_reason added');
      } else {
        console.log('[Migration 095] workspaces.archived_reason already present, skipping');
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_workspaces_archived_at ON workspaces(archived_at)`);
      console.log('[Migration 095] idx_workspaces_archived_at index ready');

      // Deliberately does NOT back-fill any archive here. Archiving is driven by
      // the honored declined set at converge time (syncDeclinedWorkspaceArchive),
      // which reads build-state — the canonical provenance source. A migration
      // guessing at which departments were declined would be exactly the kind of
      // unprovenanced decline that gate #8 exists to reject.
    },
  },

  // ── Migration 096 — Reconcile indexes the fleet is silently missing (v5.16.1) ──
  {
    id: '096',
    name: 'reconcile_missing_indexes',
    // Purely ADDITIVE: nothing but `CREATE INDEX IF NOT EXISTS`. No data is read,
    // written, moved or destroyed, so it is safe under the additive self-heal path.
    //
    // WHY THIS EXISTS
    // Two defects (found by the v5.16.1 same-class audit) left indexes missing on
    // live boxes, and neither could ever self-repair — the owning migration is
    // already recorded in _migrations, so fixing that migration in place does
    // nothing for a box that already ran it. Only a NEW migration can reach them.
    //
    //   1. Index created INSIDE a column-absence guard.
    //      `if (!cols.includes(x)) { ALTER TABLE ... ADD COLUMN x; CREATE INDEX ON (x); }`
    //      schema.ts already declares x in the base CREATE TABLE, so on a FRESH install
    //      the guard is skipped — and the index is never created. Every client box is a
    //      fresh install. Verified against a pristine v5.16.0 database:
    //      idx_tasks_qc_reroute was MISSING. (migration 061; 058 had the same shape
    //      before it was fixed, so boxes built before that fix also lack
    //      idx_tasks_archived_at.)
    //
    //   2. A 12-step table rebuild that does not replay every index it dropped.
    //      `DROP TABLE agents` (migration 034) destroys every index on agents, and 034
    //      only recreated idx_agents_status. idx_agents_workspace survived purely because
    //      schema.ts re-issued it on every getDb() — an accidental self-heal that had to
    //      end, because that same schema.ts index is what deadlocked upgrades.
    //
    // Every column referenced below is guaranteed to exist by migration 096 (002, 012,
    // 058, 061, 095 all precede it), so this migration cannot itself deadlock.
    up: (db) => {
      console.log('[Migration 096] Reconciling missing indexes...');

      // name, table, the columns the index depends on, DDL.
      // The columns are declared explicitly so this migration can VERIFY they exist
      // before issuing the CREATE INDEX. That guard is the whole point: a migration
      // that indexes a column which turns out not to exist throws, boot fail-closes,
      // and the box is deadlocked — precisely the bug this release fixes. Migration
      // 096 must never be able to become the next one.
      const wanted: { name: string; table: string; cols: string[]; ddl: string }[] = [
        // Family A — moved out of schema.ts (indexing there deadlocked old databases).
        // Ensure they exist regardless of which migrations a given box has run.
        { name: 'idx_workspaces_archived_at', table: 'workspaces', cols: ['archived_at'],
          ddl: 'CREATE INDEX IF NOT EXISTS idx_workspaces_archived_at ON workspaces(archived_at)' },
        { name: 'idx_workspaces_company', table: 'workspaces', cols: ['company_id'],
          ddl: 'CREATE INDEX IF NOT EXISTS idx_workspaces_company ON workspaces(company_id)' },
        { name: 'idx_tasks_workspace', table: 'tasks', cols: ['workspace_id'],
          ddl: 'CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id)' },

        // Family B — the index was created INSIDE a column-absence guard, so a fresh
        // install (schema.ts already declared the column -> guard skipped) never got
        // it. idx_tasks_qc_reroute was missing on EVERY box in the fleet this way.
        { name: 'idx_tasks_qc_reroute', table: 'tasks', cols: ['qc_reroute_attempts'],
          ddl: 'CREATE INDEX IF NOT EXISTS idx_tasks_qc_reroute ON tasks(qc_reroute_attempts) WHERE qc_reroute_attempts > 0' },
        { name: 'idx_tasks_archived_at', table: 'tasks', cols: ['archived_at'],
          ddl: 'CREATE INDEX IF NOT EXISTS idx_tasks_archived_at ON tasks(archived_at)' },

        // Family C — a table rebuild dropped the table (and every index on it) without
        // replaying them. Migration 034 (agents) replayed only idx_agents_status;
        // migration 020 defers a legacy da_challenges to 024, which reconciles the
        // table but never recreates 020's three indexes.
        { name: 'idx_agents_workspace', table: 'agents', cols: ['workspace_id'],
          ddl: 'CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id)' },
        { name: 'idx_da_task', table: 'da_challenges', cols: ['task_id'],
          ddl: 'CREATE INDEX IF NOT EXISTS idx_da_task ON da_challenges(task_id)' },
        { name: 'idx_da_status', table: 'da_challenges', cols: ['status'],
          ddl: 'CREATE INDEX IF NOT EXISTS idx_da_status ON da_challenges(status)' },
        { name: 'idx_da_severity', table: 'da_challenges', cols: ['severity'],
          ddl: 'CREATE INDEX IF NOT EXISTS idx_da_severity ON da_challenges(severity)' },
      ];

      const created: string[] = [];
      const skipped: string[] = [];

      for (const { name, table, cols, ddl } of wanted) {
        const tableExists = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
          .get(table);
        if (!tableExists) {
          skipped.push(`${name} (no ${table} table)`);
          continue;
        }
        const present = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
        );
        const absent = cols.filter((c) => !present.has(c));
        if (absent.length > 0) {
          // Do NOT throw. A missing column here means a box is in a shape we did not
          // predict; skipping costs one index, throwing costs the entire box.
          skipped.push(`${name} (${table}.${absent.join('/')} absent)`);
          continue;
        }

        const existed = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?")
          .get(name);
        db.exec(ddl);
        if (!existed) created.push(name);
      }

      console.log(
        created.length > 0
          ? `[Migration 096] Restored ${created.length} missing index(es): ${created.join(', ')}`
          : '[Migration 096] All indexes already present — nothing to restore',
      );
      if (skipped.length > 0) {
        console.log(`[Migration 096] Skipped (shape not present, not an error): ${skipped.join(', ')}`);
      }
    },
  },
  {
    id: '097',
    name: 'reconcile_missing_dispatch_columns',
    // Purely ADDITIVE: PRAGMA-guarded `ALTER TABLE tasks ADD COLUMN` + a single
    // `CREATE INDEX IF NOT EXISTS`. No row is read, written, moved or destroyed,
    // so it is safe under the additive self-heal path and a no-op on healthy boxes.
    //
    // WHY THIS EXISTS (DATA-01 ledger-lie — confirmed live on a v5.16.1 box, v5.16.2)
    // The runner keys applied-state on `_migrations.id` ALONE and snapshots the
    // applied set ONCE per run (runMigrations + the DATA-03 duplicate-id guard).
    // Migrations 077 (dispatch_attempts / last_dispatch_attempt_at /
    // next_dispatch_eligible_at + idx_tasks_next_dispatch_eligible) and 078
    // (block_reason) each add their columns INSIDE a `if (!cols.includes(x))`
    // guard. On any box where id '077'/'078' was already recorded applied while
    // the column was ABSENT, the guarded ALTER is SKIPPED FOREVER — the ledger
    // says "applied", the box climbs to HEAD and reports healthy, but the columns
    // never existed. Every dispatch/board tick (intake-advance / backlog-
    // redispatch / stale sweeps, task-dispatcher) then throws
    // "no such column: t.dispatch_attempts" and task dispatch is SILENTLY DEAD.
    // This is the SAME class migration 079 fixes for id '074' and 096 for a
    // guard-skipped index: fixing 077/078 in place can never reach an already-
    // applied box, so only a NEW migration can. This one inspects the LIVE schema
    // (never the ledger) and adds whatever is genuinely missing.
    //
    // Every ALTER is guarded by a fresh PRAGMA table_info read and the index by
    // IF NOT EXISTS + a column-presence check, so this migration can NEVER become
    // the next silent abort (096's philosophy: skipping costs one column, throwing
    // costs the whole box — so it never throws on an unforeseen shape).
    up: (db) => {
      console.log('[Migration 097] Reconciling missing dispatch attempt-accounting columns...');
      const tasksExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'")
        .get();
      if (!tasksExists) {
        console.log('[Migration 097] tasks table absent — nothing to reconcile');
        return;
      }

      const presentCols = () =>
        new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));

      const added: string[] = [];
      for (const { name, ddl, owner } of CRITICAL_TASKS_DISPATCH_COLUMNS) {
        if (!presentCols().has(name)) {
          db.exec(ddl);
          added.push(`${name} (owed by migration ${owner})`);
        }
      }

      const cols = presentCols();
      const createdIdx: string[] = [];
      for (const { name, column, ddl } of CRITICAL_TASKS_DISPATCH_INDEXES) {
        // Only index a column that actually exists — CREATE INDEX on a missing
        // column throws and would deadlock the box (the whole class we are fixing).
        if (!cols.has(column)) continue;
        const existed = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?")
          .get(name);
        db.exec(ddl);
        if (!existed) createdIdx.push(name);
      }

      console.log(
        added.length > 0
          ? `[Migration 097] Restored ${added.length} missing dispatch column(s): ${added.join(', ')}`
          : '[Migration 097] All dispatch columns already present — nothing to restore',
      );
      if (createdIdx.length > 0) {
        console.log(`[Migration 097] Restored missing index(es): ${createdIdx.join(', ')}`);
      }
    },
  },
  {
    id: '098',
    name: 'add_trust_engine_columns',
    // Purely ADDITIVE: PRAGMA-guarded `ALTER TABLE tasks ADD COLUMN` only. No row
    // is read, written, moved or destroyed, so it is safe under the additive
    // self-heal path and a NO-OP on healthy boxes. Follows the migration-097
    // pattern exactly: inspect the LIVE schema (PRAGMA table_info), never the
    // ledger, and add whatever is genuinely missing. Never throws on an
    // unforeseen shape (096/097 philosophy: skipping costs one column; throwing
    // costs the whole box).
    //
    // WHY THIS EXISTS (P1-04 — THE TRUST ENGINE / REPORT-BACK LOOP)
    // The #1 client complaint: a client asks the AI CEO for something, it is
    // routed to a department, and then silence — no ack, no progress, no done.
    // The report-back engine (src/lib/jobs/trust-engine.ts) needs eight new
    // columns on `tasks` to (a) remember the ORIGINATING client channel so it can
    // report back into it, and (b) crash-safely stamp each of the three messages
    // exactly once. All eight are nullable + additive; the base schema.ts CREATE
    // TABLE carries them for fresh installs, and this migration back-fills every
    // existing box.
    //
    //   requester_channel      e.g. 'telegram' — the channel the request came in on
    //   requester_chat_id      the client's chat id to report back to
    //   ack_sent_at            stamp: message 1 (acknowledge) sent
    //   progress_last_sent_at  stamp: message 2 (in-progress / blocked-needs-you) sent
    //   eta_estimate           the coarse honest ETA surfaced with the progress msg
    //   completion_sent_at     stamp: message 3 (done + result) sent
    //   result_summary         honest one-line result surfaced on done
    //   result_location        where the deliverable can be found (file/GHL/Drive)
    up: (db) => {
      console.log('[Migration 098] Adding trust-engine report-back columns to tasks...');
      const tasksExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'")
        .get();
      if (!tasksExists) {
        console.log('[Migration 098] tasks table absent — nothing to add');
        return;
      }

      const presentCols = () =>
        new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));

      // Every column is nullable TEXT and additive — no DEFAULT, no CHECK, so an
      // ALTER can never fail on existing data.
      const wanted: { name: string; ddl: string }[] = [
        { name: 'requester_channel', ddl: 'ALTER TABLE tasks ADD COLUMN requester_channel TEXT' },
        { name: 'requester_chat_id', ddl: 'ALTER TABLE tasks ADD COLUMN requester_chat_id TEXT' },
        { name: 'ack_sent_at', ddl: 'ALTER TABLE tasks ADD COLUMN ack_sent_at TEXT' },
        { name: 'progress_last_sent_at', ddl: 'ALTER TABLE tasks ADD COLUMN progress_last_sent_at TEXT' },
        { name: 'eta_estimate', ddl: 'ALTER TABLE tasks ADD COLUMN eta_estimate TEXT' },
        { name: 'completion_sent_at', ddl: 'ALTER TABLE tasks ADD COLUMN completion_sent_at TEXT' },
        { name: 'result_summary', ddl: 'ALTER TABLE tasks ADD COLUMN result_summary TEXT' },
        { name: 'result_location', ddl: 'ALTER TABLE tasks ADD COLUMN result_location TEXT' },
      ];

      const added: string[] = [];
      for (const { name, ddl } of wanted) {
        if (!presentCols().has(name)) {
          db.exec(ddl);
          added.push(name);
        }
      }

      // Partial index so the 2-minute trust-engine sweep can cheaply find the
      // tasks it must report on (those that carry an originating client chat id)
      // without scanning the whole board. IF NOT EXISTS + a column-presence guard
      // so it can never deadlock a box.
      if (presentCols().has('requester_chat_id')) {
        const existed = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_tasks_requester_chat'")
          .get();
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_tasks_requester_chat ON tasks(requester_chat_id) WHERE requester_chat_id IS NOT NULL',
        );
        if (!existed) console.log('[Migration 098] Created idx_tasks_requester_chat');
      }

      console.log(
        added.length > 0
          ? `[Migration 098] Added ${added.length} trust-engine column(s): ${added.join(', ')}`
          : '[Migration 098] All trust-engine columns already present — nothing to add',
      );
    },
  },
  {
    id: '099',
    name: 'add_persona_reason_column',
    // Purely ADDITIVE: a single PRAGMA-guarded `ALTER TABLE tasks ADD COLUMN`.
    // No row is read, written, moved or destroyed, so it is safe under the
    // additive self-heal path and a NO-OP on healthy boxes. Follows the
    // migration-097/098 pattern exactly: inspect the LIVE schema (PRAGMA
    // table_info), never the ledger, and add the column only when genuinely
    // missing. Never throws on an unforeseen shape (096/097/098 philosophy:
    // skipping costs one column; throwing costs the whole box).
    //
    // WHY THIS EXISTS (P2-02 — TASK-DETAIL WINDOW: FILL IN AND USE ITS FIELDS)
    // The operator wants the task modal to show which persona is working on a
    // task AND WHY. `persona_reason` stores that one-sentence WHY, generated at
    // persona-selection time (buildPersonaReason in persona-selector.ts, which
    // REUSES the scorer's own message when it wrote one) and persisted alongside
    // persona_id/name/mode/score. Nullable + additive; the base schema.ts CREATE
    // carries it for fresh installs and this migration back-fills every existing
    // box. A pre-099 row simply carries NULL and the panel renders its honest
    // empty-state.
    up: (db) => {
      console.log('[Migration 099] Adding persona_reason column to tasks...');
      const tasksExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'")
        .get();
      if (!tasksExists) {
        console.log('[Migration 099] tasks table absent — nothing to add');
        return;
      }

      const presentCols = () =>
        new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));

      if (!presentCols().has('persona_reason')) {
        db.exec('ALTER TABLE tasks ADD COLUMN persona_reason TEXT');
        console.log('[Migration 099] Added persona_reason column');
      } else {
        console.log('[Migration 099] persona_reason already present — nothing to add');
      }
    },
  },
  {
    id: '100',
    name: 'add_env_auditor_and_auth_proof_tables',
    // P2-04 — MODEL SETTINGS: LLM env-auditor + mirage-proof tiles.
    //
    // Two new, purely-additive tables (same CREATE-TABLE-IF-NOT-EXISTS pattern
    // Migration 031 used for model_registry — never touches an existing row):
    //
    //   provider_key_audit_suggestions — one row per candidate env-var name the
    //   Deep Scan surfaced, classified by the box's OWN cheap/quick-tier model
    //   (never Anthropic, never the operator's model — see env-auditor.ts). The
    //   raw secret VALUE is never stored here — only the env-var NAME, its
    //   source file, and the suggested provider. Auto-wiring happens ONLY when
    //   the operator confirms a row (status -> 'confirmed'); until then the
    //   suggestion is inert.
    //
    //   provider_auth_proof_cache — one row per provider slug recording whether
    //   an actual AUTHENTICATED call (a real chat completion, or a connector's
    //   verifyKey()) succeeded, and when. This is what kills the "/v1/models
    //   unauthenticated mirage": a provider whose catalog listed successfully
    //   is NOT rendered with a proven green check unless a row here says so,
    //   and that row is at most 24h old (see provider-auth-proof.ts).
    up: (db) => {
      console.log('[Migration 100] Adding env-auditor + auth-proof-cache tables...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_key_audit_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_at TEXT DEFAULT (datetime('now')),
          env_var TEXT NOT NULL,
          source_path TEXT NOT NULL,
          source_label TEXT NOT NULL,
          suggested_provider TEXT NOT NULL,
          confidence TEXT NOT NULL DEFAULT 'low' CHECK (confidence IN ('high', 'medium', 'low')),
          reason TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'dismissed')),
          confirmed_at TEXT,
          confirmed_env_var TEXT
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_provider_key_audit_status ON provider_key_audit_suggestions(status)`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_auth_proof_cache (
          provider_slug TEXT PRIMARY KEY,
          proven_at TEXT NOT NULL,
          ok INTEGER NOT NULL,
          method TEXT NOT NULL,
          model_id TEXT,
          detail TEXT
        );
      `);

      console.log('[Migration 100] provider_key_audit_suggestions + provider_auth_proof_cache ready');
    },
  },
  {
    id: '101',
    name: 'add_ceo_chat_messages_table',
    // P5-01 — THE BETA "MY AI CEO" DASHBOARD FEATURE.
    //
    // A new, purely-additive table (same CREATE-TABLE-IF-NOT-EXISTS pattern
    // Migration 100 used for the env-auditor tables — never touches an existing
    // row and is a NO-OP on a box that already has it). Stores the transcript of
    // the "My AI CEO" chat surface: the client's messages, the agent's streamed
    // replies, upload receipts, and the trust-engine report-back events that the
    // 2-minute sweep writes back INTO this channel (requester_channel='ceo-chat').
    //
    // One trust engine, two channels (P5-01 step 2): a task the agent routes from
    // a ceo-chat request carries requester_channel='ceo-chat' + requester_chat_id
    // = the chat session id, so the trust engine's ack/progress/done land here as
    // `trust`-role rows instead of going to Telegram.
    //
    //   session_id        the chat session id (also used as requester_chat_id)
    //   role              'user' | 'assistant' | 'system' | 'trust'
    //   content           the message text
    //   kind              'message' | 'upload' | 'trust_ack' | 'trust_progress' |
    //                     'trust_done' | 'error' (free-form provenance)
    //   task_id           optional link to a task this event pertains to
    //   attachment_*      upload provenance (path the agent was told about, name,
    //                     mime type, byte size). The raw file lives on disk under
    //                     <workspace>/inbox/ceo-chat/<date>/; only its PATH is here.
    up: (db) => {
      console.log('[Migration 101] Adding ceo_chat_messages table...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS ceo_chat_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'trust')),
          content TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'message',
          task_id TEXT,
          attachment_path TEXT,
          attachment_name TEXT,
          attachment_type TEXT,
          attachment_size INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_ceo_chat_session ON ceo_chat_messages(session_id, created_at)`,
      );
      console.log('[Migration 101] ceo_chat_messages ready');
    },
  },
  {
    id: '102',
    name: 'add_job_liveness_table',
    // C-09 / U40 — "watch the watchers": the advancer-liveness watchdog.
    //
    // A single, purely-additive table (same CREATE-TABLE-IF-NOT-EXISTS pattern
    // Migration 100/101 used — never touches an existing row, no-op on a box
    // that already has it). One row per registered cron job name, upserted by
    // scheduler.ts's wrap() on EVERY tick (success or failure — a tick is a
    // liveness signal, not a success signal). src/lib/jobs/sweep-liveness.ts
    // reads this to detect an advancer (intake-advance) or qc-review-sweep
    // that has gone silent for 3x its cadence — the "nothing watches the
    // watchers" gap this unit closes (root-caused in the master spec: the
    // single advancer re-selects a stuck card every 2 minutes forever with no
    // liveness probe on the sweep loop itself).
    up: (db) => {
      console.log('[Migration 102] Adding job_liveness table...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS job_liveness (
          job_name TEXT PRIMARY KEY,
          last_ran_at TEXT NOT NULL,
          last_status TEXT NOT NULL DEFAULT 'ok' CHECK (last_status IN ('ok', 'error')),
          last_error TEXT
        );
      `);
      console.log('[Migration 102] job_liveness ready');
    },
  },
  {
    id: '103',
    name: 'purge_demo_recommendations_seed',
    // U56 (E.2 / JM-U52) — GET /api/recommendations used to auto-seed 5
    // hardcoded demo rows (`DEMO_RECOMMENDATIONS`, now deleted from
    // src/app/api/recommendations/route.ts) into the LIVE `recommendations`
    // table on the first empty GET. Any box that ever hit that GET before
    // this fix landed carries those 5 fake rows permanently. This migration
    // deletes ONLY rows matching the five exact seeded (title, department_id)
    // fingerprints below — an operator-authored recommendation that happens
    // to share a department_id but NOT the exact seeded title text is never
    // touched. Idempotent (a box with none of these rows is a no-op) and
    // down-safe (it only ever deletes, never restores — re-running or
    // reverting the migration itself cannot resurrect or re-delete operator
    // data, because the fingerprint match is exact-title, not a LIKE/prefix).
    //
    // Destructive row-delete, so it defers during additive-only self-heal
    // (INGEST-07 convention — see migrations 081/082/etc.).
    deferInAdditiveSelfHeal: true,
    up: (db) => {
      console.log('[Migration 103] Purging DEMO_RECOMMENDATIONS seeded rows...');
      const DEMO_RECOMMENDATIONS_FINGERPRINTS: Array<{ department_id: string; title: string }> = [
        { department_id: 'marketing-dept', title: 'Double Down on Email Campaigns' },
        { department_id: 'sales-dept', title: 'Pause Cold Calling Campaign' },
        { department_id: 'operations-dept', title: 'Monitor Task Completion Times' },
        { department_id: 'finance-dept', title: 'Automate Invoice Reminders' },
        { department_id: 'product-dept', title: 'Expand User Testing Program' },
      ];
      const del = db.prepare(
        `DELETE FROM recommendations WHERE department_id = ? AND title = ?`,
      );
      let deleted = 0;
      for (const fp of DEMO_RECOMMENDATIONS_FINGERPRINTS) {
        const result = del.run(fp.department_id, fp.title);
        deleted += result.changes;
      }
      console.log(`[Migration 103] Deleted ${deleted} seeded demo recommendation row(s)`);
    },
  },
  {
    id: '104',
    name: 'reject_blocked_on_human_without_ask',
    // POISON-STATE GATE (see src/lib/blocked-ask.ts for the full incident note).
    //
    // A tasks row with `blocked_on_human` SET and `ask` EMPTY is unanswerable by
    // construction: the named human is paged with no question in it, cannot clear
    // it, so the card never leaves Blocked and the stale-task sweep re-pings on
    // every tick — forever. The API's blocked gate already demanded an `ask`; the
    // rows that flooded were written by a RAW sweep UPDATE that set
    // `blocked_on_human='operator'` and put its instruction in `block_needs`
    // (a different column), leaving `ask` NULL. Code-level validation alone cannot
    // close that class — any raw `run('UPDATE tasks SET ...')` bypasses it. This
    // migration closes it in the database.
    //
    // WHY TRIGGERS, NOT A CHECK CONSTRAINT — ⛔ NON-NEGOTIABLE:
    // SQLite cannot ADD a CHECK to an existing table; it requires the 12-step
    // rebuild, whose `INSERT INTO tasks_new SELECT * FROM tasks` would ABORT on the
    // very rows this incident already created. That migration would refuse to run
    // (or, if the rows were "cleaned" first, DESTROY live tasks that carry real
    // task_deliverables and task_activities). Unacceptable. BEFORE-row triggers
    // validate only rows WRITTEN FROM NOW ON: every existing row survives byte-for-
    // byte, stays readable, stays ARCHIVABLE, and stays repairable (setting a real
    // `ask`, or NULLing `blocked_on_human`, both pass the trigger). Forward-only
    // enforcement is the entire design.
    //
    // The UPDATE trigger is scoped `UPDATE OF blocked_on_human, ask`, so it fires
    // ONLY when a write names one of those two columns. A sweep that archives a
    // legacy poisoned row, bumps `updated_at`, or writes `archived_at` never trips
    // it. This migration is purely additive DDL (no row is read, written, or
    // deleted), hence it is SAFE in the additive-only self-heal path — no
    // `deferInAdditiveSelfHeal`.
    //
    // Idempotent: CREATE TRIGGER IF NOT EXISTS. Manual rollback (no auto-down in
    // this framework):
    //   DROP TRIGGER IF EXISTS trg_tasks_blocked_on_human_requires_ask_insert;
    //   DROP TRIGGER IF EXISTS trg_tasks_blocked_on_human_requires_ask_update;
    //   DELETE FROM _migrations WHERE id = '104';
    up: (db) => {
      console.log('[Migration 104] Installing blocked_on_human⇒ask invariant triggers...');

      // Guard: the trigger bodies reference tasks.blocked_on_human / tasks.ask,
      // added by migration 072. On a fresh DB schema.ts creates `tasks` WITHOUT
      // them, so a box that somehow reaches 104 with 072 unapplied would throw
      // "no such column" and fail the whole boot. Skip instead — 072 runs first in
      // every ordered run, so this is belt-and-braces, not an expected path.
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('blocked_on_human') || !cols.includes('ask')) {
        console.log('[Migration 104] tasks.blocked_on_human / tasks.ask absent — skipping (migration 072 owns them)');
        return;
      }

      // Count (do NOT touch) the pre-existing poisoned rows, purely so the boot log
      // states plainly that they SURVIVED this migration and still need a human
      // repair/archive decision. ⛔ Never DELETE them: they carry real
      // task_deliverables + task_activities produced by dispatched agents.
      const legacy = db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
            WHERE blocked_on_human IS NOT NULL AND trim(blocked_on_human) <> ''
              AND (ask IS NULL OR trim(ask) = '' OR lower(trim(ask)) IN ('(no ask specified)', 'no ask specified'))`,
        )
        .get() as { n: number };

      for (const sql of BLOCKED_ASK_TRIGGER_SQL) db.exec(sql);

      if (legacy.n > 0) {
        console.log(
          `[Migration 104] ${legacy.n} pre-existing blocked-without-ask row(s) left INTACT ` +
            '(forward-only enforcement — they keep their deliverables/activities and remain archivable)',
        );
      }
      console.log('[Migration 104] blocked_on_human⇒ask triggers ready');
    },
  },
  {
    id: '105',
    name: 'add_task_persona_bundle_scope',
    up: (db) => {
      // A-U5 (master spec v2 Section A.6) — PER-PAGE / SCOPED persona blends.
      //
      // Migration 090 gave every task exactly ONE persona bundle
      // (`task_persona_bundle.task_id TEXT NOT NULL UNIQUE`) — a 5-page funnel
      // wrote its opt-in, sales, and thank-you pages under one blend. This
      // migration is PURELY ADDITIVE: it never touches 090's table, columns,
      // or UNIQUE constraint (see the A-U5 binary acceptance test that dumps
      // and diffs 090's schema pre/post this migration).
      //
      // New table `task_persona_bundle_scope`, keyed `(task_id, scope)`
      // composite UNIQUE — one row per PAGE (or, per U115's later
      // generalization, per PART) of a task, each carrying its own bundle
      // JSON. `scope` mirrors the ONB matcher's `build_bundle(scope_hint=...)`
      // resolved scope key (persona_blend.py's `_resolve_scope_key`:
      // page_slug > page_role > part_id). The unscoped `task_persona_bundle`
      // row remains the task-level default; every pre-A-U5 consumer (the
      // tasks GET LEFT JOIN, the dispatch mirror columns, the backfill sweep)
      // keeps reading it untouched.
      //
      // Renumbered 104 -> 105 by the Wave One Stage B merge-writer: main
      // independently landed migration 104 (`reject_blocked_on_human_without_ask`)
      // ahead of this branch's own merge; this migration's body is otherwise
      // byte-identical to what shipped on the branch.
      console.log('[Migration 105] Adding task_persona_bundle_scope table...');

      db.exec(`
        CREATE TABLE IF NOT EXISTS task_persona_bundle_scope (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          page_role TEXT,
          page_slug TEXT,
          conversion_goal TEXT,
          -- Mirror columns (same rationale as migration 090's tasks mirror
          -- columns): the resolved VOICE persona for this page/scope, so the
          -- chip row reads a plain column instead of re-parsing bundle_json.
          voice_persona_id TEXT,
          voice_persona_name TEXT,
          bundle_json TEXT,
          catalog_version TEXT,
          scope_reason TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (task_id, scope)
        )
      `);
      db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_task_persona_bundle_scope_task ON task_persona_bundle_scope(task_id)',
      ).run();

      console.log('[Migration 105] task_persona_bundle_scope ready');
    },
  },
  {
    id: '106',
    name: 'add_provider_auth_proof_failure_kind',
    up: (db) => {
      // PURELY ADDITIVE — one nullable column on migration 100's
      // provider_auth_proof_cache. Never rewrites an existing row: rows written
      // before this migration keep failure_kind NULL, and provider-auth-proof.ts
      // reports those as the honest 'unknown' rather than inventing a cause.
      //
      // WHY: a failed proof was being stored as a bare ok:0, so the Model
      // Settings tile rendered "model not found" (a STALE local catalog row —
      // e.g. ollama-cloud/deepseek-v3.1:671b, which no longer exists upstream)
      // identically to "your key was rejected". That manufactured phantom auth
      // incidents on boxes whose keys were perfectly good. failure_kind keeps
      // the two apart: 'auth' is a real rejection; 'model_not_found' means auth
      // was never disproven and the catalog needs a refresh.
      console.log('[Migration 106] Adding provider_auth_proof_cache.failure_kind...');

      const cols = db.prepare(`PRAGMA table_info(provider_auth_proof_cache)`).all() as { name: string }[];
      const hasColumn = cols.some((c) => c.name === 'failure_kind');

      if (cols.length === 0) {
        // Table not present yet (fresh DB where 100 hasn't run): nothing to
        // alter — migration 100 creates it and this is a no-op.
        console.log('[Migration 106] provider_auth_proof_cache absent — skipping (no-op)');
        return;
      }

      if (!hasColumn) {
        db.exec(`ALTER TABLE provider_auth_proof_cache ADD COLUMN failure_kind TEXT`);
      }

      console.log('[Migration 106] provider_auth_proof_cache.failure_kind ready');
    },
  },
  {
    id: '107',
    name: 'add_task_persona_bundle_scope_per_part_fields',
    up: (db) => {
      // U115 (E6-1, closes G7; master spec v2 Section E6, ADD-1) — per-part /
      // per-persona governance across multi-item & long-horizon tasks. The CC
      // leg of U115 (the ONB leg landed on openclaw-onboarding main,
      // c396225187a5b61d028a95b2e1aa256b3a4fae0e, and explicitly left this leg
      // OWED). PURELY ADDITIVE: never touches migration 090's task_persona_
      // bundle table or its UNIQUE(task_id); never touches migration 105's
      // UNIQUE(task_id, scope) on task_persona_bundle_scope — this migration
      // only ADDS nullable mirror columns to the EXISTING 105 table.
      //
      // The ONB matcher's `govern_task_parts` (persona_blend.py) emits an
      // 8-key record PER PART into routing/part-persona-map.json:
      //   part_id, part_role, voice_persona_id, topic_persona_id,
      //   audience_label, audience_source, stage, reason.
      // Migration 105 already gave 3 of those 8 a home: part_id -> `scope`
      // (U115 generalizes A-U5's page-scope key to a part-scope key, per
      // 105's own header comment), voice_persona_id -> `voice_persona_id`,
      // reason -> `scope_reason`. The remaining 5 — part_role, stage,
      // topic_persona_id, audience_label, audience_source — get NEW columns
      // here. `audience_label`/`audience_source` close acceptance (c)'s
      // explicit "naming its blend + audience" requirement, which was absent
      // from every CC layer before this migration.
      //
      // Column-existence-guarded ALTER TABLE (same pattern as every additive
      // mirror-column migration in this file, e.g. the CRITICAL_TASKS_
      // DISPATCH_COLUMNS driven ALTERs below) so this migration is a safe
      // no-op on a box where schema.ts already created these columns on a
      // fresh DB (schema.ts's task_persona_bundle_scope CREATE TABLE is kept
      // in sync with the post-107 shape — see schema.ts).
      //
      // MERGE-WRITER RENUMBER NOTE: this migration was scored and built as id
      // '106' (skill6-v2/U115 @ 64ccd7ab). Between QC and merge, main picked
      // up an unrelated, independently-scored migration 106 (provider-defects-
      // fix, PR #196: provider_auth_proof_cache.failure_kind) that collided on
      // the same id. Both migrations are purely additive and touch entirely
      // disjoint tables (provider_auth_proof_cache vs task_persona_bundle_
      // scope) — no semantic conflict, only an id collision. Renumbered to
      // '107' by the merge writer per this file's own DATA-03 fail-fast
      // guard below. Neither test file asserts on the numeric id, only on
      // column existence, so this renumber does not change test behavior.
      console.log('[Migration 107] Adding per-part governance columns to task_persona_bundle_scope...');

      const scopeInfo = db.prepare("PRAGMA table_info(task_persona_bundle_scope)").all() as { name: string }[];
      const hasCol = (name: string) => scopeInfo.some((c) => c.name === name);

      const newColumns: { name: string; ddl: string }[] = [
        { name: 'part_role', ddl: 'ALTER TABLE task_persona_bundle_scope ADD COLUMN part_role TEXT' },
        { name: 'stage', ddl: 'ALTER TABLE task_persona_bundle_scope ADD COLUMN stage TEXT' },
        { name: 'topic_persona_id', ddl: 'ALTER TABLE task_persona_bundle_scope ADD COLUMN topic_persona_id TEXT' },
        { name: 'audience_label', ddl: 'ALTER TABLE task_persona_bundle_scope ADD COLUMN audience_label TEXT' },
        { name: 'audience_source', ddl: 'ALTER TABLE task_persona_bundle_scope ADD COLUMN audience_source TEXT' },
      ];
      for (const col of newColumns) {
        if (!hasCol(col.name)) {
          db.exec(col.ddl);
          console.log(`[Migration 107] Added ${col.name} to task_persona_bundle_scope`);
        }
      }

      console.log('[Migration 107] task_persona_bundle_scope per-part columns ready');
    },
  },
  {
    id: '108',
    name: 'add_comms_audience_mirror_columns',
    up: (db) => {
      // U116 (E6-2; master spec v2 Section E6-2, implements ADD-2, closes G8)
      // — Command Center leg, BINARY acceptance (e): "the board card renders
      // the chosen audience (standard vs specific) alongside the persona-
      // blend chips (snapshot)".
      //
      // ⚠️ NAME-COLLISION TRAP (do not "simplify" this to reuse `audience_source`):
      // `tasks.audience_source` already exists (migration 090) and mirrors
      // `bundle.resolved_audience.source` — vocabulary
      // onboarding_icp | operator_confirmed | asked (persona_blend.py's
      // resolve_audience provenance). U116 introduces a SECOND, semantically
      // DIFFERENT field stamped onto the bundle ROOT (not nested under
      // resolved_audience) by the ONB-side comms_audience_trigger.py:350 —
      // `bundle["audience_source"]` — vocabulary standard | specific (the
      // ADD-2 "should I use your standard audience, or a specific one"
      // confirmation outcome). These two fields legitimately coexist on the
      // SAME bundle with DIFFERENT values and must never collapse into one
      // column. This migration adds `comms_audience_source` as a distinctly
      // named mirror column so the two are structurally unable to collide.
      //
      // Two additive, nullable mirror columns on `tasks` (same mirror-column
      // rationale as migration 090's tasks columns — the board reads a plain
      // column instead of re-parsing bundle_json):
      //   comms_audience_source — 'standard' | 'specific' | null. Written by
      //     persistPersonaBundle from the bundle-ROOT `audience_source` field
      //     (parsePersonaBundle's `comms_audience_source`), NEVER from
      //     `resolved_audience.source`.
      //   comms_type — 'page' | 'blog' | 'email' | 'sms' | 'social' | null.
      //     Written from the bundle-ROOT `comms_type` field, stamped by the
      //     same ONB-side trigger.
      //
      // ADDITIVE ONLY — never touches migration 090's `audience_source`
      // column, `task_persona_bundle`, or `task_persona_bundle_scope` (105).
      // A pre-108 row simply lacks these columns and the board renders the
      // U116 chip's empty-state (the U116 revert clause: "the audience chip
      // renders empty-state when the field is absent").
      //
      // MERGE-WRITER RENUMBER NOTE: this migration was scored and built as id
      // '106' (skill6-v2/U116-cc-leg @ 1e65a94e). Between QC and merge, main
      // independently picked up TWO other migrations that both landed at
      // migration ids that would have collided (provider-defects-fix's own
      // real 106, and U115's originally-106-now-107) — none of this was
      // foreseeable at authoring time (this branch's commit predates the
      // colliding provider-defects-fix merge by 5+ hours). Renumbered to the
      // next free id, '108', by the merge writer per this file's own DATA-03
      // fail-fast guard below. Neither U116 test file asserts on the numeric
      // id, only on column existence via PRAGMA table_info, so this renumber
      // does not change test behavior.
      console.log('[Migration 108] Adding comms_audience_source + comms_type mirror columns...');

      const tasksInfo = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
      const columnNames = tasksInfo.map((c) => c.name);
      const adds: Record<string, string> = {
        comms_audience_source: 'TEXT',
        comms_type: 'TEXT',
      };
      for (const [col, type] of Object.entries(adds)) {
        if (!columnNames.includes(col)) {
          db.prepare(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`).run();
        }
      }

      console.log('[Migration 108] comms_audience_source + comms_type ready');
    },
  },

  // ── Migration 109 — D-C2 / D8: RATIFIED 2026-07-16 as REJECT. The catch-
  //    all's client-facing display name stays "General Task"; the proposed
  //    rename to "General Stuff" was explicitly rejected by the operator. ──
  {
    id: '109',
    name: 'guard_general_task_display_name_stays_general_task',
    up: (db) => {
      // MERGE-WRITER RENUMBER NOTE: this migration was originally authored
      // and scored as id '106' (skill6-v2/U44 @ 3eb6093), when it renamed
      // the catch-all's display name to "General Stuff" per D-C2's
      // then-unratified recommendation. QC (~/skill6-merge-queue/CC/U44.json,
      // score 5.0, SEND BACK) caught that D8 was never operator-ratified —
      // the master spec's own governance text marked it "none is ratified"
      // on both 2026-07-14 and 2026-07-15. Trevor ratified D8 on 2026-07-16
      // as REJECT (see ledgers/ratified-decisions-2026-07-16.md in
      // trevorotts1/openclaw-onboarding): "General Task" stays exactly as
      // it was; "General Stuff" never ships. Between original authoring and
      // this fix, main independently landed a DIFFERENT migration 106
      // (provider-defects-fix, PR #196) and two sibling branches (U115,
      // U116) already renumbered their own id-106 collisions to 107 and
      // 108 — so this migration is renumbered again, to the next free id,
      // '109', per this file's own DATA-03 fail-fast guard below.
      //
      // Because D8 was rejected, there is no rename left to apply — but
      // this migration id is kept (rather than deleted outright) as a
      // DEFENSIVE NORMALIZER: it corrects any workspace row that drifted
      // away from the canonical "General Task" (a stray "General Stuff"
      // from local/branch testing of the now-rejected proposal, or a
      // pre-existing plural "General Tasks" variant) back to the ratified
      // name. The SLUG stays FROZEN at 'general-task' regardless — routing,
      // ingest fallbacks, migration 059's sort pin, and the recurrence
      // detector all key on the slug, never the display name (see
      // departments.config.ts:854-878). Idempotent: a box whose name is
      // already the canonical "General Task" is left untouched (0 rows
      // changed) on every re-run.
      console.log('[Migration 109] Normalizing general-task workspace display name to "General Task"...');
      try {
        const result = db
          .prepare(
            `UPDATE workspaces
                SET name = 'General Task'
              WHERE lower(slug) = 'general-task'
                AND name != 'General Task'`
          )
          .run();
        console.log(`[Migration 109] Normalized ${result.changes} general-task workspace row(s) to "General Task"`);
      } catch (e) {
        // Non-fatal — mirrors migration 059's own guard: the row may not
        // exist yet on a fresh install (DEFAULT_DEPARTMENTS seeds it there
        // with the canonical name already).
        console.log('[Migration 109] Skipped:', (e as Error).message);
      }
    },
  },
  {
    id: '110',
    name: 'add_ceo_chat_usage_columns',
    up: (db) => {
      // U62 (JM/U65, master E.2) — "My AI CEO" Phase B, exact usage metering.
      // BINARY acceptance: "usage frames ... re-emitted as a new SSE `usage`
      // event and echoed by history for reload continuity — the meter drops
      // `≈` on the first real frame." A page reload wipes client state, so
      // the ContextMeter can only resume exact mode after reload if the LAST
      // assistant turn's usage was actually persisted, not just held in
      // memory — hence these three columns.
      //
      // Three additive, nullable INTEGER columns on the EXISTING
      // ceo_chat_messages table (migration 101) — same column-existence-
      // guarded ALTER TABLE pattern as migration 107/108/109 above, so this
      // is a safe no-op on a box where schema.ts already created these
      // columns on a fresh DB (schema.ts's ceo_chat_messages CREATE TABLE is
      // kept in sync with the post-110 shape).
      //   usage_input   the gateway's real prompt-token count for this turn.
      //   usage_output  the gateway's real completion-token count.
      //   usage_total   the gateway's real total (may differ from
      //                 input+output on providers with cache read/write).
      // Populated ONLY on an assistant row where a real usage frame was
      // captured mid-stream (src/lib/ceo-chat/gateway.ts extractUsage()) —
      // NULL on every user/system/trust row and on any assistant row where
      // no usage frame arrived, so the app never fabricates a false-precise
      // number.
      //
      // MERGE-WRITER RENUMBER NOTE: originally authored and scored as id
      // '109' (the next free id at authoring time, verified directly against
      // this file — highest existing id was '108'). While this branch was in
      // flight, main independently landed migration 109
      // (guard_general_task_display_name_stays_general_task, D-C2/D8 REJECT)
      // — a real, unforeseeable id collision (disjoint tables:
      // ceo_chat_messages vs workspaces, no semantic conflict), same pattern
      // as migrations 107/108's own renumber notes above. Renumbered to the
      // next free id, '110', on rebase, per this file's own DATA-03
      // fail-fast guard below. Neither this migration's own tests nor
      // ceo-chat-store.test.ts assert on the numeric id, only on column
      // existence, so this renumber does not change test behavior.
      console.log('[Migration 110] Adding usage_input/usage_output/usage_total to ceo_chat_messages...');

      const chatInfo = db.prepare('PRAGMA table_info(ceo_chat_messages)').all() as { name: string }[];
      const columnNames = chatInfo.map((c) => c.name);
      const adds: Record<string, string> = {
        usage_input: 'INTEGER',
        usage_output: 'INTEGER',
        usage_total: 'INTEGER',
      };
      for (const [col, type] of Object.entries(adds)) {
        if (!columnNames.includes(col)) {
          db.prepare(`ALTER TABLE ceo_chat_messages ADD COLUMN ${col} ${type}`).run();
        }
      }

      console.log('[Migration 110] ceo_chat_messages usage columns ready');
    },
  },

  // MERGE-WRITER RENUMBER NOTE: originally authored and scored as id '110'
  // (the next free id at authoring time, verified directly against this file
  // — highest existing id was '109'). While this branch was in flight, main
  // independently landed its OWN migration '110' (add_ceo_chat_usage_columns,
  // U62/Phase B exact usage metering) — a real, unforeseeable id collision
  // (disjoint tables: ceo_chat_messages vs workspaces, no semantic conflict),
  // same pattern as this file's own 095/107/108/109/110 renumber notes.
  // Renumbered to the next free id, '111', on merge integration into main.
  // tests/unit/migration-110-funnels-seed.test.ts renamed to
  // migration-111-funnels-seed.test.ts to match; neither it nor any other
  // test asserts on the numeric id, only on the resulting workspace row, so
  // this renumber does not change test behavior. The DATA-03 duplicate-id
  // fail-fast below is exactly what would have rejected the clash at module
  // load had this not been renumbered.
  // ── Migration 111 — U118 (2026-07-16, operator ruling): backfill the
  //    "funnels" department workspace on every PRE-EXISTING box. ─────────────
  {
    id: '111',
    name: 'seed_funnels_department_workspace',
    up: (db) => {
      // Operator ruling, verbatim: "THEN USE THE STANDALONE WORKSPACE IF IT
      // ALREADY EXISTS." Skill 6's 06-ghl-install-pages/tools/cc_board.py has
      // ALWAYS unconditionally stamped department_slug='funnels' for every
      // job_type='funnel' card (job_type itself defaults to 'funnel') — that
      // stamp was never vertical-gated, so on a standard-floor box with no ad
      // hoc 'funnels' workspace already seeded (unlike the operator's own
      // box), INGEST-06's unrecognized-slug tier (src/app/api/tasks/ingest/
      // route.ts's resolveWorkspaceId) silently rerouted every funnel card to
      // the general-task catch-all. departments.config.ts's DEFAULT_DEPARTMENTS
      // now carries a real 'funnels' entry (id 'funnels', mandatory/universal —
      // NOT in VERTICAL_PACK_DEPARTMENTS), and canonical-slug.ts's
      // CANONICAL_SLUGS now includes it. That fixes every FRESH install (the
      // normal DEFAULT_DEPARTMENTS / departments.json seed path creates the
      // workspace like any other floor department) and — via
      // reseedWorkspacesFromConfig's manifest-GROWTH path — any client whose
      // ONB-side departments.json is regenerated to include the new mandatory
      // dept. This migration is the one-time BACKFILL for every OTHER
      // pre-existing box: it inserts exactly one 'funnels' workspace row if
      // (and only if) none already exists, so a box that already carries an ad
      // hoc 'funnels' workspace (seeded outside the floor, by hand — the
      // operator's own box) is left untouched (0 rows changed, per the
      // ruling's own "IF IT ALREADY EXISTS" instruction).
      //
      // Idempotent + additive: never deletes, never updates an existing row
      // (matches migration 059/109's own additive-only pattern for this
      // table). company_id is anchored to an EXISTING workspace row's
      // company_id (preferring the CEO/master-orchestrator row, the one every
      // box seeds first) rather than re-deriving it via branding-seed.ts's
      // seedCompanyGuarded — a migration must never risk creating/mutating a
      // company row as a side effect of backfilling one department workspace.
      console.log('[Migration 111] Backfilling the "funnels" department workspace...');

      const existing = db
        .prepare(`SELECT id FROM workspaces WHERE lower(slug) = 'funnels' OR lower(id) = 'funnels' LIMIT 1`)
        .get() as { id: string } | undefined;
      if (existing) {
        console.log(`[Migration 111] "funnels" workspace already present (id=${existing.id}) — no-op`);
        return;
      }

      let companyRow = db
        .prepare(
          `SELECT company_id FROM workspaces
            WHERE lower(slug) IN ('master-orchestrator', 'ceo', 'dept-ceo')
            ORDER BY sort_order ASC LIMIT 1`
        )
        .get() as { company_id: string } | undefined;
      if (!companyRow) {
        companyRow = db
          .prepare(`SELECT company_id FROM workspaces ORDER BY rowid ASC LIMIT 1`)
          .get() as { company_id: string } | undefined;
      }
      if (!companyRow) {
        // Genuinely empty install (no workspaces at all yet) — nothing to
        // anchor to. The normal fresh-install seed path (DEFAULT_DEPARTMENTS /
        // autoSeedFromDepartmentsJson) creates "funnels" along with every
        // other floor department once the box actually seeds; this backfill
        // is only for a box that already has OTHER workspace rows.
        console.log('[Migration 111] No existing workspace to anchor company_id — skipping (fresh install seeds "funnels" normally)');
        return;
      }

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
         VALUES ('funnels', 'Funnels', 'funnels', ?, ?, ?, 1000, ?, ?)`
      ).run(
        "Owns the automated GHL sales-funnel build queue Skill 6 creates: cut/import/verify/provision execution, build QA, and conversion-tracking verification.",
        '🔻',
        companyRow.company_id,
        now,
        now,
      );
      console.log('[Migration 111] Inserted the "funnels" department workspace');
    },
  },
];

// DATA-03: fail-fast at module load if two migrations share an id. The runner
// keys applied-state on `_migrations.id` and snapshots the applied set ONCE at
// the top of a run, so a duplicate id is a latent land-mine: depending on order
// it either double-applies (the second INSERT throws a PRIMARY KEY violation and
// aborts the whole run) or — history-attested — the second definition is treated
// as already-applied and SILENTLY never runs on any box (its heal ships but never
// executes). A renumbering mistake must break the build here, not on a client
// box at boot. Runs at import time, before any migration can execute.
(() => {
  const ids = migrations.map((m) => m.id);
  if (new Set(ids).size !== ids.length) {
    const dupes = Array.from(new Set(ids.filter((id, i) => ids.indexOf(id) !== i)));
    throw new Error(
      `[migrations] duplicate migration id(s) detected: ${dupes.join(', ')} — each migration id must be unique`,
    );
  }
})();

// DATA-02: the id of the migration that most recently failed in this process,
// exported so a health endpoint can surface a precise "migration <id> failed"
// 503 instead of an opaque boot crash. Cleared on any fully-successful run.
let lastFailedMigrationId: string | null = null;
export function getLastFailedMigrationId(): string | null {
  return lastFailedMigrationId;
}

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
        // Migration owns its own transaction boundary (e.g. a 12-step table
        // rebuild that must toggle PRAGMA foreign_keys OUTSIDE a transaction).
        // The runner records the apply in a tiny independent statement AFTER
        // up() succeeds.
        try {
          migration.up(db);
          db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name);
        } finally {
          // DATA-06: a non-outer migration disables FK enforcement for its
          // rebuild (`PRAGMA foreign_keys=OFF`) and re-enables it on the happy
          // path. If up() threw AFTER the OFF but BEFORE the ON, enforcement
          // would stay OFF for the rest of this connection's life — every later
          // migration AND all runtime writes would then silently accept
          // orphaned foreign keys. Re-assert ON here so a failed/partial rebuild
          // can never leave the connection with FK checks disabled.
          db.pragma('foreign_keys = ON');
        }
      }

      console.log(`[DB] Migration ${migration.id} completed`);
    } catch (error) {
      // DATA-02: record WHICH migration failed so a health endpoint can surface
      // a precise "migration <id> failed" 503, then re-throw (fail-closed — a
      // half-migrated schema must never serve traffic; see getDb() in db/index.ts).
      lastFailedMigrationId = migration.id;
      console.error(`[DB] Migration ${migration.id} failed:`, error);
      throw error;
    }
  }

  // DATA-02: every pending migration applied cleanly — clear any stale failure
  // marker left by an earlier failed attempt in this process.
  lastFailedMigrationId = null;

  // DATA-01: MAKE THE LEDGER HONEST. A migration is recorded "applied" by id
  // ALONE (DATA-03 duplicate-id guard), so a guarded ALTER whose guard was
  // satisfied by a PRIOR body under the same id records applied WITHOUT its
  // column ever existing — the falsely-healed box climbs to HEAD and reports
  // healthy while task dispatch is dead. Migration 097 reconciles that by
  // inspecting the LIVE schema; we ALSO verify the effect HERE and log LOUDLY
  // if a critical dispatch column/index is STILL absent, so a ledger-lie can
  // never again pass silently. We do NOT throw — throwing would brick a box in
  // an unforeseen shape (exactly what migration 096 refuses to do); the loud
  // line + checkDispatchSchemaHealth() / scripts/cc-schema-health.ts surface it.
  // (The deeper redesign — verify EVERY migration's effect before recording it
  // applied, e.g. a per-migration `verify` hook — is intentionally out of scope
  // for this release; this covers the one HOT, confirmed-broken invariant.)
  try {
    const health = checkDispatchSchemaHealth(db);
    if (!health.ok) {
      console.error(
        '[DB] SCHEMA-INTEGRITY (DATA-01): after all migrations, tasks is STILL missing ' +
          `column(s) [${health.missingColumns.join(', ') || 'none'}] / index(es) ` +
          `[${health.missingIndexes.join(', ') || 'none'}]. ` +
          (health.ledgerClaimsAppliedButAbsent.length
            ? `The _migrations ledger FALSELY claims migration(s) ${health.ledgerClaimsAppliedButAbsent.join(', ')} applied. `
            : '') +
          'Task dispatch will fail with "no such column: t.dispatch_attempts". ' +
          'Run `npx tsx scripts/cc-schema-health.ts` to audit this box.',
      );
    }
  } catch (verifyErr) {
    console.error('[DB] SCHEMA-INTEGRITY check errored (non-fatal):', (verifyErr as Error).message);
  }

  // Auto-seed from departments.json if workspaces table is empty
  autoSeedFromDepartmentsJson(db);

  // PRD 2.11: Ensure the trio (QC + research + DA) exists for every workspace.
  // This covers the case where migration 065 ran before any workspaces existed
  // (autoSeedFromDepartmentsJson may have just created them above). Idempotent —
  // and, since C3, idempotent on the ROLE rather than on the agent id, so this
  // boot-time call tops up missing trio members without ever duplicating one.
  autoSeedTrioAgents(db);

  // C3: no workspace may be headless. Migration 028's head backfill ran ONCE, so
  // every workspace created after it (including by autoSeedFromDepartmentsJson
  // directly above) was born with head_agent_id = NULL and nothing refilled it —
  // 13 accumulated. Running the reaper on every boot means a headless workspace
  // cannot survive a restart. Idempotent; non-fatal.
  try {
    const heads = ensureWorkspaceHeadAgents(db);
    if (heads.promoted + heads.created > 0) {
      console.log(
        `[Auto-seed Heads] Promoted ${heads.promoted} + materialised ${heads.created} department head(s)`,
      );
    }
  } catch (err) {
    console.log('[Auto-seed Heads] Skipped:', (err as Error).message);
  }

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

    const seeded = seedTrioForWorkspaces(db, workspaces);
    const total = seeded.qc + seeded.research + seeded.devilsAdvocate;
    if (total > 0) {
      console.log(
        `[Auto-seed Trio] Seeded ${seeded.qc} QC + ${seeded.research} Research + ` +
          `${seeded.devilsAdvocate} Devil's Advocate agent(s) across ${workspaces.length} workspace(s); ` +
          `${seeded.skipped} role slot(s) already filled (role_type-aware skip)`,
      );
    }
  } catch (err) {
    // Non-fatal: log and continue.
    console.log('[Auto-seed Trio] Skipped:', (err as Error).message);
  }
}

// ── C3: duplicate trio agents + headless workspaces ──────────────────────────
//
// ROOT CAUSE (create side). Migration 065 and autoSeedTrioAgents both seeded the
// trio with `INSERT OR IGNORE` keyed on their OWN deterministic ids
// (`research-agent-<ws.id>`, `da-agent-<ws.id>`). Skill 23 had ALREADY seeded the
// same *roles* under different (hex) ids — e.g. marketing carried BOTH
// 'Deep Research Specialist — Marketing' (hex, role_type='deep-research') AND
// 'Marketing Research Specialist' (research-agent-marketing, role_type='research').
// `INSERT OR IGNORE` only suppresses a PRIMARY-KEY collision, so a different id
// carrying the SAME role never collided: it duplicated. Every re-provision
// (converge → reseedWorkspacesFromConfig → autoSeedTrioAgents) re-ran that seed,
// so the trio multiplied instead of converging. The fix is to make the seed
// idempotent on the ROLE, not on the id.
//
// ROOT CAUSE (head side). Migration 028 backfilled workspaces.head_agent_id ONCE.
// Migrations run once, so every workspace created AFTERWARDS (autoSeedFromDepartments-
// Json, reseedWorkspacesFromConfig) was born with head_agent_id = NULL and nothing
// ever filled it — 13 workspaces accumulated with no head, including mandatory
// floor departments. ensureWorkspaceHeadAgents() below is the reaper/guard: it runs
// on EVERY boot, so a headless workspace cannot survive a restart.
//
// role_type vocabulary. Skill 23 writes 'deep-research'; CC writes 'research'. They
// are the SAME role. resolveTrioAgents() matched `role_type = 'research'` exactly,
// so the 58 live 'deep-research' rows were invisible to it — which is precisely why
// the CC seed thought the slot was empty and inserted a duplicate. We canonicalise
// the alias in the DB (migration 092) AND teach the resolver both spellings.

/** The three trio role slots, in canonical spelling. */
export const TRIO_ROLE_TYPES = ['qc', 'research', 'devils-advocate'] as const;
export type TrioRoleType = (typeof TRIO_ROLE_TYPES)[number];

/**
 * Every role_type spelling that means a trio role, mapped to its canonical form.
 * Skill 23 and CC evolved separate vocabularies; this is the reconciliation table.
 */
export const TRIO_ROLE_ALIASES: Readonly<Record<string, TrioRoleType>> = {
  qc: 'qc',
  research: 'research',
  'deep-research': 'research', // Skill-23 spelling for the same role
  'devils-advocate': 'devils-advocate',
};

/** The role_type that marks a department head. All 54 live heads use this. */
export const HEAD_ROLE_TYPE = 'leadership';

/**
 * Canonicalise a role_type to its trio slot, or null when it is NOT a trio role.
 *
 * Returning null for non-trio roles is the load-bearing safety property of the
 * de-dup: 'specialist', 'leadership', 'healer' and 'orchestrator' agents are
 * legitimately many-per-workspace (the live `presentations` department has 17
 * DISTINCT role_type='specialist' agents). De-duping those would delete 16 real
 * agents. Only the trio is one-per-workspace-per-role.
 */
export function canonicalTrioRole(roleType: string | null | undefined): TrioRoleType | null {
  if (!roleType) return null;
  return TRIO_ROLE_ALIASES[roleType.trim().toLowerCase()] ?? null;
}

/** Every alias spelling for a canonical trio slot (for SQL IN (...) matching). */
function aliasesFor(role: TrioRoleType): string[] {
  return Object.keys(TRIO_ROLE_ALIASES).filter((a) => TRIO_ROLE_ALIASES[a] === role);
}

/** Ids this codebase generates for trio agents — used to tell CC rows from Skill-23 rows. */
function isCcGeneratedTrioId(id: string): boolean {
  return /^(qc|research|da)-agent-/.test(id);
}

/**
 * Seed the trio (QC + Research + Devil's Advocate) for the given workspaces,
 * skipping any ROLE SLOT that is already filled by ANY agent — whatever its id or
 * alias spelling. This is the C3 create-side guard: it makes re-provisioning
 * converge instead of multiply.
 */
export function seedTrioForWorkspaces(
  db: Database.Database,
  workspaces: { id: string; name: string }[],
): { qc: number; research: number; devilsAdvocate: number; skipped: number } {
  const result = { qc: 0, research: 0, devilsAdvocate: 0, skipped: 0 };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO agents
      (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
       specialist_type, role_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'standby', 0, ?, 'permanent', ?, datetime('now'), datetime('now'))
  `);

  const spec = (ws: { id: string; name: string }): Record<TrioRoleType, {
    id: string; name: string; role: string; emoji: string; desc: string;
  }> => ({
    qc: {
      id: `qc-agent-${ws.id}`,
      name: `${ws.name} QC Specialist`,
      role: 'QC Specialist',
      emoji: '🔍',
      desc: `Quality control specialist for the ${ws.name} department. Reviews completed tasks against SOP success criteria and decides whether work moves to Done or back to In Progress.`,
    },
    research: {
      id: `research-agent-${ws.id}`,
      name: `${ws.name} Research Specialist`,
      role: 'Research Specialist',
      emoji: '🔬',
      desc: `Deep-research specialist for the ${ws.name} department. Applies the Tier-1 research mandate (McKinsey, Harvard Business Review, IBISWorld, Statista citations required) to discover, synthesise, and validate information needed by the department's specialists and SOP library.`,
    },
    'devils-advocate': {
      id: `da-agent-${ws.id}`,
      name: `${ws.name} Devil's Advocate`,
      role: "Devil's Advocate",
      emoji: '😈',
      // DA description is intentionally operator-facing only — never shown in client UI.
      desc: `[INTERNAL — not surfaced to client] Devil's Advocate for the ${ws.name} department. Stress-tests plans, decisions, and deliverables by surfacing assumptions, edge cases, and counter-arguments BEFORE they become problems. Reports findings only to the department's QC Specialist and the master orchestrator.`,
    },
  });

  for (const ws of workspaces) {
    const specs = spec(ws);
    for (const role of TRIO_ROLE_TYPES) {
      const aliases = aliasesFor(role);
      const placeholders = aliases.map(() => '?').join(',');
      // The guard: does ANY agent already fill this role slot for this workspace,
      // regardless of id or alias spelling? (INSERT OR IGNORE could not see this.)
      const existing = db
        .prepare(
          `SELECT id FROM agents WHERE workspace_id = ? AND lower(role_type) IN (${placeholders}) LIMIT 1`,
        )
        .get(ws.id, ...aliases) as { id: string } | undefined;

      if (existing) {
        result.skipped++;
        continue;
      }

      const s = specs[role];
      const info = insert.run(s.id, s.name, s.role, s.desc, s.emoji, ws.id, role);
      if (info.changes > 0) {
        if (role === 'devils-advocate') result.devilsAdvocate++;
        else result[role]++;
      }
    }
  }

  return result;
}

/** A workspace/role slot filled by more than one agent. */
export interface DuplicateTrioGroup {
  workspaceId: string;
  role: TrioRoleType;
  agentIds: string[];
}

/**
 * Find every workspace/role slot occupied by more than one trio agent.
 * Alias-aware ('deep-research' and 'research' collapse into one slot) and
 * strictly limited to trio roles, so multi-specialist departments are never
 * reported. Used by the de-dup migration and as a standing invariant in tests.
 */
export function findDuplicateTrioAgents(db: Database.Database): DuplicateTrioGroup[] {
  const cols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('role_type')) return [];

  const rows = db
    .prepare(
      `SELECT id, workspace_id, role_type FROM agents
        WHERE workspace_id IS NOT NULL AND role_type IS NOT NULL
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all() as { id: string; workspace_id: string; role_type: string }[];

  const groups = new Map<string, DuplicateTrioGroup>();
  for (const r of rows) {
    const role = canonicalTrioRole(r.role_type);
    if (!role) continue; // non-trio roles are legitimately many-per-workspace
    const key = `${r.workspace_id}::${role}`;
    const g = groups.get(key) ?? { workspaceId: r.workspace_id, role, agentIds: [] };
    g.agentIds.push(r.id);
    groups.set(key, g);
  }

  return Array.from(groups.values()).filter((g) => g.agentIds.length > 1);
}

/** Workspaces with no head agent — the thing that must always be zero. */
export function findHeadlessWorkspaces(db: Database.Database): { id: string; slug: string }[] {
  const cols = (db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('head_agent_id')) return [];
  return db
    .prepare(
      `SELECT w.id, w.slug FROM workspaces w
        WHERE w.head_agent_id IS NULL OR w.head_agent_id = ''
           OR NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = w.head_agent_id)
        ORDER BY w.slug ASC`,
    )
    .all() as { id: string; slug: string }[];
}

/** Every column in the schema that is a FOREIGN KEY onto agents(id). */
function agentFkColumns(db: Database.Database): { table: string; column: string }[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];

  const out: { table: string; column: string }[] = [];
  for (const t of tables) {
    // Introspect rather than hardcode: the live schema has 12 FK columns onto
    // agents across 12 tables with mixed ON DELETE actions (SET NULL / CASCADE /
    // NO ACTION). A hardcoded list silently rots as tables are added.
    const fks = db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as {
      table: string; from: string;
    }[];
    for (const fk of fks) {
      if (fk.table === 'agents') out.push({ table: t.name, column: fk.from });
    }
  }
  return out;
}

export interface TrioDedupeResult {
  aliasesNormalized: number;
  groupsFound: number;
  agentsRemoved: number;
  referencesRepointed: number;
  groupsSkipped: number;
}

/**
 * Collapse duplicate trio agents to ONE agent per workspace/role, preserving all
 * references.
 *
 * Survivor selection (deterministic, highest wins):
 *   1. most inbound FK references   — never orphan real work
 *   2. NOT a CC-generated id        — keep the older/richer Skill-23 row (per spec)
 *   3. name matches the workspace   — disambiguates merged departments, e.g. the
 *                                     'engineering' workspace carries 4 DAs, two of
 *                                     them named '— App Development' from a merged
 *                                     tree; this keeps 'Devil's Advocate — Engineering'
 *   4. oldest created_at, then lowest rowid
 *
 * Losers' references are repointed onto the survivor BEFORE deletion. If any
 * reference cannot be repointed (a UNIQUE collision), the loser is KEPT rather than
 * deleted — a duplicate row is recoverable, a destroyed foreign key is not.
 *
 * Idempotent: running it twice is a no-op (the second pass finds no groups).
 */
export function dedupeTrioAgents(db: Database.Database): TrioDedupeResult {
  const result: TrioDedupeResult = {
    aliasesNormalized: 0, groupsFound: 0, agentsRemoved: 0,
    referencesRepointed: 0, groupsSkipped: 0,
  };

  const cols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('role_type')) return result;

  // 1. Canonicalise the alias vocabulary FIRST, so 'deep-research' and 'research'
  //    group into one slot here AND become visible to resolveTrioAgents().
  for (const alias of Object.keys(TRIO_ROLE_ALIASES)) {
    const canonical = TRIO_ROLE_ALIASES[alias];
    if (alias === canonical) continue;
    const info = db
      .prepare('UPDATE agents SET role_type = ?, updated_at = datetime(\'now\') WHERE lower(role_type) = ?')
      .run(canonical, alias);
    result.aliasesNormalized += info.changes;
  }

  const groups = findDuplicateTrioAgents(db);
  result.groupsFound = groups.length;
  if (groups.length === 0) return result;

  const fkCols = agentFkColumns(db);

  const countRefs = (agentId: string): number => {
    let n = 0;
    for (const fk of fkCols) {
      const row = db
        .prepare(`SELECT count(*) AS c FROM "${fk.table}" WHERE "${fk.column}" = ?`)
        .get(agentId) as { c: number };
      n += row.c;
    }
    return n;
  };

  for (const g of groups) {
    const ws = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(g.workspaceId) as
      | { name: string }
      | undefined;
    const wsName = (ws?.name ?? '').toLowerCase();

    const candidates = g.agentIds.map((id) => {
      const row = db
        .prepare('SELECT id, name, created_at, rowid AS rid FROM agents WHERE id = ?')
        .get(id) as { id: string; name: string; created_at: string; rid: number };
      return {
        ...row,
        refs: countRefs(id),
        ccGenerated: isCcGeneratedTrioId(id),
        nameAffinity: wsName.length > 0 && row.name.toLowerCase().includes(wsName),
      };
    });

    candidates.sort((a, b) => {
      // Identity first, references LAST. Reference count deliberately does NOT
      // outrank identity: every loser's references are repointed onto the survivor
      // below, so keeping the most-referenced row buys no safety the repoint does
      // not already provide — while letting a stray reference on a CC-generated row
      // hijack the survivor slot. It really happened: the live 'engineering' DA
      // duplicate had ONE events row pinned to 'da-agent-app-development', which was
      // enough to beat "Devil's Advocate — Engineering" and leave the department
      // holding a wrongly-named internal agent.
      if (a.ccGenerated !== b.ccGenerated) return a.ccGenerated ? 1 : -1;   // prefer the Skill-23 row
      if (a.nameAffinity !== b.nameAffinity) return a.nameAffinity ? -1 : 1; // prefer own-dept name
      const t = String(a.created_at).localeCompare(String(b.created_at));
      if (t !== 0) return t;                                                 // oldest / richer
      if (a.refs !== b.refs) return b.refs - a.refs;                        // fewest repoints
      return a.rid - b.rid;                                                  // stable
    });

    const survivor = candidates[0];
    const losers = candidates.slice(1);

    for (const loser of losers) {
      // Repoint every inbound reference onto the survivor. OR IGNORE absorbs a
      // UNIQUE collision (e.g. the survivor is already a participant in the same
      // conversation) instead of aborting the migration.
      for (const fk of fkCols) {
        const info = db
          .prepare(`UPDATE OR IGNORE "${fk.table}" SET "${fk.column}" = ? WHERE "${fk.column}" = ?`)
          .run(survivor.id, loser.id);
        result.referencesRepointed += info.changes;
      }

      // Any reference that survived the repoint hit a UNIQUE collision. Deleting the
      // loser now would CASCADE (conversation_participants, agent_memory_logs) or
      // dangle a NO ACTION FK (tasks, messages, events). Keep the row instead.
      const residual = countRefs(loser.id);
      if (residual > 0) {
        result.groupsSkipped++;
        console.warn(
          `[C3 dedupe] Kept duplicate ${loser.id} (workspace=${g.workspaceId} role=${g.role}): ` +
            `${residual} reference(s) could not be repointed onto ${survivor.id}`,
        );
        continue;
      }

      db.prepare('DELETE FROM agents WHERE id = ?').run(loser.id);
      result.agentsRemoved++;
    }
  }

  return result;
}

export interface HeadAgentResult {
  promoted: number;
  created: number;
  stillHeadless: number;
}

/**
 * Guarantee every workspace has a head agent.
 *
 * Prefers promoting an existing non-trio agent (a 'leadership' row first — that is
 * what all 54 live heads are). Only when a workspace has NOTHING but trio
 * specialists — which is exactly the state the 13 headless departments were in, each
 * holding just a Research + Devil's Advocate row — does it materialise a head.
 *
 * A trio agent is NEVER promoted to head: the Devil's Advocate is an INTERNAL role
 * that must never surface in client-facing UI, and the department head does.
 *
 * Runs on every boot, so a headless workspace cannot survive a restart. Idempotent.
 */
export function ensureWorkspaceHeadAgents(db: Database.Database): HeadAgentResult {
  const result: HeadAgentResult = { promoted: 0, created: 0, stillHeadless: 0 };

  const wsCols = (db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map((c) => c.name);
  const agentCols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name);
  if (!wsCols.includes('head_agent_id') || !agentCols.includes('role_type')) return result;

  const headless = findHeadlessWorkspaces(db);
  if (headless.length === 0) return result;

  const setHead = db.prepare('UPDATE workspaces SET head_agent_id = ? WHERE id = ?');
  const insertHead = db.prepare(`
    INSERT OR IGNORE INTO agents
      (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
       specialist_type, role_type, created_at, updated_at)
    VALUES (?, ?, 'Department Head', ?, '🧭', 'standby', 0, ?, 'permanent', ?, datetime('now'), datetime('now'))
  `);

  const trioAliases = Object.keys(TRIO_ROLE_ALIASES);
  const trioPlaceholders = trioAliases.map(() => '?').join(',');

  for (const ws of headless) {
    // Promote the best existing non-trio agent: a 'leadership' row wins, then the
    // oldest remaining non-trio agent.
    const candidate = db
      .prepare(
        `SELECT id FROM agents
          WHERE workspace_id = ?
            AND (role_type IS NULL OR lower(role_type) NOT IN (${trioPlaceholders}))
          ORDER BY CASE WHEN lower(role_type) = ? THEN 0 ELSE 1 END, created_at ASC, rowid ASC
          LIMIT 1`,
      )
      .get(ws.id, ...trioAliases, HEAD_ROLE_TYPE) as { id: string } | undefined;

    if (candidate) {
      setHead.run(candidate.id, ws.id);
      result.promoted++;
      continue;
    }

    // Nothing but trio specialists — materialise the department head.
    const wsRow = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(ws.id) as
      | { name: string }
      | undefined;
    const wsName = wsRow?.name ?? ws.slug;
    const headId = `head-agent-${ws.id}`;
    const desc = `Department head for the ${wsName} department. Owns the department's queue: triages incoming work, assigns tasks to specialists, and is accountable for the department's deliverables.`;

    insertHead.run(headId, `${wsName} Department Head`, desc, ws.id, HEAD_ROLE_TYPE);

    const exists = db.prepare('SELECT id FROM agents WHERE id = ?').get(headId) as { id: string } | undefined;
    if (!exists) {
      result.stillHeadless++;
      console.warn(`[C3 heads] Could not materialise a head agent for workspace ${ws.slug}`);
      continue;
    }
    setHead.run(headId, ws.id);
    result.created++;
  }

  return result;
}

// ── C2: ghost SOP-library cleanup ────────────────────────────────────────────
// Deprecated department slugs whose starter SOP rows are retired (dropped from
// sops-seed.ts; soft-deleted here on DBs that already seeded them). Matched
// against each row's ORIGINAL department value BEFORE canonicalization so 'ceo'
// is retired rather than rescued to master-orchestrator.
const DEPRECATED_SOP_DEPARTMENTS: readonly string[] = [
  'ceo',
  'security',
  'hr-people',
  'finance-accounting',
  'operations',
  'data-analytics',
  'executive-assistant',
];

// C8 — TEST_RESIDUE_SOP_DEPARTMENTS now lives in ../test-residue (imported
// above) so the API-layer gate (api/sops/route.ts) and the converge assertion
// (detectTestResidue below) share the SAME exact allowlist as this migration —
// never a LIKE/pattern match here (a 'testing-lab' or 'contest-dept' client
// dept must never be purged).

export interface SopGhostCleanupResult {
  rekeyed: number;
  deprecatedRetired: number;
  testPurged: number;
}

/**
 * C2 — retire the ghost SOP-library residue and re-key legacy alias rows to the
 * canonical ZHC department slug set.
 *
 * PRESERVES every surviving row's sop id: dispatch_rules.sop_id (an FK by
 * convention) and Triad SOP matching key off the id, so re-keying only ever
 * UPDATEs the `department` column, never re-inserts.
 *
 * Order matters:
 *   1. PURGE test-dept residue (hard DELETE, exact slug). FK-safe: sop_proposals
 *      may reference sops(id) and foreign_keys is ON at connection, so any stray
 *      reference to a test-dept row is nulled out first (test rows are never real
 *      proposals, but this makes the DELETE impossible to trip an FK).
 *   2. SOFT-DELETE deprecated-dept rows (set deleted_at) by ORIGINAL department.
 *   3. RE-KEY remaining active rows: department := canonicalDeptSlug(department).
 *
 * Idempotent: a second run purges/retires nothing and re-keys nothing (all
 * active rows already canonical).
 */
export function rekeyAndPurgeGhostSops(db: Database.Database): SopGhostCleanupResult {
  const empty: SopGhostCleanupResult = { rekeyed: 0, deprecatedRetired: 0, testPurged: 0 };

  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sops'")
    .get();
  if (!hasTable) return empty;

  const cols = db.prepare('PRAGMA table_info(sops)').all() as { name: string }[];
  const hasDeletedAt = cols.some((c) => c.name === 'deleted_at');
  const now = new Date().toISOString();

  // ── 1. PURGE test-dept residue ─────────────────────────────────────────────
  const testPlaceholders = TEST_RESIDUE_SOP_DEPARTMENTS.map(() => '?').join(',');
  const testRows = db
    .prepare(`SELECT id FROM sops WHERE department IN (${testPlaceholders})`)
    .all(...TEST_RESIDUE_SOP_DEPARTMENTS) as { id: string }[];
  let testPurged = 0;
  if (testRows.length > 0) {
    const hasProposals = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sop_proposals'")
      .get();
    if (hasProposals) {
      const clearApproved = db.prepare('UPDATE sop_proposals SET approved_sop_id = NULL WHERE approved_sop_id = ?');
      const clearReplaces = db.prepare('UPDATE sop_proposals SET replaces_sop_id = NULL WHERE replaces_sop_id = ?');
      for (const { id } of testRows) {
        clearApproved.run(id);
        clearReplaces.run(id);
      }
    }
    testPurged = db
      .prepare(`DELETE FROM sops WHERE department IN (${testPlaceholders})`)
      .run(...TEST_RESIDUE_SOP_DEPARTMENTS).changes;
  }

  // ── 2. SOFT-DELETE deprecated-department rows (by original department) ──────
  let deprecatedRetired = 0;
  if (hasDeletedAt) {
    const depPlaceholders = DEPRECATED_SOP_DEPARTMENTS.map(() => '?').join(',');
    deprecatedRetired = db
      .prepare(
        `UPDATE sops SET deleted_at = ?, updated_at = ?
         WHERE department IN (${depPlaceholders}) AND deleted_at IS NULL`,
      )
      .run(now, now, ...DEPRECATED_SOP_DEPARTMENTS).changes;
  }

  // ── 3. RE-KEY remaining active rows to canonical slugs (id preserved) ──────
  const activeClause = hasDeletedAt ? 'WHERE deleted_at IS NULL' : '';
  const activeRows = db
    .prepare(`SELECT id, department FROM sops ${activeClause}`)
    .all() as { id: string; department: string | null }[];
  const rekeyStmt = db.prepare('UPDATE sops SET department = ?, updated_at = ? WHERE id = ?');
  let rekeyed = 0;
  for (const row of activeRows) {
    const canon = canonicalDeptSlug(row.department);
    if (canon && canon !== (row.department ?? '')) {
      rekeyStmt.run(canon, now, row.id);
      rekeyed++;
    }
  }

  return { rekeyed, deprecatedRetired, testPurged };
}

// ── C8 — test/fixture residue: workspaces + companies ───────────────────────
// rekeyAndPurgeGhostSops (above) only ever touched the `sops` table. The same
// live QC-harness leak also left fixture WORKSPACES (smoke-test-dept,
// no-script-dept — 7 fixture agents each) and a `testco` COMPANY row behind.
// This section extends the C2 cleanup pattern to those two tables, reusing the
// SAME exact-allowlist discipline (see ../test-residue.ts).

/**
 * A single test-shaped title token. Kept separate from TEST_RESIDUE_DETECT_PATTERN
 * (slug-shaped) because task TITLES are free text, not hyphenated slugs.
 *
 * This pattern is the ONLY thing standing between a task and a HARD DELETE
 * (purgeTestResidueWorkspaces drops the row outright), so it is deliberately
 * NARROW — on a destructive path, err toward KEEPING data:
 *
 *   - 'routing' and 'probe' were removed. Both are ordinary business words: a
 *     real task titled "Fix routing for the campaign" or "Probe the vendor's
 *     API limits" would have been classified test-shaped and DESTROYED. A
 *     false negative here is a skipped purge an operator reviews by hand; a
 *     false positive is unrecoverable client work loss. Not a close call.
 *
 * Every token that remains is one no real client task title would carry as a
 * standalone word (`test`, `e2e`, `smoke`, `dims`, `fixture`). If a workspace
 * on the exact allowlist holds a task this does NOT match, the workspace is
 * SKIPPED (never force-purged) and reported for manual review.
 */
const TASK_TEST_TITLE_PATTERN = /\b(test|e2e|smoke|dims|fixture)\b/i;

export interface TestResidueReport {
  /** workspaces.slug values that look test/fixture-shaped (detection only). */
  workspaces: string[];
  /** active sops.department values that look test/fixture-shaped (detection only). */
  sopDepartments: string[];
  /** companies.slug values that look test/fixture-shaped (detection only). */
  companies: string[];
}

/**
 * C8 — DETECTION ONLY (never deletes, never mutates). Scans workspaces / active
 * SOPs / companies for test-or-fixture-shaped slugs so a converge run (or a
 * standalone QC check) can FAIL LOUD when residue is live in a prod DB — see
 * TEST_RESIDUE_DETECT_PATTERN's docstring for why this is intentionally
 * BROADER than (and must stay decoupled from) the exact-slug delete allowlists.
 */
export function detectTestResidue(db: Database.Database): TestResidueReport {
  const report: TestResidueReport = { workspaces: [], sopDepartments: [], companies: [] };

  const tableExists = (name: string) =>
    !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

  // All three branches use isTestResidueSlug (pattern OR exact allowlist).
  // Pattern-ONLY would be BLIND to `no-script-dept`: it is on
  // TEST_RESIDUE_WORKSPACE_SLUGS and IS hard-deleted by migration 093, yet it
  // carries no test-shaped token, so a pattern-only gate would never fail loud
  // on it — letting known residue ride onto a client board whenever 093 is
  // deferred (it is `deferInAdditiveSelfHeal`) or skipped.
  if (tableExists('workspaces')) {
    const rows = db.prepare('SELECT slug FROM workspaces').all() as { slug: string | null }[];
    for (const { slug } of rows) {
      if (isTestResidueSlug(slug, TEST_RESIDUE_WORKSPACE_SLUGS)) report.workspaces.push(slug!);
    }
  }

  if (tableExists('sops')) {
    const cols = db.prepare('PRAGMA table_info(sops)').all() as { name: string }[];
    const activeClause = cols.some((c) => c.name === 'deleted_at') ? 'WHERE deleted_at IS NULL' : '';
    const rows = db
      .prepare(`SELECT DISTINCT department FROM sops ${activeClause}`)
      .all() as { department: string | null }[];
    for (const { department } of rows) {
      if (isTestResidueSlug(department, TEST_RESIDUE_SOP_DEPARTMENTS)) report.sopDepartments.push(department!);
    }
  }

  if (tableExists('companies')) {
    const rows = db.prepare('SELECT slug FROM companies').all() as { slug: string | null }[];
    for (const { slug } of rows) {
      if (isTestResidueSlug(slug, TEST_RESIDUE_COMPANY_SLUGS)) report.companies.push(slug!);
    }
  }

  return report;
}

export interface TestResidueWorkspaceCleanupResult {
  /** Workspace slugs that were dropped (fixture agents + tasks with them). */
  workspacesPurged: string[];
  /** Workspace slugs on the allowlist that were found but left untouched, with why. */
  workspacesSkipped: { slug: string; reason: string }[];
}

/**
 * C8 — EXACT-slug cleanup of fixture workspaces (`smoke-test-dept`,
 * `no-script-dept`) that leaked into the live DB from an un-isolated test
 * harness. NEVER pattern-deletes — see ../test-residue.ts. Idempotent: a slug
 * absent from `workspaces` (already cleaned, or never present on this box) is
 * silently skipped-as-absent (not reported as skipped/purged).
 *
 * Safety: a matched workspace is dropped ONLY when EVERY task referencing it
 * is itself test-shaped (TASK_TEST_TITLE_PATTERN) or it has zero tasks. A
 * workspace carrying any real-looking task, or any FK the deletion can't
 * satisfy, is left completely untouched and reported in `workspacesSkipped`
 * for manual review — this cleanup must never destroy real client work.
 */
export function purgeTestResidueWorkspaces(db: Database.Database): TestResidueWorkspaceCleanupResult {
  const result: TestResidueWorkspaceCleanupResult = { workspacesPurged: [], workspacesSkipped: [] };

  const hasWorkspaces = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'")
    .get();
  if (!hasWorkspaces) return result;

  for (const slug of TEST_RESIDUE_WORKSPACE_SLUGS) {
    const ws = db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug) as { id: string } | undefined;
    if (!ws) continue; // not present on this box — nothing to do, not a "skip"

    const tasks = db.prepare('SELECT id, title FROM tasks WHERE workspace_id = ?').all(ws.id) as {
      id: string;
      title: string;
    }[];
    const nonTest = tasks.filter((t) => !TASK_TEST_TITLE_PATTERN.test(t.title || ''));
    if (nonTest.length > 0) {
      result.workspacesSkipped.push({
        slug,
        reason: `${nonTest.length} non-test-looking task(s) reference this workspace — left untouched`,
      });
      continue;
    }

    try {
      const purge = db.transaction(() => {
        const agentIds = (
          db.prepare('SELECT id FROM agents WHERE workspace_id = ?').all(ws.id) as { id: string }[]
        ).map((a) => a.id);
        // Delete the (already-confirmed-test-shaped) tasks FIRST so no FK from
        // tasks.assigned_agent_id/created_by_agent_id blocks the agent deletes
        // below (those columns carry no ON DELETE clause).
        for (const t of tasks) {
          db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
        }
        for (const agentId of agentIds) {
          db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
        }
        // workspaces.head_agent_id is ON DELETE SET NULL, so it self-clears
        // above when its agent is deleted — safe to delete the workspace now.
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
      });
      purge();
      result.workspacesPurged.push(slug);
    } catch (err) {
      // FK conflict from a table this function doesn't know about (e.g. a
      // deliverable or message row referencing a fixture agent) — never half-
      // delete; the transaction already rolled back. Leave it for manual
      // review rather than crashing the whole migration/converge run.
      result.workspacesSkipped.push({
        slug,
        reason: `cleanup failed (${(err as Error).message}) — left untouched for manual review`,
      });
    }
  }

  return result;
}

export interface TestResidueCompanyCleanupResult {
  /** Company slugs that were deleted. */
  companiesPurged: string[];
  /** Company slugs found but left untouched, with why. */
  companiesSkipped: { slug: string; reason: string }[];
}

/**
 * C8 — EXACT-slug cleanup of the fixture `testco` COMPANY row left behind by
 * the same un-isolated QC harness (it is a role-library-import ingest ROOT
 * candidate, so a stray one can mis-attribute an ingest).
 *
 * This closes a real hole: BEFORE this function existed, `detectTestResidue`
 * flagged `testco`, converge returned 500 on the hit, and the 500's own
 * remediation text told the operator to run migrations 091/092 — but NOTHING
 * anywhere deleted a company row (the only other `DELETE FROM companies` is
 * migration 030, scoped to slugs 'default'/'command-center'). The advice
 * provably did not work, so converge stayed 500 forever on any box carrying a
 * testco row. Now the advice is true.
 *
 * Safety: NEVER pattern-deletes (see ../test-residue.ts), and a company is
 * dropped ONLY when nothing references it — `workspaces.company_id` is a real
 * FK (schema.ts:35). A referenced company is left completely untouched and
 * reported in `companiesSkipped` for manual review; deleting it would orphan or
 * cascade into live workspaces. Idempotent: an absent slug is a silent no-op.
 */
export function purgeTestResidueCompanies(db: Database.Database): TestResidueCompanyCleanupResult {
  const result: TestResidueCompanyCleanupResult = { companiesPurged: [], companiesSkipped: [] };

  const hasCompanies = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companies'")
    .get();
  if (!hasCompanies) return result;

  const hasWorkspaces = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'")
    .get();

  for (const slug of TEST_RESIDUE_COMPANY_SLUGS) {
    const company = db.prepare('SELECT id FROM companies WHERE slug = ?').get(slug) as
      | { id: string }
      | undefined;
    if (!company) continue; // not on this box — nothing to do

    // FK guard: refuse to delete a company any workspace still points at.
    if (hasWorkspaces) {
      const refs = db
        .prepare('SELECT COUNT(*) AS c FROM workspaces WHERE company_id = ?')
        .get(company.id) as { c: number };
      if (refs.c > 0) {
        result.companiesSkipped.push({
          slug,
          reason:
            `${refs.c} workspace(s) still reference this company — left untouched. ` +
            `Purge/re-home those workspaces first (migration 093 handles the fixture ones).`,
        });
        continue;
      }
    }

    try {
      db.prepare('DELETE FROM companies WHERE id = ?').run(company.id);
      result.companiesPurged.push(slug);
    } catch (err) {
      // A FK from a table this function doesn't know about — never half-delete.
      result.companiesSkipped.push({
        slug,
        reason: `cleanup failed (${(err as Error).message}) — left untouched for manual review`,
      });
    }
  }

  return result;
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

// TCC-safe metadata checks. On macOS an unprivileged background process can
// BLOCK FOREVER on open()/opendir() under ~/Downloads · ~/Desktop · ~/Documents,
// but stat() is measured-safe there — safeIsFile/safeIsDir take the fast direct
// path on TCC dirs and only bound network/removable volumes. See src/lib/fs/safe-fs.ts.
function isExistingFile(p: string): boolean {
  return safeIsFile(p);
}

function isExistingDir(p: string): boolean {
  return safeIsDir(p);
}

/** Legacy hard-coded install locations (preserved verbatim, additive). */
function legacyConfigCandidates(): string[] {
  return [
    // SAFE, non-TCC canonical location — highest legacy priority so a fixed
    // install (or a box migrated off ~/Downloads) resolves here first and never
    // needs to touch a TCC-gated dir. See src/lib/fs/safe-fs.ts.
    path.join(os.homedir(), '.openclaw', 'master-files', 'company-discovery', DEPARTMENTS_JSON),
    path.join(os.homedir(), 'clawd', 'projects', 'blackceo-command-center', 'config', DEPARTMENTS_JSON),
    path.join(os.homedir(), 'projects', 'mission-control', 'config', DEPARTMENTS_JSON),
    // LEGACY ~/Downloads location (TCC-protected). Retained ONLY so a not-yet-
    // migrated box is not orphaned; every read of it goes through the bounded,
    // never-blocking safe-fs helpers — it can never freeze boot again.
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
    // SAFE, non-TCC canonical root FIRST — new/fixed installs land here and the
    // boot path never has to probe a protected dir.
    path.join(os.homedir(), '.openclaw', 'master-files', 'zero-human-company'),
    // LEGACY ~/Downloads root (TCC-protected). Read only via the bounded,
    // never-blocking safe-fs helpers below so an un-migrated box still resolves
    // but can never freeze boot.
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
    // safeReaddirNames NEVER blocks the event loop: on a TCC-gated / network
    // root it runs the opendir in a hard-timeout child process and returns []
    // if it would hang, instead of freezing boot forever (the 13-hour outage).
    const slugs = safeReaddirNames(root);
    for (const slug of slugs) {
      const candidate = path.join(root, slug, rel);
      const st = safeStatSync(candidate);
      if (!st) continue;
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

  // SHORT-CIRCUIT (Layer 2 of the TCC fix): evaluate candidates in priority
  // order and RETURN THE FIRST HIT, never probing a lower-priority candidate we
  // do not need. The live outage box hung inside step 3 (a ~/Downloads readdir)
  // even though its step-1 env candidate would have won — because the previous
  // implementation built the ENTIRE candidate list eagerly (calling
  // newestZhcChild() up front) before the existence loop. Deferring step 3 means
  // a box whose ZERO_HUMAN_COMPANY_DIR / BLACKCEO_COMMAND_CENTER_ROOT resolves
  // never touches the TCC-gated discovery scan at all.

  // 1. Explicit active-company folder — the strongest signal of the live client.
  if (explicitCompany) {
    const p = path.join(explicitCompany, DEPARTMENTS_JSON);
    if (isExistingFile(p)) return p;
  }
  // 2. Explicit Command Center root (same env the writer's CC copy honors).
  if (ccRoot) {
    for (const p of [
      path.join(ccRoot, 'config', DEPARTMENTS_JSON),
      path.join(ccRoot, 'data', DEPARTMENTS_JSON),
      path.join(ccRoot, DEPARTMENTS_JSON),
    ]) {
      if (isExistingFile(p)) return p;
    }
  }
  // 3. Discovered real ZHC company build — probed only now (LAZY), and BEFORE
  //    the repo-committed template so the newest client departments.json takes
  //    precedence over the demo config/departments.json checked into the repo.
  //    newestZhcChild() reads every ZHC root through the never-blocking safe-fs
  //    helpers, so even this scan cannot freeze boot.
  const zhcBuild = newestZhcChild(DEPARTMENTS_JSON);
  if (zhcBuild && isExistingFile(zhcBuild)) return zhcBuild;
  // 4. The running Command Center itself (process.cwd() === CC root in prod).
  for (const p of [
    path.join(process.cwd(), 'config', DEPARTMENTS_JSON),
    path.join(process.cwd(), 'data', DEPARTMENTS_JSON),
  ]) {
    if (isExistingFile(p)) return p;
  }
  // 5. Legacy hard-coded install locations (safe location first; the legacy
  //    ~/Downloads entry is read only via the bounded safe-fs helpers).
  for (const p of legacyConfigCandidates()) {
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

    // safeReadFileUtf8 NEVER blocks the event loop: if configPath resolved to a
    // TCC-gated ~/Downloads path (legacy box) the open() runs in a hard-timeout
    // child and returns null instead of hanging boot forever. null → treat as
    // "no config" and skip the reseed (service comes up, does not freeze).
    const raw = safeReadFileUtf8(configPath);
    if (raw == null) {
      console.warn('[reseed] departments.json unreadable (absent or TCC-blocked) — skipping workspace reseed:', configPath);
      return { created, updated };
    }
    const depts = JSON.parse(raw);
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

      // C8 INGEST GUARD — never (re-)create a known test/fixture workspace from a
      // stale departments.json. EXACT slug match only (see ../test-residue.ts);
      // a client dept named "testing-lab" is untouched.
      //
      // Without this, the C8 loop is unbreakable: migration 093 hard-deletes
      // `smoke-test-dept` on boot, then the very next converge re-seeds it right
      // back from the manifest, and converge's own residue assertion 500s on the
      // row converge itself just created — a permanent brick no migration can
      // clear. Refusing to create it is the only fix that terminates.
      if (isTestResidueIngestSlug(dept.slug || dept.id)) {
        console.log(
          `[reseed] Skipping "${dept.id || dept.slug}" — test/fixture residue slug (C8); never seeded onto a client board`,
        );
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

    // Re-seed trio agents and starter SOPs (both idempotent).
    // C3: this converge path is the RE-PROVISIONING loop that used to multiply the
    // trio on every run — autoSeedTrioAgents is now role-idempotent, so re-running
    // converge converges instead of duplicating. Newly created workspaces also get
    // a head here, so converge can never mint a headless department.
    autoSeedTrioAgents(db);
    ensureWorkspaceHeadAgents(db);
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

/**
 * DATA-01: A REAL schema health check — "is THIS box's dispatch schema ACTUALLY
 * correct?" — answered by inspecting the LIVE schema (PRAGMA table_info +
 * sqlite_master), NEVER the `_migrations` ledger.
 *
 * The ledger lies: it records a migration applied by id alone, so a box can show
 * 077/078 (and climb to HEAD) while the columns those migrations own were never
 * created — task dispatch is then silently dead ("no such column:
 * t.dispatch_attempts"). This function is how you tell a TRULY-healed box from a
 * FALSELY-healed one: `ok:false` with a non-empty `ledgerClaimsAppliedButAbsent`
 * is the exact falsely-healed signature. Use it to re-audit boxes a ledger-only
 * check called healthy. Read-only; never mutates.
 */
export function checkDispatchSchemaHealth(db: Database.Database): DispatchSchemaHealth {
  const tasksTablePresent = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'")
    .get();
  if (!tasksTablePresent) {
    return {
      ok: false,
      tasksTablePresent: false,
      missingColumns: [],
      missingIndexes: [],
      ledgerClaimsAppliedButAbsent: [],
    };
  }

  const cols = new Set(
    (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name),
  );
  const idxNames = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );

  const missingColumns = CRITICAL_TASKS_DISPATCH_COLUMNS.filter((c) => !cols.has(c.name)).map((c) => c.name);
  // An index is only "expected" once its column exists; a box that is missing the
  // column is reported via missingColumns, not double-counted as a missing index.
  const missingIndexes = CRITICAL_TASKS_DISPATCH_INDEXES.filter(
    (i) => cols.has(i.column) && !idxNames.has(i.name),
  ).map((i) => i.name);

  // Which migration id(s) does the ledger CLAIM applied while their owned columns
  // are absent? That set being non-empty is the falsely-healed fingerprint.
  const owedByGap = new Set<string>();
  for (const c of CRITICAL_TASKS_DISPATCH_COLUMNS) if (!cols.has(c.name)) owedByGap.add(c.owner);
  const migrationTableExists = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_migrations'")
    .get();
  const ledgerApplied = migrationTableExists
    ? new Set((db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map((m) => m.id))
    : new Set<string>();
  const ledgerClaimsAppliedButAbsent = Array.from(owedByGap).filter((id) => ledgerApplied.has(id)).sort();

  return {
    ok: missingColumns.length === 0 && missingIndexes.length === 0,
    tasksTablePresent: true,
    missingColumns,
    missingIndexes,
    ledgerClaimsAppliedButAbsent,
  };
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

  // 2. Try to find from Skill 23 interview answers.
  //    SAFE canonical location first; the legacy ~/Downloads path is read only
  //    via the never-blocking safe-fs helper so a TCC-gated box cannot hang here.
  const answerFiles = [
    path.join(os.homedir(), '.openclaw', 'master-files', 'company-discovery', 'workforce-interview-answers.md'),
    path.join(os.homedir(), '.openclaw', 'workspace', 'company-discovery', 'workforce-interview-answers.md'),
    path.join(os.homedir(), 'Downloads', 'openclaw-master-files', 'company-discovery', 'workforce-interview-answers.md'),
  ];

  for (const f of answerFiles) {
    const content = safeReadFileUtf8(f);
    if (content == null) continue;
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
  }

  // 3. Default fallback
  return 'Command Center';
}
