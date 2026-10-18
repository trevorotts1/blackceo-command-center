/**
 * Council composition root, Command Center (CWE-050; directive
 * Section 34 CWE-050, CWE-027's composition list).
 *
 * Every accepted CC council unit built a service; this module is
 * where they become one production service surface:
 *
 * - the CWE-006 store and repositories over the Command Center
 *   council database (the foundation opens its own handle per
 *   request for route work; the engine's handle serves the
 *   background composition: the outbox pump and the job service);
 * - CWE-030's event fan-out: the ONE shared CouncilEventSubscriptions
 *   registry for this process, plus the outbox pump that drains
 *   durable projection intents into it (CWE-030's remainder);
 * - CWE-027's CC durable job service (council_jobs);
 * - CWE-049's run-authorization service, exposed per principal
 *   behind CWE-035's port adapter, and the run controls composed
 *   over it (start admits only through a real grant);
 * - the ancillary coordination services' dependencies (decision,
 *   follow-up, rerun, outcomes, archive, delete, evidence) and
 *   CWE-038's CC report downloads, bound to this store;
 * - the scoped settings service (file-backed, no migration).
 *
 * Host-hardening posture (CWE-030's build report, executed here):
 * this composition NEVER wires a council producer into the host
 * fan-out (src/lib/events broadcast): council events stay on the
 * council's own scoped registry and journal, and the host journal
 * cleanup is never pointed at council tables. The pump is started
 * from the host scheduler as a named job with an env kill switch
 * (DISABLE_COUNCIL_OUTBOX_PUMP=1), mirroring the host's job pattern.
 *
 * Nothing in this module invents a service: every member maps to an
 * accepted unit's implementation in this tree.
 *
 * CWE-045 final integration additions:
 * - CWE-037's intent dispatcher and completion scanner are bound
 *   here, over this store and these repositories, so the surface
 *   binding (intents/intent-surface.ts, consumed by the CEO chat
 *   route) and the scheduler's completion-scan sweep share the one
 *   composition.
 * - runCompletionScansOnce is the production invocation of CWE-037's
 *   completion scan: every COMPLETED session that has no scan record
 *   at its current state version is scanned with trigger
 *   'completion', and a completed session whose last scan predates
 *   the current calendar month is scanned again with trigger
 *   'scheduled_review' (the Section 20.4 outcome-review cadence; the
 *   scanner's own dedupe keys make the review candidate monthly).
 *   The sweep acts under each session's recorded owner subject, so
 *   the CWE-007 private-owner rule is honored exactly; a private
 *   session with no recorded owner is skipped and reported, never
 *   scanned under a borrowed identity.
 * - The model probe (model-probe.ts) graduated council.models.probe
 *   to a real composed service; the registry now reports every
 *   endpoint ready.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  envelopeFromScope,
  openCouncilRepositories,
  type CouncilEnvelope,
  type CouncilRepositories,
} from './store';
import { openCouncilStore, type CouncilStore } from './persistence/council-store';
import {
  CouncilEventSubscriptions,
  drainCouncilEventOutbox,
  type CouncilOutboxDrainResult,
} from './events/fanout';
import {
  COUNCIL_JOB_LEASE_TTL_MS,
  CouncilJobService,
  CouncilRunControls,
  type CouncilJobRecord,
} from './jobs';
import { CouncilRunAuthorizationService } from './run-authorization';
import { CouncilRunAuthorizationAdapter } from './run-authorization-adapter';
import { CouncilSettingsService } from './settings';
import type { ReportDownloadsDeps } from './report-downloads';
import type { CouncilPrincipal } from './auth';
import type { SessionStateRecord } from './contracts';
import type { CouncilRouteSelection } from './explicit-selection';
import {
  CouncilCompletionScanner,
  CouncilIntentDispatcher,
  type CompletionScanTrigger,
} from './intents';
import { listKanbanJournalEntries } from './kanban/journal';

export interface CouncilEngine {
  store: CouncilStore;
  repositories: CouncilRepositories;
  /** The process-shared council event subscription registry (CWE-030). */
  subscriptions: CouncilEventSubscriptions;
  jobs: CouncilJobService;
  settings: CouncilSettingsService;
  reportDownloads: ReportDownloadsDeps;
  /** CWE-049's service, unbound (methods take the principal). */
  runAuthorizationService: CouncilRunAuthorizationService;
  /** The run-authorization port adapter bound to one principal. */
  runAuthorizationFor(principal: CouncilPrincipal): CouncilRunAuthorizationAdapter;
  /** The run controls bound to one principal. */
  runControlsFor(principal: CouncilPrincipal): CouncilRunControls;
  /** CWE-037's intent dispatch adapter, bound to this store (CWE-045). */
  intents: CouncilIntentDispatcher;
  /** CWE-037's completion scanner, bound to this store (CWE-045). */
  completionScanner: CouncilCompletionScanner;
  /**
   * WER-014: the production consumer of durable `council_run` jobs.
   * This is EXECUTION. Outbox pumping and completion scanning are
   * projection and review work and are never counted as execution.
   */
  runWorker: CouncilRunWorker;
  /** Readiness of the run worker: true only when a live worker can dispatch. */
  workerReadiness(): CouncilRunWorkerReadiness;
  /** Claim, dispatch, settle and finish every due council_run job once. */
  drainCouncilRunsOnce(options?: CouncilRunDrainOptions): Promise<CouncilRunDrainSummary>;
  /** Fence a generation and abort its supported in-flight transports. */
  cancelCouncilRun(
    envelope: CouncilEnvelope,
    sessionId: string,
    input?: { reason?: string | null },
  ): CouncilRunCancelReceipt;
  /** Drain due outbox intents in every scope that has them. */
  pumpOutboxOnce(limitPerScope?: number): CouncilOutboxPumpSummary;
  /**
   * Invoke CWE-037's completion scan where it is due (CWE-045):
   * trigger 'completion' for completed sessions with no scan at
   * their current state version, trigger 'scheduled_review' for
   * completed sessions whose last scan predates this month.
   */
  runCompletionScansOnce(): Promise<CouncilCompletionScanSummary>;
}

export interface CouncilCompletionScanSummary {
  scanned: Array<{
    session_id: string;
    trigger: CompletionScanTrigger;
    enqueued: number;
    skipped_candidates: number;
  }>;
  skipped: Array<{ session_id: string; reason: string }>;
}

export interface CouncilOutboxPumpSummary {
  scopes: number;
  claimed: number;
  published: number;
  deliveries: number;
  marked_delivered: number;
  marked_failed: number;
  skipped_unlinked: number;
  skipped_gone: number;
}

export interface CouncilEngineOverrides {
  store?: CouncilStore;
  subscriptions?: CouncilEventSubscriptions;
  settings?: CouncilSettingsService;
  /** WER-014: the route transport. Absent means no run may dispatch. */
  runTransport?: CouncilRunTransport | null;
  now?: () => string;
  newId?: () => string;
  workerId?: string;
  workerLeaseTtlMs?: number;
  workerHeartbeatMs?: number;
}

/** Compose the council engine over the given (or default) store. */
export function composeCouncilEngine(overrides: CouncilEngineOverrides = {}): CouncilEngine {
  const store = overrides.store ?? openCouncilStore();
  const repositories = openCouncilRepositories({ adapter: store });
  const subscriptions = overrides.subscriptions ?? new CouncilEventSubscriptions();
  const jobs = new CouncilJobService({ store, now: overrides.now, newId: overrides.newId });
  const settings = overrides.settings ?? new CouncilSettingsService();
  const runAuthorizationService = new CouncilRunAuthorizationService({
    store,
    now: overrides.now,
    newId: overrides.newId,
  });
  const runWorker = new CouncilRunWorker(
    { store, repositories, jobs, runAuthorization: runAuthorizationService },
    {
      workerId: overrides.workerId,
      leaseTtlMs: overrides.workerLeaseTtlMs,
      heartbeatMs: overrides.workerHeartbeatMs,
      transport: overrides.runTransport ?? null,
      now: overrides.now,
      newId: overrides.newId,
    },
  );

  const runAuthorizationFor = (principal: CouncilPrincipal) =>
    new CouncilRunAuthorizationAdapter({
      principal,
      service: runAuthorizationService,
      db: store.handle(),
    });

  const engineDb = store.handle();
  const intents = new CouncilIntentDispatcher({ repositories, db: engineDb });
  const completionScanner = new CouncilCompletionScanner({ repositories, db: engineDb });

  const engine: CouncilEngine = {
    store,
    repositories,
    subscriptions,
    jobs,
    settings,
    runWorker,
    workerReadiness: () => runWorker.readiness(),
    drainCouncilRunsOnce: (options) => runWorker.drain(options),
    cancelCouncilRun: (envelope, sessionId, input) =>
      runWorker.cancelSessionRun(envelope, sessionId, input),
    reportDownloads: { repositories, store },
    intents,
    completionScanner,
    runAuthorizationService,
    runAuthorizationFor,
    runControlsFor(principal: CouncilPrincipal) {
      return new CouncilRunControls({
        repositories,
        jobs,
        runAuthorization: runAuthorizationService,
        adapter: runAuthorizationFor(principal),
      });
    },
    pumpOutboxOnce(limitPerScope = 50): CouncilOutboxPumpSummary {
      const db = store.handle();
      const scopes = db
        .prepare(
          `SELECT DISTINCT tenant_id, company_id FROM council_projection_outbox
            WHERE state IN ('pending', 'failed')
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
        )
        .all(new Date().toISOString()) as Array<{ tenant_id: string; company_id: string }>;
      const summary: CouncilOutboxPumpSummary = {
        scopes: 0,
        claimed: 0,
        published: 0,
        deliveries: 0,
        marked_delivered: 0,
        marked_failed: 0,
        skipped_unlinked: 0,
        skipped_gone: 0,
      };
      for (const scope of scopes) {
        const representative = db
          .prepare(
            `SELECT installation_id FROM council_sessions
              WHERE tenant_id = ? AND company_id = ? LIMIT 1`,
          )
          .get(scope.tenant_id, scope.company_id) as { installation_id: string } | undefined;
        const envelope = envelopeFromScope(
          {
            tenant_id: scope.tenant_id,
            company_id: scope.company_id,
            installation_id: representative?.installation_id ?? 'council-pump',
            owner_subject: null,
          },
          'council-outbox-pump',
          'system',
          'admin',
        );
        const result: CouncilOutboxDrainResult = drainCouncilEventOutbox(
          { repositories, store, subscriptions },
          envelope,
          limitPerScope,
        );
        summary.scopes += 1;
        summary.claimed += result.claimed;
        summary.published += result.published;
        summary.deliveries += result.deliveries;
        summary.marked_delivered += result.marked_delivered;
        summary.marked_failed += result.marked_failed;
        summary.skipped_unlinked += result.skipped_unlinked;
        summary.skipped_gone += result.skipped_gone;
      }
      return summary;
    },
    async runCompletionScansOnce(): Promise<CouncilCompletionScanSummary> {
      const rows = engineDb
        .prepare(
          `SELECT id, tenant_id, company_id, installation_id, owner_subject, visibility, state_version
             FROM council_sessions
            WHERE state = 'COMPLETED' AND archived = 0
            ORDER BY tenant_id, company_id, id`,
        )
        .all() as Array<{
        id: string;
        tenant_id: string;
        company_id: string;
        installation_id: string;
        owner_subject: string | null;
        visibility: string;
        state_version: number;
      }>;
      const summary: CouncilCompletionScanSummary = { scanned: [], skipped: [] };
      const currentMonth = new Date().toISOString().slice(0, 7);
      for (const row of rows) {
        const scope = { tenant_id: row.tenant_id, company_id: row.company_id };
        const scans = listKanbanJournalEntries(engineDb, scope, row.id).filter(
          (entry) => entry.action === 'completion_scan_recorded',
        );
        const completionAtVersion = scans.some(
          (entry) =>
            entry.payload.trigger === 'completion' &&
            entry.payload.session_state_version === row.state_version,
        );
        let trigger: CompletionScanTrigger | null = null;
        if (!completionAtVersion) {
          trigger = 'completion';
        } else {
          const lastScanMonth = scans
            .map((entry) => entry.created_at.slice(0, 7))
            .sort()
            .at(-1);
          if (lastScanMonth !== undefined && lastScanMonth < currentMonth) {
            trigger = 'scheduled_review';
          }
        }
        if (!trigger) {
          summary.skipped.push({ session_id: row.id, reason: 'already_scanned' });
          continue;
        }
        if (row.owner_subject === null && row.visibility === 'private') {
          summary.skipped.push({
            session_id: row.id,
            reason: 'private_session_without_recorded_owner',
          });
          continue;
        }
        const subject = row.owner_subject ?? 'system:council-completion-scan';
        const principal: CouncilPrincipal = {
          subject,
          tenantKind: 'self',
          channel: 'browser',
          supportAccess: false,
          scope: {
            tenant_id: row.tenant_id,
            company_id: row.company_id,
            installation_id: row.installation_id,
            owner_subject: null,
          },
          tenant: {
            tenantId: row.tenant_id,
            companyId: row.company_id,
            clientId: null,
            kind: 'self',
            subject,
            host: '',
            installationId: row.installation_id,
          },
        };
        try {
          const result = await completionScanner.runCompletionScan(principal, row.id, {
            trigger,
          });
          summary.scanned.push({
            session_id: row.id,
            trigger,
            enqueued: result.enqueued.length,
            skipped_candidates: result.skipped.length,
          });
        } catch (error) {
          summary.skipped.push({
            session_id: row.id,
            reason: `scan_failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      return summary;
    },
  };
  return engine;
}

// ===========================================================================
// WER-014: production Council run worker (the consumer of `council_run`)
// ===========================================================================
//
// SCOPE LAW: this is the EXECUTION path. `pumpOutboxOnce` (projection
// outbox) and `runCompletionScansOnce` (review scanning) are NOT
// execution and are never counted as such by this worker; a session is
// only executed through a claimed `council_run` job below.
//
// CONNECTS TO EXISTING SURFACES (nothing parallel):
//   * durable queue + lease: CouncilJobService over `council_jobs`
//     (claimDueJob / heartbeatJob / finishJob / cancelJobsForSession);
//   * authority: CouncilRunAuthorizationService.admitOperation /
//     recordConsumption, fenced by the session state record's
//     `lease_epoch` (the one fencing generation);
//   * store: CouncilRepositories.writeStateRecord (CAS) over
//     `council_sessions` / `council_events`;
//   * accounting: `council_budget_reservations` +
//     `council_provider_attempts`;
//   * presence: the host `scheduler_leases` table (same instrument the
//     host job runner uses).
//
// FENCING LAW: the session's `lease_epoch` is the only generation that
// may reserve budget, dispatch a route, have a result accepted, record
// progress, or finish the job. A worker whose epoch moved on is fenced
// and its late result is discarded (the reservation is never settled by
// the stale generation).
//
// ADMISSION LAW: POST /api/council/sessions/:id/start already returns a
// durable receipt (`council_run` job + QUEUED session) without owning
// inference. This worker owns the long call; the API never does.
//
// ROUTE LAW: the dispatched route is the grant's pinned
// `proof.route_snapshot` — the explicitly selected route frozen at
// preview/approve time. No hidden default route is read here, and the
// provider catalog (providers.ts) builds descriptors from explicit
// registry rows, not from a default.

export const COUNCIL_RUN_JOB_KIND = 'council_run';
export const COUNCIL_RUN_WORKER_PRESENCE_PREFIX = 'council-run-worker';

/** The states in which a generation may no longer admit or persist. */
const COUNCIL_RUN_FENCED_STATES: ReadonlySet<string> = new Set([
  'CANCEL_REQUESTED',
  'CANCELLED',
  'PAUSED',
  'COMPLETED',
  'FAILED',
]);

export interface CouncilRunScope {
  tenant_id: string;
  company_id: string;
  installation_id: string;
}

export interface CouncilRunTransportDispatch {
  tenant_id: string;
  company_id: string;
  installation_id: string;
  session_id: string;
  job_id: string;
  operation_id: string;
  attempt: number;
  lease_epoch: number;
  /** The explicitly selected route frozen on the grant. Never a default. */
  route: CouncilRouteSelection;
  signal: AbortSignal;
}

export interface CouncilRunTransportResult {
  status: 'accepted' | 'failed' | 'unknown';
  response_sha256?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  actual_minor?: number | null;
  error_code?: string | null;
}

/**
 * The only place a real provider call may happen. Supplying none keeps
 * every council_run job queued and reports the worker unavailable; the
 * worker never fabricates a dispatch result.
 */
export interface CouncilRunTransport {
  dispatch(input: CouncilRunTransportDispatch): Promise<CouncilRunTransportResult>;
}

export interface CouncilRunWorkerOptions {
  workerId?: string;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  transport?: CouncilRunTransport | null;
  now?: () => string;
  newId?: () => string;
}

export interface CouncilRunWorkerReadiness {
  available: boolean;
  reason: 'available' | 'transport_not_configured' | 'worker_not_heartbeating';
  worker_id: string;
  live_worker_count: number;
  heartbeat_expires_at: string | null;
}

export interface CouncilSessionLeaseClaim {
  claimed: boolean;
  reason:
    | 'claimed'
    | 'session_not_found'
    | 'session_private_without_owner'
    | 'fenced_state'
    | 'version_conflict';
  lease_epoch: number;
  state_version: number;
  state: string;
  cancel_generation: number;
  owner_subject: string;
  lease_expires_at: string;
}

export interface CouncilRunJobOutcome {
  job_id: string;
  session_id: string | null;
  outcome:
    | 'succeeded'
    | 'failed'
    | 'fenced'
    | 'cancelled'
    | 'recovered'
    | 'skipped';
  operation_id: string | null;
  lease_epoch: number | null;
  reason: string | null;
}

export interface CouncilRunDrainOptions {
  maxJobsPerScope?: number;
  leaseTtlMs?: number;
}

export interface CouncilRunDrainSummary {
  available: boolean;
  reason: string | null;
  scopes: number;
  claimed: number;
  jobs: CouncilRunJobOutcome[];
}

export interface CouncilRunCancelReceipt {
  session_id: string;
  jobs_cancelled: number;
  transports_aborted: number;
  lease_epoch: number;
}

interface CouncilRunSessionRow {
  id: string;
  tenant_id: string;
  company_id: string;
  installation_id: string;
  owner_subject: string | null;
  visibility: string;
  state: string;
  state_version: number;
  cancellation_generation: number;
}

interface AcceptedAttemptRow {
  operation_id: string;
  status: string;
}

class CouncilRunFencedError extends Error {
  readonly code = 'LEASE_FENCED';
  constructor(message: string) {
    super(message);
    this.name = 'CouncilRunFencedError';
  }
}

export interface CouncilRunWorkerDeps {
  store: CouncilStore;
  repositories: CouncilRepositories;
  jobs: CouncilJobService;
  runAuthorization: CouncilRunAuthorizationService;
}

/**
 * The production consumer of `council_run`.
 *
 * One `drain()` claims due jobs under the job lease (CAS in
 * `council_jobs`), takes the session lease by bumping the journaled
 * `lease_epoch`, resolves the pinned route from the grant, admits one
 * budget reservation at that epoch, dispatches through the configured
 * transport, settles accounting, and finishes the job — each step
 * refusing to proceed on a stale generation. Two workers on the same
 * database therefore produce exactly one reservation and one accepted
 * attempt per operation; the loser is fenced, not merely slower.
 */
export class CouncilRunWorker {
  readonly workerId: string;
  private readonly repositories: CouncilRepositories;
  private readonly jobs: CouncilJobService;
  private readonly runAuthorization: CouncilRunAuthorizationService;
  private readonly db: Database.Database;
  private readonly transport: CouncilRunTransport | null;
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly inFlight = new Map<string, Set<AbortController>>();

  constructor(deps: CouncilRunWorkerDeps, options: CouncilRunWorkerOptions = {}) {
    this.repositories = deps.repositories;
    this.jobs = deps.jobs;
    this.runAuthorization = deps.runAuthorization;
    this.db = deps.store.handle();
    this.transport = options.transport ?? null;
    this.leaseTtlMs = options.leaseTtlMs ?? COUNCIL_JOB_LEASE_TTL_MS;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(10, Math.floor(this.leaseTtlMs / 4));
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
    this.workerId = options.workerId ?? `council-run-worker:${this.newId()}`;
  }

  // ------------------------------------------------------------- presence

  private presenceName(): string {
    return `${COUNCIL_RUN_WORKER_PRESENCE_PREFIX}:${this.workerId}`;
  }

  /**
   * Record a live worker heartbeat. Readiness reads this row, so a
   * worker that stopped stops advertising as available.
   */
  touchPresence(): void {
    try {
      const now = this.now();
      const expires = new Date(Date.parse(now) + this.leaseTtlMs).toISOString();
      this.db
        .prepare(
          `INSERT INTO scheduler_leases (job_name, owner, expires_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(job_name) DO UPDATE SET
             owner = excluded.owner,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
        )
        .run(this.presenceName(), this.workerId, expires, now);
    } catch {
      // Presence is an observation surface, never a dispatch gate.
    }
  }

  /** Withdraw presence (worker shutdown). */
  stop(): void {
    try {
      this.db
        .prepare('DELETE FROM scheduler_leases WHERE job_name = ? AND owner = ?')
        .run(this.presenceName(), this.workerId);
    } catch {
      // Nothing to withdraw.
    }
    for (const controllers of this.inFlight.values()) {
      for (const controller of controllers) controller.abort();
    }
    this.inFlight.clear();
  }

  /**
   * Readiness reflects a genuinely available worker: a configured
   * transport AND at least one live, unexpired worker heartbeat. A
   * configured route catalog alone is not readiness.
   */
  readiness(): CouncilRunWorkerReadiness {
    const base = {
      worker_id: this.workerId,
      live_worker_count: 0,
      heartbeat_expires_at: null as string | null,
    };
    try {
      const now = this.now();
      const rows = this.db
        .prepare(
          `SELECT job_name, expires_at FROM scheduler_leases
            WHERE job_name LIKE ? AND expires_at > ?
            ORDER BY expires_at DESC`,
        )
        .all(`${COUNCIL_RUN_WORKER_PRESENCE_PREFIX}:%`, now) as Array<{
        job_name: string;
        expires_at: string;
      }>;
      base.live_worker_count = rows.length;
      base.heartbeat_expires_at = rows[0]?.expires_at ?? null;
    } catch {
      base.live_worker_count = 0;
    }
    if (!this.transport) {
      return { available: false, reason: 'transport_not_configured', ...base };
    }
    if (base.live_worker_count === 0) {
      return { available: false, reason: 'worker_not_heartbeating', ...base };
    }
    return { available: true, reason: 'available', ...base };
  }

  // --------------------------------------------------------------- scopes

  private dueScopes(): CouncilRunScope[] {
    const now = this.now();
    return this.db
      .prepare(
        `SELECT DISTINCT s.tenant_id, s.company_id, s.installation_id
           FROM council_jobs j
           JOIN council_sessions s
             ON s.tenant_id = j.tenant_id
            AND s.company_id = j.company_id
            AND s.id = j.session_id
          WHERE j.kind = ?
            AND (
              (j.state = 'queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?))
              OR (j.state IN ('leased', 'running') AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at <= ?)
            )
          ORDER BY s.tenant_id, s.company_id`,
      )
      .all(COUNCIL_RUN_JOB_KIND, now, now) as CouncilRunScope[];
  }

  private readSession(scope: CouncilRunScope, sessionId: string): CouncilRunSessionRow | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, company_id, installation_id, owner_subject, visibility,
                state, state_version, cancellation_generation
           FROM council_sessions
          WHERE tenant_id = ? AND company_id = ? AND id = ?`,
      )
      .get(scope.tenant_id, scope.company_id, sessionId) as CouncilRunSessionRow | undefined;
    return row ?? null;
  }

  private workerSubject(row: CouncilRunSessionRow): string {
    return row.owner_subject ?? 'system:council-run-worker';
  }

  private workerEnvelope(scope: CouncilRunScope, row: CouncilRunSessionRow): CouncilEnvelope {
    return envelopeFromScope(
      {
        tenant_id: scope.tenant_id,
        company_id: scope.company_id,
        installation_id: scope.installation_id,
        owner_subject: row.owner_subject,
      },
      this.workerSubject(row),
      'worker',
      'write',
    );
  }

  private workerPrincipal(scope: CouncilRunScope, subject: string): CouncilPrincipal {
    return {
      subject,
      tenantKind: 'self',
      channel: 'machine',
      supportAccess: false,
      scope: {
        tenant_id: scope.tenant_id,
        company_id: scope.company_id,
        installation_id: scope.installation_id,
        owner_subject: null,
      },
      tenant: {
        tenantId: scope.tenant_id,
        companyId: scope.company_id,
        clientId: null,
        kind: 'self',
        subject,
        host: '',
        installationId: scope.installation_id,
      } as CouncilPrincipal['tenant'],
    };
  }

  // ---------------------------------------------------------- session lease

  /**
   * Take the session lease: one CAS write that bumps the journaled
   * `lease_epoch` (the fencing generation) and moves QUEUED -> PREPARING.
   * A concurrent claimant loses the CAS; no second generation is minted.
   */
  claimSessionLease(
    envelope: CouncilEnvelope,
    sessionId: string,
    input: { leaseTtlMs?: number } = {},
  ): CouncilSessionLeaseClaim {
    const session = this.repositories.getSession(envelope, sessionId);
    if (!session) {
      return {
        claimed: false,
        reason: 'session_not_found',
        lease_epoch: 0,
        state_version: 0,
        state: '',
        cancel_generation: 0,
        owner_subject: envelope.actor_subject,
        lease_expires_at: '',
      };
    }
    const current = session.state;
    const base = {
      lease_epoch: current.lease_epoch,
      state_version: current.state_version,
      state: current.state,
      cancel_generation: current.cancel_generation,
      owner_subject: envelope.actor_subject,
      lease_expires_at: '',
    };
    if (COUNCIL_RUN_FENCED_STATES.has(current.state)) {
      return { ...base, claimed: false, reason: 'fenced_state' };
    }
    const ttl = input.leaseTtlMs ?? this.leaseTtlMs;
    const now = this.now();
    const expires = new Date(Date.parse(now) + ttl).toISOString();
    const next: SessionStateRecord = {
      ...current,
      state: current.state === 'QUEUED' ? 'PREPARING' : current.state,
      state_version: current.state_version + 1,
      lease_epoch: current.lease_epoch + 1,
      updated_at: now,
    };
    try {
      this.db.transaction(() => {
        this.repositories.writeStateRecord(envelope, next, current.state_version);
        this.db
          .prepare(
            `UPDATE council_sessions SET lease_owner = ?, lease_expires_at = ?
              WHERE tenant_id = ? AND company_id = ? AND id = ?`,
          )
          .run(
            this.workerId,
            expires,
            envelope.tenant_id,
            envelope.company_id,
            sessionId,
          );
      })();
    } catch {
      // Another worker won the CAS, or the row moved under us.
      return {
        ...base,
        claimed: false,
        reason: 'version_conflict',
      };
    }
    return {
      claimed: true,
      reason: 'claimed',
      lease_epoch: next.lease_epoch,
      state_version: next.state_version,
      state: next.state,
      cancel_generation: next.cancel_generation,
      owner_subject: envelope.actor_subject,
      lease_expires_at: expires,
    };
  }

  private renewSessionLease(scope: CouncilRunScope, sessionId: string): boolean {
    const now = this.now();
    const expires = new Date(Date.parse(now) + this.leaseTtlMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE council_sessions SET lease_expires_at = ?, updated_at = ?
          WHERE tenant_id = ? AND company_id = ? AND id = ? AND lease_owner = ?`,
      )
      .run(expires, now, scope.tenant_id, scope.company_id, sessionId, this.workerId);
    return Number(result.changes) === 1;
  }

  private releaseSessionLease(scope: CouncilRunScope, sessionId: string): void {
    try {
      this.db
        .prepare(
          `UPDATE council_sessions SET lease_owner = NULL, lease_expires_at = NULL
            WHERE tenant_id = ? AND company_id = ? AND id = ? AND lease_owner = ?`,
        )
        .run(scope.tenant_id, scope.company_id, sessionId, this.workerId);
    } catch {
      // Release is advisory; the fencing generation is the authority.
    }
  }

  /**
   * One heartbeat: job lease + session lease + generation check. A false
   * return means the generation is stale and the caller must abort.
   */
  heartbeatOnce(
    scope: CouncilRunScope,
    job: CouncilJobRecord,
    claim: CouncilSessionLeaseClaim,
  ): boolean {
    const jobAlive = this.jobs.heartbeatJob(scope, {
      job_id: job.id,
      worker_id: this.workerId,
      lease_epoch: job.lease_epoch,
      lease_ttl_ms: this.leaseTtlMs,
    });
    if (!jobAlive) return false;
    if (!this.renewSessionLease(scope, job.session_id as string)) return false;
    if (!this.isCurrentGeneration(scope, job.session_id as string, claim)) return false;
    this.touchPresence();
    return true;
  }

  private isCurrentGeneration(
    scope: CouncilRunScope,
    sessionId: string,
    claim: CouncilSessionLeaseClaim,
  ): boolean {
    const row = this.readSession(scope, sessionId);
    if (!row) return false;
    if (COUNCIL_RUN_FENCED_STATES.has(row.state)) return false;
    if (row.cancellation_generation !== claim.cancel_generation) return false;
    const session = this.repositories.getSession(
      envelopeFromScope(
        {
          tenant_id: scope.tenant_id,
          company_id: scope.company_id,
          installation_id: scope.installation_id,
          owner_subject: row.owner_subject,
        },
        this.workerSubject(row),
        'worker',
        'write',
      ),
      sessionId,
    );
    return session?.state.lease_epoch === claim.lease_epoch;
  }

  private trackController(sessionId: string, controller: AbortController): void {
    const set = this.inFlight.get(sessionId) ?? new Set<AbortController>();
    set.add(controller);
    this.inFlight.set(sessionId, set);
  }

  private untrackController(sessionId: string, controller: AbortController): void {
    const set = this.inFlight.get(sessionId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) this.inFlight.delete(sessionId);
  }

  // ------------------------------------------------------------ cancellation

  /**
   * Cancel one session's run: abort supported in-flight transports, cancel
   * pending durable jobs, and bump the fencing generation so a late reply
   * from the previous generation can never persist.
   */
  cancelSessionRun(
    envelope: CouncilEnvelope,
    sessionId: string,
    input: { reason?: string | null } = {},
  ): CouncilRunCancelReceipt {
    const scope: CouncilRunScope = {
      tenant_id: envelope.tenant_id,
      company_id: envelope.company_id,
      installation_id: envelope.installation_id,
    };
    const controllers = this.inFlight.get(sessionId);
    let aborted = 0;
    if (controllers) {
      for (const controller of controllers) {
        if (!controller.signal.aborted) {
          controller.abort(input.reason ?? 'session_cancelled');
          aborted += 1;
        }
      }
    }
    const cancelled = this.jobs.cancelJobsForSession(scope, sessionId);
    const session = this.repositories.getSession(envelope, sessionId);
    if (!session) {
      return {
        session_id: sessionId,
        jobs_cancelled: cancelled,
        transports_aborted: aborted,
        lease_epoch: 0,
      };
    }
    const current = session.state;
    const next: SessionStateRecord = {
      ...current,
      state_version: current.state_version + 1,
      lease_epoch: current.lease_epoch + 1,
      updated_at: this.now(),
    };
    try {
      this.repositories.writeStateRecord(envelope, next, current.state_version);
    } catch {
      // The generation already moved (or a concurrent cancel won); the
      // row's epoch is at least as new as ours, and every writer is
      // fenced by whatever epoch the record now carries.
    }
    this.db
      .prepare(
        `UPDATE council_sessions SET lease_owner = NULL, lease_expires_at = NULL
          WHERE tenant_id = ? AND company_id = ? AND id = ?`,
      )
      .run(envelope.tenant_id, envelope.company_id, sessionId);
    return {
      session_id: sessionId,
      jobs_cancelled: cancelled,
      transports_aborted: aborted,
      lease_epoch: next.lease_epoch,
    };
  }

  // ------------------------------------------------------------------ drain

  /** Claim and execute every due council_run job once. */
  async drain(options: CouncilRunDrainOptions = {}): Promise<CouncilRunDrainSummary> {
    if (!this.transport) {
      return {
        available: false,
        reason:
          'transport_not_configured: no council run transport is wired, so no job may dispatch. Jobs stay queued; this worker reports unavailable rather than simulating execution.',
        scopes: 0,
        claimed: 0,
        jobs: [],
      };
    }
    this.touchPresence();
    const scopes = this.dueScopes();
    const maxJobs = options.maxJobsPerScope ?? 10;
    const summary: CouncilRunDrainSummary = {
      available: true,
      reason: null,
      scopes: scopes.length,
      claimed: 0,
      jobs: [],
    };
    for (const scope of scopes) {
      for (let i = 0; i < maxJobs; i += 1) {
        const job = this.jobs.claimDueJob(scope, {
          kind: COUNCIL_RUN_JOB_KIND,
          worker_id: this.workerId,
          lease_ttl_ms: options.leaseTtlMs ?? this.leaseTtlMs,
        });
        if (!job) break;
        summary.claimed += 1;
        const outcome = await this.runJob(scope, job);
        summary.jobs.push(outcome);
      }
    }
    this.touchPresence();
    return summary;
  }

  private markRunning(scope: CouncilRunScope, job: CouncilJobRecord): void {
    this.db
      .prepare(
        `UPDATE council_jobs SET state = 'running', updated_at = ?
          WHERE tenant_id = ? AND company_id = ? AND id = ?
            AND lease_owner = ? AND lease_epoch = ? AND state = 'leased'`,
      )
      .run(
        this.now(),
        scope.tenant_id,
        scope.company_id,
        job.id,
        this.workerId,
        job.lease_epoch,
      );
  }

  private payloadOf(job: CouncilJobRecord): {
    grant_id: string | null;
    attempt: number;
  } {
    const grantId = job.payload.grant_id;
    const attempt = job.payload.attempt;
    return {
      grant_id: typeof grantId === 'string' ? grantId : null,
      attempt: typeof attempt === 'number' && attempt >= 1 ? attempt : 1,
    };
  }

  private operationIdFor(sessionId: string, attempt: number, phase: string): string {
    return `council-run:${sessionId}:attempt:${attempt}:${phase}`;
  }

  private acceptedAttempt(
    scope: CouncilRunScope,
    sessionId: string,
    operationId: string,
  ): AcceptedAttemptRow | null {
    const row = this.db
      .prepare(
        `SELECT operation_id, status FROM council_provider_attempts
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND operation_id = ?`,
      )
      .get(scope.tenant_id, scope.company_id, sessionId, operationId) as
      | AcceptedAttemptRow
      | undefined;
    return row ?? null;
  }

  private recordAttempt(
    scope: CouncilRunScope,
    sessionId: string,
    jobId: string,
    operationId: string,
    input: {
      status: string;
      outcome_code: string | null;
      route: CouncilRouteSelection;
      request_sha256: string;
      response_sha256: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      actual_minor: number | null;
      currency: string | null;
      round: number;
    },
  ): string {
    const now = this.now();
    const id = this.newId();
    this.db
      .prepare(
        `INSERT INTO council_provider_attempts
           (tenant_id, company_id, session_id, id, job_id, operation_id, seat_id, round,
            provider_id, provider_config_version, model_ref, model_selection_source, status,
            outcome_code, retry_safe, input_tokens, output_tokens, actual_cost_minor, currency,
            request_hash, response_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'run-grant', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, company_id, operation_id) DO UPDATE SET
           status = excluded.status,
           outcome_code = excluded.outcome_code,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           actual_cost_minor = excluded.actual_cost_minor,
           currency = excluded.currency,
           response_hash = excluded.response_hash,
           updated_at = excluded.updated_at
         WHERE council_provider_attempts.status IN ('reserved', 'dispatched')`,
      )
      .run(
        scope.tenant_id,
        scope.company_id,
        sessionId,
        id,
        jobId,
        operationId,
        input.round,
        input.route.providerSlug,
        input.route.requestedModelOrAlias ?? input.route.routeId,
        input.route.selectionSource,
        input.status,
        input.outcome_code,
        input.input_tokens,
        input.output_tokens,
        input.actual_minor,
        input.currency,
        input.request_sha256,
        input.response_sha256,
        now,
        now,
      );
    return id;
  }

  private finish(
    scope: CouncilRunScope,
    job: CouncilJobRecord,
    outcome: 'succeeded' | 'failed',
    input: {
      error_code?: string | null;
      terminal_reason?: string | null;
      checkpoint?: Record<string, unknown> | null;
    },
  ): boolean {
    const ok = this.jobs.finishJob(scope, {
      job_id: job.id,
      worker_id: this.workerId,
      lease_epoch: job.lease_epoch,
      outcome,
      error_code: input.error_code ?? null,
      terminal_reason: input.terminal_reason ?? null,
      checkpoint: input.checkpoint ?? null,
    });
    this.releaseSessionLease(scope, job.session_id as string);
    return ok;
  }

  private async runJob(
    scope: CouncilRunScope,
    job: CouncilJobRecord,
  ): Promise<CouncilRunJobOutcome> {
    const sessionId = job.session_id;
    const base = {
      job_id: job.id,
      session_id: sessionId,
      operation_id: null as string | null,
      lease_epoch: null as number | null,
    };
    if (!sessionId) {
      return {
        ...base,
        outcome: 'failed',
        reason: 'job_has_no_session',
      };
    }
    const row = this.readSession(scope, sessionId);
    if (!row) {
      this.finish(scope, job, 'failed', {
        error_code: 'SESSION_NOT_FOUND',
        terminal_reason: 'session_not_found',
      });
      return { ...base, outcome: 'failed', reason: 'session_not_found' };
    }
    const envelope = this.workerEnvelope(scope, row);
    this.markRunning(scope, job);

    const claim = this.claimSessionLease(envelope, sessionId);
    if (!claim.claimed) {
      // Do not finish: the job lease expires and the queue recovers it.
      return { ...base, outcome: 'fenced', reason: claim.reason };
    }
    const principal = this.workerPrincipal(scope, claim.owner_subject);
    const { grant_id, attempt } = this.payloadOf(job);
    const operationId = this.operationIdFor(sessionId, attempt, 'prepare');
    base.operation_id = operationId;
    base.lease_epoch = claim.lease_epoch;

    const controller = new AbortController();
    this.trackController(sessionId, controller);
    const timer = setInterval(() => {
      try {
        if (!this.heartbeatOnce(scope, job, claim)) {
          controller.abort('lease_lost');
        }
      } catch {
        controller.abort('heartbeat_failed');
      }
    }, this.heartbeatMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    // Kept for the fenced catch so a late result can be observed against
    // the operation it belongs to, without inventing a route.
    let dispatchedRoute: CouncilRouteSelection | null = null;
    let dispatchedRequestSha = '';

    try {
      // Recovery: a result already accepted at this operation is never
      // replayed. Restart resumes from the durable checkpoint.
      if (job.checkpoint && job.checkpoint.status === 'accepted') {
        this.finish(scope, job, 'succeeded', {
          checkpoint: job.checkpoint,
          terminal_reason: 'recovered_already_accepted',
        });
        return { ...base, outcome: 'recovered', reason: 'checkpoint_accepted' };
      }
      const accepted = this.acceptedAttempt(scope, sessionId, operationId);
      if (accepted?.status === 'accepted') {
        this.finish(scope, job, 'succeeded', {
          checkpoint: {
            operation_id: operationId,
            status: 'accepted',
            lease_epoch: claim.lease_epoch,
            updated_at: this.now(),
          },
          terminal_reason: 'recovered_already_accepted',
        });
        return { ...base, outcome: 'recovered', reason: 'attempt_already_accepted' };
      }

      if (!this.isCurrentGeneration(scope, sessionId, claim)) {
        throw new CouncilRunFencedError(
          `Generation ${claim.lease_epoch} of session ${sessionId} is stale before admission.`,
        );
      }
      if (!grant_id) {
        this.finish(scope, job, 'failed', {
          error_code: 'RUN_GRANT_MISSING',
          terminal_reason: 'job payload names no run grant',
        });
        return { ...base, outcome: 'failed', reason: 'grant_missing' };
      }

      const grantRecord = this.runAuthorization.loadGrantRecord(principal, grant_id);
      if (!grantRecord || grantRecord.proof.stage !== 'granted') {
        this.finish(scope, job, 'failed', {
          error_code: 'RUN_GRANT_INACTIVE',
          terminal_reason: `grant ${grant_id} is not a granted run grant`,
        });
        return { ...base, outcome: 'failed', reason: 'grant_not_usable' };
      }
      const routeSnapshot = grantRecord.proof.route_snapshot;
      if (!routeSnapshot) {
        this.finish(scope, job, 'failed', {
          error_code: 'RUN_ROUTE_PIN_MISSING',
          terminal_reason: 'the grant carries no pinned route snapshot',
        });
        return { ...base, outcome: 'failed', reason: 'route_pin_missing' };
      }
      const currency =
        grantRecord.currency ?? grantRecord.proof.ceilings.max_money?.currency ?? null;
      if (!currency) {
        this.finish(scope, job, 'failed', {
          error_code: 'RUN_CURRENCY_REQUIRED',
          terminal_reason: 'no currency is bound to the grant; admission would be unpriced',
        });
        return { ...base, outcome: 'failed', reason: 'currency_missing' };
      }

      const admission = this.runAuthorization.admitOperation(principal, {
        grant_id,
        session_id: sessionId,
        operation_id: operationId,
        kind: 'provider_request',
        purpose: 'council_run',
        estimate_minor: 0,
        currency,
        lease_epoch: claim.lease_epoch,
        route_snapshot: routeSnapshot,
      });

      const requestSha = admission.route_snapshot_fingerprint;
      dispatchedRoute = routeSnapshot;
      dispatchedRequestSha = requestSha;
      this.recordAttempt(scope, sessionId, job.id, operationId, {
        status: 'dispatched',
        outcome_code: null,
        route: routeSnapshot,
        request_sha256: requestSha,
        response_sha256: null,
        input_tokens: null,
        output_tokens: null,
        actual_minor: null,
        currency,
        round: 0,
      });

      const result = await this.transport!.dispatch({
        tenant_id: scope.tenant_id,
        company_id: scope.company_id,
        installation_id: scope.installation_id,
        session_id: sessionId,
        job_id: job.id,
        operation_id: operationId,
        attempt,
        lease_epoch: claim.lease_epoch,
        route: routeSnapshot,
        signal: controller.signal,
      });

      // Late reply from a fenced generation is rejected before anything
      // is settled or accepted.
      if (!this.isCurrentGeneration(scope, sessionId, claim)) {
        throw new CouncilRunFencedError(
          `Generation ${claim.lease_epoch} of session ${sessionId} was fenced while the transport ran; the late result is discarded.`,
        );
      }

      const actual = result.actual_minor ?? 0;
      if (result.status === 'unknown') {
        this.runAuthorization.recordConsumption(principal, {
          grant_id,
          session_id: sessionId,
          operation_id: operationId,
          lease_epoch: claim.lease_epoch,
          outcome: 'unknown',
        });
      } else {
        this.runAuthorization.recordConsumption(principal, {
          grant_id,
          session_id: sessionId,
          operation_id: operationId,
          lease_epoch: claim.lease_epoch,
          outcome: 'settled',
          actual_minor: actual,
        });
      }
      this.recordAttempt(scope, sessionId, job.id, operationId, {
        status:
          result.status === 'accepted'
            ? 'accepted'
            : result.status === 'failed'
              ? 'failed'
              : 'provider_completion_unknown',
        outcome_code: result.error_code ?? null,
        route: routeSnapshot,
        request_sha256: requestSha,
        response_sha256: result.response_sha256 ?? null,
        input_tokens: result.input_tokens ?? null,
        output_tokens: result.output_tokens ?? null,
        actual_minor: actual,
        currency,
        round: 0,
      });

      if (result.status === 'accepted') {
        this.finish(scope, job, 'succeeded', {
          checkpoint: {
            operation_id: operationId,
            status: 'accepted',
            lease_epoch: claim.lease_epoch,
            updated_at: this.now(),
          },
          terminal_reason: 'prepared',
        });
        return { ...base, outcome: 'succeeded', reason: null };
      }
      const failed = result.status === 'failed';
      this.finish(scope, job, 'failed', {
        error_code: failed ? result.error_code ?? 'TRANSPORT_FAILED' : 'PROVIDER_COMPLETION_UNKNOWN',
        terminal_reason: failed ? 'transport reported failure' : 'provider completion unknown',
        checkpoint: {
          operation_id: operationId,
          status: result.status,
          lease_epoch: claim.lease_epoch,
          updated_at: this.now(),
        },
      });
      return {
        ...base,
        outcome: 'failed',
        reason: failed ? result.error_code ?? 'transport_failed' : 'completion_unknown',
      };
    } catch (error) {
      if (error instanceof CouncilRunFencedError) {
        // Accounting honesty: the stale generation settles nothing. An
        // ambiguous provider completion is left at estimate by never
        // being settled (the reservation stays reserved for review).
        try {
          if (dispatchedRoute) {
            this.recordAttempt(scope, sessionId, job.id, operationId, {
              status: 'cancelled',
              outcome_code: 'LEASE_FENCED',
              route: dispatchedRoute,
              request_sha256: dispatchedRequestSha,
              response_sha256: null,
              input_tokens: null,
              output_tokens: null,
              actual_minor: null,
              currency: null,
              round: 0,
            });
          }
        } catch {
          // Best-effort observation only.
        }
        this.finish(scope, job, 'failed', {
          error_code: 'LEASE_FENCED',
          terminal_reason: error.message,
        });
        return { ...base, outcome: 'fenced', reason: 'lease_fenced' };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.finish(scope, job, 'failed', {
        error_code:
          (error as { code?: string }).code ?? 'RUN_WORKER_ERROR',
        terminal_reason: message,
      });
      return { ...base, outcome: 'failed', reason: message };
    } finally {
      clearInterval(timer);
      this.untrackController(sessionId, controller);
    }
  }
}

let sharedEngine: CouncilEngine | null = null;

/**
 * The process-wide engine. Background composition (the scheduler's
 * outbox pump) and any in-process subscriber share one registry and
 * one store profile through here.
 */
export function getCouncilEngine(): CouncilEngine {
  if (!sharedEngine) sharedEngine = composeCouncilEngine();
  return sharedEngine;
}

/** Test seam: replace the shared engine (isolated stores in tests). */
export function setCouncilEngineForTests(engine: CouncilEngine | null): void {
  sharedEngine = engine;
}
