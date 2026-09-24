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
  pendingConfirmation?: boolean;
  priorDelegationDiscussion?: boolean;
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

export function normalizeIntakeMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ');
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
  if (/\bactually\b.{0,10}\buse\b|\bchange\b.*\bto\b|\buse\b.*\binstead\b/i.test(stripped)) {
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
  if (/you personally|do not delegate|don't delegate|never delegate|without delegat/i.test(stripped)) {
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
  if (/\bcan you (create|build|make|write|draft|send|handle|do|help).{0,40}(for me|this|the|a|an|it)\b/i.test(stripped)) {
    return finish('task_request', 'normal_delegation', message, controlProbe, 'lexical');
  }
  // Informational questions ("What does Marketing do?", "How would you
  // create...?", "Can you explain it to me?", "Explain the options...").
  if (
    /^(what|how|why|which|when|where|who|is|are|do|does|can)\b/i.test(stripped) ||
    /^explain\b/i.test(stripped)
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
