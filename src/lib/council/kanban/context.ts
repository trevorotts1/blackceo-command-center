/**
 * CWE-035 shared authorization context (Sections 17.5, 17.6, 25).
 *
 * Every public method of the parent-and-plan service and the scan queue
 * starts here: the session's scope row is loaded under the principal's
 * own tenant and company, then the CWE-007 session assertions run
 * (scope barrier, private-owner rule, support limits). Machine-channel
 * principals additionally need a CWE-007 machine binding that contains
 * the exact CouncilPermission the method declares, so the four
 * authorizations of Section 25 (build, council run, action-plan
 * approval, execution) stay separate at this layer too: proposing a
 * plan requires 'create_tasks', approving an item requires
 * 'approve_plan', materializing tasks and releasing a plan require
 * 'execute', and session-control resolution requires 'run'. Browser
 * principals are authorized by the session assertions; the declared
 * permission is journaled with every mutation for audit.
 */
import type Database from 'better-sqlite3';
import {
  assertCouncilSessionMutate,
  assertCouncilSessionRead,
  assertMachineBinding,
  CouncilAuthError,
  type CouncilAccessVia,
  type CouncilMachineBinding,
  type CouncilPermission,
  type CouncilPrincipal,
} from '../auth';
import type { ScopeFields, SessionVisibility } from '../contracts';
import {
  envelopeFromScope,
  type CouncilEnvelope,
  type CouncilEnvelopeActor,
  type CouncilEnvelopePurpose,
} from '../store';
import { CouncilKanbanError } from './errors';

export interface CouncilSessionScopeRow {
  id: string;
  tenant_id: string;
  company_id: string;
  installation_id: string;
  owner_subject: string | null;
  visibility: SessionVisibility;
  mode: string;
  state: string;
  state_version: number;
  brief_revision: number;
  archived: number;
}

/** Optional machine-binding proof a route layer passes through. */
export interface KanbanAuthOptions {
  machineBinding?: CouncilMachineBinding;
  headers?: Headers;
}

export interface KanbanAuthorization {
  row: CouncilSessionScopeRow;
  scope: ScopeFields;
  accessVia: CouncilAccessVia;
  permission: CouncilPermission;
}

/**
 * Load a session's scope row under the principal's tenant and company.
 * A session in another tenant or company is indistinguishable from a
 * missing one at this step; the CWE-007 assertion that follows still
 * runs and is what refuses installation-level mismatches.
 */
export function loadKanbanSessionRow(
  db: Database.Database,
  principal: CouncilPrincipal,
  sessionId: string,
): CouncilSessionScopeRow {
  const row = db
    .prepare(
      `SELECT id, tenant_id, company_id, installation_id, owner_subject, visibility,
              mode, state, state_version, brief_revision, archived
         FROM council_sessions
        WHERE tenant_id = ? AND company_id = ? AND id = ?`,
    )
    .get(principal.scope.tenant_id, principal.scope.company_id, sessionId) as
    | CouncilSessionScopeRow
    | undefined;
  if (!row) {
    throw new CouncilKanbanError(
      'COUNCIL_SESSION_NOT_FOUND',
      `Council session ${sessionId} was not found in the caller's scope.`,
      404,
    );
  }
  return row;
}

export function rowScopeFields(row: CouncilSessionScopeRow): ScopeFields {
  return {
    tenant_id: row.tenant_id,
    company_id: row.company_id,
    installation_id: row.installation_id,
    owner_subject: row.owner_subject,
  };
}

/**
 * A session is private when its visibility says so (Section 11.1).
 *
 * CWE-050 reconciliation of the drafts-privacy seam: this predicate
 * previously also treated any non-null owner_subject as private. That
 * contradicted every other layer's visibility derivation — the
 * CWE-005 store adapter (sessionVisibleTo), the CWE-006 repositories
 * (sessionVisibleToEnvelope), and the CWE-007 session assertions all
 * key privacy on `visibility` alone, with owner_subject acting as the
 * identity a private session is checked against, never as a privacy
 * marker by itself. Because CWE-029's createDraftSession stamps
 * owner_subject (the creator) on every draft, the old predicate made
 * every API-created company session "private" here: such sessions
 * could be previewed and approved but never assembled or projected
 * to the board. owner_subject remains the creator/owner of record;
 * privacy is visibility alone.
 */
export function isPrivateSessionRow(row: CouncilSessionScopeRow): boolean {
  return row.visibility === 'private';
}

/**
 * Run the CWE-007 authorization for one kanban operation. Throws
 * CouncilAuthError on any denial; never returns an unauthorized context.
 */
export function authorizeKanbanOperation(
  db: Database.Database,
  principal: CouncilPrincipal,
  sessionId: string,
  permission: CouncilPermission,
  mode: 'read' | 'mutate',
  auth?: KanbanAuthOptions,
): KanbanAuthorization {
  const row = loadKanbanSessionRow(db, principal, sessionId);
  const scope = rowScopeFields(row);
  const target = { scope, visibility: row.visibility };
  const accessVia =
    mode === 'read'
      ? assertCouncilSessionRead(principal, target)
      : assertCouncilSessionMutate(principal, target);
  if (principal.channel === 'machine') {
    if (!auth?.machineBinding || !auth?.headers) {
      throw new CouncilAuthError(
        'COUNCIL_MACHINE_BINDING',
        'Machine kanban operations require the bound machine binding and request headers.',
      );
    }
    assertMachineBinding(principal, auth.headers, auth.machineBinding, permission, sessionId);
  }
  return { row, scope, accessVia, permission };
}

/**
 * Deleted sessions are tombstoned in the CWE-006 store; kanban
 * operations on them fail visibly instead of resurrecting board state.
 */
export function assertKanbanSessionNotDeleted(
  repositories: { isDeleted: (tenantId: string, sessionId: string) => boolean },
  principal: CouncilPrincipal,
  sessionId: string,
): void {
  if (repositories.isDeleted(principal.scope.tenant_id, sessionId)) {
    throw new CouncilKanbanError(
      'COUNCIL_SESSION_DELETED',
      `Council session ${sessionId} was explicitly deleted; its content is gone from the authoritative store.`,
      410,
    );
  }
}

/**
 * The CWE-006 envelope for a kanban operation. Support principals act as
 * 'system' in the journal, machine principals as 'worker', the chair
 * pipeline and browser owners as 'owner'.
 */
export function kanbanEnvelope(
  principal: CouncilPrincipal,
  scope: ScopeFields,
  purpose: CouncilEnvelopePurpose,
): CouncilEnvelope {
  const actor: CouncilEnvelopeActor = principal.supportAccess
    ? 'system'
    : principal.channel === 'machine'
      ? 'worker'
      : 'owner';
  return envelopeFromScope(scope, principal.subject, actor, purpose);
}
