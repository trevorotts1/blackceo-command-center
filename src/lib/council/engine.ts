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

import {
  envelopeFromScope,
  openCouncilRepositories,
  type CouncilRepositories,
} from './store';
import { openCouncilStore, type CouncilStore } from './persistence/council-store';
import {
  CouncilEventSubscriptions,
  drainCouncilEventOutbox,
  type CouncilOutboxDrainResult,
} from './events/fanout';
import { CouncilJobService, CouncilRunControls } from './jobs';
import { CouncilRunAuthorizationService } from './run-authorization';
import { CouncilRunAuthorizationAdapter } from './run-authorization-adapter';
import { CouncilSettingsService } from './settings';
import type { ReportDownloadsDeps } from './report-downloads';
import type { CouncilPrincipal } from './auth';
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
}

/** Compose the council engine over the given (or default) store. */
export function composeCouncilEngine(overrides: CouncilEngineOverrides = {}): CouncilEngine {
  const store = overrides.store ?? openCouncilStore();
  const repositories = openCouncilRepositories({ adapter: store });
  const subscriptions = overrides.subscriptions ?? new CouncilEventSubscriptions();
  const jobs = new CouncilJobService({ store });
  const settings = overrides.settings ?? new CouncilSettingsService();
  const runAuthorizationService = new CouncilRunAuthorizationService({ store });

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
