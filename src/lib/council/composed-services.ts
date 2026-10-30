/**
 * Route-facing composed services (CWE-050).
 *
 * The thin service layer behind the routes CWE-050 graduates: run
 * controls, run-authorization endpoints, ancillary coordination
 * (decision, follow-up, rerun, outcomes, archive, delete, evidence),
 * scoped settings, and report exports. Each function follows the
 * foundation's established route discipline (the CWE-036 approvals
 * pattern): strict body allowlists (unknown keys are
 * SCHEMA_VALIDATION, T079), idempotency claims through the
 * CWE-006 request-key store (same key + changed payload is a 409
 * conflict, T078), and typed errors translated into the canonical
 * CouncilApiError envelope. All state work delegates to the
 * composed services: CWE-049's run-authorization service, CWE-027's
 * run controls, the coordination module, the settings service, and
 * CWE-038's CC report downloads.
 */

import { canonicalHash } from './contracts';
import {
  CouncilApiError,
  schemaValidation,
  type AuthorizedSession,
  type CouncilRouteContext,
} from './api/foundation';
import { envelopeFromScope, type CouncilEnvelope } from './store';
import {
  CouncilRunAuthorizationError,
  CouncilRunAuthorizationService,
} from './run-authorization';
import type { RunCeilings } from './contracts';
import type { CouncilRouteSelection } from './explicit-selection';
import { CouncilRunAuthorizationAdapter } from './run-authorization-adapter';
import {
  CouncilJobService,
  CouncilRunControlError,
  CouncilRunControls,
  type StartRunReceipt,
} from './jobs';
import {
  archiveSession,
  createFollowUpSession,
  createRerunSession,
  deleteSessionCoordinated,
  getEvidenceEntry,
  recordClientDecision,
  recordOutcome,
  type ClientDecisionChoice,
} from './coordination';
import { CouncilSettingsService } from './settings';
import { loadCapabilitySnapshotForPrincipal } from './capability-snapshot-service';
import {
  createCouncilExport,
  findExportSession,
  readCouncilExport,
  resolveClientFormats,
  type CouncilExportDownload,
  type RedactionProfile,
} from './report-downloads';

const API_SOURCE = 'council-api';

// --------------------------------------------------------------- helpers

function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  operation: string,
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw schemaValidation(
        `Unknown field "${key}" in the ${operation} request. The ${operation} contract accepts only: ${allowed.join(', ')}.`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw schemaValidation(`Field "${key}" must be a non-empty string when present.`);
  }
  return value;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key);
  if (value === undefined) throw schemaValidation(`Field "${key}" is required.`);
  return value;
}

function optionalVersion(body: Record<string, unknown>): number | undefined {
  const value = body.expected_version;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw schemaValidation('Field "expected_version" must be a non-negative integer when present.');
  }
  return value;
}

function writeEnvelope(ctx: CouncilRouteContext, authorized: AuthorizedSession): CouncilEnvelope {
  return envelopeFromScope(
    {
      tenant_id: authorized.row.tenant_id,
      company_id: authorized.row.company_id,
      installation_id: authorized.row.installation_id,
      owner_subject: authorized.row.owner_subject,
    },
    ctx.principal.subject,
    'owner',
    'write',
  );
}

function claimKey(
  ctx: CouncilRouteContext,
  operation: string,
  idempotencyKey: string,
  fingerprintInput: Record<string, unknown>,
  sessionId: string | null,
): 'claimed' | 'replay' {
  const claim = ctx.repositories.claimRequestKey({
    tenantId: ctx.principal.scope.tenant_id,
    source: API_SOURCE,
    operation,
    requestKey: idempotencyKey,
    payloadFingerprint: canonicalHash({ operation, ...fingerprintInput }),
    sessionId,
  });
  if (claim.outcome === 'conflict') {
    throw new CouncilApiError(
      'IDEMPOTENCY_CONFLICT',
      `The idempotency key was already used for ${operation} with a different payload. The repeated request was refused; no state changed.`,
      { status: 409, action: 'use_a_new_idempotency_key' },
    );
  }
  return claim.outcome;
}

function translateRunAuthorizationError(error: unknown): never {
  if (error instanceof CouncilRunAuthorizationError) {
    const notFound = ['RUN_SESSION_NOT_FOUND', 'RUN_PREVIEW_NOT_FOUND', 'RUN_GRANT_NOT_FOUND', 'BUDGET_RESERVATION_NOT_FOUND'];
    const badRequest = ['RUN_INVALID_INPUT', 'RUN_MONEY_UNBOUNDED'];
    const forbidden = [
      'RUN_AUTHORIZATION_REQUIRED',
      'RUN_AUTHORITY_MODE_MISMATCH',
      'RUN_GRANT_SCOPE_MISMATCH',
      'RUN_GRANT_ROUTE_MISMATCH',
      'RUN_GRANT_PURPOSE_MISMATCH',
      'RUN_GRANT_KIND_NOT_ALLOWED',
      'RUN_OPERATION_GRANT_MISMATCH',
    ];
    const status = notFound.includes(error.code)
      ? 404
      : badRequest.includes(error.code)
        ? 400
        : forbidden.includes(error.code)
          ? 403
          : 409;
    throw new CouncilApiError(error.code, error.message, {
      status,
      retryable: error.code === 'BUDGET_EXHAUSTED',
      action: status === 404 ? 'check_reference' : status === 400 ? 'fix_request' : 'reload_and_retry',
    });
  }
  throw error;
}

function translateRunControlError(error: unknown): never {
  if (error instanceof CouncilRunControlError) {
    throw new CouncilApiError(error.code, error.message, {
      status: error.status,
      action: error.status === 404 ? 'check_session_id' : 'reload_and_retry',
    });
  }
  throw error;
}

// ---------------------------------------------------------- run controls

function composeRunControls(ctx: CouncilRouteContext): CouncilRunControls {
  const service = new CouncilRunAuthorizationService({ store: ctx.store });
  const adapter = new CouncilRunAuthorizationAdapter({
    principal: ctx.principal,
    service,
    db: ctx.store.handle(),
  });
  return new CouncilRunControls({
    repositories: ctx.repositories,
    jobs: new CouncilJobService({ store: ctx.store }),
    runAuthorization: service,
    adapter,
  });
}

export interface RunControlRouteResult {
  receipt: Record<string, unknown>;
  httpStatus: number;
  replayed: boolean;
}

export async function startSessionRun(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<RunControlRouteResult> {
  rejectUnknownKeys(body, ['grant_id', 'expected_version', 'idempotency_key'], 'session start');
  const grantId = optionalString(body, 'grant_id');
  const expectedVersion = optionalVersion(body);
  claimKey(ctx, 'council.sessions.start', idempotencyKey, {
    session_id: sessionId,
    grant_id: grantId ?? null,
    expected_version: expectedVersion ?? null,
  }, sessionId);
  try {
    const receipt: StartRunReceipt = await composeRunControls(ctx).start(
      ctx.principal,
      writeEnvelope(ctx, authorized),
      sessionId,
      { grant_id: grantId ?? null, expected_version: expectedVersion },
    );
    return {
      receipt: { ...receipt },
      httpStatus: receipt.idempotent_replay ? 200 : 202,
      replayed: receipt.idempotent_replay,
    };
  } catch (error) {
    translateRunControlError(error);
  }
}

export async function pauseSessionRun(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<RunControlRouteResult> {
  rejectUnknownKeys(body, ['expected_version', 'idempotency_key'], 'session pause');
  const expectedVersion = optionalVersion(body);
  claimKey(ctx, 'council.sessions.pause', idempotencyKey, {
    session_id: sessionId,
    expected_version: expectedVersion ?? null,
  }, sessionId);
  try {
    const receipt = composeRunControls(ctx).pause(writeEnvelope(ctx, authorized), sessionId, {
      expected_version: expectedVersion,
    });
    return { receipt: { ...receipt }, httpStatus: 200, replayed: receipt.idempotent_replay };
  } catch (error) {
    translateRunControlError(error);
  }
}

export async function cancelSessionRun(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<RunControlRouteResult> {
  rejectUnknownKeys(body, ['expected_version', 'reason', 'idempotency_key'], 'session cancel');
  const expectedVersion = optionalVersion(body);
  const reason = optionalString(body, 'reason');
  claimKey(ctx, 'council.sessions.cancel', idempotencyKey, {
    session_id: sessionId,
    expected_version: expectedVersion ?? null,
    reason: reason ?? null,
  }, sessionId);
  try {
    const receipt = composeRunControls(ctx).cancel(writeEnvelope(ctx, authorized), sessionId, {
      expected_version: expectedVersion,
      reason: reason ?? null,
    });
    return { receipt: { ...receipt }, httpStatus: 200, replayed: receipt.idempotent_replay };
  } catch (error) {
    translateRunControlError(error);
  }
}

export async function resumeSessionRun(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<RunControlRouteResult> {
  rejectUnknownKeys(body, ['expected_version', 'idempotency_key'], 'session resume');
  const expectedVersion = optionalVersion(body);
  claimKey(ctx, 'council.sessions.resume', idempotencyKey, {
    session_id: sessionId,
    expected_version: expectedVersion ?? null,
  }, sessionId);
  try {
    const receipt = composeRunControls(ctx).resume(writeEnvelope(ctx, authorized), sessionId, {
      expected_version: expectedVersion,
    });
    return { receipt: { ...receipt }, httpStatus: 200, replayed: receipt.idempotent_replay };
  } catch (error) {
    translateRunControlError(error);
  }
}

// ---------------------------------------------------- run authorization

function runAuthorizationService(ctx: CouncilRouteContext): CouncilRunAuthorizationService {
  return new CouncilRunAuthorizationService({ store: ctx.store });
}

function defaultCeilings(ctx: CouncilRouteContext): RunCeilings {
  const settings = new CouncilSettingsService().getSettings({
    tenant_id: ctx.principal.scope.tenant_id,
    company_id: ctx.principal.scope.company_id,
    installation_id: ctx.principal.scope.installation_id,
  }).settings;
  return {
    max_provider_requests: settings.max_session_provider_requests,
    max_output_repairs: settings.max_output_repair_requests,
    max_transport_retries: settings.max_transport_retries_total,
    max_input_tokens: null,
    max_output_tokens: null,
    max_money: null,
  };
}

function parseCeilings(body: Record<string, unknown>, ctx: CouncilRouteContext): RunCeilings {
  const raw = body.ceilings;
  if (raw === undefined || raw === null) return defaultCeilings(ctx);
  if (!isRecord(raw)) throw schemaValidation('Field "ceilings" must be an object when present.');
  const money = raw.max_money;
  return {
    max_provider_requests: raw.max_provider_requests as number,
    max_output_repairs: raw.max_output_repairs as number,
    max_transport_retries: raw.max_transport_retries as number,
    max_input_tokens: (raw.max_input_tokens as number | null) ?? null,
    max_output_tokens: (raw.max_output_tokens as number | null) ?? null,
    max_money: isRecord(money)
      ? { amount_minor: money.amount_minor as number, currency: money.currency as string }
      : null,
  };
}

export function previewRunAuthorization(
  ctx: CouncilRouteContext,
  sessionId: string,
  body: Record<string, unknown>,
) {
  rejectUnknownKeys(
    body,
    ['route_snapshot', 'route_policy_sha256', 'ceilings', 'allowed_operation_kinds', 'account_ref', 'purpose', 'idempotency_key'],
    'run authorization preview',
  );
  if (!isRecord(body.route_snapshot)) {
    throw schemaValidation(
      'Field "route_snapshot" is required and must be the explicit CWE-008 route selection object. A preview is never built from a silent default route (Section 13).',
    );
  }
  const routeSnapshot = body.route_snapshot as unknown as CouncilRouteSelection;
  const routePolicySha256 =
    optionalString(body, 'route_policy_sha256') ?? canonicalHash({ route_snapshot: body.route_snapshot });
  const allowedKinds = body.allowed_operation_kinds;
  if (allowedKinds !== undefined && !Array.isArray(allowedKinds)) {
    throw schemaValidation('Field "allowed_operation_kinds" must be an array of operation kind strings.');
  }
  try {
    const preview = runAuthorizationService(ctx).previewRun(ctx.principal, {
      session_id: sessionId,
      purpose: optionalString(body, 'purpose') as never,
      route_snapshot: routeSnapshot,
      route_policy_sha256: routePolicySha256,
      ceilings: parseCeilings(body, ctx),
      allowed_operation_kinds: allowedKinds as string[] | undefined,
      account_ref: optionalString(body, 'account_ref') ?? null,
    });
    return {
      preview_id: preview.preview_id,
      stage: 'preview' as const,
      session_id: preview.session_id,
      purpose: preview.purpose,
      preview_sha256: preview.preview_sha256,
      route_policy_sha256: preview.route_policy_sha256,
      brief_revision: preview.brief_revision,
      brief_sha256: preview.brief_sha256,
      mode: preview.mode,
      seat_ids: preview.seat_ids,
      pack_version: preview.pack_version,
      expires_at: preview.expires_at,
      ceilings: preview.ceilings,
      money_bounded: preview.money_bounded,
      confers_authorization: false as const,
    };
  } catch (error) {
    translateRunAuthorizationError(error);
  }
}

export function approveRunAuthorization(
  ctx: CouncilRouteContext,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  rejectUnknownKeys(
    body,
    ['preview_id', 'authority_mode', 'standing_parent_grant_id', 'chosen_expires_at', 'chosen_ceilings', 'renews_grant_id', 'current_route_snapshot', 'idempotency_key'],
    'run authorization approval',
  );
  const previewId = requiredString(body, 'preview_id');
  claimKey(ctx, 'council.sessions.run_authorization.approve', idempotencyKey, {
    session_id: sessionId,
    preview_id: previewId,
    authority_mode: optionalString(body, 'authority_mode') ?? null,
  }, sessionId);
  try {
    const grant = runAuthorizationService(ctx).approveRun(ctx.principal, previewId, {
      authority_mode: (optionalString(body, 'authority_mode') ?? 'managed_principal') as never,
      standing_parent_grant_id: optionalString(body, 'standing_parent_grant_id'),
      chosen_expires_at: optionalString(body, 'chosen_expires_at'),
      chosen_ceilings: isRecord(body.chosen_ceilings)
        ? parseCeilings({ ceilings: body.chosen_ceilings }, ctx)
        : undefined,
      renews_grant_id: optionalString(body, 'renews_grant_id'),
      current_route_snapshot: isRecord(body.current_route_snapshot)
        ? (body.current_route_snapshot as unknown as CouncilRouteSelection)
        : undefined,
    });
    if (grant.session_id !== sessionId) {
      throw new CouncilApiError(
        'RUN_GRANT_SCOPE_MISMATCH',
        `The approved grant binds session ${grant.session_id}, not ${sessionId}.`,
        { status: 403, action: 'check_reference' },
      );
    }
    return {
      grant_id: grant.grant_id,
      stage: 'granted' as const,
      status: grant.status,
      session_id: grant.session_id,
      purpose: grant.purpose,
      authority_mode: grant.authority_mode,
      preview_sha256: grant.preview_sha256,
      route_policy_sha256: grant.route_policy_sha256,
      expires_at: grant.expires_at,
      ceilings: grant.ceilings,
      confers_authorization: true as const,
    };
  } catch (error) {
    translateRunAuthorizationError(error);
  }
}

/**
 * The redacted grant status view (CWE-049 composition list): summary
 * fields only — status, authority mode, purpose, expiry, parent
 * link. Scope-proof internals and secrets are never serialized.
 */
export function getRunAuthorizationStatus(
  ctx: CouncilRouteContext,
  sessionId: string,
  grantId?: string,
) {
  const service = runAuthorizationService(ctx);
  const summarize = (record: ReturnType<typeof service.loadGrantRecord>) => {
    if (!record) return null;
    return {
      grant_id: record.grant_id,
      session_id: record.session_id,
      stage: record.proof.stage,
      standing: record.proof.standing,
      status: record.status,
      authority_mode: record.authority_mode,
      purpose: record.purpose,
      expires_at: record.expires_at,
      issued_at: record.issued_at,
      parent_grant_id: record.parent_grant_id,
      max_cost_minor: record.max_cost_minor,
      currency: record.currency,
    };
  };
  if (grantId) {
    const record = service.loadGrantRecord(ctx.principal, grantId);
    if (!record || record.session_id !== sessionId) {
      throw new CouncilApiError(
        'RUN_GRANT_NOT_FOUND',
        `No run grant ${grantId} exists for session ${sessionId} in this scope.`,
        { status: 404, action: 'check_reference' },
      );
    }
    return { grants: [summarize(record)] };
  }
  const rows = ctx.store
    .handle()
    .prepare(
      `SELECT id FROM council_approvals
        WHERE tenant_id = ? AND company_id = ? AND kind = 'run_grant' AND session_id = ?
        ORDER BY issued_at DESC, id DESC`,
    )
    .all(ctx.principal.scope.tenant_id, ctx.principal.scope.company_id, sessionId) as Array<{ id: string }>;
  return {
    grants: rows
      .map((row) => summarize(service.loadGrantRecord(ctx.principal, row.id)))
      .filter((entry) => entry !== null),
  };
}

export function revokeRunAuthorization(
  ctx: CouncilRouteContext,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  rejectUnknownKeys(body, ['grant_id', 'idempotency_key'], 'run authorization revocation');
  const grantId = requiredString(body, 'grant_id');
  claimKey(ctx, 'council.sessions.run_authorization.revoke', idempotencyKey, {
    session_id: sessionId,
    grant_id: grantId,
  }, sessionId);
  try {
    const service = runAuthorizationService(ctx);
    const before = service.loadGrantRecord(ctx.principal, grantId);
    if (!before || before.session_id !== sessionId) {
      throw new CouncilApiError(
        'RUN_GRANT_NOT_FOUND',
        `No run grant ${grantId} exists for session ${sessionId} in this scope.`,
        { status: 404, action: 'check_reference' },
      );
    }
    const result = service.revokeRunGrant(ctx.principal, grantId);
    const after = service.loadGrantRecord(ctx.principal, grantId);
    return {
      grant_id: result.grant_id,
      status: result.status,
      already_final: result.already_final,
      revocation_epoch: after?.proof.revocation_epoch ?? null,
    };
  } catch (error) {
    translateRunAuthorizationError(error);
  }
}

// ---------------------------------------------------------- coordination

export function recordDecision(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  rejectUnknownKeys(
    body,
    ['decision', 'chosen_option_id', 'reason', 'verdict_revision', 'idempotency_key'],
    'client decision',
  );
  const decision = requiredString(body, 'decision');
  if (!['accept', 'reject', 'defer'].includes(decision)) {
    throw schemaValidation('Field "decision" must be one of: accept, reject, defer.');
  }
  const verdictRevision = body.verdict_revision;
  if (typeof verdictRevision !== 'number' || !Number.isInteger(verdictRevision) || verdictRevision < 0) {
    throw schemaValidation('Field "verdict_revision" is required and must be a non-negative integer.');
  }
  claimKey(ctx, 'council.sessions.decision', idempotencyKey, {
    session_id: sessionId,
    decision,
    chosen_option_id: optionalString(body, 'chosen_option_id') ?? null,
    verdict_revision: verdictRevision,
  }, sessionId);
  const record = recordClientDecision(
    { repositories: ctx.repositories, store: ctx.store },
    writeEnvelope(ctx, authorized),
    sessionId,
    {
      decision: decision as ClientDecisionChoice,
      chosen_option_id: optionalString(body, 'chosen_option_id') ?? null,
      reason: optionalString(body, 'reason') ?? null,
      verdict_revision: verdictRevision,
      actor_subject: ctx.principal.subject,
    },
  );
  return { ...record };
}

export function createFollowUp(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  rejectUnknownKeys(
    body,
    ['seat_id', 'target_seat_id', 'target_kind', 'target_department_id', 'question', 'evidence_ids', 'idempotency_key'],
    'follow-up',
  );
  const question = requiredString(body, 'question');
  const seatId = optionalString(body, 'seat_id') ?? optionalString(body, 'target_seat_id');
  const targetKind = optionalString(body, 'target_kind');
  if (!seatId) {
    throw schemaValidation(
      'A follow-up requires a target seat (seat_id). Department-targeted follow-ups are not a council operation: a follow-up consults one of the session\u2019s own advisor seats.',
    );
  }
  if (targetKind !== undefined && targetKind !== 'advisor') {
    throw schemaValidation(
      `Follow-up target_kind "${targetKind}" is not supported; council follow-ups target an advisor seat of the session.`,
    );
  }
  const evidenceIds = body.evidence_ids;
  if (evidenceIds !== undefined && !Array.isArray(evidenceIds)) {
    throw schemaValidation('Field "evidence_ids" must be an array of evidence IDs when present.');
  }
  const envelope = writeEnvelope(ctx, authorized);
  const parent = ctx.repositories.getSession(envelope, sessionId);
  if (!parent) {
    throw new CouncilApiError('PERSISTENCE_SESSION_NOT_FOUND', `No council session ${sessionId} exists in this scope.`, {
      status: 404,
      action: 'check_session_id',
    });
  }
  const result = createFollowUpSession(
    { repositories: ctx.repositories, store: ctx.store },
    envelope,
    parent,
    {
      seat_id: seatId,
      question,
      evidence_ids: (evidenceIds as string[] | undefined) ?? [],
      actor_subject: ctx.principal.subject,
      idempotency_key: idempotencyKey,
    },
  );
  return { ...result };
}

export function createRerun(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  rejectUnknownKeys(
    body,
    ['question', 'facts', 'assumptions', 'unknowns', 'constraints', 'options', 'idempotency_key'],
    'rerun',
  );
  const changes: Record<string, unknown> = {};
  for (const field of ['question', 'facts', 'assumptions', 'unknowns', 'constraints', 'options'] as const) {
    if (body[field] !== undefined) changes[field] = body[field];
  }
  if (Object.keys(changes).length === 0) {
    throw schemaValidation(
      'A rerun requires at least one changed brief field (question, facts, assumptions, unknowns, constraints, or options); a rerun with no changed facts is a duplicate, not a rerun.',
    );
  }
  const envelope = writeEnvelope(ctx, authorized);
  const parent = ctx.repositories.getSession(envelope, sessionId);
  if (!parent) {
    throw new CouncilApiError('PERSISTENCE_SESSION_NOT_FOUND', `No council session ${sessionId} exists in this scope.`, {
      status: 404,
      action: 'check_session_id',
    });
  }
  const result = createRerunSession(
    { repositories: ctx.repositories, store: ctx.store },
    envelope,
    parent,
    {
      changes: changes as never,
      actor_subject: ctx.principal.subject,
      idempotency_key: idempotencyKey,
    },
  );
  return { ...result };
}

export function recordOutcomeRoute(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  rejectUnknownKeys(
    body,
    ['observed_outcome', 'observed_at', 'verdict_revision', 'verdict_content_sha256', 'evidence_refs', 'horizon', 'idempotency_key'],
    'outcome',
  );
  const verdictRevision = body.verdict_revision;
  if (typeof verdictRevision !== 'number' || !Number.isInteger(verdictRevision) || verdictRevision < 0) {
    throw schemaValidation('Field "verdict_revision" is required and must be a non-negative integer.');
  }
  claimKey(ctx, 'council.sessions.outcomes', idempotencyKey, {
    session_id: sessionId,
    observed_outcome: requiredString(body, 'observed_outcome'),
    observed_at: requiredString(body, 'observed_at'),
    verdict_revision: verdictRevision,
    verdict_content_sha256: requiredString(body, 'verdict_content_sha256'),
    horizon: optionalString(body, 'horizon') ?? 'custom',
  }, sessionId);
  const record = recordOutcome(
    { repositories: ctx.repositories, store: ctx.store },
    writeEnvelope(ctx, authorized),
    sessionId,
    {
      observed_outcome: requiredString(body, 'observed_outcome'),
      observed_at: requiredString(body, 'observed_at'),
      verdict_revision: verdictRevision,
      verdict_content_sha256: requiredString(body, 'verdict_content_sha256'),
      evidence_refs: Array.isArray(body.evidence_refs) ? (body.evidence_refs as string[]) : [],
      horizon: optionalString(body, 'horizon'),
      actor_subject: ctx.principal.subject,
      idempotency_key: idempotencyKey,
    },
  );
  return { ...record };
}

export function archiveSessionRoute(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  rejectUnknownKeys(body, ['expected_version', 'idempotency_key'], 'session archive');
  const expectedVersion = optionalVersion(body);
  claimKey(ctx, 'council.sessions.archive', idempotencyKey, {
    session_id: sessionId,
    expected_version: expectedVersion ?? null,
  }, sessionId);
  const envelope = writeEnvelope(ctx, authorized);
  const session = ctx.repositories.getSession(envelope, sessionId);
  if (!session) {
    throw new CouncilApiError('PERSISTENCE_SESSION_NOT_FOUND', `No council session ${sessionId} exists in this scope.`, {
      status: 404,
      action: 'check_session_id',
    });
  }
  const result = archiveSession({ repositories: ctx.repositories }, envelope, session, {
    expected_version: expectedVersion,
  });
  return { ...result };
}

export function deleteSessionRoute(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  rejectUnknownKeys(body, ['confirm', 'idempotency_key'], 'session delete');
  if (body.confirm !== true) {
    throw schemaValidation(
      'Session deletion requires the explicit confirmation field "confirm": true (SessionDeleteRequest). Nothing was deleted.',
    );
  }
  claimKey(ctx, 'council.sessions.delete', idempotencyKey, { session_id: sessionId, confirm: true }, sessionId);
  const deleteEnvelope = envelopeFromScope(
    {
      tenant_id: authorized.row.tenant_id,
      company_id: authorized.row.company_id,
      installation_id: authorized.row.installation_id,
      owner_subject: authorized.row.owner_subject,
    },
    ctx.principal.subject,
    'owner',
    'delete',
  );
  const result = deleteSessionCoordinated({ repositories: ctx.repositories }, deleteEnvelope, sessionId);
  return { ...result };
}

export function getEvidenceRoute(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  evidenceId: string,
) {
  return getEvidenceEntry({ repositories: ctx.repositories }, authorized.envelope, sessionId, evidenceId);
}

// -------------------------------------------------------------- settings

export function getSettingsRoute(ctx: CouncilRouteContext) {
  return new CouncilSettingsService().getSettings({
    tenant_id: ctx.principal.scope.tenant_id,
    company_id: ctx.principal.scope.company_id,
    installation_id: ctx.principal.scope.installation_id,
  });
}

export function patchSettingsRoute(ctx: CouncilRouteContext, body: Record<string, unknown>) {
  rejectUnknownKeys(body, ['settings', 'expected_revision'], 'settings update');
  const expected = body.expected_revision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw schemaValidation('Field "expected_revision" is required and must be a non-negative integer.');
  }
  return new CouncilSettingsService().patchSettings(
    {
      tenant_id: ctx.principal.scope.tenant_id,
      company_id: ctx.principal.scope.company_id,
      installation_id: ctx.principal.scope.installation_id,
    },
    { settings: body.settings, expected_revision: expected, actor_subject: ctx.principal.subject },
  );
}

// --------------------------------------------------------------- exports

export async function createExportRoute(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  rejectUnknownKeys(
    body,
    ['session_id', 'format', 'formats', 'redaction', 'replay', 'idempotency_key'],
    'report export',
  );
  const sessionId = requiredString(body, 'session_id');
  const formatInput = optionalString(body, 'format');
  let formats;
  if (Array.isArray(body.formats)) {
    formats = (body.formats as string[]).flatMap((entry) => {
      const resolved = resolveClientFormats(entry);
      if (!resolved) {
        throw schemaValidation(`Unknown export format "${entry}". Accepted: markdown, json, print_html, pdf, all.`);
      }
      return resolved;
    });
    formats = [...new Set(formats)];
  } else {
    const resolved = resolveClientFormats(formatInput ?? 'markdown');
    if (!resolved) {
      throw schemaValidation(`Unknown export format "${formatInput}". Accepted: markdown, json, print_html, pdf, all.`);
    }
    formats = resolved;
  }
  const redaction: RedactionProfile | null = null;
  if (body.redaction !== undefined && body.redaction !== null) {
    // The CC route surface does not accept redaction profiles in
    // this composition: redacted artifacts' exact bytes cannot be
    // re-derived on later reads because replacement literals are
    // never persisted (see report-downloads). Refuse explicitly
    // rather than producing an undownloadable artifact.
    throw schemaValidation(
      'Redaction profiles are not accepted on the Command Center export surface yet; submit the export without a redaction profile.',
    );
  }
  claimKey(ctx, 'council.exports.create', idempotencyKey, {
    session_id: sessionId,
    formats,
    redaction_profile_id: null,
  }, sessionId);
  // CTR-165: the report reads the scope-bound installation snapshot. A
  // self installation is captured through the existing platform resolver;
  // a client installation is never read from disk and must have pushed its
  // own snapshot. No caller-supplied inventory enters this path.
  const capability = loadCapabilitySnapshotForPrincipal(
    ctx.store.handle(),
    ctx.principal,
    { captured_at: new Date().toISOString().slice(0, 10) },
  );
  const result = await createCouncilExport(
    { repositories: ctx.repositories, store: ctx.store },
    authorized.envelope,
    {
      session_id: sessionId,
      formats,
      redaction,
      // The export identity derives from the client's idempotency
      // key (the logical request), never from the per-HTTP-request
      // foundation ID: a replayed key must find its recorded
      // artifacts, not mint duplicates (T078).
      request_id: idempotencyKey,
      exporter_subject: ctx.principal.subject,
      via: authorized.accessVia,
      capability_snapshot: capability?.snapshot ?? null,
    },
  );
  const primary = result.artifacts[0];
  return {
    export_id: primary?.export_id ?? null,
    session_id: result.session_id,
    status: 'ready' as const,
    format: primary?.format ?? null,
    download_url: primary?.download_url ?? null,
    report_revision_id: result.report_revision_id,
    verdict_revision: result.verdict_revision,
    verdict_content_sha256: result.verdict_content_sha256,
    artifacts: result.artifacts,
    capability_snapshot: {
      present: capability !== null,
      source: capability?.source ?? null,
      captured_now: capability?.captured_now ?? false,
      item_count: capability?.snapshot.items.length ?? 0,
    },
    created_at: new Date().toISOString(),
  };
}

/**
 * Locate the session owning an export ID within the caller's scope
 * (IDs are unguessable hashes; the route still runs the full
 * session read authorization before any byte is served).
 */
export function locateExportSession(ctx: CouncilRouteContext, exportId: string): string {
  const sessionId = findExportSession(
    { repositories: ctx.repositories, store: ctx.store },
    { tenant_id: ctx.principal.scope.tenant_id, company_id: ctx.principal.scope.company_id },
    exportId,
  );
  if (!sessionId) {
    throw new CouncilApiError(
      'EXPORT_DELIVERABLE_NOT_FOUND',
      `Export ${exportId} is not a registered deliverable in this scope.`,
      { status: 404, action: 'check_export_id' },
    );
  }
  return sessionId;
}

export async function readExportDownload(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  exportId: string,
): Promise<CouncilExportDownload> {
  return readCouncilExport(
    { repositories: ctx.repositories, store: ctx.store },
    authorized.envelope,
    sessionId,
    exportId,
  );
}
