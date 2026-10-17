/**
 * CWE-035 canonical parent task adapter (Sections 17.6, 19.2, 19.3).
 *
 * Exactly ONE parent task exists per COMPANY council session, titled
 * "Council review: [decision title]". Identity is the company-scoped
 * task-request fingerprint (Section 19 warns the title-similarity dedup
 * window is insufficient, and it is never used here): repeat and
 * concurrent calls link the same parent through createTaskCore's
 * idempotency triple and the council_kanban_links unique constraint.
 * PRIVATE sessions create NO board task at all (Section 17.6).
 *
 * The parent is born in Being Prepared (backlog) behind the
 * council_plan_assembling routing hold, with no assigned agent: the
 * generic dispatcher cannot execute it (autoDispatchTask GUARD 1 holds
 * agentless tasks, the intent sweep requires an agent, the intake
 * sweep excludes held tasks, execution attempts refuse held tasks).
 * The card names the dedicated `council_session` handler, so the board
 * never treats it as ordinary department work. Registering 'council' in
 * the dispatcher's engine-owned source lists is the named CWE-050 host
 * wiring step (see the CWE-035 build report).
 *
 * Parent state changes go ONLY through task-lifecycle transition()
 * (Section 19.2 readiness mapping is CWE-038's contract; this adapter
 * performs the writes): deliberation maps to In Progress, a validated
 * verdict to Review, a delivered advisory to Done. The lifecycle
 * requires an assigned agent for the 'assigned' and 'in_progress'
 * states; the parent must never gain one (an assignee is what would
 * let the generic dispatcher execute it), so those two steps use the
 * lifecycle's operatorOverride, which by the lifecycle's own design
 * waives ONLY routing and assignment preconditions. The fact gates sit
 * above that bail-out and still bind: Review and Done remain
 * completion-evidence gated, and that gate is surfaced as a typed
 * blocked result, never forced.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { createTaskCore } from '@/lib/tasks';
import { taskRequestFingerprint } from '@/lib/task-request-identity';
import {
  LEGAL_TRANSITIONS,
  TransitionError,
  transition,
  type LifecycleState,
} from '@/lib/task-lifecycle';
import type { CouncilPrincipal } from '../auth';
import { CouncilRepositories } from '../store';
import {
  COUNCIL_PLAN_ASSEMBLING_HOLD,
  COUNCIL_SESSION_HANDLER,
  COUNCIL_TASK_SOURCE,
  councilParentOperationId,
  councilSourceSessionTag,
} from './constants';
import {
  assertKanbanSessionNotDeleted,
  authorizeKanbanOperation,
  isPrivateSessionRow,
  kanbanEnvelope,
  type KanbanAuthOptions,
} from './context';
import { CouncilKanbanError } from './errors';
import {
  COUNCIL_CHAIR_GOVERNANCE_PERSONA_ID,
  COUNCIL_DELIBERATION_SOP_NAME,
  COUNCIL_DELIBERATION_SOP_SLUG,
  ensureCouncilDeliberationSop,
} from './governance';
import { appendKanbanJournalEvent } from './journal';
import { withKeyedLock } from './mutex';

export type ParentTaskResult =
  | { kind: 'linked'; task_id: string; created: boolean; title: string; status: string }
  | { kind: 'none'; reason: 'private_session' | 'not_created' };

export type ParentPhase =
  | 'session_started'
  | 'deliberating'
  | 'verdict_validated'
  | 'advisory_delivered'
  | 'session_blocked'
  | 'session_resumed';

const PHASE_TARGETS: Record<ParentPhase, LifecycleState | null> = {
  session_started: null,
  deliberating: 'in_progress',
  verdict_validated: 'review',
  advisory_delivered: 'done',
  session_blocked: 'blocked',
  session_resumed: 'in_progress',
};

export type ParentProjectionResult =
  | { kind: 'projected'; task_id: string; status: LifecycleState; path: LifecycleState[] }
  | { kind: 'already'; task_id: string; status: LifecycleState }
  | {
      kind: 'blocked';
      task_id: string;
      status: LifecycleState;
      target: LifecycleState;
      reason: 'completion_evidence_required' | 'wip_limit' | 'no_legal_transition_path' | 'cas_conflict';
    }
  | { kind: 'none'; reason: 'private_session' };

export interface CouncilParentTaskDeps {
  repositories?: CouncilRepositories;
  db?: Database.Database;
  now?: () => string;
  newId?: () => string;
}

interface KanbanLinkRow {
  parent_task_id: string;
  board_ref: string | null;
  column_ref: string | null;
  operation_id: string;
}

/** "Council review: [decision title]" from the frozen brief question. */
export function councilParentTitle(question: string): string {
  const clean = question.replace(/\s+/g, ' ').trim();
  const prefix = 'Council review: ';
  const room = 180 - prefix.length;
  const body = clean.length > room ? `${clean.slice(0, room - 1).trimEnd()}…` : clean;
  return `${prefix}${body}`;
}

function findLegalPath(from: LifecycleState, to: LifecycleState): LifecycleState[] | null {
  if (from === to) return [];
  const visited = new Set<LifecycleState>([from]);
  const queue: Array<{ state: LifecycleState; path: LifecycleState[] }> = [
    { state: from, path: [] },
  ];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of LEGAL_TRANSITIONS[current.state]) {
      if (visited.has(next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      visited.add(next);
      queue.push({ state: next, path });
    }
  }
  return null;
}

export class CanonicalParentTaskAdapter {
  private readonly repositories: CouncilRepositories;
  private readonly db: Database.Database;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(deps: CouncilParentTaskDeps = {}) {
    this.db = deps.db ?? getDb();
    this.repositories = deps.repositories ?? new CouncilRepositories();
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  private linkRow(scope: { tenant_id: string; company_id: string }, sessionId: string): KanbanLinkRow | null {
    const row = this.db
      .prepare(
        `SELECT parent_task_id, board_ref, column_ref, operation_id
           FROM council_kanban_links
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?`,
      )
      .get(scope.tenant_id, scope.company_id, sessionId) as KanbanLinkRow | undefined;
    return row ?? null;
  }

  private taskRow(taskId: string): { id: string; title: string; status: string } | null {
    const row = this.db
      .prepare('SELECT id, title, status FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; title: string; status: string } | undefined;
    return row ?? null;
  }

  /**
   * Create or link the session's single canonical parent task.
   * Company sessions only; private sessions return { kind: 'none' } and
   * no task is created, linked, or journaled as board work.
   */
  async ensureParentTask(
    principal: CouncilPrincipal,
    sessionId: string,
    auth?: KanbanAuthOptions,
  ): Promise<ParentTaskResult> {
    const { row, scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'create_tasks',
      'mutate',
      auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const lockKey = `${scope.tenant_id}:${scope.company_id}:${sessionId}:parent`;
    return withKeyedLock(lockKey, async () => {
      if (isPrivateSessionRow(row)) {
        return { kind: 'none', reason: 'private_session' } as ParentTaskResult;
      }
      const existing = this.linkRow(scope, sessionId);
      if (existing) {
        const task = this.taskRow(existing.parent_task_id);
        if (task) {
          return {
            kind: 'linked',
            task_id: task.id,
            created: false,
            title: task.title,
            status: task.status,
          } as ParentTaskResult;
        }
      }
      const envelope = kanbanEnvelope(principal, scope, 'write');
      const stored = this.repositories.getSession(envelope, sessionId);
      if (!stored) {
        throw new CouncilKanbanError(
          'COUNCIL_SESSION_NOT_FOUND',
          `Council session ${sessionId} is not visible in the caller's scope.`,
          404,
        );
      }
      const sop = ensureCouncilDeliberationSop(this.db, this.now());
      const title = councilParentTitle(stored.brief.question);
      const operationId = councilParentOperationId(sessionId);
      const fingerprint = taskRequestFingerprint({
        kind: 'council_parent_task',
        tenant_id: scope.tenant_id,
        company_id: scope.company_id,
        session_id: sessionId,
        title,
      });
      const description = [
        councilSourceSessionTag(sessionId),
        `Handler: ${COUNCIL_SESSION_HANDLER}`,
        `Session: /council/sessions/${sessionId}`,
        `Decision: ${stored.brief.question}`,
        `Mode: ${stored.spec.mode} | Seats: ${stored.spec.seat_ids.join(', ')}`,
        `Required SOP: ${COUNCIL_DELIBERATION_SOP_NAME} (${COUNCIL_DELIBERATION_SOP_SLUG})`,
        `Governance persona: ${COUNCIL_CHAIR_GOVERNANCE_PERSONA_ID}`,
        'This card is the single board projection of the council session. ' +
          'It is prepared and advanced by the council service only; it is never ' +
          'dispatched to a department agent.',
      ].join('\n');
      const result = await createTaskCore({
        title,
        description,
        source: COUNCIL_TASK_SOURCE,
        sop_id: sop.sop_id,
        routing_hold_reason: COUNCIL_PLAN_ASSEMBLING_HOLD,
        idempotency_company_id: scope.company_id,
        idempotency_key: operationId,
        idempotency_payload_hash: fingerprint,
        skipWindowDedup: true,
      });
      if (!result) {
        throw new CouncilKanbanError(
          'COUNCIL_PARENT_CREATE_FAILED',
          `createTaskCore did not return a parent task for council session ${sessionId}.`,
          500,
        );
      }
      const task = result.task;
      const createdAt = this.now();
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO council_kanban_links
               (tenant_id, company_id, session_id, id, parent_task_id, board_ref, column_ref, operation_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            scope.tenant_id,
            scope.company_id,
            sessionId,
            this.newId(),
            task.id,
            'tasks',
            task.status,
            operationId,
            createdAt,
          );
        appendKanbanJournalEvent(this.db, scope, sessionId, {
          eventId: this.newId(),
          actorSubject: principal.subject,
          action: 'parent_linked',
          createdAt,
          data: {
            task_id: task.id,
            operation_id: operationId,
            created: !result.deduped,
            sop_id: sop.sop_id,
            authorization: { permission: 'create_tasks' },
          },
        });
      }).immediate();
      const link = this.linkRow(scope, sessionId);
      const linkedTask = link ? this.taskRow(link.parent_task_id) : null;
      return {
        kind: 'linked',
        task_id: link?.parent_task_id ?? task.id,
        created: !result.deduped && (link?.parent_task_id ?? task.id) === task.id,
        title: linkedTask?.title ?? title,
        status: linkedTask?.status ?? task.status,
      } as ParentTaskResult;
    });
  }

  /** Read the session's parent link without creating anything. */
  async getParentTask(
    principal: CouncilPrincipal,
    sessionId: string,
    auth?: KanbanAuthOptions,
  ): Promise<ParentTaskResult> {
    const { row, scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'read',
      'read',
      auth,
    );
    if (isPrivateSessionRow(row)) return { kind: 'none', reason: 'private_session' };
    const link = this.linkRow(scope, sessionId);
    if (!link) return { kind: 'none', reason: 'not_created' };
    const task = this.taskRow(link.parent_task_id);
    if (!task) return { kind: 'none', reason: 'not_created' };
    return { kind: 'linked', task_id: task.id, created: false, title: task.title, status: task.status };
  }

  /**
   * Advance the parent through the Section 19.2 readiness mapping using
   * ONLY task-lifecycle transition() calls (compare-and-swap on the
   * observed status). Evidence-gated targets (Review, Done) surface the
   * lifecycle's own refusal as a typed blocked result.
   */
  async projectParentPhase(
    principal: CouncilPrincipal,
    sessionId: string,
    phase: ParentPhase,
    auth?: KanbanAuthOptions,
  ): Promise<ParentProjectionResult> {
    const ensured = await this.ensureParentTask(principal, sessionId, auth);
    if (ensured.kind === 'none') return { kind: 'none', reason: 'private_session' };
    const target = PHASE_TARGETS[phase];
    const taskId = ensured.task_id;
    if (target === null) {
      const task = this.taskRow(taskId);
      return { kind: 'already', task_id: taskId, status: (task?.status ?? 'backlog') as LifecycleState };
    }
    const { scope } = authorizeKanbanOperation(this.db, principal, sessionId, 'create_tasks', 'mutate', auth);
    const task = this.taskRow(taskId);
    if (!task) {
      throw new CouncilKanbanError(
        'COUNCIL_PARENT_CREATE_FAILED',
        `Parent task ${taskId} for council session ${sessionId} is missing.`,
        500,
      );
    }
    const from = task.status as LifecycleState;
    if (from === target) {
      return { kind: 'already', task_id: taskId, status: from };
    }
    const path = findLegalPath(from, target);
    if (!path) {
      return { kind: 'blocked', task_id: taskId, status: from, target, reason: 'no_legal_transition_path' };
    }
    let current = from;
    for (const step of path) {
      try {
        await transition(taskId, step, {
          actor: 'council-kanban-projection',
          reason: `Council parent projection: ${phase}`,
          expectedFrom: current,
          // The parent is advanced by the council service and must
          // never carry an assigned agent; the override waives only
          // the assignment precondition on the two agent-gated states.
          // Completion-evidence and process-certificate gates are
          // checked above the override bail-out and are NOT waived.
          operatorOverride: step === 'assigned' || step === 'in_progress',
        });
      } catch (err) {
        if (err instanceof TransitionError && err.code === 'PRECONDITION_EVIDENCE') {
          this.journalProjection(scope, principal, sessionId, {
            phase,
            outcome: 'blocked',
            reason: 'completion_evidence_required',
            from_status: current,
            target_status: target,
          });
          return {
            kind: 'blocked',
            task_id: taskId,
            status: current,
            target,
            reason: 'completion_evidence_required',
          };
        }
        if (err instanceof TransitionError && err.code === 'WIP_LIMIT') {
          return { kind: 'blocked', task_id: taskId, status: current, target, reason: 'wip_limit' };
        }
        if (err instanceof TransitionError && err.code === 'CAS_CONFLICT') {
          const fresh = this.taskRow(taskId);
          const freshStatus = (fresh?.status ?? current) as LifecycleState;
          if (freshStatus === target) return { kind: 'already', task_id: taskId, status: freshStatus };
          return { kind: 'blocked', task_id: taskId, status: freshStatus, target, reason: 'cas_conflict' };
        }
        throw err;
      }
      current = step;
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE council_kanban_links SET column_ref = ?
            WHERE tenant_id = ? AND company_id = ? AND session_id = ?`,
        )
        .run(target, scope.tenant_id, scope.company_id, sessionId);
      this.journalProjection(scope, principal, sessionId, {
        phase,
        outcome: 'projected',
        from_status: from,
        target_status: target,
        path,
      });
    }).immediate();
    return { kind: 'projected', task_id: taskId, status: target, path };
  }

  private journalProjection(
    scope: { tenant_id: string; company_id: string },
    principal: CouncilPrincipal,
    sessionId: string,
    data: Record<string, unknown>,
  ): void {
    appendKanbanJournalEvent(this.db, scope, sessionId, {
      eventId: this.newId(),
      actorSubject: principal.subject,
      action: 'parent_projected',
      createdAt: this.now(),
      data: { ...data, authorization: { permission: 'create_tasks' } },
    });
  }
}
