/**
 * Owner-message-id oracle (FIX-1 CC side).
 *
 * The authoritative owner-approval source for phase-skip authenticity. A phase
 * skip in the presentations engine is authentic ONLY when its owner_msg_id
 * resolves to a REAL owner-authored message row in Command Center
 * task_activities. Presence of a string in phase_skip_approvals.json is never
 * proof — the live E2E forged "e2e-test-002" and it authorized 9+ skips
 * (ERRORS-DETECTED E1 / R1).
 *
 * Owner-authored messages are the rows written by
 * POST /api/tasks/[id]/messages with sender === 'owner', which land in
 * task_activities as activity_type = 'owner_message' (see
 * src/app/api/tasks/[id]/messages/route.ts). They carry NO agent_id — an owner
 * message is a human write, never an agent write. This is the ONLY writer of
 * the 'owner_message' type in the codebase, so the type is the complete,
 * exclusive marker of an owner-authored message.
 *
 * The read is served to the engine through GET /api/tasks/[id]/messages/
 * owner-ids (the route in this package), which returns a plain JSON array of id
 * strings. The engine's cc_board.list_owner_message_ids() treats a non-200 or a
 * non-array response as UNDETERMINED and fails CLOSED (a skip that cannot be
 * proven authentic is DENIED), so this route must stay 200+array on success and
 * 404 only for an unknown task.
 *
 * listOwnerMessageIds is the reusable, side-effect-free query so both the route
 * and tests share ONE implementation.
 */

import { queryAll } from '@/lib/db';

/**
 * Resolve a task to the set of REAL owner-authored message ids in CC
 * task_activities.
 *
 * Owner-authored messages are identified by activity_type = 'owner_message'
 * (the exclusive marker the messages POST route writes for sender === 'owner').
 * Returns the ids as a sorted, de-duplicated array of non-empty strings.
 * Returns an EMPTY array when the task exists but has no owner messages, or
 * when no rows match — never throws.
 *
 * Callers must NOT use the return value to conclude "the task is unknown": a
 * nonexistent task and a task with no owner messages both yield []. The route
 * layers task-existence on top (404 vs 200 []) so the engine can distinguish
 * "oracle knows this task, it has no owner messages" from "no such task".
 */
export function listOwnerMessageIds(taskId: string): string[] {
  if (!taskId || !String(taskId).trim()) return [];

  const rows = queryAll<{ id: string }>(
    `SELECT id
       FROM task_activities
      WHERE task_id = ? AND activity_type = 'owner_message'
      ORDER BY created_at ASC`,
    [taskId],
  );

  const ids = new Set<string>();
  for (const row of rows) {
    const id = row?.id;
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
  // Array.from, not spread — the repo tsconfig leaves `target` at the ES5
  // default, where `[...set]` needs --downlevelIteration. Array.from is emitted
  // without it and reads identically.
  return Array.from(ids).sort();
}
