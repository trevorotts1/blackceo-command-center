/**
 * JEV-009 CC bridge — public surface.
 *
 * Thin async typed bridge over the installed compatible Python core.
 * CC keeps its own assignment writers; this package only judges.
 * Pure detection + request/response plumbing; no fallback removal.
 */

export {
  DECISION_SCHEMA_VERSION,
  assertAssignmentReadOnly,
  assertRevisionEcho,
  buildRequest,
  schemaMajor,
  type DecisionRequest,
  type DecisionRecommendation,
  type DecisionResponse,
} from './contract';

export {
  evaluateDecision,
  resolveCorePath,
  CORE_PATH_ENV,
  DEFAULT_PYTHON_BIN,
  type CorePathSource,
  type EvaluateOptions,
} from './bridge';

export {
  probeInstalledCore,
  requiresNoJevFallback,
  type CapabilityReason,
  type CapabilityState,
  type ProbeOptions,
  type SelectionPath,
} from './capability';

export {
  stampRootDeadline,
  systemClock,
  type BridgeDeadline,
  type Clock,
} from './deadline';

export {
  AssignmentMutationError,
  BridgeFailedError,
  CoreAbsentError,
  DeadlineExceededError,
  DecisionEngineError,
  IncompatibleRevisionError,
  type DecisionEngineErrorCode,
} from './errors';
