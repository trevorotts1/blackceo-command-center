/**
 * CWE-050 composition adapter: the real CWE-049 run-authorization
 * service behind CWE-035's CouncilRunAuthorizationPort.
 *
 * CWE-035 defined the port against the Section 25.6 surface and
 * shipped a fail-closed default (UnavailableRunAuthorizationPort)
 * because CWE-049 was being built concurrently. CWE-049 has since
 * landed in this tree as CouncilRunAuthorizationService
 * (src/lib/council/run-authorization.ts), and CWE-050 wires it behind
 * the port here, at the composition root, so the CWE-036 execution
 * guard chain evaluates REAL grants:
 *
 * - resolveRunGrant: with an explicit grant reference, the reference
 *   is resolved through the service (every fence applies: granted
 *   stage, session binding, status, lazy expiry, session revocation
 *   generation, standing-parent validity). Without a reference, the
 *   adapter discovers the session's granted run grants in scope and
 *   resolves each through the same service path; the first that
 *   resolves active wins. Nothing is fabricated: a session with no
 *   active grant resolves 'missing' (or the precise terminal status
 *   of its latest granted record), never a synthesized grant.
 * - admitOperation: the port's question is a coverage question — does
 *   the resolved ACTIVE grant admit this task's exact Section 19.6
 *   operation identity? The adapter answers it from recorded state
 *   only: the grant must resolve active through the service for this
 *   session, the operation identity must parse and name this session,
 *   and a council_task_links row created by the approved assembly
 *   must bind that exact operation identity in this scope. It does
 *   NOT create a budget reservation: reserving provider budget for a
 *   task-release check would spend the run envelope on non-inference
 *   work and journal false admissions. Provider-operation admission
 *   and consumption stay on the service's own admit/record pair,
 *   driven by the worker composition (CWE-027), not by this port.
 * - previewRun / approveRun: the port's reduced input shape (a scope
 *   reference and a preview hash) cannot honestly construct a Section
 *   25.6 preview or approval, which require the pinned route
 *   snapshot, ceilings, and an approval decision object. Those
 *   operations are served by the run-authorization endpoints through
 *   the service directly; the adapter throws a precise typed error
 *   rather than inventing inputs. No consumer in this tree calls
 *   them through the port (the guard chain uses resolve/admit only).
 * - recordConsumption: the port admission above reserves nothing, so
 *   there is nothing to record; the adapter answers recorded: false
 *   instead of fabricating a consumption record.
 * - revokeRunGrant: delegates to the service's revocation.
 *
 * The four authorizations stay separate (Section 1.2, binding B16):
 * a council-run grant resolving here never creates a plan, approves
 * a plan, or executes a task. It is one fence in CWE-036's guard
 * chain, evaluated alongside exact plan approval, dependency state,
 * and committed condition verification, all of which must also pass
 * before any task is released.
 */

import type Database from 'better-sqlite3';
import { canonicalHash } from './contracts';
import type { CouncilPrincipal } from './auth';
import {
  CouncilRunAuthorizationService,
  CouncilRunAuthorizationError,
} from './run-authorization';
import { CouncilKanbanError } from './kanban/errors';
import type {
  CouncilRunAuthorizationPort,
  RunGrantReference,
  RunGrantResolution,
  RunPreview,
  RunScopeRef,
} from './kanban/run-authorization-port';

export interface CouncilRunAuthorizationAdapterDeps {
  /** The verified principal this composition acts for (CWE-007). */
  principal: CouncilPrincipal;
  service: CouncilRunAuthorizationService;
  db: Database.Database;
  now?: () => string;
}

interface GrantRow {
  id: string;
  status: string;
  expires_at: string;
  scope_proof: string;
}

function parseProofStage(scopeProof: string): string | null {
  try {
    const parsed = JSON.parse(scopeProof) as { stage?: unknown };
    return typeof parsed.stage === 'string' ? parsed.stage : null;
  } catch {
    return null;
  }
}

/** Parse a Section 19.6 operation identity; null when malformed. */
export function parseCouncilActionOperationId(
  operationId: string,
): { session_id: string; verdict_revision: number; action_id: string; plan_hash: string } | null {
  const match = /^council:(.+):verdict:(\d+):action:(.+):plan:([0-9a-f]{64})$/.exec(operationId);
  if (!match) return null;
  return {
    session_id: match[1],
    verdict_revision: Number(match[2]),
    action_id: match[3],
    plan_hash: match[4],
  };
}

/**
 * Typed refusal for the two port operations this adapter does not
 * serve (preview/approve) and for revocation failures mapped from
 * the CWE-049 service. Carries the precise code so a caller can
 * distinguish "not served through this port" from a storage failure.
 */
export class CouncilRunAuthorizationPortError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'CouncilRunAuthorizationPortError';
    this.code = code;
    this.status = status;
  }
}

export class CouncilRunAuthorizationAdapter implements CouncilRunAuthorizationPort {
  private readonly principal: CouncilPrincipal;
  private readonly service: CouncilRunAuthorizationService;
  private readonly db: Database.Database;
  private readonly now: () => string;

  constructor(deps: CouncilRunAuthorizationAdapterDeps) {
    this.principal = deps.principal;
    this.service = deps.service;
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private scopeMatches(input: RunScopeRef): boolean {
    return (
      input.tenant_id === this.principal.scope.tenant_id &&
      input.company_id === this.principal.scope.company_id
    );
  }

  private grantedRowsForSession(sessionId: string): GrantRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, status, expires_at, scope_proof FROM council_approvals
          WHERE tenant_id = ? AND company_id = ? AND kind = 'run_grant' AND session_id = ?
          ORDER BY issued_at DESC, id DESC`,
      )
      .all(this.principal.scope.tenant_id, this.principal.scope.company_id, sessionId) as GrantRow[];
    return rows.filter((row) => parseProofStage(row.scope_proof) === 'granted');
  }

  private resolutionFor(
    input: RunScopeRef & { grant_ref?: string | null },
    status: RunGrantResolution['status'],
    grantRef: string | null,
  ): RunGrantResolution {
    return {
      status,
      grant_ref: grantRef,
      session_id: input.session_id,
      scope_sha256:
        status === 'active' && grantRef
          ? canonicalHash({
              tenant_id: input.tenant_id,
              company_id: input.company_id,
              installation_id: this.principal.scope.installation_id,
              session_id: input.session_id,
              grant_id: grantRef,
            })
          : null,
    };
  }

  async resolveRunGrant(
    input: RunScopeRef & { grant_ref?: string | null },
  ): Promise<RunGrantResolution> {
    if (!this.scopeMatches(input)) {
      return this.resolutionFor(input, 'missing', null);
    }
    const candidates: string[] = input.grant_ref
      ? [input.grant_ref]
      : this.grantedRowsForSession(input.session_id).map((row) => row.id);
    for (const candidate of candidates) {
      const grant = this.service.resolveRunGrant(this.principal, candidate, input.session_id);
      if (grant) return this.resolutionFor(input, 'active', grant.grant_id);
    }
    if (input.grant_ref) {
      const record = this.service.loadGrantRecord(this.principal, input.grant_ref);
      if (!record || record.proof.stage !== 'granted' || record.session_id !== input.session_id) {
        return this.resolutionFor(input, 'missing', null);
      }
      if (record.status === 'revoked') return this.resolutionFor(input, 'revoked', null);
      if (record.status === 'exhausted') return this.resolutionFor(input, 'exhausted', null);
      return this.resolutionFor(input, 'expired', null);
    }
    const rows = this.grantedRowsForSession(input.session_id);
    if (rows.length === 0) return this.resolutionFor(input, 'missing', null);
    const latest = rows[0];
    if (latest.status === 'revoked') return this.resolutionFor(input, 'revoked', null);
    if (latest.status === 'exhausted') return this.resolutionFor(input, 'exhausted', null);
    if (latest.status === 'expired' || Date.parse(latest.expires_at) <= Date.parse(this.now())) {
      return this.resolutionFor(input, 'expired', null);
    }
    return this.resolutionFor(input, 'missing', null);
  }

  async admitOperation(
    input: RunScopeRef & { grant_ref: string; operation_id: string },
  ): Promise<{ admitted: boolean }> {
    if (!this.scopeMatches(input)) return { admitted: false };
    const grant = this.service.resolveRunGrant(this.principal, input.grant_ref, input.session_id);
    if (!grant) return { admitted: false };
    const parsed = parseCouncilActionOperationId(input.operation_id);
    if (!parsed || parsed.session_id !== input.session_id) return { admitted: false };
    if (parsed.plan_hash.length !== 64) return { admitted: false };
    const link = this.db
      .prepare(
        `SELECT id FROM council_task_links
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND operation_id = ?`,
      )
      .get(input.tenant_id, input.company_id, input.session_id, input.operation_id) as
      | { id: string }
      | undefined;
    return { admitted: link !== undefined };
  }

  async previewRun(): Promise<RunPreview> {
    throw new CouncilRunAuthorizationPortError(
      'COUNCIL_RUN_AUTHORIZATION_PORT_PARTIAL',
      'Run previews require the pinned route snapshot and ceilings of Section 25.6; ' +
        'they are served by the run-authorization endpoints through the CWE-049 service ' +
        'directly, not through this release-coverage port.',
      501,
    );
  }

  async approveRun(): Promise<RunGrantReference> {
    throw new CouncilRunAuthorizationPortError(
      'COUNCIL_RUN_AUTHORIZATION_PORT_PARTIAL',
      'Run approval requires an explicit approval decision under Section 25.6; ' +
        'it is served by the run-authorization endpoints through the CWE-049 service ' +
        'directly, not through this release-coverage port.',
      501,
    );
  }

  async revokeRunGrant(
    input: RunScopeRef & { grant_ref: string; reason?: string | null },
  ): Promise<{ revoked: boolean }> {
    if (!this.scopeMatches(input)) {
      throw new CouncilKanbanError(
        'COUNCIL_SESSION_NOT_FOUND',
        'The grant reference does not resolve in the caller scope.',
        404,
      );
    }
    try {
      const result = this.service.revokeRunGrant(this.principal, input.grant_ref);
      return { revoked: result.status === 'revoked' };
    } catch (error) {
      if (error instanceof CouncilRunAuthorizationError) {
        throw new CouncilRunAuthorizationPortError(
          error.code,
          error.message,
          error.code === 'RUN_GRANT_NOT_FOUND' ? 404 : 409,
        );
      }
      throw error;
    }
  }

  async recordConsumption(): Promise<{ recorded: boolean }> {
    // The port admission is a coverage check that reserves nothing;
    // there is no consumption to record through this surface.
    return { recorded: false };
  }
}
