/**
 * Agent File Sync Layer
 * 
 * Syncs agent .md files between the filesystem (agents/<slug>/) and the database.
 * - On startup: reads files from disk, writes to database
 * - On UI edit: writes to both database and disk
 * - On agent create: creates folder + template files
 * - On agent delete: optionally removes folder
 */

import fs from 'fs';
import path from 'path';

/**
 * The agents root. Resolved per call, not captured at import, and overridable
 * with CC_AGENTS_DIR — the same first-class override pattern DATABASE_PATH
 * already uses, so a test can point the writer at a throwaway tree without the
 * production default changing. Unset on every box; the default is unchanged.
 */
function agentsRoot(): string {
  const override = process.env.CC_AGENTS_DIR;
  return override ? path.resolve(override) : path.join(process.cwd(), 'agents');
}

// Map of database columns to file names.
//
// CC-SHARED-001 (T0-43): `user_md` was absent from this map, so every
// USER.md save was accepted by the database and silently never written to disk.
// Every agent's startup procedure reads USER.md ("Read `USER.md` (owner
// profile)"), so an operator edited the owner profile, the interface confirmed
// the save, and every agent kept running on the previous owner context
// indefinitely — invisible from both ends. It is mapped here now, which means
// the shared-file guard below governs it like every other file the interface
// exposes.
const FILE_MAP: Record<string, string> = {
  soul_md: 'SOUL.md',
  user_md: 'USER.md',
  agents_md: 'AGENTS.md',
  tools_md: 'TOOLS.md',
  memory_md: 'MEMORY.md',
};

/**
 * CC-SHARED-001 (T1-04): the shared-file write guard.
 *
 * Every agent directory's AGENTS.md, TOOLS.md and USER.md are SYMBOLIC LINKS to
 * `agents/_shared/…`. `writeAgentFile` used to `fs.writeFileSync` straight at
 * the path, which follows the link: one agent-scoped save from the per-agent
 * editor replaced the operating rules — including the safety rules — for EVERY
 * agent in the company, and the response returned the single updated agent as
 * if one agent had changed. `agents/_shared/AGENTS.md` even lists
 * "Editing this file (it's shared — edit `agents/_shared/AGENTS.md` instead)"
 * among prohibited actions, and the writer performed exactly that.
 *
 * The writer now `lstat`s the destination and refuses a symbolic link with a
 * typed error. Deliberate company-wide changes go through `writeSharedFile`,
 * the one authorised shared-file operation, which is not reachable from the
 * agent-scoped update route.
 */
export class SharedFileError extends Error {
  readonly code = 'SHARED_FILE';
  readonly column: string;
  readonly filename: string;
  readonly sharedTarget: string;

  constructor(column: string, filename: string, sharedTarget: string) {
    super(
      `${filename} is inherited: it is a symbolic link to ${sharedTarget}, shared by every agent. ` +
        `An agent-scoped save cannot write through it.`
    );
    this.name = 'SharedFileError';
    this.column = column;
    this.filename = filename;
    this.sharedTarget = sharedTarget;
  }
}

/**
 * Is this agent's file for `column` an inherited (symlinked) shared file?
 * Returns the link target when it is, otherwise null. Used by the update route
 * to preflight BEFORE the database write, so the database and the disk can
 * never disagree about whether a save happened.
 */
export function sharedFileTarget(name: string, column: string): string | null {
  const filename = FILE_MAP[column];
  if (!filename) return null;
  const filePath = path.join(agentDir(name), filename);
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isSymbolicLink()) return null;
    return fs.readlinkSync(filePath);
  } catch {
    // Absent file: not inherited. A fresh agent directory writes a real file.
    return null;
  }
}

/**
 * Every column the interface exposes whose file is inherited for this agent.
 */
export function inheritedFields(name: string): string[] {
  return Object.keys(FILE_MAP).filter((column) => sharedFileTarget(name, column) !== null);
}

/**
 * Convert agent name to folder slug
 */
export function agentSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Get the folder path for an agent
 */
export function agentDir(name: string): string {
  return path.join(agentsRoot(), agentSlug(name));
}

/**
 * Read all .md files for an agent from disk
 */
export function readAgentFiles(name: string): Record<string, string | null> {
  const dir = agentDir(name);
  const result: Record<string, string | null> = {};

  for (const [column, filename] of Object.entries(FILE_MAP)) {
    const filePath = path.join(dir, filename);
    try {
      if (fs.existsSync(filePath)) {
        result[column] = fs.readFileSync(filePath, 'utf-8');
      } else {
        result[column] = null;
      }
    } catch {
      result[column] = null;
    }
  }

  return result;
}

/**
 * Write a single .md file for an agent to disk
 */
export function writeAgentFile(name: string, column: string, content: string): void {
  const dir = agentDir(name);
  const filename = FILE_MAP[column];
  if (!filename) return;

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filePath = path.join(dir, filename);

  // CC-SHARED-001 (T1-04): lstat, never stat — stat follows the link and would
  // report the shared file as an ordinary file. A symlinked destination is
  // company-wide state and is refused here, at the writer, so no caller can
  // reach it by accident.
  const sharedTarget = sharedFileTarget(name, column);
  if (sharedTarget !== null) {
    throw new SharedFileError(column, filename, sharedTarget);
  }

  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * The ONE authorised company-wide write.
 *
 * Deliberate changes to a shared file go through here: the caller names the
 * shared file explicitly, so a company-wide edit is always an explicit act and
 * never the side effect of saving one agent. It writes `agents/_shared/<file>`
 * directly — never through an agent directory's link.
 */
export function writeSharedFile(filename: string, content: string): void {
  const allowed = new Set(Object.values(FILE_MAP));
  if (!allowed.has(filename)) {
    throw new Error(`writeSharedFile: ${filename} is not one of the managed agent files`);
  }
  const sharedDir = path.join(agentsRoot(), '_shared');
  if (!fs.existsSync(sharedDir)) {
    fs.mkdirSync(sharedDir, { recursive: true });
  }
  const target = path.join(sharedDir, filename);
  const st = fs.existsSync(target) ? fs.lstatSync(target) : null;
  if (st && st.isSymbolicLink()) {
    throw new Error(`writeSharedFile: ${target} is itself a symbolic link — refusing to write through it`);
  }
  fs.writeFileSync(target, content, 'utf-8');
}

/**
 * Write a daily memory log for an agent
 */
export function writeAgentDailyLog(name: string, date: string, content: string): void {
  const dir = path.join(agentDir(name), 'memory');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, `${date}.md`), content, 'utf-8');
}

/**
 * Read a daily memory log for an agent
 */
export function readAgentDailyLog(name: string, date: string): string | null {
  const filePath = path.join(agentDir(name), 'memory', `${date}.md`);
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * List all daily memory logs for an agent
 */
export function listAgentDailyLogs(name: string): string[] {
  const dir = path.join(agentDir(name), 'memory');
  try {
    if (fs.existsSync(dir)) {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''))
        .sort()
        .reverse();
    }
  } catch {
    // ignore
  }
  return [];
}

/**
 * Create folder structure for a new agent with template files
 */
export function createAgentFolder(name: string, role: string, model: string): void {
  const dir = agentDir(name);
  const memoryDir = path.join(dir, 'memory');

  fs.mkdirSync(memoryDir, { recursive: true });

  // Determine tier
  let tier = 'Execution';
  if (model.includes('opus')) tier = 'Strategic';
  else if (model.includes('perplexity')) tier = 'Research';

  // Create template files only if they don't already exist
  const templates: Record<string, string> = {
    'SOUL.md': `# ${name}\n\n## Identity\n- **Role:** ${role}\n- **Model:** ${model}\n- **Tier:** ${tier}\n\n## Personality\nDefine this agent's personality, communication style, and values here.\n\n## Boundaries\nWhat this agent should and should not do.\n`,
    'AGENTS.md': `# ${name} - Workspace Rules\n\n## Role\n${role}\n\n## Rules\n- Follow instructions precisely\n- Report completion with evidence\n- Escalate blockers to Master Orchestrator\n`,
    'TOOLS.md': `# ${name} - Tools & Capabilities\n\n## Available Tools\nList the tools, APIs, and integrations this agent has access to.\n\n## Credentials\nReference any API keys or credentials this agent needs (do not store secrets here).\n`,
    'MEMORY.md': `# ${name} - Long-Term Memory\n\n## Lessons Learned\nCurated memories, decisions, and lessons learned over time.\n\n## Key Decisions\nImportant decisions that should persist across sessions.\n`,
  };

  for (const [filename, content] of Object.entries(templates)) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }
}

/**
 * Delete agent folder (with safety check)
 */
export function deleteAgentFolder(name: string): boolean {
  const dir = agentDir(name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
    return true;
  }
  return false;
}

/**
 * Check if agents directory exists
 */
export function ensureAgentsDir(): void {
  const root = agentsRoot();
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
}
