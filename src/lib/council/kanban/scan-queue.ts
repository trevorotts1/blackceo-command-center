/**
 * CWE-035 post-session scan queue (Section 20).
 *
 * After a session, the follow-up scan looks for work the council
 * surfaced but did not plan. It operates as a BOUNDED queue over the
 * CWE-006 store: items are journal entries in the session's own
 * hash-chained journal (the store of record), each carrying its
 * source-session provenance, processed strictly in journal order under
 * the same CWE-007 scope checks as every other kanban operation.
 *
 * A scan hit creates at most a PROPOSAL record, never a task: only an
 * approved action plan (plan-service) can materialize board work.
 * Board commands in the "Stop that council" family are NOT work: they
 * resolve the existing session through the trusted session surface and
 * create no task, no scan item, and no plan.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { canonicalHash, canonicalStringify } from '../contracts';
import type { CouncilPrincipal } from '../auth';
import { CouncilRepositories } from '../store';
import {
  assertKanbanSessionNotDeleted,
  authorizeKanbanOperation,
  type KanbanAuthOptions,
} from './context';
import { CouncilKanbanError } from './errors';
import { appendKanbanJournalEvent, listKanbanJournalEntries } from './journal';
import { withKeyedLock } from './mutex';

export const DEFAULT_MAX_PENDING_SCAN_ITEMS = 100;
export const DEFAULT_MAX_SCAN_ITEM_BYTES = 16_384;

const TERMINAL_SESSION_STATES = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);

export interface CouncilScanItemInput {
  summary: string;
  candidate_kind?: string;
  evidence_refs?: string[];
}

export interface CouncilScanItem {
  scan_item_id: string;
  source_session_id: string;
  summary: string;
  candidate_kind: string;
  evidence_refs: string[];
  enqueued_by: string;
  enqueued_at: string;
  sequence: number;
}

export interface CouncilScanProposal {
  proposal_id: string;
  scan_item_id: string;
  source_session_id: string;
  summary: string;
  candidate_kind: string;
  evidence_refs: string[];
  status: 'proposed';
  /** A scan proposal is never a task; only an approved plan creates tasks. */
  creates_task: false;
  recorded_at: string;
}

export type BoardCommandResolution =
  | {
      kind: 'session_command';
      command: 'stop' | 'cancel' | 'pause' | 'resume';
      session_id: string;
      creates_task: false;
      resolution: 'resolve_existing_session_via_trusted_api';
    }
  | {
      kind: 'unresolved';
      reason: 'no_session_command' | 'no_council_reference' | 'no_active_session';
      creates_task: false;
    };

export interface CouncilScanQueueDeps {
  repositories?: CouncilRepositories;
  db?: Database.Database;
  now?: () => string;
  newId?: () => string;
  maxPending?: number;
  maxItemBytes?: number;
}

interface ScanQueueState {
  pending: CouncilScanItem[];
  proposals: CouncilScanProposal[];
}

export class CouncilScanQueue {
  private readonly repositories: CouncilRepositories;
  private readonly db: Database.Database;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly maxPending: number;
  private readonly maxItemBytes: number;

  constructor(deps: CouncilScanQueueDeps = {}) {
    this.db = deps.db ?? getDb();
    this.repositories = deps.repositories ?? new CouncilRepositories();
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
    this.maxPending = deps.maxPending ?? DEFAULT_MAX_PENDING_SCAN_ITEMS;
    this.maxItemBytes = deps.maxItemBytes ?? DEFAULT_MAX_SCAN_ITEM_BYTES;
  }

  private deriveState(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
  ): ScanQueueState {
    const entries = listKanbanJournalEntries(this.db, scope, sessionId);
    const enqueued: CouncilScanItem[] = [];
    const processedIds = new Set<string>();
    const proposals: CouncilScanProposal[] = [];
    const seenProposals = new Set<string>();
    for (const entry of entries) {
      if (entry.action === 'scan_enqueued') {
        const item = entry.payload.scan_item as CouncilScanItem | undefined;
        if (item && typeof item.scan_item_id === 'string') {
          enqueued.push({ ...item, sequence: entry.sequence });
        }
      } else if (entry.action === 'scan_processed') {
        if (typeof entry.payload.scan_item_id === 'string') {
          processedIds.add(entry.payload.scan_item_id);
        }
      } else if (entry.action === 'scan_proposal_recorded') {
        const proposal = entry.payload.proposal as CouncilScanProposal | undefined;
        if (proposal && !seenProposals.has(proposal.proposal_id)) {
          seenProposals.add(proposal.proposal_id);
          proposals.push(proposal);
        }
      }
    }
    return {
      pending: enqueued.filter((item) => !processedIds.has(item.scan_item_id)),
      proposals,
    };
  }

  /**
   * Enqueue follow-up candidates for a session. Bounded: the pending
   * depth may not exceed the configured cap, and each item is size
   * checked. Overflow is a visible typed error, never a silent drop.
   */
  async enqueueScanItems(
    principal: CouncilPrincipal,
    sessionId: string,
    items: CouncilScanItemInput[],
    auth?: KanbanAuthOptions,
  ): Promise<CouncilScanItem[]> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'create_tasks',
      'mutate',
      auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const lockKey = `${scope.tenant_id}:${scope.company_id}:${sessionId}:scan`;
    return withKeyedLock(lockKey, async () => {
      const state = this.deriveState(scope, sessionId);
      if (state.pending.length + items.length > this.maxPending) {
        throw new CouncilKanbanError(
          'COUNCIL_SCAN_QUEUE_FULL',
          `The follow-up scan queue for session ${sessionId} is bounded at ${this.maxPending} pending items.`,
          409,
          { pending: state.pending.length, attempted: items.length },
        );
      }
      const enqueuedAt = this.now();
      const records: CouncilScanItem[] = [];
      for (const input of items) {
        if (!input || typeof input.summary !== 'string' || input.summary.trim().length === 0) {
          throw new CouncilKanbanError(
            'COUNCIL_SCAN_ITEM_INVALID',
            'A scan item requires a non-empty summary.',
          );
        }
        const record: CouncilScanItem = {
          scan_item_id: this.newId(),
          source_session_id: sessionId,
          summary: input.summary,
          candidate_kind: input.candidate_kind ?? 'follow_up_candidate',
          evidence_refs: input.evidence_refs ?? [],
          enqueued_by: principal.subject,
          enqueued_at: enqueuedAt,
          sequence: 0,
        };
        if (canonicalStringify(record).length > this.maxItemBytes) {
          throw new CouncilKanbanError(
            'COUNCIL_SCAN_ITEM_TOO_LARGE',
            `A scan item exceeds the ${this.maxItemBytes}-byte bound and was not enqueued.`,
          );
        }
        records.push(record);
      }
      this.db
        .transaction(() => {
          for (const record of records) {
            appendKanbanJournalEvent(this.db, scope, sessionId, {
              eventId: this.newId(),
              actorSubject: principal.subject,
              action: 'scan_enqueued',
              createdAt: enqueuedAt,
              data: {
                scan_item: record,
                authorization: { permission: 'create_tasks' },
              },
            });
          }
        })
        .immediate();
      return this.deriveState(scope, sessionId).pending.filter((item) =>
        records.some((record) => record.scan_item_id === item.scan_item_id),
      );
    });
  }

  /** Pending scan items in processing (journal) order. */
  async listPendingScanItems(
    principal: CouncilPrincipal,
    sessionId: string,
    auth?: KanbanAuthOptions,
  ): Promise<CouncilScanItem[]> {
    const { scope } = authorizeKanbanOperation(this.db, principal, sessionId, 'read', 'read', auth);
    return this.deriveState(scope, sessionId).pending;
  }

  /** Proposal records created by scan processing, in journal order. */
  async listScanProposals(
    principal: CouncilPrincipal,
    sessionId: string,
    auth?: KanbanAuthOptions,
  ): Promise<CouncilScanProposal[]> {
    const { scope } = authorizeKanbanOperation(this.db, principal, sessionId, 'read', 'read', auth);
    return this.deriveState(scope, sessionId).proposals;
  }

  /**
   * Process the oldest pending scan item. Processing records at most
   * ONE proposal for the item and never creates a task, a plan, or a
   * parent. Returns the empty-queue outcome instead of throwing when
   * there is nothing to do.
   */
  async processNextScanItem(
    principal: CouncilPrincipal,
    sessionId: string,
    auth?: KanbanAuthOptions,
  ): Promise<
    | { processed: false; reason: 'queue_empty' }
    | { processed: true; scan_item_id: string; proposal: CouncilScanProposal }
  > {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'create_tasks',
      'mutate',
      auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const lockKey = `${scope.tenant_id}:${scope.company_id}:${sessionId}:scan`;
    return withKeyedLock(lockKey, async () => {
      const state = this.deriveState(scope, sessionId);
      const next = state.pending[0];
      if (!next) return { processed: false, reason: 'queue_empty' } as const;
      const proposal: CouncilScanProposal = {
        proposal_id: `scanprop-${canonicalHash({ scan_item_id: next.scan_item_id }).slice(0, 24)}`,
        scan_item_id: next.scan_item_id,
        source_session_id: next.source_session_id,
        summary: next.summary,
        candidate_kind: next.candidate_kind,
        evidence_refs: next.evidence_refs,
        status: 'proposed',
        creates_task: false,
        recorded_at: this.now(),
      };
      this.db
        .transaction(() => {
          appendKanbanJournalEvent(this.db, scope, sessionId, {
            eventId: this.newId(),
            actorSubject: principal.subject,
            action: 'scan_proposal_recorded',
            createdAt: proposal.recorded_at,
            data: {
              proposal,
              authorization: { permission: 'create_tasks' },
            },
          });
          appendKanbanJournalEvent(this.db, scope, sessionId, {
            eventId: this.newId(),
            actorSubject: principal.subject,
            action: 'scan_processed',
            createdAt: proposal.recorded_at,
            data: {
              scan_item_id: next.scan_item_id,
              outcome: 'proposal_recorded',
              proposal_id: proposal.proposal_id,
              creates_task: false,
            },
          });
        })
        .immediate();
      return { processed: true, scan_item_id: next.scan_item_id, proposal } as const;
    });
  }

  /**
   * Resolve a board command ("Stop that council", "Pause that
   * council", and family) to the existing session it targets. This
   * NEVER creates a task or any board work; the state change itself is
   * performed by the trusted session API (CWE-008 lifecycle), and this
   * resolution is journaled on the resolved session for audit.
   */
  async resolveBoardCommand(
    principal: CouncilPrincipal,
    input: { text: string; session_id?: string | null },
    auth?: KanbanAuthOptions,
  ): Promise<BoardCommandResolution> {
    const text = (input.text ?? '').toLowerCase();
    let command: 'stop' | 'cancel' | 'pause' | 'resume' | null = null;
    if (/\b(stop|halt)\b/.test(text)) command = 'stop';
    else if (/\bcancel\b/.test(text)) command = 'cancel';
    else if (/\bpause\b/.test(text)) command = 'pause';
    else if (/\bresume\b/.test(text)) command = 'resume';
    if (!command) return { kind: 'unresolved', reason: 'no_session_command', creates_task: false };

    let sessionId = input.session_id ?? null;
    if (!sessionId) {
      if (!/\bcouncil\b/.test(text)) {
        return { kind: 'unresolved', reason: 'no_council_reference', creates_task: false };
      }
      const rows = this.db
        .prepare(
          `SELECT id, state FROM council_sessions
            WHERE tenant_id = ? AND company_id = ? AND archived = 0
            ORDER BY updated_at DESC`,
        )
        .all(principal.scope.tenant_id, principal.scope.company_id) as Array<{
        id: string;
        state: string;
      }>;
      const active = rows.find((row) => !TERMINAL_SESSION_STATES.has(row.state));
      if (!active) {
        return { kind: 'unresolved', reason: 'no_active_session', creates_task: false };
      }
      sessionId = active.id;
    }
    const { scope } = authorizeKanbanOperation(this.db, principal, sessionId, 'run', 'mutate', auth);
    appendKanbanJournalEvent(this.db, scope, sessionId, {
      eventId: this.newId(),
      actorSubject: principal.subject,
      action: 'board_command_resolved',
      createdAt: this.now(),
      data: {
        command,
        creates_task: false,
        resolution: 'resolve_existing_session_via_trusted_api',
        authorization: { permission: 'run' },
      },
    });
    return {
      kind: 'session_command',
      command,
      session_id: sessionId,
      creates_task: false,
      resolution: 'resolve_existing_session_via_trusted_api',
    };
  }
}
