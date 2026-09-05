import { createHash } from 'crypto';
import type Database from 'better-sqlite3';

export const TASK_REQUEST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_request_keys (
 company_id TEXT NOT NULL,
 source TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 created_at TEXT NOT NULL,
 PRIMARY KEY(company_id, source, operation_id)
);
CREATE TABLE IF NOT EXISTS task_dispatch_intents (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','acknowledged','cancelled')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
`;

export class TaskContextError extends Error { readonly status = 400; }

export class TaskRequestConflict extends Error {
  readonly status = 409;
  constructor() { super('The operation ID was already used with different task instructions.'); }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function taskRequestFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export interface TaskRequestIdentity {
  companyId: string;
  source: string;
  operationId: string;
  fingerprint: string;
}

/** Internal callers must pass a validated company or an owned workspace. */
export function taskRequestCompany(db: Database.Database, workspaceId: string | null, companyId?: string | null): string {
  const workspace = workspaceId ? db.prepare('SELECT company_id FROM workspaces WHERE id = ?')
    .get(workspaceId) as { company_id: string | null } | undefined : undefined;
  if (companyId && workspace?.company_id && workspace.company_id !== companyId) {
    throw new TaskContextError('Task workspace does not belong to the requested company.');
  }
  const resolved = companyId || workspace?.company_id;
  if (resolved) {
    if (!db.prepare('SELECT id FROM companies WHERE id = ?').get(resolved)) throw new TaskContextError('The requested company does not exist.');
    return resolved;
  }
  const slug = process.env.COMPANY_SLUG?.trim();
  const companies = (slug
    ? db.prepare('SELECT id FROM companies WHERE slug = ? LIMIT 2').all(slug)
    : db.prepare('SELECT id FROM companies LIMIT 2').all()) as { id: string }[];
  if (companies.length === 1) return companies[0].id;
  throw new TaskContextError('A unique company context is required to create this task.');
}

export function findTaskRequest(db: Database.Database, identity: TaskRequestIdentity): string | null {
  const row = db.prepare(`SELECT task_id, payload_sha256 FROM task_request_keys
    WHERE company_id = ? AND source = ? AND operation_id = ?`)
    .get(identity.companyId, identity.source, identity.operationId) as { task_id: string; payload_sha256: string } | undefined;
  if (!row) return null;
  if (row.payload_sha256 !== identity.fingerprint) throw new TaskRequestConflict();
  return row.task_id;
}

/** No await or network work may run inside create. Archive retains identity. */
export function createTaskOnce(db: Database.Database, identity: TaskRequestIdentity | null,
  taskId: string, now: string, create: () => void, dispatch: boolean): string | null {
  return db.transaction(() => {
    const existing = identity ? findTaskRequest(db, identity) : null;
    if (existing) return existing;
    create();
    if (identity) db.prepare(`INSERT INTO task_request_keys
      (company_id, source, operation_id, payload_sha256, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(identity.companyId, identity.source, identity.operationId, identity.fingerprint, taskId, now);
    if (dispatch) db.prepare(`INSERT INTO task_dispatch_intents (task_id, created_at, updated_at) VALUES (?, ?, ?)`)
      .run(taskId, now, now);
    return null;
  }).immediate();
}
