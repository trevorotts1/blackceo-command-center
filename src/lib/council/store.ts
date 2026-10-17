/**
 * Council repository services (CWE-006, directive Sections 15, 16, 18).
 *
 * This is the CWE-006 repository layer for the Command Center host. It
 * builds on the CWE-005 adapter (src/lib/council/persistence), which
 * supplies the scoped storage shape over getDb(), and adds the
 * repository services the prose block assigns to CWE-006:
 *
 * - Scoped repository methods that require an authorization envelope:
 *   scope is enforced before content loads and before any write, and
 *   private sessions answer only to their recorded owner (Section
 *   11.1).
 * - Session lifecycle with state-version compare-and-swap against the
 *   canonical transition table (CWE-003 contracts).
 * - The atomic accepted-work commit: fence recheck, card insert,
 *   ordered journal event, and projection outbox intent in ONE short
 *   better-sqlite3 transaction. No network call, render, or
 *   notification happens inside a transaction. A duplicate commit of
 *   the same logical operation returns the original outcome and
 *   duplicates no card, event sequence, or outbox intent; a crash or
 *   fault between the operations rolls the whole unit back.
 * - The event journal with per-session gapless sequences and a hash
 *   chain that tampering cannot survive undetected (Section 18).
 * - The single diagnostic sink (Section 16.6): raw bodies are
 *   memory-only unless an explicit grant for one named session is on
 *   record and the contracts gate allows the capture after redaction;
 *   denied captures record only safe metadata. Byte counters come from
 *   stored rows, so limits survive restart; reads re-check revocation
 *   and the TTL deadline, so expired or revoked content is
 *   inaccessible before physical cleanup (T133, T134).
 * - Explicit deletion with a minimal non-content tombstone: late
 *   writes to a deleted session are blocked and never reconstitute
 *   it. Backup copies follow the host retention policy; nothing here
 *   claims immediate physical erasure from historical backups.
 * - Bounded busy behavior: writes retry lock contention a bounded
 *   number of times, then fail with a visible deferred error (T056)
 *   instead of blocking indefinitely or applying partially.
 *
 * Authority mode (Sections 4.5, 16.1): this service is the managed
 * authority's store. The mode is recorded by the host at installation
 * (the portable runtime's profile enforces the standalone side); this
 * layer never switches a session between authorities.
 *
 * Mapping notes (canonical contracts to the CWE-005 columnar schema)
 * mirror the portable runtime: SessionSpec JSON and the full
 * SessionStateRecord are carried in the journal payloads, the sessions
 * row stays the authoritative index for state, state_version,
 * brief_revision, archive flag, and cancellation_generation, and
 * consult verdicts store the contract JSON verbatim with the column
 * placeholder label INSUFFICIENT_EVIDENCE (the contract carries no
 * label for consults; the placeholder is never read back as a
 * recommendation).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { getDb, getDbPath } from '../db';
import {
  assertTransition,
  canonicalHash,
  canonicalStringify,
  evaluateCapture,
  sha256Hex,
  validateCard,
  validateDecisionBrief,
  validateDiagnosticRetentionPolicy,
  validateSessionSpec,
  validateSessionStateRecord,
  validateVerdict,
  type CouncilCard,
  type CouncilEventType,
  type DecisionBrief,
  type DiagnosticRetentionPolicy,
  type ScopeFields,
  type SessionSpec,
  type SessionState,
  type SessionStateRecord,
  type Verdict,
} from './contracts';
import { openCouncilStore, type CouncilStore } from './persistence/council-store';

// ---------------------------------------------------------------- errors

export type CouncilPersistenceErrorCode =
  | 'PERSISTENCE_CONFIG_INVALID'
  | 'PERSISTENCE_SCOPE_DENIED'
  | 'PERSISTENCE_SESSION_NOT_FOUND'
  | 'PERSISTENCE_SESSION_DELETED'
  | 'PERSISTENCE_STATE_CONFLICT'
  | 'PERSISTENCE_DUPLICATE_OPERATION'
  | 'PERSISTENCE_OPERATION_CONFLICT'
  | 'PERSISTENCE_STORE_DEFERRED'
  | 'PERSISTENCE_DIAGNOSTIC_DENIED'
  | 'PERSISTENCE_VALIDATION_FAILED'
  | 'PERSISTENCE_INTERNAL';

export class CouncilPersistenceError extends Error {
  readonly code: CouncilPersistenceErrorCode;
  readonly retryable: boolean;
  constructor(
    code: CouncilPersistenceErrorCode,
    message: string,
    options: { retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'CouncilPersistenceError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export class CouncilStoreDeferredError extends CouncilPersistenceError {
  readonly attempts: number;
  readonly waitedMs: number;
  constructor(attempts: number, waitedMs: number) {
    super(
      'PERSISTENCE_STORE_DEFERRED',
      `The council database stayed locked through ${attempts} bounded attempt(s) over ${waitedMs} ms. The write was deferred, not dropped and not partially applied; retry when the lock clears.`,
      { retryable: true },
    );
    this.name = 'CouncilStoreDeferredError';
    this.attempts = attempts;
    this.waitedMs = waitedMs;
  }
}

// -------------------------------------------------------------- envelope

export type CouncilEnvelopeActor = 'owner' | 'system' | 'worker' | 'chair';
export type CouncilEnvelopePurpose =
  | 'read'
  | 'write'
  | 'delete'
  | 'diagnostic_capture'
  | 'diagnostic_read'
  | 'admin';

export interface CouncilEnvelope {
  tenant_id: string;
  company_id: string;
  installation_id: string;
  actor_subject: string;
  actor: CouncilEnvelopeActor;
  purpose: CouncilEnvelopePurpose;
}

export function envelopeFromScope(
  scope: ScopeFields,
  actorSubject: string,
  actor: CouncilEnvelopeActor,
  purpose: CouncilEnvelopePurpose,
): CouncilEnvelope {
  return {
    tenant_id: scope.tenant_id,
    company_id: scope.company_id,
    installation_id: scope.installation_id,
    actor_subject: actorSubject,
    actor,
    purpose,
  };
}

function scopeDenied(message: string): CouncilPersistenceError {
  return new CouncilPersistenceError('PERSISTENCE_SCOPE_DENIED', message);
}

function sessionNotFound(sessionId: string): CouncilPersistenceError {
  return new CouncilPersistenceError(
    'PERSISTENCE_SESSION_NOT_FOUND',
    `No council session ${sessionId} exists in this tenant and company scope.`,
  );
}

function sessionDeleted(sessionId: string): CouncilPersistenceError {
  return new CouncilPersistenceError(
    'PERSISTENCE_SESSION_DELETED',
    `Council session ${sessionId} was explicitly deleted. Its content is gone from the authoritative store and late writes are blocked.`,
  );
}

function stateConflict(message: string): CouncilPersistenceError {
  return new CouncilPersistenceError('PERSISTENCE_STATE_CONFLICT', message, {
    retryable: true,
  });
}

function assertPurpose(envelope: CouncilEnvelope, purpose: CouncilEnvelopePurpose, what: string): void {
  if (envelope.purpose !== purpose) {
    throw scopeDenied(
      `${what} requires an authorization envelope with purpose '${purpose}'; this envelope carries '${envelope.purpose}'.`,
    );
  }
}

function sessionVisibleToEnvelope(
  envelope: CouncilEnvelope,
  row: { visibility: string; owner_subject: string | null },
): boolean {
  if (row.visibility === 'company') return true;
  return row.owner_subject !== null && row.owner_subject === envelope.actor_subject;
}

// ------------------------------------------------------------------ types

/** A session as persisted by the store: spec, frozen brief, scope, state. */
export interface CouncilStoredSession {
  spec: SessionSpec;
  brief: DecisionBrief;
  scope: ScopeFields;
  state: SessionStateRecord;
  sample: boolean;
}

export interface CouncilJournalEvent {
  event_id: string;
  type: CouncilEventType;
  sequence: number;
  from_state: string | null;
  to_state: string | null;
  actor_subject: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  event_hash: string;
  created_at: string;
}

export interface CouncilOutboxIntent {
  id: string;
  session_id: string | null;
  event_sequence: number | null;
  topic: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  state: 'pending' | 'delivered' | 'failed' | 'dead_letter';
  attempt_count: number;
  created_at: string;
  delivered_at: string | null;
}

export type DiagnosticCaptureOutcome =
  | { stored: 'payload'; capture_id: string; byte_count: number; truncated: boolean; payload_deadline_at: string }
  | { stored: 'metadata'; capture_id: string; reason_code: string }
  | { stored: 'none'; reason_code: string };

export const DELETION_TOMBSTONE_SOURCE = 'council-persistence';
export const DELETION_TOMBSTONE_OPERATION = 'session_deleted';

const STATE_EVENT_TYPES: CouncilEventType[] = [
  'session_created',
  'session_state_changed',
  'session_paused',
  'session_cancelled',
  'session_blocked',
  'session_failed',
];

interface SessionRow {
  id: string;
  tenant_id: string;
  company_id: string;
  installation_id: string;
  owner_subject: string | null;
  archived: number;
  mode: string;
  visibility: string;
  state: string;
  state_version: number;
  brief_revision: number;
  brief_hash: string;
  cancellation_generation: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  sequence: number;
  id: string;
  type: string;
  from_state: string | null;
  to_state: string | null;
  actor_subject: string;
  payload_json: string;
  prev_hash: string;
  event_hash: string;
  created_at: string;
}

function isBusyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED') return true;
  return typeof e.message === 'string' && /database is locked|SQLITE_BUSY/i.test(e.message);
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Redact secret-shaped material before diagnostic capture (Section 16.6). */
export function defaultDiagnosticRedactor(body: string): string {
  return body
    .replace(
      /("(?:access_token|refresh_token|id_token|api_key|apikey|api-key|password|passwd|secret|client_secret|authorization|cookie|set-cookie)"\s*:\s*")[^"]*(")/gi,
      '$1[REDACTED]$2',
    )
    .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED]');
}

export interface CouncilRepositoryOptions {
  /** Adapter over getDb(); defaults to openCouncilStore(). */
  adapter?: CouncilStore;
  /** Protected diagnostic payload directory; defaults beside the host DB. */
  diagnosticsDir?: string;
  /** Bounded busy policy for writes (T056). */
  busyMaxAttempts?: number;
  busyBaseDelayMs?: number;
  /** Outbox attempts before an intent is parked as dead_letter. */
  outboxMaxAttempts?: number;
  now?: () => string;
  newId?: () => string;
  redact?: (body: string) => string | null;
}

/**
 * The CWE-006 repository service for the Command Center host. One
 * instance serves one host database; every method is scoped by its
 * envelope argument.
 */
export class CouncilRepositories {
  private readonly adapter: CouncilStore;
  private readonly db: Database.Database;
  private readonly diagnosticsDir: string;
  private readonly busyMaxAttempts: number;
  private readonly busyBaseDelayMs: number;
  private readonly outboxMaxAttempts: number;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly redact: (body: string) => string | null;

  constructor(options: CouncilRepositoryOptions = {}) {
    this.adapter = options.adapter ?? openCouncilStore();
    this.db = this.adapter.handle();
    this.diagnosticsDir =
      options.diagnosticsDir ?? join(dirname(getDbPath()), 'council-diagnostics');
    this.busyMaxAttempts = options.busyMaxAttempts ?? 4;
    this.busyBaseDelayMs = options.busyBaseDelayMs ?? 25;
    this.outboxMaxAttempts = options.outboxMaxAttempts ?? 5;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
    this.redact = options.redact ?? defaultDiagnosticRedactor;
  }

  // ------------------------------------------------------- transactions

  /**
   * Run one write unit in a single transaction under the bounded busy
   * policy. Exhaustion raises CouncilStoreDeferredError: the write is
   * visibly deferred, never partially applied (T056).
   */
  private write<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    let waitedMs = 0;
    for (let attempt = 1; attempt <= this.busyMaxAttempts; attempt += 1) {
      try {
        return tx();
      } catch (err) {
        if (!isBusyError(err)) throw err;
        if (attempt === this.busyMaxAttempts) {
          throw new CouncilStoreDeferredError(attempt, waitedMs);
        }
        const delay = Math.min(500, this.busyBaseDelayMs * 2 ** (attempt - 1));
        sleepSync(delay);
        waitedMs += delay;
      }
    }
    throw new CouncilStoreDeferredError(this.busyMaxAttempts, waitedMs);
  }

  private read<T>(fn: () => T): T {
    let waitedMs = 0;
    for (let attempt = 1; attempt <= this.busyMaxAttempts; attempt += 1) {
      try {
        return fn();
      } catch (err) {
        if (!isBusyError(err)) throw err;
        if (attempt === this.busyMaxAttempts) {
          throw new CouncilStoreDeferredError(attempt, waitedMs);
        }
        const delay = Math.min(500, this.busyBaseDelayMs * 2 ** (attempt - 1));
        sleepSync(delay);
        waitedMs += delay;
      }
    }
    throw new CouncilStoreDeferredError(this.busyMaxAttempts, waitedMs);
  }

  // ------------------------------------------------------------ sessions

  private sessionRow(envelope: CouncilEnvelope, sessionId: string): SessionRow | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, company_id, installation_id, owner_subject, archived,
                mode, visibility, state, state_version, brief_revision, brief_hash,
                cancellation_generation, created_at, updated_at
           FROM council_sessions
          WHERE tenant_id = ? AND company_id = ? AND id = ?`,
      )
      .get(envelope.tenant_id, envelope.company_id, sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  isDeleted(tenantId: string, sessionId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT request_key FROM council_request_keys
          WHERE tenant_id = ? AND source = ? AND operation = ? AND request_key = ?`,
      )
      .get(tenantId, DELETION_TOMBSTONE_SOURCE, DELETION_TOMBSTONE_OPERATION, sessionId) as
      | { request_key: string }
      | undefined;
    return row !== undefined;
  }

  private assertNotDeleted(envelope: CouncilEnvelope, sessionId: string): void {
    if (this.isDeleted(envelope.tenant_id, sessionId)) throw sessionDeleted(sessionId);
  }

  createSession(envelope: CouncilEnvelope, session: CouncilStoredSession): CouncilStoredSession {
    if (
      envelope.tenant_id !== session.scope.tenant_id ||
      envelope.company_id !== session.scope.company_id ||
      envelope.installation_id !== session.scope.installation_id
    ) {
      throw scopeDenied(
        'The authorization envelope scope does not match the record scope. Repository writes never cross a tenant, company, or installation boundary.',
      );
    }
    for (const [what, check] of [
      ['SessionSpec', validateSessionSpec(session.spec)],
      ['DecisionBrief', validateDecisionBrief(session.brief)],
      ['SessionStateRecord', validateSessionStateRecord(session.state)],
    ] as const) {
      if (!check.ok) {
        throw new CouncilPersistenceError(
          'PERSISTENCE_VALIDATION_FAILED',
          `${what} failed canonical contract validation and was not stored.`,
        );
      }
    }
    this.assertNotDeleted(envelope, session.spec.session_id);
    this.write(() => {
      if (this.sessionRow(envelope, session.spec.session_id)) {
        throw new CouncilPersistenceError(
          'PERSISTENCE_DUPLICATE_OPERATION',
          `Council session ${session.spec.session_id} already exists in this scope.`,
        );
      }
      this.db
        .prepare(
          `INSERT INTO council_sessions
             (id, tenant_id, company_id, installation_id, owner_subject, created_by_subject,
              archived, mode, visibility, state, state_version, brief_revision, brief_hash,
              selected_seats_json, cancellation_generation, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.spec.session_id,
          session.scope.tenant_id,
          session.scope.company_id,
          session.scope.installation_id,
          session.scope.owner_subject,
          envelope.actor_subject,
          session.state.archived ? 1 : 0,
          session.spec.mode,
          session.spec.visibility,
          session.state.state,
          session.state.state_version,
          session.state.brief_revision,
          session.spec.brief_sha256,
          canonicalStringify(session.spec.seat_ids),
          session.state.cancel_generation,
          session.spec.created_at,
          session.state.updated_at,
        );
      this.db
        .prepare(
          `INSERT INTO council_brief_revisions
             (tenant_id, company_id, session_id, revision, brief_json, canonical_hash,
              question, decision_type, stakes, deadline, reversibility,
              success_criteria_json, constraints_json, author_subject, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'general', 'not_recorded', NULL, 'not_recorded', '[]', ?, ?, ?)`,
        )
        .run(
          envelope.tenant_id,
          envelope.company_id,
          session.brief.session_id,
          session.brief.revision,
          canonicalStringify(session.brief),
          canonicalHash(session.brief),
          session.brief.question,
          canonicalStringify(session.brief.constraints),
          envelope.actor_subject,
          session.brief.created_at,
        );
      this.appendEventInTx(envelope, session.spec.session_id, {
        event_id: this.newId(),
        type: 'session_created',
        from_state: null,
        to_state: session.state.state,
        actor_subject: envelope.actor_subject,
        payload: { sample: session.sample, spec: session.spec, state_record: session.state },
        created_at: session.state.updated_at,
      });
    });
    return session;
  }

  getSession(envelope: CouncilEnvelope, sessionId: string): CouncilStoredSession | null {
    const row = this.read(() => this.sessionRow(envelope, sessionId));
    if (!row) return null;
    if (!sessionVisibleToEnvelope(envelope, row)) return null;
    return this.reconstruct(envelope, row);
  }

  private reconstruct(envelope: CouncilEnvelope, row: SessionRow): CouncilStoredSession {
    const created = this.latestEventOfType(envelope, row.id, ['session_created']);
    if (!created) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_INTERNAL',
        `Session ${row.id} has no session_created journal event; the store is inconsistent.`,
      );
    }
    const briefRow = this.db
      .prepare(
        `SELECT brief_json FROM council_brief_revisions
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND revision = ?`,
      )
      .get(envelope.tenant_id, envelope.company_id, row.id, row.brief_revision) as
      | { brief_json: string }
      | undefined;
    if (!briefRow) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_INTERNAL',
        `Session ${row.id} is missing brief revision ${row.brief_revision}; the store is inconsistent.`,
      );
    }
    const stateEvent = this.latestEventOfType(envelope, row.id, STATE_EVENT_TYPES);
    const journaled = stateEvent?.payload.state_record as SessionStateRecord | undefined;
    if (!journaled) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_INTERNAL',
        `Session ${row.id} has no journaled state record; the store is inconsistent.`,
      );
    }
    if (journaled.state_version !== row.state_version || journaled.state !== row.state) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_INTERNAL',
        `Session ${row.id} journal state (version ${journaled.state_version}) disagrees with the session row (version ${row.state_version}); refusing to serve a divergent record.`,
      );
    }
    return {
      spec: created.payload.spec as SessionSpec,
      brief: JSON.parse(briefRow.brief_json) as DecisionBrief,
      scope: {
        tenant_id: row.tenant_id,
        company_id: row.company_id,
        installation_id: row.installation_id,
        owner_subject: row.owner_subject,
      },
      state: {
        ...journaled,
        archived: row.archived === 1,
        cancel_generation: row.cancellation_generation,
      },
      sample: created.payload.sample === true,
    };
  }

  /**
   * Compare-and-swap state write. The caller validates transition
   * legality; this method guarantees a stale writer never overwrites a
   * newer record and journals the new record in the same transaction.
   */
  writeStateRecord(
    envelope: CouncilEnvelope,
    record: SessionStateRecord,
    expectedVersion: number,
  ): void {
    this.assertNotDeleted(envelope, record.session_id);
    this.write(() => {
      const row = this.sessionRow(envelope, record.session_id);
      if (!row) throw sessionNotFound(record.session_id);
      const result = this.db
        .prepare(
          `UPDATE council_sessions
              SET state = ?, state_version = ?, archived = ?,
                  cancellation_generation = ?, updated_at = ?
            WHERE tenant_id = ? AND company_id = ? AND id = ? AND state_version = ?`,
        )
        .run(
          record.state,
          record.state_version,
          record.archived ? 1 : 0,
          record.cancel_generation,
          record.updated_at,
          envelope.tenant_id,
          envelope.company_id,
          record.session_id,
          expectedVersion,
        );
      if (Number(result.changes) !== 1) {
        throw stateConflict(
          `Session ${record.session_id} changed underneath this writer (expected state version ${expectedVersion}, current ${row.state_version}).`,
        );
      }
      this.appendEventInTx(envelope, record.session_id, {
        event_id: this.newId(),
        type: 'session_state_changed',
        from_state: row.state,
        to_state: record.state,
        actor_subject: envelope.actor_subject,
        payload: { state_record: record },
        created_at: record.updated_at,
      });
    });
  }

  /** A legal, fenced state transition via the canonical transition table. */
  transitionState(
    envelope: CouncilEnvelope,
    sessionId: string,
    to: SessionState,
    expectedVersion: number,
  ): SessionStateRecord {
    const session = this.getSession(envelope, sessionId);
    if (!session) throw sessionNotFound(sessionId);
    const current = session.state;
    const enteringCancel = to === 'CANCEL_REQUESTED';
    const { stateVersion } = assertTransition({
      mode: current.mode,
      from: current.state,
      to,
      expectedVersion,
      currentVersion: current.state_version,
      actor: envelope.actor,
      resumePhase: current.resume_phase,
      cancelGeneration: enteringCancel ? current.cancel_generation + 1 : undefined,
      currentCancelGeneration: current.cancel_generation,
    });
    const next: SessionStateRecord = {
      ...current,
      state: to,
      state_version: stateVersion,
      cancel_generation: enteringCancel
        ? current.cancel_generation + 1
        : current.cancel_generation,
      resume_phase:
        to === 'PAUSED' || to === 'BLOCKED' ? current.state : current.resume_phase,
      updated_at: this.now(),
    };
    this.assertNotDeleted(envelope, sessionId);
    this.write(() => {
      const row = this.sessionRow(envelope, sessionId);
      if (!row) throw sessionNotFound(sessionId);
      const result = this.db
        .prepare(
          `UPDATE council_sessions
              SET state = ?, state_version = ?, archived = ?,
                  cancellation_generation = ?, updated_at = ?
            WHERE tenant_id = ? AND company_id = ? AND id = ? AND state_version = ?`,
        )
        .run(
          next.state,
          next.state_version,
          next.archived ? 1 : 0,
          next.cancel_generation,
          next.updated_at,
          envelope.tenant_id,
          envelope.company_id,
          sessionId,
          expectedVersion,
        );
      if (Number(result.changes) !== 1) {
        throw stateConflict(
          `Session ${sessionId} changed underneath this writer (expected state version ${expectedVersion}, current ${row.state_version}).`,
        );
      }
      const eventType: CouncilEventType =
        to === 'PAUSED'
          ? 'session_paused'
          : to === 'CANCELLED'
            ? 'session_cancelled'
            : to === 'BLOCKED'
              ? 'session_blocked'
              : to === 'FAILED'
                ? 'session_failed'
                : 'session_state_changed';
      this.appendEventInTx(envelope, sessionId, {
        event_id: this.newId(),
        type: eventType,
        from_state: current.state,
        to_state: to,
        actor_subject: envelope.actor_subject,
        payload: { state_record: next, from_state: current.state, to_state: to },
        created_at: next.updated_at,
      });
    });
    return next;
  }

  // --------------------------------------------------------------- journal

  private appendEventInTx(
    envelope: CouncilEnvelope,
    sessionId: string,
    input: {
      event_id: string;
      type: CouncilEventType;
      from_state: string | null;
      to_state: string | null;
      actor_subject: string;
      payload: Record<string, unknown>;
      created_at: string;
    },
  ): CouncilJournalEvent {
    const last = this.db
      .prepare(
        `SELECT sequence, event_hash FROM council_events
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?
          ORDER BY sequence DESC LIMIT 1`,
      )
      .get(envelope.tenant_id, envelope.company_id, sessionId) as
      | { sequence: number; event_hash: string }
      | undefined;
    const sequence = (last?.sequence ?? 0) + 1;
    const prevHash = last?.event_hash ?? '';
    const payloadJson = canonicalStringify(input.payload);
    const eventHash = canonicalHash({
      tenant_id: envelope.tenant_id,
      company_id: envelope.company_id,
      session_id: sessionId,
      sequence,
      type: input.type,
      payload_json: payloadJson,
      prev_hash: prevHash,
      created_at: input.created_at,
    });
    this.db
      .prepare(
        `INSERT INTO council_events
           (tenant_id, company_id, session_id, sequence, id, type, from_state, to_state,
            actor_subject, payload_json, prev_hash, event_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.tenant_id,
        envelope.company_id,
        sessionId,
        sequence,
        input.event_id,
        input.type,
        input.from_state,
        input.to_state,
        input.actor_subject,
        payloadJson,
        prevHash,
        eventHash,
        input.created_at,
      );
    return {
      event_id: input.event_id,
      type: input.type,
      sequence,
      from_state: input.from_state,
      to_state: input.to_state,
      actor_subject: input.actor_subject,
      payload: input.payload,
      prev_hash: prevHash,
      event_hash: eventHash,
      created_at: input.created_at,
    };
  }

  listEvents(envelope: CouncilEnvelope, sessionId: string, afterSequence = 0): CouncilJournalEvent[] {
    const rows = this.read(() =>
      this.db
        .prepare(
          `SELECT sequence, id, type, from_state, to_state, actor_subject,
                  payload_json, prev_hash, event_hash, created_at
             FROM council_events
            WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND sequence > ?
            ORDER BY sequence ASC`,
        )
        .all(envelope.tenant_id, envelope.company_id, sessionId, afterSequence),
    ) as EventRow[];
    return rows.map((row) => ({
      event_id: row.id,
      type: row.type as CouncilEventType,
      sequence: row.sequence,
      from_state: row.from_state,
      to_state: row.to_state,
      actor_subject: row.actor_subject,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      prev_hash: row.prev_hash,
      event_hash: row.event_hash,
      created_at: row.created_at,
    }));
  }

  private latestEventOfType(
    envelope: CouncilEnvelope,
    sessionId: string,
    types: CouncilEventType[],
  ): CouncilJournalEvent | null {
    const events = this.listEvents(envelope, sessionId, 0);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (types.includes(events[i].type)) return events[i];
    }
    return null;
  }

  verifyChain(
    envelope: CouncilEnvelope,
    sessionId: string,
  ): { ok: boolean; checked: number; first_bad_sequence: number | null } {
    const events = this.listEvents(envelope, sessionId, 0);
    let prevHash = '';
    for (const [index, event] of events.entries()) {
      if (event.sequence !== index + 1 || event.prev_hash !== prevHash) {
        return { ok: false, checked: index, first_bad_sequence: event.sequence };
      }
      const recomputed = canonicalHash({
        tenant_id: envelope.tenant_id,
        company_id: envelope.company_id,
        session_id: sessionId,
        sequence: event.sequence,
        type: event.type,
        payload_json: canonicalStringify(event.payload),
        prev_hash: event.prev_hash,
        created_at: event.created_at,
      });
      if (recomputed !== event.event_hash) {
        return { ok: false, checked: index, first_bad_sequence: event.sequence };
      }
      prevHash = event.event_hash;
    }
    return { ok: true, checked: events.length, first_bad_sequence: null };
  }

  // ----------------------------------------------------------------- cards

  /**
   * THE atomic accepted-work commit (Sections 15.2, 16.4): fence
   * recheck, card insert, journal event, and outbox intent in one
   * transaction. Duplicate commits return the original card.
   */
  acceptCard(
    envelope: CouncilEnvelope,
    card: CouncilCard,
    fence: { expected_state_version: number; cancel_generation: number; lease_epoch: number },
  ): { outcome: 'committed' | 'duplicate'; card: CouncilCard } {
    const check = validateCard(card);
    if (!check.ok) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_VALIDATION_FAILED',
        'The card failed canonical contract validation and was not stored.',
      );
    }
    if (
      card.host.scope.tenant_id !== envelope.tenant_id ||
      card.host.scope.company_id !== envelope.company_id
    ) {
      throw scopeDenied('The card host stamp scope does not match the authorization envelope.');
    }
    this.assertNotDeleted(envelope, card.session_id);
    return this.write(() => {
      const row = this.sessionRow(envelope, card.session_id);
      if (!row) throw sessionNotFound(card.session_id);
      const session = this.reconstruct(envelope, row);
      if (
        row.state_version !== fence.expected_state_version ||
        row.cancellation_generation !== fence.cancel_generation ||
        session.state.lease_epoch !== fence.lease_epoch
      ) {
        throw stateConflict(
          `Commit fence failed for session ${card.session_id}: the session moved on (state version, cancellation generation, or lease epoch no longer matches). The card was not committed.`,
        );
      }
      const fingerprint = canonicalHash(card);
      const existing = this.db
        .prepare(
          `SELECT card_json, payload_fingerprint FROM council_cards
            WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND operation_id = ?`,
        )
        .get(envelope.tenant_id, envelope.company_id, card.session_id, card.host.operation_id) as
        | { card_json: string; payload_fingerprint: string }
        | undefined;
      if (existing) {
        if (existing.payload_fingerprint === fingerprint) {
          return { outcome: 'duplicate' as const, card: JSON.parse(existing.card_json) as CouncilCard };
        }
        throw new CouncilPersistenceError(
          'PERSISTENCE_OPERATION_CONFLICT',
          `Operation ${card.host.operation_id} was already committed with different content. The conflicting card was not stored.`,
        );
      }
      const prev = this.db
        .prepare(
          `SELECT canonical_hash FROM council_cards
            WHERE tenant_id = ? AND company_id = ? AND session_id = ?
            ORDER BY rowid DESC LIMIT 1`,
        )
        .get(envelope.tenant_id, envelope.company_id, card.session_id) as
        | { canonical_hash: string }
        | undefined;
      const round =
        card.card_kind === 'ratification' ? 3 : card.card_kind === 'consult' ? 0 : card.round;
      const nowIso = this.now();
      this.db
        .prepare(
          `INSERT INTO council_cards
             (tenant_id, company_id, session_id, id, kind, seat_id, round, brief_revision,
              operation_id, payload_fingerprint, card_json, canonical_hash, prev_hash,
              validation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?)`,
        )
        .run(
          envelope.tenant_id,
          envelope.company_id,
          card.session_id,
          card.host.operation_id,
          card.card_kind,
          card.seat_id,
          round,
          card.brief_revision,
          card.host.operation_id,
          fingerprint,
          canonicalStringify(card),
          fingerprint,
          prev?.canonical_hash ?? '',
          nowIso,
        );
      const event = this.appendEventInTx(envelope, card.session_id, {
        event_id: this.newId(),
        type: 'card_accepted',
        from_state: null,
        to_state: null,
        actor_subject: envelope.actor_subject,
        payload: {
          operation_id: card.host.operation_id,
          seat_id: card.seat_id,
          round,
          card_hash: fingerprint,
        },
        created_at: nowIso,
      });
      this.enqueueOutboxInTx(envelope, {
        id: this.newId(),
        session_id: card.session_id,
        event_sequence: event.sequence,
        topic: 'card.accepted',
        idempotency_key: card.host.operation_id,
        payload: {
          session_id: card.session_id,
          operation_id: card.host.operation_id,
          event_sequence: event.sequence,
        },
        created_at: nowIso,
      });
      return { outcome: 'committed' as const, card };
    });
  }

  listCards(envelope: CouncilEnvelope, sessionId: string): CouncilCard[] {
    const rows = this.read(() =>
      this.db
        .prepare(
          `SELECT card_json FROM council_cards
            WHERE tenant_id = ? AND company_id = ? AND session_id = ?
            ORDER BY rowid ASC`,
        )
        .all(envelope.tenant_id, envelope.company_id, sessionId),
    ) as Array<{ card_json: string }>;
    return rows.map((r) => JSON.parse(r.card_json) as CouncilCard);
  }

  // -------------------------------------------------------------- verdicts

  saveVerdict(
    envelope: CouncilEnvelope,
    verdict: Verdict,
  ): { outcome: 'committed' | 'duplicate' } {
    const check = validateVerdict(verdict);
    if (!check.ok) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_VALIDATION_FAILED',
        'The verdict failed canonical contract validation and was not stored.',
      );
    }
    this.assertNotDeleted(envelope, verdict.session_id);
    return this.write(() => {
      const row = this.sessionRow(envelope, verdict.session_id);
      if (!row) throw sessionNotFound(verdict.session_id);
      const existing = this.db
        .prepare(
          `SELECT canonical_hash FROM council_verdicts
            WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND brief_revision = ?`,
        )
        .get(envelope.tenant_id, envelope.company_id, verdict.session_id, verdict.verdict_revision) as
        | { canonical_hash: string }
        | undefined;
      if (existing) {
        if (existing.canonical_hash === verdict.content_sha256) {
          return { outcome: 'duplicate' as const };
        }
        throw new CouncilPersistenceError(
          'PERSISTENCE_OPERATION_CONFLICT',
          `Verdict revision ${verdict.verdict_revision} for session ${verdict.session_id} was already committed with different content. Verdicts are immutable; a correction is a new revision.`,
        );
      }
      const session = this.reconstruct(envelope, row);
      const lastCard = this.db
        .prepare(
          `SELECT canonical_hash FROM council_cards
            WHERE tenant_id = ? AND company_id = ? AND session_id = ?
            ORDER BY rowid DESC LIMIT 1`,
        )
        .get(envelope.tenant_id, envelope.company_id, verdict.session_id) as
        | { canonical_hash: string }
        | undefined;
      const nowIso = this.now();
      const isScored = verdict.result_kind === 'scored';
      this.db
        .prepare(
          `INSERT INTO council_verdicts
             (tenant_id, company_id, session_id, id, brief_revision, verdict_json,
              canonical_hash, verdict_hash, cards_root_hash, brief_hash, policy_hash,
              validation_run_hash, label, validation, ratification, chosen_option_id,
              client_decision_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.tenant_id,
          envelope.company_id,
          verdict.session_id,
          `verdict-${verdict.verdict_revision}`,
          verdict.verdict_revision,
          canonicalStringify(verdict),
          verdict.content_sha256,
          verdict.content_sha256,
          lastCard?.canonical_hash ?? canonicalHash({ cards: [] }),
          verdict.brief_sha256,
          canonicalHash(session.spec.model_policy),
          canonicalHash({
            validation_status: verdict.validation_status,
            content_sha256: verdict.content_sha256,
            validated_at: nowIso,
          }),
          isScored ? verdict.label : 'INSUFFICIENT_EVIDENCE',
          verdict.validation_status,
          isScored ? verdict.ratification_status : 'not_required',
          isScored ? verdict.recommended_option_id : null,
          null,
          nowIso,
        );
      const event = this.appendEventInTx(envelope, verdict.session_id, {
        event_id: this.newId(),
        type: 'verdict_validated',
        from_state: null,
        to_state: null,
        actor_subject: envelope.actor_subject,
        payload: {
          verdict_revision: verdict.verdict_revision,
          result_kind: verdict.result_kind,
          content_sha256: verdict.content_sha256,
        },
        created_at: nowIso,
      });
      this.enqueueOutboxInTx(envelope, {
        id: this.newId(),
        session_id: verdict.session_id,
        event_sequence: event.sequence,
        topic: 'verdict.validated',
        idempotency_key: `verdict:${verdict.session_id}:${verdict.verdict_revision}`,
        payload: {
          session_id: verdict.session_id,
          verdict_revision: verdict.verdict_revision,
          event_sequence: event.sequence,
        },
        created_at: nowIso,
      });
      return { outcome: 'committed' as const };
    });
  }

  getVerdict(envelope: CouncilEnvelope, sessionId: string): Verdict | null {
    const row = this.read(() =>
      this.db
        .prepare(
          `SELECT verdict_json FROM council_verdicts
            WHERE tenant_id = ? AND company_id = ? AND session_id = ?
            ORDER BY brief_revision DESC LIMIT 1`,
        )
        .get(envelope.tenant_id, envelope.company_id, sessionId),
    ) as { verdict_json: string } | undefined;
    return row ? (JSON.parse(row.verdict_json) as Verdict) : null;
  }

  // ---------------------------------------------------------------- outbox

  private enqueueOutboxInTx(
    envelope: CouncilEnvelope,
    input: {
      id: string;
      session_id: string | null;
      event_sequence: number | null;
      topic: string;
      idempotency_key: string;
      payload: Record<string, unknown>;
      created_at: string;
    },
  ): { created: boolean } {
    const existing = this.db
      .prepare(
        `SELECT id FROM council_projection_outbox
          WHERE tenant_id = ? AND company_id = ? AND topic = ? AND idempotency_key = ?`,
      )
      .get(envelope.tenant_id, envelope.company_id, input.topic, input.idempotency_key) as
      | { id: string }
      | undefined;
    if (existing) return { created: false };
    this.db
      .prepare(
        `INSERT INTO council_projection_outbox
           (tenant_id, company_id, session_id, id, event_sequence, topic, idempotency_key,
            payload_json, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        envelope.tenant_id,
        envelope.company_id,
        input.session_id,
        input.id,
        input.event_sequence,
        input.topic,
        input.idempotency_key,
        canonicalStringify(input.payload),
        input.created_at,
      );
    return { created: true };
  }

  claimDueOutbox(envelope: CouncilEnvelope, limit = 50): CouncilOutboxIntent[] {
    const nowIso = this.now();
    const rows = this.read(() =>
      this.db
        .prepare(
          `SELECT id, session_id, event_sequence, topic, idempotency_key, payload_json,
                  state, attempt_count, created_at, delivered_at
             FROM council_projection_outbox
            WHERE tenant_id = ? AND company_id = ?
              AND state IN ('pending', 'failed')
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY created_at ASC LIMIT ?`,
        )
        .all(envelope.tenant_id, envelope.company_id, nowIso, limit),
    ) as Array<{
      id: string;
      session_id: string | null;
      event_sequence: number | null;
      topic: string;
      idempotency_key: string;
      payload_json: string;
      state: CouncilOutboxIntent['state'];
      attempt_count: number;
      created_at: string;
      delivered_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      event_sequence: row.event_sequence,
      topic: row.topic,
      idempotency_key: row.idempotency_key,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      state: row.state,
      attempt_count: row.attempt_count,
      created_at: row.created_at,
      delivered_at: row.delivered_at,
    }));
  }

  markOutboxDelivered(envelope: CouncilEnvelope, id: string): void {
    this.write(() => {
      this.db
        .prepare(
          `UPDATE council_projection_outbox
              SET state = 'delivered', delivered_at = ?
            WHERE tenant_id = ? AND company_id = ? AND id = ? AND state != 'delivered'`,
        )
        .run(this.now(), envelope.tenant_id, envelope.company_id, id);
    });
  }

  markOutboxFailed(envelope: CouncilEnvelope, id: string, errorCode: string): void {
    this.write(() => {
      const row = this.db
        .prepare(
          `SELECT attempt_count, state FROM council_projection_outbox
            WHERE tenant_id = ? AND company_id = ? AND id = ?`,
        )
        .get(envelope.tenant_id, envelope.company_id, id) as
        | { attempt_count: number; state: string }
        | undefined;
      if (!row || row.state === 'delivered' || row.state === 'dead_letter') return;
      const attempts = row.attempt_count + 1;
      const state = attempts >= this.outboxMaxAttempts ? 'dead_letter' : 'failed';
      this.db
        .prepare(
          `UPDATE council_projection_outbox
              SET state = ?, attempt_count = ?, last_error_code = ?, next_attempt_at = ?
            WHERE tenant_id = ? AND company_id = ? AND id = ?`,
        )
        .run(
          state,
          attempts,
          errorCode,
          state === 'dead_letter' ? null : this.now(),
          envelope.tenant_id,
          envelope.company_id,
          id,
        );
    });
  }

  listOutboxForSession(envelope: CouncilEnvelope, sessionId: string): CouncilOutboxIntent[] {
    const rows = this.read(() =>
      this.db
        .prepare(
          `SELECT id, session_id, event_sequence, topic, idempotency_key, payload_json,
                  state, attempt_count, created_at, delivered_at
             FROM council_projection_outbox
            WHERE tenant_id = ? AND company_id = ? AND session_id = ?
            ORDER BY created_at ASC`,
        )
        .all(envelope.tenant_id, envelope.company_id, sessionId),
    ) as Array<{
      id: string;
      session_id: string | null;
      event_sequence: number | null;
      topic: string;
      idempotency_key: string;
      payload_json: string;
      state: CouncilOutboxIntent['state'];
      attempt_count: number;
      created_at: string;
      delivered_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      event_sequence: row.event_sequence,
      topic: row.topic,
      idempotency_key: row.idempotency_key,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      state: row.state,
      attempt_count: row.attempt_count,
      created_at: row.created_at,
      delivered_at: row.delivered_at,
    }));
  }

  // ------------------------------------------------------------ diagnostics

  /**
   * Record an explicit diagnostic grant for one named session. The
   * envelope actor must be the authorizing principal named in the
   * policy; the CWE-005 adapter records the grant row, and this
   * service journals the issuance.
   */
  recordDiagnosticGrant(
    envelope: CouncilEnvelope,
    policy: DiagnosticRetentionPolicy,
  ): { grant_id: string; window_started_at: string; window_ends_at: string } {
    assertPurpose(envelope, 'diagnostic_capture', 'Diagnostic grant');
    const check = validateDiagnosticRetentionPolicy(policy);
    if (!check.ok || !policy.enabled || policy.session_id === null) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_DIAGNOSTIC_DENIED',
        'A diagnostic grant requires a valid, enabled DiagnosticRetentionPolicy naming one session and an authorizing principal. The grant was not recorded.',
      );
    }
    if (policy.authorized_by_principal !== envelope.actor_subject) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_DIAGNOSTIC_DENIED',
        'The envelope actor is not the principal named in the diagnostic policy. An enabled flag in a request body is not authority; the grant was not recorded.',
      );
    }
    const sessionId = policy.session_id;
    this.assertNotDeleted(envelope, sessionId);
    if (!this.sessionRow(envelope, sessionId)) throw sessionNotFound(sessionId);
    const nowIso = this.now();
    const windowEndsAt = new Date(
      Date.parse(nowIso) + policy.capture_window_minutes * 60_000,
    ).toISOString();
    const grantId = this.newId();
    const recorded = this.adapter.recordDiagnosticGrant({
      scope: { tenantId: envelope.tenant_id, companyId: envelope.company_id },
      sessionId,
      grantId,
      policy,
      windowStartedAt: nowIso,
      windowEndsAt,
      createdAt: nowIso,
    });
    if (recorded === null) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_DIAGNOSTIC_DENIED',
        'The diagnostic grant was refused by the storage adapter and was not recorded.',
      );
    }
    this.write(() => {
      this.appendEventInTx(envelope, sessionId, {
        event_id: this.newId(),
        type: 'grant_issued',
        from_state: null,
        to_state: null,
        actor_subject: envelope.actor_subject,
        payload: {
          grant_id: grantId,
          authorization_kind: policy.authorization_kind,
          capture_window_minutes: policy.capture_window_minutes,
          payload_ttl_hours: policy.payload_ttl_hours,
        },
        created_at: nowIso,
      });
    });
    return { grant_id: grantId, window_started_at: nowIso, window_ends_at: windowEndsAt };
  }

  private activeGrantRow(envelope: CouncilEnvelope, sessionId: string): {
    id: string;
    authorized_by_principal: string;
    authorization_kind: 'owner' | 'audited_support';
    window_started_at: string;
    window_ends_at: string;
    capture_window_minutes: number;
    payload_ttl_hours: number;
    max_bytes_per_operation: number;
    max_bytes_per_session: number;
    policy_schema_version: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, policy_schema_version, authorized_by_principal, authorization_kind,
                window_started_at, window_ends_at, capture_window_minutes,
                payload_ttl_hours, max_bytes_per_operation, max_bytes_per_session
           FROM council_diagnostic_capture
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?
            AND record_kind = 'grant' AND revoked_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(envelope.tenant_id, envelope.company_id, sessionId) as
      | {
          id: string;
          authorized_by_principal: string;
          authorization_kind: 'owner' | 'audited_support';
          window_started_at: string;
          window_ends_at: string;
          capture_window_minutes: number;
          payload_ttl_hours: number;
          max_bytes_per_operation: number;
          max_bytes_per_session: number;
          policy_schema_version: string;
        }
      | undefined;
    return row ?? null;
  }

  /**
   * Capture one provider or tool body under the session's grant. This
   * is the only write path for raw bodies in this layer. Policy
   * denials never throw: they return a metadata or none outcome with
   * a reason code.
   */
  captureDiagnostic(
    envelope: CouncilEnvelope,
    input: { sessionId: string; operationId: string; dataClass: string; body: string },
  ): DiagnosticCaptureOutcome {
    assertPurpose(envelope, 'diagnostic_capture', 'Diagnostic capture');
    const nowIso = this.now();
    const nowMs = Date.parse(nowIso);
    const grant = this.read(() => this.activeGrantRow(envelope, input.sessionId));
    if (!grant) return { stored: 'none', reason_code: 'no_active_grant' };
    if (!this.sessionRow(envelope, input.sessionId)) {
      return { stored: 'none', reason_code: 'session_not_found' };
    }
    const policy: DiagnosticRetentionPolicy = {
      schema_version: grant.policy_schema_version as DiagnosticRetentionPolicy['schema_version'],
      enabled: true,
      authorized_by_principal: grant.authorized_by_principal,
      authorization_kind: grant.authorization_kind,
      session_id: input.sessionId,
      capture_window_minutes: grant.capture_window_minutes,
      payload_ttl_hours: grant.payload_ttl_hours,
      max_bytes_per_operation: grant.max_bytes_per_operation,
      max_bytes_per_session: grant.max_bytes_per_session,
    };
    let redacted: string | null = null;
    let protectionEstablished = true;
    try {
      redacted = this.redact(input.body);
      if (redacted === null) protectionEstablished = false;
    } catch {
      protectionEstablished = false;
    }
    const scope = { tenantId: envelope.tenant_id, companyId: envelope.company_id };
    const decision = evaluateCapture({
      policy,
      sessionId: input.sessionId,
      dataClass: input.dataClass,
      byteLength: protectionEstablished
        ? Buffer.byteLength(redacted as string, 'utf8')
        : Buffer.byteLength(input.body, 'utf8'),
      sessionBytesAlreadyCaptured: this.adapter.diagnosticSessionBytes(
        scope,
        input.sessionId,
        grant.id,
      ),
      minutesSinceWindowStart: (nowMs - Date.parse(grant.window_started_at)) / 60_000,
      protectionEstablished,
      sessionDeletedOrRevoked: this.isDeleted(envelope.tenant_id, input.sessionId),
    });
    if (!decision.allowed) {
      const reasonCode = /never captured/.test(decision.reason)
        ? 'never_captured'
        : /window has closed/.test(decision.reason)
          ? 'window_closed'
          : /ceiling reached/.test(decision.reason)
            ? 'session_byte_ceiling'
            : /metadata only/.test(decision.reason)
              ? 'protection_unavailable'
              : /deleted or capture revoked/.test(decision.reason)
                ? 'session_deleted_or_revoked'
                : 'capture_denied';
      const captureId = this.newId();
      const neverClass = [
        'hidden_reasoning',
        'access_token',
        'cookie',
        'authentication_header',
        'private_key',
      ].includes(input.dataClass);
      this.write(() => {
        this.db
          .prepare(
            `INSERT INTO council_diagnostic_capture
               (tenant_id, company_id, session_id, id, record_kind, grant_id,
                operation_id, data_class, byte_count, truncated, redaction_status,
                payload_protected_ref, response_hash, error_code, captured_at, created_at)
             VALUES (?, ?, ?, ?, 'metadata', ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, ?)`,
          )
          .run(
            envelope.tenant_id,
            envelope.company_id,
            input.sessionId,
            captureId,
            grant.id,
            input.operationId,
            neverClass ? null : input.dataClass,
            Buffer.byteLength(input.body, 'utf8'),
            protectionEstablished ? 'redacted' : 'unavailable',
            sha256Hex(Buffer.from(input.body, 'utf8')),
            reasonCode,
            nowIso,
            nowIso,
          );
      });
      return { stored: 'metadata', capture_id: captureId, reason_code: reasonCode };
    }
    const effective = Buffer.from(redacted as string, 'utf8').subarray(0, decision.effectiveBytes);
    const captureId = this.newId();
    const ref = `${input.sessionId}/${captureId}.bin`;
    const deadline = new Date(nowMs + policy.payload_ttl_hours * 3_600_000).toISOString();
    mkdirSync(join(this.diagnosticsDir, input.sessionId), { recursive: true, mode: 0o700 });
    writeFileSync(join(this.diagnosticsDir, ref), effective, { mode: 0o600 });
    try {
      this.write(() => {
        this.db
          .prepare(
            `INSERT INTO council_diagnostic_capture
               (tenant_id, company_id, session_id, id, record_kind, grant_id,
                operation_id, data_class, byte_count, truncated, redaction_status,
                payload_protected_ref, payload_deadline_at, response_hash,
                captured_at, created_at)
             VALUES (?, ?, ?, ?, 'payload', ?, ?, ?, ?, ?, 'redacted', ?, ?, ?, ?, ?)`,
          )
          .run(
            envelope.tenant_id,
            envelope.company_id,
            input.sessionId,
            captureId,
            grant.id,
            input.operationId,
            input.dataClass,
            effective.byteLength,
            decision.truncated ? 1 : 0,
            ref,
            deadline,
            sha256Hex(Buffer.from(input.body, 'utf8')),
            nowIso,
            nowIso,
          );
      });
    } catch (err) {
      rmSync(join(this.diagnosticsDir, ref), { force: true });
      throw err;
    }
    return {
      stored: 'payload',
      capture_id: captureId,
      byte_count: effective.byteLength,
      truncated: decision.truncated,
      payload_deadline_at: deadline,
    };
  }

  /**
   * Read one captured payload. Access is re-decided at read time via
   * the adapter's accessibility check (grant unrevoked, deadline and
   * TTL respected): expired or revoked content is inaccessible even
   * while its file still exists.
   */
  readDiagnosticPayload(
    envelope: CouncilEnvelope,
    sessionId: string,
    captureId: string,
  ): { body: string; byte_count: number; truncated: boolean } {
    assertPurpose(envelope, 'diagnostic_read', 'Diagnostic payload read');
    if (this.isDeleted(envelope.tenant_id, sessionId)) throw sessionDeleted(sessionId);
    const accessible = this.adapter.diagnosticPayloadAccessible(
      { tenantId: envelope.tenant_id, companyId: envelope.company_id },
      sessionId,
      captureId,
      this.now(),
    );
    if (!accessible) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_DIAGNOSTIC_DENIED',
        'This diagnostic payload is not accessible: it does not exist in scope, its grant was revoked, or it has passed its retention deadline.',
      );
    }
    const row = this.db
      .prepare(
        `SELECT byte_count, truncated, payload_protected_ref FROM council_diagnostic_capture
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND id = ?
            AND record_kind = 'payload'`,
      )
      .get(envelope.tenant_id, envelope.company_id, sessionId, captureId) as
      | { byte_count: number; truncated: number; payload_protected_ref: string }
      | undefined;
    if (!row) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_DIAGNOSTIC_DENIED',
        `No captured diagnostic payload ${captureId} exists for session ${sessionId} in this scope.`,
      );
    }
    const body = readFileSync(join(this.diagnosticsDir, row.payload_protected_ref), 'utf8');
    return { body, byte_count: row.byte_count, truncated: row.truncated === 1 };
  }

  /** Revoke a grant: late writes and reads are blocked from this moment. */
  revokeDiagnosticGrant(envelope: CouncilEnvelope, sessionId: string, grantId: string): void {
    assertPurpose(envelope, 'diagnostic_capture', 'Diagnostic grant revocation');
    const nowIso = this.now();
    this.write(() => {
      const result = this.db
        .prepare(
          `UPDATE council_diagnostic_capture
              SET revoked_at = ?, revoked_by = ?
            WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND id = ?
              AND record_kind = 'grant' AND revoked_at IS NULL`,
        )
        .run(nowIso, envelope.actor_subject, envelope.tenant_id, envelope.company_id, sessionId, grantId);
      if (Number(result.changes) !== 1) {
        throw new CouncilPersistenceError(
          'PERSISTENCE_DIAGNOSTIC_DENIED',
          `No active diagnostic grant ${grantId} exists for session ${sessionId} in this scope. Nothing was revoked.`,
        );
      }
      this.appendEventInTx(envelope, sessionId, {
        event_id: this.newId(),
        type: 'grant_revoked',
        from_state: null,
        to_state: null,
        actor_subject: envelope.actor_subject,
        payload: { grant_id: grantId },
        created_at: nowIso,
      });
    });
  }

  /** Remove protected payload files by reference (post-deletion sweep). */
  purgeDiagnosticFiles(refs: string[]): void {
    for (const ref of refs) {
      const full = join(this.diagnosticsDir, ref);
      if (existsSync(full)) rmSync(full, { force: true });
    }
  }

  // -------------------------------------------------------------- deletion

  /**
   * Explicit authorized deletion (Section 16.5): tombstone, collect
   * diagnostic payload references, delete the session row (composite
   * foreign keys cascade to every child table) in one transaction.
   */
  deleteSession(
    envelope: CouncilEnvelope,
    sessionId: string,
  ): { deleted: true; diagnosticProtectedRefs: string[] } {
    assertPurpose(envelope, 'delete', 'Session deletion');
    return this.write(() => {
      const row = this.sessionRow(envelope, sessionId);
      if (!row) {
        if (this.isDeleted(envelope.tenant_id, sessionId)) throw sessionDeleted(sessionId);
        throw sessionNotFound(sessionId);
      }
      const refs = this.db
        .prepare(
          `SELECT payload_protected_ref FROM council_diagnostic_capture
            WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND record_kind = 'payload'`,
        )
        .all(envelope.tenant_id, envelope.company_id, sessionId) as Array<{
        payload_protected_ref: string;
      }>;
      this.db
        .prepare(
          `INSERT INTO council_request_keys
             (tenant_id, source, operation, request_key, payload_fingerprint, session_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.tenant_id,
          DELETION_TOMBSTONE_SOURCE,
          DELETION_TOMBSTONE_OPERATION,
          sessionId,
          canonicalHash({
            deleted_session: sessionId,
            deleted_by: envelope.actor_subject,
            deleted_at: this.now(),
          }),
          sessionId,
          this.now(),
        );
      this.db
        .prepare(
          `DELETE FROM council_sessions WHERE tenant_id = ? AND company_id = ? AND id = ?`,
        )
        .run(envelope.tenant_id, envelope.company_id, sessionId);
      return {
        deleted: true as const,
        diagnosticProtectedRefs: refs.map((r) => r.payload_protected_ref),
      };
    });
  }

  // ----------------------------------------------------------- request keys

  /** Section 17 idempotency, delegated to the CWE-005 adapter. */
  claimRequestKey(input: {
    tenantId: string;
    source: string;
    operation: string;
    requestKey: string;
    payloadFingerprint: string;
    sessionId: string | null;
  }): { outcome: 'claimed' | 'replay' | 'conflict'; payloadFingerprint: string } {
    return this.adapter.claimRequestKey({ ...input, createdAt: this.now() });
  }
}

/** Open the repository service over the host database (getDb()). */
export function openCouncilRepositories(
  options: CouncilRepositoryOptions = {},
): CouncilRepositories {
  // Touch getDb() so a host database init failure surfaces here, at
  // composition time, rather than on first use.
  getDb();
  return new CouncilRepositories(options);
}
