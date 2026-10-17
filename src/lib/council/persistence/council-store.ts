/**
 * Council store adapter over getDb() (CWE-005, directive Section 16).
 *
 * This is the persistence ADAPTER layer only: it opens the host database
 * through getDb() (which applies the base schema and the full migration
 * chain, council migration included) and exposes the scoped, checked
 * access methods the council schema guarantees. The repository services
 * of CWE-006 (session lifecycle, event journal semantics, budget ledger,
 * outbox delivery, diagnostic sink) build on top of this adapter; they
 * are not implemented here.
 *
 * Scope law (Section 16.2): every read and write is bound to a
 * (tenant_id, company_id) scope, and private sessions additionally
 * require the viewer to be the recorded owner. A globally unique UUID is
 * never authorization. Cross-scope references are rejected by the
 * schema's composite foreign keys; this adapter never widens a query
 * beyond its scope arguments.
 *
 * Diagnostic capture (Section 16.6, CWE-003 DiagnosticRetentionPolicy):
 * the adapter records grants and reads capture state. A captured payload
 * is accessible only while its grant is unrevoked, its capture window
 * covers the capture time, and its payload deadline has not passed; an
 * expired payload is inaccessible immediately, even before physical
 * cleanup. The pure policy decisions live in the CWE-003 contracts
 * (evaluateCapture, isCaptureExpired); the schema enforces the hard
 * bounds (window at most 4 hours, TTL at most 72 hours, 5 MiB per
 * operation, 25 MiB per session, never-captured data classes rejected).
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../db';
import {
  DIAGNOSTIC_LIMITS,
  diagnosticRetentionPolicySchema,
  isCaptureExpired,
  type DiagnosticRetentionPolicy,
} from '../contracts';

export interface CouncilScope {
  tenantId: string;
  companyId: string;
}

export interface CouncilSessionRow {
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
  created_at: string;
  updated_at: string;
}

export interface CouncilDiagnosticGrantRow {
  id: string;
  authorized_by_principal: string;
  authorization_kind: string;
  window_started_at: string;
  window_ends_at: string;
  capture_window_minutes: number;
  payload_ttl_hours: number;
  max_bytes_per_operation: number;
  max_bytes_per_session: number;
  revoked_at: string | null;
}

export interface CouncilDiagnosticPayloadRow {
  id: string;
  grant_id: string;
  operation_id: string;
  data_class: string;
  byte_count: number;
  truncated: number;
  payload_protected_ref: string;
  payload_deadline_at: string;
  captured_at: string;
}

/** Section 11.1 visibility derivation for one viewer. */
export function sessionVisibleTo(
  row: Pick<CouncilSessionRow, 'visibility' | 'owner_subject'>,
  viewerSubject: string,
): boolean {
  if (row.visibility === 'company') return true;
  return row.owner_subject !== null && row.owner_subject === viewerSubject;
}

export class CouncilStore {
  constructor(private readonly db: Database.Database) {}

  /** The underlying handle (the getDb() singleton when opened via openCouncilStore). */
  handle(): Database.Database {
    return this.db;
  }

  /**
   * Load one session inside its scope. Returns null when the session
   * does not exist in this scope or is not visible to the viewer; the
   * two cases are indistinguishable by design (Section 11.1).
   */
  getSession(scope: CouncilScope, sessionId: string, viewerSubject: string): CouncilSessionRow | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, company_id, installation_id, owner_subject, archived,
                mode, visibility, state, state_version, brief_revision, created_at, updated_at
           FROM council_sessions
          WHERE tenant_id = ? AND company_id = ? AND id = ?`,
      )
      .get(scope.tenantId, scope.companyId, sessionId) as CouncilSessionRow | undefined;
    if (!row) return null;
    if (!sessionVisibleTo(row, viewerSubject)) return null;
    return row;
  }

  /**
   * Append one event with the next sequence for the session, inside one
   * short transaction (Section 16.4). The caller supplies the canonical
   * event hash chain values; allocation of the sequence and insertion
   * are atomic here, so concurrent writers cannot interleave sequences.
   */
  appendEvent(input: {
    scope: CouncilScope;
    sessionId: string;
    id: string;
    type: string;
    fromState: string | null;
    toState: string | null;
    actorSubject: string;
    payloadJson: string;
    prevHash: string;
    eventHash: string;
    createdAt: string;
  }): number {
    const run = this.db.transaction((): number => {
      const maxRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM council_events
            WHERE tenant_id = ? AND company_id = ? AND session_id = ?`,
        )
        .get(input.scope.tenantId, input.scope.companyId, input.sessionId) as { max_seq: number };
      const sequence = maxRow.max_seq + 1;
      this.db
        .prepare(
          `INSERT INTO council_events
             (tenant_id, company_id, session_id, sequence, id, type, from_state, to_state,
              actor_subject, payload_json, prev_hash, event_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.scope.tenantId,
          input.scope.companyId,
          input.sessionId,
          sequence,
          input.id,
          input.type,
          input.fromState,
          input.toState,
          input.actorSubject,
          input.payloadJson,
          input.prevHash,
          input.eventHash,
          input.createdAt,
        );
      return sequence;
    });
    return run();
  }

  /**
   * Record a diagnostic capture grant for one named session from a
   * validated CWE-003 DiagnosticRetentionPolicy. Disabled policies and
   * policies naming a different session record nothing and return null:
   * an enabled flag is not authority (Section 16.6), and the schema
   * additionally requires an authorizing principal and kind on the row.
   */
  recordDiagnosticGrant(input: {
    scope: CouncilScope;
    sessionId: string;
    grantId: string;
    policy: DiagnosticRetentionPolicy;
    windowStartedAt: string;
    windowEndsAt: string;
    createdAt: string;
  }): string | null {
    const parsed = diagnosticRetentionPolicySchema.safeParse(input.policy);
    if (!parsed.success) return null;
    const policy = parsed.data;
    if (!policy.enabled) return null;
    if (policy.session_id !== input.sessionId) return null;
    if (policy.authorized_by_principal === null || policy.authorization_kind === null) return null;
    this.db
      .prepare(
        `INSERT INTO council_diagnostic_capture
           (tenant_id, company_id, session_id, id, record_kind, policy_schema_version,
            authorized_by_principal, authorization_kind, window_started_at, window_ends_at,
            capture_window_minutes, payload_ttl_hours, max_bytes_per_operation,
            max_bytes_per_session, created_at)
         VALUES (?, ?, ?, ?, 'grant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scope.tenantId,
        input.scope.companyId,
        input.sessionId,
        input.grantId,
        policy.schema_version,
        policy.authorized_by_principal,
        policy.authorization_kind,
        input.windowStartedAt,
        input.windowEndsAt,
        policy.capture_window_minutes,
        policy.payload_ttl_hours,
        policy.max_bytes_per_operation,
        policy.max_bytes_per_session,
        input.createdAt,
      );
    return input.grantId;
  }

  /** The grant row for one capture grant id, or null. */
  getDiagnosticGrant(
    scope: CouncilScope,
    sessionId: string,
    grantId: string,
  ): CouncilDiagnosticGrantRow | null {
    const row = this.db
      .prepare(
        `SELECT id, authorized_by_principal, authorization_kind, window_started_at,
                window_ends_at, capture_window_minutes, payload_ttl_hours,
                max_bytes_per_operation, max_bytes_per_session, revoked_at
           FROM council_diagnostic_capture
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND id = ?
            AND record_kind = 'grant'`,
      )
      .get(scope.tenantId, scope.companyId, sessionId, grantId) as
      | CouncilDiagnosticGrantRow
      | undefined;
    return row ?? null;
  }

  /** Bytes already captured under one grant (drives the per-session ceiling). */
  diagnosticSessionBytes(scope: CouncilScope, sessionId: string, grantId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(byte_count), 0) AS total FROM council_diagnostic_capture
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND grant_id = ?
            AND record_kind = 'payload'`,
      )
      .get(scope.tenantId, scope.companyId, sessionId, grantId) as { total: number };
    return row.total;
  }

  /**
   * Payload accessibility (Section 16.6): accessible only while the
   * grant is unrevoked, the payload deadline has not passed at `nowIso`,
   * and the captured bytes respect the policy TTL from capture time.
   * Expiry hides the payload immediately, before physical cleanup.
   */
  diagnosticPayloadAccessible(
    scope: CouncilScope,
    sessionId: string,
    payloadId: string,
    nowIso: string,
  ): boolean {
    const payload = this.db
      .prepare(
        `SELECT id, grant_id, operation_id, data_class, byte_count, truncated,
                payload_protected_ref, payload_deadline_at, captured_at
           FROM council_diagnostic_capture
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND id = ?
            AND record_kind = 'payload'`,
      )
      .get(scope.tenantId, scope.companyId, sessionId, payloadId) as
      | CouncilDiagnosticPayloadRow
      | undefined;
    if (!payload) return false;
    const grant = this.getDiagnosticGrant(scope, sessionId, payload.grant_id);
    if (!grant) return false;
    if (grant.revoked_at !== null) return false;
    if (Date.parse(nowIso) >= Date.parse(payload.payload_deadline_at)) return false;
    const ttlHours = Math.min(grant.payload_ttl_hours, DIAGNOSTIC_LIMITS.maxPayloadTtlHours);
    return !isCaptureExpired(Date.parse(payload.captured_at), Date.parse(nowIso), ttlHours);
  }

  /**
   * Idempotency key claim (Section 17): the first claim records the
   * payload fingerprint and wins; a replay with the same fingerprint
   * returns the recorded claim; a replay with a DIFFERENT fingerprint
   * conflicts and records nothing (the host maps it to HTTP 409).
   */
  claimRequestKey(input: {
    tenantId: string;
    source: string;
    operation: string;
    requestKey: string;
    payloadFingerprint: string;
    sessionId: string | null;
    createdAt: string;
  }): { outcome: 'claimed' | 'replay' | 'conflict'; payloadFingerprint: string } {
    const existing = this.db
      .prepare(
        `SELECT payload_fingerprint FROM council_request_keys
          WHERE tenant_id = ? AND source = ? AND operation = ? AND request_key = ?`,
      )
      .get(input.tenantId, input.source, input.operation, input.requestKey) as
      | { payload_fingerprint: string }
      | undefined;
    if (existing) {
      return existing.payload_fingerprint === input.payloadFingerprint
        ? { outcome: 'replay', payloadFingerprint: existing.payload_fingerprint }
        : { outcome: 'conflict', payloadFingerprint: existing.payload_fingerprint };
    }
    this.db
      .prepare(
        `INSERT INTO council_request_keys
           (tenant_id, source, operation, request_key, payload_fingerprint, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        input.source,
        input.operation,
        input.requestKey,
        input.payloadFingerprint,
        input.sessionId,
        input.createdAt,
      );
    return { outcome: 'claimed', payloadFingerprint: input.payloadFingerprint };
  }
}

/**
 * Open the council store over the host database. getDb() applies the
 * base schema and the full migration chain (council migration included)
 * and fails closed if any migration fails.
 */
export function openCouncilStore(): CouncilStore {
  return new CouncilStore(getDb());
}
