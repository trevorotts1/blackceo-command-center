/**
 * CWE-037 completion-time scan trigger (Sections 20, 20.4, 24, 31).
 *
 * When a council session's work completes, this trigger derives
 * follow-up candidates from the session's RECORDED state only and
 * enqueues them onto CWE-035's CouncilScanQueue with source-session
 * provenance. Processing a queued item creates at most a PROPOSAL
 * record, never a task (that guarantee is the queue's). The trigger
 * itself creates no task, no plan, and no session, and it bypasses
 * none of the four authorizations: derivation runs under the caller's
 * 'read' authorization and the enqueue under the queue's own
 * 'create_tasks' authorization.
 *
 * Candidate sources, all recorded state:
 * - Release refusals recorded by recordReleaseOutcomes (the
 *   composition hook for CWE-036's releaseReadyTasks onTask callback):
 *   each narration carries the decision's per-task refusal reasons
 *   verbatim.
 * - Verdict action proposals that never entered any action plan row.
 * - Plan conditions with no committed verification evidence in the
 *   session journal (the CWE-036 guard's condition_verified records).
 * - One outcome-review candidate per verdict revision, deduplicated
 *   by decision and review period (Section 20.4): the dedupe key
 *   binds session, verdict revision, and the run's calendar period.
 *
 * Deduplication: every candidate carries a stable dedupe key in its
 * evidence references. A scan run skips any candidate whose key is
 * already on record in the session journal (pending or processed),
 * and journals a completion_scan_recorded entry naming what it
 * enqueued and what it skipped, so re-running a trigger is a visible
 * no-op rather than a duplicate flood.
 *
 * Honesty: a summary is composed only from recorded fields. A
 * condition whose description was never recorded is narrated by id
 * and verification state only; nothing is invented to fill the gap.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import type { CouncilPrincipal } from '../auth';
import { CouncilRepositories } from '../store';
import {
  assertKanbanSessionNotDeleted,
  authorizeKanbanOperation,
  loadKanbanSessionRow,
  type KanbanAuthOptions,
} from '../kanban/context';
import {
  appendKanbanJournalEvent,
  listKanbanJournalEntries,
} from '../kanban/journal';
import {
  CouncilScanQueue,
  type CouncilScanItem,
  type CouncilScanItemInput,
} from '../kanban/scan-queue';
import type { TaskReleaseOutcome } from '../kanban/action-execution';
import { CouncilIntentError } from './errors';

export type CompletionScanTrigger = 'completion' | 'scheduled_review' | 'manual';

export interface CompletionScanResult {
  session_id: string;
  trigger: CompletionScanTrigger;
  verdict_revision: number | null;
  verdict_label: string | null;
  /** Items this run enqueued, in queue order. */
  enqueued: CouncilScanItem[];
  /** Candidates this run skipped because their dedupe key is on record. */
  skipped: Array<{ dedupe_key: string; candidate_kind: string }>;
  /** Plain-language narration composed from the recorded state. */
  narration: string;
  creates_task: false;
}

export interface CouncilCompletionScannerDeps {
  repositories?: CouncilRepositories;
  db?: Database.Database;
  scanQueue?: CouncilScanQueue;
  now?: () => string;
  newId?: () => string;
}

interface VerdictRow {
  id: string;
  brief_revision: number;
  label: string;
  verdict_json: string;
  created_at: string;
}

interface DerivedCandidate extends CouncilScanItemInput {
  dedupe_key: string;
}

const DEDUPE_REF_PREFIX = 'dedupe:';
const MAX_SUMMARY_CHARS = 3_500;

function capSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_CHARS) return summary;
  return `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export class CouncilCompletionScanner {
  private readonly repositories: CouncilRepositories;
  private readonly db: Database.Database;
  private readonly scanQueue: CouncilScanQueue;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(deps: CouncilCompletionScannerDeps = {}) {
    this.db = deps.db ?? getDb();
    this.repositories = deps.repositories ?? new CouncilRepositories();
    this.scanQueue =
      deps.scanQueue ?? new CouncilScanQueue({ repositories: this.repositories, db: this.db });
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  /**
   * The composition hook for CWE-036's releaseReadyTasks onTask
   * callback: record each REFUSED release decision into the session
   * journal, with the decision's reasons verbatim, so the completion
   * scan can narrate from recorded state instead of re-evaluating
   * under a different authorization context. Recording is idempotent
   * per operation and plan hash. Returns what was recorded.
   */
  async recordReleaseOutcomes(
    principal: CouncilPrincipal,
    sessionId: string,
    outcomes: TaskReleaseOutcome[],
    auth?: KanbanAuthOptions,
  ): Promise<{ recorded: number; skipped: number }> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'execute',
      'mutate',
      auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const existing = new Set(
      listKanbanJournalEntries(this.db, scope, sessionId)
        .filter((entry) => entry.action === 'release_outcome_recorded')
        .map(
          (entry) =>
            `${String(entry.payload.operation_id ?? '')}:${String(entry.payload.plan_hash ?? '')}`,
        ),
    );
    let recorded = 0;
    let skipped = 0;
    const recordedAt = this.now();
    this.db
      .transaction(() => {
        for (const outcome of outcomes) {
          if (outcome.released || outcome.already_released) {
            skipped += 1;
            continue;
          }
          const key = `${outcome.decision.operation_id}:${outcome.decision.plan_hash}`;
          if (existing.has(key)) {
            skipped += 1;
            continue;
          }
          existing.add(key);
          appendKanbanJournalEvent(this.db, scope, sessionId, {
            eventId: this.newId(),
            actorSubject: principal.subject,
            action: 'release_outcome_recorded',
            createdAt: recordedAt,
            data: {
              plan_id: outcome.decision.plan_id,
              plan_hash: outcome.decision.plan_hash,
              action_id: outcome.decision.action_id,
              task_id: outcome.decision.task_id,
              operation_id: outcome.decision.operation_id,
              releasable: false,
              grant_status: outcome.decision.grant_status,
              checks: outcome.decision.checks,
              reasons: outcome.decision.reasons,
              evaluated_at: outcome.decision.evaluated_at,
              authorization: { permission: 'execute' },
            },
          });
          recorded += 1;
        }
      })
      .immediate();
    return { recorded, skipped };
  }

  /**
   * Run the scan for one COMPLETED session. Fails visibly with
   * COUNCIL_SESSION_NOT_COMPLETED when the recorded state is not a
   * completed session: a trigger never scans a session whose work
   * has not finished.
   */
  async runCompletionScan(
    principal: CouncilPrincipal,
    sessionId: string,
    opts: { trigger?: CompletionScanTrigger; auth?: KanbanAuthOptions } = {},
  ): Promise<CompletionScanResult> {
    const trigger = opts.trigger ?? 'completion';
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'read',
      'read',
      opts.auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const row = loadKanbanSessionRow(this.db, principal, sessionId);
    if (row.state !== 'COMPLETED') {
      throw new CouncilIntentError(
        'COUNCIL_SESSION_NOT_COMPLETED',
        `Session ${sessionId} is in state ${row.state}; the completion scan runs only on a completed session.`,
        409,
        { state: row.state },
      );
    }

    const verdict = this.latestVerdict(scope, sessionId);
    const verdictJson = verdict ? asRecord(safeParse(verdict.verdict_json)) : {};
    const candidates = this.deriveCandidates(scope, sessionId, verdict, verdictJson);

    const recordedKeys = this.recordedDedupeKeys(scope, sessionId);
    const fresh: DerivedCandidate[] = [];
    const skipped: Array<{ dedupe_key: string; candidate_kind: string }> = [];
    for (const candidate of candidates) {
      if (recordedKeys.has(candidate.dedupe_key)) {
        skipped.push({
          dedupe_key: candidate.dedupe_key,
          candidate_kind: candidate.candidate_kind ?? 'follow_up_candidate',
        });
      } else {
        recordedKeys.add(candidate.dedupe_key);
        fresh.push(candidate);
      }
    }

    let enqueued: CouncilScanItem[] = [];
    if (fresh.length > 0) {
      enqueued = await this.scanQueue.enqueueScanItems(
        principal,
        sessionId,
        fresh.map(({ dedupe_key: _dedupeKey, ...item }) => item),
        opts.auth,
      );
    }

    const narration = this.narrate(sessionId, trigger, verdict, enqueued, skipped);
    const recordedAt = this.now();
    this.db
      .transaction(() => {
        appendKanbanJournalEvent(this.db, scope, sessionId, {
          eventId: this.newId(),
          actorSubject: principal.subject,
          action: 'completion_scan_recorded',
          createdAt: recordedAt,
          data: {
            trigger,
            session_state_version: row.state_version,
            verdict_id: verdict?.id ?? null,
            verdict_revision:
              typeof verdictJson.verdict_revision === 'number'
                ? verdictJson.verdict_revision
                : (verdict?.brief_revision ?? null),
            candidates_found: candidates.length,
            enqueued_scan_item_ids: enqueued.map((item) => item.scan_item_id),
            skipped_dedupe_keys: skipped.map((entry) => entry.dedupe_key),
            creates_task: false,
            authorization: { permission: 'create_tasks' },
          },
        });
      })
      .immediate();

    return {
      session_id: sessionId,
      trigger,
      verdict_revision:
        typeof verdictJson.verdict_revision === 'number'
          ? verdictJson.verdict_revision
          : (verdict?.brief_revision ?? null),
      verdict_label: verdict?.label ?? null,
      enqueued,
      skipped,
      narration,
      creates_task: false,
    };
  }

  // ------------------------------------------------------------ internals

  private latestVerdict(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
  ): VerdictRow | null {
    const row = this.db
      .prepare(
        `SELECT id, brief_revision, label, verdict_json, created_at
           FROM council_verdicts
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?
          ORDER BY brief_revision DESC LIMIT 1`,
      )
      .get(scope.tenant_id, scope.company_id, sessionId) as VerdictRow | undefined;
    return row ?? null;
  }

  private recordedDedupeKeys(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
  ): Set<string> {
    const keys = new Set<string>();
    for (const entry of listKanbanJournalEntries(this.db, scope, sessionId)) {
      if (entry.action !== 'scan_enqueued') continue;
      const item = asRecord(entry.payload.scan_item);
      for (const ref of stringArray(item.evidence_refs)) {
        if (ref.startsWith(DEDUPE_REF_PREFIX)) keys.add(ref.slice(DEDUPE_REF_PREFIX.length));
      }
    }
    return keys;
  }

  private deriveCandidates(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    verdict: VerdictRow | null,
    verdictJson: Record<string, unknown>,
  ): DerivedCandidate[] {
    const candidates: DerivedCandidate[] = [];
    const entries = listKanbanJournalEntries(this.db, scope, sessionId);

    // 1. Recorded release refusals, reasons verbatim (CWE-036 decisions).
    for (const entry of entries) {
      if (entry.action !== 'release_outcome_recorded') continue;
      const payload = entry.payload;
      const operationId = String(payload.operation_id ?? '');
      const planHash = String(payload.plan_hash ?? '');
      if (!operationId) continue;
      const taskId = String(payload.task_id ?? '');
      const taskRow = taskId
        ? (this.db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(taskId) as
            | { title: string }
            | undefined)
        : undefined;
      const reasons = stringArray(payload.reasons);
      const summary = capSummary(
        `Task "${taskRow?.title ?? taskId}" was not released after plan approval` +
          (reasons.length > 0 ? `: ${reasons.join(' ')}` : '. No refusal reasons were recorded.'),
      );
      candidates.push({
        candidate_kind: 'task_not_released',
        dedupe_key: `release:${operationId}:${planHash}`,
        summary,
        evidence_refs: [
          `${DEDUPE_REF_PREFIX}release:${operationId}:${planHash}`,
          `task:${taskId}`,
          'journal:release_outcome_recorded',
        ],
      });
    }

    // 2. Verdict action proposals that never entered any action plan.
    const plannedActionIds = new Set<string>();
    const planConditionIds = new Set<string>();
    const planRows = this.db
      .prepare(
        `SELECT actions_json FROM council_action_proposals
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?`,
      )
      .all(scope.tenant_id, scope.company_id, sessionId) as Array<{ actions_json: string }>;
    for (const planRow of planRows) {
      const actions = safeParse(planRow.actions_json);
      if (!Array.isArray(actions)) continue;
      for (const action of actions) {
        const record = asRecord(action);
        if (typeof record.action_id === 'string') plannedActionIds.add(record.action_id);
        for (const conditionId of stringArray(record.source_condition_ids)) {
          planConditionIds.add(conditionId);
        }
      }
    }
    if (verdict && verdictJson.result_kind === 'scored' && Array.isArray(verdictJson.action_proposals)) {
      for (const proposal of verdictJson.action_proposals) {
        const record = asRecord(proposal);
        const actionId = typeof record.action_id === 'string' ? record.action_id : null;
        if (!actionId || plannedActionIds.has(actionId)) continue;
        const title = typeof record.title === 'string' ? record.title : actionId;
        const rationale = typeof record.rationale === 'string' ? record.rationale : '';
        candidates.push({
          candidate_kind: 'unplanned_action',
          dedupe_key: `action:${sessionId}:${actionId}`,
          summary: capSummary(
            `The council proposed "${title}" but it was never placed in an action plan` +
              (rationale ? `: ${rationale}` : '.'),
          ),
          evidence_refs: [
            `${DEDUPE_REF_PREFIX}action:${sessionId}:${actionId}`,
            `verdict:${verdict.id}`,
            `action:${actionId}`,
          ],
        });
      }
    }

    // 3. Plan conditions with no committed verification evidence.
    if (planConditionIds.size > 0) {
      const verified = new Set<string>();
      for (const entry of entries) {
        if (entry.action !== 'condition_verified') continue;
        const status = entry.payload.status;
        if (status === 'satisfied' || status === 'waived_by_owner') {
          verified.add(String(entry.payload.condition_id ?? ''));
        }
      }
      const conditionFacts = this.conditionFacts(scope, sessionId);
      for (const conditionId of planConditionIds) {
        if (verified.has(conditionId)) continue;
        const facts = conditionFacts.get(conditionId);
        const summary = capSummary(
          `Condition ${conditionId}` +
            (facts?.description ? ` ("${facts.description}")` : '') +
            ' has no committed verification evidence in the session record' +
            (facts?.verification_method
              ? `; it was to be verified by: ${facts.verification_method}.`
              : '.'),
        );
        candidates.push({
          candidate_kind: 'unverified_condition',
          dedupe_key: `condition:${sessionId}:${conditionId}`,
          summary,
          evidence_refs: [
            `${DEDUPE_REF_PREFIX}condition:${sessionId}:${conditionId}`,
            `condition:${conditionId}`,
          ],
        });
      }
    }

    // 4. One outcome review per verdict revision and review period.
    if (verdict && verdictJson.result_kind === 'scored') {
      const revision =
        typeof verdictJson.verdict_revision === 'number'
          ? verdictJson.verdict_revision
          : verdict.brief_revision;
      const period = this.now().slice(0, 7);
      const reviewCriteria = stringArray(verdictJson.review_criteria);
      candidates.push({
        candidate_kind: 'outcome_review',
        dedupe_key: `review:${sessionId}:v${revision}:${period}`,
        summary: capSummary(
          `Outcome review for the council's ${verdict.label} decision (verdict revision ${revision})` +
            (reviewCriteria.length > 0
              ? `: check the recorded review criteria: ${reviewCriteria.join('; ')}`
              : ': no review criteria were recorded with the verdict.'),
        ),
        evidence_refs: [
          `${DEDUPE_REF_PREFIX}review:${sessionId}:v${revision}:${period}`,
          `verdict:${verdict.id}`,
        ],
      });
    }

    return candidates;
  }

  /** Condition descriptions and methods, from the recorded cards only. */
  private conditionFacts(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
  ): Map<string, { description: string; verification_method: string }> {
    const facts = new Map<string, { description: string; verification_method: string }>();
    const rows = this.db
      .prepare(
        `SELECT card_json FROM council_cards
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?`,
      )
      .all(scope.tenant_id, scope.company_id, sessionId) as Array<{ card_json: string }>;
    for (const row of rows) {
      const card = asRecord(safeParse(row.card_json));
      if (!Array.isArray(card.conditions)) continue;
      for (const condition of card.conditions) {
        const record = asRecord(condition);
        if (typeof record.id !== 'string' || facts.has(record.id)) continue;
        facts.set(record.id, {
          description: typeof record.description === 'string' ? record.description : '',
          verification_method:
            typeof record.verification_method === 'string' ? record.verification_method : '',
        });
      }
    }
    return facts;
  }

  private narrate(
    sessionId: string,
    trigger: CompletionScanTrigger,
    verdict: VerdictRow | null,
    enqueued: CouncilScanItem[],
    skipped: Array<{ dedupe_key: string; candidate_kind: string }>,
  ): string {
    const head = verdict
      ? `Session ${sessionId} completed with verdict ${verdict.label}.`
      : `Session ${sessionId} completed with no verdict on record.`;
    if (enqueued.length === 0) {
      return (
        `${head} The ${trigger} scan recorded no new follow-up candidates` +
        (skipped.length > 0
          ? `; ${skipped.length} candidate(s) were already on record and were deduplicated, not re-enqueued.`
          : '.') +
        ' A scan records proposals for review only; it creates no tasks.'
      );
    }
    const lines = enqueued.map((item) => `- [proposal candidate: ${item.candidate_kind}] ${item.summary}`);
    return (
      `${head} The ${trigger} scan enqueued ${enqueued.length} follow-up candidate(s) as proposals for review` +
      (skipped.length > 0 ? ` and deduplicated ${skipped.length} already-recorded candidate(s)` : '') +
      `:\n${lines.join('\n')}\n` +
      'Each item is a proposal only; no task is created unless an action plan is separately approved.'
    );
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
