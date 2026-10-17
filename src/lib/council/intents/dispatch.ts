/**
 * CWE-037 council intent dispatch adapter (Sections 17.5, 20, 31).
 *
 * This adapter is the seam between a front-door surface (dashboard,
 * chat, a department, the AI CEO) and the council's locked service
 * ports. Section 17.5 assigns this layer adapter-level tests against
 * those ports; CWE-045 does the production wiring and CWE-050 serves
 * the endpoints. The adapter composes only accepted surfaces:
 *
 * - Session controls resolve through CWE-035's CouncilScanQueue
 *   board-command resolution, which journals the resolution and
 *   creates nothing. Controls are dispatched FIRST, before any
 *   work-creating intent, per Section 20.2.
 * - Verdict and objection reads read the CWE-006 store's recorded
 *   rows (council_verdicts, council_cards) under the CWE-007 scope
 *   assertions every kanban operation uses.
 * - Convene, consult, follow-up, and rerun intents produce REQUEST
 *   descriptors only. Creating a session, running a consult, and
 *   rerunning are CWE-050 coordination behind fresh CWE-049 run
 *   authorizations; this layer never creates a session or a task and
 *   never inherits an earlier approval.
 *
 * Recursion guard (Section 20.4, T096): council-generated work is
 * tagged with its source session, and the council capability cannot
 * invoke itself from its own drafts, approvals, outcome reminders,
 * scan proposals, or scheduled reviews. A convene or rerun request
 * carrying such an origin is BLOCKED unless it carries a separately
 * authorized need with an authorization evidence reference; the block
 * is a visible outcome, never a silent drop.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import type { CouncilPrincipal } from '../auth';
import type { SeatId } from '../contracts';
import { CouncilRepositories } from '../store';
import {
  assertKanbanSessionNotDeleted,
  authorizeKanbanOperation,
  type KanbanAuthOptions,
} from '../kanban/context';
import { appendKanbanJournalEvent } from '../kanban/journal';
import { CouncilScanQueue } from '../kanban/scan-queue';
import { CouncilIntentError } from './errors';
import {
  classifyCouncilIntent,
  type CouncilIntentClassification,
} from './registry';

export type CouncilIntentOriginKind =
  | 'user'
  | 'department'
  | 'ceo'
  | 'council_generated'
  | 'scan_proposal'
  | 'scheduled_review'
  | 'outcome_reminder';

/** Provenance a caller stamps on a request (Section 20.4 tagging). */
export interface CouncilIntentOrigin {
  kind: CouncilIntentOriginKind;
  source_session_id?: string | null;
  source_task_id?: string | null;
  source_department_id?: string | null;
  /** The artifact the request was derived from, when it was derived from one. */
  artifact_kind?: 'draft' | 'approval' | 'outcome_reminder' | 'report' | null;
  /** A separately authorized need, attested by the caller (T096). */
  separately_authorized_need?: boolean;
  /** Evidence reference for that separate authorization. */
  authorization_evidence_ref?: string | null;
}

export interface CouncilIntentRequest {
  text: string;
  session_id?: string | null;
  origin?: CouncilIntentOrigin;
}

export type CouncilIntentOutcome =
  | {
      kind: 'no_intent';
      creates_task: false;
      creates_session: false;
    }
  | {
      kind: 'session_command';
      command: 'stop' | 'cancel' | 'pause' | 'resume';
      session_id: string;
      resolution: 'resolve_existing_session_via_trusted_api';
      creates_task: false;
      creates_session: false;
    }
  | {
      kind: 'unresolved';
      reason: string;
      creates_task: false;
      creates_session: false;
    }
  | {
      kind: 'blocked';
      reason: 'recursive_council_requires_separate_authorization';
      detail: string;
      creates_task: false;
      creates_session: false;
    }
  | {
      kind: 'not_found';
      what: 'verdict' | 'objection';
      session_id: string;
      creates_task: false;
      creates_session: false;
    }
  | {
      kind: 'verdict_read';
      session_id: string;
      verdict_id: string;
      label: string | null;
      result_kind: string | null;
      verdict_revision: number | null;
      main_reasons: string[];
      decided_at: string;
      creates_task: false;
      creates_session: false;
    }
  | {
      kind: 'objection_read';
      session_id: string;
      seat_id: SeatId | null;
      objection: string;
      source: 'advisor_card' | 'verdict_strongest_dissent';
      creates_task: false;
      creates_session: false;
    }
  | {
      kind: 'consult_request';
      consult: {
        purpose: 'consult' | 'follow_up';
        seat_id: SeatId | null;
        question: string;
        source_session_id: string | null;
        requires: string[];
      };
      creates_task: false;
      creates_session: false;
    }
  | {
      kind: 'convene_request';
      request: {
        mode: 'full_council';
        brief_text: string;
        source_session_id: string | null;
        source_task_id: string | null;
        source_department_id: string | null;
        separately_authorized_need: boolean;
        requires: string[];
      };
      creates_task: false;
      creates_session: false;
    }
  | {
      kind: 'rerun_request';
      request: {
        source_session_id: string;
        requires: string[];
      };
      creates_task: false;
      creates_session: false;
    };

export interface CouncilIntentDispatcherDeps {
  repositories?: CouncilRepositories;
  db?: Database.Database;
  scanQueue?: CouncilScanQueue;
  now?: () => string;
  newId?: () => string;
}

const SELF_INVOKING_ORIGINS: ReadonlySet<CouncilIntentOriginKind> = new Set([
  'council_generated',
  'scan_proposal',
  'scheduled_review',
  'outcome_reminder',
]);

const SELF_INVOKING_ARTIFACTS: ReadonlySet<string> = new Set([
  'draft',
  'approval',
  'outcome_reminder',
]);

/**
 * The T096 recursion guard. Returns a block detail when a convene or
 * rerun request originates from the council's own outputs without a
 * separately authorized need on record; null when it may proceed.
 */
export function recursionBlockDetail(origin: CouncilIntentOrigin | undefined): string | null {
  if (!origin) return null;
  const selfInvoking =
    SELF_INVOKING_ORIGINS.has(origin.kind) ||
    (origin.artifact_kind != null && SELF_INVOKING_ARTIFACTS.has(origin.artifact_kind));
  if (!selfInvoking) return null;
  const authorized =
    origin.separately_authorized_need === true &&
    typeof origin.authorization_evidence_ref === 'string' &&
    origin.authorization_evidence_ref.trim() !== '';
  if (authorized) return null;
  return (
    'This request originates from council-generated material (its own drafts, approvals, ' +
    'outcome reminders, scan proposals, or scheduled reviews). The council capability cannot ' +
    'invoke itself from those outputs; a new council requires a separately authorized need ' +
    'with an authorization evidence reference (Section 20.4).'
  );
}

export class CouncilIntentDispatcher {
  private readonly repositories: CouncilRepositories;
  private readonly db: Database.Database;
  private readonly scanQueue: CouncilScanQueue;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(deps: CouncilIntentDispatcherDeps = {}) {
    this.db = deps.db ?? getDb();
    this.repositories = deps.repositories ?? new CouncilRepositories();
    this.scanQueue =
      deps.scanQueue ?? new CouncilScanQueue({ repositories: this.repositories, db: this.db });
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  async dispatch(
    principal: CouncilPrincipal,
    request: CouncilIntentRequest,
    auth?: KanbanAuthOptions,
  ): Promise<CouncilIntentOutcome> {
    const classification = classifyCouncilIntent(request.text ?? '');
    const origin = request.origin;
    const explicitSessionId = request.session_id ?? origin?.source_session_id ?? null;

    switch (classification.intent) {
      case 'none':
        return { kind: 'no_intent', creates_task: false, creates_session: false };
      case 'session_control':
        return this.dispatchControl(principal, request, auth);
      case 'read_result':
        return this.dispatchVerdictRead(principal, explicitSessionId, classification, auth);
      case 'explain_objection':
        if (classification.requires_inference) {
          return this.consultRequest(classification, request, explicitSessionId, principal, auth);
        }
        return this.dispatchObjectionRead(principal, explicitSessionId, classification, auth);
      case 'consult_seat':
      case 'follow_up':
        return this.consultRequest(classification, request, explicitSessionId, principal, auth);
      case 'rerun_session': {
        const blocked = recursionBlockDetail(origin);
        if (blocked) {
          return { kind: 'blocked', reason: 'recursive_council_requires_separate_authorization', detail: blocked, creates_task: false, creates_session: false };
        }
        if (!explicitSessionId) {
          throw new CouncilIntentError(
            'COUNCIL_INTENT_SESSION_REQUIRED',
            'A rerun request must name the source session it reruns.',
          );
        }
        const { scope } = authorizeKanbanOperation(this.db, principal, explicitSessionId, 'read', 'read', auth);
        assertKanbanSessionNotDeleted(this.repositories, principal, explicitSessionId);
        this.journalIntent(principal, scope, explicitSessionId, classification, 'rerun_request');
        return {
          kind: 'rerun_request',
          request: {
            source_session_id: explicitSessionId,
            requires: [
              'a fresh council-run authorization for the rerun (CWE-049); the original approval never carries over',
              'CWE-050 rerun coordination behind council.sessions.rerun',
            ],
          },
          creates_task: false,
          creates_session: false,
        };
      }
      case 'convene_council': {
        const blocked = recursionBlockDetail(origin);
        if (blocked) {
          return { kind: 'blocked', reason: 'recursive_council_requires_separate_authorization', detail: blocked, creates_task: false, creates_session: false };
        }
        return {
          kind: 'convene_request',
          request: {
            mode: 'full_council',
            brief_text: request.text,
            source_session_id: origin?.source_session_id ?? null,
            source_task_id: origin?.source_task_id ?? null,
            source_department_id: origin?.source_department_id ?? null,
            separately_authorized_need: origin?.separately_authorized_need === true,
            requires: [
              'session creation through the CWE-006 store (draft only at creation)',
              'a council-run authorization (CWE-049) before the session runs',
            ],
          },
          creates_task: false,
          creates_session: false,
        };
      }
    }
  }

  /** Controls resolve the existing session first and create nothing. */
  private async dispatchControl(
    principal: CouncilPrincipal,
    request: CouncilIntentRequest,
    auth?: KanbanAuthOptions,
  ): Promise<CouncilIntentOutcome> {
    const resolution = await this.scanQueue.resolveBoardCommand(
      principal,
      { text: request.text, session_id: request.session_id ?? request.origin?.source_session_id ?? null },
      auth,
    );
    if (resolution.kind === 'session_command') {
      return {
        kind: 'session_command',
        command: resolution.command,
        session_id: resolution.session_id,
        resolution: resolution.resolution,
        creates_task: false,
        creates_session: false,
      };
    }
    return { kind: 'unresolved', reason: resolution.reason, creates_task: false, creates_session: false };
  }

  private async dispatchVerdictRead(
    principal: CouncilPrincipal,
    sessionId: string | null,
    classification: CouncilIntentClassification,
    auth?: KanbanAuthOptions,
  ): Promise<CouncilIntentOutcome> {
    if (!sessionId) {
      throw new CouncilIntentError(
        'COUNCIL_INTENT_SESSION_REQUIRED',
        'Reading a verdict requires the session whose verdict is being read.',
      );
    }
    const { scope } = authorizeKanbanOperation(this.db, principal, sessionId, 'read', 'read', auth);
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const row = this.db
      .prepare(
        `SELECT id, brief_revision, label, verdict_json, created_at
           FROM council_verdicts
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?
          ORDER BY brief_revision DESC LIMIT 1`,
      )
      .get(scope.tenant_id, scope.company_id, sessionId) as
      | { id: string; brief_revision: number; label: string; verdict_json: string; created_at: string }
      | undefined;
    if (!row) {
      return { kind: 'not_found', what: 'verdict', session_id: sessionId, creates_task: false, creates_session: false };
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(row.verdict_json) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    this.journalIntent(principal, scope, sessionId, classification, 'verdict_read');
    return {
      kind: 'verdict_read',
      session_id: sessionId,
      verdict_id: row.id,
      label: row.label,
      result_kind: typeof parsed.result_kind === 'string' ? parsed.result_kind : null,
      verdict_revision:
        typeof parsed.verdict_revision === 'number' ? parsed.verdict_revision : row.brief_revision,
      main_reasons: Array.isArray(parsed.main_reasons)
        ? parsed.main_reasons.filter((reason): reason is string => typeof reason === 'string')
        : [],
      decided_at: row.created_at,
      creates_task: false,
      creates_session: false,
    };
  }

  private async dispatchObjectionRead(
    principal: CouncilPrincipal,
    sessionId: string | null,
    classification: CouncilIntentClassification,
    auth?: KanbanAuthOptions,
  ): Promise<CouncilIntentOutcome> {
    if (!sessionId) {
      throw new CouncilIntentError(
        'COUNCIL_INTENT_SESSION_REQUIRED',
        'Retrieving a recorded objection requires the session it was recorded in.',
      );
    }
    const { scope } = authorizeKanbanOperation(this.db, principal, sessionId, 'read', 'read', auth);
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);

    if (classification.seat_id) {
      const cardRow = this.db
        .prepare(
          `SELECT card_json FROM council_cards
            WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND seat_id = ? AND kind = 'advisor'
            ORDER BY round DESC LIMIT 1`,
        )
        .get(scope.tenant_id, scope.company_id, sessionId, classification.seat_id) as
        | { card_json: string }
        | undefined;
      if (cardRow) {
        try {
          const card = JSON.parse(cardRow.card_json) as Record<string, unknown>;
          if (typeof card.strongest_objection === 'string' && card.strongest_objection.trim() !== '') {
            this.journalIntent(principal, scope, sessionId, classification, 'objection_read');
            return {
              kind: 'objection_read',
              session_id: sessionId,
              seat_id: classification.seat_id,
              objection: card.strongest_objection,
              source: 'advisor_card',
              creates_task: false,
              creates_session: false,
            };
          }
        } catch {
          // Fall through to the visible not_found outcome below.
        }
      }
      return { kind: 'not_found', what: 'objection', session_id: sessionId, creates_task: false, creates_session: false };
    }

    const verdictRow = this.db
      .prepare(
        `SELECT verdict_json FROM council_verdicts
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?
          ORDER BY brief_revision DESC LIMIT 1`,
      )
      .get(scope.tenant_id, scope.company_id, sessionId) as { verdict_json: string } | undefined;
    if (verdictRow) {
      try {
        const verdict = JSON.parse(verdictRow.verdict_json) as Record<string, unknown>;
        if (typeof verdict.strongest_dissent === 'string' && verdict.strongest_dissent.trim() !== '') {
          this.journalIntent(principal, scope, sessionId, classification, 'objection_read');
          return {
            kind: 'objection_read',
            session_id: sessionId,
            seat_id: null,
            objection: verdict.strongest_dissent,
            source: 'verdict_strongest_dissent',
            creates_task: false,
            creates_session: false,
          };
        }
      } catch {
        // Fall through to the visible not_found outcome below.
      }
    }
    return { kind: 'not_found', what: 'objection', session_id: sessionId, creates_task: false, creates_session: false };
  }

  /**
   * A consult or follow-up is a REQUEST descriptor linked to its
   * source session. Running it stays behind a fresh purpose-bound
   * CWE-049 authorization and CWE-050 coordination; nothing here
   * creates a session.
   */
  private async consultRequest(
    classification: CouncilIntentClassification,
    request: CouncilIntentRequest,
    sourceSessionId: string | null,
    principal: CouncilPrincipal,
    auth?: KanbanAuthOptions,
  ): Promise<CouncilIntentOutcome> {
    const purpose: 'consult' | 'follow_up' =
      classification.intent === 'follow_up' || sourceSessionId ? 'follow_up' : 'consult';
    if (sourceSessionId) {
      const { scope } = authorizeKanbanOperation(this.db, principal, sourceSessionId, 'read', 'read', auth);
      assertKanbanSessionNotDeleted(this.repositories, principal, sourceSessionId);
      this.journalIntent(principal, scope, sourceSessionId, classification, 'consult_request');
    }
    return {
      kind: 'consult_request',
      consult: {
        purpose,
        seat_id: classification.seat_id,
        question: request.text,
        source_session_id: sourceSessionId,
        requires: [
          'a fresh purpose-bound run authorization (CWE-049) for the follow_up purpose',
          'CWE-050 follow-up coordination behind council.sessions.follow_up',
        ],
      },
      creates_task: false,
      creates_session: false,
    };
  }

  /** Every session-bound resolution is journaled on that session. */
  private journalIntent(
    principal: CouncilPrincipal,
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    classification: CouncilIntentClassification,
    outcomeKind: string,
  ): void {
    this.db
      .transaction(() => {
        appendKanbanJournalEvent(this.db, scope, sessionId, {
          eventId: this.newId(),
          actorSubject: principal.subject,
          action: 'intent_resolved',
          createdAt: this.now(),
          data: {
            capability_id: 'council-of-wise-elders',
            intent: classification.intent,
            matched: classification.matched,
            seat_id: classification.seat_id,
            outcome: outcomeKind,
            creates_task: false,
            creates_session: false,
            authorization: { permission: 'read' },
          },
        });
      })
      .immediate();
  }
}
