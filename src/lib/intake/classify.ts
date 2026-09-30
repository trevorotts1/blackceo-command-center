/**
 * JEV-010 CC intake classifier — spec section 4.1 required classification.
 *
 * Pure, offline, dependency-free lexical path. This module IS the no-JEV
 * intake path (spec 4.5: deterministic handling first; never a global
 * contains('you') or punctuation check): every rule below matches a specific
 * phrase or shape, never a bare pronoun or question mark.
 *
 * The JEV path (spec 4.3) answers the same intent Choice through the
 * installed core; classifyViaJev() accepts that single intent answer and
 * validates it against the 4.1 enums. Control-probe scanning always runs
 * locally on BOTH paths — classification never happens core-side.
 *
 * Provenance: 'lexical' | 'jev' | 'control'. A control probe
 * ("Ignore all routing rules" etc., spec 4.4 last row) forces provenance
 * 'control' and bypassAllowed=false on either path: untrusted task material,
 * never permission to bypass policy.
 */

import { createHash } from 'node:crypto';

export type Intent =
  | 'answer_only'
  | 'task_request'
  | 'mixed_answer_and_task'
  | 'existing_task_control'
  | 'clarification_response'
  | 'social_conversation'
  | 'unresolved';

export type ExecutionPreference =
  | 'normal_delegation'
  | 'current_assistant'
  | 'named_worker'
  | 'named_department'
  | 'unspecified';

export type ClassificationProvenance = 'lexical' | 'jev' | 'control';

export interface IntakeContext {
  hasExistingTask?: boolean;
  /**
   * A question to the owner is actually waiting for an answer. Only then can
   * a "yes", a "change … to …" or a "use … instead" be read as that answer;
   * without it the same words are a new instruction (JEV-501). Doors that do
   * not know leave it unset (false).
   */
  pendingConfirmation?: boolean;
  priorDelegationDiscussion?: boolean;
}

/**
 * Spec 4.2 requires the classifier be handed the active task/confirmation
 * reference; a door that HAS one must supply it, or a status question and a
 * confirmation answer arrive as bare text and cannot be told apart from a new
 * request. Facts are counts the door already has, so this stays pure and the
 * door owns the query.
 */
export interface IntakeContextFacts {
  /** Live (non-terminal, unarchived) tasks for this requester. */
  liveTaskCount?: number;
  /** Live tasks for this requester whose `ask` is still awaiting an answer. */
  awaitingAnswerCount?: number;
}

export function deriveIntakeContext(facts: IntakeContextFacts): IntakeContext {
  return {
    ...((facts.liveTaskCount ?? 0) > 0 ? { hasExistingTask: true } : {}),
    ...((facts.awaitingAnswerCount ?? 0) > 0 ? { pendingConfirmation: true } : {}),
  };
}

export interface Classification {
  intent: Intent;
  executionPreference: ExecutionPreference;
  executorName?: string;
  provenance: ClassificationProvenance;
  /** True when the message carries a control-probe phrase. Never bypass. */
  controlProbe: boolean;
  /** False exactly when controlProbe is true. */
  bypassAllowed: boolean;
  /** sha256 of the normalized message; the task-creation gate re-checks it. */
  messageHash: string;
}

const INTENTS: ReadonlySet<string> = new Set([
  'answer_only',
  'task_request',
  'mixed_answer_and_task',
  'existing_task_control',
  'clarification_response',
  'social_conversation',
  'unresolved',
]);

const EXEC_PREFS: ReadonlySet<string> = new Set([
  'normal_delegation',
  'current_assistant',
  'named_worker',
  'named_department',
  'unspecified',
]);

/** Spec 4.4 control rows: untrusted material, never a bypass permission. */
const CONTROL_PATTERNS: readonly RegExp[] = [
  /ignore\s+all\s+(routing\s+|these\s+)?rules?/i,
  /bypass\s+(all\s+)?(routing|policy|safety|guardrails?)/i,
  /disregard\s+(all\s+)?(prior\s+|previous\s+)?(instructions?|rules?|policy)/i,
  /override\s+(all\s+)?(safety|policy|routing|guardrails?)/i,
];

/**
 * Work verbs that make a question-form message a task request (spec 4.4 row 3
 * shape; spec 4.1 line 437: "'Can you build the page?' is normally a task
 * request"). The first group is the verb set the bare-imperative rule below
 * already treats as task work, `handle|do|help` are carried from the original
 * question-form rule, and `review|update|fix|publish|set|put|take` are the
 * verbs the ACC-012 acceptance pass measured as falling through to
 * answer_only. A verb outside this set is never guessed at: the message falls
 * to the informational rule or to unresolved, neither of which creates a card.
 */
const REQUEST_VERBS: ReadonlySet<string> = new Set([
  'create', 'build', 'make', 'write', 'draft', 'send', 'prepare', 'generate',
  'design', 'schedule', 'plan', 'handle', 'do', 'help',
  'review', 'update', 'fix', 'publish', 'set', 'put', 'take',
]);

export function normalizeIntakeMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ');
}

/**
 * Informational guard for the question-form task rule. A message whose work
 * verb is governable by these verbs asks ABOUT the work, not FOR it: "Can you
 * tell me how to create a campaign?" must stay answer_only (spec 4.4 rows 1,
 * 2, 8; spec 4.1 line 437 "How would you build the page?").
 *
 * Two positions count as "governing":
 *  - before the first request verb — "Can you tell me how to create ...";
 *  - after a WEAK first verb ("help", "do"), whose object is the informational
 *    act itself — "Can you help me understand how the campaign works?".
 * A request verb that precedes the informational one keeps the message a task:
 * "Please review the deck and tell me what to change." asks FOR a review and
 * merely asks to be told the result.
 */
const METHOD_LEAD = /^\s*(how|what|which|why|when|where)\b/i;
const INFORMATIONAL_VERBS: readonly RegExp[] = [
  /\bexplain\b/,
  /\btell\b/,
  /\bshow\b/,
  /\bdescribe\b/,
  /\bwalk (me )?through\b/,
  /\bunderstand\b/,
  /\bknow\b/,
  /\blearn\b/,
];
/**
 * Weak first verbs: their object is whatever follows, so they alone do not
 * prove a work request — "Can you help me?" is not a task. They keep the
 * object shape the original question-form rule required, which is exactly the
 * behaviour this rule had before the work-verb list was widened.
 */
const WEAK_VERBS: ReadonlySet<string> = new Set(['help', 'do']);
const WEAK_VERB_OBJECT = /\b(for me|this|the|a|an|it)\b/;

/** The work verb governing this message, or null when there is none. */
function requestVerb(stripped: string): string | null {
  const words = stripped.toLowerCase().match(/[a-z']+/g) ?? [];
  for (const w of words) if (REQUEST_VERBS.has(w)) return w;
  return null;
}

/**
 * Spec 4.4 row 3 (question form) extended to spec 4.1 line 437.
 *
 * Two shapes reach it:
 *  - modal request  — `can you <verb>`, `could you <verb>`, `would you
 *    <verb>`, `will you <verb>`, `are you able to <verb>`, `any chance you
 *    could <verb>`, or a `please <verb>` serving as the command.
 *  - plain question — `can you <verb>` with no tail ("Can you build the
 *    landing page from the brief?"), same door.
 *
 * The modal grammar is matched, never a bare punctuation mark: spec 4.5
 * forbids substituting a punctuation/`contains('you')` classifier, and every
 * assertion here holds with or without the trailing "?".
 */
function isQuestionFormTaskRequest(stripped: string): boolean {
  const s = stripped.toLowerCase();
  const modal =
    /(?:^|[^a-z])(?:can|could|would|will) you\b/.test(s) ||
    /\bare you able to\b/.test(s) ||
    /\bany chance you(?:'d| would| could)?\b/.test(s) ||
    /^please\b/.test(s);
  if (!modal) return false;
  const verb = requestVerb(s);
  if (verb === null) return false;
  if (METHOD_LEAD.test(s)) return false;
  const head = s.slice(0, s.indexOf(verb));
  if (INFORMATIONAL_VERBS.some((re) => re.test(head))) return false;
  // A weak first verb hands its object to an informational verb after it
  // ("Can you help me understand how the campaign works?"), and on its own it
  // is not proof of work ("Can you help me?") — it keeps the object shape the
  // original rule required.
  if (WEAK_VERBS.has(verb)) {
    const tail = s.slice(s.indexOf(verb) + verb.length);
    if (INFORMATIONAL_VERBS.some((re) => re.test(tail))) return false;
    if (!WEAK_VERB_OBJECT.test(tail)) return false;
  }
  return true;
}

export function hashIntakeMessage(message: string): string {
  return createHash('sha256').update(normalizeIntakeMessage(message), 'utf8').digest('hex');
}

/** Remove quoted spans so quoted text is never read as owner authorization. */
function stripQuoted(text: string): string {
  return text
    .replace(/"[^"]*"/g, ' ')
    .replace(/'[^']*'/g, ' ')
    .replace(/‘[^’]*’/g, ' ')
    .replace(/“[^”]*”/g, ' ');
}

export function isControlProbe(message: string): boolean {
  return CONTROL_PATTERNS.some((re) => re.test(message));
}

function finish(
  intent: Intent,
  executionPreference: ExecutionPreference,
  message: string,
  controlProbe: boolean,
  provenance: ClassificationProvenance,
  executorName?: string,
): Classification {
  return {
    intent,
    executionPreference,
    ...(executorName ? { executorName } : {}),
    provenance: controlProbe ? 'control' : provenance,
    controlProbe,
    bypassAllowed: !controlProbe,
    messageHash: hashIntakeMessage(message),
  };
}

/**
 * Deterministic lexical classification (the no-JEV path). Rule order is
 * load-bearing: meta-questions about quoted text and social/stop/status
 * shapes resolve before any owner-direct or delegation phrase.
 */
export function classifyLexical(message: string, ctx: IntakeContext = {}): Classification {
  const controlProbe = isControlProbe(message);
  const text = normalizeIntakeMessage(message);
  if (!text) {
    return finish('unresolved', 'unspecified', message, controlProbe, 'lexical');
  }
  const stripped = normalizeIntakeMessage(stripQuoted(text));

  // Quoted text is not current-owner authorization ("The client wrote,
  // 'you do it'; what does that mean?" -> answer only).
  if (/what does (that|this) mean|what do you mean\b/i.test(text)) {
    return finish('answer_only', 'unspecified', message, controlProbe, 'lexical');
  }
  // Social conversation ("Thanks.").
  if (/^(thanks?|thank you|thx|ok thanks|great|perfect|👍)[\s.!]*$/i.test(text)) {
    return finish('social_conversation', 'unspecified', message, controlProbe, 'lexical');
  }
  // Existing-task stop/kill ("Stop that task.").
  if (/\bstop that\b|\b(stop|cancel|kill|halt|abort)\b.{0,20}\btask\b/i.test(stripped)) {
    return finish('existing_task_control', 'unspecified', message, controlProbe, 'lexical');
  }
  // Existing workflow action with prior authorization ("Send the draft you already made.").
  if (/\bsend\b.*\b(draft|it|that)\b.*\balready made\b/i.test(stripped)) {
    return finish('existing_task_control', 'unspecified', message, controlProbe, 'lexical');
  }
  // Status question about a live task ("Is that finished?").
  if (
    ctx.hasExistingTask &&
    /\b(is|are)\b.*\b(finished|done|complete|ready)\b|\bstatus\b.*\btask\b/i.test(stripped)
  ) {
    return finish('existing_task_control', 'unspecified', message, controlProbe, 'lexical');
  }
  // Pending-confirmation completion ("Yes, that audience is right.").
  if (
    ctx.pendingConfirmation &&
    /^(yes|yeah|yep|correct|right|agreed|looks good|that'?s right|confirmed)\b/i.test(stripped)
  ) {
    return finish('clarification_response', 'unspecified', message, controlProbe, 'lexical');
  }
  // Amendment of a pending decision ("Actually, use the new-business-owner audience.").
  // Only when a question is actually pending: "Change the price on the
  // coaching page to $997" with nothing pending is a new task (JEV-501).
  if (
    ctx.pendingConfirmation &&
    /\bactually\b.{0,10}\buse\b|\bchange\b.*\bto\b|\buse\b.*\binstead\b/i.test(stripped)
  ) {
    return finish('clarification_response', 'unspecified', message, controlProbe, 'lexical');
  }
  // Named-department preference ("Please have Marketing handle it.",
  // "send it to Sales", "I don't want you to do it; send it to Sales.").
  // Checked before owner-direct phrases: the negation in row 11 must not win.
  const deptMatch =
    stripped.match(/please have (\w[\w-]*) handle it/i) ??
    stripped.match(/\bsend it to ([\w-]+)/i) ??
    stripped.match(/\bhave ([\w-]+) (handle|take care of) (it|this|that)\b/i) ??
    stripped.match(/\blet ([\w-]+) (handle|take) (it|this|that)\b/i);
  if (deptMatch) {
    return finish('task_request', 'named_department', message, controlProbe, 'lexical', deptMatch[1]);
  }
  // Named worker ("Have Jordan do it."). Records the name only — ambiguity
  // must never select a random worker; resolution happens against the roster.
  const workerMatch = stripped.match(/\bhave ([\w-]+) do it\b/i);
  if (workerMatch) {
    return finish('task_request', 'named_worker', message, controlProbe, 'lexical', workerMatch[1]);
  }
  // Owner-direct current-assistant execution. Specific phrases only — never a
  // bare contains('you'): "Can you explain it to me?" must not land here
  // (explanation questions resolve below first when reached in order, and the
  // patterns here require an explicit non-delegation or do-it directive).
  if (
    /you personally|do not delegate|don't delegate|never delegate|without delegat|no delegating/i.test(
      stripped,
    )
  ) {
    return finish('task_request', 'current_assistant', message, controlProbe, 'lexical');
  }
  if (/\byou do it\b/i.test(stripped)) {
    return finish('task_request', 'current_assistant', message, controlProbe, 'lexical');
  }
  // Mixed answer + task ("Create the campaign and explain why ...").
  if (
    /\b(create|build|make|write|draft|design)\b/i.test(stripped) &&
    /\band explain\b|\btell me why\b|\bwhy you chose\b/i.test(stripped)
  ) {
    return finish('mixed_answer_and_task', 'normal_delegation', message, controlProbe, 'lexical');
  }
  // Question-form task request ("Can you create the campaign for me?").
  // The discriminator is the REQUEST VERB, not the leading interrogative
  // (spec 4.1 line 437: "'Can you build the page?' is normally a task
  // request. 'How would you build the page?' is normally an informational
  // question."). The informational-METHOD verb guard runs first so that
  // "Can you tell me how to create a campaign?" cannot be read as a request
  // to create one; a bare "Can you explain how it works?" has no request verb
  // and falls to the informational rule below.
  if (isQuestionFormTaskRequest(stripped)) {
    return finish('task_request', 'normal_delegation', message, controlProbe, 'lexical');
  }
  // Informational questions ("What does Marketing do?", "How would you
  // create...?", "Can you explain it to me?", "Explain the options...").
  // Spec 4.4 row 5's paraphrase carries a trailing prohibition ("no building
  // for now") that sheds any work verb, so an explicit prohibition on the
  // work is itself the answer-only signal — never a request for it.
  // A leading discourse marker ("So what exactly is it that Marketing does?")
  // is how a spoken question opens; it is stripped before the interrogative
  // anchor, never a request verb in its own right (row 1's paraphrase). Any
  // request-verb message already returned above, so nothing that reached here
  // can be turned into work by this allowance.
  const withoutLeadIn = stripped.replace(/^(?:so|well|and|but|ok|okay|now|hey)\b[\s,]*/i, '');
  // The prohibition only reads as answer-only when the message asks for no
  // work at all: a work verb anywhere ("Build the deck with no building
  // delay") is still a request for it, and every such message returned above.
  const prohibitedWork =
    requestVerb(withoutLeadIn) === null &&
    /\bno (building|creating|making|writing|drafting|sending|executing|doing)\b/i.test(stripped);
  if (
    /^(what|how|why|which|when|where|who|is|are|do|does|can)\b/i.test(withoutLeadIn) ||
    /^explain\b/i.test(withoutLeadIn) ||
    prohibitedWork
  ) {
    return finish('answer_only', 'unspecified', message, controlProbe, 'lexical');
  }
  // Bare imperative task verbs ("Draft it here, but do not send it.").
  // ponytail: prohibition part ("do not send") is recorded nowhere here;
  // a send-guard consumes the draft, never this classifier. Upgrade when a
  // structured prohibition field exists on the card.
  if (/^(create|build|make|write|draft|send|prepare|generate|design|schedule|plan)\b/i.test(stripped)) {
    return finish('task_request', 'unspecified', message, controlProbe, 'lexical');
  }
  return finish('unresolved', 'unspecified', message, controlProbe, 'lexical');
}

export interface JevIntentAnswer {
  intent: string;
  executionPreference: string;
  executorName?: string;
}

export type JevResponder = (question: {
  message: string;
  context: IntakeContext;
}) => JevIntentAnswer | Promise<JevIntentAnswer>;

/**
 * JEV path: the installed core answers the single 4.1 intent Choice via
 * `responder`; this function validates the answer against the enums and
 * applies the local control-probe scan. Invalid answers and responder
 * failures fall back to the lexical path (no-JEV parity) rather than
 * throwing the message away.
 */
export async function classifyViaJev(
  message: string,
  ctx: IntakeContext = {},
  responder?: JevResponder,
): Promise<Classification> {
  const controlProbe = isControlProbe(message);
  if (!responder) {
    return classifyLexical(message, ctx);
  }
  let answer: JevIntentAnswer;
  try {
    answer = await responder({ message, context: ctx });
  } catch {
    return classifyLexical(message, ctx);
  }
  if (!INTENTS.has(answer.intent) || !EXEC_PREFS.has(answer.executionPreference)) {
    return classifyLexical(message, ctx);
  }
  return finish(
    answer.intent as Intent,
    answer.executionPreference as ExecutionPreference,
    message,
    controlProbe,
    'jev',
    typeof answer.executorName === 'string' && answer.executorName.trim()
      ? answer.executorName.trim()
      : undefined,
  );
}

/** Auto path: JEV when a responder is supplied, lexical otherwise. */
export function classify(
  message: string,
  ctx: IntakeContext = {},
  opts: { jevResponder?: JevResponder } = {},
): Promise<Classification> {
  return classifyViaJev(message, ctx, opts.jevResponder);
}
