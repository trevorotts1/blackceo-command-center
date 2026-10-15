/**
 * Council intent surface binding (CWE-045; directive Sections 17.5,
 * 20). CWE-037 built the capability registration, the deterministic
 * classifier, and the dispatch adapter, and named this line as where
 * the production wiring happens: front-door surfaces (dashboard,
 * chat, department, CEO) bind through here.
 *
 * The binding is deliberately narrow and fail-open for the host
 * surface:
 * - Classification is pure text analysis. A message that does not
 *   classify as one of the seven registered council intents is NOT
 *   intercepted: the surface proceeds exactly as before.
 * - A classified intent is dispatched through CWE-037's
 *   CouncilIntentDispatcher over the composition root's store. The
 *   dispatcher resolves existing state first, creates no session and
 *   no task at this layer, and produces at most a request descriptor
 *   behind the four separate authorizations of Section 25.
 * - The outcome is rendered as one plain-language summary the surface
 *   can show verbatim. Summaries are composed only from the outcome's
 *   recorded fields; nothing is invented to fill a gap.
 *
 * The CEO chat route (src/app/api/ceo-chat/message/route.ts) is the
 * first bound surface: it attempts this binding only when a verified
 * council principal resolves for the request, and any failure in the
 * binding falls back to the normal agent forward, so a council
 * outage can never break ordinary chat.
 */

import type { CouncilPrincipal } from './auth';
import { getCouncilEngine } from './engine';
import {
  classifyCouncilIntent,
  type CouncilIntentDispatcher,
  type CouncilIntentOrigin,
  type CouncilIntentOutcome,
} from './intents';

export interface CouncilSurfaceResult {
  /** True when the message was a council intent and was handled here. */
  intercepted: boolean;
  /** The dispatcher outcome, when intercepted. */
  outcome?: CouncilIntentOutcome;
  /** Plain-language summary for the surface to show, when intercepted. */
  summary?: string;
}

const NOT_INTERCEPTED: CouncilSurfaceResult = { intercepted: false };

/** Render one dispatcher outcome as a plain-language surface summary. */
export function summarizeCouncilOutcome(outcome: CouncilIntentOutcome): string {
  switch (outcome.kind) {
    case 'no_intent':
      return 'That did not match a council request, so nothing was sent to the council.';
    case 'session_command':
      return (
        `Resolved your ${outcome.command} request against the existing council session ` +
        `${outcome.session_id}. No new work was created; the session controls apply to that session.`
      );
    case 'unresolved':
      return (
        'That sounded like a command for an existing council session, but no matching active ' +
        'council session could be resolved, so nothing was changed.'
      );
    case 'blocked':
      return outcome.detail;
    case 'not_found':
      return outcome.what === 'verdict'
        ? `Session ${outcome.session_id} has no recorded verdict yet, so there is no decision to read.`
        : `No recorded objection was found in session ${outcome.session_id} for that request.`;
    case 'verdict_read': {
      const reasons =
        outcome.main_reasons.length > 0
          ? ` Main reasons recorded: ${outcome.main_reasons.join('; ')}.`
          : '';
      return (
        `The council's recorded decision for session ${outcome.session_id} is ` +
        `${outcome.label ?? outcome.result_kind ?? 'recorded'} (verdict revision ` +
        `${outcome.verdict_revision ?? 'unknown'}, decided ${outcome.decided_at}).${reasons}`
      );
    }
    case 'objection_read':
      return `The recorded objection is: ${outcome.objection}`;
    case 'consult_request':
      return (
        'That is a request for new council reasoning, so it was recorded as a consult request ' +
        `linked to ${outcome.consult.source_session_id ?? 'no session'}: it runs only under a ` +
        'fresh purpose-bound run authorization, and nothing was run yet.'
      );
    case 'convene_request':
      return (
        'That convenes the full council. The request was recorded with its source references; ' +
        'a session is created and run only under a council-run authorization, and nothing was run yet.'
      );
    case 'rerun_request':
      return (
        `That reruns session ${outcome.request.source_session_id}. The rerun request was recorded; ` +
        'it needs a fresh run authorization, and the original approval does not carry over.'
      );
  }
}

/**
 * Attempt the council binding for one surface message. Returns
 * { intercepted: false } for any message that is not a council
 * intent, so the caller falls through to its normal handling.
 */
export async function handleCouncilSurfaceMessage(input: {
  principal: CouncilPrincipal;
  text: string;
  session_id?: string | null;
  origin: CouncilIntentOrigin;
  dispatcher?: CouncilIntentDispatcher;
}): Promise<CouncilSurfaceResult> {
  const classification = classifyCouncilIntent(input.text ?? '');
  if (classification.intent === 'none') return NOT_INTERCEPTED;
  const dispatcher = input.dispatcher ?? getCouncilEngine().intents;
  const outcome = await dispatcher.dispatch(
    input.principal,
    { text: input.text, session_id: input.session_id ?? null, origin: input.origin },
    undefined,
  );
  if (outcome.kind === 'no_intent') return NOT_INTERCEPTED;
  return { intercepted: true, outcome, summary: summarizeCouncilOutcome(outcome) };
}
