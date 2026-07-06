/**
 * Shared owner-notification helpers.
 *
 * notifyTelegram() was previously embedded in sop-auto-replace.ts.  It is
 * extracted here so any module (qc-scorer, tasks PATCH route, etc.) can
 * send Telegram messages without creating a circular dependency on the SOP
 * subsystem.
 *
 * Design contract:
 *   - BEST-EFFORT: a failed send NEVER throws.  The caller gets a boolean so
 *     it can log, but it must not roll back any DB state because of it.
 *   - GATEWAY-ONLY: every send goes through `openclaw message send` (the
 *     OpenClaw gateway). Direct HTTP to api.telegram.org is FORBIDDEN — the
 *     same rule every onboarding-repo script follows.
 *   - Gate: set OWNER_NOTIFY_TELEGRAM_DISABLED=1 to suppress all sends (used
 *     in unit tests and CI environments without openclaw installed).
 *   - Chat-ID resolution mirrors the fleet's authoritative resolver
 *     (openclaw-onboarding/shared-utils/resolve-owner-chat.sh):
 *       S0  OPENCLAW_OWNER_CHAT_ID env (operator-rejected)
 *       S1  openclaw.json → channels.telegram.allowFrom   (first non-operator)
 *       S1b openclaw.json → commands.ownerAllowFrom       (first non-operator)
 *       S2  <workspace>/agents/main/sessions/sessions.json direct-session keys
 *     Every source rejects the known OPERATOR chat ids so a client box can
 *     never notify an operator DM as if it were the owner.
 *   - SECRETS: openclaw.json contains a bot token. This module reads the file
 *     to extract allowFrom lists ONLY and never logs or returns any other
 *     field. Never print parsed config contents.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The known OPERATOR chat IDs — never returned as a client owner target.
 * MUST stay in sync with openclaw-onboarding:
 *   install.sh, shared-utils/resolve-owner-chat.sh,
 *   shared-utils/nudge-incomplete-interviews.py,
 *   tests/unit/cron-owner-chat-guard.test.sh
 */
const OPERATOR_CHAT_IDS = new Set(['5252140759', '6663821679', '6771245262']);

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the live OpenClaw workspace dir the same way the Skill-23 scripts do:
 * env override (OPENCLAW_WORKSPACE_PATH — this module's historical name — then
 * OPENCLAW_WORKSPACE_ROOT, the interview seam's name) → /data/.openclaw/workspace
 * when it EXISTS (VPS/Docker) → $HOME/.openclaw/workspace (Mac/bare install).
 * The previous hardcoded '/data/...' default silently broke every Mac box.
 */
function resolveWorkspaceBase(): string {
  const override =
    process.env.OPENCLAW_WORKSPACE_PATH || process.env.OPENCLAW_WORKSPACE_ROOT;
  if (override && override.trim()) return override.trim();
  const vps = '/data/.openclaw/workspace';
  if (safeIsDir(vps)) return vps;
  return path.join(os.homedir(), '.openclaw', 'workspace');
}

/** The openclaw.json config sits beside the workspace dir (<root>/openclaw.json). */
function resolveConfigPath(): string {
  return path.join(path.dirname(resolveWorkspaceBase()), 'openclaw.json');
}

/** Normalise + validate a candidate chat id; '' when invalid or an operator id. */
function validOwnerChatId(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).trim().replace(/^telegram:/, '').replace(/^tg:/, '');
  if (!s) return '';
  const digits = s.replace(/^-/, '');
  if (!/^\d{6,20}$/.test(digits)) return '';
  if (OPERATOR_CHAT_IDS.has(s)) return '';
  return s;
}

/** First non-operator id from an allowFrom-style list (string | array). */
function firstOwnerFromList(list: unknown): string {
  const entries = Array.isArray(list) ? list : list != null ? [list] : [];
  for (const entry of entries) {
    const id = validOwnerChatId(entry as string | number);
    if (id) return id;
  }
  return '';
}

/** S1/S1b — read allowFrom lists from openclaw.json. Never logs file contents. */
function resolveFromConfig(): string | null {
  try {
    const raw = fs.readFileSync(resolveConfigPath(), 'utf8');
    const cfg = JSON.parse(raw) as Record<string, any>;
    const allowFrom = cfg?.channels?.telegram?.allowFrom;
    const fromChannel = firstOwnerFromList(allowFrom);
    if (fromChannel) return fromChannel;
    const ownerAllowFrom = cfg?.commands?.ownerAllowFrom;
    const fromCommands = firstOwnerFromList(ownerAllowFrom);
    if (fromCommands) return fromCommands;
    return null;
  } catch {
    return null;
  }
}

/** S2 — legacy fallback: paired direct sessions in the sessions file. */
function resolveFromSessions(): string | null {
  const sessionsPath = path.join(
    resolveWorkspaceBase(),
    'agents/main/sessions/sessions.json',
  );
  try {
    const raw = fs.readFileSync(sessionsPath, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(data).filter((k) =>
      k.startsWith('agent:main:telegram:direct:'),
    );
    // Only a non-operator (client) ID may resolve as the owner. The previous
    // "fall back to any direct session" branch could return an OPERATOR id on
    // a box where only the operator had DM'd the bot — doctrine forbids that.
    for (const k of keys) {
      const id = validOwnerChatId(k.split(':').pop());
      if (id) return id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the owner (client) Telegram chat ID.
 *
 * Returns null when no source yields a valid, non-operator chat id.
 */
export function resolveOwnerChatId(): string | null {
  // S0 — explicit env pin (operator-rejected like every other source).
  const pinned = validOwnerChatId(process.env.OPENCLAW_OWNER_CHAT_ID ?? '');
  if (pinned) return pinned;

  // S1/S1b — openclaw.json allowFrom lists (the fleet's authoritative source).
  const fromConfig = resolveFromConfig();
  if (fromConfig) return fromConfig;

  // S2 — paired direct sessions (legacy fallback).
  return resolveFromSessions();
}

/**
 * Send a Telegram message to a specific chat via `openclaw message send`.
 *
 * @returns true if the send succeeded, false otherwise (never throws).
 */
export function notifyTelegram(opts: {
  chatId: string;
  message: string;
}): boolean {
  if (process.env.OWNER_NOTIFY_TELEGRAM_DISABLED === '1') {
    return false;
  }
  try {
    execFileSync(
      'openclaw',
      [
        'message',
        'send',
        '--channel',
        'telegram',
        // `--target` / `--message` are the real CLI flags (openclaw 2026.x).
        // The previous `--to` / `--text` flags do not exist — commander
        // rejected them, so every owner send silently failed.
        '--target',
        opts.chatId,
        '--message',
        opts.message,
      ],
      { stdio: 'pipe', timeout: 10_000 },
    );
    return true;
  } catch (err) {
    console.error(
      '[notify] Telegram send failed (chatId=%s): %s',
      opts.chatId,
      (err as Error).message,
    );
    return false;
  }
}

/**
 * Convenience: resolve the owner chat ID then send.
 *
 * Logs a warning (does NOT throw) when chat ID is unavailable.
 *
 * @returns true if sent, false if chat ID missing or send failed.
 */
export function notifyOwner(message: string): boolean {
  const chatId = resolveOwnerChatId();
  if (!chatId) {
    console.warn(
      '[notify] notifyOwner: no owner chat ID found in sessions — skipping Telegram',
    );
    return false;
  }
  return notifyTelegram({ chatId, message });
}
