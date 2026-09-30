/**
 * JEV-010 CC intake bypass rules — spec sections 4.2, 4.4 (typed vs raw),
 * 4.5 (no-JEV) and 12.2 (entry-path seams).
 *
 * Two doors, never mixed:
 *  - Typed ingest/API payloads (explicit structured instructions, spec 4.5
 *    first sentence) skip conversational re-classification but are still
 *    validated: shape check (title required) + unknown-field policy
 *    (default strip-and-report; 'reject' fails closed).
 *  - Raw gateway/chat text ALWAYS goes through classify() first; task
 *    creation for a raw message requires a Classification whose messageHash
 *    matches the message (raw text never reaches task creation unclassified).
 *
 * Malformed typed payloads are rejected, never reclassified: validate takes
 * no responder and never calls the classifier.
 */

import { hashIntakeMessage, type Classification } from './classify';

export type UnknownFieldPolicy = 'strip' | 'reject';

export interface TypedIngestPayload {
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  source?: string;
  source_ref?: string;
  department_slug?: string;
  persona?: string;
  target_agent?: string;
  specialist?: string;
  external_session_id?: string;
  idempotency_key?: string;
  context_refs?: string | string[];
  parent_task_id?: string;
  existing_task_id?: string;
  requester_channel?: string;
  requester_chat_id?: string;
  requester_session_key?: string;
  voice_persona_id?: string;
  topic_persona_id?: string;
  task_persona_ids?: string[];
  bundle_sha?: string;
  slide_count?: number | string;
  phase_id?: string;
  stage?: string;
  presentation_intake?: unknown;
  need_by?: string;
  lane?: string;
  effort_steps?: number | string;
  depts_touched?: number | string;
  persona_bundle?: unknown;
  /** Raw door only: a question to the owner is waiting for this answer. Default false. */
  pending_question?: boolean;
}

/** Every field the ingest front door accepts. Anything else is unknown. */
const KNOWN_TYPED_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'priority',
  'source',
  'source_ref',
  'department_slug',
  'persona',
  'target_agent',
  'specialist',
  'external_session_id',
  'idempotency_key',
  'context_refs',
  'parent_task_id',
  'existing_task_id',
  'requester_channel',
  'requester_chat_id',
  'requester_session_key',
  'voice_persona_id',
  'topic_persona_id',
  'task_persona_ids',
  'bundle_sha',
  'slide_count',
  'phase_id',
  'stage',
  'presentation_intake',
  'need_by',
  'lane',
  'effort_steps',
  'depts_touched',
  'persona_bundle',
  'pending_question',
]);

const VALID_PRIORITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'critical']);

export const MAX_TITLE_CHARS = 500;

export type ValidateTypedResult =
  | { ok: true; payload: TypedIngestPayload; stripped: string[] }
  | { ok: false; error: string };

/**
 * Shape-check a typed ingest/API payload. Never classifies: no responder,
 * no classifier call on any path (valid or malformed).
 */
export function validateTypedIngest(
  body: unknown,
  opts: { unknownFields?: UnknownFieldPolicy } = {},
): ValidateTypedResult {
  const policy = opts.unknownFields ?? 'strip';
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'typed payload must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !KNOWN_TYPED_FIELDS.has(k));
  if (unknown.length > 0 && policy === 'reject') {
    return { ok: false, error: `unknown typed-payload fields: ${unknown.join(', ')}` };
  }
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title) return { ok: false, error: 'title is required' };
  if (title.length > MAX_TITLE_CHARS) return { ok: false, error: 'title must be 500 characters or less' };
  if (record.priority !== undefined) {
    const p = typeof record.priority === 'string' ? record.priority.trim() : '';
    if (!VALID_PRIORITIES.has(p)) return { ok: false, error: `invalid priority: ${JSON.stringify(p)}` };
  }
  const payload = { ...record, title } as unknown as TypedIngestPayload;
  if (unknown.length > 0) {
    for (const k of unknown) delete (payload as unknown as Record<string, unknown>)[k];
  }
  return { ok: true, payload, stripped: unknown };
}

export type TaskCreationInput =
  | {
      kind: 'raw';
      message: string;
      classification?: Classification;
      /**
       * The door applied rawDoorMakesCard (JEV-501, Trevor-approved change to
       * this gate): an unresolved message becomes a card rather than nothing.
       */
      unsureMakesCard?: boolean;
    }
  | { kind: 'typed'; validated: Extract<ValidateTypedResult, { ok: true }> };

/**
 * Task-creation gate. Raw text requires a Classification whose messageHash
 * matches the exact message (proves classify() ran on THIS text). Typed
 * input requires a successful validateTypedIngest result (proves validation
 * ran; classification is correctly absent — never double-classified).
 * Throws on any violation; returns void on success.
 */
export function assertTaskCreationAllowed(input: TaskCreationInput): void {
  if (input.kind === 'typed') {
    if (!input.validated || input.validated.ok !== true) {
      throw new Error('typed task creation requires a validated payload');
    }
    return;
  }
  const { message, classification } = input;
  if (!classification) {
    throw new Error('raw text task creation requires classification first');
  }
  if (classification.messageHash !== hashIntakeMessage(message)) {
    throw new Error('classification does not match this message');
  }
  if (classification.intent === 'unresolved' && !input.unsureMakesCard) {
    throw new Error('unresolved raw text must not create a task');
  }
}

/**
 * Exact small-talk list: the only messages the raw door may leave card-less
 * without a decision engine verdict. Compared whole, lowercased, trailing
 * punctuation dropped — never a prefix or pattern match.
 */
const SMALL_TALK: ReadonlySet<string> = new Set([
  'hi', 'hello', 'hey', 'hi there', 'hello there', 'hey there',
  'good morning', 'good afternoon', 'good evening',
  'thanks', 'thank you', 'thank you so much', 'thanks so much', 'thx', 'ty',
  'ok thanks', 'okay thanks', 'great', 'perfect', '👍',
]);

export function isPureSmallTalk(message: string): boolean {
  return SMALL_TALK.has(message.trim().toLowerCase().replace(/[\s.!]+$/u, '').replace(/\s+/g, ' '));
}

/**
 * JEV-501 raw-door rule — BACKUP LEANS TO CARD. A card is made unless:
 *  - the verdict is a confident control of existing work (existing_task_control,
 *    or clarification_response, which needs a pending question); or
 *  - the message is on the exact small-talk list; or
 *  - the live decision engine itself (provenance 'jev') called it a question
 *    or small talk.
 * Everything else — unresolved, or any lexical-only verdict because the
 * engine is off/shadow/legacy/slow/missing/erroring — makes one card. The
 * door never answers directly for something it could not classify.
 */
export function rawDoorMakesCard(classification: Classification, message: string): boolean {
  const { intent, provenance } = classification;
  if (intent === 'existing_task_control' || intent === 'clarification_response') return false;
  if (intent === 'task_request' || intent === 'mixed_answer_and_task') return true;
  if (isPureSmallTalk(message)) return false;
  if (provenance === 'jev' && (intent === 'answer_only' || intent === 'social_conversation')) return false;
  return true;
}
