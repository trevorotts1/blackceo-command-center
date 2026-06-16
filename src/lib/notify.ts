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
 *   - Gate: set OWNER_NOTIFY_TELEGRAM_DISABLED=1 to suppress all sends (used
 *     in unit tests and CI environments without openclaw installed).
 *   - Chat-ID resolution: reads the OpenClaw sessions file at
 *     <OPENCLAW_WORKSPACE_PATH>/agents/main/sessions/sessions.json for
 *     `agent:main:telegram:direct:<id>` keys.  Skips Trevor's operator ID
 *     (5252140759) to find the client's own chat ID.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const WORKSPACE_BASE =
  process.env.OPENCLAW_WORKSPACE_PATH || '/data/.openclaw/workspace';

// Trevor's known operator ID — skip when looking for the *client* chat ID.
const TREVOR_OPERATOR_ID = '5252140759';

/**
 * Resolve the owner (client) Telegram chat ID from the OpenClaw sessions file.
 *
 * Returns null if the file is missing, unreadable, or contains no paired
 * non-operator direct session.
 */
export function resolveOwnerChatId(): string | null {
  const sessionsPath = path.join(
    WORKSPACE_BASE,
    'agents/main/sessions/sessions.json',
  );
  try {
    let raw = '';
    if (fs.existsSync(sessionsPath)) {
      raw = fs.readFileSync(sessionsPath, 'utf8');
    } else {
      raw = execFileSync('cat', [sessionsPath], {
        encoding: 'utf8',
        timeout: 5_000,
      });
    }
    const data = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(data).filter((k) =>
      k.startsWith('agent:main:telegram:direct:'),
    );
    // Prefer a non-operator (client) ID; fall back to any direct session.
    for (const k of keys) {
      const id = k.split(':').pop();
      if (id && id !== TREVOR_OPERATOR_ID) return id;
    }
    return keys[0]?.split(':').pop() ?? null;
  } catch {
    return null;
  }
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
        '--to',
        opts.chatId,
        '--text',
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
