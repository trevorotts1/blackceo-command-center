/**
 * CWE-049 managed run authorization for the Command Center host
 * (directive Sections 1.2, 11, 15, 17.5, 25.6, 28).
 *
 * This is the managed trusted-principal adapter for the ONE canonical
 * RunAuthorizationService: the same service semantics as the portable
 * core (openclaw-onboarding 77-council-of-wise-elders/runtime/src/
 * authorization/run-grants.ts and admission.ts), over this host's
 * scoped store (CWE-006 CouncilRepositories and the CWE-005 adapter)
 * and this host's trusted principal (CWE-007's auth.ts:
 * resolveCouncilPrincipal over the verified tenant context). The
 * managed HTTP endpoints that bind these operations are CWE-050's;
 * this module is the service behind them.
 *
 * Semantics, identical to the portable service:
 * - Purpose-bound grants over the durable council_approvals run_grant
 *   record (the money authority): principal, scope (installation,
 *   tenant, company, owner), session, purpose, pinned route snapshot
 *   fingerprint, frozen brief hash, mode and seats, pack and protocol
 *   versions, allowed operation kinds, ceilings, expiry. Previews
 *   default to 15 minutes, grants to 24 hours; a stricter chosen
 *   limit or a standing parent's earlier expiry wins.
 * - No authority before approval: a preview writes its grant row born
 *   'expired' (the council_run_previews foreign key requires the row;
 *   the status confers nothing and admission refuses it), and
 *   approveRun is the only transition to 'active'.
 * - No bypass: approval requires a host-verified managed principal or
 *   a pre-existing standing grant that verifiably covers the exact
 *   envelope, checked here, in the same operation. No flag, file,
 *   environment variable, or model output is read as approval, and a
 *   council outcome is never a run credential (the four authorizations
 *   of Section 1.2 stay separate kinds). The local interactive owner
 *   mode belongs to the standalone form and is refused here: this host
 *   has no local owner channel.
 * - Admission composes with the shared budget accounting over
 *   council_budget_reservations (the CWE-028 semantics: session-wide
 *   counting inside the reservation transaction, unknown completion
 *   counted at estimate, settle and release exactly once, lease-epoch
 *   fencing). There is no second ledger: reservations are rows in the
 *   same table the portable service uses, journaled the same way.
 * - Revocation and expiry are durable and immediate; every resolve
 *   and admission re-reads the record, so replays of an earlier
 *   admission are fenced with everything else. Lifecycle events ride
 *   CWE-006's hash-chained journal with the frozen vocabulary
 *   (grant_issued and grant_revoked carry a grant_kind discriminator;
 *   no event type is invented).
 * - Support access never approves, revokes, or mutates: the CWE-007
 *   session mutation decision is reused, not re-derived.
 */

import type Database from 'better-sqlite3';
import {
  assertCouncilSessionMutate,
  CouncilAuthError,
  type CouncilPrincipal,
} from './auth';
import {
  CONTRACT_PACKAGE_VERSION,
  DEFAULT_COUNCIL_SETTINGS,
  canonicalHash,
  canonicalStringify,
  validateRunGrant,
  validateRunPreview,
  type CouncilEventType,
  type GrantStatus,
  type RunCeilings,
  type RunGrant,
  type RunGrantAuthorityMode,
  type RunPreview,
  type RunPurpose,
} from './contracts';
import type { CouncilRouteSelection } from './explicit-selection';
import {
  CouncilRepositories,
  envelopeFromScope,
  type CouncilEnvelope,
  type CouncilStoredSession,
} from './store';
import type { CouncilStore } from './persistence/council-store';

// ------------------------------------------------------------------ errors

export type CouncilRunAuthorizationErrorCode =
  | 'RUN_AUTHORIZATION_REQUIRED'
  | 'RUN_AUTHORITY_MODE_MISMATCH'
  | 'RUN_INVALID_INPUT'
  | 'RUN_SESSION_NOT_FOUND'
  | 'RUN_PREVIEW_NOT_FOUND'
  | 'RUN_PREVIEW_EXPIRED'
  | 'RUN_PREVIEW_STALE'
  | 'RUN_PREVIEW_TAMPERED'
  | 'RUN_MONEY_UNBOUNDED'
  | 'RUN_GRANT_NOT_FOUND'
  | 'RUN_GRANT_INACTIVE'
  | 'RUN_GRANT_SCOPE_MISMATCH'
  | 'RUN_GRANT_ROUTE_MISMATCH'
  | 'RUN_GRANT_PURPOSE_MISMATCH'
  | 'RUN_GRANT_KIND_NOT_ALLOWED'
  | 'RUN_GRANT_PARENT_INVALID'
  | 'RUN_GRANT_WOULD_BROADEN'
  | 'RUN_OPERATION_GRANT_MISMATCH'
  | 'BUDGET_EXHAUSTED'
  | 'BUDGET_LEASE_FENCED'
  | 'BUDGET_RESERVATION_FINALIZED'
  | 'BUDGET_RESERVATION_NOT_FOUND';

/** Stable typed refusal; callers branch on code, never message text. */
export class CouncilRunAuthorizationError extends Error {
  readonly code: CouncilRunAuthorizationErrorCode;
  readonly detail: Record<string, unknown> | null;

  constructor(
    code: CouncilRunAuthorizationErrorCode,
    message: string,
    detail: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'CouncilRunAuthorizationError';
    this.code = code;
    this.detail = detail;
  }
}

function invalidInput(message: string): CouncilRunAuthorizationError {
  return new CouncilRunAuthorizationError('RUN_INVALID_INPUT', message);
}

// ------------------------------------------------------------------ shapes

export const PREVIEW_TTL_MS = 900_000;
export const GRANT_TTL_MS = 86_400_000;

export interface RunGrantProof {
  proof_version: 'run-grant-proof/v1';
  stage: 'preview' | 'granted';
  standing: boolean;
  installation_id: string;
  owner_subject: string | null;
  route_policy_sha256: string;
  route_snapshot: CouncilRouteSelection | null;
  route_snapshot_fingerprint: string | null;
  brief_sha256: string | null;
  brief_revision: number | null;
  mode: string | null;
  pack_version: string | null;
  protocol_version: string;
  allowed_operation_kinds: string[];
  ceilings: RunCeilings;
  account_ref: string | null;
  preview_id: string | null;
  preview_sha256: string | null;
  revocation_epoch: number;
  renews_grant_id: string | null;
}

export interface RunGrantRecord {
  grant_id: string;
  session_id: string | null;
  authority_mode: RunGrantAuthorityMode;
  purpose: RunPurpose;
  issuer_principal: string;
  seat_ids: string[];
  status: GrantStatus;
  issued_at: string;
  expires_at: string;
  max_cost_minor: number | null;
  currency: string | null;
  parent_grant_id: string | null;
  proof: RunGrantProof;
}

export interface PreviewRunInput {
  session_id: string;
  purpose?: RunPurpose;
  route_snapshot: CouncilRouteSelection;
  route_policy_sha256: string;
  ceilings: RunCeilings;
  allowed_operation_kinds?: string[];
  account_ref?: string | null;
  require_money_bound?: boolean;
}

export interface ApproveRunDecision {
  authority_mode: RunGrantAuthorityMode;
  standing_parent_grant_id?: string | null;
  chosen_expires_at?: string | null;
  chosen_ceilings?: Partial<RunCeilings> | null;
  renews_grant_id?: string | null;
  current_route_snapshot?: CouncilRouteSelection | null;
}

export interface StandingAuthorizationInput {
  purpose: RunPurpose;
  route_policy_sha256: string;
  pack_version: string;
  seat_ids: string[];
  ceilings: RunCeilings;
  allowed_operation_kinds?: string[];
  account_ref?: string | null;
  expires_at: string;
}

export type BudgetReservationKind =
  | 'provider_request'
  | 'output_repair'
  | 'transport_retry'
  | 'semantic_verification';

export interface AdmitOperationInput {
  grant_id: string;
  session_id: string;
  operation_id: string;
  kind: BudgetReservationKind;
  purpose?: string;
  estimate_minor: number;
  currency?: string | null;
  lease_epoch: number;
  route_snapshot: CouncilRouteSelection;
  original_operation_id?: string | null;
}

export interface Admission {
  operation_id: string;
  reservation_id: string;
  grant_id: string;
  session_id: string;
  kind: BudgetReservationKind;
  state: string;
  estimate_minor: number;
  currency: string;
  route_snapshot_fingerprint: string;
  revocation_epoch: number;
  replayed: boolean;
}

const OPERATION_KINDS_BY_PURPOSE: Readonly<Record<RunPurpose, string[]>> = {
  council_run: [
    'provider_request',
    'output_repair',
    'transport_retry',
    'semantic_verification',
  ],
  follow_up: [
    'provider_request',
    'output_repair',
    'transport_retry',
    'semantic_verification',
  ],
  capability_probe: ['provider_request'],
  intake_refinement: ['provider_request'],
};

const ACTIVE_RESERVATION_STATES = new Set(['reserved', 'committed', 'unknown']);
const STATE_EVENT_TYPES: CouncilEventType[] = [
  'session_created',
  'session_state_changed',
  'session_paused',
  'session_cancelled',
  'session_blocked',
  'session_failed',
];

interface ApprovalRow {
  id: string;
  session_id: string | null;
  authority_mode: string;
  purpose: string;
  actor_subject: string;
  parent_approval_id: string | null;
  scope_proof: string;
  max_cost_minor: number | null;
  currency: string | null;
  seat_allowlist_json: string | null;
  status: string;
  issued_at: string;
  expires_at: string;
}

interface ReservationRow {
  id: string;
  session_id: string;
  operation_id: string;
  grant_id: string;
  estimate_minor: number;
  actual_minor: number | null;
  currency: string;
  state: string;
  hold_expires_at: string;
  created_at: string;
  finalized_at: string | null;
}

const APPROVAL_COLUMNS = `id, session_id, authority_mode, purpose, actor_subject,
  parent_approval_id, scope_proof, max_cost_minor, currency, seat_allowlist_json,
  status, issued_at, expires_at`;

// ------------------------------------------------------------------ service

export interface CouncilRunAuthorizationDeps {
  /** The CWE-005 adapter over the host database. */
  store: CouncilStore;
  now?: () => string;
  newId?: () => string;
  previewTtlMs?: number;
  grantTtlMs?: number;
}

export class CouncilRunAuthorizationService {
  private readonly db: Database.Database;
  private readonly repositories: CouncilRepositories;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly previewTtlMs: number;
  private readonly grantTtlMs: number;

  constructor(deps: CouncilRunAuthorizationDeps) {
    this.db = deps.store.handle();
    this.now = deps.now ?? (() => new Date().toISOString());
    let counter = 0;
    this.newId =
      deps.newId ??
      (() => {
        counter += 1;
        return `run-auth-${Date.now().toString(36)}-${counter}`;
      });
    this.previewTtlMs = deps.previewTtlMs ?? PREVIEW_TTL_MS;
    this.grantTtlMs = deps.grantTtlMs ?? GRANT_TTL_MS;
    this.repositories = new CouncilRepositories({
      adapter: deps.store,
      now: this.now,
      newId: this.newId,
    });
  }

  // ------------------------------------------------------------- internals

  private envelope(principal: CouncilPrincipal): CouncilEnvelope {
    return envelopeFromScope(principal.scope, principal.subject, 'owner', 'write');
  }

  private write<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Append one journal event with the CWE-006 hash chain, in the caller's transaction. */
  private appendJournal(
    envelope: CouncilEnvelope,
    sessionId: string,
    input: {
      type: CouncilEventType;
      actor_subject: string;
      payload: Record<string, unknown>;
      created_at: string;
    },
  ): number {
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
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.tenant_id,
        envelope.company_id,
        sessionId,
        sequence,
        this.newId(),
        input.type,
        input.actor_subject,
        payloadJson,
        prevHash,
        eventHash,
        input.created_at,
      );
    return sequence;
  }

  private enqueueOutbox(
    envelope: CouncilEnvelope,
    input: {
      session_id: string | null;
      event_sequence: number | null;
      topic: string;
      idempotency_key: string;
      payload: Record<string, unknown>;
      created_at: string;
    },
  ): void {
    const existing = this.db
      .prepare(
        `SELECT id FROM council_projection_outbox
          WHERE tenant_id = ? AND company_id = ? AND topic = ? AND idempotency_key = ?`,
      )
      .get(envelope.tenant_id, envelope.company_id, input.topic, input.idempotency_key);
    if (existing) return;
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
        this.newId(),
        input.event_sequence,
        input.topic,
        input.idempotency_key,
        canonicalStringify(input.payload),
        input.created_at,
      );
  }

  private sessionFor(
    principal: CouncilPrincipal,
    sessionId: string,
  ): CouncilStoredSession {
    const session = this.repositories.getSession(this.envelope(principal), sessionId);
    if (!session) {
      throw new CouncilRunAuthorizationError(
        'RUN_SESSION_NOT_FOUND',
        `Council session ${sessionId} does not exist in this scope, or is not visible to the principal. The two cases are indistinguishable by design.`,
        { session_id: sessionId },
      );
    }
    return session;
  }

  private approvalRow(
    envelope: CouncilEnvelope,
    grantId: string,
  ): ApprovalRow | null {
    const row = this.db
      .prepare(
        `SELECT ${APPROVAL_COLUMNS} FROM council_approvals
          WHERE tenant_id = ? AND company_id = ? AND id = ? AND kind = 'run_grant'`,
      )
      .get(envelope.tenant_id, envelope.company_id, grantId) as ApprovalRow | undefined;
    return row ?? null;
  }

  loadGrantRecord(
    principal: CouncilPrincipal,
    grantId: string,
  ): RunGrantRecord | null {
    const envelope = this.envelope(principal);
    const row = this.approvalRow(envelope, grantId);
    if (!row) return null;
    const proof = parseProof(row);
    if (proof.installation_id !== envelope.installation_id) return null;
    let seatIds: string[] = [];
    if (row.seat_allowlist_json) {
      try {
        const parsed = JSON.parse(row.seat_allowlist_json) as unknown;
        if (Array.isArray(parsed)) {
          seatIds = parsed.filter((s): s is string => typeof s === 'string');
        }
      } catch {
        seatIds = [];
      }
    }
    return {
      grant_id: row.id,
      session_id: row.session_id,
      authority_mode: row.authority_mode as RunGrantAuthorityMode,
      purpose: row.purpose as RunPurpose,
      issuer_principal: row.actor_subject,
      seat_ids: seatIds,
      status: row.status as GrantStatus,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      max_cost_minor: row.max_cost_minor,
      currency: row.currency,
      parent_grant_id: row.parent_approval_id,
      proof,
    };
  }

  private allowedKinds(purpose: RunPurpose, requested?: string[]): string[] {
    const allowed = OPERATION_KINDS_BY_PURPOSE[purpose];
    if (!requested) return [...allowed];
    for (const kind of requested) {
      if (!allowed.includes(kind)) {
        throw invalidInput(`Operation kind ${kind} is not available to purpose ${purpose}.`);
      }
    }
    return [...requested];
  }

  standingParentStands(parent: RunGrantRecord): boolean {
    return (
      parent.proof.standing &&
      parent.proof.stage === 'granted' &&
      parent.status === 'active' &&
      Date.parse(parent.expires_at) > Date.parse(this.now())
    );
  }

  /** Flip an active-but-lapsed grant to 'expired', journaled. Returns true when flipped. */
  expireGrantIfLapsed(principal: CouncilPrincipal, record: RunGrantRecord): boolean {
    if (record.status !== 'active') return false;
    const now = this.now();
    if (Date.parse(record.expires_at) > Date.parse(now)) return false;
    const envelope = this.envelope(principal);
    let flipped = false;
    this.write(() => {
      const result = this.db
        .prepare(
          `UPDATE council_approvals SET status = 'expired'
            WHERE tenant_id = ? AND company_id = ? AND id = ? AND status = 'active'`,
        )
        .run(envelope.tenant_id, envelope.company_id, record.grant_id);
      flipped = Number(result.changes) === 1;
      if (flipped && record.session_id !== null) {
        const sequence = this.appendJournal(envelope, record.session_id, {
          type: 'operation_completed',
          actor_subject: envelope.actor_subject,
          payload: {
            grant_kind: 'run_grant',
            lifecycle: 'expired',
            outcome: 'grant_expired',
            grant_id: record.grant_id,
            expires_at: record.expires_at,
          },
          created_at: now,
        });
        this.enqueueOutbox(envelope, {
          session_id: record.session_id,
          event_sequence: sequence,
          topic: 'run_authorization.grant_expired',
          idempotency_key: `run-authorization:grant:${record.grant_id}:expired`,
          payload: { grant_id: record.grant_id, session_id: record.session_id, event_sequence: sequence },
          created_at: now,
        });
      }
    });
    return flipped;
  }

  // ------------------------------------------------------------ previewRun

  previewRun(principal: CouncilPrincipal, input: PreviewRunInput): RunPreview {
    const envelope = this.envelope(principal);
    const purpose: RunPurpose = input.purpose ?? 'council_run';
    if (input.require_money_bound === true && input.ceilings.max_money === null) {
      throw new CouncilRunAuthorizationError(
        'RUN_MONEY_UNBOUNDED',
        'This run requires a hard currency ceiling, but the requested envelope carries no money bound and no reliable upper bound can be computed. Admission is blocked rather than promised on an unknown price.',
      );
    }
    const snapScope = input.route_snapshot.scope;
    if (
      snapScope.tenantId !== envelope.tenant_id ||
      snapScope.companyId !== envelope.company_id ||
      snapScope.installationId !== envelope.installation_id
    ) {
      throw new CouncilRunAuthorizationError(
        'RUN_GRANT_SCOPE_MISMATCH',
        'The pinned route snapshot scope does not match the trusted principal scope.',
        { session_id: input.session_id },
      );
    }
    const session = this.sessionFor(principal, input.session_id);
    const allowedKinds = this.allowedKinds(purpose, input.allowed_operation_kinds);
    const now = this.now();
    const expiresAt = new Date(Date.parse(now) + this.previewTtlMs).toISOString();
    const previewId = this.newId();
    const grantId = this.newId();
    const fingerprint = canonicalHash(
      input.route_snapshot as unknown as Record<string, unknown>,
    );
    const briefSha256 = canonicalHash(session.brief);
    const previewContent = {
      schema_version: 'wise-elders.run-preview/v1' as const,
      preview_id: previewId,
      session_id: session.spec.session_id,
      brief_revision: session.brief.revision,
      brief_sha256: briefSha256,
      mode: session.spec.mode,
      seat_ids: [...session.spec.seat_ids],
      purpose,
      route_policy_sha256: input.route_policy_sha256,
      pack_version: session.spec.source_pack_version,
      ceilings: input.ceilings,
      money_bounded: input.ceilings.max_money !== null,
      created_at: now,
      expires_at: expiresAt,
    };
    const previewSha = canonicalHash(previewContent);
    const preview: RunPreview = { ...previewContent, preview_sha256: previewSha };
    const check = validateRunPreview(preview);
    if (!check.ok) {
      throw invalidInput(
        `The preview does not satisfy the canonical RunPreview contract: ${check.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const proof: RunGrantProof = {
      proof_version: 'run-grant-proof/v1',
      stage: 'preview',
      standing: false,
      installation_id: envelope.installation_id,
      owner_subject: session.scope.owner_subject,
      route_policy_sha256: input.route_policy_sha256,
      route_snapshot: input.route_snapshot,
      route_snapshot_fingerprint: fingerprint,
      brief_sha256: briefSha256,
      brief_revision: session.brief.revision,
      mode: session.spec.mode,
      pack_version: session.spec.source_pack_version,
      protocol_version: CONTRACT_PACKAGE_VERSION,
      allowed_operation_kinds: allowedKinds,
      ceilings: input.ceilings,
      account_ref: input.account_ref ?? null,
      preview_id: previewId,
      preview_sha256: previewSha,
      revocation_epoch: session.state.revocation_generation,
      renews_grant_id: null,
    };
    this.write(() => {
      this.db
        .prepare(
          `INSERT INTO council_approvals
             (tenant_id, company_id, id, kind, session_id, action_proposal_id,
              authority_mode, purpose, actor_subject, actor_role,
              parent_approval_id, scope_proof, current_plan_hash, verdict_hash,
              max_cost_minor, currency, seat_allowlist_json,
              company_scope_verified, status, issued_at, expires_at,
              revoked_at, revoked_by, consumed_at)
           VALUES (?, ?, ?, 'run_grant', ?, NULL, 'managed_principal', ?, ?, 'requester',
                   NULL, ?, NULL, NULL, ?, ?, ?, 1, 'expired', ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          envelope.tenant_id,
          envelope.company_id,
          grantId,
          session.spec.session_id,
          purpose,
          envelope.actor_subject,
          canonicalStringify(proof),
          input.ceilings.max_money?.amount_minor ?? null,
          input.ceilings.max_money?.currency ?? null,
          canonicalStringify([...session.spec.seat_ids]),
          now,
          expiresAt,
        );
      this.db
        .prepare(
          `INSERT INTO council_run_previews
             (tenant_id, company_id, session_id, id, grant_id, preview_json,
              preview_hash, estimate_minor, currency, cost_confirmed,
              frozen_seat_count, risk_class, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.tenant_id,
          envelope.company_id,
          session.spec.session_id,
          previewId,
          grantId,
          canonicalStringify(preview),
          previewSha,
          input.ceilings.max_money?.amount_minor ?? 0,
          input.ceilings.max_money?.currency ?? '',
          input.ceilings.max_money !== null ? 1 : 0,
          session.spec.seat_ids.length,
          input.ceilings.max_money === null
            ? 'high'
            : input.ceilings.max_provider_requests >= 50
              ? 'medium'
              : 'low',
          expiresAt,
          now,
        );
      const sequence = this.appendJournal(envelope, session.spec.session_id, {
        type: 'grant_issued',
        actor_subject: envelope.actor_subject,
        payload: {
          grant_kind: 'run_grant',
          lifecycle: 'preview',
          authority: 'none',
          preview_id: previewId,
          prospective_grant_id: grantId,
          preview_sha256: previewSha,
          purpose,
          expires_at: expiresAt,
        },
        created_at: now,
      });
      this.enqueueOutbox(envelope, {
        session_id: session.spec.session_id,
        event_sequence: sequence,
        topic: 'run_authorization.preview',
        idempotency_key: `run-authorization:preview:${previewId}`,
        payload: { preview_id: previewId, session_id: session.spec.session_id, preview_sha256: previewSha, event_sequence: sequence },
        created_at: now,
      });
    });
    return preview;
  }

  // ------------------------------------------------------------ approveRun

  approveRun(
    principal: CouncilPrincipal,
    previewId: string,
    decision: ApproveRunDecision,
  ): RunGrant {
    const envelope = this.envelope(principal);
    if (decision.authority_mode === 'local_interactive_owner') {
      throw new CouncilRunAuthorizationError(
        'RUN_AUTHORITY_MODE_MISMATCH',
        'The managed host has no local interactive owner channel; standalone approval belongs to the portable runtime form of this service.',
      );
    }
    const previewRow = this.db
      .prepare(
        `SELECT id, session_id, grant_id, preview_json, preview_hash FROM council_run_previews
          WHERE tenant_id = ? AND company_id = ? AND id = ?`,
      )
      .get(envelope.tenant_id, envelope.company_id, previewId) as
      | { id: string; session_id: string; grant_id: string; preview_json: string; preview_hash: string }
      | undefined;
    if (!previewRow) {
      throw new CouncilRunAuthorizationError(
        'RUN_PREVIEW_NOT_FOUND',
        `No run preview ${previewId} exists in this scope.`,
        { preview_id: previewId },
      );
    }
    const preview = verifyPreviewRow(previewRow);
    const session = this.sessionFor(principal, previewRow.session_id);
    const now = this.now();
    if (Date.parse(preview.expires_at) <= Date.parse(now)) {
      throw new CouncilRunAuthorizationError(
        'RUN_PREVIEW_EXPIRED',
        `Preview ${previewId} expired at ${preview.expires_at}.`,
        { preview_id: previewId },
      );
    }
    const stale: string[] = [];
    if (canonicalHash(session.brief) !== preview.brief_sha256) stale.push('brief');
    if (session.brief.revision !== preview.brief_revision) stale.push('brief_revision');
    if (session.spec.mode !== preview.mode) stale.push('mode');
    if (canonicalStringify([...session.spec.seat_ids]) !== canonicalStringify([...preview.seat_ids])) stale.push('seats');
    if (session.spec.source_pack_version !== preview.pack_version) stale.push('pack');
    if (stale.length > 0) {
      throw new CouncilRunAuthorizationError(
        'RUN_PREVIEW_STALE',
        `Preview ${previewId} is stale: ${stale.join(', ')} changed since it was frozen.`,
        { preview_id: previewId, changed: stale },
      );
    }
    // Mutation rights over the session (CWE-007 decision): support
    // never approves, and a private session approves only for its owner.
    assertCouncilSessionMutate(principal, {
      scope: session.scope,
      visibility: session.spec.visibility,
    });
    const anchor = this.approvalRow(envelope, previewRow.grant_id);
    if (!anchor || anchor.session_id !== previewRow.session_id) {
      throw new CouncilRunAuthorizationError(
        'RUN_PREVIEW_TAMPERED',
        `Preview ${previewId} references a grant anchor that is missing or bound to another session.`,
        { preview_id: previewId },
      );
    }
    const anchorProof = parseProof(anchor);
    if (anchorProof.stage !== 'preview' || anchorProof.preview_sha256 !== preview.preview_sha256) {
      throw new CouncilRunAuthorizationError(
        'RUN_PREVIEW_TAMPERED',
        `Preview ${previewId} was already consumed or its anchor does not match the preview hash.`,
        { preview_id: previewId },
      );
    }
    if (
      decision.current_route_snapshot &&
      anchorProof.route_snapshot_fingerprint !== null &&
      canonicalHash(decision.current_route_snapshot as unknown as Record<string, unknown>) !==
        anchorProof.route_snapshot_fingerprint
    ) {
      throw new CouncilRunAuthorizationError(
        'RUN_PREVIEW_STALE',
        `Preview ${previewId} is stale: route changed since it was frozen.`,
        { preview_id: previewId, changed: ['route'] },
      );
    }

    let parent: RunGrantRecord | null = null;
    if (decision.authority_mode === 'existing_standing_grant') {
      const parentId = decision.standing_parent_grant_id ?? null;
      if (!parentId) throw invalidInput('existing_standing_grant approval requires standing_parent_grant_id.');
      parent = this.loadGrantRecord(principal, parentId);
      if (!parent) {
        throw new CouncilRunAuthorizationError(
          'RUN_GRANT_PARENT_INVALID',
          `Standing grant ${parentId} does not exist in this scope.`,
          { standing_parent_grant_id: parentId },
        );
      }
      assertStandingCoverage(envelope, parent, preview, anchorProof, session, this.standingParentStands(parent));
    }

    let ceilings = tightenCeilings(preview.ceilings, decision.chosen_ceilings ?? null, previewId);
    if (parent) ceilings = minCeilings(ceilings, parent.proof.ceilings);
    let expiresAt = new Date(Date.parse(now) + this.grantTtlMs).toISOString();
    if (decision.chosen_expires_at) {
      if (Date.parse(decision.chosen_expires_at) > Date.parse(expiresAt)) {
        throw new CouncilRunAuthorizationError(
          'RUN_GRANT_WOULD_BROADEN',
          'A chosen expiry later than the default grant validity would broaden the approval.',
          { chosen_expires_at: decision.chosen_expires_at },
        );
      }
      expiresAt = decision.chosen_expires_at;
    }
    if (parent && Date.parse(parent.expires_at) < Date.parse(expiresAt)) {
      expiresAt = parent.expires_at;
    }
    if (Date.parse(expiresAt) <= Date.parse(now)) {
      throw new CouncilRunAuthorizationError(
        'RUN_GRANT_PARENT_INVALID',
        'The resulting grant would already be expired.',
        { preview_id: previewId },
      );
    }

    const proof: RunGrantProof = {
      ...anchorProof,
      stage: 'granted',
      ceilings,
      revocation_epoch: session.state.revocation_generation,
      renews_grant_id: decision.renews_grant_id ?? null,
    };
    this.write(() => {
      const result = this.db
        .prepare(
          `UPDATE council_approvals
              SET authority_mode = ?, actor_subject = ?, actor_role = ?,
                  parent_approval_id = ?, scope_proof = ?,
                  max_cost_minor = ?, currency = ?, status = 'active',
                  issued_at = ?, expires_at = ?
            WHERE tenant_id = ? AND company_id = ? AND id = ? AND status = 'expired'`,
        )
        .run(
          decision.authority_mode,
          principal.subject,
          decision.authority_mode === 'managed_principal' ? 'managed_principal' : 'standing_grant',
          parent ? parent.grant_id : null,
          canonicalStringify(proof),
          ceilings.max_money?.amount_minor ?? null,
          ceilings.max_money?.currency ?? null,
          now,
          expiresAt,
          envelope.tenant_id,
          envelope.company_id,
          previewRow.grant_id,
        );
      if (Number(result.changes) !== 1) {
        throw new CouncilRunAuthorizationError(
          'RUN_PREVIEW_TAMPERED',
          `Preview ${previewId} changed state while approval was in flight.`,
          { preview_id: previewId },
        );
      }
      const sequence = this.appendJournal(envelope, session.spec.session_id, {
        type: 'grant_issued',
        actor_subject: principal.subject,
        payload: {
          grant_kind: 'run_grant',
          lifecycle: 'approved',
          grant_id: previewRow.grant_id,
          preview_id: previewId,
          preview_sha256: preview.preview_sha256,
          authority_mode: decision.authority_mode,
          standing_parent_grant_id: parent ? parent.grant_id : null,
          renews_grant_id: decision.renews_grant_id ?? null,
          purpose: preview.purpose,
          expires_at: expiresAt,
        },
        created_at: now,
      });
      this.enqueueOutbox(envelope, {
        session_id: session.spec.session_id,
        event_sequence: sequence,
        topic: 'run_authorization.grant_issued',
        idempotency_key: `run-authorization:grant:${previewRow.grant_id}:issued`,
        payload: { grant_id: previewRow.grant_id, session_id: session.spec.session_id, event_sequence: sequence },
        created_at: now,
      });
    });
    const grant = this.resolveRunGrant(principal, previewRow.grant_id, session.spec.session_id);
    if (!grant) {
      throw new CouncilRunAuthorizationError(
        'RUN_GRANT_INACTIVE',
        `Grant ${previewRow.grant_id} was approved but does not resolve as active.`,
        { grant_id: previewRow.grant_id },
      );
    }
    return grant;
  }

  // ---------------------------------------------------------- resolveRunGrant

  resolveRunGrant(
    principal: CouncilPrincipal,
    grantRef: string,
    sessionId?: string,
  ): RunGrant | null {
    const record = this.loadGrantRecord(principal, grantRef);
    if (!record) return null;
    if (record.proof.stage !== 'granted') return null;
    if (record.proof.standing || record.session_id === null) return null;
    if (sessionId !== undefined && record.session_id !== sessionId) return null;
    if (record.status === 'revoked' || record.status === 'exhausted') return null;
    if (record.status === 'expired') return null;
    if (Date.parse(record.expires_at) <= Date.parse(this.now())) {
      this.expireGrantIfLapsed(principal, record);
      return null;
    }
    const session = this.repositories.getSession(this.envelope(principal), record.session_id);
    if (!session) return null;
    if (session.state.revocation_generation > record.proof.revocation_epoch) return null;
    if (record.parent_grant_id) {
      const parent = this.loadGrantRecord(principal, record.parent_grant_id);
      if (!parent || !this.standingParentStands(parent)) return null;
    }
    return this.toRunGrant(principal, record);
  }

  // ----------------------------------------------------------- revokeRunGrant

  revokeRunGrant(
    principal: CouncilPrincipal,
    grantId: string,
  ): { grant_id: string; status: GrantStatus; already_final: boolean } {
    const envelope = this.envelope(principal);
    const record = this.loadGrantRecord(principal, grantId);
    if (!record || record.proof.stage !== 'granted') {
      throw new CouncilRunAuthorizationError(
        'RUN_GRANT_NOT_FOUND',
        `No active run grant ${grantId} exists in this scope. Nothing was revoked.`,
        { grant_id: grantId },
      );
    }
    if (record.session_id !== null) {
      const session = this.sessionFor(principal, record.session_id);
      assertCouncilSessionMutate(principal, {
        scope: session.scope,
        visibility: session.spec.visibility,
      });
    } else if (principal.subject !== record.issuer_principal) {
      throw new CouncilAuthError(
        'COUNCIL_PERMISSION_DENIED',
        'A standing authorization can be revoked only by its issuer.',
      );
    }
    if (record.status === 'revoked') {
      return { grant_id: grantId, status: 'revoked', already_final: true };
    }
    if (record.status === 'expired' || record.status === 'exhausted') {
      return { grant_id: grantId, status: record.status, already_final: true };
    }
    const now = this.now();
    this.write(() => {
      const result = this.db
        .prepare(
          `UPDATE council_approvals SET status = 'revoked', revoked_at = ?, revoked_by = ?
            WHERE tenant_id = ? AND company_id = ? AND id = ? AND status = 'active'`,
        )
        .run(now, principal.subject, envelope.tenant_id, envelope.company_id, grantId);
      if (Number(result.changes) !== 1) {
        throw new CouncilRunAuthorizationError('RUN_GRANT_INACTIVE', `Grant ${grantId} changed state while revocation was in flight.`, { grant_id: grantId });
      }
      if (record.session_id !== null) {
        const sequence = this.appendJournal(envelope, record.session_id, {
          type: 'grant_revoked',
          actor_subject: principal.subject,
          payload: {
            grant_kind: 'run_grant',
            lifecycle: 'revoked',
            grant_id: grantId,
            purpose: record.purpose,
          },
          created_at: now,
        });
        this.enqueueOutbox(envelope, {
          session_id: record.session_id,
          event_sequence: sequence,
          topic: 'run_authorization.grant_revoked',
          idempotency_key: `run-authorization:grant:${grantId}:revoked`,
          payload: { grant_id: grantId, session_id: record.session_id, event_sequence: sequence },
          created_at: now,
        });
      }
    });
    return { grant_id: grantId, status: 'revoked', already_final: false };
  }

  // ------------------------------------------- standing authorization records

  /**
   * Host provisioning for a PRE-EXISTING standing authorization (not
   * one of the six canonical operations): standing authorizations are
   * created by host administration, never by a run flow. Purpose-bound
   * to council_run family purposes only; a standing record can never
   * authorize task creation or external execution.
   */
  provisionStandingAuthorization(
    principal: CouncilPrincipal,
    input: StandingAuthorizationInput,
  ): RunGrantRecord {
    const envelope = this.envelope(principal);
    const now = this.now();
    if (Date.parse(input.expires_at) <= Date.parse(now)) {
      throw invalidInput('A standing authorization must expire in the future.');
    }
    const grantId = this.newId();
    const proof: RunGrantProof = {
      proof_version: 'run-grant-proof/v1',
      stage: 'granted',
      standing: true,
      installation_id: envelope.installation_id,
      owner_subject: principal.subject,
      route_policy_sha256: input.route_policy_sha256,
      route_snapshot: null,
      route_snapshot_fingerprint: null,
      brief_sha256: null,
      brief_revision: null,
      mode: null,
      pack_version: input.pack_version,
      protocol_version: CONTRACT_PACKAGE_VERSION,
      allowed_operation_kinds: this.allowedKinds(input.purpose, input.allowed_operation_kinds),
      ceilings: input.ceilings,
      account_ref: input.account_ref ?? null,
      preview_id: null,
      preview_sha256: null,
      revocation_epoch: 0,
      renews_grant_id: null,
    };
    this.write(() => {
      this.db
        .prepare(
          `INSERT INTO council_approvals
             (tenant_id, company_id, id, kind, session_id, action_proposal_id,
              authority_mode, purpose, actor_subject, actor_role,
              parent_approval_id, scope_proof, current_plan_hash, verdict_hash,
              max_cost_minor, currency, seat_allowlist_json,
              company_scope_verified, status, issued_at, expires_at,
              revoked_at, revoked_by, consumed_at)
           VALUES (?, ?, ?, 'run_grant', NULL, NULL, 'managed_principal', ?, ?,
                   'standing_authorization', NULL, ?, NULL, NULL, ?, ?, ?, 1, 'active',
                   ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          envelope.tenant_id,
          envelope.company_id,
          grantId,
          input.purpose,
          principal.subject,
          canonicalStringify(proof),
          input.ceilings.max_money?.amount_minor ?? null,
          input.ceilings.max_money?.currency ?? null,
          canonicalStringify([...input.seat_ids]),
          now,
          input.expires_at,
        );
    });
    const record = this.loadGrantRecord(principal, grantId);
    if (!record) {
      throw new CouncilRunAuthorizationError('RUN_GRANT_NOT_FOUND', `Standing authorization ${grantId} was recorded but does not read back.`, { grant_id: grantId });
    }
    return record;
  }

  // ------------------------------------------------------------ admitOperation

  /**
   * Admit one operation under a grant: all grant fences first, then
   * the reservation, in one transaction with CWE-028's counting
   * semantics (session-wide ceilings from the canonical settings
   * tightened by the grant's ceilings, the grant money ceiling, the
   * lease-epoch fence). Every refusal is journaled under the session.
   */
  admitOperation(principal: CouncilPrincipal, input: AdmitOperationInput): Admission {
    try {
      return this.admitChecked(principal, input);
    } catch (error) {
      const code =
        error instanceof CouncilRunAuthorizationError
          ? error.code
          : 'RUN_ADMISSION_REFUSED';
      try {
        this.journalAdmissionRefused(principal, input, code);
      } catch {
        // Journaling a refusal must never mask the refusal itself.
      }
      throw error;
    }
  }

  private admitChecked(principal: CouncilPrincipal, input: AdmitOperationInput): Admission {
    const envelope = this.envelope(principal);
    const record = this.loadGrantRecord(principal, input.grant_id);
    if (!record || record.proof.stage !== 'granted' || record.proof.standing) {
      throw new CouncilRunAuthorizationError('RUN_GRANT_NOT_FOUND', `No granted run grant ${input.grant_id} exists in this scope.`, { grant_id: input.grant_id });
    }
    if (record.session_id !== input.session_id) {
      throw new CouncilRunAuthorizationError('RUN_GRANT_SCOPE_MISMATCH', `Run grant ${record.grant_id} is bound to session ${record.session_id}, not ${input.session_id}.`, { grant_id: record.grant_id });
    }
    if (record.status === 'revoked' || record.status === 'exhausted') {
      throw new CouncilRunAuthorizationError('RUN_GRANT_INACTIVE', `Run grant ${record.grant_id} is ${record.status}. It admits nothing, including replays.`, { grant_id: record.grant_id, status: record.status });
    }
    if (record.status === 'expired' || this.expireGrantIfLapsed(principal, record)) {
      throw new CouncilRunAuthorizationError('RUN_GRANT_INACTIVE', `Run grant ${record.grant_id} expired at ${record.expires_at}.`, { grant_id: record.grant_id, status: 'expired' });
    }
    if (record.parent_grant_id) {
      const parent = this.loadGrantRecord(principal, record.parent_grant_id);
      if (!parent || !this.standingParentStands(parent)) {
        throw new CouncilRunAuthorizationError('RUN_GRANT_PARENT_INVALID', `The standing parent of grant ${record.grant_id} no longer stands.`, { grant_id: record.grant_id });
      }
    }
    const session = this.sessionFor(principal, input.session_id);
    if (session.state.revocation_generation > record.proof.revocation_epoch) {
      throw new CouncilRunAuthorizationError('RUN_GRANT_INACTIVE', `Session ${input.session_id} advanced its revocation generation past grant ${record.grant_id}'s epoch.`, { grant_id: record.grant_id });
    }
    if (input.purpose !== undefined && input.purpose !== record.purpose) {
      throw new CouncilRunAuthorizationError('RUN_GRANT_PURPOSE_MISMATCH', `Operation purpose ${input.purpose} does not match grant ${record.grant_id}'s purpose ${record.purpose}.`, { grant_id: record.grant_id });
    }
    if (!record.proof.allowed_operation_kinds.includes(input.kind)) {
      throw new CouncilRunAuthorizationError('RUN_GRANT_KIND_NOT_ALLOWED', `Operation kind ${input.kind} is outside grant ${record.grant_id}'s allowed kinds.`, { grant_id: record.grant_id, kind: input.kind });
    }
    const fingerprint = canonicalHash(input.route_snapshot as unknown as Record<string, unknown>);
    if (record.proof.route_snapshot_fingerprint !== null && fingerprint !== record.proof.route_snapshot_fingerprint) {
      throw new CouncilRunAuthorizationError('RUN_GRANT_ROUTE_MISMATCH', `The operation's pinned route snapshot does not match grant ${record.grant_id}'s approved route pin.`, { grant_id: record.grant_id });
    }
    if (!Number.isSafeInteger(input.estimate_minor) || input.estimate_minor < 0) {
      throw invalidInput('estimate_minor must be a safe integer >= 0.');
    }

    const now = this.now();
    return this.write(() => {
      const currentEpoch = this.currentLeaseEpoch(envelope, input.session_id);
      if (input.lease_epoch !== currentEpoch) {
        throw new CouncilRunAuthorizationError('BUDGET_LEASE_FENCED', `Operation ${input.operation_id} presented lease epoch ${input.lease_epoch}, but the session lease is at epoch ${currentEpoch}.`, { session_id: input.session_id, operation_id: input.operation_id });
      }
      const existing = this.reservationRow(envelope, input.session_id, input.operation_id);
      if (existing && existing.grant_id !== input.grant_id) {
        throw new CouncilRunAuthorizationError('RUN_OPERATION_GRANT_MISMATCH', `Operation ${input.operation_id} is already reserved under grant ${existing.grant_id}.`, { operation_id: input.operation_id });
      }
      if (existing && ACTIVE_RESERVATION_STATES.has(existing.state)) {
        return this.toAdmission(input, record, existing, fingerprint, true);
      }
      const ceilings = effectiveCeilings(record.proof.ceilings);
      const rows = this.sessionReservations(envelope, input.session_id);
      const facts = this.journalKindFacts(envelope, input.session_id);
      const active = rows.filter((r) => ACTIVE_RESERVATION_STATES.has(r.state));
      if (active.length + 1 > ceilings.max_provider_requests) {
        throw new CouncilRunAuthorizationError('BUDGET_EXHAUSTED', `Session ${input.session_id} has reached its max_session_provider_requests ceiling of ${ceilings.max_provider_requests}.`, { ceiling: 'max_session_provider_requests', limit: ceilings.max_provider_requests, current: active.length });
      }
      const kindActive = active.filter((r) => facts.get(r.operation_id)?.kind === input.kind);
      const kindCeiling =
        input.kind === 'output_repair'
          ? ceilings.max_output_repairs
          : input.kind === 'transport_retry'
            ? ceilings.max_transport_retries
            : input.kind === 'semantic_verification'
              ? ceilings.max_semantic_verifications
              : ceilings.max_provider_requests;
      if (kindActive.length + 1 > kindCeiling) {
        throw new CouncilRunAuthorizationError('BUDGET_EXHAUSTED', `Session ${input.session_id} has reached its ${input.kind} ceiling of ${kindCeiling}.`, { ceiling: input.kind, limit: kindCeiling, current: kindActive.length });
      }
      if (input.original_operation_id) {
        const perOriginal =
          input.kind === 'transport_retry'
            ? DEFAULT_COUNCIL_SETTINGS.max_transport_retries_per_request
            : input.kind === 'output_repair'
              ? DEFAULT_COUNCIL_SETTINGS.max_output_repairs_per_original_operation
              : null;
        if (perOriginal !== null) {
          const siblings = active.filter((r) => {
            const fact = facts.get(r.operation_id);
            return (
              fact !== undefined &&
              fact.kind === input.kind &&
              fact.original_operation_id === input.original_operation_id
            );
          });
          if (siblings.length + 1 > perOriginal) {
            throw new CouncilRunAuthorizationError('BUDGET_EXHAUSTED', `Session ${input.session_id} has reached its per-original ${input.kind} ceiling of ${perOriginal} for operation ${input.original_operation_id}.`, { ceiling: input.kind, limit: perOriginal, current: siblings.length });
          }
        }
      }
      const currency = input.currency ?? record.currency;
      if (!currency) throw invalidInput('A reservation needs a currency: neither the input nor the grant record names one.');
      if (record.currency !== null && currency !== record.currency) {
        throw new CouncilRunAuthorizationError('RUN_GRANT_SCOPE_MISMATCH', `Reservation currency ${currency} does not match grant currency ${record.currency}.`, { grant_id: record.grant_id });
      }
      if (record.max_cost_minor !== null) {
        let outstanding = 0;
        for (const row of active) {
          outstanding += row.state === 'committed' ? (row.actual_minor ?? row.estimate_minor) : row.estimate_minor;
        }
        if (outstanding + input.estimate_minor > record.max_cost_minor) {
          throw new CouncilRunAuthorizationError('BUDGET_EXHAUSTED', `Session ${input.session_id} would exceed the grant money ceiling of ${record.max_cost_minor}.`, { ceiling: 'grant_max_cost_minor', limit: record.max_cost_minor, current: outstanding });
        }
      }
      const holdExpiresAt = new Date(Date.parse(now) + 900_000).toISOString();
      const reservationId = existing ? existing.id : this.newId();
      if (existing) {
        this.db
          .prepare(
            `UPDATE council_budget_reservations
                SET grant_id = ?, estimate_minor = ?, actual_minor = NULL, currency = ?,
                    state = 'reserved', hold_expires_at = ?, created_at = ?, finalized_at = NULL
              WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND id = ?`,
          )
          .run(input.grant_id, input.estimate_minor, currency, holdExpiresAt, now, envelope.tenant_id, envelope.company_id, input.session_id, existing.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO council_budget_reservations
               (tenant_id, company_id, session_id, id, operation_id, grant_id,
                estimate_minor, actual_minor, currency, state, hold_expires_at, created_at, finalized_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'reserved', ?, ?, NULL)`,
          )
          .run(envelope.tenant_id, envelope.company_id, input.session_id, reservationId, input.operation_id, input.grant_id, input.estimate_minor, currency, holdExpiresAt, now);
      }
      const sequence = this.appendJournal(envelope, input.session_id, {
        type: 'operation_reserved',
        actor_subject: envelope.actor_subject,
        payload: {
          reservation_id: reservationId,
          operation_id: input.operation_id,
          grant_id: input.grant_id,
          kind: input.kind,
          original_operation_id: input.original_operation_id ?? null,
          estimate_minor: input.estimate_minor,
          currency,
          lease_epoch: input.lease_epoch,
          hold_expires_at: holdExpiresAt,
          route_snapshot: input.route_snapshot,
          route_snapshot_fingerprint: fingerprint,
          route_resolution: null,
          reissued_from_state: existing ? existing.state : null,
        },
        created_at: now,
      });
      this.enqueueOutbox(envelope, {
        session_id: input.session_id,
        event_sequence: sequence,
        topic: 'budget.reserved',
        idempotency_key: `budget:${reservationId}:reserved:${sequence}`,
        payload: { session_id: input.session_id, reservation_id: reservationId, operation_id: input.operation_id, event_sequence: sequence },
        created_at: now,
      });
      const stored = this.reservationRow(envelope, input.session_id, input.operation_id);
      return this.toAdmission(input, record, stored as ReservationRow, fingerprint, false);
    });
  }

  // --------------------------------------------------------- recordConsumption

  recordConsumption(
    principal: CouncilPrincipal,
    input: {
      grant_id: string;
      session_id: string;
      operation_id: string;
      lease_epoch: number;
      outcome: 'settled' | 'unknown';
      actual_minor?: number;
    },
  ): {
    operation_id: string;
    state: string;
    actual_minor: number | null;
    grant_status: string;
    totals: { consumed: number; reserved: number; unknown: number; outstanding_minor: number; committed_actual_minor: number };
  } {
    const envelope = this.envelope(principal);
    const existing = this.reservationRow(envelope, input.session_id, input.operation_id);
    if (!existing) {
      throw new CouncilRunAuthorizationError('BUDGET_RESERVATION_NOT_FOUND', `No budget reservation for operation ${input.operation_id} exists in session ${input.session_id} in this scope.`, { operation_id: input.operation_id });
    }
    if (existing.grant_id !== input.grant_id) {
      throw new CouncilRunAuthorizationError('RUN_OPERATION_GRANT_MISMATCH', `Operation ${input.operation_id} was admitted under grant ${existing.grant_id}, not ${input.grant_id}.`, { operation_id: input.operation_id });
    }
    if (input.outcome === 'settled' && input.actual_minor === undefined) {
      throw invalidInput('A settled consumption requires actual_minor.');
    }
    const now = this.now();
    const finalized = this.write(() => {
      const currentEpoch = this.currentLeaseEpoch(envelope, input.session_id);
      if (input.lease_epoch !== currentEpoch) {
        throw new CouncilRunAuthorizationError('BUDGET_LEASE_FENCED', `Operation ${input.operation_id} presented lease epoch ${input.lease_epoch}, but the session lease is at epoch ${currentEpoch}.`, { operation_id: input.operation_id });
      }
      const row = this.reservationRow(envelope, input.session_id, input.operation_id) as ReservationRow;
      if (input.outcome === 'settled') {
        if (row.state !== 'reserved' && row.state !== 'unknown') {
          throw new CouncilRunAuthorizationError('BUDGET_RESERVATION_FINALIZED', `Reservation for operation ${row.operation_id} is already ${row.state}; it cannot be settled.`, { operation_id: row.operation_id });
        }
        const result = this.db
          .prepare(
            `UPDATE council_budget_reservations SET state = 'committed', actual_minor = ?, finalized_at = ?
              WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND id = ? AND state = ?`,
          )
          .run(input.actual_minor as number, now, envelope.tenant_id, envelope.company_id, input.session_id, row.id, row.state);
        if (Number(result.changes) !== 1) {
          throw new CouncilRunAuthorizationError('BUDGET_RESERVATION_FINALIZED', `Reservation for operation ${row.operation_id} is already ${row.state}.`, { operation_id: row.operation_id });
        }
        const sequence = this.appendJournal(envelope, input.session_id, {
          type: 'operation_completed',
          actor_subject: envelope.actor_subject,
          payload: {
            reservation_id: row.id,
            operation_id: row.operation_id,
            outcome: 'settled',
            from_state: row.state,
            lease_epoch: input.lease_epoch,
            actual_minor: input.actual_minor,
            currency: row.currency,
          },
          created_at: now,
        });
        this.enqueueOutbox(envelope, {
          session_id: input.session_id,
          event_sequence: sequence,
          topic: 'budget.finalized',
          idempotency_key: `budget:${row.id}:settled:${sequence}`,
          payload: { session_id: input.session_id, reservation_id: row.id, operation_id: row.operation_id, outcome: 'settled', event_sequence: sequence },
          created_at: now,
        });
      } else {
        if (row.state === 'unknown') {
          return row;
        }
        if (row.state !== 'reserved') {
          throw new CouncilRunAuthorizationError('BUDGET_RESERVATION_FINALIZED', `Reservation for operation ${row.operation_id} is already ${row.state}; it cannot be marked unknown.`, { operation_id: row.operation_id });
        }
        const result = this.db
          .prepare(
            `UPDATE council_budget_reservations SET state = 'unknown'
              WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND id = ? AND state = 'reserved'`,
          )
          .run(envelope.tenant_id, envelope.company_id, input.session_id, row.id);
        if (Number(result.changes) !== 1) {
          throw new CouncilRunAuthorizationError('BUDGET_RESERVATION_FINALIZED', `Reservation for operation ${row.operation_id} is already ${row.state}.`, { operation_id: row.operation_id });
        }
        const sequence = this.appendJournal(envelope, input.session_id, {
          type: 'operation_completed',
          actor_subject: envelope.actor_subject,
          payload: {
            reservation_id: row.id,
            operation_id: row.operation_id,
            outcome: 'completion_unknown',
            from_state: 'reserved',
            estimate_minor: row.estimate_minor,
            currency: row.currency,
            lease_epoch: input.lease_epoch,
          },
          created_at: now,
        });
        this.enqueueOutbox(envelope, {
          session_id: input.session_id,
          event_sequence: sequence,
          topic: 'budget.finalized',
          idempotency_key: `budget:${row.id}:completion_unknown:${sequence}`,
          payload: { session_id: input.session_id, reservation_id: row.id, operation_id: row.operation_id, outcome: 'completion_unknown', event_sequence: sequence },
          created_at: now,
        });
      }
      return this.reservationRow(envelope, input.session_id, input.operation_id) as ReservationRow;
    });
    this.write(() => {
      this.db
        .prepare(
          `UPDATE council_approvals SET consumed_at = ?
            WHERE tenant_id = ? AND company_id = ? AND id = ? AND consumed_at IS NULL`,
        )
        .run(now, envelope.tenant_id, envelope.company_id, input.grant_id);
    });
    const record = this.loadGrantRecord(principal, input.grant_id);
    const rows = this.sessionReservations(envelope, input.session_id);
    let consumed = 0;
    let reserved = 0;
    let unknown = 0;
    let outstanding = 0;
    let committedActual = 0;
    for (const row of rows) {
      if (row.state === 'committed' || row.state === 'unknown') consumed += 1;
      if (row.state === 'reserved') reserved += 1;
      if (row.state === 'unknown') unknown += 1;
      if (ACTIVE_RESERVATION_STATES.has(row.state)) {
        outstanding += row.state === 'committed' ? (row.actual_minor ?? row.estimate_minor) : row.estimate_minor;
      }
      if (row.state === 'committed') committedActual += row.actual_minor ?? row.estimate_minor;
    }
    return {
      operation_id: input.operation_id,
      state: finalized.state,
      actual_minor: finalized.actual_minor,
      grant_status: record ? record.status : 'missing',
      totals: { consumed, reserved, unknown, outstanding_minor: outstanding, committed_actual_minor: committedActual },
    };
  }

  // ------------------------------------------------------------- private data

  private reservationRow(
    envelope: CouncilEnvelope,
    sessionId: string,
    operationId: string,
  ): ReservationRow | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, operation_id, grant_id, estimate_minor, actual_minor,
                currency, state, hold_expires_at, created_at, finalized_at
           FROM council_budget_reservations
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND operation_id = ?`,
      )
      .get(envelope.tenant_id, envelope.company_id, sessionId, operationId) as
      | ReservationRow
      | undefined;
    return row ?? null;
  }

  private sessionReservations(
    envelope: CouncilEnvelope,
    sessionId: string,
  ): ReservationRow[] {
    return this.db
      .prepare(
        `SELECT id, session_id, operation_id, grant_id, estimate_minor, actual_minor,
                currency, state, hold_expires_at, created_at, finalized_at
           FROM council_budget_reservations
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(envelope.tenant_id, envelope.company_id, sessionId) as ReservationRow[];
  }

  private journalKindFacts(
    envelope: CouncilEnvelope,
    sessionId: string,
  ): Map<string, { kind: string; original_operation_id: string | null }> {
    const facts = new Map<string, { kind: string; original_operation_id: string | null }>();
    for (const event of this.repositories.listEvents(envelope, sessionId, 0)) {
      if (event.type !== 'operation_reserved') continue;
      if (typeof event.payload.operation_id === 'string') {
        facts.set(event.payload.operation_id, {
          kind: String(event.payload.kind ?? 'provider_request'),
          original_operation_id:
            typeof event.payload.original_operation_id === 'string'
              ? event.payload.original_operation_id
              : null,
        });
      }
    }
    return facts;
  }

  private currentLeaseEpoch(envelope: CouncilEnvelope, sessionId: string): number {
    const events = this.repositories.listEvents(envelope, sessionId, 0);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (!STATE_EVENT_TYPES.includes(event.type)) continue;
      const record = event.payload.state_record as { lease_epoch?: unknown } | undefined;
      if (record && typeof record.lease_epoch === 'number') return record.lease_epoch;
      throw new CouncilRunAuthorizationError('RUN_INVALID_INPUT', `Session ${sessionId} has no journaled state record to fence against.`, { session_id: sessionId });
    }
    throw new CouncilRunAuthorizationError('RUN_INVALID_INPUT', `Session ${sessionId} has no journaled state record to fence against.`, { session_id: sessionId });
  }

  private journalAdmissionRefused(
    principal: CouncilPrincipal,
    input: AdmitOperationInput,
    code: string,
  ): void {
    const envelope = this.envelope(principal);
    const session = this.repositories.getSession(envelope, input.session_id);
    if (!session) return;
    const now = this.now();
    this.write(() => {
      const sequence = this.appendJournal(envelope, input.session_id, {
        type: 'operation_completed',
        actor_subject: envelope.actor_subject,
        payload: {
          grant_kind: 'run_grant',
          lifecycle: 'admission_refused',
          outcome: 'admission_refused',
          grant_id: input.grant_id,
          operation_id: input.operation_id,
          reason_code: code,
        },
        created_at: now,
      });
      this.enqueueOutbox(envelope, {
        session_id: input.session_id,
        event_sequence: sequence,
        topic: 'run_authorization.admission_refused',
        idempotency_key: `run-authorization:refused:${input.operation_id}:${sequence}`,
        payload: { session_id: input.session_id, operation_id: input.operation_id, event_sequence: sequence },
        created_at: now,
      });
    });
  }

  private toAdmission(
    input: AdmitOperationInput,
    record: RunGrantRecord,
    row: ReservationRow,
    fingerprint: string,
    replayed: boolean,
  ): Admission {
    return {
      operation_id: input.operation_id,
      reservation_id: row.id,
      grant_id: input.grant_id,
      session_id: input.session_id,
      kind: input.kind,
      state: row.state,
      estimate_minor: row.estimate_minor,
      currency: row.currency,
      route_snapshot_fingerprint: fingerprint,
      revocation_epoch: record.proof.revocation_epoch,
      replayed,
    };
  }

  private toRunGrant(principal: CouncilPrincipal, record: RunGrantRecord): RunGrant {
    const envelope = this.envelope(principal);
    const consumed = { provider_requests: 0, output_repairs: 0, transport_retries: 0 };
    const reserved = { provider_requests: 0, output_repairs: 0, transport_retries: 0 };
    if (record.session_id !== null) {
      const facts = this.journalKindFacts(envelope, record.session_id);
      const rows = this.sessionReservations(envelope, record.session_id).filter(
        (r) => r.grant_id === record.grant_id,
      );
      const bump = (bucket: typeof consumed, kind: string | undefined): void => {
        bucket.provider_requests += 1;
        if (kind === 'output_repair') bucket.output_repairs += 1;
        if (kind === 'transport_retry') bucket.transport_retries += 1;
      };
      for (const row of rows) {
        const kind = facts.get(row.operation_id)?.kind;
        if (row.state === 'committed' || row.state === 'unknown') bump(consumed, kind);
        else if (row.state === 'reserved') bump(reserved, kind);
      }
    }
    const grant: RunGrant = {
      schema_version: 'wise-elders.run-grant/v1',
      grant_id: record.grant_id,
      authority_mode: record.authority_mode,
      issuer_principal: record.issuer_principal,
      scope: {
        tenant_id: envelope.tenant_id,
        company_id: envelope.company_id,
        installation_id: record.proof.installation_id,
        owner_subject: record.proof.owner_subject,
      },
      purpose: record.purpose,
      session_id: record.session_id as string,
      brief_revision: record.proof.brief_revision as number,
      brief_sha256: record.proof.brief_sha256 as string,
      mode: record.proof.mode as RunGrant['mode'],
      seat_ids: [...record.seat_ids] as RunGrant['seat_ids'],
      route_policy_sha256: record.proof.route_policy_sha256,
      account_ref: record.proof.account_ref,
      pack_version: record.proof.pack_version as string,
      protocol_version: record.proof.protocol_version,
      allowed_operation_kinds: [...record.proof.allowed_operation_kinds],
      ceilings: record.proof.ceilings,
      created_at: record.issued_at,
      expires_at: record.expires_at,
      revocation_epoch: record.proof.revocation_epoch,
      status: record.status,
      standing_parent_grant_id: record.parent_grant_id,
      preview_sha256: record.proof.preview_sha256 as string,
      consumed,
      reserved,
    };
    const check = validateRunGrant(grant);
    if (!check.ok) {
      throw new CouncilRunAuthorizationError('RUN_INVALID_INPUT', `Stored grant ${record.grant_id} does not satisfy the canonical RunGrant contract: ${check.issues.map((i) => i.message).join('; ')}`, { grant_id: record.grant_id });
    }
    return grant;
  }
}

// ------------------------------------------------------------------ helpers

function parseProof(row: ApprovalRow): RunGrantProof {
  try {
    return JSON.parse(row.scope_proof) as RunGrantProof;
  } catch {
    throw new CouncilRunAuthorizationError('RUN_INVALID_INPUT', `Grant ${row.id} carries an unparseable scope proof.`, { grant_id: row.id });
  }
}

function verifyPreviewRow(row: {
  id: string;
  preview_json: string;
  preview_hash: string;
}): RunPreview {
  let parsed: RunPreview;
  try {
    parsed = JSON.parse(row.preview_json) as RunPreview;
  } catch {
    throw new CouncilRunAuthorizationError('RUN_PREVIEW_TAMPERED', `Preview ${row.id} does not parse.`, { preview_id: row.id });
  }
  const { preview_sha256: _recorded, ...content } = parsed;
  if (
    canonicalHash(content as unknown as Record<string, unknown>) !== row.preview_hash ||
    parsed.preview_sha256 !== row.preview_hash
  ) {
    throw new CouncilRunAuthorizationError('RUN_PREVIEW_TAMPERED', `Preview ${row.id} content does not match its recorded hash.`, { preview_id: row.id });
  }
  const check = validateRunPreview(parsed);
  if (!check.ok) {
    throw new CouncilRunAuthorizationError('RUN_PREVIEW_TAMPERED', `Preview ${row.id} no longer satisfies the canonical RunPreview contract.`, { preview_id: row.id });
  }
  return parsed;
}

function assertStandingCoverage(
  envelope: CouncilEnvelope,
  parent: RunGrantRecord,
  preview: RunPreview,
  anchorProof: RunGrantProof,
  session: CouncilStoredSession,
  parentStands: boolean,
): void {
  const fail = (reason: string): never => {
    throw new CouncilRunAuthorizationError(
      'RUN_GRANT_PARENT_INVALID',
      `Standing grant ${parent.grant_id} does not cover this preview: ${reason}.`,
      { standing_parent_grant_id: parent.grant_id, reason },
    );
  };
  if (!parentStands) {
    fail('the standing grant is not active and unexpired');
  }
  if (parent.proof.installation_id !== envelope.installation_id) fail('different installation');
  if (parent.proof.owner_subject !== session.scope.owner_subject) fail('different owner');
  if (parent.purpose !== preview.purpose) fail('different purpose');
  if (parent.proof.route_policy_sha256 !== preview.route_policy_sha256) fail('different route policy');
  if (parent.proof.pack_version !== preview.pack_version) fail('different pack version');
  const parentSeats = new Set(parent.seat_ids);
  for (const seat of preview.seat_ids) {
    if (!parentSeats.has(seat)) fail(`seat ${seat} is outside the standing allowlist`);
  }
  const p = parent.proof.ceilings;
  const r = preview.ceilings;
  if (p.max_provider_requests < r.max_provider_requests) fail('request ceiling below the preview');
  if (p.max_output_repairs < r.max_output_repairs) fail('repair ceiling below the preview');
  if (p.max_transport_retries < r.max_transport_retries) fail('retry ceiling below the preview');
  if (r.max_input_tokens !== null && (p.max_input_tokens === null || p.max_input_tokens < r.max_input_tokens)) fail('input token ceiling below the preview');
  if (r.max_output_tokens !== null && (p.max_output_tokens === null || p.max_output_tokens < r.max_output_tokens)) fail('output token ceiling below the preview');
  if (r.max_money !== null) {
    const parentMoney = p.max_money;
    if (parentMoney === null) fail('the standing grant carries no money bound');
    else if (parentMoney.currency !== r.max_money.currency) fail('different currency');
    else if (parentMoney.amount_minor < r.max_money.amount_minor) fail('money ceiling below the preview');
  }
  for (const kind of anchorProof.allowed_operation_kinds) {
    if (!parent.proof.allowed_operation_kinds.includes(kind)) {
      fail(`operation kind ${kind} is outside the standing grant`);
    }
  }
}

function effectiveCeilings(grantCeilings: RunCeilings): {
  max_provider_requests: number;
  max_output_repairs: number;
  max_transport_retries: number;
  max_semantic_verifications: number;
} {
  const s = DEFAULT_COUNCIL_SETTINGS;
  return {
    max_provider_requests: Math.min(s.max_session_provider_requests, grantCeilings.max_provider_requests),
    max_output_repairs: Math.min(s.max_output_repair_requests, grantCeilings.max_output_repairs),
    max_transport_retries: Math.min(s.max_transport_retries_total, grantCeilings.max_transport_retries),
    max_semantic_verifications: s.max_semantic_verification_requests,
  };
}

function tightenCeilings(
  base: RunCeilings,
  chosen: Partial<RunCeilings> | null,
  previewId: string,
): RunCeilings {
  if (!chosen) return base;
  const broaden = (field: string): never => {
    throw new CouncilRunAuthorizationError(
      'RUN_GRANT_WOULD_BROADEN',
      `Chosen ceilings would broaden ${field} beyond the approved preview.`,
      { preview_id: previewId, field },
    );
  };
  const num = (field: string, baseValue: number, chosenValue: number | undefined): number => {
    if (chosenValue === undefined) return baseValue;
    if (chosenValue > baseValue) broaden(field);
    return chosenValue;
  };
  const nullableNum = (field: string, baseValue: number | null, chosenValue: number | null | undefined): number | null => {
    if (chosenValue === undefined) return baseValue;
    if (chosenValue === null) {
      if (baseValue !== null) broaden(field);
      return null;
    }
    if (baseValue !== null && chosenValue > baseValue) broaden(field);
    return chosenValue;
  };
  let money = base.max_money;
  if (chosen.max_money !== undefined) {
    if (chosen.max_money === null) {
      if (base.max_money !== null) broaden('max_money');
      money = null;
    } else if (base.max_money === null) {
      money = chosen.max_money;
    } else {
      if (chosen.max_money.currency !== base.max_money.currency) broaden('max_money.currency');
      if (chosen.max_money.amount_minor > base.max_money.amount_minor) broaden('max_money');
      money = chosen.max_money;
    }
  }
  return {
    max_provider_requests: num('max_provider_requests', base.max_provider_requests, chosen.max_provider_requests),
    max_output_repairs: num('max_output_repairs', base.max_output_repairs, chosen.max_output_repairs),
    max_transport_retries: num('max_transport_retries', base.max_transport_retries, chosen.max_transport_retries),
    max_input_tokens: nullableNum('max_input_tokens', base.max_input_tokens, chosen.max_input_tokens),
    max_output_tokens: nullableNum('max_output_tokens', base.max_output_tokens, chosen.max_output_tokens),
    max_money: money,
  };
}

function minCeilings(a: RunCeilings, b: RunCeilings): RunCeilings {
  const nullable = (x: number | null, y: number | null): number | null => {
    if (x === null) return y;
    if (y === null) return x;
    return Math.min(x, y);
  };
  let money = a.max_money;
  if (b.max_money !== null) {
    money =
      a.max_money === null
        ? b.max_money
        : { amount_minor: Math.min(a.max_money.amount_minor, b.max_money.amount_minor), currency: a.max_money.currency };
  }
  return {
    max_provider_requests: Math.min(a.max_provider_requests, b.max_provider_requests),
    max_output_repairs: Math.min(a.max_output_repairs, b.max_output_repairs),
    max_transport_retries: Math.min(a.max_transport_retries, b.max_transport_retries),
    max_input_tokens: nullable(a.max_input_tokens, b.max_input_tokens),
    max_output_tokens: nullable(a.max_output_tokens, b.max_output_tokens),
    max_money: money,
  };
}
