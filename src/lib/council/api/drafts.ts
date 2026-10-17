/**
 * Council draft services (CWE-029, directive Sections 17.1, 17.2).
 *
 * The real writes of the API foundation: session draft creation and
 * brief draft revision, persisted through the CWE-006 repository
 * service over the CWE-005 store. A draft is a DRAFT-state session
 * with a validated CWE-003 SessionSpec, DecisionBrief, and
 * SessionStateRecord. Creating or revising a draft runs no inference,
 * dispatches no task, and freezes nothing: intake and brief freeze
 * belong to CWE-023.
 *
 * Idempotency (Section 17.1): creation and brief revision claim a
 * request key through the CWE-006 claim path before writing. A replay
 * with the same payload returns the originally committed result; a
 * replay with a different payload returns IDEMPOTENCY_CONFLICT (409)
 * and writes nothing.
 *
 * Brief revision writes the new brief revision row, moves the
 * session's brief pointer under an expected-revision compare-and-swap,
 * and appends a canonical `brief_revised` journal event with the same
 * hash-chain inputs the CWE-006 journal uses, in one transaction. The
 * frozen SessionSpec is not rewritten: its brief_sha256 stays the hash
 * of the brief as created, and adoption of a later brief revision by a
 * run belongs to CWE-023.
 */

import { randomUUID } from 'node:crypto';
import {
  canonicalHash,
  canonicalStringify,
  validateDecisionBrief,
  validateSessionSpec,
  validateSessionStateRecord,
  SCHEMA_VERSIONS,
  SEAT_IDS,
  type DecisionBrief,
  type SessionSpec,
  type SessionStateRecord,
} from '../contracts';
import { envelopeFromScope, type CouncilStoredSession } from '../store';
import type { CouncilRouteContext } from './foundation';
import { authorizeSessionMutate, authorizeSessionRead } from './foundation';
import { CouncilApiError, idempotencyConflict, schemaValidation } from './errors';

const CREATE_OPERATION = 'session.create';
const BRIEF_OPERATION = 'session.brief.patch';
const API_SOURCE = 'council-api';

export interface SessionDraftBriefInput {
  question: string;
  facts?: DecisionBrief['facts'];
  assumptions?: DecisionBrief['assumptions'];
  unknowns?: DecisionBrief['unknowns'];
  constraints?: DecisionBrief['constraints'];
  options: DecisionBrief['options'];
  relevance_weights?: DecisionBrief['relevance_weights'];
  critical_domains?: DecisionBrief['critical_domains'];
  evidence_manifest?: DecisionBrief['evidence_manifest'];
  private_preference_ref?: DecisionBrief['private_preference_ref'];
  display_timezone?: string;
}

export interface SessionDraftInput {
  mode?: SessionSpec['mode'];
  visibility?: SessionSpec['visibility'];
  seat_ids?: SessionSpec['seat_ids'];
  source_pack_version: string;
  model_policy: SessionSpec['model_policy'];
  display_timezone?: string;
  brief: SessionDraftBriefInput;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw schemaValidation(`${what} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Validate and normalize the raw create body into a draft input. Only
 * shape is checked here; the canonical CWE-003 validators decide
 * contract validity in buildDraftRecords.
 */
export function parseDraftInput(body: Record<string, unknown>): SessionDraftInput {
  const brief = asRecord(body.brief, 'brief');
  if (typeof brief.question !== 'string' || brief.question.trim().length === 0) {
    throw schemaValidation('brief.question is required and must be a non-empty string.');
  }
  if (!Array.isArray(brief.options) || brief.options.length === 0) {
    throw schemaValidation('brief.options is required and must name at least one option.');
  }
  if (typeof body.source_pack_version !== 'string' || body.source_pack_version.length === 0) {
    throw schemaValidation('source_pack_version is required.');
  }
  const modelPolicy = asRecord(body.model_policy, 'model_policy');
  return {
    mode: (body.mode as SessionSpec['mode']) ?? 'full',
    visibility: (body.visibility as SessionSpec['visibility']) ?? 'private',
    seat_ids: body.seat_ids as SessionSpec['seat_ids'],
    source_pack_version: body.source_pack_version,
    model_policy: modelPolicy as unknown as SessionSpec['model_policy'],
    display_timezone:
      typeof body.display_timezone === 'string' ? body.display_timezone : undefined,
    brief: {
      question: brief.question,
      facts: (brief.facts as DecisionBrief['facts']) ?? [],
      assumptions: (brief.assumptions as DecisionBrief['assumptions']) ?? [],
      unknowns: (brief.unknowns as DecisionBrief['unknowns']) ?? [],
      constraints: (brief.constraints as DecisionBrief['constraints']) ?? [],
      options: brief.options as DecisionBrief['options'],
      relevance_weights: (brief.relevance_weights as DecisionBrief['relevance_weights']) ?? {},
      critical_domains: (brief.critical_domains as DecisionBrief['critical_domains']) ?? [],
      evidence_manifest: (brief.evidence_manifest as DecisionBrief['evidence_manifest']) ?? [],
      private_preference_ref:
        (brief.private_preference_ref as DecisionBrief['private_preference_ref']) ?? null,
      display_timezone:
        typeof brief.display_timezone === 'string' ? brief.display_timezone : undefined,
    },
  };
}

interface DraftRecords {
  spec: SessionSpec;
  brief: DecisionBrief;
  state: SessionStateRecord;
}

function buildDraftRecords(
  input: SessionDraftInput,
  sessionId: string,
  nowIso: string,
): DraftRecords {
  const displayTimezone =
    input.brief.display_timezone ?? input.display_timezone ?? 'UTC';
  const seatIds =
    input.seat_ids ?? ((input.mode ?? 'full') === 'full' ? [...SEAT_IDS] : undefined);
  const brief: DecisionBrief = {
    schema_version: SCHEMA_VERSIONS.brief,
    brief_id: randomUUID(),
    session_id: sessionId,
    revision: 1,
    question: input.brief.question,
    facts: input.brief.facts ?? [],
    assumptions: input.brief.assumptions ?? [],
    unknowns: input.brief.unknowns ?? [],
    constraints: input.brief.constraints ?? [],
    options: input.brief.options,
    relevance_weights: input.brief.relevance_weights ?? {},
    critical_domains: input.brief.critical_domains ?? [],
    evidence_manifest: input.brief.evidence_manifest ?? [],
    private_preference_ref: input.brief.private_preference_ref ?? null,
    created_at: nowIso,
    display_timezone: displayTimezone,
  };
  const briefCheck = validateDecisionBrief(brief);
  if (!briefCheck.ok) {
    throw schemaValidation(
      `The draft brief failed canonical DecisionBrief validation: ${JSON.stringify(briefCheck.issues)}`,
    );
  }
  const spec: SessionSpec = {
    schema_version: SCHEMA_VERSIONS.session,
    session_id: sessionId,
    mode: input.mode ?? 'full',
    visibility: input.visibility ?? 'private',
    brief_revision: 1,
    brief_sha256: canonicalHash(brief),
    options: input.brief.options,
    seat_ids: seatIds as SessionSpec['seat_ids'],
    model_policy: input.model_policy,
    source_pack_version: input.source_pack_version,
    execution_policy: 'advisory_only',
    created_at: nowIso,
    display_timezone: displayTimezone,
  };
  const specCheck = validateSessionSpec(spec);
  if (!specCheck.ok) {
    throw schemaValidation(
      `The draft session failed canonical SessionSpec validation: ${JSON.stringify(specCheck.issues)}`,
    );
  }
  const state: SessionStateRecord = {
    schema_version: 'wise-elders.session-state/v1',
    session_id: sessionId,
    mode: spec.mode,
    state: 'DRAFT',
    state_version: 0,
    brief_revision: 1,
    resume_phase: null,
    cancel_generation: 0,
    revocation_generation: 0,
    attempt: 1,
    lease_epoch: 0,
    archived: false,
    updated_at: nowIso,
  } as SessionStateRecord;
  const stateCheck = validateSessionStateRecord(state);
  if (!stateCheck.ok) {
    throw schemaValidation(
      `The draft state record failed canonical SessionStateRecord validation: ${JSON.stringify(stateCheck.issues)}`,
    );
  }
  return { spec, brief, state };
}

export interface DraftCreateResult {
  session: CouncilStoredSession;
  replayed: boolean;
}

/**
 * Create one session draft through the CWE-006 store under the
 * principal's trusted scope. The principal is always the draft's
 * owner; scope fields are never read from the request body.
 */
export function createDraftSession(
  ctx: CouncilRouteContext,
  input: SessionDraftInput,
  idempotencyKey: string,
): DraftCreateResult {
  const nowIso = new Date().toISOString();
  const sessionId = randomUUID();
  const records = buildDraftRecords(input, sessionId, nowIso);
  const scope = { ...ctx.principal.scope, owner_subject: ctx.principal.subject };
  const fingerprint = canonicalHash({ operation: CREATE_OPERATION, input });
  const claim = ctx.repositories.claimRequestKey({
    tenantId: scope.tenant_id,
    source: API_SOURCE,
    operation: CREATE_OPERATION,
    requestKey: idempotencyKey,
    payloadFingerprint: fingerprint,
    sessionId,
  });
  if (claim.outcome === 'conflict') throw idempotencyConflict(CREATE_OPERATION);
  if (claim.outcome === 'replay') {
    const original = findClaimedSessionId(ctx, CREATE_OPERATION, idempotencyKey);
    if (original) {
      const { envelope } = authorizeSessionRead(ctx, original);
      const existing = ctx.repositories.getSession(envelope, original);
      if (existing) return { session: existing, replayed: true };
    }
    throw idempotencyConflict(CREATE_OPERATION);
  }
  const envelope = envelopeFromScope(scope, ctx.principal.subject, 'owner', 'write');
  const stored: CouncilStoredSession = {
    spec: records.spec,
    brief: records.brief,
    scope,
    state: records.state,
    sample: false,
  };
  ctx.repositories.createSession(envelope, stored);
  return { session: stored, replayed: false };
}

function findClaimedSessionId(
  ctx: CouncilRouteContext,
  operation: string,
  requestKey: string,
): string | null {
  const row = ctx.store
    .handle()
    .prepare(
      `SELECT session_id FROM council_request_keys
        WHERE tenant_id = ? AND source = ? AND operation = ? AND request_key = ?`,
    )
    .get(ctx.principal.scope.tenant_id, API_SOURCE, operation, requestKey) as
    | { session_id: string | null }
    | undefined;
  return row?.session_id ?? null;
}

export interface BriefRevisionInput {
  expected_revision: number;
  brief: SessionDraftBriefInput;
}

export function parseBriefRevisionInput(body: Record<string, unknown>): BriefRevisionInput {
  const expected = body.expected_revision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) {
    throw schemaValidation(
      'expected_revision is required and must be the current brief revision (a positive integer).',
    );
  }
  const brief = asRecord(body.brief, 'brief');
  if (typeof brief.question !== 'string' || brief.question.trim().length === 0) {
    throw schemaValidation('brief.question is required and must be a non-empty string.');
  }
  if (!Array.isArray(brief.options) || brief.options.length === 0) {
    throw schemaValidation('brief.options is required and must name at least one option.');
  }
  return {
    expected_revision: expected,
    brief: {
      question: brief.question,
      facts: (brief.facts as DecisionBrief['facts']) ?? [],
      assumptions: (brief.assumptions as DecisionBrief['assumptions']) ?? [],
      unknowns: (brief.unknowns as DecisionBrief['unknowns']) ?? [],
      constraints: (brief.constraints as DecisionBrief['constraints']) ?? [],
      options: brief.options as DecisionBrief['options'],
      relevance_weights: (brief.relevance_weights as DecisionBrief['relevance_weights']) ?? {},
      critical_domains: (brief.critical_domains as DecisionBrief['critical_domains']) ?? [],
      evidence_manifest: (brief.evidence_manifest as DecisionBrief['evidence_manifest']) ?? [],
      private_preference_ref:
        (brief.private_preference_ref as DecisionBrief['private_preference_ref']) ?? null,
      display_timezone:
        typeof brief.display_timezone === 'string' ? brief.display_timezone : undefined,
    },
  };
}

export interface BriefRevisionResult {
  session: CouncilStoredSession;
  replayed: boolean;
}

/**
 * Revise a draft session's brief under an expected-revision
 * compare-and-swap. Only the session owner (or a company-visibility
 * caller inside scope) may revise; support access never mutates
 * (CWE-007). A stale expected revision returns the canonical
 * VERSION_MISMATCH code and writes nothing.
 */
export function reviseDraftBrief(
  ctx: CouncilRouteContext,
  sessionId: string,
  input: BriefRevisionInput,
  idempotencyKey: string,
): BriefRevisionResult {
  const { row, envelope: writeEnvelope } = authorizeSessionMutate(ctx, sessionId);
  const current = ctx.repositories.getSession(writeEnvelope, sessionId);
  if (!current) {
    throw new CouncilApiError(
      'PERSISTENCE_SESSION_NOT_FOUND',
      `No council session ${sessionId} exists in this tenant and company scope.`,
      { status: 404, action: 'check_session_id' },
    );
  }
  if (current.brief.revision !== input.expected_revision) {
    throw new CouncilApiError(
      'VERSION_MISMATCH',
      `Brief revision mismatch for session ${sessionId}: expected_revision ${input.expected_revision} does not equal the current brief revision ${current.brief.revision}. Nothing was written.`,
      { status: 409, action: 'reload_and_retry' },
    );
  }
  const fingerprint = canonicalHash({
    operation: BRIEF_OPERATION,
    session_id: sessionId,
    expected_revision: input.expected_revision,
    brief: input.brief,
  });
  const claim = ctx.repositories.claimRequestKey({
    tenantId: row.tenant_id,
    source: API_SOURCE,
    operation: BRIEF_OPERATION,
    requestKey: idempotencyKey,
    payloadFingerprint: fingerprint,
    sessionId,
  });
  if (claim.outcome === 'conflict') throw idempotencyConflict(BRIEF_OPERATION);
  if (claim.outcome === 'replay') {
    const { envelope } = authorizeSessionRead(ctx, sessionId);
    const existing = ctx.repositories.getSession(envelope, sessionId);
    if (existing) return { session: existing, replayed: true };
    throw idempotencyConflict(BRIEF_OPERATION);
  }

  const nowIso = new Date().toISOString();
  const nextBrief: DecisionBrief = {
    ...current.brief,
    revision: input.expected_revision + 1,
    question: input.brief.question,
    facts: input.brief.facts ?? [],
    assumptions: input.brief.assumptions ?? [],
    unknowns: input.brief.unknowns ?? [],
    constraints: input.brief.constraints ?? [],
    options: input.brief.options,
    relevance_weights: input.brief.relevance_weights ?? {},
    critical_domains: input.brief.critical_domains ?? [],
    evidence_manifest: input.brief.evidence_manifest ?? [],
    private_preference_ref: input.brief.private_preference_ref ?? null,
    display_timezone:
      input.brief.display_timezone ?? current.brief.display_timezone,
    created_at: nowIso,
  };
  const briefCheck = validateDecisionBrief(nextBrief);
  if (!briefCheck.ok) {
    throw schemaValidation(
      `The revised brief failed canonical DecisionBrief validation: ${JSON.stringify(briefCheck.issues)}`,
    );
  }

  const db = ctx.store.handle();
  const apply = db.transaction(() => {
    const fresh = db
      .prepare(
        `SELECT brief_revision FROM council_sessions
          WHERE tenant_id = ? AND company_id = ? AND id = ?`,
      )
      .get(row.tenant_id, row.company_id, sessionId) as { brief_revision: number } | undefined;
    if (!fresh) {
      throw new CouncilApiError(
        'PERSISTENCE_SESSION_NOT_FOUND',
        `No council session ${sessionId} exists in this tenant and company scope.`,
        { status: 404, action: 'check_session_id' },
      );
    }
    if (fresh.brief_revision !== input.expected_revision) {
      throw new CouncilApiError(
        'PERSISTENCE_STATE_CONFLICT',
        `Session ${sessionId} changed underneath this writer (expected brief revision ${input.expected_revision}, current ${fresh.brief_revision}).`,
        { status: 409, retryable: true, action: 'reload_and_retry' },
      );
    }
    db.prepare(
      `INSERT INTO council_brief_revisions
         (tenant_id, company_id, session_id, revision, brief_json, canonical_hash,
          question, decision_type, stakes, deadline, reversibility,
          success_criteria_json, constraints_json, author_subject, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'general', 'not_recorded', NULL, 'not_recorded', '[]', ?, ?, ?)`,
    ).run(
      row.tenant_id,
      row.company_id,
      sessionId,
      nextBrief.revision,
      canonicalStringify(nextBrief),
      canonicalHash(nextBrief),
      nextBrief.question,
      canonicalStringify(nextBrief.constraints),
      ctx.principal.subject,
      nowIso,
    );
    db.prepare(
      `UPDATE council_sessions
          SET brief_revision = ?, brief_hash = ?, updated_at = ?
        WHERE tenant_id = ? AND company_id = ? AND id = ?`,
    ).run(
      nextBrief.revision,
      canonicalHash(nextBrief),
      nowIso,
      row.tenant_id,
      row.company_id,
      sessionId,
    );
    const last = db
      .prepare(
        `SELECT sequence, event_hash FROM council_events
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?
          ORDER BY sequence DESC LIMIT 1`,
      )
      .get(row.tenant_id, row.company_id, sessionId) as
      | { sequence: number; event_hash: string }
      | undefined;
    const sequence = (last?.sequence ?? 0) + 1;
    const prevHash = last?.event_hash ?? '';
    const payload = {
      brief_revision: nextBrief.revision,
      previous_brief_revision: input.expected_revision,
      brief_sha256: canonicalHash(nextBrief),
    };
    const payloadJson = canonicalStringify(payload);
    const eventHash = canonicalHash({
      tenant_id: row.tenant_id,
      company_id: row.company_id,
      session_id: sessionId,
      sequence,
      type: 'brief_revised',
      payload_json: payloadJson,
      prev_hash: prevHash,
      created_at: nowIso,
    });
    db.prepare(
      `INSERT INTO council_events
         (tenant_id, company_id, session_id, sequence, id, type, from_state, to_state,
          actor_subject, payload_json, prev_hash, event_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.tenant_id,
      row.company_id,
      sessionId,
      sequence,
      randomUUID(),
      'brief_revised',
      null,
      null,
      ctx.principal.subject,
      payloadJson,
      prevHash,
      eventHash,
      nowIso,
    );
  });
  apply();

  const { envelope } = authorizeSessionRead(ctx, sessionId);
  const updated = ctx.repositories.getSession(envelope, sessionId);
  if (!updated) {
    throw new CouncilApiError(
      'PERSISTENCE_INTERNAL',
      `Session ${sessionId} could not be reloaded after its brief revision was committed.`,
      { status: 500, action: 'contact_support' },
    );
  }
  return { session: updated, replayed: false };
}
