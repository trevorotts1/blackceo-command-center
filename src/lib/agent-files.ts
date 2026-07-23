/**
 * Agent File Sync Layer
 */
import fs from 'fs';
import path from 'path';
const AGENTS_DIR = path.join(process.cwd(), 'agents');
const FILE_MAP: Record<string, string> = { soul_md: 'SOUL.md', user_md: 'USER.md', agents_md: 'AGENTS.md', tools_md: 'TOOLS.md', memory_md: 'MEMORY.md', };
export class SharedFileSymlinkError extends Error {
  public readonly column: string; public readonly filename: string; public readonly agentName: string;
  constructor(agentName: string, column: string, filename: string) {
    super(`Refusing to write shared file through a symbolic link: agent "${agentName}" column "${column}" -> "${filename}" is a symlink. Shared files (AGENTS.md, TOOLS.md) must be edited in agents/_shared/, not through a single agent's directory.`);
    this.name = 'SharedFileSymlinkError'; this.column = column; this.filename = filename; this.agentName = agentName;
  }
}
export const SHARED_FILE_COLUMNS = new Set(['agents_md', 'tools_md']);
export function isSymlink(filePath: string): boolean { try { return fs.lstatSync(filePath).isSymbolicLink(); } catch { return false; } }
export function checkSharedFileSymlink(name: string, column: string): boolean {
  const dir = agentDir(name); const filename = FILE_MAP[column];
  if (!filename || !SHARED_FILE_COLUMNS.has(column)) return false;
  try { return fs.lstatSync(path.join(dir, filename)).isSymbolicLink(); } catch { return false; }
}
export function agentSlug(name: string): string { return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''); }
export function agentDir(name: string): string { return path.join(AGENTS_DIR, agentSlug(name)); }
export function readAgentFiles(name: string): Record<string, string| null> {
  const dir = agentDir(name); const result: Record<string, string| null> = {};
  for (const [column, filename] of Object.entries(FILE_MAP)) {
    const fp = path.join(dir, filename);
    try { if (fs.existsSync(fp)) result[column] = fs.readFileSync(fp, 'utf-8'); else result[column] = null; } catch { result[column] = null; }
  }
  return result;
}
export function writeAgentFile(name: string, column: string, content: string): void {
  const dir = agentDir(name); const filename = FILE_MAP[column]; if (!filename) return;
  const targetPath = path.join(dir, filename);
  if (SHARED_FILE_COLUMNS.has(column) && isSymlink(targetPath)) { throw new SharedFileSymlinkError(name, column, filename); }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf-8');
}
export function writeAgentDailyLog(name: string, date: string, content: string): void {
  const dir = path.join(agentDir(name), 'memory'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.md`), content, 'utf-8');
}
export function readAgentDailyLog(name: string, date: string): string | null {
  const fp = path.join(agentDir(name), 'memory', `${date}.md`);
  try { if (fs.existsSync(fp)) return fs.readFileSync(fp, 'utf-8'); } catch {}
  return null;
}
export function listAgentDailyLogs(name: string): string[] {
  const dir = path.join(agentDir(name), 'memory');
  try { if (fs.existsSync(dir)) return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', '')).sort().reverse(); } catch {}
  return [];
}
export function createAgentFolder(name: string, role: string, model: string): void {
  const dir = agentDir(name); const md = path.join(dir, 'memory'); fs.mkdirSync(md, { recursive: true });
  let tier = 'Execution'; if (model.includes('opus')) tier = 'Strategic'; else if (model.includes('perplexity')) tier = 'Research';
  const t: Record<string, string> = {
    'SOUL.md': `# ${name}\n\n## Identity\n- **Role:** ${role}\n- **Model:** ${model}\n- **Tier:** ${tier}\n\n## Personality\nDefine this agent's personality, communication style, and values here.\n\n## Boundaries\nWhat this agent should and should not do.\n`,
    'USER.md': `# ${name} - Owner Profile\n\n## About the Operator\nDescribe the human operator's preferences, background, goals, and working style here.\n\n## Communication Preferences\nHow this agent should communicate with the operator.\n`,
    'AGENTS.md': `# ${name} - Workspace Rules\n\n## Role\n${role}\n\n## Rules\n- Follow instructions precisely\n- Report completion with evidence\n- Escalate blockers to Master Orchestrator\n`,
    'TOOLS.md': `# ${name} - Tools & Capabilities\n\n## Available Tools\nList the tools, APIs, and integrations this agent has access to.\n\n## Credentials\nReference any API keys or credentials this agent needs (do not store secrets here).\n`,
    'MEMORY.md': `# ${name} - Long-Term Memory\n\n## Lessons Learned\nCurated memories, decisions, and lessons learned over time.\n\n## Key Decisions\nImportant decisions that should persist across sessions.\n`,
  };
  for (const [fn, c] of Object.entries(t)) { const fp = path.join(dir, fn); if (isSymlink(fp)) continue; if (!fs.existsSync(fp)) fs.writeFileSync(fp, c, 'utf-8'); }
}
export function deleteAgentFolder(name: string): boolean { const d = agentDir(name); if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true }); return true; } return false; }
export function ensureAgentsDir(): void { if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true }); }
