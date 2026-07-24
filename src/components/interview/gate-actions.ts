'use server';

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

import { cookies } from 'next/headers';
import { readBuildState } from '@/lib/interview/seam';
import { INTERVIEW_COOKIE_NAME, INTERVIEW_BYPASS_COOKIE_NAME, LATCH_COOKIE_NAME, signInterviewToken, signInterviewBypassToken, signLatchToken } from '@/lib/interview/gate-cookie';

/**
 * True only on the doctrine's two terminal signals, read from the canonical
 * .workforce-build-state.json:
 *   • interviewComplete === true  — update-interview-state.sh --complete pressed
 *   • buildCompletedAt present     — the build finished (closeout reveal)
 * Anything mid-interview → false (the shell stays locked). Never throws.
 */
function deriveInterviewComplete(): boolean {
  const bs = readBuildState();
  if (!bs) return false;
  if (bs.buildCompletedAt) return true;
  if (bs.interviewComplete === true) return true;
  return false;
}

/**
 * Derive completion and (re)set the signed Edge cookie. Fire-and-forget from the
 * client shim; any failure is non-fatal because the middleware fails CLOSED to
 * /interview when the cookie is absent/unverifiable.
 */
export async function refreshInterviewGate(): Promise<void> {
  const complete = deriveInterviewComplete();
  const { value, maxAge } = await signInterviewToken(complete);
  try {
    cookies().set(INTERVIEW_COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge,
      secure: process.env.NODE_ENV === 'production',
    });
    // U010: also set the persistent latch cookie as a fallback for the middleware
    // when the main cookie is absent or expired (restart / tunnel reconnect).
    if (complete) {
      const latch = await signLatchToken();
      cookies().set(LATCH_COOKIE_NAME, latch.value, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: latch.maxAge,
        secure: process.env.NODE_ENV === 'production',
      });
    }
  } catch {
    // Non-fatal: cookies() may be read-only in some contexts; the middleware
    // fail-closed posture covers an unset cookie.
  }
}

/* U057 — Interview bypass ("Skip for now") */

export async function skipInterviewForNow(): Promise<void> {
  const { value, maxAge } = await signInterviewBypassToken();
  try { cookies().set(INTERVIEW_BYPASS_COOKIE_NAME, value, { httpOnly: true, sameSite: 'lax', path: '/', maxAge, secure: process.env.NODE_ENV === 'production' }); } catch { /* non-fatal */ }
}
