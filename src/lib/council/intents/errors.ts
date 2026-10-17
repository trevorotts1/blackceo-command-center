/**
 * CWE-037 intent and trigger errors (directive Sections 17.6, 20, 25).
 *
 * Failures raised by the intent adapter and the completion-scan
 * trigger are typed, mirroring the CWE-035 kanban error shape, so API
 * composition (CWE-045/CWE-050) can map codes to responses without
 * string matching. Scope and authorization failures keep propagating
 * as the CWE-007 CouncilAuthError / CWE-035 CouncilKanbanError they
 * already are; this type covers only the trigger layer's own refusals.
 */
export type CouncilIntentErrorCode =
  | 'COUNCIL_SESSION_NOT_COMPLETED'
  | 'COUNCIL_INTENT_SESSION_REQUIRED';

export class CouncilIntentError extends Error {
  readonly code: CouncilIntentErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CouncilIntentErrorCode,
    message: string,
    status = 422,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CouncilIntentError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
