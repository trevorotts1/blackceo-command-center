/**
 * owner-question-chat.ts — the client's chat answer, relayed by the agent.
 *
 * Same rule as chat-approvals.ts: the agent (MC_API_TOKEN bearer) relays, but
 * Command Center never takes the agent's word for it. It re-reads the client's
 * message from the gateway's own inbound record and applies the answer only
 * when the message exists, came from the owner's chat (or the card's own
 * requester chat), was written by a person and not a bot, was sent after the
 * question was asked, and is bound to THIS question (carries its ref code,
 * replies to the push, or is the owner's only open question).
 *
 * The words applied are the VERIFIED message's, never the agent's paraphrase.
 */
import type { TenantContext } from '@/lib/auth/tenant-context';
import { queryAll, queryOne } from '@/lib/db';
import { resolveOwnerChatId } from '@/lib/notify';
import { readTelegramInbound, readWebchatInbound, type InboundMessage, type ReadResult } from '@/lib/gateway-inbound';
import {
  answerOwnerQuestion,
  getOwnerQuestion,
  OwnerQuestionError,
  stripQuestionCode,
  type OwnerQuestionRow,
} from '@/lib/owner-questions';

export interface ChatAnswerResult { status: number; payload: Record<string, unknown> }
export interface ChatAnswerDeps {
  readTelegram?: (chatId: string, messageId: string) => ReadResult;
  readWebchat?: (sessionId: string, messageId: string) => ReadResult;
  ownerChatId?: () => string | null;
  now?: () => number;
}

const SKEW_MS = 120_000;
const refuse = (status: number, error: string, detail: string): ChatAnswerResult => ({ status, payload: { error, detail, hint: detail } });

const hasCode = (text: string, code: string): boolean =>
  new RegExp(`(?<![0-9A-Fa-f])${code}(?![0-9A-Fa-f])`, 'i').test(text);

function publicQuestion(q: OwnerQuestionRow) {
  return {
    id: q.id, task_id: q.task_id, kind: q.kind, short_code: q.short_code, question: q.question,
    recommendation: q.recommendation, asked_at: q.asked_at, pushed_at: q.pushed_at,
    answered_at: q.answered_at, answer: q.answer, answer_source: q.answer_source,
  };
}

export async function applyOwnerChatAnswer(
  ctx: TenantContext,
  idOrCode: string,
  input: unknown,
  deps: ChatAnswerDeps = {},
): Promise<ChatAnswerResult> {
  if (ctx.subject !== 'operator:api') return refuse(403, 'agent_token_required', 'chat answers are relayed by the agent');
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refuse(400, 'invalid_body', 'send a JSON object');
  const b = input as Record<string, unknown>;
  if (typeof b.answer !== 'string' || !b.answer.trim() || b.answer.length > 4000) return refuse(400, 'invalid_answer', 'answer is a non-empty string up to 4000 characters');
  if (b.channel !== 'telegram' && b.channel !== 'webchat') return refuse(400, 'invalid_channel', 'channel is telegram or webchat');
  const channel = b.channel;
  const ref = typeof b.source_message_ref === 'string' ? b.source_message_ref.trim() : '';
  const first = ref.indexOf(':');
  const last = ref.lastIndexOf(':');
  if (first < 1 || last <= first || ref.slice(0, first) !== channel) {
    return refuse(400, 'invalid_source_message_ref', `expected "${channel}:<chat_or_session_id>:<message_id>"`);
  }
  const conversationId = ref.slice(first + 1, last);
  const messageId = ref.slice(last + 1);

  let q: OwnerQuestionRow | undefined;
  try { q = getOwnerQuestion(idOrCode); } catch { q = undefined; }
  if (!q) return refuse(404, 'question_not_found', 'No such question.');
  if (q.answered_at) {
    if (q.source_message_ref === ref) return { status: 200, payload: { success: true, applied: q.kind, replayed: true, question: publicQuestion(q) } };
    return refuse(409, 'already_answered', 'This question was already answered.');
  }

  // Who the owner is.
  let ownerChat: string | null = null;
  try { ownerChat = (deps.ownerChatId ?? resolveOwnerChatId)(); } catch { ownerChat = null; }
  const task = queryOne<{ requester_chat_id: string | null }>('SELECT requester_chat_id FROM tasks WHERE id = ?', [q.task_id]);
  const allowedChats = new Set([ownerChat, task?.requester_chat_id].filter((x): x is string => !!x));
  if (channel === 'telegram' && allowedChats.size === 0) {
    return refuse(422, 'owner_not_registered', 'No owner chat is registered on this box, so a chat answer cannot be verified. Answer on the board.');
  }

  const read = channel === 'telegram'
    ? (deps.readTelegram ?? readTelegramInbound)(conversationId, messageId)
    : (deps.readWebchat ?? readWebchatInbound)(conversationId, messageId);
  if (!read.ok) {
    const why = {
      store_unavailable: 'Command Center could not read the chat record to confirm the message, so nothing was applied. Answer on the board.',
      message_not_found: 'Command Center could not find that message in the chat record, so nothing was applied.',
      malformed: 'That message reference is not valid.',
    } as const;
    return refuse(422, read.reason === 'malformed' ? 'invalid_source_message_ref' : 'message_unverified', why[read.reason]);
  }
  const msg: InboundMessage = read.message;

  if (channel === 'telegram' && (!allowedChats.has(msg.conversationId) || msg.senderId !== msg.conversationId)) {
    return refuse(422, 'not_from_owner', 'That message did not come from the registered owner chat.');
  }
  if (msg.senderIsBot || (msg.botUserId && msg.senderId === msg.botUserId)) {
    return refuse(422, 'sender_is_bot', 'That message was written by the assistant, not by the owner.');
  }
  if (channel === 'webchat' && msg.senderId !== `webchat:${msg.conversationId}`) {
    return refuse(422, 'not_from_owner', 'That webchat entry is not a message the owner typed.');
  }
  const asked = Date.parse(q.asked_at);
  if (Number.isFinite(asked) && msg.sentAtMs < Math.floor(asked / 1000) * 1000) {
    return refuse(422, 'message_before_question', 'That message was sent before this question was asked.');
  }
  if (msg.sentAtMs > (deps.now?.() ?? Date.now()) + SKEW_MS) return refuse(422, 'message_in_future', 'That message is dated in the future.');

  // Bound to THIS question.
  let bound = hasCode(msg.text, q.short_code)
    || (!!msg.replyTo && msg.replyTo.senderIsBot && hasCode(msg.replyTo.text, q.short_code));
  if (!bound) {
    const quotedOther = msg.replyTo?.senderIsBot && /\bref\s+Q-[0-9A-F]{6}\b/i.test(msg.replyTo.text);
    if (quotedOther) return refuse(422, 'message_for_other_question', 'That reply answers a different question.');
    const open = queryAll<{ id: string }>('SELECT id FROM owner_questions WHERE answered_at IS NULL');
    bound = open.length === 1 && open[0].id === q.id;
  }
  if (!bound) {
    return refuse(422, 'ambiguous_question', `Several questions are waiting. Reply directly to the question, or include its code ${q.short_code}.`);
  }

  const text = stripQuestionCode(msg.text) ? msg.text : b.answer;
  try {
    const r = await answerOwnerQuestion({ id: q.id, answer: text, source: 'chat', sourceMessageRef: ref });
    return { status: 200, payload: { success: true, applied: r.applied, replayed: r.replayed, question: publicQuestion(r.row) } };
  } catch (err) {
    if (err instanceof OwnerQuestionError) {
      if (err.code === 'already_answered' || err.code === 'message_already_used') return refuse(409, err.code, err.message);
      if (err.code === 'not_found') return refuse(404, 'question_not_found', err.message);
      return refuse(422, err.code, err.message);
    }
    throw err;
  }
}
