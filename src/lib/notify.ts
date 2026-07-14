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
 *   - SAFETY-01 / TEST-SAFE BY DEFAULT: sends are ALSO refused whenever we are
 *     inside a test runner (node:test / vitest / jest), with NO env var needed.
 *     A test can therefore never reach a real phone even if it forgets the gate
 *     above — see isTestEnvironment(). Opt back in only via the explicit
 *     OWNER_NOTIFY_ALLOW_SEND_IN_TEST=1.
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

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Owner-send timeout (MSG-01). Bounds the detached child so a truly hung
 * gateway can never pin it forever; the send is fire-and-forget, so this
 * never blocks the request/event loop regardless of its value.
 *
 * FLEET-WIDE BUG (fixed): this was previously 5_000ms. A real
 * `openclaw message send` measured ~6.2s end to end (6.19s / 6.38s, both
 * exit 0), so the old 5s ceiling SIGTERM-killed EVERY owner send about 1.2s
 * before completion — every client Command Center silently failed to notify
 * its owner. Failure signature: "Command failed: openclaw message send" with
 * EMPTY stderr (a timeout kill, not ENOENT). Raised to 30s: comfortably
 * clears the observed ~6.2s send while still bounding a genuinely hung CLI.
 *
 * Overridable via OWNER_SEND_TIMEOUT_MS (ms) for boxes with a slower gateway
 * round-trip, consistent with the other env-tunable knobs in this module
 * (OPENCLAW_OWNER_CHAT_ID, CC_OPERATOR_CHAT_ID, etc). Falls back to the 30s
 * default on anything non-numeric or <= 0.
 */
const DEFAULT_OWNER_SEND_TIMEOUT_MS = 30_000;
function resolveOwnerSendTimeoutMs(): number {
  const raw = process.env.OWNER_SEND_TIMEOUT_MS;
  if (!raw) return DEFAULT_OWNER_SEND_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OWNER_SEND_TIMEOUT_MS;
}
const OWNER_SEND_TIMEOUT_MS = resolveOwnerSendTimeoutMs();

/**
 * ── SAFETY-01: A TEST MUST NEVER REACH A HUMAN'S PHONE ───────────────────────
 *
 * `notifyTelegram()` execFile()s the real `openclaw message send`. Its ONLY
 * guard used to be an opt-IN env var (OWNER_NOTIFY_TELEGRAM_DISABLED=1) that
 * each test file had to remember to set at module scope. That is a convention,
 * not a guarantee — and the convention failed: a test fixture drove tasks
 * through the QC scorer (which calls notifyOwner/notifyOwnerDone on promote to
 * done/blocked) WITHOUT setting the var, so every run of the unit suite
 * delivered live Telegram messages to a real person.
 *
 * The defect was never "one file forgot the flag" — it was that a test COULD
 * send at all. The env var is opt-in, so the SAFE state depended on authors
 * remembering it; the failure mode of forgetting was spamming a human.
 *
 * This inverts that: sends are refused whenever we are demonstrably inside a
 * test runner, regardless of any env var. Detection is by runner-injected
 * signals, so it needs no cooperation from test authors and cannot be
 * defeated by a new test file that forgets the convention.
 *
 *   NODE_TEST_CONTEXT  node:test — set to "child-v8"/"child" in EVERY test
 *                      child process. This is the runner this repo's
 *                      `npm run test:unit` actually uses. VERIFIED empirically;
 *                      note NODE_ENV is *undefined* under it, so a NODE_ENV
 *                      check alone would have caught none of the unit suite.
 *   VITEST             vitest (test:vitest / test:component / deep-health).
 *   JEST_WORKER_ID     jest — defensive; not used here today.
 *   NODE_ENV === test  generic convention; last, not first.
 *
 * FAIL-SAFE DIRECTION: a false positive costs one un-sent best-effort
 * notification (the module contract already permits a dropped send). A false
 * negative spams a real human. We bias hard toward refusing.
 *
 * ESCAPE HATCH: OWNER_NOTIFY_ALLOW_SEND_IN_TEST=1 lets a test deliberately
 * exercise the dispatch path (against a stub binary on PATH — see
 * tests/unit/notify-no-send-in-tests.test.ts). It must be set EXPLICITLY, so a
 * real send can only ever happen on purpose, never by omission.
 */
export function isTestEnvironment(): boolean {
  return Boolean(
    process.env.NODE_TEST_CONTEXT ||
      process.env.VITEST ||
      process.env.JEST_WORKER_ID ||
      process.env.NODE_ENV === 'test',
  );
}

/**
 * True when owner Telegram sends must be suppressed: either the explicit
 * operator/CI mute, or we are inside a test runner without the deliberate
 * opt-in. Single source for both gate sites (notifyTelegram + notifyOwner).
 */
export function ownerSendsSuppressed(): boolean {
  if (process.env.OWNER_NOTIFY_TELEGRAM_DISABLED === '1') return true;
  if (isTestEnvironment() && process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST !== '1') {
    return true;
  }
  return false;
}

/**
 * The known OPERATOR chat IDs — never returned as a client owner target.
 *
 * MSG-03 — SINGLE SOURCE: the authoritative set is read from the
 * OPERATOR_CHAT_IDS env (comma/space/newline-separated) that the installer
 * writes, so all three repos consume ONE list instead of hand-maintained
 * divergent copies. The hardcoded list below is only the fail-safe default
 * when that env is unset; it MUST stay in sync with openclaw-onboarding:
 *   install.sh, shared-utils/resolve-owner-chat.sh,
 *   shared-utils/nudge-incomplete-interviews.py,
 *   tests/unit/cron-owner-chat-guard.test.sh
 * Long-term single-source guard: an `openclaw doctor` diff of this resolver
 * against the onboarding resolver (cross-repo — see MSG-03 in the fix spec).
 */
const DEFAULT_OPERATOR_CHAT_IDS = ['5252140759', '6663821679', '6771245262'];

/**
 * Resolve the operator chat-id set from OPERATOR_CHAT_IDS env, falling back to
 * the built-in default. The fallback is intentional and fail-SAFE: an unset or
 * malformed env must never SHRINK the operator set (that would let an operator
 * id resolve as a client owner — the exact leak this list prevents).
 */
function loadOperatorChatIds(): Set<string> {
  const ids = (process.env.OPERATOR_CHAT_IDS ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{6,20}$/.test(s));
  // Always UNION the built-in defaults so an env list can only ADD operator
  // ids to reject, never drop a known one.
  return new Set([...DEFAULT_OPERATOR_CHAT_IDS, ...ids]);
}

const OPERATOR_CHAT_IDS = loadOperatorChatIds();

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

/** Normalise a candidate chat id to its bare digits; '' when malformed. */
function normalizeChatId(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).trim().replace(/^telegram:/, '').replace(/^tg:/, '');
  if (!s) return '';
  const digits = s.replace(/^-/, '');
  if (!/^\d{6,20}$/.test(digits)) return '';
  return s;
}

/** Normalise + validate a candidate chat id; '' when invalid or an operator id. */
function validOwnerChatId(v: unknown): string {
  const s = normalizeChatId(v);
  if (!s) return '';
  if (OPERATOR_CHAT_IDS.has(s)) return ''; // client-protection guardrail — UNCHANGED
  return s;
}

/**
 * The INVERSE guard (MSG-07) — the seam that makes the OPERATOR loud without
 * making CLIENTS loud.
 *
 * `validOwnerChatId` rejects OPERATOR ids so an agent can never DM an operator
 * as if they were the client owner. This is its mirror image: a SYSTEM/operator
 * alert target is valid ONLY IF the id IS a known operator id. A client id can
 * therefore NEVER be returned here, which makes it *structurally impossible* for
 * a SYSTEM alert (dispatch failure, block, undeliverable notification) to land in
 * a client's Telegram — MOVE-IN-SILENCE holds by construction, not by convention.
 *
 * Together the two guards partition the chat-id space:
 *   validOwnerChatId    → clients only   (operator ids rejected)
 *   validOperatorChatId → operators only (client ids rejected)
 * Neither can ever leak into the other's channel.
 */
function validOperatorChatId(v: unknown): string {
  const s = normalizeChatId(v);
  if (!s) return '';
  if (!OPERATOR_CHAT_IDS.has(s)) return ''; // a client id is NEVER a system target
  return s;
}

/** First OPERATOR id from an allowFrom-style list (string | array). */
function firstOperatorFromList(list: unknown): string {
  const entries = Array.isArray(list) ? list : list != null ? [list] : [];
  for (const entry of entries) {
    const id = validOperatorChatId(entry as string | number);
    if (id) return id;
  }
  return '';
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
 * Resolve the OPERATOR Telegram chat ID for SYSTEM-audience alerts (MSG-07).
 *
 * ── WHY THIS EXISTS: the operator's own board was structurally MUTE ──────────
 * `resolveOwnerChatId()` rejects operator ids at EVERY source — correctly, so a
 * client box can never DM an operator as if they were the client. But on the
 * OPERATOR's own box, `channels.telegram.allowFrom` contains ONLY operator ids
 * (there is no client on that box). So every source rejected every candidate and
 * `resolveOwnerChatId()` returned null — forever. `notifyOwner()` then hit its
 * `console.warn` and dropped the message on the floor. The live error log carried
 * 501 of those drops, including the operator's own blocked-task notification.
 *
 * The rail built to stop operators spamming clients had made the operator's own
 * board silent. This resolver is the seam: it targets the OPERATOR deliberately,
 * through the `validOperatorChatId` INVERSE guard, so it can only ever return an
 * operator id — never a client's. The client-spam guardrail is untouched.
 *
 * Sources (each passes through the inverse guard):
 *   S0  CC_OPERATOR_CHAT_ID / OPENCLAW_OPERATOR_CHAT_ID env (explicit pin)
 *   S1  openclaw.json → channels.telegram.allowFrom  (first OPERATOR entry)
 *   S1b openclaw.json → commands.ownerAllowFrom      (first OPERATOR entry)
 *
 * Returns null when no operator id is resolvable (e.g. a client box that lists no
 * operator in allowFrom) — in which case SYSTEM alerts fall through to the
 * durable record instead, and still never reach the client.
 */
export function resolveOperatorChatId(): string | null {
  const pinned =
    validOperatorChatId(process.env.CC_OPERATOR_CHAT_ID ?? '') ||
    validOperatorChatId(process.env.OPENCLAW_OPERATOR_CHAT_ID ?? '');
  if (pinned) return pinned;

  try {
    const raw = fs.readFileSync(resolveConfigPath(), 'utf8');
    const cfg = JSON.parse(raw) as Record<string, any>;
    const fromChannel = firstOperatorFromList(cfg?.channels?.telegram?.allowFrom);
    if (fromChannel) return fromChannel;
    const fromCommands = firstOperatorFromList(cfg?.commands?.ownerAllowFrom);
    if (fromCommands) return fromCommands;
    return null;
  } catch {
    return null;
  }
}

/**
 * The durable, always-on record of a notification that could NOT be delivered
 * (MSG-07). This is the last rung of the escalation ladder: even with no webhook
 * and no reachable operator chat, a dropped alert must leave a trace a human can
 * find. Failing to notify is itself an alarm — never a `console.warn`.
 *
 * Written as append-only JSONL beside the workspace, and mirrored to
 * console.ERROR (not warn) with a greppable tag. Never throws.
 */
export function recordUndeliverable(kind: string, message: string): void {
  const line = {
    ts: new Date().toISOString(),
    kind,
    message,
    // Deliberately NO chat ids — this file is diagnostic, not a contact list.
  };
  // LOUD: error-level, distinctive tag. This is the string to alert on.
  console.error('[notify][UNDELIVERABLE] %s — %s', kind, message);
  try {
    const dir = resolveWorkspaceBase();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'notification-failures.jsonl'),
      `${JSON.stringify(line)}\n`,
      'utf8',
    );
  } catch {
    /* durable record is best-effort — the console.error above already fired */
  }
}

/**
 * Send a Telegram message to a specific chat via `openclaw message send`.
 *
 * MSG-01: this is FIRE-AND-FORGET. The send is dispatched with async
 * `execFile` and NOT awaited, so a slow or hung gateway can never block the
 * Node event loop — a burst of DONE reports no longer serializes into 10s
 * stalls (P32/P39). Send errors are swallowed by the internal callback: the
 * module contract is BEST-EFFORT and callers must never roll back DB state on
 * a failed send.
 *
 * @returns true when a send was DISPATCHED to the gateway (chat present, not
 *   disabled); false when suppressed. Because the send is not awaited, `true`
 *   means "attempted", not "confirmed delivered" — consistent with the
 *   best-effort contract (even the previous sync path only confirmed the CLI
 *   exit, never actual Telegram delivery). Never throws.
 */
export function notifyTelegram(opts: {
  chatId: string;
  message: string;
}): boolean {
  // SAFETY-01: refuses on the explicit mute AND inside any test runner. This is
  // the SINGLE choke point for every Telegram send in this module (notifyOwner,
  // notifyOwnerDone and notifySystem all funnel through here), so guarding it
  // guarantees no code path in a test can reach a real phone.
  if (ownerSendsSuppressed()) {
    return false;
  }
  execFile(
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
    { timeout: OWNER_SEND_TIMEOUT_MS },
    (err) => {
      if (err) {
        console.error(
          '[notify] Telegram send failed (chatId=%s): %s',
          opts.chatId,
          err.message,
        );
      }
    },
  );
  return true;
}

/**
 * Convenience: resolve the owner chat ID then send.
 *
 * Logs a warning (does NOT throw) when chat ID is unavailable.
 *
 * @returns true if sent, false if chat ID missing or send failed.
 */
export function notifyOwner(message: string): boolean {
  // An explicit mute (CI, unit tests) is a DELIBERATE suppression, not a failed
  // delivery — it must not raise an alarm or write an undeliverable record.
  // Only a genuine inability to deliver escalates.
  // NOTE (SAFETY-01): deliberately gated on the ENV VAR ONLY — NOT on
  // ownerSendsSuppressed(). The test-runner refusal belongs at the single point
  // that actually spawns the CLI (notifyTelegram). Short-circuiting HERE would
  // also skip the MSG-07 undeliverable-escalation below, which is a LOCAL side
  // effect (a durable record + an operator-only notifySystem alarm), not a
  // phone send — and which MSG-07's tests legitimately exercise. Leaving this
  // path intact costs nothing: its escalation funnels into notifyTelegram,
  // where the test-runner hard-refuse stops the actual send.
  if (process.env.OWNER_NOTIFY_TELEGRAM_DISABLED === '1') return false;

  const chatId = resolveOwnerChatId();
  if (!chatId) {
    // ── MSG-07: NEVER SILENTLY DROP ─────────────────────────────────────────
    // This was a `console.warn` + `return false`. Every automated caller
    // (task-dispatcher, qc-scorer ×2, all 5 owner-reports helpers) throws that
    // boolean away, so an undeliverable alert simply ceased to exist — 501 of
    // them in the live error log, including a blocked-task notification the
    // operator never saw.
    //
    // Failing to notify is itself an alarm. Escalate to the SYSTEM channel,
    // which is operator-only by construction (validOperatorChatId) and so can
    // never turn this into client spam. Fixing it HERE — at the source — repairs
    // every automated caller at once, rather than at eight call sites.
    notifySystem(`UNDELIVERABLE owner notification (no owner chat resolvable): ${message}`, {
      agent: 'notify',
      action: 'escalate',
    });
    // Still `false`: callers that DO check (e.g. interview/send-link) must keep
    // reporting "owner not reachable" to the user. The escalation is additive.
    return false;
  }
  const dispatched = notifyTelegram({ chatId, message });
  if (!dispatched) {
    // Suppressed (test/CI gate) or not dispatched — record it rather than lose it.
    notifySystem(`UNDELIVERABLE owner notification (gateway send not dispatched): ${message}`, {
      agent: 'notify',
      action: 'escalate',
    });
  }
  return dispatched;
}

/** Notification audience. SYSTEM alerts are operator concerns and must NEVER
 *  reach a client Telegram (MOVE-IN-SILENCE). */
export type NotifyAudience = 'OWNER' | 'SYSTEM';

/**
 * MSG-06 / SWEEP-06 — the SYSTEM (operator) notification channel.
 *
 * SYSTEM-audience alerts (dispatch-block-at-cap, silent-failure escalations,
 * stuck-in-progress) are an OPERATOR concern and must NEVER reach the client
 * owner DM (MOVE-IN-SILENCE). This routes them to the Rescue Rangers
 * escalation webhook when configured; otherwise it logs server-side and DROPS
 * the message. It deliberately does NOT fall back to notifyOwner() — that is
 * the client's chat, and a SYSTEM alert there is the breach SWEEP-06 fixes.
 *
 * Fire-and-forget (does not await the POST); never throws.
 *
 * Cross-lane consumers (see fix-spec SWEEP-06 / MSG-06 — wired by the integrator):
 *   • task-dispatcher.ts recordDispatchFailure(): calls notifySystem() instead
 *     of notifyOwner() when `audience === 'SYSTEM'`.
 *   • jobs/stuck-in-progress-sweep.ts + jobs/stale-task-sweep.ts: route their
 *     operator escalations through notifySystem() (via notifyByAudience below).
 *
 * @returns true when dispatched to the rescue webhook; false when no webhook
 *   is configured (the alert is logged and dropped — never sent to the client).
 */
export function notifySystem(
  message: string,
  meta?: { agent?: string; action?: string },
): boolean {
  let dispatched = false;

  // ── RUNG 1: Rescue Rangers escalation webhook (when configured). ───────────
  const webhookUrl = process.env.RESCUE_RANGERS_WEBHOOK_URL;
  if (webhookUrl) {
    // Fire-and-forget: do not await; swallow any error (best-effort, never throws).
    void fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: meta?.action ?? 'escalate',
        agent: meta?.agent ?? 'command-center',
        message,
      }),
    }).catch((err) => {
      console.warn(
        '[notify] notifySystem: Rescue Rangers POST failed: %s',
        (err as Error).message,
      );
    });
    dispatched = true;
  }

  // ── RUNG 2: the OPERATOR's Telegram (MSG-07). ─────────────────────────────
  // This is what un-mutes the operator's own box. `resolveOperatorChatId()` runs
  // every candidate through the INVERSE guard, so the target here is ALWAYS a
  // known operator id and NEVER a client's — a SYSTEM alert cannot become client
  // spam even in principle. Gateway-only (`openclaw message send`), never a
  // direct call to api.telegram.org.
  const operatorChatId = resolveOperatorChatId();
  if (operatorChatId) {
    if (notifyTelegram({ chatId: operatorChatId, message })) dispatched = true;
  }

  // ── RUNG 3: the durable record. ALWAYS, when nothing above got through. ────
  // A SYSTEM alert must never evaporate. The old code hit a `console.warn` and
  // dropped it; that is how 501 notifications disappeared without a trace.
  if (!dispatched) {
    recordUndeliverable('system_alert', message);
  }
  return dispatched;
}

/**
 * Audience-gated notification (SWEEP-06 / MOVE-IN-SILENCE).
 *
 *   - 'OWNER'  → the client's own Telegram (their board is theirs to see).
 *   - 'SYSTEM' → the OPERATOR only, via notifySystem() (single source): routed
 *                to RESCUE_RANGERS_WEBHOOK_URL, or logged + dropped when unset.
 *                It is NEVER sent to the client Telegram.
 *
 * A dispatch-failure / block / stuck-agent alert is a SYSTEM (operator) concern:
 * callers such as `recordDispatchFailure` and the stuck-in-progress sweep pass
 * 'SYSTEM' so those alerts can never spam a client Telegram. Only a genuine
 * owner-facing message passes 'OWNER'.
 *
 * Reconciliation note (integrator): L2 introduced this audience wrapper and L9
 * introduced notifySystem(); the SYSTEM branch now delegates to notifySystem()
 * so there is exactly ONE Rescue Rangers webhook code path.
 *
 * Best-effort: never throws. Returns true when a notification was dispatched.
 */
export async function notifyByAudience(opts: {
  audience: NotifyAudience;
  message: string;
}): Promise<boolean> {
  if (opts.audience === 'OWNER') {
    return notifyOwner(opts.message);
  }
  // SYSTEM: single source of truth — operator channel only, never the client.
  return notifySystem(opts.message);
}
