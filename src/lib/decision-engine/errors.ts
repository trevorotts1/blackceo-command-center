/**
 * JEV-009 CC bridge — typed errors.
 *
 * Callers switch on `code` (or `instanceof`), never on message text.
 */

export type DecisionEngineErrorCode =
  | 'DeadlineExceeded'
  | 'IncompatibleRevision'
  | 'CoreAbsent'
  | 'SchemaMajorMismatch'
  | 'HandshakeFailed'
  | 'AssignmentMutation'
  | 'BridgeFailed';

export class DecisionEngineError extends Error {
  readonly code: DecisionEngineErrorCode;
  constructor(code: DecisionEngineErrorCode, message: string) {
    super(message);
    this.name = 'DecisionEngineError';
    this.code = code;
  }
}

export class DeadlineExceededError extends DecisionEngineError {
  constructor(message: string) {
    super('DeadlineExceeded', message);
    this.name = 'DeadlineExceededError';
  }
}

export class IncompatibleRevisionError extends DecisionEngineError {
  constructor(message: string) {
    super('IncompatibleRevision', message);
    this.name = 'IncompatibleRevisionError';
  }
}

export class CoreAbsentError extends DecisionEngineError {
  constructor(message: string) {
    super('CoreAbsent', message);
    this.name = 'CoreAbsentError';
  }
}

export class AssignmentMutationError extends DecisionEngineError {
  constructor(message: string) {
    super('AssignmentMutation', message);
    this.name = 'AssignmentMutationError';
  }
}

export class BridgeFailedError extends DecisionEngineError {
  constructor(message: string) {
    super('BridgeFailed', message);
    this.name = 'BridgeFailedError';
  }
}
