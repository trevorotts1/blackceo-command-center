/**
 * CTR-191 focused composition check for the FULL canonical Council engine.
 *
 * RUN (deliberately NOT run by the repair session):
 *
 *   node --import tsx scripts/council/check-full-engine-composition.ts
 *
 * No database, no network, no provider call, no credential read. A scripted
 * in-memory host returns canonical cards so the REAL ported engine executes
 * both advisor rounds, crux review, draft resolution, ratification, scoring,
 * verdict validation, and session COMPLETED. The check asserts the opening
 * barrier (nine unique seat jobs), both round barriers, and the session/
 * verdict binding.
 */
import assert from 'node:assert/strict';
import {
  canonicalHash,
  type CouncilCard,
  type CouncilEvent,
  type DecisionBrief,
  type JobCheckpoint,
  type RunGrant,
  type SessionStateRecord,
  type Verdict,
} from '../../src/lib/council/contracts';
import { CouncilEngine } from '../../src/lib/council/engine/council-engine';
import type {
  BudgetLedger,
  BudgetReservation,
  CapacityLeaseProvider,
  CouncilEventSink,
  CouncilHost,
  CouncilStore,
  EvidenceProvider,
  ModelTransport,
  OperationLease,
  SecretResolver,
  StoredSession,
  TransportRequest,
  TransportRegistry,
  TransportResponse,
} from '../../src/lib/council/engine/types';

const SESSION = 'session-full-engine-check';
const ROUTE = 'route-test';
const PACK = 'pack-test';
const SEATS = [
  'simon-sinek',
  'td-jakes',
  'oprah-winfrey',
  'tiffany-aliche',
  'russell-brunson',
  'michelle-obama',
  'brene-brown',
  'dennis-kimbro',
  'les-brown',
] as const;
const OPTIONS = [
  { id: 'option-a', label: 'Option A', kind: 'change' as const },
  { id: 'option-b', label: 'Option B', kind: 'status_quo' as const },
];
const NOW = '2026-11-02T00:00:00.000Z';

function brief(): DecisionBrief {
  return {
    schema_version: 'wise-elders.brief/v1',
    brief_id: 'brief-check',
    session_id: SESSION,
    revision: 1,
    question: 'Should the client proceed with Option A?',
    facts: [],
    assumptions: [],
    unknowns: [],
    constraints: [],
    options: OPTIONS,
    relevance_weights: Object.fromEntries(SEATS.map((seat) => [seat, 1])) as DecisionBrief['relevance_weights'],
    critical_domains: [],
    evidence_manifest: [],
    private_preference_ref: null,
    created_at: NOW,
    display_timezone: 'America/New_York',
  };
}

function spec(frozen: DecisionBrief) {
  return {
    schema_version: 'wise-elders.session/v1' as const,
    session_id: SESSION,
    mode: 'full' as const,
    visibility: 'company' as const,
    brief_revision: 1,
    brief_sha256: canonicalHash(frozen),
    options: OPTIONS,
    seat_ids: [...SEATS],
    model_policy: {
      selection: 'explicit' as const,
      route_id: ROUTE,
      requested_model_id: 'provider-test/model-test',
      reasoning_preference: null,
      fallback_policy: 'none' as const,
    },
    source_pack_version: PACK,
    execution_policy: 'advisory_only' as const,
    created_at: NOW,
    display_timezone: 'America/New_York',
  };
}

function grant(frozen: DecisionBrief): RunGrant {
  return {
    schema_version: 'wise-elders.run-grant/v1',
    grant_id: 'grant-check',
    authority_mode: 'managed_principal',
    issuer_principal: 'owner-test',
    scope: {
      tenant_id: 'tenant-check',
      company_id: 'company-check',
      installation_id: 'install-check',
      owner_subject: 'owner-test',
    },
    purpose: 'council_run',
    session_id: SESSION,
    brief_revision: 1,
    brief_sha256: canonicalHash(frozen),
    mode: 'full',
    seat_ids: [...SEATS],
    route_policy_sha256: canonicalHash({ route: ROUTE }),
    account_ref: null,
    pack_version: PACK,
    protocol_version: 'wise-elders.core/1.0.0',
    allowed_operation_kinds: [
      'provider_request',
      'output_repair',
      'transport_retry',
      'semantic_verification',
    ],
    ceilings: {
      max_provider_requests: 50,
      max_output_repairs: 9,
      max_transport_retries: 8,
      max_input_tokens: null,
      max_output_tokens: null,
      max_money: { amount_minor: 0, currency: 'USD' },
    },
    created_at: NOW,
    expires_at: '2099-01-01T00:00:00.000Z',
    revocation_epoch: 0,
    status: 'active',
    standing_parent_grant_id: null,
    preview_sha256: canonicalHash({ preview: SESSION }),
    consumed: { provider_requests: 0, output_repairs: 0, transport_retries: 0 },
    reserved: { provider_requests: 0, output_repairs: 0, transport_retries: 0 },
  };
}

interface RecordedJob {
  seat_id: string;
  purpose: TransportRequest['purpose'];
  round: number | null;
}

function cardFor(request: TransportRequest): string {
  const input = request.input as {
    input_manifest_sha256: string;
    pack_version: string;
    brief: DecisionBrief;
  };
  const round = request.round ?? (request.purpose === 'consult' ? 0 : 3);
  const base = {
    schema_version: 'wise-elders.card/v1' as const,
    session_id: SESSION,
    brief_revision: 1,
    seat_id: request.seat_id,
    input_manifest_sha256: input.input_manifest_sha256,
    pack_version: input.pack_version,
  };
  if (request.purpose === 'advisor') {
    return JSON.stringify({
      ...base,
      card_kind: 'advisor',
      round,
      stance: 'support',
      preferred_option_id: 'option-a',
      option_scores: [
        { option_id: 'option-a', score: 8, rationale: 'Best fit.', evidence_ids: [] },
        { option_id: 'option-b', score: 5, rationale: 'Status quo is slower.', evidence_ids: [] },
      ],
      framework_applications: [],
      decisive_arguments: ['Option A matches the recorded goal.'],
      strongest_objection: 'Execution capacity is unproven.',
      conditions: [],
      critical_unknowns: [],
      change_my_mind: 'Evidence that capacity cannot be staffed.',
      challenges_answered: [],
      quotes: [],
      evidence_strength: 'medium',
      minority_position: null,
    });
  }
  const resolution = (request.input as { draft_resolution?: { semantic_sha256?: string } })
    .draft_resolution?.semantic_sha256;
  assert.ok(resolution, 'ratification request carries the exact draft resolution hash');
  return JSON.stringify({
    ...base,
    card_kind: 'ratification',
    round: 3,
    draft_resolution_sha256: resolution,
    resolution_stance: 'support',
    stance: 'support',
    preferred_option_id: 'option-a',
    option_scores: [
      { option_id: 'option-a', score: 8, rationale: 'Supports the resolution.', evidence_ids: [] },
      { option_id: 'option-b', score: 5, rationale: 'Does not prefer it.', evidence_ids: [] },
    ],
    amendments: [],
    accepted_condition_ids: [],
    unresolved_objections: [],
    evidence_strength: 'medium',
  });
}

class MemoryStore implements CouncilStore {
  session: StoredSession;
  cards: CouncilCard[] = [];
  events: CouncilEvent[] = [];
  verdict: Verdict | null = null;
  constructor(session: StoredSession) {
    this.session = session;
  }
  async createSession(session: StoredSession): Promise<void> {
    this.session = session;
  }
  async getSession(sessionId: string): Promise<StoredSession | null> {
    return this.session.spec.session_id === sessionId ? this.session : null;
  }
  async updateState(record: SessionStateRecord, expectedVersion: number): Promise<void> {
    assert.equal(this.session.state.state_version, expectedVersion);
    this.session = { ...this.session, state: { ...record } };
  }
  async saveCard(card: CouncilCard): Promise<void> {
    assert.ok(!this.cards.some((c) => c.host.operation_id === card.host.operation_id));
    this.cards.push(card);
  }
  async findCard(sessionId: string, round: number, seatId: string, inputSha: string) {
    return (
      this.cards.find(
        (card) =>
          card.session_id === sessionId &&
          card.seat_id === seatId &&
          (card.card_kind === 'consult' ? 0 : card.round) === round &&
          card.input_manifest_sha256 === inputSha,
      ) ?? null
    );
  }
  async listCards(): Promise<CouncilCard[]> {
    return [...this.cards];
  }
  async appendEvent(event: Omit<CouncilEvent, 'sequence'>): Promise<CouncilEvent> {
    const stored = { ...event, sequence: this.events.length + 1 };
    this.events.push(stored);
    return stored;
  }
  async listEvents(): Promise<CouncilEvent[]> {
    return [...this.events];
  }
  async saveVerdict(verdict: Verdict): Promise<void> {
    this.verdict = verdict;
  }
  async getVerdict(): Promise<Verdict | null> {
    return this.verdict;
  }
  async saveCheckpoint(_checkpoint: JobCheckpoint): Promise<void> {}
  async getCheckpoint(): Promise<JobCheckpoint | null> {
    return null;
  }
}

class MemoryBudget implements BudgetLedger {
  reserved = 0;
  committed = 0;
  reserve(input: { session_id: string; operation_key: string; kind: BudgetReservation['kind'] }): BudgetReservation {
    this.reserved += 1;
    return input;
  }
  commit(): void {
    this.committed += 1;
  }
  release(): void {}
  markProviderCompletionUnknown(): void {}
  snapshot(sessionId: string) {
    return {
      session_id: sessionId,
      ceilings: {
        max_provider_requests: 50,
        max_output_repairs: 9,
        max_transport_retries: 8,
        max_semantic_verifications: 2,
      },
      consumed: {
        provider_requests: this.committed,
        output_repairs: 0,
        transport_retries: 0,
        semantic_verifications: 0,
      },
      reserved: 0,
      unknown: 0,
    };
  }
}

class MemoryCapacity implements CapacityLeaseProvider {
  private leases = new Map<string, OperationLease>();
  claim(operation_key: string, owner_id: string): OperationLease {
    const previous = this.leases.get(operation_key);
    const lease = {
      operation_key,
      owner_id,
      epoch: (previous?.epoch ?? 0) + 1,
      expires_at_ms: Date.now() + 60_000,
    };
    this.leases.set(operation_key, lease);
    return lease;
  }
  heartbeat(lease: OperationLease): OperationLease {
    return lease;
  }
  assertCurrent(lease: OperationLease): void {
    assert.ok(this.leases.has(lease.operation_key));
  }
  release(lease: OperationLease): void {
    this.leases.delete(lease.operation_key);
  }
}

async function main(): Promise<void> {
  const frozen = brief();
  const sessionSpec = spec(frozen);
  const session: StoredSession = {
    spec: sessionSpec,
    brief: frozen,
    scope: {
      tenant_id: 'tenant-check',
      company_id: 'company-check',
      installation_id: 'install-check',
      owner_subject: 'owner-test',
    },
    state: {
      schema_version: 'wise-elders.session-state/v1',
      session_id: SESSION,
      mode: 'full',
      state: 'PREPARING',
      state_version: 0,
      brief_revision: 1,
      resume_phase: null,
      cancel_generation: 0,
      revocation_generation: 0,
      attempt: 1,
      lease_epoch: 1,
      archived: false,
      updated_at: NOW,
    },
    sample: false,
  };
  const store = new MemoryStore(session);
  const jobs: RecordedJob[] = [];
  const transport: ModelTransport = {
    async generate(request: TransportRequest): Promise<TransportResponse> {
      jobs.push({
        seat_id: request.seat_id,
        purpose: request.purpose,
        round: request.round,
      });
      return {
        text: cardFor(request),
        provider_request_id: `attempt-${jobs.length}`,
        reported_model_id: 'model-test',
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  };
  const registry: TransportRegistry = {
    register() {},
    resolve: (routeId: string) => (routeId === ROUTE ? transport : null),
    listRoutes: () => [ROUTE],
  };
  const host: CouncilHost = {
    store,
    transportRegistry: registry,
    evidence: {
      async loadEvidenceManifest() {
        return [];
      },
      async loadSeatPack() {
        return null;
      },
    } satisfies EvidenceProvider,
    secrets: {
      async credentialPresent(routeId: string) {
        return routeId === ROUTE;
      },
    } satisfies SecretResolver,
    budget: new MemoryBudget(),
    capacity: new MemoryCapacity(),
    events: {
      async publish(event) {
        return store.appendEvent(event);
      },
    } satisfies CouncilEventSink,
    clock: { nowUtc: () => NOW },
    ids: { newId: () => `id-${Math.random().toString(36).slice(2)}` },
    authorize: {
      async resolveRunGrant(ref: string, sessionId: string) {
        return ref === 'grant-check' && sessionId === SESSION ? grant(frozen) : null;
      },
    },
  };

  const engine = new CouncilEngine(host, { ownerId: 'check-worker' });
  const finished = await engine.continueAdmittedSession(SESSION, 'grant-check');

  // Opening barrier: exactly nine unique seat jobs before any later round.
  const opening = jobs.filter((job) => job.purpose === 'advisor' && job.round === 1);
  assert.equal(opening.length, SEATS.length, 'nine opening advisor jobs');
  assert.equal(new Set(opening.map((job) => job.seat_id)).size, SEATS.length, 'unique seats');
  const firstLater = jobs.findIndex((job) => !(job.purpose === 'advisor' && job.round === 1));
  assert.ok(firstLater >= SEATS.length, 'no later-round job before the opening barrier');

  // Round-2 barrier: all nine challenge jobs, each after every opening.
  const challenge = jobs.filter((job) => job.purpose === 'advisor' && job.round === 2);
  assert.equal(challenge.length, SEATS.length, 'nine challenge jobs');
  const firstChallenge = jobs.findIndex((job) => job.purpose === 'advisor' && job.round === 2);
  assert.ok(firstChallenge >= SEATS.length, 'Round 2 starts after Round 1');

  // Ratification barrier: nine ratification jobs, only after Round 2.
  const ratification = jobs.filter((job) => job.purpose === 'ratification' && job.round === 3);
  assert.equal(ratification.length, SEATS.length, 'nine ratification jobs');
  const firstRatification = jobs.findIndex((job) => job.purpose === 'ratification');
  assert.ok(firstRatification >= firstChallenge + SEATS.length, 'Round 3 starts after Round 2');

  // Session result binding: verdict saved for this exact session and cards.
  assert.equal(finished.state.state, 'COMPLETED');
  assert.ok(store.verdict, 'a validated verdict is saved');
  assert.equal(store.verdict?.session_id, SESSION);
  assert.equal(store.verdict?.brief_sha256, sessionSpec.brief_sha256);
  assert.equal(store.cards.length, SEATS.length * 3, '27 committed cards');
  assert.ok(
    store.cards.every((card) => card.host.scope.tenant_id === 'tenant-check'),
    'every card is stamped with the session scope',
  );

  console.log(
    'check-full-engine-composition: OK (9 unique opening jobs, round barriers, verdict binding)',
  );
}

void main();
