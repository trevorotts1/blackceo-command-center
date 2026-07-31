/**
 * OWNER → AGENT MESSAGE DELIVERY
 *
 * WHY THIS EXISTS
 * ---------------
 * `POST /api/tasks/[id]/messages` accepts an owner message, returns 200, and
 * writes a row into `task_activities` with activity_type='owner_message'.
 * Until this module existed, NOTHING ever read those rows back out: across
 * `task-dispatcher.ts` and `api/tasks/[id]/dispatch/route.ts` the string
 * `task_activities` appeared ONLY in INSERT statements, never in a SELECT.
 *
 * Net effect: owner→agent communication was structurally write-only. An owner
 * could answer a specialist's question, or narrow the scope of a task, and the
 * specialist would never see it — while the board showed the message as
 * delivered. Meanwhile every dispatch prompt ends with "If you need help or
 * clarification, ask the orchestrator", inviting a conversation the pipeline
 * could not carry.
 *
 * Observed in production 2026-07-31 (Jennifer Allen, task 804f4e30): the owner
 * posted a scope clarification — "do NOT apply the logo across the whole
 * TalentLMS" — which never reached the agent. An operator context pack posted
 * the same way was also silently dropped, and the specialist re-asked the exact
 * question it had already been answered. The only way to reach the agent was to
 * bypass Command Center entirely and write into its OpenClaw session directly.
 *
 * Delivering these messages is therefore a correctness fix, not an enhancement:
 * a re-dispatch that omits them re-runs the task against stale instructions.
 */
import { queryAll } from '@/lib/db';

/** Activity rows that represent real owner intent the specialist must honor. */
const OWNER_ACTIVITY_TYPES = ['owner_message', 'owner_scope_clarification', 'owner_answer'] as const;

/** Hard cap so a long-running task cannot blow the dispatch prompt budget. */
const MAX_MESSAGES = 20;
const MAX_CHARS_PER_MESSAGE = 4000;

export interface OwnerMessageRow {
  message: string;
  created_at: string;
  activity_type: string;
}

/**
 * Load owner-authored messages for a task, oldest first so the specialist reads
 * them in the order they were written (later instructions supersede earlier).
 * Never throws: a dispatch must not fail because this lookup did.
 */
export function loadOwnerMessages(taskId: string): OwnerMessageRow[] {
  try {
    const placeholders = OWNER_ACTIVITY_TYPES.map(() => '?').join(', ');
    const rows = queryAll<OwnerMessageRow>(
      `SELECT message, created_at, activity_type
         FROM task_activities
        WHERE task_id = ?
          AND activity_type IN (${placeholders})
          AND message IS NOT NULL
          AND TRIM(message) <> ''
        ORDER BY created_at ASC
        LIMIT ?`,
      [taskId, ...OWNER_ACTIVITY_TYPES, MAX_MESSAGES],
    );
    return rows ?? [];
  } catch (err) {
    console.error(`[owner-messages] load failed for task ${taskId}:`, err);
    return [];
  }
}

/**
 * Render owner messages as a dispatch-prompt section. Returns '' when there are
 * none, so single-shot tasks render byte-identically to before this change.
 */
export function renderOwnerMessagesSection(taskId: string): string {
  const rows = loadOwnerMessages(taskId);
  if (rows.length === 0) return '';

  const body = rows
    .map((r) => {
      const text = r.message.length > MAX_CHARS_PER_MESSAGE
        ? `${r.message.slice(0, MAX_CHARS_PER_MESSAGE)}\n…[truncated]`
        : r.message;
      return `- [${r.created_at}] ${text}`;
    })
    .join('\n');

  return `
**OWNER MESSAGES — READ BEFORE STARTING (${rows.length}):**
These were sent by the task owner or operator AFTER the task was created. They
are authoritative and OVERRIDE the original description above wherever they
conflict. Later messages supersede earlier ones. If one of them answers a
question you were about to ask, act on it instead of asking again.
${body}
`;
}
