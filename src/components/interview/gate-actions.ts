'use server';
import { priorCompletion } from '@/lib/interview/prior-completion';
import { verifiedBuild } from '@/lib/interview/build-verification';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { getClient } from '@/lib/clients';

/**
 * Node-runtime setter for the interview-mode shell lock (P0-5).
 *
 * The Edge middleware can't read the filesystem, so this server action is the
 * Node side of the seam: it derives interview-completion from the canonical
 * FILES and (re)mints the short-TTL signed `mc_interview_complete` cookie that
 * the middleware reads. It runs in a writable-cookie context (a Server Action),
 * which is the ONLY place Next 14 lets us call cookies().set() — a root-layout
 * Server Component render cannot (see the note on setSelectedClient in
 * src/lib/clients.ts). A tiny client shim (InterviewGateSync) invokes it on
 * every page load to keep the cookie warm.
 *
 * DERIVATION — why NOT getInterviewState() directly:
 *   The P0-5 brief suggests deriving via getInterviewState(). We deliberately
 *   derive from the AUTHORITATIVE build-state flags instead, for correctness:
 *     • getInterviewState()'s `interview-answers-file` signal fires the instant
 *       workforce-interview-answers.md EXISTS — but the Skill-23 agent writes
 *       that transcript PER ANSWER, so it exists throughout the interview. Using
 *       it would unlock the shell mid-interview, defeating the whole lock.
 *     • Merely CALLING getInterviewState() has a side effect: it auto-backfills
 *       clients.interview_complete=true from that same file-exists signal, which
 *       would poison every other completion reader mid-interview too.
 *   The doctrine says the shell unlocks "until interviewComplete/buildCompletedAt"
 *   — both are written ONLY by update-interview-state.sh --complete and the
 *   build. Deriving from those two build-state fields is exactly that contract,
 *   with no premature-unlock and no destructive backfill. Files remain the
 *   single source of truth (read-only here).
 */

import { cookies, headers } from 'next/headers';
import { readBuildState } from '@/lib/interview/seam';
import { interviewStatus, opensShell } from '@/lib/interview/interview-status';
import { INTERVIEW_COOKIE_NAME, INTERVIEW_BYPASS_COOKIE_NAME, LATCH_COOKIE_NAME, signInterviewToken, signInterviewBypassToken, signLatchToken } from '@/lib/interview/gate-cookie';

/**
 * True only on the shell-lock states of the interface contract (2.3), read from
 * the canonical .workforce-build-state.json through the ONE reader (BU-23):
 *   • COMPLETE / BUILDING / BUILT — interviewComplete, or a verified build
 *   • PLACEHOLDER                 — owner-ordered placeholder (see below)
 *   • DECLARED                    — handled by the caller, which ORs in the
 *                                   declarations-table row before this call
 * Anything mid-interview (NOT_STARTED, IN_PROGRESS, READY) → false, so the shell
 * stays locked. Never throws.
 *
 * AI Workforce standard-first (PHASE 6 item 8) — PREBUILT-PREVIEW STATE
 * AWARENESS: a standard-prebuilt box (build-state carries
 * `standardPrebuild.status === "done"`, the STANDARD_READY state) is a THIRD
 * state — files + board present, agents NOT registered, interview incomplete.
 * It must NOT mint a complete cookie: the read-only /preview surface is the
 * only early company view (middleware exemption), and the full dashboard stays
 * locked until interviewComplete. STANDARD_READY is deliberately not one of the
 * reader's shell-lock states, so it cannot mint a complete cookie by accident.
 *
 * DELIBERATE DOCTRINE EDIT (STD001, Trevor 2026-10-08): the owner-ordered
 * STANDARD PLACEHOLDER (companyMode "standard-placeholder" with
 * standardPlaceholder.status "active", written by onboarding after 14+ days
 * of an incomplete interview) DOES admit the dashboard. A bare standardReady
 * still does not. The placeholder is never interview completion.
 */
function deriveInterviewComplete(): boolean {
  const bs = readBuildState();
  if (!bs) return false;
  const status = interviewStatus(bs);
  // BUILT keeps this lock's own stricter receipt check (buildId match,
  // version 1, no unmet requirements) — EXCEPT when the interview itself is
  // complete. Completion is terminal (interface contract S-1), and the Shell
  // lock row of 2.3 opens on COMPLETE, BUILDING, BUILT, PLACEHOLDER and
  // DECLARED, so a completed interview whose build receipt has drifted must
  // not be locked out of its own dashboard. An interview that was never
  // completed still needs the receipt, so a half-verified one cannot open it.
  if (status === 'BUILT') return bs.interviewComplete === true || verifiedBuild(bs);
  return opensShell(status);
}

/**
 * Derive completion and (re)set the signed Edge cookie. Fire-and-forget from the
 * client shim; any failure is non-fatal because the middleware fails CLOSED to
 * /interview when the cookie is absent/unverifiable.
 */
export async function refreshInterviewGate(): Promise<void> {
  let context;
  try {
    context = await resolveTenantContext({ headers: new Headers(await headers()) });
  } catch (error) {
    if (!(error instanceof TenantAccessError)) throw error;
    // The public invitation shell mounts before its fragment is redeemed.
    // No verified identity means locked: never read company state or mint a
    // completion/bypass token, and discard stale gate cookies if writable.
    try {
      const jar = await cookies();
      for (const name of [INTERVIEW_COOKIE_NAME, LATCH_COOKIE_NAME, INTERVIEW_BYPASS_COOKIE_NAME]) jar.delete(name);
    } catch { /* An absent cookie also preserves the middleware's locked state. */ }
    return;
  }
  const complete=priorCompletion(context) !== null || (context.kind==='self' ? deriveInterviewComplete() : getClient(context.clientId!)?.interview_complete===true);
  const scope=`${context.tenantId}:${context.installationId}:${context.host}`;
  const { value, maxAge } = await signInterviewToken(complete,scope);
  try {
    (await cookies()).set(INTERVIEW_COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge,
      secure: process.env.NODE_ENV === 'production',
    });
    // U010: also set the persistent latch cookie as a fallback for the middleware
    // when the main cookie is absent or expired (restart / tunnel reconnect).
    if (complete) {
      const latch = await signLatchToken(scope);
      (await cookies()).set(LATCH_COOKIE_NAME, latch.value, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: latch.maxAge,
        secure: process.env.NODE_ENV === 'production',
      });
    } else { (await cookies()).delete(LATCH_COOKIE_NAME); }
  } catch {
    // Non-fatal: cookies() may be read-only in some contexts; the middleware
    // fail-closed posture covers an unset cookie.
  }
}

/* U057 — Interview bypass ("Skip for now") */

/**
 * BU-05 (WF-013): the "Skip for now" affordance is operator-only. Resolves the
 * tenant context on the server and answers a plain boolean; an unresolvable
 * context (public invitation shell, expired grant) answers false and never
 * throws, so the interview page simply renders without the control.
 */
export async function canSkipInterview(): Promise<boolean> {
  try {
    const context = await resolveTenantContext({ headers: new Headers(await headers()) });
    return context.kind === 'self' && context.subject.startsWith('operator:');
  } catch {
    return false;
  }
}

export async function skipInterviewForNow(): Promise<void> {
  const context=await resolveTenantContext({headers:new Headers(await headers())});
  if(context.kind!=='self' || !context.subject.startsWith('operator:'))throw new Error('Operator identity required');
  const { value, maxAge } = await signInterviewBypassToken();
  try { (await cookies()).set(INTERVIEW_BYPASS_COOKIE_NAME, value, { httpOnly: true, sameSite: 'lax', path: '/', maxAge, secure: process.env.NODE_ENV === 'production' }); } catch { /* non-fatal */ }
}
