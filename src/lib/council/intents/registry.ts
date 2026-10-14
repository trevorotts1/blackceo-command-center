/**
 * CWE-037 council capability and intent registry (Section 20).
 *
 * The host at this HEAD has no general intent/capability registry to
 * register into: the "My AI CEO" chat forwards messages to the on-box
 * agent through src/lib/ceo-chat/gateway.ts, the department router
 * (src/lib/routing/department-router.ts) routes already-created tasks,
 * and src/lib/capability-manifest.ts is Skill 58 podcast activation
 * gating, not a phrase registry. This module is therefore the council
 * capability's registration record in the only form the host can
 * consume today: ONE capability identity, the Section 20 front-door
 * phrases, the portable slash command, and a deterministic classifier
 * that CWE-045 binds into dashboard/chat/department dispatch and
 * CWE-050 serves behind the locked endpoint contracts. The classifier
 * is pure text analysis; it creates nothing, and ordinary questions
 * ("Should I launch in March?") never classify as a council intent.
 *
 * Registration facts (Section 20.2): the capability preserves the
 * client-selected model end to end (no field here names or overrides
 * a model), the AI CEO gathers context and receives the report but is
 * not a voting seat, and no JEV/Decision Desk interface exists in this
 * repository at this HEAD (verified by full-tree search of src/ and
 * tests/ for decision_engine, Decision Desk, and decisionEngine: no
 * matches). Should such a routing mechanism appear, it may recommend
 * this capability or a destination through COUNCIL_CAPABILITY_ID; it
 * may never invent the verdict or override the selected model.
 */
import { SEAT_IDS, type SeatId } from '../contracts';

/** The ONE capability identity for the council (Section 20.2). */
export const COUNCIL_CAPABILITY_ID = 'council-of-wise-elders';

/** The portable slash command registered for the capability. */
export const COUNCIL_SLASH_COMMAND = '/council';

export type CouncilIntentKind =
  | 'convene_council'
  | 'consult_seat'
  | 'read_result'
  | 'explain_objection'
  | 'session_control'
  | 'rerun_session'
  | 'follow_up'
  | 'none';

export type CouncilControlCommand = 'stop' | 'pause' | 'resume' | 'cancel';

export interface CouncilIntentClassification {
  intent: CouncilIntentKind;
  /** The seat named by the request, when one is named. */
  seat_id: SeatId | null;
  /** For session_control, the control verb family detected. */
  control_command: CouncilControlCommand | null;
  /**
   * True when answering would require NEW reasoning rather than
   * retrieving what is already recorded (Section 20.2: "Explain
   * Russell's objection" is a read of the stored objection; asking why
   * he WOULD object to something new is a consult).
   */
  requires_inference: boolean;
  /** The registry phrase or pattern family that matched, for audit. */
  matched: string | null;
}

export interface CouncilIntentDefinition {
  intent: Exclude<CouncilIntentKind, 'none'>;
  capability_id: typeof COUNCIL_CAPABILITY_ID;
  summary: string;
  /** What dispatching this intent is allowed to produce at this layer. */
  produces: 'nothing' | 'verdict_read' | 'objection_read' | 'consult_request' | 'convene_request' | 'rerun_request' | 'session_resolution';
  /** The locked CWE-029 endpoint contract the intent binds to, if any. */
  endpoint_contract: string | null;
  /** The separate authorization the intent can never stand in for. */
  authorization_boundary: string;
}

/**
 * The registration table. Every intent resolves existing state first
 * and produces at most a request descriptor at this layer: session
 * creation, consult execution, and reruns stay behind the four
 * separate authorizations of Section 25.
 */
export const COUNCIL_INTENT_REGISTRY: readonly CouncilIntentDefinition[] = [
  {
    intent: 'convene_council',
    capability_id: COUNCIL_CAPABILITY_ID,
    summary:
      'Convene a full council ("Ask my Council of Wise Elders", "Take this decision to the council", "Review this plan with the council", "/council"). Produces a convene request preserving source department and task references; it does not create or run a session.',
    produces: 'convene_request',
    endpoint_contract: 'council.sessions.create',
    authorization_boundary: 'council-run authorization (CWE-049) is still required before any session runs',
  },
  {
    intent: 'consult_seat',
    capability_id: COUNCIL_CAPABILITY_ID,
    summary:
      'Ask one named seat a bounded question ("Ask the Tiffany Aliche seat"). Produces a purpose-bound consult request linked to the source session; it does not run the consult.',
    produces: 'consult_request',
    endpoint_contract: 'council.sessions.follow_up',
    authorization_boundary: 'a fresh follow_up run authorization (CWE-049) and CWE-050 follow-up coordination are still required',
  },
  {
    intent: 'read_result',
    capability_id: COUNCIL_CAPABILITY_ID,
    summary:
      '"What did they decide?" Reads the stored verdict of the existing session. A read, never a new task.',
    produces: 'verdict_read',
    endpoint_contract: 'council.sessions.verdict.get',
    authorization_boundary: 'read access only; authorizes nothing',
  },
  {
    intent: 'explain_objection',
    capability_id: COUNCIL_CAPABILITY_ID,
    summary:
      '"Explain Russell\'s objection." Retrieving the recorded objection is a read; only a request for new inference becomes a consult request.',
    produces: 'objection_read',
    endpoint_contract: 'council.sessions.verdict.get',
    authorization_boundary: 'the retrieval form authorizes nothing; the inference form follows the consult boundary',
  },
  {
    intent: 'session_control',
    capability_id: COUNCIL_CAPABILITY_ID,
    summary:
      '"Stop that council", "Pause that council", and family. Resolves the EXISTING session through the trusted session surface; checked before any work-creating intent and never creates a task.',
    produces: 'session_resolution',
    endpoint_contract: 'council.sessions.pause',
    authorization_boundary: 'run permission on the existing session; creates and authorizes no new work',
  },
  {
    intent: 'rerun_session',
    capability_id: COUNCIL_CAPABILITY_ID,
    summary:
      'Rerun a completed session ("Run that council again"). Produces a rerun request linked to the source session; a rerun never inherits the original approval.',
    produces: 'rerun_request',
    endpoint_contract: 'council.sessions.rerun',
    authorization_boundary: 'a fresh run authorization (CWE-049) is required; the original approval does not carry over',
  },
  {
    intent: 'follow_up',
    capability_id: COUNCIL_CAPABILITY_ID,
    summary:
      'A follow-up question for the council on a decided matter. Produces a purpose-bound consult request linked to the source session.',
    produces: 'consult_request',
    endpoint_contract: 'council.sessions.follow_up',
    authorization_boundary: 'a fresh follow_up run authorization (CWE-049) and CWE-050 follow-up coordination are still required',
  },
];

/** Seat display-name fragments to canonical seat ids (Section 7 roster). */
const SEAT_NAME_PATTERNS: ReadonlyArray<{ pattern: RegExp; seat_id: SeatId }> = [
  { pattern: /\bsimon\b|\bsinek\b/, seat_id: 'simon-sinek' },
  { pattern: /\bjakes\b/, seat_id: 'td-jakes' },
  { pattern: /\boprah\b|\bwinfrey\b/, seat_id: 'oprah-winfrey' },
  { pattern: /\btiffany\b|\baliche\b/, seat_id: 'tiffany-aliche' },
  { pattern: /\brussell\b|\bbrunson\b/, seat_id: 'russell-brunson' },
  { pattern: /\bmichelle\b|\bobama\b/, seat_id: 'michelle-obama' },
  { pattern: /\bbren[eé]\b/, seat_id: 'brene-brown' },
  { pattern: /\bdennis\b|\bkimbro\b/, seat_id: 'dennis-kimbro' },
  { pattern: /\bles\b|\bles brown\b/, seat_id: 'les-brown' },
];

function namedSeat(text: string): SeatId | null {
  for (const { pattern, seat_id } of SEAT_NAME_PATTERNS) {
    if (pattern.test(text)) return seat_id;
  }
  return null;
}

const NO_MATCH: CouncilIntentClassification = {
  intent: 'none',
  seat_id: null,
  control_command: null,
  requires_inference: false,
  matched: null,
};

/**
 * Classify one front-door utterance. Resolution order is deliberate:
 * existing-session controls are detected FIRST (Section 20.2: resolve
 * existing session controls before task creation), then reads, then
 * the objection rule, then rerun and follow-up, then consult and
 * convene. Anything else is 'none': the council capability does not
 * intercept ordinary conversation.
 */
export function classifyCouncilIntent(rawText: string): CouncilIntentClassification {
  const text = ` ${(rawText ?? '').toLowerCase().replace(/\s+/g, ' ').trim()} `;
  if (text.trim() === '') return NO_MATCH;
  const seat_id = namedSeat(text);

  // 1. Existing-session controls first.
  let control_command: CouncilControlCommand | null = null;
  if (/\b(stop|halt)\b/.test(text)) control_command = 'stop';
  else if (/\bcancel\b/.test(text)) control_command = 'cancel';
  else if (/\bpause\b/.test(text)) control_command = 'pause';
  else if (/\bresume\b/.test(text)) control_command = 'resume';
  if (control_command) {
    return {
      intent: 'session_control',
      seat_id,
      control_command,
      requires_inference: false,
      matched: 'session_control_verb',
    };
  }

  // 2. Verdict reads.
  if (
    /\bwhat did (they|the council) decide\b/.test(text) ||
    /\bwhat (was|is) the (verdict|decision|result)\b/.test(text) ||
    /\bshow me the (verdict|decision|result)\b/.test(text) ||
    /\bwhat did the council say\b/.test(text)
  ) {
    return { intent: 'read_result', seat_id, control_command: null, requires_inference: false, matched: 'verdict_read_phrase' };
  }

  // 3. Objection explanation: retrieval is a read, new inference is a consult.
  if (/\bobjection\b/.test(text) || (seat_id && /\bexplain\b/.test(text))) {
    const requires_inference = /\b(would|will|might)\b/.test(text) && !/\bdid\b/.test(text);
    return {
      intent: 'explain_objection',
      seat_id,
      control_command: null,
      requires_inference,
      matched: requires_inference ? 'objection_inference' : 'objection_retrieval',
    };
  }

  // 4. Rerun of an existing session.
  if (/\b(re-?run|run it again|run that again|run the council again|run that council again)\b/.test(text)) {
    return { intent: 'rerun_session', seat_id, control_command: null, requires_inference: false, matched: 'rerun_phrase' };
  }

  // 5. Follow-up on a decided matter.
  if (/\bfollow[ -]?up\b/.test(text)) {
    return { intent: 'follow_up', seat_id, control_command: null, requires_inference: true, matched: 'follow_up_phrase' };
  }

  // 6. A named-seat consult.
  if (seat_id && /\b(ask|consult|check with)\b/.test(text)) {
    return { intent: 'consult_seat', seat_id, control_command: null, requires_inference: true, matched: 'named_seat_consult' };
  }

  // 7. Convene phrases and the portable command (Section 20.1).
  if (
    text.includes(' ask my council of wise elders ') ||
    text.includes(' take this decision to the council ') ||
    text.includes(' review this plan with the council ') ||
    text.includes(' ask the council ') ||
    text.includes(' convene the council ') ||
    text.includes(' council of wise elders ') ||
    text.trim() === COUNCIL_SLASH_COMMAND ||
    text.includes(` ${COUNCIL_SLASH_COMMAND} `)
  ) {
    return { intent: 'convene_council', seat_id, control_command: null, requires_inference: false, matched: 'convene_phrase' };
  }

  return NO_MATCH;
}

/** The seat ids the registry knows, re-exported for adapter consumers. */
export const COUNCIL_SEAT_IDS = SEAT_IDS;
