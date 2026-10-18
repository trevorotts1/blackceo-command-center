/**
 * WER-024: durable AI CEO intent commands (v2.4 plan).
 *
 * The CWE-037 dispatcher (dispatch.ts) resolves existing state and
 * returns REQUEST descriptors: it never creates a session, never
 * starts a run, and never creates a task. This module is the durable
 * command layer the AI CEO actually needs, and it is deliberately
 * separate so the resolution-only contract keeps its proof:
 *
 * - `create` commits a REAL council session through the existing API
 *   draft service (canonical SessionSpec / DecisionBrief / state
 *   record validation, request-key idempotency) and ensures the ONE
 *   company-aware session parent task through the existing canonical
 *   parent adapter. A replayed delivery with the same idempotency key
 *   returns the SAME receipt and creates no second session or task.
 * - `start` hands the session to the existing run controls: a real
 *   CWE-049 grant must resolve, the canonical state machine moves
 *   DRAFT -> READY -> QUEUED, and a durable `council_run` job is
 *   enqueued. Without a grant the outcome is an explicit typed
 *   failure, never a fabricated receipt.
 * - `status` reads committed state, the durable job, the recorded
 *   verdict revision and the plan count. It writes nothing.
 * - `stop` cancels through the same run controls (idempotent on an
 *   already-cancelled session) and creates no work.
 * - `follow_up` creates the linked one-seat consult child through the
 *   existing coordination service; the parent session, its cards and
 *   its verdict are untouched, and a replayed delivery returns the
 *   same child session.
 *
 * Every receipt is built from COMMITTED records (session row, job row,
 * verdict row, coordination journal) and carries a deterministic
 * `receipt_id`, so duplicate delivery is provably the same receipt.
 * Nothing in this module claims a live provider conversation, an
 * authenticated session, or an executed action plan: those remain
 * deferred to the run worker and the action-plan handoff.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { canonicalHash, type SessionState } from '../contracts';
import type { CouncilPermission, CouncilPrincipal } from '../auth';
import {
  CouncilPersistenceError,
  CouncilRepositories,
  envelopeFromScope,
  type CouncilEnvelope,
  type CouncilStoredSession,
} from '../store';
import { openCouncilStore, type CouncilStore } from '../persistence/council-store';
import {
  CouncilJobService,
  CouncilRunControlError,
  CouncilRunControls,
  type CouncilJobRecord,
} from '../jobs';
import { CouncilRunAuthorizationService } from '../run-authorization';
import { CouncilRunAuthorizationAdapter } from '../run-authorization-adapter';
import { createFollowUpSession } from '../coordination';
import { createDraftSession, type SessionDraftInput } from '../api/drafts';
import { CouncilApiError } from '../api/errors';
import { CanonicalParentTaskAdapter } from '../kanban/parent-task';
import {
  authorizeKanbanOperation,
  rowScopeFields,
  type KanbanAuthOptions,
} from '../kanban/context';
import { CouncilKanbanError } from '../kanban/errors';
import { CouncilIntentError } from './errors';
import { classifyCouncilIntent, type CouncilIntentClassification } from './registry';

export type CouncilCommandName = 'create' | 'start' | 'status' | 'stop' | 'follow_up' | 'none';

/** The committed command receipt. Every field is read back from storage. */
export interface CouncilCommandReceipt {
  ok: true;
  command: Exclude<CouncilCommandName, 'none'>;
  /** Deterministic over committed facts: duplicates share this id. */
  receipt_id: string;
  /** True when this delivery replayed an already-committed command. */
  replayed: boolean;
  session_id: string;
  parent_session_id: string | null;
  company_id: string;
  owner_subject: string | null;
  state: SessionState;
  state_version: number;
  committed_at: string;
  parent_task_id: string | null;
  job_id: string | null;
  job_state: string | null;
  grant_id: string | null;
  attempt: number | null;
  seat_id: string | null;
  verdict_revision: number | null;
  verdict_recorded_at: string | null;
  plan_count: number;
}

/** An explicit failure: no committed receipt is ever invented. */
export interface CouncilCommandFailure {
  ok: false;
  command: CouncilCommandName;
  code: string;
  message: string;
  retryable: boolean;
}

export type CouncilCommandResult = CouncilCommandReceipt | CouncilCommandFailure;

export interface CouncilIntentCommandRequest {
  text: string;
  /** Required for every mutating command; replay key for durable dedup. */
  idempotency_key: string;
  session_id?: string | null;
  /** Session input required by a convene ("ask my council") command. */
  session?: SessionDraftInput | null;
  seat_id?: string | null;
  question?: string | null;
  evidence_ids?: string[];
  expected_version?: number;
  grant_id?: string | null;
}

export interface CouncilIntentCommandOutcome {
  classification: CouncilIntentClassification;
  result: CouncilCommandResult;
}

export interface CouncilIntentCommandDispatcherDeps {
  repositories?: CouncilRepositories;
  db?: Database.Database;
  store?: CouncilStore;
  jobs?: CouncilJobService;
  runAuthorization?: CouncilRunAuthorizationService;
  parentAdapter?: CanonicalParentTaskAdapter;
  now?: () => string;
  newId?: () => string;
}

const TERMINAL_SESSION_STATES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'CANCELLED',
  'FAILED',
]);

const PAUSE_FAMILY: ReadonlySet<string> = new Set(['pause', 'resume']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorDetails(error: unknown): { code: string; message: string; retryable: boolean; status: number } {
  if (error instanceof CouncilRunControlError) {
    return { code: error.code, message: error.message, retryable: false, status: error.status };
  }
  if (error instanceof CouncilIntentError) {
    return { code: error.code, message: error.message, retryable: false, status: error.status };
  }
  if (error instanceof CouncilKanbanError) {
    return { code: error.code, message: error.message, retryable: false, status: error.status };
  }
  if (error instanceof CouncilPersistenceError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: 409,
    };
  }
  if (error instanceof CouncilApiError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    };
  }
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'COUNCIL_COMMAND_FAILED';
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    status: 500,
  };
}

/**
 * The durable command dispatcher over the existing council services.
 * One instance serves one host database.
 */
export class CouncilIntentCommandDispatcher {
  private readonly repositories: CouncilRepositories;
  private readonly db: Database.Database;
  private readonly store: CouncilStore;
  private readonly jobs: CouncilJobService;
  private readonly runAuthorization: CouncilRunAuthorizationService;
  private readonly parentAdapter: CanonicalParentTaskAdapter;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(deps: CouncilIntentCommandDispatcherDeps = {}) {
    this.db = deps.db ?? getDb();
    this.repositories = deps.repositories ?? new CouncilRepositories();
    this.store = deps.store ?? openCouncilStore();
    this.jobs = deps.jobs ?? new CouncilJobService({ store: this.store, now: deps.now, newId: deps.newId });
    this.runAuthorization =
      deps.runAuthorization ?? new CouncilRunAuthorizationService({ store: this.store, now: deps.now, newId: deps.newId });
    this.parentAdapter =
      deps.parentAdapter ??
      new CanonicalParentTaskAdapter({
        repositories: this.repositories,
        db: this.db,
        now: deps.now,
        newId: deps.newId,
      });
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  // ------------------------------------------------------------- dispatch

  /**
   * Classify one surface utterance and execute the matching durable
   * command. Unsupported classifications return an explicit failure;
   * a non-council message returns `COUNCIL_NO_INTENT` and touches
   * nothing.
   */
  async dispatch(
    principal: CouncilPrincipal,
    request: CouncilIntentCommandRequest,
    auth?: KanbanAuthOptions,
  ): Promise<CouncilIntentCommandOutcome> {
    const text = request.text ?? '';
    const classification = classifyCouncilIntent(text);
    if (/\b(start|begin)\b[\s\S]*\bcouncil\b|\bcouncil\b[\s\S]*\b(start|begin)\b/.test(` ${text.toLowerCase()} `)) {
      return {
        classification,
        result: await this.start(principal, {
          session_id: request.session_id ?? null,
          idempotency_key: request.idempotency_key,
          expected_version: request.expected_version,
          grant_id: request.grant_id ?? null,
          auth,
        }),
      };
    }
    switch (classification.intent) {
      case 'none':
        return {
          classification,
          result: {
            ok: false,
            command: 'none',
            code: 'COUNCIL_NO_INTENT',
            message: 'That message is not a council request; nothing was dispatched.',
            retryable: false,
          },
        };
      case 'session_control':
        if (classification.control_command && PAUSE_FAMILY.has(classification.control_command)) {
          return {
            classification,
            result: {
              ok: false,
              command: 'stop',
              code: 'COUNCIL_COMMAND_UNSUPPORTED',
              message:
                `The ${classification.control_command} control is not part of the durable ` +
                'create/start/status/stop/follow-up command set; nothing was changed.',
              retryable: false,
            },
          };
        }
        return {
          classification,
          result: await this.stop(principal, {
            session_id: request.session_id ?? null,
            idempotency_key: request.idempotency_key,
            expected_version: request.expected_version,
            auth,
          }),
        };
      case 'read_result':
        return {
          classification,
          result: await this.status(principal, {
            session_id: request.session_id ?? null,
            auth,
          }),
        };
      case 'explain_objection':
        if (classification.requires_inference) {
          return {
            classification,
            result: await this.followUp(principal, {
              session_id: request.session_id ?? null,
              seat_id: request.seat_id ?? classification.seat_id,
              question: request.question ?? text,
              evidence_ids: request.evidence_ids,
              idempotency_key: request.idempotency_key,
              auth,
            }),
          };
        }
        return {
          classification,
          result: {
            ok: false,
            command: 'follow_up',
            code: 'COUNCIL_COMMAND_UNSUPPORTED',
            message:
              'Retrieving a recorded objection is a read, not a follow-up command; nothing was created.',
            retryable: false,
          },
        };
      case 'consult_seat':
      case 'follow_up':
        return {
          classification,
          result: await this.followUp(principal, {
            session_id: request.session_id ?? null,
            seat_id: request.seat_id ?? classification.seat_id,
            question: request.question ?? text,
            evidence_ids: request.evidence_ids,
            idempotency_key: request.idempotency_key,
            auth,
          }),
        };
      case 'convene_council':
        if (!request.session) {
          return {
            classification,
            result: {
              ok: false,
              command: 'create',
              code: 'COUNCIL_SESSION_INPUT_REQUIRED',
              message:
                'Convening requires the validated session input (source pack, model policy, brief ' +
                'options). No session was created and nothing was invented to fill the gap.',
              retryable: false,
            },
          };
        }
        return {
          classification,
          result: await this.create(principal, {
            session: request.session,
            idempotency_key: request.idempotency_key,
            auth,
          }),
        };
      case 'rerun_session':
        return {
          classification,
          result: {
            ok: false,
            command: 'none',
            code: 'COUNCIL_COMMAND_UNSUPPORTED',
            message:
              'Rerun has its own coordination service and is not part of the durable command set; ' +
              'nothing was created and the original approval does not carry over.',
            retryable: false,
          },
        };
    }
  }

  // --------------------------------------------------------------- create

  /**
   * Commit one council session draft and ensure its single parent task.
   * Idempotent on the caller's key through the existing request-key
   * claim; a replay returns the originally committed session.
   */
  async create(
    principal: CouncilPrincipal,
    input: { session: SessionDraftInput; idempotency_key: string; auth?: KanbanAuthOptions },
  ): Promise<CouncilCommandResult> {
    try {
      const ctx = {
        principal,
        requestId: this.newId(),
        repositories: this.repositories,
        store: this.store,
      };
      const created = createDraftSession(ctx, input.session, input.idempotency_key);
      const session = created.session;
      let parentTaskId: string | null = null;
      const parent = await this.parentAdapter.ensureParentTask(
        principal,
        session.spec.session_id,
        input.auth,
      );
      if (parent.kind === 'linked') parentTaskId = parent.task_id;
      return this.sessionReceipt('create', session, {
        replayed: created.replayed,
        parentTaskId,
      });
    } catch (error) {
      return this.failure('create', error);
    }
  }

  // ---------------------------------------------------------------- start

  /** Start a session through the existing run controls (grant required). */
  async start(
    principal: CouncilPrincipal,
    input: {
      session_id: string | null;
      idempotency_key: string;
      expected_version?: number;
      grant_id?: string | null;
      auth?: KanbanAuthOptions;
    },
  ): Promise<CouncilCommandResult> {
    try {
      const sessionId = this.resolveSessionId(principal, input.session_id);
      const envelope = this.writeEnvelope(principal, sessionId, 'run', input.auth);
      const controls = this.runControls(principal);
      const receipt = await controls.start(principal, envelope, sessionId, {
        grant_id: input.grant_id ?? null,
        expected_version: input.expected_version,
      });
      const session = this.loadSession(principal, sessionId, 'read');
      const job = this.latestJob(principal, sessionId);
      return this.sessionReceipt('start', session, {
        replayed: receipt.idempotent_replay,
        jobId: receipt.job_id,
        jobState: job?.state ?? null,
        grantId: receipt.grant_id,
        attempt: receipt.attempt,
        stateOverride: receipt.state,
        stateVersionOverride: receipt.state_version,
      });
    } catch (error) {
      return this.failure('start', error);
    }
  }

  // --------------------------------------------------------------- status

  /** Read committed session, job, verdict and plan facts. Writes nothing. */
  async status(
    principal: CouncilPrincipal,
    input: { session_id: string | null; auth?: KanbanAuthOptions },
  ): Promise<CouncilCommandResult> {
    try {
      const sessionId = this.resolveSessionId(principal, input.session_id);
      const session = this.loadSession(principal, sessionId, 'read', input.auth);
      const scope = session.scope;
      const job = this.latestJob(principal, sessionId);
      const verdict = this.db
        .prepare(
          `SELECT brief_revision, created_at FROM council_verdicts
            WHERE tenant_id = ? AND company_id = ? AND session_id = ?
            ORDER BY brief_revision DESC LIMIT 1`,
        )
        .get(scope.tenant_id, scope.company_id, sessionId) as
        | { brief_revision: number; created_at: string }
        | undefined;
      const plans = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM council_action_proposals
            WHERE tenant_id = ? AND company_id = ? AND session_id = ?`,
        )
        .get(scope.tenant_id, scope.company_id, sessionId) as { n: number };
      return {
        ok: true,
        command: 'status',
        receipt_id: canonicalHash({
          command: 'status',
          session_id: sessionId,
          state: session.state.state,
          state_version: session.state.state_version,
          job_id: job?.id ?? null,
          job_state: job?.state ?? null,
          verdict_revision: verdict?.brief_revision ?? null,
          plan_count: plans.n,
        }),
        replayed: false,
        session_id: sessionId,
        parent_session_id: null,
        company_id: scope.company_id,
        owner_subject: session.scope.owner_subject,
        state: session.state.state,
        state_version: session.state.state_version,
        committed_at: session.state.updated_at,
        parent_task_id: this.parentTaskId(sessionId, scope),
        job_id: job?.id ?? null,
        job_state: job?.state ?? null,
        grant_id: typeof job?.payload.grant_id === 'string' ? job.payload.grant_id : null,
        attempt: session.state.attempt,
        seat_id: null,
        verdict_revision: verdict?.brief_revision ?? null,
        verdict_recorded_at: verdict?.created_at ?? null,
        plan_count: plans.n,
      };
    } catch (error) {
      return this.failure('status', error);
    }
  }

  // ---------------------------------------------------------------- stop

  /** Cancel through the existing run controls; idempotent once cancelled. */
  async stop(
    principal: CouncilPrincipal,
    input: {
      session_id: string | null;
      idempotency_key: string;
      expected_version?: number;
      auth?: KanbanAuthOptions;
    },
  ): Promise<CouncilCommandResult> {
    try {
      const sessionId = this.resolveSessionId(principal, input.session_id);
      const envelope = this.writeEnvelope(principal, sessionId, 'run', input.auth);
      const controls = this.runControls(principal);
      const receipt = controls.cancel(envelope, sessionId, {
        expected_version: input.expected_version,
      });
      const session = this.loadSession(principal, sessionId, 'read');
      return this.sessionReceipt('stop', session, {
        replayed: receipt.idempotent_replay,
        stateOverride: receipt.state,
        stateVersionOverride: receipt.state_version,
      });
    } catch (error) {
      return this.failure('stop', error);
    }
  }

  // ------------------------------------------------------------ follow_up

  /**
   * Create the linked one-seat consult child for a follow-up question
   * through the existing coordination service. The parent session, its
   * cards and its verdict are never modified.
   */
  async followUp(
    principal: CouncilPrincipal,
    input: {
      session_id: string | null;
      seat_id?: string | null;
      question: string;
      evidence_ids?: string[];
      idempotency_key: string;
      auth?: KanbanAuthOptions;
    },
  ): Promise<CouncilCommandResult> {
    try {
      const parentSessionId = this.resolveSessionId(principal, input.session_id);
      const envelope = this.writeEnvelope(principal, parentSessionId, 'run', input.auth);
      const parent = this.loadSession(principal, parentSessionId, 'write', input.auth);
      const seatId = input.seat_id ?? parent.spec.seat_ids[0] ?? null;
      if (!seatId) {
        throw new CouncilIntentError(
          'COUNCIL_INTENT_SESSION_REQUIRED',
          `Session ${parentSessionId} carries no seat to consult; a follow-up names one of its own seats.`,
        );
      }
      if (!input.question || input.question.trim() === '') {
        throw new CouncilIntentError(
          'COUNCIL_INTENT_SESSION_REQUIRED',
          'A follow-up requires the question it asks.',
        );
      }
      const result = createFollowUpSession(
        { repositories: this.repositories, store: this.store },
        envelope,
        parent,
        {
          seat_id: seatId,
          question: input.question,
          evidence_ids: input.evidence_ids,
          actor_subject: principal.subject,
          idempotency_key: input.idempotency_key,
        },
      );
      const child = this.loadSession(principal, result.child_session_id, 'read');
      return {
        ok: true,
        command: 'follow_up',
        receipt_id: canonicalHash({
          command: 'follow_up',
          parent_session_id: result.parent_session_id,
          session_id: result.child_session_id,
          seat_id: result.seat_id,
        }),
        replayed: result.idempotent_replay,
        session_id: result.child_session_id,
        parent_session_id: result.parent_session_id,
        company_id: child.scope.company_id,
        owner_subject: child.scope.owner_subject,
        state: child.state.state,
        state_version: child.state.state_version,
        committed_at: child.spec.created_at,
        parent_task_id: null,
        job_id: null,
        job_state: null,
        grant_id: null,
        attempt: child.state.attempt,
        seat_id: result.seat_id,
        verdict_revision: null,
        verdict_recorded_at: null,
        plan_count: 0,
      };
    } catch (error) {
      return this.failure('follow_up', error);
    }
  }

  // ----------------------------------------------------------- internals

  private runControls(principal: CouncilPrincipal): CouncilRunControls {
    return new CouncilRunControls({
      repositories: this.repositories,
      jobs: this.jobs,
      runAuthorization: this.runAuthorization,
      adapter: new CouncilRunAuthorizationAdapter({
        principal,
        service: this.runAuthorization,
        db: this.db,
      }),
    });
  }

  /**
   * Resolve the session a command targets: the explicit id when given,
   * otherwise the caller's most recent non-terminal session. Private
   * sessions of other owners are never candidates.
   */
  private resolveSessionId(principal: CouncilPrincipal, requested: string | null): string {
    if (requested) return requested;
    const rows = this.db
      .prepare(
        `SELECT id, state FROM council_sessions
          WHERE tenant_id = ? AND company_id = ? AND archived = 0
            AND (visibility = 'company' OR owner_subject = ?)
          ORDER BY updated_at DESC`,
      )
      .all(principal.scope.tenant_id, principal.scope.company_id, principal.subject) as Array<{
      id: string;
      state: string;
    }>;
    const active = rows.find((row) => !TERMINAL_SESSION_STATES.has(row.state));
    if (!active) {
      throw new CouncilIntentError(
        'COUNCIL_INTENT_SESSION_REQUIRED',
        'No active council session could be resolved in the caller\'s scope; name the session explicitly. Nothing was changed.',
      );
    }
    return active.id;
  }

  private writeEnvelope(
    principal: CouncilPrincipal,
    sessionId: string,
    permission: CouncilPermission,
    auth?: KanbanAuthOptions,
  ): CouncilEnvelope {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      permission,
      'mutate',
      auth,
    );
    return envelopeFromScope(scope, principal.subject, 'owner', 'write');
  }

  private loadSession(
    principal: CouncilPrincipal,
    sessionId: string,
    mode: 'read' | 'write',
    auth?: KanbanAuthOptions,
  ): CouncilStoredSession {
    const { row, scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'read',
      'read',
      auth,
    );
    const envelope = envelopeFromScope(
      rowScopeFields(row),
      principal.subject,
      'owner',
      mode,
    );
    const session = this.repositories.getSession(envelope, sessionId);
    if (!session) {
      throw new CouncilKanbanError(
        'COUNCIL_SESSION_NOT_FOUND',
        `Council session ${sessionId} is not visible in the caller's scope.`,
        404,
      );
    }
    return session;
  }

  private latestJob(principal: CouncilPrincipal, sessionId: string): CouncilJobRecord | null {
    return (
      this.jobs
        .listJobsForSession(
          { tenant_id: principal.scope.tenant_id, company_id: principal.scope.company_id },
          sessionId,
        )
        .filter((job) => job.kind === 'council_run')
        .at(-1) ?? null
    );
  }

  private parentTaskId(
    sessionId: string,
    scope: { tenant_id: string; company_id: string },
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT parent_task_id FROM council_kanban_links
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?`,
      )
      .get(scope.tenant_id, scope.company_id, sessionId) as
      | { parent_task_id: string }
      | undefined;
    return row?.parent_task_id ?? null;
  }

  private sessionReceipt(
    command: Exclude<CouncilCommandName, 'none'>,
    session: CouncilStoredSession,
    opts: {
      replayed: boolean;
      parentTaskId?: string | null;
      jobId?: string | null;
      jobState?: string | null;
      grantId?: string | null;
      attempt?: number | null;
      stateOverride?: SessionState;
      stateVersionOverride?: number;
    },
  ): CouncilCommandReceipt {
    const sessionId = session.spec.session_id;
    const state = opts.stateOverride ?? session.state.state;
    const stateVersion = opts.stateVersionOverride ?? session.state.state_version;
    return {
      ok: true,
      command,
      receipt_id: canonicalHash({
        command,
        session_id: sessionId,
        parent_task_id: opts.parentTaskId ?? null,
        job_id: opts.jobId ?? null,
        grant_id: opts.grantId ?? null,
        attempt: opts.attempt ?? null,
        state,
        state_version: stateVersion,
      }),
      replayed: opts.replayed,
      session_id: sessionId,
      parent_session_id: null,
      company_id: session.scope.company_id,
      owner_subject: session.scope.owner_subject,
      state,
      state_version: stateVersion,
      committed_at: session.state.updated_at,
      parent_task_id: opts.parentTaskId ?? null,
      job_id: opts.jobId ?? null,
      job_state: opts.jobState ?? null,
      grant_id: opts.grantId ?? null,
      attempt: opts.attempt ?? session.state.attempt,
      seat_id: null,
      verdict_revision: null,
      verdict_recorded_at: null,
      plan_count: 0,
    };
  }

  private failure(command: CouncilCommandName, error: unknown): CouncilCommandFailure {
    const details = errorDetails(error);
    return {
      ok: false,
      command,
      code: details.code,
      message: details.message,
      retryable: details.retryable,
    };
  }
}
