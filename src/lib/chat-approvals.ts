/**
 * chat-approvals.ts — the owner's yes, given in chat instead of on the web page.
 *
 * THE RULE. The agent relays a chat decision (MC_API_TOKEN bearer), but Command
 * Center never takes the agent's word for it. It reads the owner's message
 * itself from the gateway's own inbound record (gateway-inbound.ts, read-only)
 * and mints ONLY when every check passes:
 *   1. the message exists in the gateway record;
 *   2. its chat is the tenant's registered owner chat (Telegram: the owner chat
 *      id resolveOwnerChatId() already uses for owner-login and notify);
 *   3. its sender is that owner and not a bot (and not the gateway's bot id);
 *   4. it was sent after the request was created and before the request expired;
 *   5. its text is a clear yes (approve) or a clear change request, matching the
 *      decision claimed, in English;
 *   6. it is bound to THIS request: a reply to the agent's approval message that
 *      carries this request's code, or text containing the short code, or an
 *      inline-button callback naming the full request id, or the owner has
 *      exactly this one pending request.
 * A failure is a 403/409 with a reason code and a sentence the agent can relay.
 * The record is minted exactly as the web Approve does (same scope and plan
 * binding, authenticated_platform_record), idempotent on the message reference.
 *
 * HONEST LIMIT. An agent with shell on the box could in theory tamper with the
 * local stores this reads. This stops the realistic failure: an agent claiming,
 * guessing or hallucinating an approval, because there is then no real owner
 * message for Command Center to find.
 */
import { randomUUID } from 'node:crypto';
import { queryAll, queryOne, run, transaction } from '@/lib/db';
import type { TenantContext } from '@/lib/auth/tenant-context';
import { resolveOwnerChatId } from '@/lib/notify';
import { PLAN_HASH_RE, OWNER_REQUEST_REF_PREFIX } from '@/lib/launch-approvals';
import { approvalExpiry, shortCodeOf, toRequest, type Row, type RequestResult } from '@/lib/approval-requests';
import { readTelegramInbound, readWebchatInbound, type InboundMessage } from '@/lib/gateway-inbound';

export const CHAT_CHANNELS = ['telegram', 'webchat'] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];
export type ChatDecision = 'approve' | 'changes';

/** Messages may not be dated meaningfully in the future (clock skew allowance). */
const SKEW_MS = 120_000;

const refuse = (status: number, error: string, detail: string): RequestResult => ({ status, payload: { error, detail } });

// ---------------------------------------------------------------- text reading

const NEGATION = new Set(['no', 'nope', 'not', 'dont', "don't", 'never', 'stop', 'wait', 'hold', 'cancel', 'nah']);
const CHANGE_WORDS = new Set(['change', 'changes', 'edit', 'revise', 'redo', 'fix', 'rewrite', 'tweak', 'reject', 'rejected', 'decline', 'declined', 'no', 'nope', 'nah']);
const APPROVE_CORE = new Set(['approve', 'approved', 'yes', 'yep', 'yeah', 'y', 'ok', 'okay', 'k', 'sure', 'go', 'good', 'great', 'perfect', 'lgtm', 'confirm', 'confirmed', '👍', '✅', '👌']);
const APPROVE_FILLER = new Set(['it', 'this', 'that', 'please', 'thanks', 'thank', 'you', 'do', 'the', 'plan', 'and', 'ahead', 'looks', 'sounds', 'all', 'right', 'is', 'its', "it's", 'i', 'send', 'publish', 'post', 'ship', 'proceed', 'now', 'them', 'these', 'code']);

function tokens(text: string, code: string): string[] {
  return text
    .toLowerCase()
    .replace(new RegExp(`\\b${code}\\b`, 'gi'), ' ')
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}'’✅]+/gu, ' ')
    .replace(/’/g, "'")
    .split(/\s+/)
    .filter(Boolean);
}

/** What the owner's words mean. `callback` carries the full request id from an inline button. */
export function interpretOwnerText(text: string, requestId: string): { meaning: 'approve' | 'changes' | 'unclear'; callbackFor: string | null } {
  const cb = /^\s*(?:callback_data:\s*)?apr:([0-9a-f-]{36}):(approve|changes)\s*$/i.exec(text);
  if (cb) return { meaning: cb[2].toLowerCase() === 'approve' ? 'approve' : 'changes', callbackFor: cb[1].toLowerCase() };
  const toks = tokens(text, shortCodeOf(requestId));
  if (toks.length === 0 || toks.length > 14) return { meaning: 'unclear', callbackFor: null };
  if (toks.some((t) => CHANGE_WORDS.has(t))) return { meaning: 'changes', callbackFor: null };
  if (toks.some((t) => NEGATION.has(t))) return { meaning: 'unclear', callbackFor: null };
  if (toks.every((t) => APPROVE_CORE.has(t) || APPROVE_FILLER.has(t)) && toks.some((t) => APPROVE_CORE.has(t))) {
    return { meaning: 'approve', callbackFor: null };
  }
  return { meaning: 'unclear', callbackFor: null };
}

const hasCode = (text: string, code: string): boolean =>
  new RegExp(`(?<![0-9a-f])${code}(?![0-9a-f])`, 'i').test(text);

// -------------------------------------------------------------------- decision

interface Parsed { channel: ChatChannel; conversationId: string; messageId: string; decision: ChatDecision; note: string }

function parseBody(input: unknown): Parsed | RequestResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refuse(400, 'invalid_body', 'send a JSON object');
  const b = input as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !['decision', 'channel', 'source_message_ref', 'note'].includes(k));
  if (extra) return refuse(400, 'unknown_field', extra);
  if (b.decision !== 'approve' && b.decision !== 'changes') return refuse(400, 'invalid_decision', 'decision is approve or changes');
  if (!CHAT_CHANNELS.includes(b.channel as ChatChannel)) return refuse(400, 'invalid_channel', 'channel is telegram or webchat');
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 2000)) return refuse(400, 'invalid_note', 'note is a string up to 2000 characters');
  const ref = typeof b.source_message_ref === 'string' ? b.source_message_ref.trim() : '';
  const channel = b.channel as ChatChannel;
  const first = ref.indexOf(':');
  const last = ref.lastIndexOf(':');
  if (first < 1 || last <= first || ref.slice(0, first) !== channel) {
    return refuse(400, 'invalid_source_message_ref', `expected "${channel}:<chat_or_session_id>:<message_id>"`);
  }
  return {
    channel, decision: b.decision as ChatDecision, conversationId: ref.slice(first + 1, last),
    messageId: ref.slice(last + 1), note: typeof b.note === 'string' ? b.note.trim() : '',
  };
}

function bind(row: Row, msg: InboundMessage, callbackFor: string | null, ownerPendingIds: string[]): { ok: true } | { ok: false; res: RequestResult } {
  const code = shortCodeOf(row.request_id);
  if (callbackFor) {
    return callbackFor === row.request_id.toLowerCase()
      ? { ok: true }
      : { ok: false, res: refuse(409, 'message_for_other_request', 'That button belongs to a different approval request.') };
  }
  if (msg.replyTo) {
    const quoted = msg.replyTo.text;
    if (msg.replyTo.senderIsBot && hasCode(quoted, code)) return { ok: true };
    if (msg.replyTo.senderIsBot && /Code:\s*[0-9a-f]{6}\b/i.test(quoted)) {
      return { ok: false, res: refuse(409, 'message_for_other_request', 'That reply answers a different approval request.') };
    }
  }
  if (hasCode(msg.text, code)) return { ok: true };
  if (ownerPendingIds.length === 1 && ownerPendingIds[0] === row.request_id) return { ok: true };
  return {
    ok: false,
    res: refuse(409, 'ambiguous_request',
      `You have ${ownerPendingIds.length} approvals waiting. Reply directly to the approval message, or include the code ${code} in your answer.`),
  };
}

function readMessage(parsed: Parsed): { ok: true; msg: InboundMessage } | { ok: false; res: RequestResult } {
  const r = parsed.channel === 'telegram'
    ? readTelegramInbound(parsed.conversationId, parsed.messageId)
    : readWebchatInbound(parsed.conversationId, parsed.messageId);
  if (r.ok) return { ok: true, msg: r.message };
  const why = {
    store_unavailable: refuse(403, 'inbound_record_unavailable', 'Command Center could not read the chat record to confirm your message, so nothing was approved. Use the approval page instead.'),
    message_not_found: refuse(403, 'message_not_found', 'Command Center could not find that message in the chat record, so nothing was approved.'),
    malformed: refuse(400, 'invalid_source_message_ref', 'That message reference is not valid.'),
  } as const;
  return { ok: false, res: why[r.reason] };
}

/**
 * AGENT-RELAYED OWNER DOOR. `ctx` must be the agent bearer (operator:api); the
 * authority comes from the verified chat message, not from the caller.
 */
export function decideApprovalFromChat(ctx: TenantContext, requestId: string, input: unknown): RequestResult {
  if (ctx.subject !== 'operator:api') return refuse(403, 'agent_token_required', 'chat decisions are relayed by the agent');
  const parsed = parseBody(input);
  if ('status' in parsed) return parsed;

  const row0 = queryOne<Row>('SELECT * FROM approval_requests WHERE request_id = ? AND tenant_id = ?', [requestId, ctx.tenantId]);
  if (!row0) return refuse(404, 'request_not_found', 'No such approval request.');

  // Who the owner is. Telegram: the configured owner chat. Webchat: the session in the reference.
  let ownerChat: string | null = null;
  try { ownerChat = resolveOwnerChatId(); } catch { ownerChat = null; }
  if (parsed.channel === 'telegram' && !ownerChat) {
    return refuse(403, 'owner_not_registered', 'No owner chat is registered on this box, so a chat approval cannot be verified. Use the approval page.');
  }

  const read = readMessage(parsed);
  if (!read.ok) return read.res;
  const msg = read.msg;

  // 2 + 3: owner chat, owner sender, not a bot.
  if (parsed.channel === 'telegram' && (msg.conversationId !== ownerChat || msg.senderId !== ownerChat)) {
    return refuse(403, 'not_from_owner', 'That message did not come from the registered owner chat.');
  }
  if (msg.senderIsBot || (msg.botUserId && msg.senderId === msg.botUserId)) {
    return refuse(403, 'sender_is_bot', 'That message was written by the assistant, not by the owner.');
  }
  if (parsed.channel === 'webchat' && msg.senderId !== `webchat:${msg.conversationId}`) {
    return refuse(403, 'not_from_owner', 'That webchat entry is not a message the owner typed.');
  }

  // 4: inside the request window.
  const created = Date.parse(row0.created_at);
  const expires = Date.parse(row0.expires_at);
  // Telegram dates are whole seconds, so compare at second resolution.
  if (msg.sentAtMs < Math.floor(created / 1000) * 1000) return refuse(403, 'message_before_request', 'That message was sent before this approval was asked for.');
  if (msg.sentAtMs >= expires) return refuse(409, 'request_expired', 'This request had already expired when that message was sent.');
  if (msg.sentAtMs > Date.now() + SKEW_MS) return refuse(403, 'message_in_future', 'That message is dated in the future.');

  // 5: the words.
  const said = interpretOwnerText(msg.text, requestId);
  if (said.meaning === 'unclear') {
    return refuse(409, 'text_not_a_decision', 'That message is not a clear yes or a clear change request. Ask the owner to reply "approve" or describe the changes.');
  }
  if (said.meaning !== parsed.decision) {
    return refuse(409, 'text_does_not_match_decision', `The owner's message reads as "${said.meaning}", not "${parsed.decision}".`);
  }

  const identity = `${parsed.channel}:${msg.conversationId}`;
  const refSuffix = `:chat:${parsed.channel}:${msg.conversationId}:${msg.messageId}`;
  const ref = `${OWNER_REQUEST_REF_PREFIX}${requestId}${refSuffix}`;

  return transaction(() => {
    const row = queryOne<Row>('SELECT * FROM approval_requests WHERE request_id = ? AND tenant_id = ?', [requestId, ctx.tenantId])!;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // One message answers one request.
    const used = queryOne<{ source_message_ref: string }>(
      'SELECT source_message_ref FROM launch_approvals WHERE tenant_id = ? AND source_message_ref LIKE ?',
      [ctx.tenantId, `${OWNER_REQUEST_REF_PREFIX}%${refSuffix}`],
    );
    if (used && used.source_message_ref !== ref) return refuse(409, 'message_already_used', 'That message already answered a different approval request.');

    // Idempotent repeat: same decision already recorded.
    if (row.status === 'approved' && parsed.decision === 'approve') {
      return { status: 200, payload: { ...toRequest(row, nowMs), approval_id: row.approval_id, replayed: true } };
    }
    if (row.status !== 'pending') return refuse(409, 'request_not_pending', `This request is already ${row.status}.`);
    if (Date.parse(row.expires_at) <= nowMs) return refuse(409, 'request_expired', 'This request has expired. Ask your assistant to send a new one.');

    // 6: bound to THIS request.
    const pendingIds = queryAll<{ request_id: string }>(
      `SELECT request_id FROM approval_requests WHERE tenant_id = ? AND status = 'pending' AND expires_at > ?`,
      [ctx.tenantId, nowIso],
    ).map((r) => r.request_id);
    const bound = bind(row, msg, said.callbackFor, pendingIds);
    if (!bound.ok) return bound.res;

    const note = parsed.note || msg.text.slice(0, 2000);
    if (parsed.decision === 'changes') {
      run(
        `UPDATE approval_requests SET status = 'changes_requested', decided_at = ?, decided_by = ?, decision_note = ?
          WHERE request_id = ? AND status = 'pending'`,
        [nowIso, identity, note, requestId],
      );
    } else {
      const approvalId = randomUUID();
      const digest = PLAN_HASH_RE.exec(row.plan_sha256)![1].toLowerCase();
      const scope = JSON.stringify({ location_id: row.location_id, action: row.action, object_key: row.object_key });
      run(
        `INSERT INTO launch_approvals (approval_id, tenant_id, client_identity_ref, kind, plan_hash, scope,
           cap_minor, currency, expires_at, revoked, source_message_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, ?, ?)`,
        [approvalId, ctx.tenantId, identity, row.kind, `sha256:${digest}`, scope, approvalExpiry(row, nowMs), ref, nowIso],
      );
      run(
        `UPDATE approval_requests SET status = 'approved', decided_at = ?, decided_by = ?, decision_note = ?, approval_id = ?
          WHERE request_id = ? AND status = 'pending'`,
        [nowIso, identity, note, approvalId, requestId],
      );
    }
    const updated = queryOne<Row>('SELECT * FROM approval_requests WHERE request_id = ?', [requestId])!;
    return { status: 200, payload: { ...toRequest(updated, nowMs) } };
  });
}
