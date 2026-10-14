/**
 * CWE-036 action-side errors (directive Sections 17.6, 19.5, 19.6,
 * 19.7; Section 35 contracts T090-T095, T159).
 *
 * CWE-035's CouncilKanbanError covers the parent-and-plan service.
 * The action side (preview, assembly, execution guard) raises these
 * additional typed errors so the API facade in src/lib/council/
 * approvals.ts can map codes to responses without string matching.
 * Codes are never invented at the route layer; they originate here or
 * in CWE-035's vocabulary and pass through unchanged.
 */
export type CouncilActionErrorCode =
  | 'COUNCIL_VERDICT_NOT_FOUND'
  | 'COUNCIL_VERDICT_SUPERSEDED'
  | 'COUNCIL_PLAN_HASH_MISMATCH'
  | 'COUNCIL_PLAN_NOT_CURRENT'
  | 'COUNCIL_DEPENDENCY_INVALID'
  | 'COUNCIL_ASSEMBLY_READINESS_FAILED'
  | 'COUNCIL_ASSEMBLY_NOT_FOUND'
  | 'COUNCIL_TASK_LINK_NOT_FOUND'
  | 'COUNCIL_TASK_NOT_RELEASABLE'
  | 'COUNCIL_CONDITION_EVIDENCE_INVALID';

export class CouncilActionError extends Error {
  readonly code: CouncilActionErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CouncilActionErrorCode,
    message: string,
    status = 422,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CouncilActionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
