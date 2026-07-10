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
 */

import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getMessagesFromOpenClaw } from '@/lib/planning-utils';
import { runQCOnReview } from '@/lib/qc-scorer';
import { recordStatusEvent } from '@/lib/task-lifecycle';
import { resolveSpecialistSessionKey } from '@/lib/task-dispatcher';
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
 * Advance one task to `review` and broadcast. Mirrors
 * /api/webhooks/agent-completion so behavior is identical regardless of which
 * path (instant webhook vs reconcile) detected the completion.
 */
function advanceToReview(taskId: string, agentId: string | null, agentName: string | null, summary: string): void {
  const now = new Date().toISOString();
  run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['review', now, taskId]);
  // DISP-10: complete the task_events audit sink for this in_progress→review
  // advance (the watcher only ever selects in_progress tasks).
  recordStatusEvent(taskId, 'in_progress', 'review', {
    actor: agentId ?? 'execution-watcher',
    reason: 'agent reported TASK_COMPLETE (reconcile)',
  });
  run(
    `INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), 'task_completed', agentId, taskId, `${agentName ?? 'Agent'} completed: ${summary}`, now]
  );
  if (agentId) {
    run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['standby', now, agentId]);
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

  const rows = queryAll<InProgressRow>(
    `SELECT t.id, t.title, t.status, t.assigned_agent_id, t.workspace_id,
            a.name as assigned_agent_name,
            a.role as assigned_agent_role,
            s.openclaw_session_id
     FROM tasks t
     LEFT JOIN agents a ON t.assigned_agent_id = a.id
     LEFT JOIN openclaw_sessions s ON s.agent_id = t.assigned_agent_id AND s.status = 'active'
     WHERE t.status = 'in_progress'
       AND t.assigned_agent_id IS NOT NULL
       AND s.openclaw_session_id IS NOT NULL`
  );

  if (rows.length === 0) return;

  for (const task of rows) {
    if (!task.openclaw_session_id) continue;
    try {
      // NAMESPACE FIX: probe the resolved dept session key first, then the legacy
      // agent:main: key — so a dept agent's late TASK_COMPLETE is actually found.
      let match: string | null = null;
      for (const sessionKey of candidateSessionKeys(task)) {
        let messages: Array<{ role: string; content: string }> = [];
        try {
          messages = await getMessagesFromOpenClaw(sessionKey);
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
        advanceToReview(task.id, task.assigned_agent_id, task.assigned_agent_name, match);
        runQCOnReview(task.id).catch(err => console.error('[execution-watcher] QC error:', err));
      }
    } catch (err) {
      console.warn(`[execution-watcher] Reconcile failed for task ${task.id}:`, (err as Error).message);
    }
  }
}
