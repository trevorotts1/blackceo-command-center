/**
 * CWE-035 kanban journal appends (Sections 18, 19, 20).
 *
 * The CWE-005 schema freezes the council_events type vocabulary (the
 * CWE-003 event list enforced by a database CHECK), and it has no
 * kanban-specific event type. Following the coordinator-accepted CWE-038
 * precedent, plan and scan lifecycle facts are journaled as
 * `operation_completed` events whose payload carries the discriminator
 * `kind: 'council_kanban'` plus a specific `action`. A dedicated event
 * type remains a CWE-003 amendment candidate for CWE-050.
 *
 * The append below reproduces CWE-006's hash chain EXACTLY (same
 * canonicalHash input, same 1-based sequence, same empty-string genesis
 * prev_hash), so CouncilRepositories.verifyChain verifies these events
 * as part of the one session chain. Appends assume the caller's
 * transaction context: services wrap multi-write operations in a single
 * better-sqlite3 transaction and call this inside it.
 */
import type Database from 'better-sqlite3';
import { canonicalHash, canonicalStringify } from '../contracts';

export const KANBAN_JOURNAL_KIND = 'council_kanban';
export const KANBAN_JOURNAL_EVENT_TYPE = 'operation_completed';

export interface KanbanJournalScope {
  tenant_id: string;
  company_id: string;
}

export interface KanbanJournalEntry {
  sequence: number;
  event_id: string;
  action: string;
  actor_subject: string;
  created_at: string;
  /** The full payload (kind discriminator included). */
  payload: Record<string, unknown>;
}

/**
 * Append one kanban lifecycle event to the session's hash-chained
 * journal. Must be called inside the caller's write transaction when the
 * event accompanies other writes.
 */
export function appendKanbanJournalEvent(
  db: Database.Database,
  scope: KanbanJournalScope,
  sessionId: string,
  input: {
    eventId: string;
    actorSubject: string;
    action: string;
    createdAt: string;
    data: Record<string, unknown>;
  },
): { sequence: number; event_hash: string } {
  const payload: Record<string, unknown> = {
    kind: KANBAN_JOURNAL_KIND,
    action: input.action,
    ...input.data,
  };
  const last = db
    .prepare(
      `SELECT sequence, event_hash FROM council_events
        WHERE tenant_id = ? AND company_id = ? AND session_id = ?
        ORDER BY sequence DESC LIMIT 1`,
    )
    .get(scope.tenant_id, scope.company_id, sessionId) as
    | { sequence: number; event_hash: string }
    | undefined;
  const sequence = (last?.sequence ?? 0) + 1;
  const prevHash = last?.event_hash ?? '';
  const payloadJson = canonicalStringify(payload);
  const eventHash = canonicalHash({
    tenant_id: scope.tenant_id,
    company_id: scope.company_id,
    session_id: sessionId,
    sequence,
    type: KANBAN_JOURNAL_EVENT_TYPE,
    payload_json: payloadJson,
    prev_hash: prevHash,
    created_at: input.createdAt,
  });
  db.prepare(
    `INSERT INTO council_events
       (tenant_id, company_id, session_id, sequence, id, type, from_state, to_state,
        actor_subject, payload_json, prev_hash, event_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scope.tenant_id,
    scope.company_id,
    sessionId,
    sequence,
    input.eventId,
    KANBAN_JOURNAL_EVENT_TYPE,
    null,
    null,
    input.actorSubject,
    payloadJson,
    prevHash,
    eventHash,
    input.createdAt,
  );
  return { sequence, event_hash: eventHash };
}

/** All kanban lifecycle entries for a session, in journal order. */
export function listKanbanJournalEntries(
  db: Database.Database,
  scope: KanbanJournalScope,
  sessionId: string,
): KanbanJournalEntry[] {
  const rows = db
    .prepare(
      `SELECT sequence, id, actor_subject, payload_json, created_at
         FROM council_events
        WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND type = ?
        ORDER BY sequence ASC`,
    )
    .all(scope.tenant_id, scope.company_id, sessionId, KANBAN_JOURNAL_EVENT_TYPE) as Array<{
    sequence: number;
    id: string;
    actor_subject: string;
    payload_json: string;
    created_at: string;
  }>;
  const entries: KanbanJournalEntry[] = [];
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (payload.kind !== KANBAN_JOURNAL_KIND) continue;
    entries.push({
      sequence: row.sequence,
      event_id: row.id,
      action: typeof payload.action === 'string' ? payload.action : '',
      actor_subject: row.actor_subject,
      created_at: row.created_at,
      payload,
    });
  }
  return entries;
}

/** The most recent kanban journal entry with the given action, if any. */
export function latestKanbanJournalEntry(
  db: Database.Database,
  scope: KanbanJournalScope,
  sessionId: string,
  action: string,
): KanbanJournalEntry | null {
  const entries = listKanbanJournalEntries(db, scope, sessionId);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].action === action) return entries[i];
  }
  return null;
}
