/**
 * Database Migrations System
 * 
 * Handles schema changes in a production-safe way:
 * 1. Tracks which migrations have been applied
 * 2. Runs new migrations automatically on startup
 * 3. Never runs the same migration twice
 */

import Database from 'better-sqlite3';

interface Migration {
  id: string;
  name: string;
  up: (db: Database.Database) => void;
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
      
      // Insert default workspace if not exists
      db.exec(`
        INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon) 
        VALUES ('default', 'Default Workspace', 'default', 'Default workspace', '🏠');
      `);
      
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
  }
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
  
  // Run pending migrations in order
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }
    
    console.log(`[DB] Running migration ${migration.id}: ${migration.name}`);
    
    try {
      // Run migration in a transaction
      db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name);
      })();
      
      console.log(`[DB] Migration ${migration.id} completed`);
    } catch (error) {
      console.error(`[DB] Migration ${migration.id} failed:`, error);
      throw error;
    }
  }

  // Auto-seed from departments.json if workspaces table is empty
  autoSeedFromDepartmentsJson(db);
}

/**
 * Get migration status
 */
export function getMigrationStatus(db: Database.Database): { applied: string[]; pending: string[] } {
  const applied = (db.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: string }[]).map(m => m.id);
  const pending = migrations.filter(m => !applied.includes(m.id)).map(m => m.id);
  return { applied, pending };
}

// Auto-seed workspaces from config/departments.json on first boot
function autoSeedFromDepartmentsJson(db: any) {
  try {
    const fs = require('fs');
    const path = require('path');
    
    // Check if workspaces table is empty
    const count = db.prepare('SELECT COUNT(*) as c FROM workspaces').get();
    if (count && count.c > 0) return; // Already has data
    
    // Look for departments.json
    const configPath = path.join(process.cwd(), 'config', 'departments.json');
    if (!fs.existsSync(configPath)) return;
    
    const depts = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!Array.isArray(depts) || depts.length === 0) return;
    
    console.log('[Auto-seed] Found departments.json with', depts.length, 'departments');
    
    for (const dept of depts) {
      db.prepare(
        'INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        dept.id,
        dept.name,
        dept.id,
        dept.name + ' department workspace',
        dept.emoji || '📁',
        'default'
      );
      console.log('[Auto-seed] Created workspace:', dept.id, dept.name);
    }
    
    console.log('[Auto-seed] Done. Seeded', depts.length, 'workspaces');
  } catch (err) {
    console.log('[Auto-seed] Skipped:', (err as Error).message);
  }
}
