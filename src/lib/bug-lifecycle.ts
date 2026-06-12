/**
 * bug-lifecycle.ts -- T3-001 Bug Ticket state machine.
 *
 * Mirrors the shape of task-lifecycle.ts but for bug_tickets exclusively.
 * The 7 bug stages (REPORTED -> TRIAGED -> HEALING -> VERIFYING -> HEALED ->
 * REGRESSION WATCH -> CLOSED) are entirely separate from TaskStatus and the
 * tasks table -- do NOT import or reuse task-lifecycle.ts here.
 *
 * Transition ownership (from spec SOP B-9.x):
 *   REPORTED         Bug Intake Clerk on intake (default state).
 *   TRIAGED          Triage & Dedup Analyst after SOP B-9.2.
 *   HEALING          Assigned dept Healer when healing begins.
 *   VERIFYING        Healer when fix applied + regression running.
 *   HEALED           Healer when regression green + healing report sent.
 *   REGRESSION WATCH Bug Librarian per SOP B-9.5.
 *   CLOSED           Bug Librarian after watch window expires cleanly.
 *
 * Plus: any state -> REPORTED (reopen on recurrence, increments recurrence_count).
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { BugStatus, BugTicket } from '@/lib/types';

// ---------------------------------------------------------------------------
// State machine definition
// ---------------------------------------------------------------------------

/**
 * Legal transitions: from -> Set<to>
 * The linear happy path is enforced; reopening (any -> REPORTED) is always
 * allowed so a recurring bug creates a trail via recurrence_count.
 */
export const BUG_LEGAL_TRANSITIONS: Record<BugStatus, Set<BugStatus>> = {
  'REPORTED':         new Set<BugStatus>(['TRIAGED', 'CLOSED']),
  'TRIAGED':          new Set<BugStatus>(['HEALING', 'REPORTED']),
  'HEALING':          new Set<BugStatus>(['VERIFYING', 'TRIAGED']),
  'VERIFYING':        new Set<BugStatus>(['HEALED', 'HEALING']),
  'HEALED':           new Set<BugStatus>(['REGRESSION WATCH', 'HEALING']),
  'REGRESSION WATCH': new Set<BugStatus>(['CLOSED', 'HEALING']),
  'CLOSED':           new Set<BugStatus>(['REPORTED']), // reopen only
};

export class BugTransitionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BugTransitionError';
  }
}

export interface BugTransitionEvidence {
  actor?: string | null;
  reason?: string;
}

// ---------------------------------------------------------------------------
// transitionBug -- the single mutation point for bug_tickets.status
// ---------------------------------------------------------------------------

interface BugRow {
  id: string;
  status: BugStatus;
  recurrence_count: number;
  workspace_id: string;
}

/**
 * Advance (or reopen) a bug ticket from its current status to `toStatus`.
 *
 * - Validates legality via BUG_LEGAL_TRANSITIONS.
 * - Writes a bug_ticket_events row (audit trail).
 * - Updates bug_tickets.status (+ recurrence_count on reopen, closed_at on CLOSED).
 * - Broadcasts SSE { type: 'bug_updated' }.
 * - Returns the updated BugTicket row.
 *
 * Throws BugTransitionError (code 'ILLEGAL_TRANSITION') on invalid moves.
 */
export async function transitionBug(
  bugId: string,
  toStatus: BugStatus,
  evidence: BugTransitionEvidence = {},
): Promise<BugTicket> {
  const row = queryOne<BugRow>(
    'SELECT id, status, recurrence_count, workspace_id FROM bug_tickets WHERE id = ?',
    [bugId],
  );

  if (!row) {
    throw new BugTransitionError('NOT_FOUND', `Bug ticket not found: ${bugId}`);
  }

  const fromStatus = row.status;

  // Idempotent: same-state is a no-op
  if (fromStatus === toStatus) {
    const current = queryOne<BugTicket>('SELECT * FROM bug_tickets WHERE id = ?', [bugId]);
    return current!;
  }

  // Validate the transition
  const legalSet = BUG_LEGAL_TRANSITIONS[fromStatus];
  if (!legalSet.has(toStatus)) {
    throw new BugTransitionError(
      'ILLEGAL_TRANSITION',
      `Cannot transition bug ${bugId} from ${fromStatus} to ${toStatus}. ` +
        `Legal next states: [${Array.from(legalSet).join(', ')}]`,
    );
  }

  const now = new Date().toISOString();
  const eventId = uuidv4();

  // Build the UPDATE columns
  const isReopen = toStatus === 'REPORTED' && fromStatus !== 'REPORTED';
  const isClosed = toStatus === 'CLOSED';

  // Write event + update in a transaction-like sequence (both are synchronous with better-sqlite3)
  run(
    `INSERT INTO bug_ticket_events (id, bug_id, from_status, to_status, actor, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [eventId, bugId, fromStatus, toStatus, evidence.actor ?? null, evidence.reason ?? null, now],
  );

  if (isReopen) {
    run(
      `UPDATE bug_tickets
       SET status = ?, recurrence_count = recurrence_count + 1, updated_at = ?
       WHERE id = ?`,
      [toStatus, now, bugId],
    );
  } else if (isClosed) {
    run(
      `UPDATE bug_tickets SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?`,
      [toStatus, now, now, bugId],
    );
  } else {
    run(
      `UPDATE bug_tickets SET status = ?, updated_at = ? WHERE id = ?`,
      [toStatus, now, bugId],
    );
  }

  // Broadcast SSE for live-board updates.
  // We fetch the updated row first, then broadcast so listeners get the full snapshot.
  const updated = queryOne<BugTicket>('SELECT * FROM bug_tickets WHERE id = ?', [bugId]);

  // Cast to 'never' since the SSEEvent union does not yet enumerate BugTicket payloads;
  // the broadcast channel is untyped at runtime -- consumers just re-fetch on bug_updated.
  broadcast({ type: 'bug_updated', payload: updated as never });

  return updated!;
}
