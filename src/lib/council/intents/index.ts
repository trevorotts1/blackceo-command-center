/**
 * CWE-037 trigger, intent, and completion-scan integration.
 *
 * Composition surface for CWE-045 (production wiring) and CWE-050
 * (endpoint assembly): the council capability registration and phrase
 * classifier, the intent dispatch adapter over the locked service
 * ports, and the completion-time scan trigger over CWE-035's scan
 * queue. Nothing in this folder creates a task or a session, and no
 * path here bypasses the four separate authorizations of Section 25.
 */
export {
  COUNCIL_CAPABILITY_ID,
  COUNCIL_SLASH_COMMAND,
  COUNCIL_INTENT_REGISTRY,
  COUNCIL_SEAT_IDS,
  classifyCouncilIntent,
  type CouncilControlCommand,
  type CouncilIntentClassification,
  type CouncilIntentDefinition,
  type CouncilIntentKind,
} from './registry';
export {
  CouncilIntentDispatcher,
  recursionBlockDetail,
  type CouncilIntentDispatcherDeps,
  type CouncilIntentOrigin,
  type CouncilIntentOriginKind,
  type CouncilIntentOutcome,
  type CouncilIntentRequest,
} from './dispatch';
export {
  CouncilCompletionScanner,
  type CompletionScanResult,
  type CompletionScanTrigger,
  type CouncilCompletionScannerDeps,
} from './completion-scan';
export { CouncilIntentError, type CouncilIntentErrorCode } from './errors';
