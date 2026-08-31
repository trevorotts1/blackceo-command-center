/**
 * P1-04 — THE TRUST ENGINE / REPORT-BACK LOOP (#1 client complaint).
 *
 * A client asks their AI CEO for something, it is routed to a department, and
 * then SILENCE — no "it was assigned", no progress/ETA, no completion notice.
 * Clients don't trust the system because it never reports back. This engine
 * closes that loop with the three-message contract from the directive:
 *
 *   1. ACK       — "Got it — '<title>' was assigned to the <dept> department."
 *   2. PROGRESS  — "'<title>' is in progress with <role>. Estimated: <eta>."
 *                  (and, on a blocked-on-OWNER task, "here's what I need from you")
 *   3. DONE      — "Done: '<title>'. <summary>. Find it here: <location>."
 *
 * DESIGN — a single crash-safe SWEEP is the authority for all three messages.
 * Rather than firing sends inline from every status-transition path (which loses
 * a message if the process dies mid-transition), the engine is a self-contained
 * planner + executor driven every 2 minutes off LIVE DB state. This is exactly
 * what the crash-safety contract (P1-04 step 7) requires: "the 2-min sweep
 * re-attempts unstamped sends; duplicate-send guard is the stamp itself." A thin
 * best-effort hook on the status route also invokes runTrustEngineForTask() so a
 * transition reports back IMMEDIATELY; the sweep is the guaranteed backstop.
 * Both paths share this one code path, so they can never double-send (the stamp
 * is the single guard).
 *
 * CRASH-SAFETY — we CLAIM-then-send (transactional-outbox ordering), not
 * send-then-stamp. Each planned send first writes its `*_sent_at` stamp with an
 * `UPDATE ... WHERE <stamp> IS NULL` claim (0 rows affected => another worker
 * already took it => skip). ONLY after the claim commits do we dispatch the
 * fire-and-forget gateway send. This is the only ordering under which a crash
 * BETWEEN the two operations cannot produce a duplicate on the next sweep: the
 * durable stamp is the idempotency guard, precisely as step 7 mandates. The
 * cost — a status ping lost if the process dies in the microscopic window after
 * the stamp commits and before the async dispatch — is acceptable and self-heals
 * on the next state change. A row whose claim never committed (stamp still NULL)
 * is always re-attempted by the next 2-minute sweep.
 *
 * CLIENT-FACING BY DESIGN — this is the one deliberately client-facing feature
 * (the directive sanctions it; MOVE-IN-SILENCE governs operator internals). All
 * sends go through the box's OWN OpenClaw gateway (notify.ts notifyTelegram —
 * `openclaw message send`), NEVER a direct api.telegram.org call. A trust message
 * is only ever sent to a task's captured `requester_chat_id`; it is never routed
 * to a SYSTEM/operator audience. The done-without-deliverable QC smell is the one
 * thing that goes to the OPERATOR lane (notifySystem) — never to the client.
 */

import { queryAll, queryOne, run, transaction } from '@/lib/db';
import {
  notifyTelegram,
  notifySystem,
  recordUndeliverable,
  resolveOperatorChatId,
  resolveOwnerChatId,
} from '@/lib/notify';
import { v4 as uuidv4 } from 'uuid';
import { BACKLOG_COLUMN_SUBTITLE } from '@/lib/board-labels';
import { CEO_CHAT_CHANNEL } from '@/lib/ceo-chat/config';
import { appendTrustMessage } from '@/lib/ceo-chat/store';
import { broadcast } from '@/lib/events';
import { requiresRegisteredCertificate } from '@/lib/presentations-cert-gate';

// ── Tunables ──────────────────────────────────────────────────────────────
/** After ingest, wait up to this long for the triad to advance a task past
 *  `backlog` before we send the ACK anyway (honesty over silence). */
export const ACK_BACKLOG_GRACE_MS = 10 * 60 * 1000; // 10 minutes
/**
 * FIX 24: at most one progress message per task per this interval, EXCEPT
 * state changes (blocked/done are never throttled against it). Shipped default
 * 1h (was 12h) so a multi-hour render reports hourly without per-slide spam.
 * Env-overridable via TRUST_ENGINE_PROGRESS_MIN_INTERVAL_HOURS; a non-positive
 * or non-finite override is REJECTED (warned about) and the 1h default ships.
 */
export function resolveProgressMinIntervalHours(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const t = raw.trim();
  if (t === '') return 1;
  const parsed = Number(t);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[trust-engine] TRUST_ENGINE_PROGRESS_MIN_INTERVAL_HOURS="${raw}" is invalid (must be a positive number of hours) — using default 1h`,
    );
    return 1;
  }
  return parsed;
}
export const PROGRESS_MIN_INTERVAL_MS =
  resolveProgressMinIntervalHours(process.env.TRUST_ENGINE_PROGRESS_MIN_INTERVAL_HOURS) * 60 * 60 * 1000;
/** A blocked job re-asks at most this often. Distinct from PROGRESS_MIN_INTERVAL_MS: the
 *  point of a blocked notice is that the requester is the blocker, so a reminder is
 *  useful, not nagging. Twelve hours was the accidental inherited value; six is a
 *  deliberate one. */
export const BLOCKED_RENOTIFY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** Coalesce into ONE digest when a single chat has MORE than this many queued sends. */
export const DIGEST_THRESHOLD = 3;
/** Quiet hours (box-local): no messages 22:00–07:00 (DONE included — default hold till morning). */
export const NIGHT_START_HOUR = 22;
export const NIGHT_END_HOUR = 7;

/**
 * Coarse, conservative ETA table per department/task-type, seeded in config. An
 * honest coarse ETA beats a fabricated precise one (P1-04 step 4). Keys are
 * lower-cased department slugs/names; the DEFAULT applies to anything unlisted.
 * Refine later — the point is to never invent a precise time we can't honour.
 * A box may override any entry via TRUST_ENGINE_ETA_JSON (a JSON object).
 */
export const DEFAULT_ETA = 'within 24 hours';
const BASE_DEPARTMENT_ETA: Record<string, string> = {
  'general-task': 'within 24 hours',
  research: 'within 24 hours',
  sales: 'within 1 business day',
  'social-media': 'within 1 business day',
  marketing: 'within 2 business days',
  'web-development': 'within 2–3 business days',
  presentations: 'within 2–3 business days',
  video: 'within 3–5 business days',
};

function departmentEtaTable(): Record<string, string> {
  const raw = process.env.TRUST_ENGINE_ETA_JSON;
  if (!raw) return BASE_DEPARTMENT_ETA;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const merged: Record<string, string> = { ...BASE_DEPARTMENT_ETA };
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) merged[k.toLowerCase()] = v.trim();
    }
    return merged;
  } catch {
    return BASE_DEPARTMENT_ETA;
  }
}

export function etaForDepartment(department: string | null | undefined): string {
  if (!department) return DEFAULT_ETA;
  const table = departmentEtaTable();
  return table[department.toLowerCase()] ?? DEFAULT_ETA;
}

// ── Types ───────────────────────────────────────────────────────────────────

/** The task shape the planner reasons over (a subset of the tasks row). */
export interface TrustTaskRow {
  id: string;
  title: string;
  status: string;
  department: string | null;
  assigned_agent_name: string | null;
  created_at: string;
  requester_channel: string | null;
  requester_chat_id: string | null;
  ack_sent_at: string | null;
  progress_last_sent_at: string | null;
  completion_sent_at: string | null;
  block_audience: string | null;
  block_needs: string | null;
  blocked_notice_sent_at: string | null;
  phase_progress_sent_at: string | null;
  last_reported_phase_label: string | null;
  /** TICKET 3 (L-13): gates the DONE message for presentations/book-writer tasks. */
  process_certificate_sha: string | null;
  source: string | null;
}

/** A deliverable pointer for a completed task (from the deliverables registry). */
export interface DeliverableInfo {
  location: string;
  summary: string;
}

/** One database stamp to apply atomically as part of claiming a send. The
 *  `guardColumn` must be NULL for the claim to succeed (the idempotency guard). */
export interface StampOp {
  taskId: string;
  guardColumn: 'ack_sent_at' | 'progress_last_sent_at' | 'completion_sent_at'
             | 'blocked_notice_sent_at' | 'phase_progress_sent_at';
  /** Additional columns to set in the same claim UPDATE (eta/result columns). */
  extraSets: Record<string, string | null>;
  eventType: 'trust_ack' | 'trust_progress' | 'trust_done' | 'trust_phase_progress';
  eventMessage: string;
}

/** A planned client-facing send. `stamps` are claimed atomically before dispatch. */
export interface PlannedSend {
  chatId: string;
  channel: string;
  message: string;
  stamps: StampOp[];
  /** done-without-deliverable QC smells to escalate to the OPERATOR lane (never the client). */
  doneWithoutDeliverable: { taskId: string; title: string }[];
  /**
   * TICKET 3 (L-13 capstone fix). A DONE completion message is the exact
   * client-facing claim the L-13 shortcut deck proved can fire with no
   * mechanical check that the SOP pipeline's own postflight gate actually
   * passed. For presentations/book-writer tasks this reuses the SAME
   * process_certificate_sha invariant qc-scorer.ts already enforces on the
   * review->done DB transition (requiresRegisteredCertificate,
   * presentations-cert-gate.ts) as a SEPARATE, independent precondition on
   * the notification itself — so a task that somehow reaches status='done'
   * without a registered certificate (a future bug, a bypass, a race) still
   * cannot have its completion announced to the client. When populated, the
   * carrying PlannedSend has `stamps: []` (see executeSends: an empty
   * `stamps` array claims nothing and dispatches nothing — a structural
   * no-send, not a suppressed message body) and must be escalated to the
   * OPERATOR lane only, never retried as a client send.
   */
  heldForMissingPostflight: { taskId: string; title: string; detail: string }[];
}

export interface PlanContext {
  now: Date;
  /** Lookup a completed task's registered deliverable (null when none registered). */
  deliverableFor: (taskId: string) => DeliverableInfo | null;
  /** Chat ids that are OPERATOR/owner-internal — a trust message must NEVER target these. */
  blockedChatIds?: Set<string>;
  /** Override night-hold detection (defaults to box-local clock on `now`). */
  isNight?: boolean;
  /** Resolves a task's current phase for per-phase progress. Returns null when the task
   *  has no phase activity -- a non-pipeline task must produce NO phase messages. */
  phaseFor?: (taskId: string) => {
    label: string;        // human words, never an internal phase id
    budgetMs: number;     // this phase's budget; the silence ceiling
    doneCount: number;
    totalCount: number;
  } | null;
}

// ── Message builders ──────────────────────────────────────────────────────────

function ackMessage(task: TrustTaskRow, queuedForGrooming: boolean): string {
  if (queuedForGrooming) {
    // P2-01 step 3: same honest language the board uses for a backlog-parked
    // (now "Being Prepared") card — BACKLOG_COLUMN_SUBTITLE — so the client
    // hears the identical explanation here and on the board.
    return (
      `✅ Got it — "${task.title}" is captured and queued for grooming (being prepared). ` +
      `${BACKLOG_COLUMN_SUBTITLE}. I'll assign it to the right department shortly and keep you posted.`
    );
  }
  const dept = task.department ? `the ${task.department} department` : 'the right department';
  const who = task.assigned_agent_name ? ` (${task.assigned_agent_name})` : '';
  return `✅ Got it — "${task.title}" was assigned to ${dept}${who}. I'll update you as it moves.`;
}

function progressMessage(task: TrustTaskRow, eta: string): string {
  const who = task.assigned_agent_name ?? (task.department ? `the ${task.department} department` : 'the team');
  return `🔄 "${task.title}" is in progress with ${who}. Estimated completion: ${eta}.`;
}

function blockedMessage(task: TrustTaskRow): string {
  const needs = task.block_needs?.trim();
  const ask = needs
    ? `I need this from you to continue: ${needs}`
    : `I need a decision or some input from you before I can continue.`;
  return `⏳ "${task.title}" is paused waiting on you. ${ask}`;
}

/** Per-phase progress. Names the phase in the requester's words and says what is next.
 *  Deliberately NOT the tool trace: the operator has already received
 *  "Exec run # Check -> run python3 inline script -> print text running" from an agent
 *  asked for status, which is why this unit exists. Never emit an internal phase
 *  identifier -- pass the human label. */
function phaseProgressMessage(
  task: TrustTaskRow,
  phaseLabel: string,
  doneCount: number,
  totalCount: number,
): string {
  const of = totalCount > 0 ? ` (step ${doneCount} of ${totalCount})` : '';
  return `🔄 "${task.title}" — ${phaseLabel}${of}. I'll tell you when the next step finishes.`;
}

function doneMessage(task: TrustTaskRow, deliverable: DeliverableInfo | null): string {
  if (deliverable) {
    return `✅ Done: "${task.title}". ${deliverable.summary} Find it here: ${deliverable.location}`;
  }
  // NEVER fabricate a location. Honest completion + ask-for-details.
  return `✅ Done: "${task.title}". It's completed — ask me for details and I'll pull them up.`;
}

// ── The pure planner ─────────────────────────────────────────────────────────

/** True when the given instant falls inside the box-local quiet window. */
export function isQuietHour(now: Date): boolean {
  const h = now.getHours();
  // Window wraps midnight: [22:00, 24:00) ∪ [00:00, 07:00).
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

/**
 * Message types that are NOT held by quiet hours.
 *
 * A client waiting on a deck wants "it's ready" and "it's stuck" the moment they are
 * true; those two are the entire reason the report-back loop exists. ACK and PROGRESS
 * are courtesy updates and stay held until 07:00, because a 02:00 "it's in progress"
 * is a notification with no action behind it.
 *
 * Keyed off the task STATUS, not the message text, so the rule cannot drift from the
 * planner's own branches: 'done' -> the DONE message (planSends, the `status === 'done'`
 * branch); 'blocked' + block_audience 'OWNER' -> the BLOCKED-on-owner ask.
 *
 * COST, stated plainly: NIGHT_START_HOUR/NIGHT_END_HOUR are evaluated with
 * Date#getHours(), which is the BOX-local hour. A client in another timezone can now
 * receive a DONE or BLOCKED message during THEIR night. That is a deliberate trade:
 * a nine-hour delay on "your deck is ready" was judged worse than an off-hours ping on
 * the two messages a client is actually waiting for.
 */
export function bypassesQuietHours(task: TrustTaskRow): boolean {
  if (task.status === 'done') return true;
  if (task.status === 'blocked' && task.block_audience === 'OWNER') return true;
  return false;
}

function ageMs(now: Date, iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : now.getTime() - t;
}

/**
 * Given the candidate tasks and context, produce the list of client-facing sends
 * to make right now. Pure: no IO, no clock reads beyond `ctx.now`. This is the
 * unit under test — every P1-04 QC break-it probe exercises it directly.
 */
export function planSends(tasks: TrustTaskRow[], ctx: PlanContext): PlannedSend[] {
  const night = ctx.isNight ?? isQuietHour(ctx.now);
  // Quiet hours: hold the COURTESY messages (ACK, PROGRESS) — nothing is stamped for
  // them, so every held send is re-attempted after 07:00 by the next sweep. DONE and
  // BLOCKED-on-owner are carved out (bypassesQuietHours) because a client is waiting
  // on those two and a nine-hour hold on "your deck is ready" is the complaint this
  // engine exists to answer.
  const candidates = night ? tasks.filter(bypassesQuietHours) : tasks;
  if (candidates.length === 0) return [];

  // One send per task per sweep (whichever message is due). Grouped by chat at
  // the end so >DIGEST_THRESHOLD sends to one chat coalesce into a digest.
  const perTask: PlannedSend[] = [];

  for (const task of candidates) {
    const chatId = task.requester_chat_id;
    if (!chatId) continue; // never reported on
    // NEVER target a SYSTEM/operator-internal audience with a client trust message.
    if (ctx.blockedChatIds?.has(chatId)) continue;
    const channel = task.requester_channel || 'telegram';

    // ── Message 3 — DONE (highest priority: a finished task's client is waiting) ──
    if (task.status === 'done' && !task.completion_sent_at) {
      // TICKET 3 (L-13): mechanical postflight gate on the notification itself,
      // independent of how the task reached status='done'. currentStatus is
      // passed as a value OTHER than 'done' deliberately — the underlying
      // helper short-circuits to { applies: false } when currentStatus ===
      // targetStatus (it's built for gating a live transition, not a
      // post-hoc check), so this call asks "would THIS task, department, and
      // cert state be allowed to become done right now" rather than relying
      // on a transition that has, by definition, already happened.
      const certGate = requiresRegisteredCertificate({
        department: task.department,
        currentStatus: 'review',
        targetStatus: 'done',
        storedCert: task.process_certificate_sha,
        sopAuthoringForTaskId: null,
        source: task.source,
      });
      if (certGate.applies && !certGate.ok) {
        perTask.push({
          chatId,
          channel,
          message: '',
          stamps: [], // structural no-send — see PlannedSend.heldForMissingPostflight doc
          doneWithoutDeliverable: [],
          heldForMissingPostflight: [{
            taskId: task.id,
            title: task.title,
            detail:
              `task ${task.id} ("${task.title}") reached status='done' with NO registered ` +
              `process_certificate_sha — the completion message was HELD, not sent. ${certGate.error ?? ''} ` +
              `${certGate.remediation ?? ''}`.trim(),
          }],
        });
        continue;
      }
      const deliverable = ctx.deliverableFor(task.id);
      const message = doneMessage(task, deliverable);
      const extraSets: Record<string, string | null> = {
        result_summary: deliverable ? deliverable.summary : 'Completed (no deliverable registered).',
        result_location: deliverable ? deliverable.location : null,
      };
      perTask.push({
        chatId,
        channel,
        message,
        stamps: [
          {
            taskId: task.id,
            guardColumn: 'completion_sent_at',
            extraSets,
            eventType: 'trust_done',
            eventMessage: `trust_done -> ${chatId}: ${message}`,
          },
        ],
        doneWithoutDeliverable: deliverable ? [] : [{ taskId: task.id, title: task.title }],
        heldForMissingPostflight: [],
      });
      continue;
    }

    // ── Message 2 — BLOCKED on OWNER (the phantom-spec finding: the ask never reached anyone) ──
    if (task.status === 'blocked' && task.block_audience === 'OWNER') {
      // U065: blocked-with-reason has its OWN stamp. Until 2026-07-26 it shared
      // progress_last_sent_at, which produced two wrong behaviours: a task that blocked
      // before its first progress message never received a progress message at all, and a
      // task that blocked within PROGRESS_MIN_INTERVAL_MS of a progress message stayed
      // silent about being blocked for up to twelve hours. "Paused waiting on you" is a
      // STATE CHANGE and is never throttled against an unrelated message.
      const throttled =
        task.blocked_notice_sent_at !== null &&
        ageMs(ctx.now, task.blocked_notice_sent_at) < BLOCKED_RENOTIFY_INTERVAL_MS;
      if (!throttled) {
        const message = blockedMessage(task);
        perTask.push({
          chatId,
          channel,
          message,
          stamps: [
            {
              taskId: task.id,
              guardColumn: 'blocked_notice_sent_at',
              extraSets: {},
              eventType: 'trust_progress',
              eventMessage: `trust_progress(blocked) -> ${chatId}: ${message}`,
            },
          ],
          doneWithoutDeliverable: [],
          heldForMissingPostflight: [],
        });
        continue;
      }
    }

    // ── Message 3 — PER-PHASE PROGRESS (U065) ──
    // Below BLOCKED on purpose: a blocked job must ask for what it needs, not report a
    // phase. Above ACK on purpose: a moving job has already been acknowledged.
    // Held during quiet hours (see isQuietHour) -- unlike done and blocked, a phase
    // report is never urgent enough to wake anyone. U044 must NOT carve this out.
    if (task.status === 'in_progress' && task.progress_last_sent_at && !night) {
      const phase = ctx.phaseFor?.(task.id);
      if (phase && phase.label) {
        // FIX 24: the send is gated on BOTH the phase's own budget (silence
        // ceiling — the old behavior) and the global PROGRESS_MIN_INTERVAL_MS
        // floor (1h shipped). A phase that advanced 30 minutes after the last
        // report is HELD until the 1h floor elapses — at most one progress
        // message per task per hour, phase budget or not.
        const stale =
          task.phase_progress_sent_at === null ||
          (ageMs(ctx.now, task.phase_progress_sent_at) >= phase.budgetMs &&
            ageMs(ctx.now, task.phase_progress_sent_at) >= PROGRESS_MIN_INTERVAL_MS);
        const advanced = phase.label !== task.last_reported_phase_label;
        if (advanced && stale) {
          const message = phaseProgressMessage(task, phase.label, phase.doneCount, phase.totalCount);
          perTask.push({
            chatId,
            channel,
            message,
            stamps: [
              {
                taskId: task.id,
                guardColumn: 'phase_progress_sent_at',
                extraSets: { last_reported_phase_label: phase.label },
                eventType: 'trust_phase_progress',
                eventMessage: `trust_phase_progress -> ${chatId}: ${message}`,
              },
            ],
            doneWithoutDeliverable: [],
            heldForMissingPostflight: [],
          });
          continue;
        }
      }
    }

    // ── Message 2 — IN-PROGRESS + ETA (first in-progress touch only) ──
    if (task.status === 'in_progress' && !task.progress_last_sent_at) {
      const eta = etaForDepartment(task.department);
      const message = progressMessage(task, eta);
      perTask.push({
        chatId,
        channel,
        message,
        stamps: [
          {
            taskId: task.id,
            guardColumn: 'progress_last_sent_at',
            extraSets: { eta_estimate: eta },
            eventType: 'trust_progress',
            eventMessage: `trust_progress -> ${chatId}: ${message}`,
          },
        ],
        doneWithoutDeliverable: [],
        heldForMissingPostflight: [],
      });
      continue;
    }

    // ── Message 1 — ACK (past backlog, or 10 min after ingest, whichever first) ──
    if (!task.ack_sent_at) {
      const pastBacklog = task.status !== 'backlog' && task.status !== 'inbox';
      const graceElapsed = ageMs(ctx.now, task.created_at) >= ACK_BACKLOG_GRACE_MS;
      if (pastBacklog || graceElapsed) {
        // Still in backlog after the grace window => honest "queued for grooming".
        const queuedForGrooming = !pastBacklog && graceElapsed;
        const message = ackMessage(task, queuedForGrooming);
        perTask.push({
          chatId,
          channel,
          message,
          stamps: [
            {
              taskId: task.id,
              guardColumn: 'ack_sent_at',
              extraSets: {},
              eventType: 'trust_ack',
              eventMessage: `trust_ack -> ${chatId}: ${message}`,
            },
          ],
          doneWithoutDeliverable: [],
          heldForMissingPostflight: [],
        });
        continue;
      }
    }
  }

  // ── Digest coalescing: >DIGEST_THRESHOLD sends to a single chat => ONE message ──
  const byChat = new Map<string, PlannedSend[]>();
  for (const s of perTask) {
    const arr = byChat.get(s.chatId) ?? [];
    arr.push(s);
    byChat.set(s.chatId, arr);
  }

  const out: PlannedSend[] = [];
  for (const chatId of Array.from(byChat.keys())) {
    const allSends: PlannedSend[] = byChat.get(chatId) ?? [];
    // TICKET 3: a held (certificate-missing) entry carries stamps: [] and an
    // empty message — it is a structural no-send, never a real client update.
    // Keep it OUT of digest coalescing entirely (no blank bullet line in a
    // client-facing digest) — it always passes through untouched below, and
    // executeSends still treats it as a no-op regardless of bucketing.
    const held = allSends.filter((s) => s.heldForMissingPostflight.length > 0);
    const sends = allSends.filter((s) => s.heldForMissingPostflight.length === 0);
    out.push(...held);
    if (sends.length === 0) continue;
    if (sends.length <= DIGEST_THRESHOLD) {
      out.push(...sends);
      continue;
    }
    // Coalesce: one digest message, ALL stamps claimed together, all smells merged.
    const lines = sends.map((s: PlannedSend) => `• ${s.message}`);
    const digest: PlannedSend = {
      chatId,
      channel: sends[0].channel,
      message: `Here are ${sends.length} quick updates:\n${lines.join('\n')}`,
      stamps: sends.flatMap((s: PlannedSend) => s.stamps),
      doneWithoutDeliverable: sends.flatMap((s: PlannedSend) => s.doneWithoutDeliverable),
      heldForMissingPostflight: [],
    };
    out.push(digest);
  }
  return out;
}

// ── The executor (IO) ─────────────────────────────────────────────────────────

export interface ExecuteContext {
  now: Date;
  /**
   * Injected sender. When omitted, the DEFAULT dispatcher routes BY CHANNEL
   * (P5-01 step 2 — one trust engine, two channels): a `ceo-chat` plan is written
   * into the "My AI CEO" chat transcript so the report-back renders as a chat
   * event in that UI; every other channel goes to Telegram via notify.ts. Tests
   * may override to capture sends. Returns true when a send was DISPATCHED.
   */
  send?: (chatId: string, message: string, channel?: string) => boolean;
  /** Injected operator-lane escalation for the done-without-deliverable QC smell. */
  escalate?: (message: string) => void;
}

/** Map a plan's stamps to the ceo-chat trust `kind` used for UI styling. */
function trustKindFor(plan: PlannedSend): 'trust_ack' | 'trust_progress' | 'trust_done' {
  const t = plan.stamps[0]?.eventType;
  if (t === 'trust_ack') return 'trust_ack';
  if (t === 'trust_done') return 'trust_done';
  return 'trust_progress';
}

/**
 * The channel-aware DEFAULT sender (P5-01 step 2). `ceo-chat` report-backs are
 * written into `ceo_chat_messages` (the My AI CEO transcript) instead of
 * Telegram; every other channel uses notifyTelegram. Never throws — a write
 * failure returns false so the durable stamp is preserved and the row simply
 * isn't counted as sent (no duplicate risk).
 *
 * U60/JM-U63c (J.0.7 threading fix): `plan.stamps[0].taskId` is passed through
 * to `appendTrustMessage` so the written row can be joined back to the
 * Operations Rail card that spawned it (previously dropped here). A broadcast
 * on the existing SSE bus follows the write so a connected rail updates within
 * ~2s without waiting on its 15s poll fallback; the broadcast is fire-and-forget
 * and never affects the send's success/failure outcome.
 */
function defaultTrustSend(plan: PlannedSend): boolean {
  if (plan.channel === CEO_CHAT_CHANNEL) {
    const taskId = plan.stamps[0]?.taskId ?? null;
    const kind = trustKindFor(plan);
    try {
      appendTrustMessage(plan.chatId, plan.message, kind, taskId);
    } catch (err) {
      console.warn('[trust-engine] ceo-chat report-back write failed:', (err as Error).message);
      return false;
    }
    try {
      if (taskId) {
        broadcast({
          type: 'ceo_chat_task_status',
          payload: { taskId, sessionId: plan.chatId, kind, message: plan.message },
        });
      }
    } catch (err) {
      // Never let a broadcast failure undo an already-durable write.
      console.warn('[trust-engine] ceo-chat status broadcast failed (non-fatal):', (err as Error).message);
    }
    return true;
  }
  return notifyTelegram({ chatId: plan.chatId, message: plan.message });
}

export interface ExecuteResult {
  sent: number;
  claimed: number;
  skipped: number;
  /** Claims this run wrote and then released because the transport proved the send
   *  did not happen. A non-zero value is a real alarm, not noise. */
  released: number;
}

/**
 * Release a claim this iteration wrote, when the transport PROVED the send did not
 * happen. Narrow by construction: the guard column must still hold the exact
 * timestamp this iteration wrote (`claimedAt`), so a concurrent sweep's fresher
 * claim is never clobbered. Every column the claim set — the guard plus any
 * `extraSets` — is reset together, so a released row carries no half-applied
 * result_summary/result_location.
 *
 * Returns the number of stamps actually released (0 when another worker moved on).
 * Never throws: this runs on a failure path and must not turn a non-send into a crash.
 */
function releaseUnsentClaims(stamps: StampOp[], claimedAt: string): number {
  let released = 0;
  for (const stamp of stamps) {
    try {
      const sets: string[] = [`${stamp.guardColumn} = NULL`, 'updated_at = ?'];
      const params: (string | null)[] = [claimedAt];
      for (const col of Object.keys(stamp.extraSets)) {
        sets.push(`${col} = NULL`);
      }
      params.push(stamp.taskId, claimedAt);
      const res = run(
        `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND ${stamp.guardColumn} = ?`,
        params,
      );
      released += res.changes;
    } catch (err) {
      console.warn(
        '[trust-engine] claim release failed for task %s (%s); the stamp stays and the row will not be re-planned:',
        stamp.taskId,
        stamp.guardColumn,
        (err as Error).message,
      );
    }
  }
  return released;
}

/**
 * Execute planned sends CLAIM-then-dispatch. For each plan: within a single
 * transaction, claim every stamp (`UPDATE ... WHERE <guard> IS NULL`) and write
 * its events row; if EVERY stamp claim affected 0 rows the send was already made
 * by another worker => skip (no duplicate). Only after the claim commits do we
 * dispatch the fire-and-forget gateway send. The durable stamp is the sole
 * idempotency guard (P1-04 step 7).
 */
export function executeSends(plans: PlannedSend[], ctx: ExecuteContext): ExecuteResult {
  // Channel-aware dispatch: an injected ctx.send wins (tests / custom routers);
  // otherwise the DEFAULT routes ceo-chat → chat transcript, else → Telegram.
  const dispatch = (plan: PlannedSend): boolean =>
    ctx.send ? ctx.send(plan.chatId, plan.message, plan.channel) : defaultTrustSend(plan);
  const escalate =
    ctx.escalate ??
    ((message: string) => notifySystem(message, { agent: 'trust-engine', action: 'escalate' }));
  const nowIso = ctx.now.toISOString();

  let released = 0;
  let sent = 0;
  let claimed = 0;
  let skipped = 0;

  for (const plan of plans) {
    // TICKET 3 (L-13): a held (certificate-missing) plan has stamps: [] by
    // construction (see PlannedSend.heldForMissingPostflight) — it would
    // otherwise fall into the generic `!anyClaimed => skipped, continue` path
    // below and its smell would NEVER reach the operator lane. Handle it
    // first, unconditionally: escalate, count as skipped (nothing was ever
    // going to be claimed or sent), and move on — never attempt dispatch.
    if (plan.heldForMissingPostflight.length > 0) {
      for (const held of plan.heldForMissingPostflight) {
        escalate(`[trust-engine] completion_notification_held: ${held.detail}`);
      }
      skipped += 1;
      continue;
    }

    // ── Claim: durable stamp BEFORE dispatch (transactional outbox). ──
    // A plan's stamp-claims AND their events rows commit together inside ONE
    // explicit transaction, so a crash mid-claim can never leave a half-applied
    // plan (some stamps taken, others not) — the whole claim is all-or-nothing,
    // exactly as the executeSends contract above promises.
    const anyClaimed = transaction(() => {
      let claimedInTx = false;
      for (const stamp of plan.stamps) {
        const sets: string[] = [`${stamp.guardColumn} = ?`, 'updated_at = ?'];
        const params: (string | null)[] = [nowIso, nowIso];
        for (const [col, val] of Object.entries(stamp.extraSets)) {
          sets.push(`${col} = ?`);
          params.push(val);
        }
        params.push(stamp.taskId);
        const res = run(
          `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND ${stamp.guardColumn} IS NULL`,
          params,
        );
        if (res.changes > 0) {
          claimedInTx = true;
          // Operator-visibility events row so the board Activity tab shows the
          // client-communication trail (P1-04 step 8, feeds P2-02). Best-effort:
          // a missing events table on a very old box must never roll back the
          // durable stamp, so the insert is swallowed but stays inside the tx.
          try {
            run(
              `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
              [uuidv4(), stamp.eventType, stamp.taskId, stamp.eventMessage, nowIso],
            );
          } catch {
            // events row is best-effort telemetry — never block the send on it.
          }
        }
      }
      return claimedInTx;
    });

    if (!anyClaimed) {
      // Every stamp was already claimed by a prior sweep/worker => no duplicate.
      skipped += 1;
      continue;
    }
    claimed += 1;

    // ── Dispatch AFTER the claim is durable. Fire-and-forget. ──
    // A throw here simulates a crash in the send step: the claim is already
    // committed (durable stamp), so the row is NOT re-planned on the next sweep
    // and NO duplicate can be produced. The throw is swallowed so one bad send
    // never aborts the rest of the batch.
    let dispatched = false;
    let threw = false;
    try {
      dispatched = dispatch(plan);
    } catch (err) {
      threw = true;
      console.warn('[trust-engine] send threw before the transport spawned:', (err as Error).message);
      dispatched = false;
    }
    if (dispatched) {
      sent += 1;
    } else {
      // PROVABLE NON-SEND. The transport returns false in exactly two cases, both
      // of which mean nothing was queued: the suppression short-circuit
      // (notify.ts:617, before execFile) and a synchronous throw. The ceo-chat
      // branch's false (notify/appendTrustMessage write failure, trust-engine
      // defaultTrustSend) is likewise a real non-write. In all of them the claim
      // this iteration wrote is a lie, so release it and record it.
      //
      // NOT COVERED: a gateway that accepts and later fails. `notifyTelegram` is
      // async execFile and returns true before the child runs, so that outcome is
      // indistinguishable from success here. See U043 Part B (senior).
      const releasedCount = releaseUnsentClaims(plan.stamps, nowIso);
      released += releasedCount;
      if (releasedCount > 0) {
        recordUndeliverable(
          'trust_send_not_dispatched',
          `trust-engine released ${releasedCount} claim(s) for task(s) ` +
            `${plan.stamps.map((s) => `${s.taskId}:${s.guardColumn}`).join(', ')} ` +
            `— the transport reported a provable non-send (${threw ? 'threw' : 'returned false'}); ` +
            `the row will be re-planned on the next sweep.`,
        );
      }
    }

    // ── done-without-deliverable QC smell -> OPERATOR lane ONLY (never the client). ──
    for (const smell of plan.doneWithoutDeliverable) {
      escalate(
        `[trust-engine] done_without_deliverable: task ${smell.taskId} ("${smell.title}") ` +
          `completed with ZERO registered deliverables — client was told "ask me for details" ` +
          `(no location fabricated). This is a QC smell worth checking.`,
      );
    }
  }

  return { sent, claimed, skipped, released };
}

// ── DB glue: load candidates + deliverable lookup ─────────────────────────────

/** Columns the sweep needs, joined to the assigned agent's display name. */
const CANDIDATE_SQL = `
  SELECT t.id, t.title, t.status, t.department, a.name AS assigned_agent_name,
         t.created_at, t.requester_channel, t.requester_chat_id,
         t.ack_sent_at, t.progress_last_sent_at, t.completion_sent_at,
         t.block_audience, t.block_needs, t.blocked_notice_sent_at, t.phase_progress_sent_at, t.last_reported_phase_label,
         t.process_certificate_sha, t.source
    FROM tasks t
    LEFT JOIN agents a ON t.assigned_agent_id = a.id
   WHERE t.requester_chat_id IS NOT NULL
     AND t.archived_at IS NULL
     AND (
       t.ack_sent_at IS NULL
       OR (t.status = 'in_progress' AND t.progress_last_sent_at IS NULL)
       OR (t.status = 'blocked' AND t.block_audience = 'OWNER'
           AND (t.blocked_notice_sent_at IS NULL
                OR t.blocked_notice_sent_at < ?))
       OR (t.status = 'done' AND t.completion_sent_at IS NULL)
       OR (t.status = 'in_progress' AND t.progress_last_sent_at IS NOT NULL)
     )
`;

export function loadCandidateTasks(taskId?: string): TrustTaskRow[] {
  const blockedCutoff = new Date(Date.now() - BLOCKED_RENOTIFY_INTERVAL_MS).toISOString();
  if (taskId) {
    const row = queryOne<TrustTaskRow>(`${CANDIDATE_SQL} AND t.id = ?`, [blockedCutoff, taskId]);
    return row ? [row] : [];
  }
  // Cap per sweep so a large backlog can never fan out an unbounded burst; the
  // next 2-minute sweep drains the rest. Ordered oldest-first (fairness).
  return queryAll<TrustTaskRow>(`${CANDIDATE_SQL} ORDER BY t.created_at ASC LIMIT 200`, [blockedCutoff]);
}

/** Resolve a completed task's newest registered deliverable into a client-safe
 *  summary + location. Returns null when the task has no deliverable row. */
export function loadDeliverable(taskId: string): DeliverableInfo | null {
  try {
    const row = queryOne<{ title: string | null; path: string | null; deliverable_type: string | null }>(
      `SELECT title, path, deliverable_type FROM task_deliverables
        WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    if (!row || !row.path) return null;
    const label = row.title?.trim() || row.deliverable_type?.trim() || 'the result';
    return { location: row.path, summary: `Here's ${label}.` };
  } catch {
    // task_deliverables absent on a very old box — treat as no deliverable.
    return null;
  }
}

/** The set of OPERATOR/owner-internal chat ids a trust message must never target. */
function internalChatIds(): Set<string> {
  const ids = new Set<string>();
  try {
    const op = resolveOperatorChatId();
    if (op) ids.add(op);
  } catch { /* best-effort */ }
  // NOTE: the OWNER chat id is intentionally NOT excluded — on a single-owner
  // client box the owner IS the client the trust engine reports to. Only the
  // OPERATOR-internal audience is excluded. resolveOwnerChatId is imported to keep
  // the contract explicit and available to future multi-tenant refinements.
  void resolveOwnerChatId;
  return ids;
}

export interface SweepResult extends ExecuteResult {
  scanned: number;
  skippedReason?: string;
}

/**
 * The 2-minute sweep entry point (registered in scheduler.ts). Loads candidate
 * tasks, plans the due sends, and executes them CLAIM-then-dispatch. Optional
 * overrides exist purely for tests; production calls it with no arguments.
 */
export function runTrustEngineSweep(opts?: {
  taskId?: string;
  now?: Date;
  send?: (chatId: string, message: string) => boolean;
  escalate?: (message: string) => void;
}): SweepResult {
  if (process.env.DISABLE_TRUST_ENGINE === '1' || process.env.DISABLE_TRUST_ENGINE === 'true') {
    return { scanned: 0, sent: 0, claimed: 0, skipped: 0, released: 0, skippedReason: 'DISABLE_TRUST_ENGINE set' };
  }
  const now = opts?.now ?? new Date();
  const tasks = loadCandidateTasks(opts?.taskId);
  if (tasks.length === 0) {
    return { scanned: 0, sent: 0, claimed: 0, skipped: 0, released: 0 };
  }
  const plans = planSends(tasks, {
    now,
    deliverableFor: loadDeliverable,
    blockedChatIds: internalChatIds(),
  });
  const result = executeSends(plans, { now, send: opts?.send, escalate: opts?.escalate });
  return { scanned: tasks.length, ...result };
}

/**
 * Best-effort per-task trigger for the status route to invoke on a transition,
 * so a report-back goes out IMMEDIATELY without waiting up to 2 minutes for the
 * sweep. Shares the exact same claim-then-send path, so it can never double-send
 * with the sweep. Never throws.
 */
export function runTrustEngineForTask(taskId: string): void {
  try {
    runTrustEngineSweep({ taskId });
  } catch (err) {
    console.warn('[trust-engine] per-task trigger failed (non-fatal):', (err as Error).message);
  }
}
