/**
 * TEST-ONLY stub for `@/lib/hq/context` (B02's owned path, not on disk in this
 * worktree). Loaded ONLY by this unit's test file through
 * `hq-stub-register.mjs`; the stub is never shipped and never imported by
 * product code. The route imports the declared contract name exactly as the
 * SPEC names it, so the call site is real and only the implementation is
 * supplied here — with a per-test injected identity.
 */
export type StubHqContext = {
  companyId: string;
  subject: string;
  installationId: string;
  kind: 'self' | 'client';
};

export async function requireHqContext(_request: unknown): Promise<StubHqContext> {
  const impl = (globalThis as unknown as { __B07_STUBS__?: { requireHqContext?: (request: unknown) => StubHqContext | Promise<StubHqContext> } }).__B07_STUBS__?.requireHqContext;
  if (impl) return impl(_request);
  return { companyId: 'co-a', subject: 'owner-a', installationId: 'inst-a', kind: 'self' };
}

/** Thrown by the injected denial paths so the route's error mapping is exercised. */
export class StubHqAccessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
