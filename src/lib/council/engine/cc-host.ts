/**
 * Command Center adapter for the canonical CouncilHost ports (CTR-191).
 *
 * This file composes the installed canonical engine (`council-engine.ts`,
 * ported verbatim from the 77-council-of-wise-elders runtime) over the
 * Command Center's OWN durable surfaces, with no second store and no second
 * credential path:
 *
 *   canonical engine
 *     -> CouncilRepositories  (cards, verdicts, hash-chained events, state CAS)
 *     -> CouncilJobService    (lease-fenced checkpoint persistence)
 *     -> run-authorization    (grant resolution, per-operation admission,
 *                              settlement, release, unknown-completion)
 *     -> installed provider connector (exact grant route; fallback none)
 *
 * Laws kept:
 * - The managed CC store is authoritative. Nothing here creates a database,
 *   migration, session, or spend on a read.
 * - Every provider request is admitted under the exact granted route and the
 *   current session lease epoch before it leaves the box.
 * - Events the store already journals atomically (card_accepted,
 *   verdict_validated, session_state_changed) are not duplicated; round
 *   events (crux_identified, resolution_drafted, operation_completed) are
 *   appended through the same hash chain so the UI sees every round.
 * - Untrusted provider text is returned RAW to the engine; the canonical
 *   validator and its single bounded repair decide acceptance.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  DEFAULT_COUNCIL_SETTINGS,
  canonicalHash,
  sha256Hex,
  type CouncilCard,
  type CouncilEvent,
  type CouncilEventType,
  type CouncilSettings,
  type EvidenceManifestEntry,
  type IdSource,
  type JobCheckpoint,
  type RunGrant,
  type SeatId,
  type SessionStateRecord,
  type Verdict,
} from '../contracts';
import {
  type CouncilEnvelope,
  type CouncilJournalEvent,
  type CouncilRepositories,
} from '../store';
import type { CouncilJobService } from '../jobs';
import type { CouncilPrincipal } from '../auth';
import { CouncilRunAuthorizationService } from '../run-authorization';
import type { CouncilRouteSelection } from '../explicit-selection';
import type { CouncilStore as CouncilPersistenceStore } from '../persistence/council-store';
import {
  resolveConfiguredConnector,
  type ResolvedConnector,
} from '../provider-route';
import { CouncilError } from './errors';
import type {
  AuthorizationProvider,
  BudgetLedger,
  BudgetReservation,
  BudgetSnapshot,
  CapacityLeaseProvider,
  CouncilEventSink,
  CouncilHost,
  CouncilStore as EngineStore,
  EvidenceProvider,
  ModelTransport,
  OperationLease,
  SecretResolver,
  StoredSession,
  TransportRegistry,
  TransportRequest,
  TransportResponse,
} from './types';

const EVENT_DEDUPE: ReadonlySet<CouncilEventType> = new Set([
  'session_created',
  'session_state_changed',
  'card_accepted',
  'verdict_validated',
]);

const OPERATION_LEASE_TTL_MS = 60_000;

export interface CcHostInput {
  repositories: CouncilRepositories;
  store: CouncilPersistenceStore;
  jobs: CouncilJobService;
  runAuthorization: CouncilRunAuthorizationService;
  principal: CouncilPrincipal;
  envelope: CouncilEnvelope;
  session: StoredSession;
  grant_id: string;
  /** Currency bound to the grant record (the worker refuses an unbound run). */
  currency: string;
  route: CouncilRouteSelection;
  job_id: string;
  worker_id: string;
  worker_subject: string;
  lease_epoch: number;
  job_lease_epoch: number;
  signal: AbortSignal;
  settings?: CouncilSettings;
  now?: () => string;
  newId?: () => string;
  timeoutMs?: number;
}

interface CcBudgetReservation extends BudgetReservation {
  reservation_id: string;
}

function engineError(code: 'COUNCIL_LEASE_LOST' | 'COUNCIL_ROUTE_UNAVAILABLE' | 'COUNCIL_TRANSPORT_FAILED', message: string): CouncilError {
  return new CouncilError(code, message, { retryable: false, exitCode: 3 });
}

/** The CC repository store behind the canonical persistence port. */
class CcEngineStore implements EngineStore {
  constructor(
    private readonly repos: CouncilRepositories,
    private readonly envelope: CouncilEnvelope,
    private readonly ownerSubject: string | null,
    private readonly checkpoints: (checkpoint: JobCheckpoint) => Promise<void>,
  ) {}

  async createSession(session: StoredSession): Promise<void> {
    this.repos.createSession(this.envelope, session);
  }

  async getSession(sessionId: string): Promise<StoredSession | null> {
    return this.repos.getSession(this.envelope, sessionId);
  }

  async updateState(record: SessionStateRecord, expectedVersion: number): Promise<void> {
    this.repos.writeStateRecord(this.envelope, record, expectedVersion);
  }

  async saveCard(card: CouncilCard): Promise<void> {
    const fresh = this.repos.getSession(this.envelope, card.session_id);
    if (!fresh) throw engineError('COUNCIL_LEASE_LOST', `Session ${card.session_id} disappeared before card commit.`);
    this.repos.acceptCard(this.envelope, card, {
      expected_state_version: fresh.state.state_version,
      cancel_generation: fresh.state.cancel_generation,
      lease_epoch: fresh.state.lease_epoch,
    });
  }

  async findCard(
    sessionId: string,
    round: number,
    seatId: SeatId,
    inputSha256: string,
  ): Promise<CouncilCard | null> {
    const cards = await this.listCards(sessionId);
    return (
      cards.find(
        (card) =>
          card.seat_id === seatId &&
          (card.card_kind === 'consult' ? 0 : card.round) === round &&
          card.input_manifest_sha256 === inputSha256,
      ) ?? null
    );
  }

  async listCards(sessionId: string): Promise<CouncilCard[]> {
    return this.repos.listCards(this.envelope, sessionId);
  }

  async appendEvent(event: Omit<CouncilEvent, 'sequence'>): Promise<CouncilEvent> {
    if (EVENT_DEDUPE.has(event.event_type)) {
      // The atomic store commit already journaled this event.
      return { ...event, sequence: 0 };
    }
    const journal: CouncilJournalEvent = this.repos.appendEventRecord(
      this.envelope,
      event.session_id,
      {
        type: event.event_type,
        from_state: null,
        to_state: null,
        actor_subject: event.actor === 'owner' ? (this.ownerSubject ?? event.actor) : this.envelope.actor_subject,
        payload: event.payload,
        created_at: event.created_at,
      },
    );
    return { ...event, sequence: journal.sequence };
  }

  async listEvents(sessionId: string, afterSequence = 0): Promise<CouncilEvent[]> {
    return this.repos
      .listEvents(this.envelope, sessionId, afterSequence)
      .map((row) => ({
        schema_version: 'wise-elders.event/v1' as const,
        event_id: row.event_id,
        session_id: sessionId,
        sequence: row.sequence,
        event_type: row.type as CouncilEventType,
        tenant_id: this.envelope.tenant_id,
        company_id: this.envelope.company_id,
        owner_subject: this.ownerSubject,
        actor: 'system' as const,
        payload: row.payload,
        created_at: row.created_at,
      }));
  }

  async saveVerdict(verdict: Verdict): Promise<void> {
    this.repos.saveVerdict(this.envelope, verdict);
  }

  async getVerdict(sessionId: string): Promise<Verdict | null> {
    return this.repos.getVerdict(this.envelope, sessionId);
  }

  async saveCheckpoint(checkpoint: JobCheckpoint): Promise<void> {
    await this.checkpoints(checkpoint);
  }

  async getCheckpoint(): Promise<JobCheckpoint | null> {
    // Completed logical operations are recovered from the durable cards;
    // the engine never needs a second checkpoint read path.
    return null;
  }
}

class CcBudgetLedger implements BudgetLedger {
  constructor(
    private readonly auth: CouncilRunAuthorizationService,
    private readonly principal: CouncilPrincipal,
    private readonly grantId: string,
    private readonly currency: string,
    private readonly route: CouncilRouteSelection,
    private readonly leaseEpoch: number,
    private readonly db: Database.Database,
    private readonly scope: { tenant_id: string; company_id: string },
  ) {}

  reserve(input: {
    session_id: string;
    operation_key: string;
    kind: BudgetReservation['kind'];
  }): BudgetReservation {
    const admission = this.auth.admitOperation(this.principal, {
      grant_id: this.grantId,
      session_id: input.session_id,
      operation_id: input.operation_key,
      kind: input.kind,
      purpose: 'council_run',
      estimate_minor: 0,
      currency: this.currency,
      lease_epoch: this.leaseEpoch,
      route_snapshot: this.route,
    });
    return {
      operation_key: input.operation_key,
      session_id: input.session_id,
      kind: input.kind,
      reservation_id: admission.reservation_id,
    } as CcBudgetReservation;
  }

  commit(reservation: BudgetReservation): void {
    this.auth.recordConsumption(this.principal, {
      grant_id: this.grantId,
      session_id: reservation.session_id,
      operation_id: reservation.operation_key,
      lease_epoch: this.leaseEpoch,
      outcome: 'settled',
      actual_minor: 0,
    });
  }

  release(reservation: BudgetReservation): void {
    this.auth.releaseOperation(this.principal, {
      grant_id: this.grantId,
      session_id: reservation.session_id,
      operation_id: reservation.operation_key,
      lease_epoch: this.leaseEpoch,
    });
  }

  markProviderCompletionUnknown(reservation: BudgetReservation): void {
    this.auth.recordConsumption(this.principal, {
      grant_id: this.grantId,
      session_id: reservation.session_id,
      operation_id: reservation.operation_key,
      lease_epoch: this.leaseEpoch,
      outcome: 'unknown',
    });
  }

  snapshot(sessionId: string): BudgetSnapshot {
    const rows = this.db
      .prepare(
        `SELECT state, estimate_minor FROM council_budget_reservations
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?`,
      )
      .all(this.scope.tenant_id, this.scope.company_id, sessionId) as Array<{
      state: string;
      estimate_minor: number;
    }>;
    return {
      session_id: sessionId,
      ceilings: {
        max_provider_requests: DEFAULT_COUNCIL_SETTINGS.max_session_provider_requests,
        max_output_repairs: DEFAULT_COUNCIL_SETTINGS.max_output_repair_requests,
        max_transport_retries: DEFAULT_COUNCIL_SETTINGS.max_transport_retries_total,
        max_semantic_verifications: DEFAULT_COUNCIL_SETTINGS.max_semantic_verification_requests,
      },
      consumed: {
        provider_requests: rows.filter((r) => r.state === 'committed' || r.state === 'unknown').length,
        output_repairs: 0,
        transport_retries: 0,
        semantic_verifications: 0,
      },
      reserved: rows.filter((r) => r.state === 'reserved').length,
      unknown: rows.filter((r) => r.state === 'unknown').length,
    };
  }
}

class CcCapacityLeases implements CapacityLeaseProvider {
  private readonly leases = new Map<string, OperationLease>();
  constructor(
    private readonly ownerId: string,
    private readonly signal: AbortSignal,
    private readonly now: () => number,
  ) {}

  claim(operationKey: string, ownerId: string, ttlMs = OPERATION_LEASE_TTL_MS): OperationLease {
    const previous = this.leases.get(operationKey);
    const lease: OperationLease = {
      operation_key: operationKey,
      owner_id: ownerId || this.ownerId,
      epoch: (previous?.epoch ?? 0) + 1,
      expires_at_ms: this.now() + ttlMs,
    };
    this.leases.set(operationKey, lease);
    return lease;
  }

  heartbeat(lease: OperationLease): OperationLease {
    this.assertCurrent(lease);
    const renewed = { ...lease, expires_at_ms: this.now() + OPERATION_LEASE_TTL_MS };
    this.leases.set(lease.operation_key, renewed);
    return renewed;
  }

  assertCurrent(lease: OperationLease): void {
    const current = this.leases.get(lease.operation_key);
    if (this.signal.aborted || !current || current.epoch !== lease.epoch || current.expires_at_ms <= this.now()) {
      throw engineError('COUNCIL_LEASE_LOST', `Operation lease ${lease.operation_key} is no longer current.`);
    }
  }

  release(lease: OperationLease): void {
    const current = this.leases.get(lease.operation_key);
    if (current && current.epoch === lease.epoch) this.leases.delete(lease.operation_key);
  }
}

class SingleRouteRegistry implements TransportRegistry {
  private readonly transports = new Map<string, ModelTransport>();
  constructor(routeId: string, transport: ModelTransport) {
    this.transports.set(routeId, transport);
  }
  register(routeId: string, transport: ModelTransport): void {
    this.transports.set(routeId, transport);
  }
  resolve(routeId: string): ModelTransport | null {
    return this.transports.get(routeId) ?? null;
  }
  listRoutes(): string[] {
    return [...this.transports.keys()];
  }
}

class PinnedProviderTransport implements ModelTransport {
  private connector: ResolvedConnector | null = null;
  constructor(
    private readonly input: {
      route: CouncilRouteSelection;
      sessionId: string;
      jobId: string;
      grantId: string;
      currency: string;
      signal: AbortSignal;
      db: Database.Database;
      scope: { tenant_id: string; company_id: string };
      newId: () => string;
      now: () => string;
      timeoutMs: number;
    },
  ) {}

  private connectorOnce(): ResolvedConnector {
    if (!this.connector) this.connector = resolveConfiguredConnector(this.input.route);
    return this.connector;
  }

  private recordAttempt(
    attemptId: string,
    request: TransportRequest,
    input: {
      status: 'dispatched' | 'accepted' | 'failed' | 'provider_completion_unknown' | 'cancelled';
      outcomeCode: string | null;
      requestHash: string;
      responseHash: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      retrySafe: boolean;
    },
  ): void {
    const now = this.input.now();
    const round = request.round ?? 0;
    const existing = this.input.db
      .prepare(
        `SELECT id FROM council_provider_attempts
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND operation_id = ?`,
      )
      .get(this.input.scope.tenant_id, this.input.scope.company_id, this.input.sessionId, attemptId) as
      | { id: string }
      | undefined;
    if (!existing) {
      this.input.db
        .prepare(
          `INSERT INTO council_provider_attempts
             (tenant_id, company_id, session_id, id, job_id, operation_id, seat_id, round,
              provider_id, provider_config_version, model_ref, model_selection_source, status,
              outcome_code, retry_safe, input_tokens, output_tokens, actual_cost_minor, currency,
              request_hash, response_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'run-grant', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.input.scope.tenant_id,
          this.input.scope.company_id,
          this.input.sessionId,
          this.input.newId(),
          this.input.jobId,
          attemptId,
          request.seat_id,
          round,
          this.input.route.providerSlug,
          this.input.route.requestedModelOrAlias ?? this.input.route.routeId,
          this.input.route.selectionSource,
          input.status,
          input.outcomeCode,
          input.retrySafe ? 1 : 0,
          input.inputTokens,
          input.outputTokens,
          this.input.currency,
          input.requestHash,
          input.responseHash,
          now,
          now,
        );
      return;
    }
    this.input.db
      .prepare(
        `UPDATE council_provider_attempts
            SET status = ?, outcome_code = ?, retry_safe = ?, input_tokens = ?,
                output_tokens = ?, response_hash = ?, updated_at = ?
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND operation_id = ?`,
      )
      .run(
        input.status,
        input.outcomeCode,
        input.retrySafe ? 1 : 0,
        input.inputTokens,
        input.outputTokens,
        input.responseHash,
        now,
        this.input.scope.tenant_id,
        this.input.scope.company_id,
        this.input.sessionId,
        attemptId,
      );
  }

  async generate(request: TransportRequest): Promise<TransportResponse> {
    if (request.route_id !== this.input.route.routeId) {
      throw engineError(
        'COUNCIL_ROUTE_UNAVAILABLE',
        `The session's route ${request.route_id} is not the grant's pinned route ${this.input.route.routeId}. No substitution is made.`,
      );
    }
    const connector = this.connectorOnce();
    const attemptId = `engine:${this.input.sessionId}:${request.purpose}:${request.round ?? 0}:${request.seat_id}:${this.input.newId()}`;
    const requestHash = canonicalHash({
      purpose: request.purpose,
      session_id: request.session_id,
      seat_id: request.seat_id,
      round: request.round,
      route_id: request.route_id,
      system: request.system,
      input: request.input,
    });
    this.recordAttempt(attemptId, request, {
      status: 'dispatched',
      outcomeCode: null,
      requestHash,
      responseHash: null,
      inputTokens: null,
      outputTokens: null,
      retrySafe: false,
    });

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(this.input.signal.reason);
    this.input.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('provider_timeout');
    }, this.input.timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    let response;
    try {
      response = await connector.provider.chatCompletion!(
        connector.apiKey,
        {
          model: connector.model,
          messages: [
            { role: 'system' as const, content: request.system },
            { role: 'user' as const, content: JSON.stringify(request.input) },
          ],
          max_tokens: 1600,
        },
        controller.signal,
      );
    } catch (error) {
      const status = (error as { status?: number; httpStatus?: number; statusCode?: number });
      const http =
        typeof status?.status === 'number'
          ? status.status
          : typeof status?.httpStatus === 'number'
            ? status.httpStatus
            : typeof status?.statusCode === 'number'
              ? status.statusCode
              : null;
      const retryable = http !== null ? http === 429 || http >= 500 : true;
      const unknownCompletion = timedOut || this.input.signal.aborted;
      this.recordAttempt(attemptId, request, {
        status: unknownCompletion
          ? 'provider_completion_unknown'
          : this.input.signal.aborted
            ? 'cancelled'
            : 'failed',
        outcomeCode: unknownCompletion
          ? 'COUNCIL_TRANSPORT_UNKNOWN'
          : http !== null
            ? `TRANSPORT_HTTP_${http}`
            : 'COUNCIL_TRANSPORT_FAILED',
        requestHash,
        responseHash: null,
        inputTokens: null,
        outputTokens: null,
        retrySafe: retryable,
      });
      const failure = engineError(
        'COUNCIL_TRANSPORT_FAILED',
        `Provider request for seat ${request.seat_id} (${request.purpose}) failed before a complete response.`,
      );
      throw Object.assign(failure, {
        retryable: retryable && !unknownCompletion,
        unknownCompletion,
      });
    } finally {
      clearTimeout(timer);
      this.input.signal.removeEventListener('abort', onAbort);
    }

    const text = response?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim().length === 0) {
      this.recordAttempt(attemptId, request, {
        status: 'failed',
        outcomeCode: 'TRANSPORT_EMPTY_RESPONSE',
        requestHash,
        responseHash: null,
        inputTokens: response?.usage?.prompt_tokens ?? null,
        outputTokens: response?.usage?.completion_tokens ?? null,
        retrySafe: false,
      });
      throw engineError('COUNCIL_TRANSPORT_FAILED', `Provider returned no text for seat ${request.seat_id}.`);
    }
    this.recordAttempt(attemptId, request, {
      status: 'accepted',
      outcomeCode: null,
      requestHash,
      responseHash: sha256Hex(Buffer.from(text, 'utf8')),
      inputTokens: response.usage?.prompt_tokens ?? null,
      outputTokens: response.usage?.completion_tokens ?? null,
      retrySafe: false,
    });
    return {
      text,
      provider_request_id: attemptId,
      reported_model_id: typeof response.model === 'string' ? response.model : null,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? null,
        output_tokens: response.usage?.completion_tokens ?? null,
      },
    };
  }
}

class CcEvidence implements EvidenceProvider {
  constructor(
    private readonly repos: CouncilRepositories,
    private readonly envelope: CouncilEnvelope,
  ) {}
  async loadEvidenceManifest(sessionId: string): Promise<EvidenceManifestEntry[]> {
    const session = this.repos.getSession(this.envelope, sessionId);
    return session ? session.brief.evidence_manifest : [];
  }
  async loadSeatPack(): Promise<{ pack_version: string; briefing_text: string } | null> {
    // Installed seat packs are a separate runtime surface; the canonical
    // engine handles their absence explicitly instead of inventing a pack.
    return null;
  }
}

class CcSecrets implements SecretResolver {
  constructor(private readonly route: CouncilRouteSelection) {}
  async credentialPresent(routeId: string): Promise<boolean> {
    if (routeId !== this.route.routeId) return false;
    try {
      resolveConfiguredConnector(this.route);
      return true;
    } catch {
      return false;
    }
  }
}

class CcAuthorization implements AuthorizationProvider {
  constructor(
    private readonly auth: CouncilRunAuthorizationService,
    private readonly principal: CouncilPrincipal,
  ) {}
  async resolveRunGrant(grantRef: string, sessionId: string): Promise<RunGrant | null> {
    return this.auth.resolveRunGrant(this.principal, grantRef, sessionId);
  }
}

class CcEvents implements CouncilEventSink {
  constructor(private readonly store: CcEngineStore) {}
  publish(event: Omit<CouncilEvent, 'sequence'>): Promise<CouncilEvent> {
    return this.store.appendEvent(event);
  }
}

const systemClock = { nowUtc: () => new Date().toISOString() };
const systemIds: IdSource = { newId: () => randomUUID() };

export interface ComposedCcHost {
  host: CouncilHost;
  settings: CouncilSettings;
}

/**
 * Build the canonical CouncilHost over the CC durable surfaces for ONE
 * admitted durable job. The returned host is bound to that job's exact
 * grant, route, lease epoch, and cancellation signal.
 */
export function createCcCouncilHost(input: CcHostInput): ComposedCcHost {
  const now = input.now ?? systemClock.nowUtc;
  const newId = input.newId ?? systemIds.newId;
  const db = input.store.handle();
  const checkpoints = async (checkpoint: JobCheckpoint): Promise<void> => {
    const updated = input.jobs.updateCheckpoint(
      { tenant_id: input.envelope.tenant_id, company_id: input.envelope.company_id },
      {
        job_id: input.job_id,
        worker_id: input.worker_id,
        lease_epoch: input.job_lease_epoch,
        checkpoint: { engine: checkpoint, updated_at: now() },
      },
    );
    if (!updated) {
      throw engineError(
        'COUNCIL_LEASE_LOST',
        `The durable job ${input.job_id} no longer belongs to this generation; the checkpoint was not written.`,
      );
    }
  };
  const engineStore = new CcEngineStore(
    input.repositories,
    input.envelope,
    input.session.scope.owner_subject,
    checkpoints,
  );
  const transport = new PinnedProviderTransport({
    route: input.route,
    sessionId: input.session.spec.session_id,
    jobId: input.job_id,
    grantId: input.grant_id,
    currency: input.currency,
    signal: input.signal,
    db,
    scope: {
      tenant_id: input.envelope.tenant_id,
      company_id: input.envelope.company_id,
    },
    newId,
    now,
    timeoutMs: input.timeoutMs ?? 180_000,
  });
  const host: CouncilHost = {
    store: engineStore,
    transportRegistry: new SingleRouteRegistry(input.session.spec.model_policy.route_id, transport),
    evidence: new CcEvidence(input.repositories, input.envelope),
    secrets: new CcSecrets(input.route),
    budget: new CcBudgetLedger(
      input.runAuthorization,
      input.principal,
      input.grant_id,
      input.currency,
      input.route,
      input.lease_epoch,
      db,
      { tenant_id: input.envelope.tenant_id, company_id: input.envelope.company_id },
    ),
    capacity: new CcCapacityLeases(input.worker_id, input.signal, () => Date.now()),
    events: new CcEvents(engineStore),
    clock: { nowUtc: now },
    ids: { newId },
    authorize: new CcAuthorization(input.runAuthorization, input.principal),
  };
  return { host, settings: input.settings ?? DEFAULT_COUNCIL_SETTINGS };
}

