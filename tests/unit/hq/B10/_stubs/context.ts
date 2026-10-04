/**
 * PRIVATE TEST STUB — declares the B02 seam (`CC:src/lib/hq/context.ts`) that this
 * unit's routes import and that does not exist yet on branch `hq/contracts`.
 *
 * swarm-plan `base_policy`: "Contract consumers import declared names and use existing
 * test mocks/private test stubs only for absent implementations; never ship mocks."
 * This file is test-only: it is reached through the `paths` override in
 * `tests/unit/hq/B10/tsconfig.b10.json`, never by a shipped route in a real build.
 *
 * The names below are the declared interface B10 requires of B02, taken from SPEC S7
 * line 263 ("Every `/api/hq/*` route resolves `resolveTenantContext(request)` itself
 * through one shared proposed `requireHqContext` helper; it must receive a verified
 * subject and installation") and the P02 contract §(d) refusal matrix. Assembly must
 * provide the real module; a mismatch is an INTERFACE_PASS build error, not a silent
 * substitution.
 */

/** Machine-readable context refusal. Status 401/403 per SPEC S7 line 267; a `code` is
 *  carried so route envelopes can reuse the SPEC's named codes (e.g. `company_not_bound`,
 *  `hq_direct_origin_required` from P01's HQ_SPEC_ERROR_CODES) when the resolver has one. */
export class HqContextError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = 'HqContextError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Verified identity + installation + resolved company. `subject` is the verified
 *  browser owner subject B09 binds private turns to; it is never a request-supplied
 *  value (SPEC S7 line 265/269). */
export interface HqContext {
  companyId: string;
  installationId: string;
  subject: string;
  host: string;
  kind: 'self' | 'client';
}

interface Control {
  calls: number;
  next: HqContext | HqContextError | null;
}

export const __hqContextControl: Control = { calls: 0, next: null };

export async function requireHqContext(_request: { headers: Headers }): Promise<HqContext> {
  __hqContextControl.calls += 1;
  const next = __hqContextControl.next;
  if (next instanceof HqContextError) throw next;
  if (!next) throw new Error('stub not armed: set __hqContextControl.next');
  return next;
}
