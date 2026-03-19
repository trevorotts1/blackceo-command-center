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

const AGENTS_DIR = path.join(process.cwd(), 'agents');

// Map of database columns to file names
const FILE_MAP: Record<string, string> = {
  soul_md: 'SOUL.md',
  agents_md: 'AGENTS.md',
  tools_md: 'TOOLS.md',
  memory_md: 'MEMORY.md',
};

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
  return path.join(AGENTS_DIR, agentSlug(name));
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

  fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
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
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }
}
