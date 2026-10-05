/**
 * Company Headquarters — activity append helper (unit B05, milestone V04).
 *
 * Authority: SPEC.md revision 4, S5 (activity and real communication), S6
 * (storage and retention), S7 (producer envelope). `appendHqActivity` is the
 * ONLY writer of Headquarters activity (S5: "Proposed `appendHqActivity(db,
 * input)` is the **only writer** of Headquarters activity."). Every other HQ
 * module reads these rows; none inserts them.
 *
 * SERVER-ONLY: like every other `src/lib/hq/*` module this file is imported by
 * server routes only. It takes a `better-sqlite3` handle and uses `node:crypto`
 * to recompute the content hash inside the transaction, so it must never be
 * imported from a client component. `./types` stays the client-importable half.
 *
 * Table shapes are the frozen SPEC S6 ones (`hq_activity`, `hq_activity_state`,
 * `hq_activity_receipts`). Their DDL is owned by B01's reserved additive
 * migration; this module creates nothing and checks nothing into schema.ts.
 * Two SPEC S6 facts have no column in the frozen DDL and are therefore DERIVED
 * here rather than invented as schema: per-row `payload_bytes` is
 * `length(CAST(payload_json AS BLOB))` (UTF-8 bytes, not characters) and
 * `retained_bytes` is its `SUM` over the company's retained rows.
 */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  hqProducerEventSchema,
  hqSemanticSerialize,
  type HqActivityEvent,
  type HqActivityKind,
  type HqPublicActivityPayload,
  type HqProducerEvent,
} from './types';

/* ================================================================== *
 * SPEC S6 / S7 bounds — the exact numbers the SPEC fixes
 * ================================================================== */

/** S6: public feed holds at most 5,000 rows per company. */
export const HQ_ACTIVITY_ROW_CAP = 5000;
/** S6: at most 32 MiB of encoded payload bytes per company. */
export const HQ_ACTIVITY_BYTE_CAP = 32 * 1024 * 1024;
/** S6: receipts retain for 48 hours after FIRST acceptance (never refreshed on retry). */
export const HQ_RECEIPT_TTL_MS = 48 * 60 * 60 * 1000;
/** S6: at most 100,000 unexpired receipt keys per company. */
export const HQ_RECEIPT_CAP = 100_000;
/** S7: original `issuedAt` older than 24 hours is expired (`410 event_expired`). */
export const HQ_ISSUED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** S7: `issuedAt` more than five minutes in the future is rejected (422). */
export const HQ_ISSUED_MAX_FUTURE_MS = 5 * 60 * 1000;

/* ================================================================== *
 * Append contract
 * ================================================================== */

export type HqAppendInput = {
  /** Trusted company resolved server-side (S7), never read from the request body. */
  companyId: string;
  /** Trusted installation resolved server-side (S7). */
  installationId: string;
  /** Validated S7 producer event. Re-validated here: this is the last boundary before storage. */
  event: HqProducerEvent;
  /** Receiver clock override, in ms. Defaults to `Date.now()`; exists so tests are deterministic. */
  nowMs?: number;
};

export type HqAppendResult =
  | {
      status: 'appended';
      duplicate: false;
      eventId: string;
      /** Global cursor value assigned to the new row. */
      seq: number;
      /** Highest seq evicted by the insertion-time bounds in this append, else null. */
      evictedThroughSeq: number | null;
    }
  | {
      status: 'duplicate';
      duplicate: true;
      eventId: string;
      /** Seq of the first acceptance. `visible` is false when the feed no longer retains that row. */
      originalSeq: number;
      visible: boolean;
    }
  | { status: 'conflict'; code: 'content_conflict'; eventId: string }
  | { status: 'event_expired'; code: 'event_expired' }
  | { status: 'event_not_yet_valid'; code: 'event_not_yet_valid' }
  | { status: 'receipt_capacity'; code: 'receipt_capacity' }
  | { status: 'oversize'; code: 'insufficient_retention_capacity' }
  | { status: 'foreign_source_id'; code: 'foreign_source_id' }
  | { status: 'invalid_event'; code: 'invalid_event' }
  | {
      /** The append rolled back its own savepoint and recorded capture degradation.
       *  Already-authorized business work in the caller's transaction is untouched (S5). */
      status: 'capture_failed';
      code: 'capture_failed';
      reason: string;
    };

/**
 * The ONLY writer of HQ activity (SPEC S5).
 *
 * Call it after the underlying source action is recorded, or inside the source
 * transaction (same database) so the append joins that transaction through its
 * own savepoint. A telemetry failure rolls back only this helper's work and
 * returns `capture_failed`: it never throws into the caller's business
 * transaction and never rolls back already-authorized business work.
 *
 * Dedup rules (S5/S6): same `(company_id, source_key)` + same content hash is a
 * duplicate success; same key + different hash is a conflict, recorded
 * diagnostically and never overwritten. Receipts outlive feed eviction for 48
 * hours, so a retry still dedupes after the visible row is pruned.
 */
export function appendHqActivity(db: Database.Database, input: HqAppendInput): HqAppendResult {
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const parsed = hqProducerEventSchema.safeParse(input.event);
  if (!parsed.success) return { status: 'invalid_event', code: 'invalid_event' };
  const event = parsed.data;

  // S7: forged company/actor/installation are rejected before persistence. The
  // trusted values come from the resolved request context, never from the body.
  if (event.companyId !== input.companyId) return { status: 'foreign_source_id', code: 'foreign_source_id' };
  if (event.installationId !== input.installationId) return { status: 'foreign_source_id', code: 'foreign_source_id' };

  // S7: the RECEIVER's clock decides expiry, not the producer's.
  const issuedMs = Date.parse(event.issuedAt);
  if (!Number.isFinite(issuedMs)) return { status: 'invalid_event', code: 'invalid_event' };
  if (nowMs - issuedMs > HQ_ISSUED_MAX_AGE_MS) return { status: 'event_expired', code: 'event_expired' };
  if (issuedMs - nowMs > HQ_ISSUED_MAX_FUTURE_MS) return { status: 'event_not_yet_valid', code: 'event_not_yet_valid' };

  let canonicalEvent: string;
  let payloadJson: string;
  try {
    // S7 canonical bytes: sorted keys, no whitespace, integers only, no lone
    // surrogates. `hqSemanticSerialize` throws on any of those, which is a
    // rejection, not a capture failure.
    canonicalEvent = hqSemanticSerialize(event);
    payloadJson = hqSemanticSerialize(storedPayload(event));
  } catch {
    return { status: 'invalid_event', code: 'invalid_event' };
  }

  const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');
  if (payloadBytes > HQ_ACTIVITY_BYTE_CAP) {
    // No eviction can bring the feed under the byte bound if one row exceeds it,
    // so this refusal is the only honest outcome. The caller maps it to 413.
    return { status: 'oversize', code: 'insufficient_retention_capacity' };
  }
  const contentHash = createHash('sha256').update(canonicalEvent, 'utf8').digest('hex');

  try {
    // When the caller is already inside a business transaction, better-sqlite3
    // runs this nested transaction as a SAVEPOINT: a throw here rolls back only
    // these writes. Standalone, it is an ordinary transaction (S6: "Insert and
    // high-water update are one transaction").
    return db.transaction((): HqAppendResult => {
      const receipt = db
        .prepare('SELECT content_hash, original_seq FROM hq_activity_receipts WHERE company_id = ? AND source_key = ?')
        .get(input.companyId, event.sourceKey) as { content_hash: string; original_seq: number } | undefined;

      if (receipt) {
        // S5: same key/different content is a conflict "recorded diagnostically,
        // not overwrite" — the stored row and the receipt are both left alone.
        // `accepted_at` is never refreshed on a retry (S6).
        if (receipt.content_hash !== contentHash) return { status: 'conflict', code: 'content_conflict', eventId: event.eventId };
        const visible = !!db
          .prepare('SELECT 1 FROM hq_activity WHERE company_id = ? AND seq = ?')
          .get(input.companyId, receipt.original_seq);
        return { status: 'duplicate', duplicate: true, eventId: event.eventId, originalSeq: receipt.original_seq, visible };
      }

      // S6: cleanup FIRST removes expired receipts, then capacity is evaluated.
      db.prepare('DELETE FROM hq_activity_receipts WHERE company_id = ? AND accepted_at < ?').run(
        input.companyId,
        new Date(nowMs - HQ_RECEIPT_TTL_MS).toISOString(),
      );
      const liveReceipts = db
        .prepare('SELECT COUNT(*) AS n FROM hq_activity_receipts WHERE company_id = ?')
        .get(input.companyId) as { n: number };
      if (liveReceipts.n >= HQ_RECEIPT_CAP) {
        // S6: reject the new distinct event, record capture degradation, and
        // preserve every live dedup key (nothing above evicted an unexpired one).
        markCaptureDegraded(db, input.companyId, nowIso);
        return { status: 'receipt_capacity', code: 'receipt_capacity' };
      }

      // S6: "nullable source IDs, validated same-company before insert".
      if (!sourcesBelongToCompany(db, input.companyId, event)) return { status: 'foreign_source_id', code: 'foreign_source_id' };

      const info = db
        .prepare(
          `INSERT INTO hq_activity
             (id, company_id, source_key, content_hash, kind, task_id, actor_agent_id, recipient_agent_id,
              from_workspace_id, to_workspace_id, exchange_id, phase, payload_json, occurred_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(), // S6: the row `id` is a server UUID; eventId is a separate representation.
          input.companyId,
          event.sourceKey,
          contentHash,
          event.kind,
          event.taskId,
          event.actorRuntimeId,
          event.recipientRuntimeId,
          event.fromWorkspaceId,
          event.toWorkspaceId,
          event.exchangeId,
          event.phase,
          payloadJson,
          event.occurredAt,
          nowIso,
        );
      const seq = Number(info.lastInsertRowid);

      db.prepare(
        `INSERT INTO hq_activity_receipts (company_id, source_key, content_hash, issued_at, accepted_at, original_seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.companyId, event.sourceKey, contentHash, event.issuedAt, nowIso, seq);

      // S6 insertion-time bounds, in the SAME transaction as the insert. Gaps are
      // legal; `high_seq` never decreases even when everything above it is pruned.
      const evictedThroughSeq = enforceInsertionBounds(db, input.companyId);
      // A recorded capture failure is NOT cleared by a later success. A success
      // proves the pipeline works now; it cannot prove the earlier failure
      // dropped nothing, and this table has no dropped-count column to remember
      // it with (the SPEC's "degraded with dropped-count" shape is gap G-18,
      // owned by B08). So the state is monotone here: only a unit that owns
      // capture-health shape and holds a real reconciled count may clear it.
      db.prepare(
        `INSERT INTO hq_activity_state (company_id, high_seq, pruned_through_seq, capture_state, updated_at)
         VALUES (?, ?, ?, 'ok', ?)
         ON CONFLICT(company_id) DO UPDATE SET
           high_seq = MAX(high_seq, excluded.high_seq),
           pruned_through_seq = MAX(pruned_through_seq, excluded.pruned_through_seq),
           capture_state = CASE WHEN capture_state = 'degraded' THEN 'degraded' ELSE 'ok' END,
           updated_at = excluded.updated_at`,
      ).run(input.companyId, seq, evictedThroughSeq ?? 0, nowIso);

      return { status: 'appended', duplicate: false, eventId: event.eventId, seq, evictedThroughSeq };
    })();
  } catch (err) {
    // S5: telemetry failure rolls back its OWN savepoint and records a bounded
    // capture-health failure. The caller's business transaction is untouched —
    // this never rethrows (rollback already happened inside better-sqlite3).
    markCaptureDegraded(db, input.companyId, nowIso);
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'capture_failed', code: 'capture_failed', reason: reason.slice(0, 200) };
  }
}

/* ================================================================== *
 * S5/S6 public projection (gaps G-08 and G-09)
 * ================================================================== */

/**
 * S5 public feed row. Field names are P01's frozen `HqActivityEvent` naming of
 * the SPEC's content list (source, actor/recipient labels from current scope,
 * occurred/received times, truthful phase, reference) — the row shape gap G-08
 * that this unit freezes.
 *
 * `reference` is the row's source key: the SPEC's own "explicit source
 * reference" for an exchange outside a CC-owned task (S5) and the JEV receipt's
 * recorded "source reference" (S5). The frozen DDL's per-column row type is
 * B01's (gap G-19); the parameter below is this function's structural input, so
 * B01's decoder output is assignable to it without either side redeclaring the
 * other's contract.
 */
export function toPublicActivityEvent(
  row: {
    id: string;
    seq: number;
    kind: HqActivityKind;
    phase: string;
    task_id: string | null;
    actor_agent_id: string | null;
    recipient_agent_id: string | null;
    payload_json: string;
    occurred_at: string | null;
    received_at: string;
    source_key: string;
  },
  resolveLabel: (agentId: string) => string | null,
): HqActivityEvent {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    phase: row.phase as HqActivityEvent['phase'],
    taskId: row.task_id ?? null,
    // S5 "labels from current scope": the caller resolves the current display
    // label. A removed or foreign target resolves to null (tombstone), and no
    // historical name is retained here.
    actorLabel: row.actor_agent_id ? resolveLabel(row.actor_agent_id) : null,
    recipientLabel: row.recipient_agent_id ? resolveLabel(row.recipient_agent_id) : null,
    occurredAt: row.occurred_at ?? null,
    receivedAt: row.received_at,
    reference: row.source_key,
    payload: toPublicPayload(row.kind, row.payload_json),
  };
}

/**
 * S5 "Allowlisted fields, not a generic JSON dump." S7: "These internal routing
 * keys are stripped from browser/public detail projection." Gap G-09 — the
 * exchange projection below keeps exactly `{message, summary}` from the frozen
 * `HqPublicExchangePayload` and drops toolCallId, callerRunId, targetRunId,
 * both session keys, sourceHook, nativeStatus, targetDisposition and
 * correlationStatus. Every branch builds a new object field by field; nothing
 * is spread, so a key nobody named can never reach the feed.
 */
export function toPublicPayload(kind: HqActivityKind, payloadJson: string): HqPublicActivityPayload {
  const raw = JSON.parse(payloadJson) as Record<string, unknown>;
  switch (kind) {
    case 'task':
      return { status: nullableString(raw.status), previousStatus: nullableString(raw.previousStatus) };
    case 'owner_note':
      return { text: requiredString(raw.text) };
    case 'decision':
      return {
        intent: nullableString(raw.intent),
        routeAction: nullableString(raw.routeAction),
        departmentSlug: nullableString(raw.departmentSlug),
        confidenceBps: nullableInteger(raw.confidenceBps),
        fallback: nullableBoolean(raw.fallback),
        mode: requiredString(raw.mode),
        resolvedBy: nullableString(raw.resolvedBy),
      };
    case 'exchange':
      return { message: nullableString(raw.message), summary: requiredString(raw.summary) };
  }
}

/* ================================================================== *
 * internals
 * ================================================================== */

/**
 * S5 structural safety at the write boundary: "**Before any text persistence**,
 * resolve caller ancestry ... Such an unbound exchange is coverage metadata
 * only: discard request/reply text before public outbox and never include it in
 * the company feed." An exchange with no task id has no proven task audience
 * (S7: "With no proven run map, taskId remains null"), so its message text is
 * never persisted, at the receiver as well as at the plugin. The summary stays:
 * it is the required non-null field and carries the action, not the text.
 */
function storedPayload(event: HqProducerEvent): unknown {
  if (event.kind === 'exchange' && event.taskId === null) return { ...event.payload, message: null };
  return event.payload;
}

/** S6: a source ID is acceptable only when it resolves to THIS company. Legacy
 *  unowned/default rows are excluded here by design — their Headquarters
 *  treatment is explicit in S3 and belongs to the roster projection (B03), not
 *  to the activity writer. */
function sourcesBelongToCompany(db: Database.Database, companyId: string, event: HqProducerEvent): boolean {
  const companyOf = db.prepare('SELECT company_id AS c FROM workspaces WHERE id = ?');
  // AMBIGUITY, named rather than guessed away: the envelope field is
  // `actorRuntimeId`/`recipientRuntimeId` (S7), which is a RUNTIME binding, and
  // SPEC S2 is explicit that "display and runtime IDs are not interchangeable by
  // convention" — `agents.openclaw_agent_id` (migration 133) is the runtime
  // binding. But the frozen S6 column is named `actor_agent_id`, and no frozen
  // contract states which id a producer actually sends here. Resolving against
  // BOTH bindings is strictly safer than picking one: a foreign company's agent
  // cannot satisfy either, because both paths require the workspace's company to
  // equal the trusted company. Which one a producer sends is a contract gap for
  // the first consumer that must display it (B07/B08) to freeze.
  const companyOfAgent = db.prepare(
    'SELECT w.company_id AS c FROM agents a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = ? OR a.openclaw_agent_id = ?',
  );
  const companyOfTask = db.prepare(
    'SELECT w.company_id AS c FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ?',
  );
  // Separate helpers, not one generic: better-sqlite3 is strict about the
  // parameter count, so each statement is bound with exactly its own arity.
  const sameCompany = (row: { c: string | null } | undefined): boolean => row !== undefined && row.c === companyId;
  const workspaceOk = (id: string | null): boolean =>
    id === null || sameCompany(companyOf.get(id) as { c: string | null } | undefined);
  const agentOk = (id: string | null): boolean =>
    id === null || sameCompany(companyOfAgent.get(id, id) as { c: string | null } | undefined);
  return (
    (event.taskId === null || sameCompany(companyOfTask.get(event.taskId) as { c: string | null } | undefined)) &&
    agentOk(event.actorRuntimeId) &&
    agentOk(event.recipientRuntimeId) &&
    workspaceOk(event.fromWorkspaceId) &&
    workspaceOk(event.toWorkspaceId)
  );
}

/**
 * S6: "In the same append transaction, evict the oldest contiguous prefix until
 * this company's public feed contains at most 5,000 rows AND at most 32 MiB of
 * encoded payload bytes." Returns the highest evicted seq, or null when the
 * feed was already inside both bounds.
 *
 * Byte accounting is derived, not stored: `payload_bytes` is the UTF-8 length
 * of the encoded payload (`CAST(... AS BLOB)` — SQLite `length()` on TEXT counts
 * CHARACTERS, which would under-count non-ASCII messages and let the byte bound
 * drift above 32 MiB). The walk is bounded by the row cap itself.
 */
function enforceInsertionBounds(db: Database.Database, companyId: string): number | null {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS b
       FROM hq_activity WHERE company_id = ?`,
    )
    .get(companyId) as { n: number; b: number };
  if (totals.n <= HQ_ACTIVITY_ROW_CAP && totals.b <= HQ_ACTIVITY_BYTE_CAP) return null;

  const rows = db
    .prepare(
      `SELECT seq, length(CAST(payload_json AS BLOB)) AS bytes
       FROM hq_activity WHERE company_id = ? ORDER BY seq ASC`,
    )
    .all(companyId) as { seq: number; bytes: number }[];

  let n = totals.n;
  let b = totals.b;
  let through: number | null = null;
  for (const row of rows) {
    if (n <= HQ_ACTIVITY_ROW_CAP && b <= HQ_ACTIVITY_BYTE_CAP) break;
    n -= 1;
    b -= row.bytes;
    through = row.seq;
  }
  if (through === null) return null;
  db.prepare('DELETE FROM hq_activity WHERE company_id = ? AND seq <= ?').run(companyId, through);
  return through;
}

/** The bounded capture-health failure S5 requires. Best-effort by design: a
 *  failure to record a failure must not become a new failure. */
function markCaptureDegraded(db: Database.Database, companyId: string, nowIso: string): void {
  try {
    db.prepare(
      `INSERT INTO hq_activity_state (company_id, high_seq, pruned_through_seq, capture_state, updated_at)
       VALUES (?, 0, 0, 'degraded', ?)
       ON CONFLICT(company_id) DO UPDATE SET capture_state = 'degraded', updated_at = excluded.updated_at`,
    ).run(companyId, nowIso);
  } catch {
    // Swallowed deliberately; see the function comment.
  }
}

/* Frozen-shape accessors. The append boundary only ever stores payloads that
 * passed the P01 schemas, so a value that is not the frozen shape is storage
 * corruption and must fail loudly instead of leaking "undefined" to the feed. */
function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('hq activity payload is not the frozen shape');
  return value;
}
function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}
function nullableInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new Error('hq activity payload is not the frozen shape');
  return value as number;
}
function nullableBoolean(value: unknown): boolean | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') throw new Error('hq activity payload is not the frozen shape');
  return value;
}
