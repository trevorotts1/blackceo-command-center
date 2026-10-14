/**
 * Council API foundation plumbing (CWE-029, directive Sections 17.1,
 * 17.3, 17.5, 17.6).
 *
 * Every council route runs the same opening sequence, in this order:
 *   1. Reject credentials in the URL query string (CWE-007).
 *   2. Resolve the trusted principal through CWE-007 (which resolves
 *      through the existing tenant context; missing auth configuration
 *      fails closed as COUNCIL_AUTH_NOT_CONFIGURED, 503).
 *   3. For mutations, require the CSRF cookie proof (CWE-007).
 *   4. Reject body/query scope claims that conflict with the trusted
 *      scope (CWE-007); scope is never taken from the request.
 *   5. For session routes, load the session's committed scope facts
 *      inside the principal's tenant and company, then apply the
 *      CWE-007 read or mutate rule. A session that does not exist in
 *      scope, and one the caller may not see, are deliberately the
 *      same typed not-found at this layer only when the scope barrier
 *      itself hides it; private-owner and cross-installation denials
 *      surface as their CWE-007 codes.
 *
 * No function in this module fetches tenant-private data at import
 * time; the store and repositories open per request.
 */

import { randomUUID } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import {
  assertClaimedScopeMatches,
  assertCouncilCsrf,
  assertCouncilSessionMutate,
  assertCouncilSessionRead,
  assertNoConfiguredSecretsInPayload,
  assertNoQueryCredential,
  clientSafePrincipalView,
  resolveCouncilPrincipal,
  type CouncilAccessVia,
  type CouncilPrincipal,
} from '../auth';
import {
  envelopeFromScope,
  CouncilPersistenceError,
  openCouncilRepositories,
  type CouncilEnvelope,
  type CouncilRepositories,
} from '../store';
import { openCouncilStore, type CouncilStore } from '../persistence/council-store';
import type { ScopeFields, SessionVisibility } from '../contracts';
import {
  CouncilApiError,
  errorResponse,
  featureNotReady,
  newRequestId,
  okResponse,
  schemaValidation,
} from './errors';

export { CouncilApiError, schemaValidation } from './errors';
import { endpointById, registrySummary } from './registry';
import { advisorProfileLabel, SEAT_ROSTER } from '../contracts';
import {
  buildRouteCatalog,
  credentialPresenceForSlug,
  routeDescriptorFromRegistryEntry,
} from '../providers';
import { listModels } from '@/lib/model-registry';

export interface CouncilRouteContext {
  principal: CouncilPrincipal;
  requestId: string;
  repositories: CouncilRepositories;
  store: CouncilStore;
}

/**
 * Run one council route inside the Section 17.3 envelope discipline.
 * Any error thrown by the handler is translated by errors.ts; codes
 * pass through from the canonical layer that raised them.
 */
export async function handleCouncil(
  request: NextRequest,
  fn: (ctx: CouncilRouteContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    assertNoQueryCredential(new URL(request.url));
    const principal = await resolveCouncilPrincipal(request);
    const ctx: CouncilRouteContext = {
      principal,
      requestId,
      repositories: openCouncilRepositories(),
      store: openCouncilStore(),
    };
    return await fn(ctx);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

/** Success response with the CWE-007 last-line secret guard applied. */
export function respondOk<T>(
  ctx: CouncilRouteContext,
  data: T,
  options: { status?: number; meta?: Record<string, unknown> } = {},
): NextResponse {
  assertNoConfiguredSecretsInPayload(data);
  return okResponse(data, ctx.requestId, options);
}

/** CSRF proof for mutating council requests (Section 17.1, CWE-007). */
export async function requireMutationProof(request: NextRequest): Promise<void> {
  await assertCouncilCsrf(request);
}

/**
 * Parse a JSON request body. A body that is not valid JSON returns the
 * canonical INVALID_JSON code; a body that is not an object returns
 * SCHEMA_VALIDATION. No route in this foundation accepts form data.
 */
export async function parseJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CouncilApiError('INVALID_JSON', 'The request body is not valid JSON.', {
      status: 400,
      action: 'fix_request',
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw schemaValidation('The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/** Reject body scope claims that conflict with the trusted scope. */
export function checkBodyScope(
  principal: CouncilPrincipal,
  body: Record<string, unknown>,
): void {
  assertClaimedScopeMatches(principal, body);
}

/**
 * The Section 17.1 idempotency key: the Idempotency-Key header, or the
 * body's idempotency_key field. Mutating foundation routes require it;
 * a missing key is a SCHEMA_VALIDATION failure, never a silent pass.
 */
export function requireIdempotencyKey(
  request: NextRequest,
  body: Record<string, unknown>,
  operation: string,
): string {
  const header = request.headers.get('idempotency-key');
  const candidate =
    typeof header === 'string' && header.trim().length > 0
      ? header.trim()
      : body.idempotency_key;
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw schemaValidation(
      `Mutating council requests require an idempotency key (Idempotency-Key header or idempotency_key field); ${operation} was not attempted without one.`,
    );
  }
  return candidate;
}

// ------------------------------------------------------------- sessions

export interface SessionScopeRow {
  id: string;
  tenant_id: string;
  company_id: string;
  installation_id: string;
  owner_subject: string | null;
  visibility: SessionVisibility;
  mode: string;
  state: string;
  state_version: number;
  brief_revision: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

function sessionNotFound(sessionId: string): CouncilPersistenceError {
  return new CouncilPersistenceError(
    'PERSISTENCE_SESSION_NOT_FOUND',
    `No council session ${sessionId} exists in this tenant and company scope.`,
  );
}

/**
 * Load a session's committed scope facts inside the principal's tenant
 * and company. Cross-tenant and cross-company sessions are not found
 * here by construction (the CWE-005 scope law); the CWE-007 barrier
 * then decides installation, visibility, and ownership.
 */
export function loadSessionScopeRow(
  ctx: CouncilRouteContext,
  sessionId: string,
): SessionScopeRow {
  const row = ctx.store
    .handle()
    .prepare(
      `SELECT id, tenant_id, company_id, installation_id, owner_subject, visibility,
              mode, state, state_version, brief_revision, archived, created_at, updated_at
         FROM council_sessions
        WHERE tenant_id = ? AND company_id = ? AND id = ?`,
    )
    .get(ctx.principal.scope.tenant_id, ctx.principal.scope.company_id, sessionId) as
    | SessionScopeRow
    | undefined;
  if (!row) throw sessionNotFound(sessionId);
  if (ctx.repositories.isDeleted(ctx.principal.scope.tenant_id, sessionId)) {
    throw new CouncilPersistenceError(
      'PERSISTENCE_SESSION_DELETED',
      `Council session ${sessionId} was explicitly deleted. Its content is gone from the authoritative store.`,
    );
  }
  return row;
}

export function rowScope(row: SessionScopeRow): ScopeFields {
  return {
    tenant_id: row.tenant_id,
    company_id: row.company_id,
    installation_id: row.installation_id,
    owner_subject: row.owner_subject,
  };
}

export interface AuthorizedSession {
  row: SessionScopeRow;
  accessVia: CouncilAccessVia;
  /** Read envelope for the CWE-006 store, scoped to the session. */
  envelope: CouncilEnvelope;
}

/**
 * Authorize a session read through CWE-007 and build the store read
 * envelope. Note on the support seam: the CWE-006 store's visibility
 * model predates via-support reads and keys private visibility to the
 * owner subject, so for an authorized support read the envelope
 * carries the session owner's subject with actor 'system', while the
 * route response reports the true principal and access_via 'support'
 * for audit. No journal entry is written for reads, so no actor is
 * misrecorded in the durable record.
 */
export function authorizeSessionRead(
  ctx: CouncilRouteContext,
  sessionId: string,
): AuthorizedSession {
  const row = loadSessionScopeRow(ctx, sessionId);
  const accessVia = assertCouncilSessionRead(ctx.principal, {
    scope: rowScope(row),
    visibility: row.visibility,
  });
  const actorSubject =
    accessVia === 'support' && row.owner_subject !== null
      ? row.owner_subject
      : ctx.principal.subject;
  const envelope = envelopeFromScope(
    rowScope(row),
    actorSubject,
    accessVia === 'support' ? 'system' : 'owner',
    'read',
  );
  return { row, accessVia, envelope };
}

/** Authorize a session mutation through CWE-007 (support never mutates). */
export function authorizeSessionMutate(
  ctx: CouncilRouteContext,
  sessionId: string,
): AuthorizedSession {
  const row = loadSessionScopeRow(ctx, sessionId);
  const accessVia = assertCouncilSessionMutate(ctx.principal, {
    scope: rowScope(row),
    visibility: row.visibility,
  });
  const envelope = envelopeFromScope(
    rowScope(row),
    ctx.principal.subject,
    'owner',
    'write',
  );
  return { row, accessVia, envelope };
}

// ------------------------------------------------------- not-ready routes

/**
 * The Section 17.6 not-ready route behavior, shared by every unwired
 * production endpoint: the caller is authenticated (and, for session
 * mutations, authorized against the session) and then receives the
 * typed FEATURE_NOT_READY error naming the owning unit. The endpoint
 * performs no operation, creates no identifier, and claims no success.
 */
export async function handleNotReady(
  request: NextRequest,
  contractId: string,
  options: { sessionId?: string; sessionAccess?: 'read' | 'mutate' } = {},
): Promise<NextResponse> {
  return handleCouncil(request, async (ctx) => {
    const entry = endpointById(contractId);
    const method = entry.contract.method;
    if (method !== 'GET') await requireMutationProof(request);
    if (options.sessionId) {
      if (options.sessionAccess === 'read') {
        authorizeSessionRead(ctx, options.sessionId);
      } else {
        authorizeSessionMutate(ctx, options.sessionId);
      }
    }
    throw featureNotReady(entry.owning_unit, entry.surface);
  });
}

// ------------------------------------------------------------ metadata

/** GET /api/council/capabilities data: registry and catalog metadata only. */
export function capabilitiesData(ctx: CouncilRouteContext): Record<string, unknown> {
  const catalog = modelsCatalogData();
  return {
    foundation: {
      unit: 'CWE-029',
      scope: 'foundation_contracts_and_real_safe_reads_only',
      registry_contract: 'wise-elders.endpoint-contract/v1',
      route_ownership_after_acceptance: 'CWE-050',
    },
    endpoints: registrySummary(),
    routes: catalog.summary,
    principal: clientSafePrincipalView(ctx.principal),
  };
}

/** GET /api/council/advisors data: the canonical CWE-003 seat roster. */
export function advisorsData(): Record<string, unknown> {
  return {
    seats: SEAT_ROSTER.map((seat) => ({
      seat_id: seat.seat_id,
      display_name: seat.display_name,
      lenses: [...seat.lenses],
      profile_label: advisorProfileLabel(seat.display_name),
      provenance: 'canonical_contract',
    })),
  };
}

/**
 * GET /api/council/models data: the CWE-008 explicit route catalog
 * built from the host model registry. Credential values never enter
 * the catalog (presence only, per CWE-008); routes with no recorded
 * evidence report UNTESTED with runtime_verified false.
 */
export function modelsCatalogData(): {
  routes: ReturnType<typeof buildRouteCatalog>;
  summary: { total: number; by_readiness: Record<string, number>; runtime_verified: boolean };
} {
  const descriptors = listModels().map((model) =>
    routeDescriptorFromRegistryEntry(
      model,
      credentialPresenceForSlug(model.provider) ?? {
        state: 'absent',
        envVar: null,
        source: null,
        checked: [],
      },
    ),
  );
  const routes = buildRouteCatalog(descriptors);
  const byReadiness: Record<string, number> = {};
  for (const route of routes) {
    byReadiness[route.readiness] = (byReadiness[route.readiness] ?? 0) + 1;
  }
  return {
    routes,
    summary: { total: routes.length, by_readiness: byReadiness, runtime_verified: false },
  };
}

export function newSessionId(): string {
  return randomUUID();
}
