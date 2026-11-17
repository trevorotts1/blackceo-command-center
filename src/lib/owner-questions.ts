/**
 * owner-questions.ts — every question Command Center asks the CLIENT.
 *
 * One store, one recommendation, one push, one answer door:
 *   - openOwnerQuestion: records the question with a plain-English
 *     recommendation (never blank). Operator/system faults are never owner
 *     questions: a card blocked on the operator, a SYSTEM-audience stop or an
 *     archived card is refused.
 *   - pushOwnerQuestion: pushes it ONCE to the client's main chat (requester
 *     chat first, else the registered owner chat). Claim-then-send, so a
 *     restart or a second sweep tick can never double-message.
 *   - runOwnerQuestionBackstop: the trust-engine sweep's safety net — pushes
 *     anything still unpushed and sends at most one reminder per 24 hours.
 *   - answerOwnerQuestion: applies the answer by kind (confirm the audience, or
 *     resume the blocked card) and records who answered and where.
 *
 * The OpenClaw agent only RECOGNIZES the client's reply in chat and relays it
 * to POST /api/owner-questions/[id]/chat-answer; Command Center re-reads the
 * client's message itself (owner-chat-verify.ts) before it applies anything.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { queryAll, queryOne, run } from '@/lib/db';
import {
  confirmTaskAudience,
  rescoreAudienceBlend,
  type AudienceConfirmDecision,
} from '@/lib/tasks';
import { cleanPhrase, labelFromRecommendation } from '@/lib/owner-question-text';
import { extractNamedRecipient } from '@/lib/audience/named-recipient';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
import { ANSWERED_AUDIENCE_SOURCES } from '@/lib/board/audience-chip';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import { notifySystem, ownerSendsHeld, ownerSendsSuppressed } from '@/lib/notify';
import {
  isQuietHour,
  sendProviderChoiceAsk,
  sendRequesterAudienceAsk,
  type RequesterAudienceAskDelivery,
} from '@/lib/jobs/trust-engine';

export type OwnerQuestionKind = 'audience' | 'owner_block';
export type OwnerAnswerSource = 'board' | 'chat';

export interface OwnerQuestionRow {
  id: string;
  task_id: string;
  kind: OwnerQuestionKind;
  short_code: string;
  question: string;
  recommendation: string;
  recommended_value: string | null;
  asked_at: string;
  pushed_at: string | null;
  push_delivery: string | null;
  last_reminded_at: string | null;
  reminder_count: number;
  answered_at: string | null;
  answer: string | null;
  answer_source: OwnerAnswerSource | null;
  source_message_ref: string | null;
}

export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A question is reminded at most this many times, then closed as expired. */
export const MAX_REMINDERS_PER_QUESTION = 3;
/** Pushes plus reminders one sweep tick may send (oldest first); the rest wait for the next tick. */
export const MAX_OWNER_QUESTION_SENDS_PER_TICK = 3;
const SHORT_CODE_RE = /^Q-[0-9A-F]{6}$/;

export class OwnerQuestionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OwnerQuestionError';
  }
}

// ---------------------------------------------------------------- recommendation

interface TaskFacts {
  title: string;
  description: string | null;
}

const PROMO_WORDS = /\b(promo|promotion|promotional|sale|launch|campaign|offer|discount|webinar|announce|announcement|newsletter|email blast|black friday)\b/i;
const CLIENT_WORDS = /\b(proposal|invoice|contract|quote|onboarding|welcome|follow[- ]?up|thank[- ]?you|client)\b/i;
const SOCIAL_WORDS = /\b(post|posts|caption|instagram|facebook|linkedin|tiktok|tweet|social)\b/i;


/**
 * Plain-English audience recommendation. Best candidate from the persona gate
 * when there is one, then a named recipient in the task, then a sensible
 * default derived from the task title. Never blank.
 */
export function buildAudienceRecommendation(
  task: TaskFacts,
  decision?: Pick<AudienceConfirmDecision, 'audienceLabel' | 'candidates'> | null,
): { text: string; label: string } {
  const named = extractNamedRecipient(task.title, task.description);
  const fromGate = decision?.audienceLabel ?? decision?.candidates?.[0] ?? null;
  const gateLabel = fromGate && fromGate.trim() ? cleanPhrase(fromGate) : null;
  if (named && named.trim()) {
    const label = cleanPhrase(named);
    return { label, text: `I recommend: ${label}, because the task names them as the reader.` };
  }
  if (gateLabel) {
    return { label: gateLabel, text: `I recommend: ${gateLabel}, because that is who this kind of content is usually written for in your business.` };
  }
  const blob = `${task.title} ${task.description ?? ''}`;
  if (PROMO_WORDS.test(blob)) {
    return {
      label: 'your email list and social media followers',
      text: 'I recommend: your email list and social media followers, because this is a promotional campaign.',
    };
  }
  if (CLIENT_WORDS.test(blob)) {
    return {
      label: 'your clients',
      text: 'I recommend: your clients, because this reads like something you send directly to the people you work with.',
    };
  }
  if (SOCIAL_WORDS.test(blob)) {
    return {
      label: 'your social media followers',
      text: 'I recommend: your social media followers, because this reads like a public post.',
    };
  }
  const title = cleanPhrase(task.title).slice(0, 80) || 'this task';
  return {
    label: 'your existing customers and followers',
    text: `I recommend: your existing customers and followers, because "${title}" is best written for the people who already know your business.`,
  };
}

/** Owner-block recommendation, phrased from what the card says it needs. */
export function buildOwnerBlockRecommendation(needs: string | null | undefined, title?: string | null): string {
  const n = cleanPhrase(needs ?? '');
  if (n) {
    return `I recommend: ${n.charAt(0).toLowerCase()}${n.slice(1)}. Say yes and I will pick the work back up right away.`;
  }
  const t = cleanPhrase(title ?? '').slice(0, 80);
  return t
    ? `I recommend: let "${t}" continue with my best judgment. Say yes and I will pick the work back up right away.`
    : 'I recommend: let me continue with my best judgment. Say yes and I will pick the work back up right away.';
}

// ---------------------------------------------------------------- open

export type OpenOwnerQuestionResult =
  | { ok: true; row: OwnerQuestionRow; created: boolean }
  | { ok: false; reason: 'blank_recommendation' | 'blank_question' | 'task_not_found' | 'task_archived' | 'operator_fault' | 'no_table' };

function newShortCode(): string {
  for (let i = 0; i < 12; i++) {
    const code = `Q-${randomBytes(3).toString('hex').toUpperCase()}`;
    if (!queryOne('SELECT 1 AS x FROM owner_questions WHERE short_code = ?', [code])) return code;
  }
  return `Q-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function openRow(taskId: string, kind: OwnerQuestionKind): OwnerQuestionRow | undefined {
  return queryOne<OwnerQuestionRow>(
    'SELECT * FROM owner_questions WHERE task_id = ? AND kind = ? AND answered_at IS NULL',
    [taskId, kind],
  );
}

export function openOwnerQuestion(p: {
  taskId: string;
  kind: OwnerQuestionKind;
  question: string;
  recommendation: string;
  recommendedValue?: string | null;
}): OpenOwnerQuestionResult {
  if (!p.recommendation || !p.recommendation.trim()) return { ok: false, reason: 'blank_recommendation' };
  if (!p.question || !p.question.trim()) return { ok: false, reason: 'blank_question' };
  try {
    const task = queryOne<{ archived_at: string | null; blocked_on_human: string | null; block_audience: string | null }>(
      'SELECT archived_at, blocked_on_human, block_audience FROM tasks WHERE id = ?',
      [p.taskId],
    );
    if (!task) return { ok: false, reason: 'task_not_found' };
    if (task.archived_at) return { ok: false, reason: 'task_archived' };
    if (task.blocked_on_human === 'operator' || task.block_audience === 'SYSTEM') {
      return { ok: false, reason: 'operator_fault' };
    }
    const existing = openRow(p.taskId, p.kind);
    if (existing) return { ok: true, row: existing, created: false };
    const id = randomUUID();
    const now = new Date().toISOString();
    run(
      `INSERT INTO owner_questions (id, task_id, kind, short_code, question, recommendation, recommended_value, asked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.taskId, p.kind, newShortCode(), p.question.trim(), p.recommendation.trim(), p.recommendedValue?.trim() || null, now],
    );
    return { ok: true, row: queryOne<OwnerQuestionRow>('SELECT * FROM owner_questions WHERE id = ?', [id])!, created: true };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/no such table/i.test(msg)) return { ok: false, reason: 'no_table' };
    // A concurrent open can lose the partial-unique race: return the winner.
    const winner = openRow(p.taskId, p.kind);
    if (winner) return { ok: true, row: winner, created: false };
    throw err;
  }
}

export function getOwnerQuestion(idOrCode: string): OwnerQuestionRow | undefined {
  const key = idOrCode.trim();
  return queryOne<OwnerQuestionRow>(
    'SELECT * FROM owner_questions WHERE id = ? OR short_code = ?',
    [key, key.toUpperCase()],
  );
}

// ---------------------------------------------------------------- push

/** The exact text the client reads in chat. */
export function composeOwnerQuestionMessage(q: Pick<OwnerQuestionRow, 'question' | 'recommendation' | 'short_code'>): string {
  const rec = q.recommendation.trim().replace(/^i recommend:\s*/i, '');
  return `${q.question.trim()}\n\nMy recommendation: ${rec}\n\nReply YES to go with my recommendation, or tell me what you want instead. (ref ${q.short_code})`;
}

export type OwnerQuestionSender = (taskId: string, text: string) => RequesterAudienceAskDelivery;

/** Requester chat first, else the registered owner chat. */
export const defaultOwnerQuestionSender: OwnerQuestionSender = (taskId, text) => {
  const viaRequester = sendRequesterAudienceAsk(taskId, text);
  if (viaRequester === 'telegram' || viaRequester === 'session') return viaRequester;
  return sendProviderChoiceAsk(taskId, text);
};

export interface PushOptions {
  send?: OwnerQuestionSender;
  now?: Date;
  /** Skip the quiet-hours deferral (stuck/blocked notices and the first audience ask never waited for morning). */
  bypassQuietHours?: boolean;
  /** Prefix the text (reminders). */
  prefix?: string;
}

export type PushResult =
  | { status: 'pushed'; delivery: RequesterAudienceAskDelivery }
  | { status: 'already_pushed' | 'closed' | 'not_found' | 'deferred' }
  | { status: 'undeliverable'; delivery: RequesterAudienceAskDelivery };

function gateSends(opts: PushOptions): boolean {
  if (!opts.send && (ownerSendsSuppressed() || ownerSendsHeld())) return true;
  if (!opts.bypassQuietHours && isQuietHour(opts.now ?? new Date())) return true;
  return false;
}

function reportUndeliverableOnce(q: OwnerQuestionRow, delivery: string): void {
  if (q.push_delivery && q.push_delivery.startsWith('none')) return; // already reported
  try {
    notifySystem(
      `[owner-question-undeliverable] Question ${q.short_code} on task ${q.task_id} could not be sent: no owner chat resolved (${delivery}).`,
      { agent: 'owner-questions', action: 'escalate' },
    );
  } catch { /* best-effort */ }
}

/** Atomic claim of the one push. Exactly one caller per question ever gets true. */
export function claimPush(id: string, nowIso: string): boolean {
  const res = run('UPDATE owner_questions SET pushed_at = ? WHERE id = ? AND pushed_at IS NULL AND answered_at IS NULL', [nowIso, id]);
  return (res.changes ?? 0) > 0;
}

/** Atomic claim of one reminder: only the caller that saw the current last_reminded_at wins. */
export function claimReminder(id: string, expectedLast: string | null, nowIso: string): boolean {
  const res = run(
    'UPDATE owner_questions SET last_reminded_at = ?, reminder_count = reminder_count + 1 WHERE id = ? AND answered_at IS NULL AND last_reminded_at IS ?',
    [nowIso, id, expectedLast],
  );
  return (res.changes ?? 0) > 0;
}

export function pushOwnerQuestion(id: string, opts: PushOptions = {}): PushResult {
  const q = getOwnerQuestion(id);
  if (!q) return { status: 'not_found' };
  if (q.answered_at) return { status: 'closed' };
  if (q.pushed_at) return { status: 'already_pushed' };
  if (gateSends(opts)) return { status: 'deferred' };

  const now = (opts.now ?? new Date()).toISOString();
  if (!claimPush(q.id, now)) return { status: 'already_pushed' };

  let delivery: RequesterAudienceAskDelivery = 'send_failed';
  try {
    delivery = (opts.send ?? defaultOwnerQuestionSender)(q.task_id, `${opts.prefix ?? ''}${composeOwnerQuestionMessage(q)}`);
  } catch { /* retain send_failed */ }

  if (delivery === 'telegram' || delivery === 'session') {
    run('UPDATE owner_questions SET push_delivery = ? WHERE id = ?', [delivery, q.id]);
    return { status: 'pushed', delivery };
  }
  // Nothing was sent: release the claim so the sweep retries.
  run('UPDATE owner_questions SET pushed_at = NULL, push_delivery = ? WHERE id = ?', [delivery, q.id]);
  if (delivery.startsWith('none')) reportUndeliverableOnce(q, delivery);
  return { status: 'undeliverable', delivery };
}

/** One reminder, at most once per 24 hours per question, at most MAX_REMINDERS_PER_QUESTION in all. */
export function remindOwnerQuestion(id: string, opts: PushOptions = {}): 'reminded' | 'not_due' | 'deferred' | 'failed' | 'expired' {
  const q = getOwnerQuestion(id);
  if (!q || q.answered_at || !q.pushed_at) return 'not_due';
  const nowDate = opts.now ?? new Date();
  const last = Date.parse(q.last_reminded_at ?? q.pushed_at);
  if (!Number.isFinite(last) || nowDate.getTime() - last < REMINDER_INTERVAL_MS) return 'not_due';
  if ((q.reminder_count ?? 0) >= MAX_REMINDERS_PER_QUESTION) {
    if (closeQuestion(q.id, `(expired: no answer after ${MAX_REMINDERS_PER_QUESTION} reminders)`, 'board')) {
      try {
        notifySystem(
          `[owner-question-expired] Question ${q.short_code} on task ${q.task_id} got no answer after ${MAX_REMINDERS_PER_QUESTION} reminders and was closed.`,
          { agent: 'owner-questions', action: 'escalate' },
        );
      } catch { /* best-effort */ }
    }
    return 'expired';
  }
  if (gateSends(opts)) return 'deferred';
  const nowIso = nowDate.toISOString();
  if (!claimReminder(q.id, q.last_reminded_at, nowIso)) return 'not_due';
  let delivery: RequesterAudienceAskDelivery = 'send_failed';
  try {
    delivery = (opts.send ?? defaultOwnerQuestionSender)(q.task_id, `Reminder: ${composeOwnerQuestionMessage(q)}`);
  } catch { /* retain */ }
  if (delivery === 'telegram' || delivery === 'session') return 'reminded';
  run('UPDATE owner_questions SET last_reminded_at = ?, reminder_count = reminder_count - 1 WHERE id = ?', [q.last_reminded_at, q.id]);
  return 'failed';
}

// ---------------------------------------------------------------- closing

function closeQuestion(id: string, answer: string, source: OwnerAnswerSource, ref: string | null = null): boolean {
  const res = run(
    `UPDATE owner_questions SET answered_at = ?, answer = ?, answer_source = ?, source_message_ref = COALESCE(?, source_message_ref)
      WHERE id = ? AND answered_at IS NULL`,
    [new Date().toISOString(), answer, source, ref, id],
  );
  return (res.changes ?? 0) > 0;
}

/** Called by confirmTaskAudience: the board (or auto-answer) settled the audience. */
export function closeOpenAudienceQuestion(taskId: string, label: string | null): void {
  try {
    const q = openRow(taskId, 'audience');
    if (q) closeQuestion(q.id, label ?? '(confirmed on the board)', 'board');
  } catch { /* table may not exist on an un-migrated box */ }
}

const PRE_DISPATCH_STATES = new Set(['inbox', 'planning', 'backlog', 'pending_dispatch', 'assigned']);

/**
 * True when the card no longer waits on the owner for THIS question: gone,
 * archived, an operator fault, or (audience) the persona bundle is no longer
 * pending / the card left the pre-dispatch states, or (owner_block) the card
 * is no longer blocked on the owner.
 */
export function isQuestionStale(q: Pick<OwnerQuestionRow, 'task_id' | 'kind'>): boolean {
  const t = queryOne<{ status: string; archived_at: string | null; audience_source: string | null; blocked_on_human: string | null; block_audience: string | null }>(
    'SELECT status, archived_at, audience_source, blocked_on_human, block_audience FROM tasks WHERE id = ?',
    [q.task_id],
  );
  if (!t || t.archived_at || t.blocked_on_human === 'operator' || t.block_audience === 'SYSTEM') return true;
  const blockedOnOwner = t.status === 'blocked' && (t.block_audience === 'OWNER' || t.blocked_on_human === 'owner');
  if (q.kind === 'owner_block') return !blockedOnOwner;
  // audience
  if (!blockedOnOwner && !PRE_DISPATCH_STATES.has(t.status)) return true; // running / finished: nothing left to confirm
  if ((ANSWERED_AUDIENCE_SOURCES as readonly string[]).includes(t.audience_source ?? '') && t.status !== 'blocked') return true;
  const bundle = queryOne<{ confirm_state: string | null }>('SELECT confirm_state FROM task_persona_bundle WHERE task_id = ?', [q.task_id]);
  return !bundle || bundle.confirm_state !== 'pending';
}

/** Close questions whose card no longer waits on the owner (answered elsewhere, archived, released, resumed). */
export function closeStaleOwnerQuestions(): number {
  let closed = 0;
  try {
    const open = queryAll<OwnerQuestionRow>('SELECT * FROM owner_questions WHERE answered_at IS NULL');
    for (const q of open) {
      if (isQuestionStale(q) && closeQuestion(q.id, '(closed: this card no longer waits on you)', 'board')) closed++;
    }
  } catch { /* table may not exist */ }
  return closed;
}

export interface BackstopResult { closed: number; pushed: number; reminded: number; deferred: number }

/** The trust-engine sweep's safety net. Never throws. */
export function runOwnerQuestionBackstop(opts: { now?: Date; send?: OwnerQuestionSender } = {}): BackstopResult {
  const out: BackstopResult = { closed: 0, pushed: 0, reminded: 0, deferred: 0 };
  try {
    out.closed = closeStaleOwnerQuestions();
    const open = queryAll<OwnerQuestionRow>('SELECT * FROM owner_questions WHERE answered_at IS NULL ORDER BY asked_at ASC');
    let sends = 0;
    for (const q of open) {
      if (sends >= MAX_OWNER_QUESTION_SENDS_PER_TICK) break; // the rest wait for the next tick
      if (!q.pushed_at) {
        const r = pushOwnerQuestion(q.id, { now: opts.now, send: opts.send });
        if (r.status === 'pushed') { out.pushed++; sends++; }
        else if (r.status === 'deferred') out.deferred++;
      } else {
        const r = remindOwnerQuestion(q.id, { now: opts.now, send: opts.send });
        if (r === 'reminded') { out.reminded++; sends++; }
        else if (r === 'deferred') out.deferred++;
      }
    }
  } catch (err) {
    console.warn('[owner-questions] backstop failed (non-fatal):', (err as Error).message);
  }
  return out;
}

// ---------------------------------------------------------------- answering

const YES_CORE = new Set(['yes', 'yep', 'yeah', 'yup', 'y', 'ok', 'okay', 'k', 'sure', 'go', 'sounds', 'good', 'great', 'perfect', 'approve', 'approved', 'agree', 'confirm', 'confirmed', 'fine', '👍', '✅', '👌']);
const YES_FILLER = new Set(['ahead', 'please', 'do', 'it', 'that', 'this', 'thanks', 'thank', 'you', 'with', 'the', 'your', 'my', 'recommendation', 'i', 'it\'s', 'its', 'is', 'to', 'and', 'all', 'right', 'looks', 'works', 'for', 'me', 'recommended', 'one', 'go-ahead']);
const NO_WORDS = new Set(['no', 'nope', 'nah', 'not', 'dont', "don't", 'never', 'stop', 'wait', 'hold', 'cancel', 'instead', 'but', 'change']);

/** Strip the reference code the client may have typed or quoted. */
export function stripQuestionCode(text: string): string {
  return text.replace(/\(?\bref\s+Q-[0-9A-F]{6}\)?/gi, ' ').replace(/\bQ-[0-9A-F]{6}\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** True when the words are a plain yes / ok / sure / go ahead / sounds good. */
export function isYes(text: string): boolean {
  const toks = stripQuestionCode(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}'’✅-]+/gu, ' ')
    .replace(/’/g, "'")
    .split(/\s+/)
    .filter(Boolean);
  if (toks.length === 0 || toks.length > 10) return false;
  if (toks.some((t) => NO_WORDS.has(t))) return false;
  return toks.every((t) => YES_CORE.has(t) || YES_FILLER.has(t)) && toks.some((t) => YES_CORE.has(t));
}

export interface AnswerResult {
  ok: true;
  row: OwnerQuestionRow;
  applied: OwnerQuestionKind;
  replayed: boolean;
}

/** Resume a blocked card the same way POST /api/tasks/[id]/resume does. */
async function resumeBlockedTask(taskId: string, note: string): Promise<boolean> {
  const task = queryOne<{ status: string; title: string; next_dispatch_eligible_at: string | null }>(
    'SELECT status, title, next_dispatch_eligible_at FROM tasks WHERE id = ?',
    [taskId],
  );
  if (!task || task.status !== 'blocked') return false;
  if (task.next_dispatch_eligible_at && Date.parse(task.next_dispatch_eligible_at) > Date.now()) {
    run('UPDATE tasks SET next_dispatch_eligible_at = NULL WHERE id = ?', [taskId]);
  }
  try {
    await transition(taskId, 'backlog', { actor: 'owner', reason: `[owner-question] ${note}`, expectedFrom: 'blocked' });
  } catch (err) {
    if (err instanceof TransitionError && err.code === 'CAS_CONFLICT') return false;
    throw err;
  }
  try {
    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), taskId, 'resume_from_blocked', `Task "${task.title}" resumed from blocked after your answer`, JSON.stringify({ actor: 'owner', from: 'blocked', to: 'backlog' }), new Date().toISOString()],
    );
  } catch { /* activity table optional */ }
  return true;
}

function postOwnerAnswerActivity(taskId: string, message: string, meta: Record<string, unknown>): void {
  try {
    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), taskId, 'owner_answer', message.slice(0, 4000), JSON.stringify(meta), new Date().toISOString()],
    );
  } catch { /* activity table optional */ }
}

export async function answerOwnerQuestion(p: {
  id?: string;
  shortCode?: string;
  answer: string;
  source: OwnerAnswerSource;
  sourceMessageRef?: string | null;
}): Promise<AnswerResult> {
  const key = (p.id ?? p.shortCode ?? '').trim();
  const q = key ? getOwnerQuestion(key) : undefined;
  if (!q) throw new OwnerQuestionError('not_found', 'No such question.');
  const ref = p.sourceMessageRef?.trim() || null;

  if (q.answered_at) {
    if (ref && q.source_message_ref === ref) return { ok: true, row: q, applied: q.kind, replayed: true };
    throw new OwnerQuestionError('already_answered', 'This question was already answered.');
  }
  if (ref) {
    const used = queryOne<{ id: string }>('SELECT id FROM owner_questions WHERE source_message_ref = ? AND id != ?', [ref, q.id]);
    if (used) throw new OwnerQuestionError('message_already_used', 'That message already answered a different question.');
  }
  if (isQuestionStale(q)) {
    closeQuestion(q.id, '(closed: this card no longer waits on you)', 'board');
    throw new OwnerQuestionError('question_no_longer_open', 'That card no longer waits on an answer from you, so nothing was changed.');
  }
  const typed = stripQuestionCode(p.answer);
  if (!typed) throw new OwnerQuestionError('blank_answer', 'The answer is empty.');

  const accepted = isYes(typed);
  const finalAnswer = accepted ? `Yes, go with the recommendation: ${q.recommendation}` : typed;

  // Claim first: the board-confirm hook below then finds nothing open to close.
  if (!closeQuestion(q.id, finalAnswer, p.source, ref)) {
    const again = getOwnerQuestion(q.id)!;
    if (ref && again.source_message_ref === ref) return { ok: true, row: again, applied: again.kind, replayed: true };
    throw new OwnerQuestionError('already_answered', 'This question was already answered.');
  }

  try {
    if (q.kind === 'audience') {
      const label = (accepted ? q.recommended_value?.trim() || labelFromRecommendation(q.recommendation) : typed).slice(0, 200);
      if (!label) throw new OwnerQuestionError('no_audience', 'Could not work out who this is for.');
      const task = queryOne<{ title: string; description: string | null; department: string | null; workspace_id: string | null }>(
        'SELECT title, description, department, workspace_id FROM tasks WHERE id = ?',
        [q.task_id],
      );
      if (!task) throw new OwnerQuestionError('task_not_found', 'The card no longer exists.');
      try {
        confirmTaskAudience(q.task_id, { audienceLabel: label, source: 'operator_confirmed' });
      } catch (err) {
        if ((err as Error).message === 'persona_bundle_missing') {
          throw new OwnerQuestionError('no_audience_gate', 'This card has no audience question to answer.');
        }
        throw err;
      }
      const dept = canonicalDeptSlug(task.department || task.workspace_id || '') || 'general';
      await rescoreAudienceBlend(q.task_id, `${task.title}${task.description ? `. ${task.description}` : ''}`.trim(), dept, label);
      postOwnerAnswerActivity(q.task_id, `You answered in chat: this is for ${label}.`, { question: q.short_code, source: p.source });
      // A hard-held card (blocked on the audience) waits for this same answer.
      await resumeBlockedTask(q.task_id, 'audience answered');
    } else {
      postOwnerAnswerActivity(
        q.task_id,
        accepted ? `You said yes to my recommendation: ${q.recommendation}` : `Your answer: ${typed}`,
        { question: q.short_code, source: p.source, accepted },
      );
      await resumeBlockedTask(q.task_id, 'owner answered');
    }
  } catch (err) {
    // Roll the claim back so the client can answer again.
    run('UPDATE owner_questions SET answered_at = NULL, answer = NULL, answer_source = NULL, source_message_ref = NULL WHERE id = ?', [q.id]);
    throw err;
  }
  return { ok: true, row: getOwnerQuestion(q.id)!, applied: q.kind, replayed: false };
}

/** The board answer for owner_block kinds is the card's own Resume; close the question there too. */
export function closeOpenOwnerBlockQuestion(taskId: string, note: string): void {
  try {
    const q = openRow(taskId, 'owner_block');
    if (q) closeQuestion(q.id, note, 'board');
  } catch { /* table may not exist */ }
}

export function listOpenOwnerQuestions(): Array<Pick<OwnerQuestionRow, 'id' | 'task_id' | 'kind' | 'short_code' | 'question' | 'recommendation' | 'asked_at' | 'pushed_at'> & { task_title: string }> {
  closeStaleOwnerQuestions();
  return queryAll(
    `SELECT q.id, q.task_id, t.title AS task_title, q.kind, q.short_code, q.question, q.recommendation, q.asked_at, q.pushed_at
       FROM owner_questions q JOIN tasks t ON t.id = q.task_id
      WHERE q.answered_at IS NULL
      ORDER BY q.asked_at ASC`,
  );
}

export const OWNER_QUESTION_SHORT_CODE_RE = SHORT_CODE_RE;
