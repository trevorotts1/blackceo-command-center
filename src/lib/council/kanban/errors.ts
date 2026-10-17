/**
 * CWE-035 kanban integration errors (directive Sections 17.6, 19, 20, 25).
 *
 * Every failure raised by the council parent-and-plan service is one of
 * these typed errors (or a CWE-007 CouncilAuthError / CWE-006
 * CouncilPersistenceError propagated unchanged), so API composition in
 * CWE-036 can map codes to responses without string matching.
 */
export type CouncilKanbanErrorCode =
  | 'COUNCIL_SESSION_NOT_FOUND'
  | 'COUNCIL_SESSION_DELETED'
  | 'COUNCIL_VERDICT_NOT_VALID'
  | 'COUNCIL_PLAN_NOT_FOUND'
  | 'COUNCIL_PLAN_SUPERSEDED'
  | 'COUNCIL_PLAN_ITEM_NOT_FOUND'
  | 'COUNCIL_PLAN_NOT_FULLY_APPROVED'
  | 'COUNCIL_PARENT_CREATE_FAILED'
  | 'COUNCIL_MACHINE_BINDING_REQUIRED'
  | 'COUNCIL_RUN_AUTHORIZATION_UNAVAILABLE'
  | 'COUNCIL_SCAN_QUEUE_FULL'
  | 'COUNCIL_SCAN_ITEM_TOO_LARGE'
  | 'COUNCIL_SCAN_ITEM_INVALID';

export class CouncilKanbanError extends Error {
  readonly code: CouncilKanbanErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CouncilKanbanErrorCode,
    message: string,
    status = 422,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CouncilKanbanError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
