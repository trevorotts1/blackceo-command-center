import type Database from 'better-sqlite3';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';

export class TaskAgentAccessError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export async function assignmentCompany(request: { headers: Headers }): Promise<string> {
  try {
    const context = await resolveTenantContext(request);
    if (context.kind !== 'self' || (process.env.MC_INSTALLATION_ID && context.installationId !== process.env.MC_INSTALLATION_ID)) {
      throw new TaskAgentAccessError('Task assignment requires the owning installation.', 403);
    }
    return context.companyId;
  } catch (error) {
    if (error instanceof TenantAccessError) throw new TaskAgentAccessError('A verified tenant identity is required.', 403);
    throw error;
  }
}

/** Exact ownership only: legacy default/null company aliases are not authority. */
export function assertTaskCompany(db: Database.Database, taskId: string, companyId: string): void {
  const owned = db.prepare(`SELECT t.id FROM tasks t
    LEFT JOIN workspaces w ON w.id = t.workspace_id
    WHERE t.id = ? AND (
      (t.workspace_id IS NOT NULL AND w.company_id = ?) OR
      (t.workspace_id IS NULL AND EXISTS (
        SELECT 1 FROM task_request_keys k WHERE k.task_id = t.id AND k.company_id = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM task_request_keys k WHERE k.task_id = t.id AND k.company_id != ?
      ))
    )`).get(taskId, companyId, companyId, companyId);
  if (!owned) throw new TaskAgentAccessError('Task not found', 404);
}

export function assertAgentCompany(db: Database.Database, agentId: string | null | undefined, companyId: string): void {
  if (agentId == null) return;
  const owned = db.prepare(`SELECT a.id FROM agents a
    JOIN workspaces w ON w.id = a.workspace_id
    WHERE a.id = ? AND w.company_id = ?`).get(agentId, companyId);
  if (!owned) throw new TaskAgentAccessError('Agent is unavailable in this task company.');
}
