/**
 * Ancillary session coordination services (CWE-050; directive
 * Sections 17.2, 19, 20, 24; CWE-034/CWE-037 remainders).
 *
 * The narrow coordination not owned by any earlier unit, composed
 * over the CWE-006 store and the frozen CWE-003 contracts:
 *
 * - client decision recording (accept / reject / defer), bound to
 *   the exact committed verdict revision and stored independently of
 *   the verdict itself (Section 12 keeps client accept/reject/defer
 *   separate from the council's label);
 * - follow-up coordination: creates a NEW linked consult session for
 *   one seat; it never edits the parent session, its cards, or its
 *   verdict (T104), and it runs no inference — starting the consult
 *   requires its own purpose-bound grant like any run;
 * - rerun coordination: creates a child session whose brief is the
 *   parent's current brief with the submitted changed facts applied,
 *   with the field-level change diff journaled on both sessions; a
 *   rerun inherits no approval and no grant (Section 20);
 * - outcome recording into council_outcome_reviews: what happened,
 *   recorded separately from what was predicted, against the
 *   preserved verdict snapshot (revision + content hash) (T107);
 * - archive (a visibility flag, never a state; the audit record is
 *   untouched) and deletion through the store's tombstone flow with
 *   an explicit confirmation, never an unguarded delete;
 * - the evidence read: the committed evidence-manifest entry of the
 *   session's frozen brief, by evidence ID, under the caller's
 *   authorized read envelope.
 *
 * Journal vocabulary decision (CWE-050, recorded in the build
 * report): the CWE-003 event vocabulary is frozen and has no
 * decision, follow-up, rerun, outcome, archive, route-changed, or
 * export type. Following the accepted CWE-038 precedent (exports
 * ride operation_completed with kind 'report_export') and the
 * CWE-037 precedent (kanban actions ride operation_completed with
 * kind 'council_kanban'), coordination facts ride
 * operation_completed with kind 'council_coordination' and a
 * specific action, appended with the exact CWE-006 hash-chain
 * inputs so verifyChain covers them. No event type is invented
 * here; a dedicated vocabulary amendment remains a CWE-003
 * contracts decision for integration, not a unilateral fork.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  canonicalHash,
  canonicalStringify,
  validateDecisionBrief,
  validateSessionSpec,
  SCHEMA_VERSIONS,
  type DecisionBrief,
  type SessionSpec,
  type SessionStateRecord,
  type Verdict,
} from './contracts';
import {
  envelopeFromScope,
  type CouncilEnvelope,
  type CouncilRepositories,
  type CouncilStoredSession,
} from './store';
import type { CouncilStore } from './persistence/council-store';
import { CouncilApiError } from './api/errors';

export const COORDINATION_JOURNAL_KIND = 'council_coordination';

/**
 * Append one coordination event to the session's hash-chained
 * journal, reproducing CWE-006's chain inputs exactly (same
 * canonicalHash input shape as kanban/journal.ts, which the
 * repositories' verifyChain validates). Caller wraps multi-write
 * flows; this append is a single statement.
 */
export function appendCoordinationEvent(
  db: Database.Database,
  scope: { tenant_id: string; company_id: string },
  sessionId: string,
  input: {
    actorSubject: string;
    action: string;
    data: Record<string, unknown>;
    createdAt: string;
  },
): { sequence: number; event_hash: string } {
  const payload: Record<string, unknown> = {
    kind: COORDINATION_JOURNAL_KIND,
    action: input.action,
    ...input.data,
  };
  const last = db
    .prepare(
      `SELECT sequence, event_hash FROM council_events
        WHERE tenant_id = ? AND company_id = ? AND session_id = ?
        ORDER BY sequence DESC LIMIT 1`,
    )
    .get(scope.tenant_id, scope.company_id, sessionId) as
    | { sequence: number; event_hash: string }
    | undefined;
  const sequence = (last?.sequence ?? 0) + 1;
  const prevHash = last?.event_hash ?? '';
  const payloadJson = canonicalStringify(payload);
  const eventHash = canonicalHash({
    tenant_id: scope.tenant_id,
    company_id: scope.company_id,
    session_id: sessionId,
    sequence,
    type: 'operation_completed',
    payload_json: payloadJson,
    prev_hash: prevHash,
    created_at: input.createdAt,
  });
  db.prepare(
    `INSERT INTO council_events
       (tenant_id, company_id, session_id, sequence, id, type, from_state, to_state,
        actor_subject, payload_json, prev_hash, event_hash, created_at)
     VALUES (?, ?, ?, ?, ?, 'operation_completed', NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    scope.tenant_id,
    scope.company_id,
    sessionId,
    sequence,
    randomUUID(),
    input.actorSubject,
    payloadJson,
    prevHash,
    eventHash,
    input.createdAt,
  );
  return { sequence, event_hash: eventHash };
}

/** Read this session's coordination events of one action, oldest first. */
export function listCoordinationEvents(
  repositories: CouncilRepositories,
  envelope: CouncilEnvelope,
  sessionId: string,
  action: string,
): Array<Record<string, unknown>> {
  return repositories
    .listEvents(envelope, sessionId, 0)
    .filter(
      (event) =>
        event.type === 'operation_completed' &&
        (event.payload as Record<string, unknown>).kind === COORDINATION_JOURNAL_KIND &&
        (event.payload as Record<string, unknown>).action === action,
    )
    .map((event) => event.payload as Record<string, unknown>);
}

// ------------------------------------------------------------- decisions

export type ClientDecisionChoice = 'accept' | 'reject' | 'defer';

export interface ClientDecisionRecord {
  session_id: string;
  decision: ClientDecisionChoice;
  chosen_option_id: string | null;
  reason: string | null;
  verdict_revision: number;
  verdict_content_sha256: string;
  decided_by: string;
  decided_at: string;
  sequence: number;
}

function verdictOrThrow(
  repositories: CouncilRepositories,
  envelope: CouncilEnvelope,
  sessionId: string,
): Verdict {
  const verdict = repositories.getVerdict(envelope, sessionId);
  if (!verdict) {
    throw new CouncilApiError(
      'COUNCIL_VERDICT_NOT_READY',
      `Session ${sessionId} has no committed verdict; this operation requires one. Nothing was recorded.`,
      { status: 409, action: 'wait_for_verdict' },
    );
  }
  return verdict;
}

function assertVerdictBinding(verdict: Verdict, sessionId: string, revision: number): void {
  if (verdict.verdict_revision !== revision) {
    throw new CouncilApiError(
      'VERSION_MISMATCH',
      `The committed verdict for session ${sessionId} is revision ${verdict.verdict_revision}, not ${revision}. The request binds a superseded or unknown verdict and was refused; nothing was recorded.`,
      { status: 409, action: 'reload_and_retry' },
    );
  }
}

/** Record the client's own decision about a committed verdict. */
export function recordClientDecision(
  deps: { repositories: CouncilRepositories; store: CouncilStore },
  envelope: CouncilEnvelope,
  sessionId: string,
  input: {
    decision: ClientDecisionChoice;
    chosen_option_id?: string | null;
    reason?: string | null;
    verdict_revision: number;
    actor_subject: string;
  },
): ClientDecisionRecord {
  const verdict = verdictOrThrow(deps.repositories, envelope, sessionId);
  assertVerdictBinding(verdict, sessionId, input.verdict_revision);
  const now = new Date().toISOString();
  const { sequence } = appendCoordinationEvent(
    deps.store.handle(),
    { tenant_id: envelope.tenant_id, company_id: envelope.company_id },
    sessionId,
    {
      actorSubject: input.actor_subject,
      action: 'client_decision_recorded',
      createdAt: now,
      data: {
        decision: input.decision,
        chosen_option_id: input.chosen_option_id ?? null,
        reason: input.reason ?? null,
        verdict_revision: verdict.verdict_revision,
        verdict_content_sha256: verdict.content_sha256,
      },
    },
  );
  return {
    session_id: sessionId,
    decision: input.decision,
    chosen_option_id: input.chosen_option_id ?? null,
    reason: input.reason ?? null,
    verdict_revision: verdict.verdict_revision,
    verdict_content_sha256: verdict.content_sha256,
    decided_by: input.actor_subject,
    decided_at: now,
    sequence,
  };
}

/** The latest recorded client decision for a session, if any. */
export function latestClientDecision(
  deps: { repositories: CouncilRepositories },
  envelope: CouncilEnvelope,
  sessionId: string,
): ClientDecisionRecord | null {
  const events = deps.repositories
    .listEvents(envelope, sessionId, 0)
    .filter(
      (event) =>
        event.type === 'operation_completed' &&
        (event.payload as Record<string, unknown>).kind === COORDINATION_JOURNAL_KIND &&
        (event.payload as Record<string, unknown>).action === 'client_decision_recorded',
    );
  const last = events[events.length - 1];
  if (!last) return null;
  const payload = last.payload as Record<string, unknown>;
  return {
    session_id: sessionId,
    decision: payload.decision as ClientDecisionChoice,
    chosen_option_id: (payload.chosen_option_id as string | null) ?? null,
    reason: (payload.reason as string | null) ?? null,
    verdict_revision: payload.verdict_revision as number,
    verdict_content_sha256: payload.verdict_content_sha256 as string,
    decided_by: last.actor_subject,
    decided_at: last.created_at,
    sequence: last.sequence,
  };
}

// ------------------------------------------------------- child sessions

function childState(sessionId: string, mode: SessionSpec['mode'], now: string): SessionStateRecord {
  return {
    schema_version: 'wise-elders.session-state/v1',
    session_id: sessionId,
    mode,
    state: 'DRAFT',
    state_version: 0,
    brief_revision: 1,
    resume_phase: null,
    cancel_generation: 0,
    revocation_generation: 0,
    attempt: 1,
    lease_epoch: 0,
    archived: false,
    updated_at: now,
  } as SessionStateRecord;
}

function createChildSession(
  deps: { repositories: CouncilRepositories; store: CouncilStore },
  parent: CouncilStoredSession,
  actorSubject: string,
  input: {
    mode: SessionSpec['mode'];
    seat_ids: SessionSpec['seat_ids'];
    brief: DecisionBrief;
  },
): CouncilStoredSession {
  const now = new Date().toISOString();
  const childId = input.brief.session_id;
  const spec: SessionSpec = {
    schema_version: SCHEMA_VERSIONS.session,
    session_id: childId,
    mode: input.mode,
    visibility: parent.spec.visibility,
    brief_revision: 1,
    brief_sha256: canonicalHash(input.brief),
    options: input.brief.options,
    seat_ids: input.seat_ids,
    model_policy: parent.spec.model_policy,
    source_pack_version: parent.spec.source_pack_version,
    execution_policy: 'advisory_only',
    created_at: now,
    display_timezone: parent.spec.display_timezone,
  };
  const specCheck = validateSessionSpec(spec);
  if (!specCheck.ok) {
    throw new CouncilApiError(
      'SCHEMA_VALIDATION',
      `The child session spec failed canonical validation: ${JSON.stringify(specCheck.issues)}`,
      { status: 400, action: 'fix_request' },
    );
  }
  const briefCheck = validateDecisionBrief(input.brief);
  if (!briefCheck.ok) {
    throw new CouncilApiError(
      'SCHEMA_VALIDATION',
      `The child session brief failed canonical validation: ${JSON.stringify(briefCheck.issues)}`,
      { status: 400, action: 'fix_request' },
    );
  }
  const child: CouncilStoredSession = {
    spec,
    brief: input.brief,
    scope: parent.scope,
    state: childState(childId, input.mode, now),
    sample: false,
  };
  const envelope = envelopeFromScope(parent.scope, actorSubject, 'owner', 'write');
  deps.repositories.createSession(envelope, child);
  return child;
}

// ------------------------------------------------------------- follow-up

export interface FollowUpResult {
  parent_session_id: string;
  child_session_id: string;
  child_state: string;
  seat_id: string;
  question: string;
  idempotent_replay: boolean;
}

/**
 * Create the linked one-seat consult for a follow-up question
 * (Section 20, T104). The parent session, its cards, and its verdict
 * are never modified; the only parent-side write is the journal
 * record of the link itself.
 */
export function createFollowUpSession(
  deps: { repositories: CouncilRepositories; store: CouncilStore },
  envelope: CouncilEnvelope,
  parent: CouncilStoredSession,
  input: {
    seat_id: string;
    question: string;
    evidence_ids?: string[];
    actor_subject: string;
    idempotency_key: string;
  },
): FollowUpResult {
  const parentId = parent.spec.session_id;
  verdictOrThrow(deps.repositories, envelope, parentId);
  const prior = listCoordinationEvents(deps.repositories, envelope, parentId, 'follow_up_created')
    .find((payload) => payload.idempotency_key === input.idempotency_key);
  if (prior) {
    return {
      parent_session_id: parentId,
      child_session_id: prior.child_session_id as string,
      child_state: 'DRAFT',
      seat_id: prior.seat_id as string,
      question: prior.question as string,
      idempotent_replay: true,
    };
  }
  if (!parent.spec.seat_ids.includes(input.seat_id as never)) {
    throw new CouncilApiError(
      'SCHEMA_VALIDATION',
      `Seat ${input.seat_id} is not a seat of session ${parentId}; a follow-up targets one of the session's own seats.`,
      { status: 400, action: 'fix_request' },
    );
  }
  const manifest = parent.brief.evidence_manifest ?? [];
  const selectedEvidence = (input.evidence_ids ?? []).map((id) => {
    const entry = manifest.find((item) => item.evidence_id === id);
    if (!entry) {
      throw new CouncilApiError(
        'SCHEMA_VALIDATION',
        `Evidence ${id} is not in the parent session's committed evidence manifest; selected context must come from the recorded manifest.`,
        { status: 400, action: 'fix_request' },
      );
    }
    return entry;
  });
  const now = new Date().toISOString();
  const childId = randomUUID();
  const brief: DecisionBrief = {
    schema_version: SCHEMA_VERSIONS.brief,
    brief_id: randomUUID(),
    session_id: childId,
    revision: 1,
    question: input.question,
    facts: [],
    assumptions: [],
    unknowns: [],
    constraints: [],
    options: parent.brief.options,
    relevance_weights: {},
    critical_domains: [],
    evidence_manifest: selectedEvidence,
    private_preference_ref: null,
    created_at: now,
    display_timezone: parent.brief.display_timezone,
  };
  const child = createChildSession(deps, parent, input.actor_subject, {
    mode: 'consult',
    seat_ids: [input.seat_id] as SessionSpec['seat_ids'],
    brief,
  });
  const scope = { tenant_id: envelope.tenant_id, company_id: envelope.company_id };
  appendCoordinationEvent(deps.store.handle(), scope, parentId, {
    actorSubject: input.actor_subject,
    action: 'follow_up_created',
    createdAt: now,
    data: {
      child_session_id: child.spec.session_id,
      seat_id: input.seat_id,
      question: input.question,
      idempotency_key: input.idempotency_key,
      verdict_revision: parent.brief.revision,
    },
  });
  appendCoordinationEvent(deps.store.handle(), scope, child.spec.session_id, {
    actorSubject: input.actor_subject,
    action: 'follow_up_received',
    createdAt: now,
    data: { parent_session_id: parentId, seat_id: input.seat_id },
  });
  return {
    parent_session_id: parentId,
    child_session_id: child.spec.session_id,
    child_state: child.state.state,
    seat_id: input.seat_id,
    question: input.question,
    idempotent_replay: false,
  };
}

// ----------------------------------------------------------------- rerun

export interface RerunResult {
  parent_session_id: string;
  child_session_id: string;
  child_state: string;
  changed_fields: string[];
  idempotent_replay: boolean;
}

const RERUN_BRIEF_FIELDS = [
  'question',
  'facts',
  'assumptions',
  'unknowns',
  'constraints',
  'options',
] as const;

/**
 * Create a changed-facts rerun child (Sections 17.2, 20; T024's
 * service half). The child brief is the parent's CURRENT brief with
 * the submitted fields replaced; the diff names exactly the fields
 * whose values changed. No approval, grant, or verdict carries over.
 */
export function createRerunSession(
  deps: { repositories: CouncilRepositories; store: CouncilStore },
  envelope: CouncilEnvelope,
  parent: CouncilStoredSession,
  input: {
    changes: Partial<Pick<DecisionBrief, (typeof RERUN_BRIEF_FIELDS)[number]>>;
    actor_subject: string;
    idempotency_key: string;
  },
): RerunResult {
  const parentId = parent.spec.session_id;
  const prior = listCoordinationEvents(deps.repositories, envelope, parentId, 'rerun_created')
    .find((payload) => payload.idempotency_key === input.idempotency_key);
  if (prior) {
    return {
      parent_session_id: parentId,
      child_session_id: prior.child_session_id as string,
      child_state: 'DRAFT',
      changed_fields: (prior.changed_fields as string[]) ?? [],
      idempotent_replay: true,
    };
  }
  const changedFields: string[] = [];
  const merged: DecisionBrief = { ...parent.brief };
  for (const field of RERUN_BRIEF_FIELDS) {
    const next = input.changes[field];
    if (next === undefined) continue;
    if (canonicalStringify(next) !== canonicalStringify(parent.brief[field])) {
      changedFields.push(field);
    }
    (merged as Record<string, unknown>)[field] = next;
  }
  const now = new Date().toISOString();
  const childId = randomUUID();
  const brief: DecisionBrief = {
    ...merged,
    brief_id: randomUUID(),
    session_id: childId,
    revision: 1,
    created_at: now,
  };
  const child = createChildSession(deps, parent, input.actor_subject, {
    mode: parent.spec.mode,
    seat_ids: parent.spec.seat_ids,
    brief,
  });
  const scope = { tenant_id: envelope.tenant_id, company_id: envelope.company_id };
  appendCoordinationEvent(deps.store.handle(), scope, parentId, {
    actorSubject: input.actor_subject,
    action: 'rerun_created',
    createdAt: now,
    data: {
      child_session_id: child.spec.session_id,
      changed_fields: changedFields,
      idempotency_key: input.idempotency_key,
      parent_brief_revision: parent.brief.revision,
    },
  });
  appendCoordinationEvent(deps.store.handle(), scope, child.spec.session_id, {
    actorSubject: input.actor_subject,
    action: 'rerun_of',
    createdAt: now,
    data: { parent_session_id: parentId, changed_fields: changedFields },
  });
  return {
    parent_session_id: parentId,
    child_session_id: child.spec.session_id,
    child_state: child.state.state,
    changed_fields: changedFields,
    idempotent_replay: false,
  };
}

// --------------------------------------------------------------- outcomes

export interface OutcomeRecord {
  session_id: string;
  review_id: string;
  horizon: string;
  observed_outcome: string;
  observed_at: string;
  evidence_refs: string[];
  verdict_revision: number;
  verdict_content_sha256: string;
  verdict_label: string | null;
  recommended_option_id: string | null;
  recorded_by: string;
  recorded_at: string;
  idempotent_replay: boolean;
}

/** Record what actually happened, separately from the prediction (T107). */
export function recordOutcome(
  deps: { repositories: CouncilRepositories; store: CouncilStore },
  envelope: CouncilEnvelope,
  sessionId: string,
  input: {
    observed_outcome: string;
    observed_at: string;
    verdict_revision: number;
    verdict_content_sha256: string;
    evidence_refs?: string[];
    horizon?: string;
    actor_subject: string;
    idempotency_key: string;
  },
): OutcomeRecord {
  const verdict = verdictOrThrow(deps.repositories, envelope, sessionId);
  assertVerdictBinding(verdict, sessionId, input.verdict_revision);
  if (verdict.content_sha256 !== input.verdict_content_sha256) {
    throw new CouncilApiError(
      'VERSION_MISMATCH',
      `The outcome names verdict content hash ${input.verdict_content_sha256}, but the committed verdict for session ${sessionId} hashes to ${verdict.content_sha256}. The outcome was refused rather than attached to the wrong prediction.`,
      { status: 409, action: 'reload_and_retry' },
    );
  }
  const horizon = input.horizon ?? 'custom';
  const db = deps.store.handle();
  const scope = { tenant_id: envelope.tenant_id, company_id: envelope.company_id };
  const existing = db
    .prepare(
      `SELECT id, review_json FROM council_outcome_reviews
        WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND horizon = ?`,
    )
    .get(scope.tenant_id, scope.company_id, sessionId, horizon) as
    | { id: string; review_json: string }
    | undefined;
  if (existing) {
    const recorded = JSON.parse(existing.review_json) as OutcomeRecord;
    if (recorded.observed_outcome === input.observed_outcome && recorded.observed_at === input.observed_at) {
      return { ...recorded, idempotent_replay: true };
    }
    throw new CouncilApiError(
      'IDEMPOTENCY_CONFLICT',
      `An outcome review for horizon ${horizon} already exists for session ${sessionId} with different content. Outcome records are not silently overwritten.`,
      { status: 409, action: 'use_another_horizon' },
    );
  }
  const now = new Date().toISOString();
  const reviewId = randomUUID();
  const label = verdict.result_kind === 'scored' ? verdict.label : null;
  const recommendedOptionId =
    verdict.result_kind === 'scored' ? verdict.recommended_option_id : null;
  const record: OutcomeRecord = {
    session_id: sessionId,
    review_id: reviewId,
    horizon,
    observed_outcome: input.observed_outcome,
    observed_at: input.observed_at,
    evidence_refs: input.evidence_refs ?? [],
    verdict_revision: verdict.verdict_revision,
    verdict_content_sha256: verdict.content_sha256,
    verdict_label: label,
    recommended_option_id: recommendedOptionId,
    recorded_by: input.actor_subject,
    recorded_at: now,
    idempotent_replay: false,
  };
  const prediction = {
    verdict_revision: verdict.verdict_revision,
    verdict_content_sha256: verdict.content_sha256,
    verdict_label: label,
    recommended_option_id: recommendedOptionId,
  };
  db.prepare(
    `INSERT INTO council_outcome_reviews
       (tenant_id, company_id, session_id, id, horizon, planned_measure_json,
        actual_evidence_json, review_json, client_conclusion, verdict_label,
        reviewed_by_subject, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scope.tenant_id,
    scope.company_id,
    sessionId,
    reviewId,
    horizon,
    canonicalStringify(prediction),
    canonicalStringify({
      observed_outcome: input.observed_outcome,
      observed_at: input.observed_at,
      evidence_refs: input.evidence_refs ?? [],
    }),
    canonicalStringify(record),
    input.observed_outcome,
    label,
    input.actor_subject,
    now,
  );
  appendCoordinationEvent(db, scope, sessionId, {
    actorSubject: input.actor_subject,
    action: 'outcome_recorded',
    createdAt: now,
    data: {
      review_id: reviewId,
      horizon,
      verdict_revision: verdict.verdict_revision,
      verdict_content_sha256: verdict.content_sha256,
      idempotency_key: input.idempotency_key,
    },
  });
  return record;
}

// ---------------------------------------------------- archive and delete

export interface ArchiveResult {
  session_id: string;
  archived: boolean;
  state: string;
  state_version: number;
  idempotent_replay: boolean;
}

/** Archive: a visibility flag, never a state (state-machine header). */
export function archiveSession(
  deps: { repositories: CouncilRepositories },
  envelope: CouncilEnvelope,
  session: CouncilStoredSession,
  input: { expected_version?: number },
): ArchiveResult {
  const current = session.state;
  if (current.archived) {
    return {
      session_id: session.spec.session_id,
      archived: true,
      state: current.state,
      state_version: current.state_version,
      idempotent_replay: true,
    };
  }
  if (input.expected_version !== undefined && input.expected_version !== current.state_version) {
    throw new CouncilApiError(
      'VERSION_MISMATCH',
      `Session ${session.spec.session_id} is at state version ${current.state_version}, not ${input.expected_version}. Nothing was archived.`,
      { status: 409, action: 'reload_and_retry' },
    );
  }
  const next: SessionStateRecord = {
    ...current,
    archived: true,
    state_version: current.state_version + 1,
    updated_at: new Date().toISOString(),
  };
  deps.repositories.writeStateRecord(envelope, next, current.state_version);
  return {
    session_id: session.spec.session_id,
    archived: true,
    state: next.state,
    state_version: next.state_version,
    idempotent_replay: false,
  };
}

/**
 * Delete through the store's tombstone flow (Section 16.5): the
 * record is removed, a tombstone blocks late writes, and protected
 * diagnostic payload files are purged. Requires the delete-purpose
 * envelope; the route layer requires the explicit confirmation.
 */
export function deleteSessionCoordinated(
  deps: { repositories: CouncilRepositories },
  envelope: CouncilEnvelope,
  sessionId: string,
): { session_id: string; deleted: true; diagnostic_files_purged: number } {
  const result = deps.repositories.deleteSession(envelope, sessionId);
  deps.repositories.purgeDiagnosticFiles(result.diagnosticProtectedRefs);
  return {
    session_id: sessionId,
    deleted: true,
    diagnostic_files_purged: result.diagnosticProtectedRefs.length,
  };
}

// --------------------------------------------------------------- evidence

export interface EvidenceEntryResult {
  session_id: string;
  evidence_id: string;
  entry: Record<string, unknown>;
  provenance: 'brief_evidence_manifest';
  brief_revision: number;
}

/**
 * The evidence read: the committed manifest entry from the session's
 * frozen brief. This is a read of committed state only — it returns
 * the recorded entry (identifiers, kind, locator, hashes) exactly as
 * frozen, never file contents from a locator.
 */
export function getEvidenceEntry(
  deps: { repositories: CouncilRepositories },
  envelope: CouncilEnvelope,
  sessionId: string,
  evidenceId: string,
): EvidenceEntryResult {
  const session = deps.repositories.getSession(envelope, sessionId);
  if (!session) {
    throw new CouncilApiError(
      'PERSISTENCE_SESSION_NOT_FOUND',
      `No council session ${sessionId} exists in this tenant and company scope.`,
      { status: 404, action: 'check_session_id' },
    );
  }
  const entry = (session.brief.evidence_manifest ?? []).find(
    (item) => item.evidence_id === evidenceId,
  );
  if (!entry) {
    throw new CouncilApiError(
      'COUNCIL_EVIDENCE_NOT_FOUND',
      `Evidence ${evidenceId} is not in session ${sessionId}'s committed evidence manifest. Nothing was fabricated to fill the gap.`,
      { status: 404, action: 'check_evidence_id' },
    );
  }
  return {
    session_id: sessionId,
    evidence_id: evidenceId,
    entry: entry as unknown as Record<string, unknown>,
    provenance: 'brief_evidence_manifest',
    brief_revision: session.brief.revision,
  };
}
