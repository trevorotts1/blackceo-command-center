/**
 * CWE-007 trusted authorization adapter for Council of Wise Elders
 * surfaces (directive Sections 17.1, 17.5, 28.2).
 *
 * This is the Command Center host adapter for the trusted-authorization
 * ports. The portable decision rules live once in the canonical core
 * (openclaw-onboarding 77-council-of-wise-elders/runtime/src/
 * authorization) against the same contract terms; this module resolves
 * the principal from the ONE trusted identity mechanism this product
 * already has, src/lib/auth/tenant-context.ts, and applies the same
 * decisions at the route boundary. Cross-repo parity proof belongs to
 * CWE-045/CWE-050.
 *
 * Laws enforced here:
 *   - Scope (tenant, company, installation, subject) comes ONLY from the
 *     verified tenant context. Host headers select configuration, never
 *     authority. Body/query scope that conflicts with the trusted
 *     context is rejected, never honored (T073, T074).
 *   - Private sessions are readable only by their owner subject; company
 *     scope alone never grants a private read (T073). Support access is
 *     granted only by host configuration (MC_COUNCIL_SUPPORT_SUBJECTS),
 *     never by request input, is read-only, and is returned as an
 *     explicit via 'support' decision so callers audit it (T075).
 *   - Machine clients use the existing approved bearer mechanism and are
 *     bound to one installation, one company, a fixed operation set, and
 *     optionally one session (T077). The operator token is a
 *     server-side credential: it is never placed in a client-bound
 *     payload (assertNoConfiguredSecretsInPayload) and never accepted in
 *     a URL query parameter.
 *   - Missing auth configuration is a clear readiness error
 *     (COUNCIL_AUTH_NOT_CONFIGURED, 503), never an open API, and council
 *     surfaces inherit none of the existing public/read bypasses: every
 *     entry point here resolves a verified principal or throws.
 *   - Mutating council requests require the existing CSRF cookie proof
 *     (src/lib/csrf-protection.ts); CWE-029 wires this into its routes.
 */

import {
  requestHost,
  resolveTenantContext,
  tenantRegistration,
  TenantAccessError,
  type TenantContext,
} from '@/lib/auth/tenant-context';
import {
  CSRF_COOKIE_NAME,
  isReadOnlyMethod,
  verifyCsrfToken,
} from '@/lib/csrf-protection';
import type { ScopeFields, SessionVisibility } from '@/lib/council/contracts';

export type CouncilAuthErrorCode =
  | 'COUNCIL_UNAUTHENTICATED'
  | 'COUNCIL_AUTH_NOT_CONFIGURED'
  | 'COUNCIL_SCOPE_MISMATCH'
  | 'COUNCIL_CROSS_SCOPE'
  | 'COUNCIL_PRIVATE_OWNER_REQUIRED'
  | 'COUNCIL_PERMISSION_DENIED'
  | 'COUNCIL_MACHINE_BINDING'
  | 'COUNCIL_QUERY_CREDENTIAL'
  | 'COUNCIL_CSRF_REQUIRED'
  | 'COUNCIL_SECRET_LEAK';

/** Stable council denial. Messages never contain credential values. */
export class CouncilAuthError extends Error {
  readonly code: CouncilAuthErrorCode;
  readonly status: number;

  constructor(code: CouncilAuthErrorCode, message: string, status = 403) {
    super(message);
    this.name = 'CouncilAuthError';
    this.code = code;
    this.status = status;
  }
}

/** Permission vocabulary shared with the portable core (CWE-007). */
export type CouncilPermission =
  | 'run'
  | 'read'
  | 'evidence'
  | 'export'
  | 'approve_plan'
  | 'create_tasks'
  | 'execute'
  | 'diagnostic_capture';

export type CouncilAccessVia = 'owner' | 'company' | 'support';

/**
 * A council principal resolved from the verified tenant context. The
 * scope carries owner_subject null: a principal is a caller, not a
 * session; session scopes carry their owner.
 */
export interface CouncilPrincipal {
  readonly subject: string;
  readonly tenantKind: 'self' | 'client';
  /** 'machine' for the approved bearer/pairing subject, else 'browser'. */
  readonly channel: 'browser' | 'machine';
  /** Host-configured support authority only; never request-derived. */
  readonly supportAccess: boolean;
  readonly scope: ScopeFields;
  readonly tenant: TenantContext;
}

const MACHINE_SUBJECT = 'operator:api';

function supportSubjects(): ReadonlySet<string> {
  const raw = process.env.MC_COUNCIL_SUPPORT_SUBJECTS ?? '';
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function notConfigured(): CouncilAuthError {
  return new CouncilAuthError(
    'COUNCIL_AUTH_NOT_CONFIGURED',
    'Council authorization is not configured on this installation.',
    503,
  );
}

/**
 * Readiness probe for council surfaces: the host must resolve to a
 * tenant registration and a tenant signing secret must be configured
 * (the same secret chain tenant-context resolves from:
 * MC_TENANT_SESSION_SECRET, then MC_INTERVIEW_COOKIE_SECRET, then
 * MC_API_TOKEN; presence only, values are never read here beyond the
 * presence check). Throws COUNCIL_AUTH_NOT_CONFIGURED instead of letting
 * a surface run open.
 */
export function assertCouncilAuthConfigured(request: {
  headers: Headers;
}): void {
  try {
    tenantRegistration(requestHost(request));
  } catch {
    throw notConfigured();
  }
  if (
    !process.env.MC_TENANT_SESSION_SECRET &&
    !process.env.MC_INTERVIEW_COOKIE_SECRET &&
    !process.env.MC_API_TOKEN
  ) {
    throw notConfigured();
  }
}

/**
 * Resolve the council principal for a request. Fails closed: an
 * unconfigured installation produces COUNCIL_AUTH_NOT_CONFIGURED (503)
 * and every other identity failure produces COUNCIL_UNAUTHENTICATED
 * (403). No path returns a principal without a verified tenant context.
 */
export async function resolveCouncilPrincipal(request: {
  headers: Headers;
}): Promise<CouncilPrincipal> {
  let tenant: TenantContext;
  try {
    tenant = await resolveTenantContext(request);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      if (
        error.message === 'Tenant authentication is not configured' ||
        error.message === 'Hostname has no configured tenant'
      ) {
        throw notConfigured();
      }
      throw new CouncilAuthError(
        'COUNCIL_UNAUTHENTICATED',
        'A verified tenant identity is required for council surfaces.',
        403,
      );
    }
    throw error;
  }
  return {
    subject: tenant.subject,
    tenantKind: tenant.kind,
    channel: tenant.subject === MACHINE_SUBJECT ? 'machine' : 'browser',
    supportAccess: supportSubjects().has(tenant.subject),
    scope: {
      tenant_id: tenant.tenantId,
      company_id: tenant.companyId,
      installation_id: tenant.installationId,
      owner_subject: null,
    },
    tenant,
  };
}

/**
 * Reject claimed scope that conflicts with the trusted principal.
 * Accepts a parsed body or query record; both snake_case (contract) and
 * camelCase (Command Center) spellings are inspected. Equal values are
 * tolerated, absent values are normal, and a claimed owner is honored
 * only when the caller claims itself. Throws COUNCIL_SCOPE_MISMATCH.
 */
export function assertClaimedScopeMatches(
  principal: CouncilPrincipal,
  claimed: Record<string, unknown>,
): void {
  const fields: Array<[string, string, unknown]> = [
    ['tenant_id', principal.scope.tenant_id, claimed.tenant_id ?? claimed.tenantId],
    ['company_id', principal.scope.company_id, claimed.company_id ?? claimed.companyId],
    [
      'installation_id',
      principal.scope.installation_id,
      claimed.installation_id ?? claimed.installationId,
    ],
    ['owner_subject', principal.subject, claimed.owner_subject ?? claimed.ownerSubject],
  ];
  for (const [name, trusted, value] of fields) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value !== trusted) {
      throw new CouncilAuthError(
        'COUNCIL_SCOPE_MISMATCH',
        `Claimed ${name} does not match the trusted authorization context.`,
      );
    }
  }
}

export interface CouncilSessionTarget {
  readonly scope: ScopeFields;
  readonly visibility: SessionVisibility;
}

function scopeBarrier(
  principal: CouncilPrincipal,
  target: CouncilSessionTarget,
): void {
  if (target.scope.tenant_id !== principal.scope.tenant_id) {
    throw new CouncilAuthError(
      'COUNCIL_CROSS_SCOPE',
      'Session belongs to another tenant.',
    );
  }
  if (target.scope.company_id !== principal.scope.company_id) {
    throw new CouncilAuthError(
      'COUNCIL_CROSS_SCOPE',
      'Session belongs to another company.',
    );
  }
  if (target.scope.installation_id !== principal.scope.installation_id) {
    throw new CouncilAuthError(
      'COUNCIL_CROSS_SCOPE',
      'Session belongs to another installation.',
    );
  }
}

/**
 * The session read rule (Section 17.5). Returns how access was granted
 * so a 'support' read can be audited by the caller (T075). Throws on any
 * denial: cross-scope reads fail, and a private session read by a
 * non-owner in the same company fails with
 * COUNCIL_PRIVATE_OWNER_REQUIRED.
 */
export function assertCouncilSessionRead(
  principal: CouncilPrincipal,
  target: CouncilSessionTarget,
): CouncilAccessVia {
  scopeBarrier(principal, target);
  if (target.visibility === 'company') return 'company';
  const owner = target.scope.owner_subject;
  if (owner !== null && owner === principal.subject) return 'owner';
  if (principal.supportAccess) return 'support';
  throw new CouncilAuthError(
    'COUNCIL_PRIVATE_OWNER_REQUIRED',
    'Private council sessions are readable only by their owner.',
  );
}

/**
 * Mutation rule: same scope barrier as reads, but support access never
 * authorizes a write to a private session.
 */
export function assertCouncilSessionMutate(
  principal: CouncilPrincipal,
  target: CouncilSessionTarget,
): CouncilAccessVia {
  scopeBarrier(principal, target);
  if (target.visibility === 'company') return 'company';
  const owner = target.scope.owner_subject;
  if (owner !== null && owner === principal.subject) return 'owner';
  throw new CouncilAuthError(
    'COUNCIL_PRIVATE_OWNER_REQUIRED',
    'Private council sessions can be changed only by their owner.',
  );
}

function readCookie(headers: Headers, name: string): string | null {
  const header = headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * CSRF proof for mutating council requests, using the existing signed
 * mc_csrf_token cookie. Read-only methods are exempt, matching the
 * product's csrf-protection contract. Council routes call this in
 * addition to (never instead of) principal resolution, because the
 * middleware's same-origin passthrough is not an identity.
 */
export async function assertCouncilCsrf(request: {
  method: string;
  headers: Headers;
}): Promise<void> {
  if (isReadOnlyMethod(request.method)) return;
  const token = readCookie(request.headers, CSRF_COOKIE_NAME);
  if (!(await verifyCsrfToken(token))) {
    throw new CouncilAuthError(
      'COUNCIL_CSRF_REQUIRED',
      'A valid CSRF token is required for mutating council requests.',
    );
  }
}

/** Query parameter names that would carry a credential (Section 17.1). */
export const QUERY_CREDENTIAL_PARAMETERS: ReadonlySet<string> = new Set([
  'api_key',
  'apikey',
  'api-key',
  'access_token',
  'token',
  'key',
  'secret',
  'password',
  'auth',
  'bearer',
]);

/**
 * Reject any council request carrying a credential in its URL query
 * string, so a token can never leak through a logged URL. Throws
 * COUNCIL_QUERY_CREDENTIAL naming the parameter, never its value.
 */
export function assertNoQueryCredential(url: URL): void {
  for (const name of url.searchParams.keys()) {
    if (QUERY_CREDENTIAL_PARAMETERS.has(name.toLowerCase())) {
      throw new CouncilAuthError(
        'COUNCIL_QUERY_CREDENTIAL',
        `Credentials are not accepted in URL query parameters (${name}).`,
        400,
      );
    }
  }
}

/** A machine client's approved binding (Section 17.1, T077). */
export interface CouncilMachineBinding {
  readonly installation_id: string;
  readonly company_id: string;
  readonly operations: readonly CouncilPermission[];
  readonly session_id?: string | null;
}

/**
 * Machine-binding check. The principal must be the machine subject, the
 * request must pin the bound installation with the existing
 * x-expected-installation-id header matching the trusted context, the
 * principal's trusted scope must equal the binding, the operation must
 * be inside the binding's set, and a session-pinned binding serves only
 * that session. Throws COUNCIL_MACHINE_BINDING on any failure.
 */
export function assertMachineBinding(
  principal: CouncilPrincipal,
  headers: Headers,
  binding: CouncilMachineBinding,
  operation: CouncilPermission,
  sessionId?: string | null,
): void {
  const fail = (message: string): never => {
    throw new CouncilAuthError('COUNCIL_MACHINE_BINDING', message);
  };
  if (principal.channel !== 'machine') {
    fail('Machine operations require a machine-bound principal.');
  }
  const pinned = headers.get('x-expected-installation-id');
  if (!pinned || pinned !== principal.scope.installation_id) {
    fail('Machine requests must pin the bound installation.');
  }
  if (principal.scope.installation_id !== binding.installation_id) {
    fail('Principal is not bound to this installation.');
  }
  if (principal.scope.company_id !== binding.company_id) {
    fail('Principal is not bound to this company.');
  }
  if (!binding.operations.includes(operation)) {
    fail(`Operation ${operation} is outside this machine binding.`);
  }
  if (
    binding.session_id !== undefined &&
    binding.session_id !== null &&
    binding.session_id !== sessionId
  ) {
    fail('Machine binding is pinned to a different session.');
  }
}

function configuredSecretValues(): string[] {
  return [
    process.env.MC_API_TOKEN,
    process.env.MC_TENANT_SESSION_SECRET,
    process.env.MC_CSRF_COOKIE_SECRET,
    process.env.MC_INTERVIEW_COOKIE_SECRET,
  ].filter(
    (value): value is string =>
      typeof value === 'string' && value.length >= 8,
  );
}

/**
 * Last-line guard for the rule that the global operator token (and the
 * tenant signing secrets) never appear in any client-bound payload.
 * Serializes the payload and throws COUNCIL_SECRET_LEAK if a configured
 * credential value is present. Values are compared, never logged.
 */
export function assertNoConfiguredSecretsInPayload(payload: unknown): void {
  const secrets = configuredSecretValues();
  if (secrets.length === 0) return;
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? '';
  } catch {
    throw new CouncilAuthError(
      'COUNCIL_SECRET_LEAK',
      'Payload could not be verified safe for client delivery.',
      500,
    );
  }
  for (const secret of secrets) {
    if (serialized.includes(secret)) {
      throw new CouncilAuthError(
        'COUNCIL_SECRET_LEAK',
        'A configured credential must never appear in a client-bound payload.',
        500,
      );
    }
  }
}

/** The only principal shape a client may ever see: identity and scope, no credentials. */
export function clientSafePrincipalView(principal: CouncilPrincipal): {
  subject: string;
  channel: 'browser' | 'machine';
  tenant_kind: 'self' | 'client';
  tenant_id: string;
  company_id: string;
  installation_id: string;
  support_access: boolean;
} {
  return {
    subject: principal.subject,
    channel: principal.channel,
    tenant_kind: principal.tenantKind,
    tenant_id: principal.scope.tenant_id,
    company_id: principal.scope.company_id,
    installation_id: principal.scope.installation_id,
    support_access: principal.supportAccess,
  };
}
