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
 * Strip the `"trust_x(<route>) -> <address>: "` telemetry prefix, returning the
 * actual client-facing message. Resilient: a message that carries no prefix (or
 * a differently-shaped one) is returned trimmed and verbatim rather than mangled.
 */
export function extractClientMessage(raw: string): string {
  const msg = (raw ?? '').trim();
  // Only strip when the line genuinely begins with a trust telemetry prefix of the
  // form "<trust_type>(<annotation>) -> <address>: <rest>" — anchored so an
  // unrelated ": " inside a real message is never used as the split point. The
  // optional parenthesized annotation carries the send variant and, since
  // WEBCHAT-REQUESTER-ROUTE, the route that delivered it (`trust_ack(session)`).
  const m = msg.match(/^trust_(?:ack|progress|done)(?:\([^)]*\))?\s*->\s*([\s\S]*)$/);
  if (!m) return msg;
  const rest = m[1];

  // The address is NOT colon-free: a gateway session key is `agent:<id>:<peer>`.
  // Splitting on the FIRST colon (the old `[^:]*` pattern) left "main:<peer>: …"
  // as the "client message" and leaked the requester's session key straight into
  // the Activity UI — the exact id-leak this function exists to prevent. Split on
  // the first colon-SPACE instead: the address never contains whitespace, so the
  // first ": " is always the real prefix/body boundary.
  const bodyAt = rest.indexOf(': ');
  if (bodyAt !== -1) return rest.slice(bodyAt + 2).trim();

  // No colon-space anywhere => a prefix-ONLY row with an EMPTY client body, e.g.
  // "trust_ack -> 55512345:" (a bare ack). Everything up to the LAST colon is the
  // address; whatever follows — usually nothing — is the body. Zero-or-more, not
  // one-or-more: with a `+` the empty-body case failed the match entirely and the
  // raw string (prefix AND id) was returned verbatim.
  const lastColon = rest.lastIndexOf(':');
  return lastColon === -1 ? msg : rest.slice(lastColon + 1).trim();
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
