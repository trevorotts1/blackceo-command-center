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

import { queryAll, queryOne, run, timeNow } from '@/lib/db';
import { notifyTelegram, notifySystem, resolveOperatorChatId, resolveOwnerChatId } from '@/lib/notify';
import { v4 as uuidv4 } from 'uuid';

// ── Tunables ──────────────────────────────────────────────────────────────
/** After ingest, wait up to this long for the triad to advance a task past
 *  `backlog` before we send the ACK anyway (honesty over silence). */
export const ACK_BACKLOG_GRACE_MS = 10 * 60 * 1000; // 10 minutes
/** Anti-spam: at most one progress message per task per 12h EXCEPT state changes. */
export const PROGRESS_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
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
  guardColumn: 'ack_sent_at' | 'progress_last_sent_at' | 'completion_sent_at';
  /** Additional columns to set in the same claim UPDATE (eta/result columns). */
  extraSets: Record<string, string | null>;
  eventType: 'trust_ack' | 'trust_progress' | 'trust_done';
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
}

export interface PlanContext {
  now: Date;
  /** Lookup a completed task's registered deliverable (null when none registered). */
  deliverableFor: (taskId: string) => DeliverableInfo | null;
  /** Chat ids that are OPERATOR/owner-internal — a trust message must NEVER target these. */
  blockedChatIds?: Set<string>;
  /** Override night-hold detection (defaults to box-local clock on `now`). */
  isNight?: boolean;
}

// ── Message builders ──────────────────────────────────────────────────────────

function ackMessage(task: TrustTaskRow, queuedForGrooming: boolean): string {
  if (queuedForGrooming) {
    return (
      `✅ Got it — "${task.title}" is captured and queued for grooming. ` +
      `I'll assign it to the right department shortly and keep you posted.`
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
  // Quiet hours: hold EVERYTHING (DONE included by default). Nothing is stamped,
  // so every held send is re-attempted after 07:00 by the next sweep.
  if (night) return [];

  // One send per task per sweep (whichever message is due). Grouped by chat at
  // the end so >DIGEST_THRESHOLD sends to one chat coalesce into a digest.
  const perTask: PlannedSend[] = [];

  for (const task of tasks) {
    const chatId = task.requester_chat_id;
    if (!chatId) continue; // never reported on
    // NEVER target a SYSTEM/operator-internal audience with a client trust message.
    if (ctx.blockedChatIds?.has(chatId)) continue;
    const channel = task.requester_channel || 'telegram';

    // ── Message 3 — DONE (highest priority: a finished task's client is waiting) ──
    if (task.status === 'done' && !task.completion_sent_at) {
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
      });
      continue;
    }

    // ── Message 2 — BLOCKED on OWNER (the phantom-spec finding: the ask never reached anyone) ──
    if (task.status === 'blocked' && task.block_audience === 'OWNER') {
      const throttled =
        task.progress_last_sent_at !== null &&
        ageMs(ctx.now, task.progress_last_sent_at) < PROGRESS_MIN_INTERVAL_MS;
      // A blocked-on-owner ask is a STATE CHANGE — it may bypass the 12h throttle
      // the FIRST time (progress stamp null). If a progress msg was already sent
      // recently we still respect the 12h floor to avoid nagging.
      if (task.progress_last_sent_at === null || !throttled) {
        const message = blockedMessage(task);
        perTask.push({
          chatId,
          channel,
          message,
          stamps: [
            {
              taskId: task.id,
              guardColumn: 'progress_last_sent_at',
              extraSets: {},
              eventType: 'trust_progress',
              eventMessage: `trust_progress(blocked) -> ${chatId}: ${message}`,
            },
          ],
          doneWithoutDeliverable: [],
        });
        continue;
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
    const sends: PlannedSend[] = byChat.get(chatId) ?? [];
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
    };
    out.push(digest);
  }
  return out;
}

// ── The executor (IO) ─────────────────────────────────────────────────────────

export interface ExecuteContext {
  now: Date;
  /** Injected gateway sender (defaults to notify.ts notifyTelegram). Returns
   *  true when a send was DISPATCHED. */
  send?: (chatId: string, message: string) => boolean;
  /** Injected operator-lane escalation for the done-without-deliverable QC smell. */
  escalate?: (message: string) => void;
}

export interface ExecuteResult {
  sent: number;
  claimed: number;
  skipped: number;
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
  const send = ctx.send ?? ((chatId: string, message: string) => notifyTelegram({ chatId, message }));
  const escalate =
    ctx.escalate ??
    ((message: string) => notifySystem(message, { agent: 'trust-engine', action: 'escalate' }));
  const nowIso = ctx.now.toISOString();

  let sent = 0;
  let claimed = 0;
  let skipped = 0;

  for (const plan of plans) {
    // ── Claim: durable stamp BEFORE dispatch (transactional outbox). ──
    let anyClaimed = false;
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
        anyClaimed = true;
        // Operator-visibility events row so the board Activity tab shows the
        // client-communication trail (P1-04 step 8, feeds P2-02).
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
    try {
      dispatched = send(plan.chatId, plan.message);
    } catch (err) {
      console.warn('[trust-engine] send failed (claim already durable, no duplicate):', (err as Error).message);
      dispatched = false;
    }
    if (dispatched) sent += 1;

    // ── done-without-deliverable QC smell -> OPERATOR lane ONLY (never the client). ──
    for (const smell of plan.doneWithoutDeliverable) {
      escalate(
        `[trust-engine] done_without_deliverable: task ${smell.taskId} ("${smell.title}") ` +
          `completed with ZERO registered deliverables — client was told "ask me for details" ` +
          `(no location fabricated). This is a QC smell worth checking.`,
      );
    }
  }

  return { sent, claimed, skipped };
}

// ── DB glue: load candidates + deliverable lookup ─────────────────────────────

/** Columns the sweep needs, joined to the assigned agent's display name. */
const CANDIDATE_SQL = `
  SELECT t.id, t.title, t.status, t.department, a.name AS assigned_agent_name,
         t.created_at, t.requester_channel, t.requester_chat_id,
         t.ack_sent_at, t.progress_last_sent_at, t.completion_sent_at,
         t.block_audience, t.block_needs
    FROM tasks t
    LEFT JOIN agents a ON t.assigned_agent_id = a.id
   WHERE t.requester_chat_id IS NOT NULL
     AND t.archived_at IS NULL
     AND (
       t.ack_sent_at IS NULL
       OR (t.status = 'in_progress' AND t.progress_last_sent_at IS NULL)
       OR (t.status = 'blocked' AND t.block_audience = 'OWNER')
       OR (t.status = 'done' AND t.completion_sent_at IS NULL)
     )
`;

export function loadCandidateTasks(taskId?: string): TrustTaskRow[] {
  if (taskId) {
    const row = queryOne<TrustTaskRow>(`${CANDIDATE_SQL} AND t.id = ?`, [taskId]);
    return row ? [row] : [];
  }
  // Cap per sweep so a large backlog can never fan out an unbounded burst; the
  // next 2-minute sweep drains the rest. Ordered oldest-first (fairness).
  return queryAll<TrustTaskRow>(`${CANDIDATE_SQL} ORDER BY t.created_at ASC LIMIT 200`, []);
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
    return { scanned: 0, sent: 0, claimed: 0, skipped: 0, skippedReason: 'DISABLE_TRUST_ENGINE set' };
  }
  const now = opts?.now ?? new Date();
  const tasks = loadCandidateTasks(opts?.taskId);
  if (tasks.length === 0) {
    return { scanned: 0, sent: 0, claimed: 0, skipped: 0 };
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
