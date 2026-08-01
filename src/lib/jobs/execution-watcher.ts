/**
 * Execution-completion watcher (B2).
 *
 * The board advances a card the moment a `task_updated` SSE event with the new
 * status is broadcast (the UI half — useSSE.ts / store.ts — already works). The
 * missing piece was the SIGNAL that fires that broadcast when an agent finishes
 * an EXECUTION task. There are two ways a completion reaches the board:
 *
 *   1. INSTANT (preferred) — the agent self-reports by POSTing
 *      `/api/webhooks/agent-completion` (with `TASK_COMPLETE: <summary>`), which
 *      now sets status `review` AND broadcasts `task_updated` immediately. This
 *      is event-driven: the card moves the instant the agent reports, with no
 *      polling delay. Dispatch already instructs the agent to do this.
 *
 *   2. SAFETY NET (this module, OPTIONAL) — a low-frequency reconcile that
 *      catches DROPPED completion reports (agent forgot to call back, webhook
 *      lost, gateway hiccup). For every `in_progress` task that has an active
 *      OpenClaw session, it reads the agent's recent assistant messages via the
 *      verified `chat.history` RPC (same call the planning poll uses) and looks
 *      for `TASK_COMPLETE:`. On a match it advances the task to `review` and
 *      broadcasts — exactly like the webhook path.
 *
 * This is intentionally a LOW-FREQUENCY reconcile, NOT the primary mechanism.
 * It is registered as a single cron in scheduler.ts and is trivially disabled
 * by removing that one JOBS entry (or setting EXECUTION_WATCHER_ENABLED=0).
 *
 * MR-15 GATEWAY-DOWN FALLBACK: when the OpenClaw gateway is unreachable, every
 * chat.history probe returns [] — the reconcile sees no TASK_COMPLETE marker and
 * never advances the task. A completed-but-unreportable task rots in_progress
 * until (a) the stuck-in-progress-sweep's 180-min threshold or (b) forever if
 * that sweep is disabled. The fallback checks registered deliverables and
 * on-disk output via the shared recoverFinishedTaskToReview() gate — the same
 * canonical recovery both sweeps already use — so a finished task is never
 * stranded when the gateway goes down. Opt out per box with
 * EXECUTION_WATCHER_GATEWAY_DOWN_RECOVERY=0.
 */

import { queryAll, queryOne, run, timeNow, parseDbTime } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getMessagesFromOpenClaw } from '@/lib/planning-utils';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { runQCOnReview } from '@/lib/qc-scorer';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import { resolveSpecialistSessionKey, deterministicOpenclawSessionId } from '@/lib/task-dispatcher';
import { recoverFinishedTaskToReview } from './finished-work-recovery';
import { v4 as uuidv4 } from 'uuid';
import type { Task, Agent } from '@/lib/types';

// Matches the same completion marker the webhook + dispatch instructions use.
const TASK_COMPLETE_RE = /TASK_COMPLETE:\s*(.+)/i;

interface InProgressRow {
  id: string;
  title: string;
  status: string;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  assigned_agent_role: string | null;
  workspace_id: string | null;
  openclaw_session_id: string | null;
}

/**
 * NAMESPACE FIX — ordered, de-duplicated OpenClaw session keys to probe for a
 * task's completion marker.
 *
 * A dispatched DEPARTMENT agent runs under `agent:dept-<slug>:<session>` (or a
 * bare `agent:<slug>:<session>`), resolved EXACTLY as dispatch does — from the
 * on-disk runtime dir via resolveSpecialistSessionKey — NOT the legacy
 * `agent:main:<session>`. The reconcile previously read ONLY `agent:main:`, so
 * it never saw a dept agent's `TASK_COMPLETE:`; the finished dept task was never
 * advanced to `review` and got swept to `blocked` (the carded-but-trapped
 * defect's late-completion sibling). We now probe the RESOLVED dept key FIRST,
 * then fall back to `agent:main:` (covers the CEO/orchestrator and any dept whose
 * runtime dir is not present on this box), so a late completion reconciles
 * regardless of which namespace its session lives in. Reading a non-existent key
 * is harmless (chat.history returns nothing / the call is caught), so trying both
 * costs only a cheap RPC on the drop-path.
 */
export function candidateSessionKeys(task: InProgressRow): string[] {
  const sessionId = task.openclaw_session_id;
  if (!sessionId) return [];
  const keys: string[] = [];
  try {
    // resolveSpecialistSessionKey only reads .name/.role/.workspace_id — pass a
    // minimal agent shim (cast is localized + runtime-safe).
    const agentLike = {
      id: task.assigned_agent_id ?? '',
      name: task.assigned_agent_name ?? '',
      role: task.assigned_agent_role ?? '',
      workspace_id: task.workspace_id ?? '',
    } as unknown as Agent;
    const resolved = resolveSpecialistSessionKey(
      agentLike,
      sessionId,
      task.workspace_id ?? undefined,
      'execution-watcher',
    );
    if (resolved) keys.push(resolved);
  } catch (err) {
    console.warn(`[execution-watcher] session-key resolve failed for ${task.id} (non-fatal):`, (err as Error).message);
  }
  const legacy = `agent:main:${sessionId}`;
  if (!keys.includes(legacy)) keys.push(legacy);
  return keys;
}

/**
 * B5: derive a probe-ready session id for an in_progress task even when the
 * openclaw_sessions row is missing (purged / never written). The id is a pure
 * function of the agent name — identical to what the dispatcher would have stored.
 */
export function sessionIdForTask(task: {
  openclaw_session_id: string | null;
  assigned_agent_name: string | null;
}): string | null {
  if (task.openclaw_session_id) return task.openclaw_session_id;
  return task.assigned_agent_name ? deterministicOpenclawSessionId(task.assigned_agent_name) : null;
}

/**
 * B5: UPSERT the agent's active openclaw_sessions row so a completion detected on
 * a derived key is durable — future webhook / reconcile lookups then resolve it
 * instead of 404-ing. Best-effort: never throws into the caller.
 */
export function upsertActiveSession(agentId: string | null, openclawSessionId: string, taskId: string): void {
  if (!agentId) return;
  try {
    const now = timeNow();
    const existing = queryOne<{ id: string }>(
      `SELECT id FROM openclaw_sessions WHERE agent_id = ? AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
      [agentId],
    );
    if (existing) {
      run(
        `UPDATE openclaw_sessions SET openclaw_session_id = ?, task_id = ?, updated_at = ? WHERE id = ?`,
        [openclawSessionId, taskId, now, existing.id],
      );
    } else {
      run(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id, created_at, updated_at)
         VALUES (?, ?, ?, 'mission-control', 'active', ?, ?, ?)`,
        [uuidv4(), agentId, openclawSessionId, taskId, now, now],
      );
    }
  } catch (err) {
    console.warn(`[execution-watcher] session upsert failed for ${taskId} (non-fatal):`, (err as Error).message);
  }
}

// Message-object timestamp field candidates the gateway may expose on chat.history.
// `content` is the message text body; it is optional (some gateways omit it from
// the history RPC) but is used by the liveness probe to scope messages to a
// specific task so unrelated agent chatter cannot mask a dead card.
export interface RawHistoryMessage {
  role?: string;
  content?: string;
  ts?: unknown;
  timestamp?: unknown;
  time?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  updatedAt?: unknown;
}

/** Extract an epoch-ms timestamp from a raw chat.history message, tolerating
 *  number (s or ms) and ISO-string forms. Returns null when none is present. */
function extractMessageTimeMs(m: RawHistoryMessage): number | null {
  const candidates = [m.ts, m.timestamp, m.time, m.createdAt, m.created_at, m.updatedAt];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) {
      // Heuristic: values below ~1e12 are seconds, not millis.
      return c < 1e12 ? c * 1000 : c;
    }
    if (typeof c === 'string' && c) {
      const ms = parseDbTime(c);
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return null;
}

export type SessionLiveness = 'alive' | 'idle' | 'unknown';

/** A raw chat.history reader for one session key. Injectable so the liveness
 *  logic is unit-testable without a live gateway. */
export type SessionHistoryReader = (sessionKey: string) => Promise<RawHistoryMessage[]>;

/**
 * Default reader: fetch raw chat.history for a session key.
 *
 * IMPORTANT: this does NOT initiate a socket connect. A not-yet-connected client
 * calling connect() against a configured-but-unreachable gateway BLOCKS the whole
 * sweep (and would hang the test runner on a dangling socket). The
 * execution-watcher reconcile keeps the singleton connected in production; when
 * it is not connected we return no history, so the probe degrades to 'unknown'
 * and the block path still runs (safety net preserved). Never throws.
 */
export async function readSessionHistory(sessionKey: string): Promise<RawHistoryMessage[]> {
  try {
    const client = getOpenClawClient();
    // Constructing the shared client starts a 5-min cache-cleanup setInterval that
    // is not unref'd; unref it so a best-effort probe never keeps a short-lived
    // process (a test run, a one-shot CLI) alive. Harmless in the long-lived
    // server — its HTTP/WS listeners keep the loop alive regardless, and the timer
    // still fires. Idempotent.
    const cleanupTimer = (globalThis as Record<string, unknown>)['__openclaw_cache_cleanup_timer__'] as
      | { unref?: () => void }
      | undefined;
    cleanupTimer?.unref?.();
    if (!client.isConnected()) return [];
    const result = await client.call<{ messages?: RawHistoryMessage[] }>('chat.history', {
      sessionKey,
      limit: 50,
    });
    return result?.messages ?? [];
  } catch (err) {
    console.warn(`[execution-watcher] liveness probe read failed (${sessionKey}):`, (err as Error).message);
    return [];
  }
}

/**
 * B3: probe an agent's OpenClaw session for genuine forward-progress BEFORE the
 * stuck-sweep force-blocks it. The `events` table has NO mid-turn agent-activity
 * type, so a legitimately long-running turn leaves no `events` row and is falsely
 * blocked at the threshold (agents were observed finishing 6h+ after such a
 * block). The session IS the real liveness channel: a chat.history message newer
 * than the cutoff proves the turn is alive.
 *
 * MR-07 (SESSION-LIVENESS-TOO-BROAD): the original probe returned `alive` for ANY
 * recent message in the session, regardless of which task the agent was working
 * on. An agent chatting about task #B while task #A quietly rotted would evade the
 * sweep forever — the agent kept the session "alive" without touching the stuck
 * card. We now require at least one recent message that references the probed
 * TASK ID (or, when no messages carry content, we fall through to the broad
 * check as a conservative backstop — a gateway that omits content never
 * incorrectly returns `idle`).
 *
 * Returns:
 *   • 'alive'   — a timestamped, task-scoped message newer than the cutoff was found → SKIP.
 *   • 'idle'    — the session responded but showed no message newer than cutoff.
 *   • 'unknown' — no session id / gateway not connected / no timestamps available.
 *
 * The caller SKIPS only on 'alive'; 'idle'/'unknown' fall through to the existing
 * block path so the silent-death safety net is fully preserved. Best-effort and
 * never-throw (a down gateway must not crash the sweep).
 */
export async function probeSessionLiveness(
  task: {
    id: string;
    assigned_agent_id: string | null;
    assigned_agent_name: string | null;
    assigned_agent_role: string | null;
    workspace_id: string | null;
    openclaw_session_id: string | null;
  },
  cutoffMs: number,
  reader: SessionHistoryReader = readSessionHistory,
): Promise<SessionLiveness> {
  const sessionId = sessionIdForTask(task);
  if (!sessionId) return 'unknown';

  const probeRow: InProgressRow = {
    id: task.id,
    title: '',
    status: 'in_progress',
    assigned_agent_id: task.assigned_agent_id,
    assigned_agent_name: task.assigned_agent_name,
    assigned_agent_role: task.assigned_agent_role,
    workspace_id: task.workspace_id,
    openclaw_session_id: sessionId,
  };

  let sawResponse = false;
  let sawAnyRecent = false; // broad fallback: at least one message crossed the cutoff
  let sawContentWithTimestamp = false; // at least one message had BOTH content + timestamp

  for (const sessionKey of candidateSessionKeys(probeRow)) {
    let messages: RawHistoryMessage[];
    try {
      messages = await reader(sessionKey);
    } catch {
      continue; // bad/absent key — try the next candidate.
    }
    if (messages.length > 0) sawResponse = true;
    for (const m of messages) {
      const ms = extractMessageTimeMs(m);
      const recent = ms !== null && ms > cutoffMs;
      if (recent) sawAnyRecent = true;
      // MR-07: scope liveness to task-specific messages. The agent must reference
      // the task id in its message content — unrelated chatter is not liveness for
      // this particular task. The task id appears in dispatch prompts, tool args,
      // and the assigned-task context block, so a genuine work turn ALWAYS names it.
      const hasContent = typeof m.content === 'string' && m.content.length > 0;
      if (hasContent && ms !== null) sawContentWithTimestamp = true;
      if (recent && hasContent && m.content!.includes(task.id)) {
        return 'alive'; // task-scoped liveness confirmed
      }
    }
  }

  // MR-07 conservative fallback: if every recent message lacks content (gateway
  // omits it), fall through to the broad check — a "false idle" on a live task
  // is worse than a "false alive" on a stuck one, so we err on the side of
  // letting a genuinely live task keep running. A content-omitting gateway is rare
  // and the HARD CEILING in the sweep caller still catches the truly stuck.
  if (!sawContentWithTimestamp && sawAnyRecent) {
    return 'alive'; // no task-scoping possible, give the benefit of the doubt
  }

  return sawResponse ? 'idle' : 'unknown';
}

/**
 * Advance one task to `review` and broadcast. Mirrors
 * /api/webhooks/agent-completion so behavior is identical regardless of which
 * path (instant webhook vs reconcile) detected the completion.
 *
 * MR-04: converted from raw status write to transition() so the legal-transition
 * guard, precondition checks, and CAS all run. The previous raw write had no CAS
 * guard beyond only selecting in_progress tasks; transition() closes the TOCTOU.
 */
async function advanceToReview(taskId: string, agentId: string | null, agentName: string | null, summary: string): Promise<void> {
  // MR-16: migrated from raw UPDATE + recordStatusEvent to transition() for
  // DISP-09 atomicity — the status flip, task_events insert, and events insert
  // now commit as ONE transaction. No separate run() / recordStatusEvent() gap.
  // The caller only ever selects in_progress tasks so no CAS guard is needed
  // beyond transition()'s own from-status guard.
  try {
    await transition(taskId, 'review', {
      actor: agentId ?? 'execution-watcher',
      reason: 'agent reported TASK_COMPLETE (reconcile)',
    });
  } catch (err) {
    if (err instanceof TransitionError) {
      // CAS_CONFLICT: another writer already moved the task. Don't double-move
      // the agent to standby — just log and return.
      console.warn(`[execution-watcher] advanceToReview transition failed for ${taskId}: ${err.code} ${err.message}`);
      return;
    }
    throw err;
  }

  // Post-commit: free the agent (transition() already handled broadcast +
  // events + task_events).
  if (agentId) {
    run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['standby', new Date().toISOString(), agentId]);
  }

  const updated = queryOne<Task>(
    `SELECT t.*, aa.name as assigned_agent_name, aa.avatar_emoji as assigned_agent_emoji
     FROM tasks t LEFT JOIN agents aa ON t.assigned_agent_id = aa.id WHERE t.id = ?`,
    [taskId]
  );
  if (updated) broadcast({ type: 'task_updated', payload: updated });
}

/**
 * Reconcile sweep: scan all in_progress tasks with an active session for a
 * `TASK_COMPLETE:` marker in the agent's recent assistant messages.
 */
export async function runExecutionCompletionReconcile(): Promise<void> {
  if (process.env.EXECUTION_WATCHER_ENABLED === '0') {
    return; // Safety net explicitly disabled.
  }

  // B5: include in_progress tasks that have NO active openclaw_sessions row (the
  // purge wiped 64 rows). The completion id is deterministic, so we derive it in
  // the loop instead of dropping the task — previously the `s.openclaw_session_id
  // IS NOT NULL` filter made a finished-but-session-less task un-reconcilable, so
  // it got swept to blocked.
  const rows = queryAll<InProgressRow>(
    `SELECT t.id, t.title, t.status, t.assigned_agent_id, t.workspace_id,
            a.name as assigned_agent_name,
            a.role as assigned_agent_role,
            s.openclaw_session_id
     FROM tasks t
     LEFT JOIN agents a ON t.assigned_agent_id = a.id
     LEFT JOIN openclaw_sessions s ON s.agent_id = t.assigned_agent_id AND s.status = 'active' AND s.deleted_at IS NULL
     WHERE t.status = 'in_progress'
       AND t.assigned_agent_id IS NOT NULL`
  );

  if (rows.length === 0) return;

  // MR-15: track whether we could reach the gateway at all this tick. If the
  // gateway is unreachable for EVERY task, the reconcile cannot find a
  // TASK_COMPLETE marker via chat.history — completed-but-unreported tasks stay
  // in_progress forever. The deliverable-based fallback (same canonical recovery
  // both sweeps share) runs only once the gateway is confirmed down — i.e.
  // isConnected() is false AND EVERY task probed so far this tick returned
  // empty (the every-task-empty guard). That guard is what keeps a transient
  // blip from false-recovering a genuinely in-progress task whose session
  // simply has no messages yet; a finished task is never left stranded when the
  // gateway goes down.
  let gatewayConfirmedDown = false;
  let everyTaskEmptySoFar = true;
  const ENABLE_GATEWAY_DOWN_RECOVERY =
    process.env.EXECUTION_WATCHER_GATEWAY_DOWN_RECOVERY !== '0';

  for (const task of rows) {
    // B5: derive the deterministic session id when the DB row is missing.
    if (!task.openclaw_session_id) {
      task.openclaw_session_id = sessionIdForTask(task);
    }
    if (!task.openclaw_session_id) continue;
    try {
      // NAMESPACE FIX: probe the resolved dept session key first, then the legacy
      // agent:main: key — so a dept agent's late TASK_COMPLETE is actually found.
      let match: string | null = null;
      let anySessionResponded = false;
      for (const sessionKey of candidateSessionKeys(task)) {
        let messages: Array<{ role: string; content: string }> = [];
        try {
          messages = await getMessagesFromOpenClaw(sessionKey);
          if (messages.length > 0) anySessionResponded = true;
        } catch (err) {
          console.warn(`[execution-watcher] history read failed for ${task.id} (${sessionKey}):`, (err as Error).message);
          continue; // bad/absent key — try the next candidate.
        }
        // Scan most-recent messages for the completion marker.
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role !== 'assistant') continue;
          const found = m.content.match(TASK_COMPLETE_RE);
          if (found) {
            match = found[1].trim();
            break;
          }
        }
        if (match) break; // found in this namespace — stop probing.
      }
      if (match) {
        console.log(`[execution-watcher] Reconcile detected TASK_COMPLETE for task ${task.id} ("${task.title}")`);
        // B5: persist the (possibly derived) session so the webhook / next
        // reconcile resolve it directly rather than re-deriving.
        upsertActiveSession(task.assigned_agent_id, task.openclaw_session_id, task.id);
        advanceToReview(task.id, task.assigned_agent_id, task.assigned_agent_name, match).catch(err =>
          console.warn(`[execution-watcher] advanceToReview transition failed for task ${task.id}:`, (err as Error).message),
        );
        runQCOnReview(task.id).catch(err => console.error('[execution-watcher] QC error:', err));
        continue; // task advanced — don't fall back to deliverable check.
      }

      // MR-15: GATEWAY-DOWN DELIVERABLE FALLBACK — when every session probe
      // returned empty AND the gateway is confirmed unreachable (isConnected()
      // returns false with no active ws), the agent's TASK_COMPLETE might be
      // already-finalized but unreachable via chat.history. Fall back to checking
      // registered deliverables and on-disk output — the SAME canonical recovery
      // both sweeps share. This closes the gap where the reconcile returns []
      // (empty messages) and never advances a completed task.
      //
      // The gateway check is lazily computed and cached for the rest of the tick
      // (a single tick's gateway state is stable). When the gateway IS reachable
      // but a session simply has no messages, we skip the fallback — an empty
      // history with a live gateway is a genuinely in-progress task, not a
      // completed-but-unreportable one.
      //
      // EVERY-TASK-EMPTY GUARD (fix2): confirm-down requires isConnected() false
      // AND every task probed so far this tick to have returned empty. An empty
      // probe on the FIRST task while isConnected() is false is ambiguous — the
      // ws may be mid-reconnect, or that one session may simply be new — and
      // recovering it on a transient blip would false-recover a genuinely
      // in-progress task. Once a later task's session DOES respond, the gateway
      // is proven reachable and the guard trips off for the rest of the tick, so
      // a single dead session can never drag a live gateway into recovery.
      const client = getOpenClawClient();
      if (ENABLE_GATEWAY_DOWN_RECOVERY && !anySessionResponded) {
        if (!gatewayConfirmedDown && !client.isConnected() && everyTaskEmptySoFar) {
          gatewayConfirmedDown = true;
          console.warn(
            '[execution-watcher] Gateway unreachable — falling back to deliverable-based completion checks for remaining in_progress tasks.',
          );
        }
        if (gatewayConfirmedDown) {
          try {
            const recovered = await recoverFinishedTaskToReview(task, 'execution-watcher');
            if (recovered) {
              console.log(
                `[execution-watcher] Gateway-down recovery: task ${task.id} ("${task.title}") recovered to review (finished work found).`,
              );
              runQCOnReview(task.id).catch(err => console.error('[execution-watcher] QC error:', err));
              continue;
            }
          } catch (recoveryErr) {
            console.warn(
              `[execution-watcher] Gateway-down recovery check failed for ${task.id}:`,
              (recoveryErr as Error).message,
            );
          }
        }
      } else {
        // This task's session responded (or recovery is disabled): the gateway
        // is reachable. Trip the every-task-empty guard so a later empty task
        // cannot confirm-down on a live gateway.
        everyTaskEmptySoFar = false;
      }
    } catch (err) {
      console.warn(`[execution-watcher] Reconcile failed for task ${task.id}:`, (err as Error).message);
    }
  }
}
