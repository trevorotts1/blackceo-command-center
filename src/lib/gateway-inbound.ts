/**
 * gateway-inbound.ts — READ-ONLY view of what the OpenClaw gateway itself
 * recorded as received from a chat.
 *
 * WHY. A chat approval is only worth something if Command Center can see the
 * owner's message WITHOUT trusting the agent that relays it. The gateway writes
 * every inbound Telegram message to its own state database before the agent
 * sees it; webchat turns are written to the session transcript. This module
 * opens those stores read-only and returns a normalised record. It never
 * writes, never takes a lock the gateway would wait on, and returns null (never
 * a guess) when the store, the row or the shape is not what it expects.
 *
 * TELEGRAM. `<state>/openclaw.sqlite`, table `plugin_state_entries`,
 * plugin_id `telegram`, namespace `telegram.message-cache`, entry_key
 * `<botHash>:<account>:<chatId>:<messageId>`, value_json
 * `{sourceMessage:{message_id,from:{id,is_bot},chat:{id},date(sec),text,
 * reply_to_message?:{message_id,from,text}}, botUserId, ...}`.
 * (Schema read from an OpenClaw 2026.11 gateway state database.)
 *
 * WEBCHAT. `<openclaw root>/agents/<agent>/sessions/<sessionId>.jsonl`, one JSON
 * object per line: `{type:'message', id, timestamp, message:{role,content}}`.
 * NOT verified against a live 2026.11 gateway (this repo has no fixture of it);
 * the reader fails closed (null) on anything it cannot parse.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { detectPlatform } from '@/lib/platform';

export interface InboundMessage {
  channel: 'telegram' | 'webchat';
  /** Telegram chat id, or webchat session id. */
  conversationId: string;
  messageId: string;
  senderId: string;
  senderIsBot: boolean;
  /** The gateway's own bot user id when recorded, else null. */
  botUserId: string | null;
  sentAtMs: number;
  text: string;
  replyTo: { messageId: string; senderIsBot: boolean; text: string } | null;
}

/** Directory that holds openclaw.sqlite. */
export function gatewayStateDir(): string {
  const env = process.env.OPENCLAW_STATE_DIR?.trim();
  if (env) {
    return fs.existsSync(path.join(env, 'openclaw.sqlite')) || !fs.existsSync(path.join(env, 'state', 'openclaw.sqlite'))
      ? env
      : path.join(env, 'state');
  }
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const root = detectPlatform() === 'vps-docker' ? '/data/.openclaw' : path.join(home, '.openclaw');
  return path.join(root, 'state');
}

function agentsDir(): string {
  const env = process.env.OPENCLAW_AGENTS_DIR?.trim();
  if (env) return env;
  const state = gatewayStateDir();
  return path.join(path.basename(state) === 'state' ? path.dirname(state) : state, 'agents');
}

const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

export type ReadResult = { ok: true; message: InboundMessage } | { ok: false; reason: 'store_unavailable' | 'message_not_found' | 'malformed' };

/** One Telegram message by chat id + message id, from the gateway's message cache. */
export function readTelegramInbound(chatId: string, messageId: string): ReadResult {
  if (!/^-?\d{1,20}$/.test(chatId) || !/^\d{1,20}$/.test(messageId)) return { ok: false, reason: 'malformed' };
  const file = path.join(gatewayStateDir(), 'openclaw.sqlite');
  if (!fs.existsSync(file)) return { ok: false, reason: 'store_unavailable' };
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 2000 });
    const rows = db
      .prepare(
        `SELECT entry_key, value_json FROM plugin_state_entries
          WHERE plugin_id = 'telegram' AND namespace = 'telegram.message-cache'
            AND entry_key LIKE ?`,
      )
      .all(`%:${chatId}:${messageId}`) as Array<{ entry_key: string; value_json: string }>;
    for (const row of rows) {
      const parts = row.entry_key.split(':');
      if (parts.length < 4 || parts[parts.length - 1] !== messageId || parts[parts.length - 2] !== chatId) continue;
      let v: any;
      try { v = JSON.parse(row.value_json); } catch { continue; }
      const m = v?.sourceMessage;
      const senderId = str(m?.from?.id);
      const chat = str(m?.chat?.id);
      const date = typeof m?.date === 'number' ? m.date : NaN;
      if (!m || !senderId || chat !== chatId || str(m.message_id) !== messageId || !Number.isFinite(date)) continue;
      const rt = m.reply_to_message;
      return {
        ok: true,
        message: {
          channel: 'telegram', conversationId: chatId, messageId, senderId,
          senderIsBot: m.from?.is_bot === true, botUserId: str(v.botUserId),
          sentAtMs: date * 1000,
          text: typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '',
          replyTo: rt && str(rt.message_id)
            ? { messageId: String(rt.message_id), senderIsBot: rt.from?.is_bot === true, text: typeof rt.text === 'string' ? rt.text : '' }
            : null,
        },
      };
    }
    return { ok: false, reason: 'message_not_found' };
  } catch {
    return { ok: false, reason: 'store_unavailable' };
  } finally {
    try { db?.close(); } catch { /* read-only handle */ }
  }
}

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;

/** One webchat user turn by session id + entry id, from the session transcript. */
export function readWebchatInbound(sessionId: string, messageId: string): ReadResult {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId.includes('..') || !/^[A-Za-z0-9._:-]{1,120}$/.test(messageId)) {
    return { ok: false, reason: 'malformed' };
  }
  const base = agentsDir();
  if (!fs.existsSync(base)) return { ok: false, reason: 'store_unavailable' };
  let agents: string[];
  try { agents = fs.readdirSync(base); } catch { return { ok: false, reason: 'store_unavailable' }; }
  for (const agent of agents) {
    const file = path.join(base, agent, 'sessions', `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, reason: 'store_unavailable' }; }
    for (const line of raw.split('\n')) {
      if (!line.includes(messageId)) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (o?.type !== 'message' || str(o.id) !== messageId) continue;
      const role = o.message?.role;
      const ts = Date.parse(String(o.timestamp ?? o.message?.timestamp ?? ''));
      const content = o.message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n') : '';
      // A turn the gateway routed in from another channel (Telegram, SMS, ...)
      // is not a webchat message from the owner's own window.
      const viaOther = [o.channel, o.message?.channel, o.provenance?.channel, o.message?.provenance?.channel]
        .some((c) => typeof c === 'string' && c && c !== 'webchat' && c !== 'control-ui');
      if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed' };
      return {
        ok: true,
        message: {
          channel: 'webchat', conversationId: sessionId, messageId,
          senderId: viaOther ? 'other-channel' : role === 'user' ? `webchat:${sessionId}` : String(role ?? 'unknown'),
          senderIsBot: role !== 'user' || viaOther,
          botUserId: null, sentAtMs: ts, text, replyTo: null,
        },
      };
    }
  }
  return { ok: false, reason: 'message_not_found' };
}
