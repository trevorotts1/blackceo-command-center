/**
 * Company Headquarters — the ONE shared verified-context guard (unit B02).
 *
 * Authority: SPEC.md revision 4, S7 ("Authentication and privacy") and the frozen
 * P02 contract `evidence/contracts/storage-auth.md` §(d). Every `/api/hq/*` route
 * resolves identity through this helper and nothing else:
 *
 *   "Every `/api/hq/*` route resolves `resolveTenantContext(request)` itself through
 *    one shared proposed `requireHqContext` helper; it must receive a verified
 *    subject and installation." (SPEC S7 line 263)
 *
 * What this module is NOT allowed to do, by the same contract:
 *   • It does not fork the resolver. Identity comes from `resolveTenantContext`
 *     (`src/lib/auth/tenant-context.ts:230-255`) and from no other source —
 *     no query company, no host header alone, no arbitrary email, no default
 *     company, no unsigned header, no `development:local` (SPEC line 263).
 *   • It does not collapse subjects. The subject returned by the resolver is the
 *     subject on the context, byte for byte: Access and fallback subjects stay
 *     separate principals (SPEC line 279). There is no fallback chain, no alias
 *     table, and no name-based inference in this file.
 *   • It never holds or returns a browser secret. Cookies are passed through to
 *     the resolver; no token, gateway key or signing secret is read, echoed or
 *     stored here (acceptance: "no browser-held secret").
 *
 * Refusal shape (SPEC S7 line 267 "Authentication failure 401/403"): 401 for a
 * missing or unverifiable credential; 403 for a credential that verified but is
 * refused on this surface (shared client host, wrong installation, service bearer
 * on a browser route); 409 `company_not_bound` when identity is proven but no
 * authorized active company resolves (SPEC line 265, "not global rows").
 *
 * Codes: `hq_direct_origin_required` and `company_not_bound` are SPEC-given
 * (P01 `HQ_SPEC_ERROR_CODES`). The remaining codes below are chosen by this
 * owner because the SPEC fixes only the status for those failures
 * (interfaces.md gap G-14): `unauthenticated`, `unregistered_host`,
 * `hq_browser_identity_required`, `hq_local_identity_refused`,
 * `installation_mismatch` (the existing middleware spelling), `hq_storage_unavailable`.
 */
import {
  configuredPublicOrigin,
  requestHost,
  resolveTenantContext,
  tenantRegistration,
  TenantAccessError,
  type TenantContext,
} from '@/lib/auth/tenant-context';
import { resolveActiveCompanyId } from '@/lib/company';
import { isSentinelCompanyId } from '@/lib/db/branding-seed';

/**
 * Machine-readable context refusal. `status` is 401/403 per SPEC S7 line 267;
 * `code` lets route envelopes reuse the SPEC's named codes. `link` carries the
 * server-configured, data-free destination the refusal names (customer origin for
 * `hq_direct_origin_required`, the setup surface for `company_not_bound`); it is
 * never private data and never an identity.
 */
export class HqContextError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly link: string | null;
  constructor(
    status: number,
    code: string,
    message: string,
    opts: { retryable?: boolean; link?: string | null } = {},
  ) {
    super(message);
    this.name = 'HqContextError';
    this.status = status;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.link = opts.link ?? null;
  }
}

/**
 * Verified Headquarters context. Structurally satisfies B09's `HqChatScope`
 * (`{companyId, ownerSubject, installationId}`) so private-chat routes hand the
 * context straight to the chat service and it scopes every query on the same
 * triple this guard proved (SPEC S6 line 251, line 267).
 */
export type HqContext = {
  /** Authorized active company: the client's registered id, or the server resolver's answer for self. */
  companyId: string;
  installationId: string;
  /** The resolver's verified subject, unchanged — the one identity this request carries. */
  subject: string;
  /** Same value under the private-scope name the chat service consumes. Never independently sourced. */
  ownerSubject: string;
  host: string;
  kind: 'self' | 'client';
};

/**
 * The server-configured customer origin for a refusal, or null when none is
 * configured. On a shared client-kind host the registration's own `remoteUrl` IS
 * that customer's installation; otherwise it is this box's configured public
 * origin. Either way it is configuration, never private data.
 */
function customerOriginLink(host: string): string | null {
  const remote = tenantRegistration(host).remoteUrl;
  if (remote) {
    try {
      const url = new URL(remote);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return url.origin;
    } catch {
      /* unparseable registration target — fall through to the configured origin */
    }
  }
  return configuredPublicOrigin()?.origin ?? null;
}

/** The existing setup surface for an unbound company (SPEC S10 "render setup state"). Data-free, middleware-exempt. */
function setupLink(): string | null {
  const origin = configuredPublicOrigin()?.origin ?? null;
  return origin ? `${origin}/onboarding` : null;
}

/**
 * The same resolver, called a second time with the bearer credential removed.
 *
 * SPEC S7 line 269: browser and private-chat endpoints "refuse bearer-only
 * `operator:api` identity and require verified browser owner subject". A request
 * that carries BOTH a service bearer and a browser credential is not bearer-only,
 * so its browser identity is what authorizes it — and the only way to ask the
 * existing resolver for that, without forking it and without inventing a new
 * subject source, is to re-run it over the same headers minus `authorization`.
 * Returns null when no browser identity verifies.
 */
async function resolveBrowserIdentity(request: { headers: Headers }): Promise<TenantContext | null> {
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  try {
    return await resolveTenantContext({ headers });
  } catch {
    return null;
  }
}

/**
 * Resolve the one authorized active company for a verified identity.
 *
 * Client tenant: "Client tenant uses its registered company ID." (SPEC S7 line 265)
 * — the registry's company, never a caller-supplied selector.
 *
 * Verified self/operator: "Verified self/operator uses explicit authorized active
 * company from server resolver; if unresolved, return 409 `company_not_bound` with
 * setup link, not global rows." (line 265). A real registered identity (never
 * caller-supplied) is that explicit company. When the identity is a sentinel
 * ("default", "command-center", empty — the box has no provisioned identity),
 * this consults the repo's one canonical active-company resolver
 * (`resolveActiveCompanyId` → `resolveSeedingCompanyId`, sentinel-aware, identity
 * terminal, row order last resort) for the installation's own company. The
 * resolver is called with NO explicit identity, so it defaults to the
 * installation's own provisioned identity (`MC_COMPANY_ID` via
 * `installedCompanyIdentity`) — which is authoritative and terminal. Handing it
 * the sentinel instead would null that branch (branding-seed.ts:277) and drop the
 * resolver to its row-order last resort, letting an unrelated company row decide
 * whose data the board is scoped to. A sentinel answer is the absence of a
 * company, so that is `company_not_bound` — never global rows, never a silently
 * widened scope.
 */
function resolveAuthorizedCompany(ctx: TenantContext): string {
  const registered = (ctx.companyId ?? '').trim();
  if (ctx.kind === 'client') {
    if (!registered) {
      throw new HqContextError(409, 'company_not_bound', 'No company is bound to this Headquarters installation.', {
        link: setupLink(),
      });
    }
    return registered;
  }

  if (registered && !isSentinelCompanyId(registered)) return registered;

  let active: string | null;
  try {
    active = resolveActiveCompanyId(undefined);
  } catch {
    // Startup schema failure / C8 guard: an unavailable store is NOT an unbound
    // company, so it must not be reported as 409 (SPEC S10 "blocks Headquarters
    // writes, not a deceptive empty office").
    throw new HqContextError(503, 'hq_storage_unavailable', 'Headquarters storage is not available.', {
      retryable: true,
    });
  }
  if (!active || isSentinelCompanyId(active)) {
    throw new HqContextError(409, 'company_not_bound', 'No authorized active company is bound to this installation.', {
      link: setupLink(),
    });
  }
  return active;
}

/**
 * The one shared Headquarters context guard.
 *
 * Order is the contract:
 *   1. Host/registration — a shared client-kind host is refused BEFORE any identity
 *      work, so a client-host request gets 403 `hq_direct_origin_required` with the
 *      server-configured customer-origin link and learns nothing about identities
 *      (SPEC S7 line 269).
 *   2. Identity — through `resolveTenantContext` only; expired or missing
 *      credentials are 401, bearer-only `operator:api` is refused (line 269), and
 *      `development:local` is refused in every environment (line 263).
 *   3. Installation — when this box declares `MC_INSTALLATION_ID`, the verified
 *      installation must be that installation (line 269 "matching installation").
 *   4. Company — the one authorized active company (line 265), or 409.
 */
export async function requireHqContext(request: { headers: Headers }): Promise<HqContext> {
  let host: string;
  try {
    host = requestHost(request);
  } catch {
    throw new HqContextError(403, 'unregistered_host', 'This host is not a registered Headquarters origin.');
  }
  try {
    if (tenantRegistration(host).kind === 'client') {
      throw new HqContextError(
        403,
        'hq_direct_origin_required',
        'Headquarters is served directly by the customer installation, not the shared tenant board.',
        { link: customerOriginLink(host) },
      );
    }
  } catch (err) {
    if (err instanceof HqContextError) throw err;
    if (err instanceof TenantAccessError) {
      throw new HqContextError(403, 'unregistered_host', 'This host is not a registered Headquarters origin.');
    }
    throw err;
  }

  let ctx: TenantContext;
  try {
    ctx = await resolveTenantContext(request);
  } catch {
    throw new HqContextError(401, 'unauthenticated', 'A verified Headquarters identity is required.');
  }

  if (ctx.subject === 'operator:api') {
    const browser = await resolveBrowserIdentity(request);
    if (!browser) {
      throw new HqContextError(
        403,
        'hq_browser_identity_required',
        'Headquarters browser routes require a verified browser identity; a service bearer is not accepted here.',
      );
    }
    ctx = browser;
  }

  if (ctx.subject === 'development:local') {
    throw new HqContextError(
      403,
      'hq_local_identity_refused',
      'Headquarters never accepts the local development identity.',
    );
  }

  // Defense in depth: the registration read above and the context's own kind come
  // from the same resolver, so this cannot currently differ — asserted anyway so a
  // future change to either path cannot silently widen the direct-origin boundary.
  if (ctx.kind === 'client') {
    throw new HqContextError(
      403,
      'hq_direct_origin_required',
      'Headquarters is served directly by the customer installation, not the shared tenant board.',
      { link: customerOriginLink(host) },
    );
  }

  const expectedInstallation = (process.env.MC_INSTALLATION_ID || '').trim();
  if (expectedInstallation && ctx.installationId !== expectedInstallation) {
    throw new HqContextError(403, 'installation_mismatch', 'This request belongs to a different installation.');
  }

  const companyId = resolveAuthorizedCompany(ctx);

  return {
    companyId,
    installationId: ctx.installationId,
    subject: ctx.subject,
    ownerSubject: ctx.subject,
    host: ctx.host,
    kind: ctx.kind,
  };
}
