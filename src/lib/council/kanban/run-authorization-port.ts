/**
 * CWE-035 run-authorization port, shaped exactly on Section 25.6.
 *
 * CWE-049 (purpose-bound run authorization) is being built concurrently;
 * this unit consumes its surface ONLY through this port and never edits
 * or waits for its files. CWE-050 wires the real CWE-049 implementation
 * behind this interface at composition time.
 *
 * The port matters here for one decision: a plan may be marked ready
 * only when an active run grant reference resolves for the session (the
 * release gate in plan-service). The default implementation is
 * fail-closed: it resolves every grant as missing, so no plan can be
 * released until the real port is wired, and it never fabricates one.
 */
import { CouncilKanbanError } from './errors';

export interface RunScopeRef {
  tenant_id: string;
  company_id: string;
  session_id: string;
}

export interface RunPreview {
  session_id: string;
  preview_sha256: string;
  estimated_cost_minor: number | null;
  currency: string | null;
  seat_count: number;
  risk_class: string | null;
}

export interface RunGrantReference {
  grant_ref: string;
  session_id: string;
  status: 'active' | 'expired' | 'revoked' | 'exhausted';
  scope_sha256: string;
}

export interface RunGrantResolution {
  status: 'active' | 'missing' | 'expired' | 'revoked' | 'exhausted';
  grant_ref: string | null;
  session_id: string;
  scope_sha256: string | null;
}

/** The Section 25.6 purpose-bound run-authorization surface. */
export interface CouncilRunAuthorizationPort {
  previewRun(input: RunScopeRef): Promise<RunPreview>;
  approveRun(input: RunScopeRef & { preview_sha256: string }): Promise<RunGrantReference>;
  resolveRunGrant(
    input: RunScopeRef & { grant_ref?: string | null },
  ): Promise<RunGrantResolution>;
  revokeRunGrant(
    input: RunScopeRef & { grant_ref: string; reason?: string | null },
  ): Promise<{ revoked: boolean }>;
  admitOperation(
    input: RunScopeRef & { grant_ref: string; operation_id: string },
  ): Promise<{ admitted: boolean }>;
  recordConsumption(
    input: RunScopeRef & {
      grant_ref: string;
      operation_id: string;
      amount_minor?: number | null;
      currency?: string | null;
    },
  ): Promise<{ recorded: boolean }>;
}

function unavailable(): CouncilKanbanError {
  return new CouncilKanbanError(
    'COUNCIL_RUN_AUTHORIZATION_UNAVAILABLE',
    'Run authorization (CWE-049) is not wired into this composition yet; ' +
      'the fail-closed default port resolves no grant and issues nothing.',
    503,
  );
}

/**
 * Fail-closed default port used until CWE-050 composes CWE-049.
 * resolveRunGrant answers 'missing' (a resolution, not an error) so
 * release evaluation can report the unmet condition precisely.
 */
export class UnavailableRunAuthorizationPort implements CouncilRunAuthorizationPort {
  async previewRun(): Promise<RunPreview> {
    throw unavailable();
  }

  async approveRun(): Promise<RunGrantReference> {
    throw unavailable();
  }

  async resolveRunGrant(input: RunScopeRef & { grant_ref?: string | null }): Promise<RunGrantResolution> {
    return {
      status: 'missing',
      grant_ref: null,
      session_id: input.session_id,
      scope_sha256: null,
    };
  }

  async revokeRunGrant(): Promise<{ revoked: boolean }> {
    throw unavailable();
  }

  async admitOperation(): Promise<{ admitted: boolean }> {
    throw unavailable();
  }

  async recordConsumption(): Promise<{ recorded: boolean }> {
    throw unavailable();
  }
}
