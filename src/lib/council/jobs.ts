/**
 * Council durable jobs and run controls, Command Center form
 * (CWE-050 composition of CWE-027's named CC module; directive
 * Sections 15, 17.2, 25.6; binding B04/B05).
 *
 * CWE-027 built the durable runner in the portable runtime and named
 * this CC module for CWE-050 composition. What lives here:
 *
 * - A durable job service over the CWE-005 council_jobs table:
 *   idempotent enqueue (the table's UNIQUE (kind, idempotency_key)
 *   is the dedup authority), lease claims under a fencing epoch
 *   (60-second lease TTL, 15-second heartbeat guidance, per Section
 *   15.8), heartbeat, and fenced completion/failure. Claiming is a
 *   compare-and-swap: two workers racing one job produce exactly one
 *   lease. An expired lease may be reclaimed at a higher epoch; the
 *   stale owner's later writes are fenced by the epoch check.
 * - The run controls behind POST /sessions/:id/start|pause|cancel|
 *   resume. Start admits only through a real CWE-049 grant (resolved
 *   through the composition adapter; no grant, no start — the typed
 *   RUN_AUTHORIZATION_REQUIRED refusal), moves the session
 *   DRAFT -> READY -> QUEUED through the canonical transition table,
 *   and enqueues the durable run job carrying the grant reference and
 *   the grant's route-policy pin. No provider work happens in a
 *   request lifetime; the job is the durable handoff to the worker
 *   surface. Pause/cancel/resume follow the canonical two-step
 *   control states and are idempotent or precisely conflicting
 *   (T055); a stale expected version is refused, never overwritten
 *   (T058).
 *
 * Pause bookkeeping note (CWE-027's carried defect, reconciled
 * here): CouncilRepositories.transitionState records resume_phase as
 * PAUSE_REQUESTED when the PAUSE_REQUESTED -> PAUSED step lands,
 * which the resume legality rule can never target. The pause control
 * below corrects the record through the CAS state writer in the same
 * operation, recording the phase the session was in when pause was
 * requested — the same override the CWE-004 engine and the CWE-027
 * runner apply. CWE-006's file is not modified.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SessionState } from './contracts';
import {
  CouncilPersistenceError,
  envelopeFromScope,
  type CouncilEnvelope,
  type CouncilRepositories,
  type CouncilStoredSession,
} from './store';
import type { CouncilStore } from './persistence/council-store';
import type { CouncilPrincipal } from './auth';
import { CouncilRunAuthorizationService } from './run-authorization';
import { CouncilRunAuthorizationAdapter } from './run-authorization-adapter';

/** Section 15.8 council operation lease defaults. */
export const COUNCIL_JOB_LEASE_TTL_MS = 60_000;
export const COUNCIL_JOB_HEARTBEAT_MS = 15_000;

export type CouncilJobState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead_letter'
  | 'cancelled';

export interface CouncilJobRecord {
  id: string;
  session_id: string | null;
  kind: string;
  idempotency_key: string;
  state: CouncilJobState;
  payload: Record<string, unknown>;
  checkpoint: Record<string, unknown> | null;
  attempt_count: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  lease_epoch: number;
  last_error_code: string | null;
  terminal_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  session_id: string | null;
  kind: string;
  idempotency_key: string;
  state: string;
  payload_json: string;
  checkpoint_json: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  lease_epoch: number;
  last_error_code: string | null;
  terminal_reason: string | null;
  created_at: string;
  updated_at: string;
}

function toJobRecord(row: JobRow): CouncilJobRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    kind: row.kind,
    idempotency_key: row.idempotency_key,
    state: row.state as CouncilJobState,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    checkpoint: row.checkpoint_json
      ? (JSON.parse(row.checkpoint_json) as Record<string, unknown>)
      : null,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at,
    lease_epoch: row.lease_epoch,
    last_error_code: row.last_error_code,
    terminal_reason: row.terminal_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const JOB_COLUMNS = `id, session_id, kind, idempotency_key, state, payload_json,
  checkpoint_json, attempt_count, next_attempt_at, lease_owner, lease_expires_at,
  lease_epoch, last_error_code, terminal_reason, created_at, updated_at`;

export interface CouncilJobServiceDeps {
  store: CouncilStore;
  now?: () => string;
  newId?: () => string;
}

export class CouncilJobService {
  private readonly db: Database.Database;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(deps: CouncilJobServiceDeps) {
    this.db = deps.store.handle();
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  private rowByKey(
    tenantId: string,
    companyId: string,
    kind: string,
    idempotencyKey: string,
  ): JobRow | null {
    const row = this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM council_jobs
          WHERE tenant_id = ? AND company_id = ? AND kind = ? AND idempotency_key = ?`,
      )
      .get(tenantId, companyId, kind, idempotencyKey) as JobRow | undefined;
    return row ?? null;
  }

  private rowById(tenantId: string, companyId: string, jobId: string): JobRow | null {
    const row = this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM council_jobs WHERE tenant_id = ? AND company_id = ? AND id = ?`,
      )
      .get(tenantId, companyId, jobId) as JobRow | undefined;
    return row ?? null;
  }

  /**
   * Enqueue a durable job. Re-enqueueing with the same kind and
   * idempotency key returns the existing job unchanged (replayed),
   * whatever state it has reached: one logical operation, one job.
   */
  enqueueJob(
    scope: { tenant_id: string; company_id: string },
    input: {
      session_id: string | null;
      kind: string;
      idempotency_key: string;
      payload: Record<string, unknown>;
    },
  ): { job: CouncilJobRecord; replayed: boolean } {
    const existing = this.rowByKey(scope.tenant_id, scope.company_id, input.kind, input.idempotency_key);
    if (existing) return { job: toJobRecord(existing), replayed: true };
    const now = this.now();
    const id = this.newId();
    try {
      this.db
        .prepare(
          `INSERT INTO council_jobs
             (tenant_id, company_id, session_id, id, kind, idempotency_key, state,
              payload_json, checkpoint_json, terminal_reason, attempt_count,
              next_attempt_at, lease_owner, lease_expires_at, lease_epoch,
              last_error_code, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, 0, ?, NULL, NULL, 0, NULL, ?, ?)`,
        )
        .run(
          scope.tenant_id,
          scope.company_id,
          input.session_id,
          id,
          input.kind,
          input.idempotency_key,
          JSON.stringify(input.payload),
          now,
          now,
          now,
        );
    } catch {
      // A concurrent enqueue won the unique key; return its row.
      const winner = this.rowByKey(scope.tenant_id, scope.company_id, input.kind, input.idempotency_key);
      if (winner) return { job: toJobRecord(winner), replayed: true };
      throw new CouncilPersistenceError(
        'PERSISTENCE_INTERNAL',
        `Council job enqueue failed for kind ${input.kind} and the winning row could not be read back.`,
      );
    }
    const row = this.rowById(scope.tenant_id, scope.company_id, id);
    if (!row) {
      throw new CouncilPersistenceError('PERSISTENCE_INTERNAL', 'Council job was inserted but does not read back.');
    }
    return { job: toJobRecord(row), replayed: false };
  }

  /**
   * Claim the next due job of a kind under a lease. Exactly one
   * claimant wins: the claim is a single conditional UPDATE guarded
   * by the observed state and lease expiry.
   */
  claimDueJob(
    scope: { tenant_id: string; company_id: string },
    input: { kind: string; worker_id: string; lease_ttl_ms?: number },
  ): CouncilJobRecord | null {
    const now = this.now();
    const ttl = input.lease_ttl_ms ?? COUNCIL_JOB_LEASE_TTL_MS;
    const expires = new Date(Date.parse(now) + ttl).toISOString();
    const claim = this.db.transaction(() => {
      const candidate = this.db
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM council_jobs
            WHERE tenant_id = ? AND company_id = ? AND kind = ?
              AND ((state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
                   OR (state IN ('leased', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
            ORDER BY created_at ASC LIMIT 1`,
        )
        .get(scope.tenant_id, scope.company_id, input.kind, now, now) as JobRow | undefined;
      if (!candidate) return null;
      const result = this.db
        .prepare(
          `UPDATE council_jobs
              SET state = 'leased', lease_owner = ?, lease_expires_at = ?,
                  lease_epoch = lease_epoch + 1, attempt_count = attempt_count + 1,
                  updated_at = ?
            WHERE tenant_id = ? AND company_id = ? AND id = ? AND state = ? AND lease_epoch = ?`,
        )
        .run(
          input.worker_id,
          expires,
          now,
          scope.tenant_id,
          scope.company_id,
          candidate.id,
          candidate.state,
          candidate.lease_epoch,
        );
      if (Number(result.changes) !== 1) return null;
      return this.rowById(scope.tenant_id, scope.company_id, candidate.id);
    });
    const row = claim();
    return row ? toJobRecord(row) : null;
  }

  /** Extend a held lease; false when the caller's epoch is stale. */
  heartbeatJob(
    scope: { tenant_id: string; company_id: string },
    input: { job_id: string; worker_id: string; lease_epoch: number; lease_ttl_ms?: number },
  ): boolean {
    const now = this.now();
    const ttl = input.lease_ttl_ms ?? COUNCIL_JOB_LEASE_TTL_MS;
    const expires = new Date(Date.parse(now) + ttl).toISOString();
    const result = this.db
      .prepare(
        `UPDATE council_jobs SET lease_expires_at = ?, updated_at = ?
          WHERE tenant_id = ? AND company_id = ? AND id = ?
            AND lease_owner = ? AND lease_epoch = ? AND state IN ('leased', 'running')`,
      )
      .run(expires, now, scope.tenant_id, scope.company_id, input.job_id, input.worker_id, input.lease_epoch);
    return Number(result.changes) === 1;
  }

  /** Fenced terminal write; false when the caller's epoch is stale. */
  finishJob(
    scope: { tenant_id: string; company_id: string },
    input: {
      job_id: string;
      worker_id: string;
      lease_epoch: number;
      outcome: 'succeeded' | 'failed' | 'dead_letter';
      error_code?: string | null;
      terminal_reason?: string | null;
      checkpoint?: Record<string, unknown> | null;
    },
  ): boolean {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE council_jobs
            SET state = ?, last_error_code = ?, terminal_reason = ?,
                checkpoint_json = COALESCE(?, checkpoint_json),
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE tenant_id = ? AND company_id = ? AND id = ?
            AND lease_owner = ? AND lease_epoch = ? AND state IN ('leased', 'running')`,
      )
      .run(
        input.outcome,
        input.error_code ?? null,
        input.terminal_reason ?? null,
        input.checkpoint ? JSON.stringify(input.checkpoint) : null,
        now,
        scope.tenant_id,
        scope.company_id,
        input.job_id,
        input.worker_id,
        input.lease_epoch,
      );
    return Number(result.changes) === 1;
  }

  /** Cancel every non-terminal job for one session (session cancel fence). */
  cancelJobsForSession(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
  ): number {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE council_jobs SET state = 'cancelled', terminal_reason = 'session_cancelled',
            lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?
            AND state IN ('queued', 'leased', 'running')`,
      )
      .run(now, scope.tenant_id, scope.company_id, sessionId);
    return Number(result.changes);
  }

  listJobsForSession(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
  ): CouncilJobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM council_jobs
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? ORDER BY created_at ASC`,
      )
      .all(scope.tenant_id, scope.company_id, sessionId) as JobRow[];
    return rows.map(toJobRecord);
  }
}

// ------------------------------------------------------------ run controls

export interface RunControlReceipt {
  session_id: string;
  state: SessionState;
  state_version: number;
  idempotent_replay: boolean;
}

export interface StartRunReceipt extends RunControlReceipt {
  job_id: string;
  grant_id: string;
  attempt: number;
}

export class CouncilRunControlError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'CouncilRunControlError';
    this.code = code;
    this.status = status;
  }
}

const ACTIVE_RUN_STATES: ReadonlySet<string> = new Set([
  'READY',
  'QUEUED',
  'PREPARING',
  'ROUND_1',
  'CRUX_REVIEW',
  'ROUND_2',
  'DRAFT_RESOLUTION',
  'ROUND_3',
  'CONSULTING',
  'VERIFYING',
  'RESUMING',
]);

export interface CouncilRunControlsDeps {
  repositories: CouncilRepositories;
  jobs: CouncilJobService;
  runAuthorization: CouncilRunAuthorizationService;
  adapter: CouncilRunAuthorizationAdapter;
  now?: () => string;
}

/**
 * The session run controls (start/pause/cancel/resume) over the
 * canonical state machine, composed at the engine root. Every method
 * takes the caller's write envelope (built from the verified
 * principal by the route layer) plus the principal itself for grant
 * resolution.
 */
export class CouncilRunControls {
  private readonly repositories: CouncilRepositories;
  private readonly jobs: CouncilJobService;
  private readonly runAuthorization: CouncilRunAuthorizationService;
  private readonly adapter: CouncilRunAuthorizationAdapter;

  constructor(deps: CouncilRunControlsDeps) {
    this.repositories = deps.repositories;
    this.jobs = deps.jobs;
    this.runAuthorization = deps.runAuthorization;
    this.adapter = deps.adapter;
  }

  private load(envelope: CouncilEnvelope, sessionId: string): CouncilStoredSession {
    const session = this.repositories.getSession(envelope, sessionId);
    if (!session) {
      throw new CouncilRunControlError(
        'PERSISTENCE_SESSION_NOT_FOUND',
        `Council session ${sessionId} does not exist in this scope, or is not visible to the caller.`,
        404,
      );
    }
    return session;
  }

  private assertExpectedVersion(session: CouncilStoredSession, expectedVersion?: number): void {
    if (expectedVersion !== undefined && expectedVersion !== session.state.state_version) {
      throw new CouncilRunControlError(
        'VERSION_MISMATCH',
        `Session ${session.spec.session_id} is at state version ${session.state.state_version}, not ${expectedVersion}. The control was not applied; reload and retry.`,
        409,
      );
    }
  }

  private conflict(session: CouncilStoredSession, action: string): CouncilRunControlError {
    return new CouncilRunControlError(
      'ILLEGAL_TRANSITION',
      `Cannot ${action} session ${session.spec.session_id} from state ${session.state.state}; the canonical state machine has no such transition. Nothing was changed.`,
      409,
    );
  }

  /**
   * Start a run: resolve the session's active CWE-049 grant (an
   * explicit grant reference when supplied, otherwise the session's
   * single active granted grant), move DRAFT -> READY -> QUEUED, and
   * enqueue the durable run job. Returns a 202-style receipt; no
   * provider work happens here.
   */
  async start(
    principal: CouncilPrincipal,
    envelope: CouncilEnvelope,
    sessionId: string,
    input: { grant_id?: string | null; expected_version?: number } = {},
  ): Promise<StartRunReceipt> {
    let session = this.load(envelope, sessionId);
    this.assertExpectedVersion(session, input.expected_version);
    const scope = { tenant_id: envelope.tenant_id, company_id: envelope.company_id };

    if (session.state.state === 'QUEUED') {
      const existing = this.jobs
        .listJobsForSession(scope, sessionId)
        .find((job) => job.kind === 'council_run' && job.state !== 'cancelled');
      if (existing) {
        return {
          session_id: sessionId,
          state: session.state.state,
          state_version: session.state.state_version,
          idempotent_replay: true,
          job_id: existing.id,
          grant_id: String(existing.payload.grant_id ?? ''),
          attempt: session.state.attempt,
        };
      }
      throw new CouncilRunControlError(
        'PERSISTENCE_INTERNAL',
        `Session ${sessionId} is QUEUED but no live council_run job exists for it. The durable job record is inconsistent; reconcile it before starting again. Nothing was changed.`,
        500,
      );
    }
    if (session.state.state !== 'DRAFT' && session.state.state !== 'READY') {
      throw this.conflict(session, 'start');
    }

    const resolution = await this.adapter.resolveRunGrant({
      tenant_id: envelope.tenant_id,
      company_id: envelope.company_id,
      session_id: sessionId,
      grant_ref: input.grant_id ?? null,
    });
    if (resolution.status !== 'active' || !resolution.grant_ref) {
      throw new CouncilRunControlError(
        'RUN_AUTHORIZATION_REQUIRED',
        `Session ${sessionId} cannot start: no active run grant resolves for it (status: ${resolution.status}). ` +
          'Preview and approve a run grant through the run-authorization endpoints first; a council vote or a plan approval is not a run grant.',
        403,
      );
    }
    const grant = this.runAuthorization.resolveRunGrant(principal, resolution.grant_ref, sessionId);
    if (!grant) {
      throw new CouncilRunControlError(
        'RUN_AUTHORIZATION_REQUIRED',
        `Session ${sessionId} cannot start: grant ${resolution.grant_ref} did not resolve as active on recheck. Nothing was started.`,
        403,
      );
    }

    if (session.state.state === 'DRAFT') {
      const ready = this.repositories.transitionState(envelope, sessionId, 'READY', session.state.state_version);
      session = { ...session, state: ready };
    }
    const queued = this.repositories.transitionState(envelope, sessionId, 'QUEUED', session.state.state_version);
    const { job } = this.jobs.enqueueJob(scope, {
      session_id: sessionId,
      kind: 'council_run',
      idempotency_key: `council-run:${sessionId}:attempt:${queued.attempt}`,
      payload: {
        grant_id: grant.grant_id,
        route_policy_sha256: grant.route_policy_sha256,
        preview_sha256: grant.preview_sha256,
        brief_revision: grant.brief_revision,
        brief_sha256: grant.brief_sha256,
        mode: grant.mode,
        attempt: queued.attempt,
      },
    });
    return {
      session_id: sessionId,
      state: queued.state,
      state_version: queued.state_version,
      idempotent_replay: false,
      job_id: job.id,
      grant_id: grant.grant_id,
      attempt: queued.attempt,
    };
  }

  /** Pause at a safe boundary (idempotent on an already-paused session). */
  pause(
    envelope: CouncilEnvelope,
    sessionId: string,
    input: { expected_version?: number } = {},
  ): RunControlReceipt {
    const session = this.load(envelope, sessionId);
    this.assertExpectedVersion(session, input.expected_version);
    const current = session.state;
    if (current.state === 'PAUSED') {
      return { session_id: sessionId, state: current.state, state_version: current.state_version, idempotent_replay: true };
    }
    if (current.state !== 'PAUSE_REQUESTED' && !ACTIVE_RUN_STATES.has(current.state)) {
      throw this.conflict(session, 'pause');
    }
    const prePausePhase = current.state === 'PAUSE_REQUESTED' ? current.resume_phase : current.state;
    let record = current;
    if (current.state !== 'PAUSE_REQUESTED') {
      record = this.repositories.transitionState(envelope, sessionId, 'PAUSE_REQUESTED', current.state_version);
    }
    record = this.repositories.transitionState(envelope, sessionId, 'PAUSED', record.state_version);
    if (record.resume_phase !== prePausePhase) {
      // Correct the store's resume_phase bookkeeping (see header):
      // the recorded resume phase must be the phase pause interrupted.
      const corrected = {
        ...record,
        resume_phase: prePausePhase,
        state_version: record.state_version + 1,
        updated_at: new Date().toISOString(),
      };
      this.repositories.writeStateRecord(envelope, corrected, record.state_version);
      record = corrected;
    }
    return { session_id: sessionId, state: record.state, state_version: record.state_version, idempotent_replay: false };
  }

  /** Cancel: fences future work immediately; CANCELLED stays terminal. */
  cancel(
    envelope: CouncilEnvelope,
    sessionId: string,
    input: { expected_version?: number; reason?: string | null } = {},
  ): RunControlReceipt {
    const session = this.load(envelope, sessionId);
    this.assertExpectedVersion(session, input.expected_version);
    const current = session.state;
    if (current.state === 'CANCELLED') {
      return { session_id: sessionId, state: current.state, state_version: current.state_version, idempotent_replay: true };
    }
    if (current.state === 'COMPLETED' || current.state === 'FAILED') {
      throw this.conflict(session, 'cancel');
    }
    let record = current;
    if (current.state !== 'CANCEL_REQUESTED') {
      record = this.repositories.transitionState(envelope, sessionId, 'CANCEL_REQUESTED', current.state_version);
    }
    record = this.repositories.transitionState(envelope, sessionId, 'CANCELLED', record.state_version);
    this.jobs.cancelJobsForSession(
      { tenant_id: envelope.tenant_id, company_id: envelope.company_id },
      sessionId,
    );
    return { session_id: sessionId, state: record.state, state_version: record.state_version, idempotent_replay: false };
  }

  /** Resume a paused or blocked session to its recorded phase. */
  resume(
    envelope: CouncilEnvelope,
    sessionId: string,
    input: { expected_version?: number } = {},
  ): RunControlReceipt {
    const session = this.load(envelope, sessionId);
    this.assertExpectedVersion(session, input.expected_version);
    const current = session.state;
    if (current.state !== 'PAUSED' && current.state !== 'BLOCKED') {
      throw this.conflict(session, 'resume');
    }
    const target = current.resume_phase;
    if (!target || target === 'PAUSE_REQUESTED' || target === 'PAUSED' || !ACTIVE_RUN_STATES.has(target)) {
      throw new CouncilRunControlError(
        'ILLEGAL_TRANSITION',
        `Session ${sessionId} records resume phase ${target ?? 'null'}, which is not a resumable active phase. The record is not guessed at; reconcile it before resuming.`,
        409,
      );
    }
    let record = this.repositories.transitionState(envelope, sessionId, 'RESUMING', current.state_version);
    record = this.repositories.transitionState(envelope, sessionId, target, record.state_version);
    return { session_id: sessionId, state: record.state, state_version: record.state_version, idempotent_replay: false };
  }
}

/** Build the write envelope for run controls from a session's scope. */
export function runControlEnvelope(
  session: CouncilStoredSession,
  actorSubject: string,
): CouncilEnvelope {
  return envelopeFromScope(session.scope, actorSubject, 'owner', 'write');
}
