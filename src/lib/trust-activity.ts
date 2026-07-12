/**
 * trust-activity.ts — surface the trust engine's report-back trail in the
 * task's Activity tab (P2-02 step 4).
 *
 * The trust engine (src/lib/jobs/trust-engine.ts, P1-04) records every send it
 * makes as an `events` row typed `trust_ack` / `trust_progress` / `trust_done`,
 * with a message shaped `"<type> -> <chatId>: <client message>"` (best-effort
 * operator telemetry). The Activity tab reads `task_activities` — a DIFFERENT
 * table — so that ack/progress/done trail was written but never SHOWN.
 *
 * This module is the pure mapping seam the /api/tasks/[id]/activities route uses
 * to fold those events into the activity feed. It extracts the CLIENT-FACING
 * message (dropping the `trust_x -> <chatId>:` telemetry prefix so a chat id
 * never leaks into the UI) and shapes each event as a TaskActivity so the
 * existing ActivityLog renders it with zero component changes to its data path.
 */

import type { TaskActivity } from './types';

/** The three P1-04 report-back event types the trust engine writes to `events`. */
export const TRUST_EVENT_TYPES = ['trust_ack', 'trust_progress', 'trust_done'] as const;

export type TrustEventType = (typeof TRUST_EVENT_TYPES)[number];

/** A raw `events` row as read from the DB (only the columns we need). */
export interface TrustEventRow {
  id: string;
  type: string;
  task_id: string;
  message: string;
  created_at: string;
}

export function isTrustEventType(t: string): t is TrustEventType {
  return (TRUST_EVENT_TYPES as readonly string[]).includes(t);
}

/**
 * Strip the `"trust_x -> <chatId>: "` telemetry prefix, returning the actual
 * client-facing message. Resilient: a message that carries no prefix (or a
 * differently-shaped one) is returned trimmed and verbatim rather than mangled.
 */
export function extractClientMessage(raw: string): string {
  const msg = (raw ?? '').trim();
  // Only strip when the line genuinely begins with a trust telemetry prefix of the
  // form "<trust_type> -> <token>: <rest>" — anchored so an unrelated ": " inside a
  // real message is never used as the split point.
  //
  // The body is `[\s\S]*` (zero-or-more), NOT `+`: a prefix-ONLY telemetry row such
  // as "trust_ack -> 55512345:" (or "…: " once trimmed) carries an EMPTY client body.
  // With `+` that empty-body case failed the whole match and the raw string — prefix
  // AND chat id — was returned verbatim and leaked into the Activity UI. With `*` the
  // prefix still matches and the empty body correctly extracts to '' (no id leak).
  const m = msg.match(/^trust_(?:ack|progress|done)(?:\([^)]*\))?\s*->\s*[^:]*:\s*([\s\S]*)$/);
  return m ? m[1].trim() : msg;
}

/**
 * Map a trust-engine `events` row into a TaskActivity so the Activity feed can
 * render it alongside the real task_activities rows. The synthetic id is
 * namespaced (`trust-evt:<id>`) so it can never collide with a task_activities
 * id and React keys stay stable.
 */
export function trustEventToActivity(row: TrustEventRow): TaskActivity {
  return {
    id: `trust-evt:${row.id}`,
    task_id: row.task_id,
    activity_type: row.type as TaskActivity['activity_type'],
    message: extractClientMessage(row.message),
    created_at: row.created_at,
  };
}
