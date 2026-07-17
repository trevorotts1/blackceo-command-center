/**
 * "My AI CEO" chat transcript store (P5-01).
 *
 * Thin, typed persistence over the `ceo_chat_messages` table (migration 101):
 *   • the client's messages           (role 'user')
 *   • the agent's streamed replies     (role 'assistant')
 *   • upload receipts                  (role 'user',  kind 'upload')
 *   • system notices                   (role 'system')
 *   • trust-engine report-backs        (role 'trust', written by the sweep when a
 *                                        ceo-chat task acks/progresses/completes)
 *
 * GET /api/ceo-chat/history reads it; the trust engine writes into it for the
 * ceo-chat channel (one trust engine, two channels — P5-01 step 2). All timestamps
 * are canonical ISO-UTC (db.timeNow) so ordering never hits the timestamp-dialect
 * trap (see src/lib/db B2).
 */
import { v4 as uuidv4 } from 'uuid';
import { queryAll, run, timeNow } from '@/lib/db';

export type CeoChatRole = 'user' | 'assistant' | 'system' | 'trust';

export interface CeoChatMessage {
  id: string;
  session_id: string;
  role: CeoChatRole;
  content: string;
  kind: string;
  task_id: string | null;
  attachment_path: string | null;
  attachment_name: string | null;
  attachment_type: string | null;
  attachment_size: number | null;
  /** U62 (JM/U65, master E.2) / migration 110 — the gateway's real per-turn
   *  token accounting (U61/S3), NULL unless a usage frame was actually
   *  captured for this turn (never a fabricated estimate — the ContextMeter
   *  stays in `≈` mode when these are null). */
  usage_input: number | null;
  usage_output: number | null;
  usage_total: number | null;
  created_at: string;
}

export interface InsertCeoChatMessage {
  sessionId: string;
  role: CeoChatRole;
  content: string;
  kind?: string;
  taskId?: string | null;
  attachmentPath?: string | null;
  attachmentName?: string | null;
  attachmentType?: string | null;
  attachmentSize?: number | null;
  /** U62 — real gateway usage for this turn (see CeoChatMessage above). */
  usageInput?: number | null;
  usageOutput?: number | null;
  usageTotal?: number | null;
}

/**
 * Insert one chat event and return the persisted row. Callers pass an
 * already-validated payload; this never validates (the route/validator owns that).
 */
export function insertCeoChatMessage(input: InsertCeoChatMessage): CeoChatMessage {
  const id = uuidv4();
  const createdAt = timeNow();
  run(
    `INSERT INTO ceo_chat_messages
       (id, session_id, role, content, kind, task_id,
        attachment_path, attachment_name, attachment_type, attachment_size,
        usage_input, usage_output, usage_total, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sessionId,
      input.role,
      input.content,
      input.kind ?? 'message',
      input.taskId ?? null,
      input.attachmentPath ?? null,
      input.attachmentName ?? null,
      input.attachmentType ?? null,
      input.attachmentSize ?? null,
      input.usageInput ?? null,
      input.usageOutput ?? null,
      input.usageTotal ?? null,
      createdAt,
    ],
  );
  return {
    id,
    session_id: input.sessionId,
    role: input.role,
    content: input.content,
    kind: input.kind ?? 'message',
    task_id: input.taskId ?? null,
    attachment_path: input.attachmentPath ?? null,
    attachment_name: input.attachmentName ?? null,
    attachment_type: input.attachmentType ?? null,
    attachment_size: input.attachmentSize ?? null,
    usage_input: input.usageInput ?? null,
    usage_output: input.usageOutput ?? null,
    usage_total: input.usageTotal ?? null,
    created_at: createdAt,
  };
}

/**
 * The trust engine's report-back into the ceo-chat channel. Written by the sweep
 * (via the default sender in trust-engine.ts) so an ack/progress/done for a
 * ceo-chat task renders as a chat event in THIS UI instead of going to Telegram.
 * `kind` distinguishes the three trust messages so the UI can style them.
 *
 * `taskId` (J.0.7 threading fix, U60/JM-U63c): the trust engine's stamp op
 * already carries the task id in hand (`StampOp.taskId`) but previously
 * dropped it here, so a report-back row could never be joined back to the
 * Operations Rail card that spawned it. Additive + defaulted to `null` so
 * every pre-existing call site (and every already-written row) is untouched.
 */
export function appendTrustMessage(
  sessionId: string,
  message: string,
  kind: 'trust_ack' | 'trust_progress' | 'trust_done' = 'trust_progress',
  taskId: string | null = null,
): CeoChatMessage {
  return insertCeoChatMessage({ sessionId, role: 'trust', content: message, kind, taskId });
}

/**
 * Read a session's transcript in chronological order. `limit` caps the newest N
 * rows (default 200) so a long-running session never returns an unbounded page.
 */
export function getCeoChatHistory(sessionId: string, limit = 200): CeoChatMessage[] {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  // Take the newest `safeLimit` rows, then return them oldest-first so the UI can
  // append straightforwardly. `rowid` (aliased _rid) is the insertion-order
  // tiebreak for rows sharing a millisecond; it is carried out of the inner
  // subquery under an alias because a bare `rowid` is not a column of a derived
  // table (SQLite: "no such column: rowid"). The outer SELECT lists explicit
  // columns so _rid never leaks into the returned row shape.
  const rows = queryAll<CeoChatMessage>(
    `SELECT id, session_id, role, content, kind, task_id,
            attachment_path, attachment_name, attachment_type, attachment_size,
            usage_input, usage_output, usage_total, created_at
       FROM (
         SELECT *, rowid AS _rid FROM ceo_chat_messages
          WHERE session_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
       ) ORDER BY created_at ASC, _rid ASC`,
    [sessionId, safeLimit],
  );
  return rows;
}
