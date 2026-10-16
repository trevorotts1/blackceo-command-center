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
  type DecisionDepartment,
  type DecisionRequest,
  type DecisionRecommendation,
  type DecisionResponse,
  type DecisionRoute,
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
  checkPairedCohortActivation,
  fenceStaleRecommendations,
  isRecommendationFenced,
  parseConfiguredMode,
  resolveEffectivePath,
  type CohortActivation,
  type CohortPair,
  type DecisionEngineMode,
  type EffectivePath,
  type FencedSplit,
  type ModeResolution,
  type ModeResolutionInput,
  type ModeSkipReason,
  type PolicyGate,
} from './modes';

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
