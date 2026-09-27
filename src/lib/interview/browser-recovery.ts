/** Browser-only recovery decisions. Saved server progress is authoritative. */
/** The link is re-openable until the interview is complete — never single-use,
 *  never a 24h clock. Sign-in help must never promise or imply a fresh link is
 *  needed when re-opening the same one works. */
export const INTERVIEW_SIGN_IN_HELP = 'Your sign-in has expired. Your saved answers are still there. Re-open your private interview link to sign in again and continue where you left off — the same link works until your interview is complete, on any device. If that link no longer opens, send “resume my interview” in your Telegram conversation with your AI assistant for a fresh one.';
/**
 * Item (8): per-code sign-in help. The interview-session exchange route is
 * ILF-005-owned — the codes below mirror its error strings read-only (never
 * redefined here) so each refusal tells the client exactly what happened and
 * what to do, instead of one generic "expired" line for every failure:
 *   session_expired_or_missing → the cookie lapsed; re-opening the link fixes it.
 *   invalid_enrollment          → the link itself is bad; request a fresh one.
 *   enrollment_session_mismatch → a different signed-in owner; sign out first.
 *   interview_already_complete  → nothing to fix; the interview is done.
 *   enrollment_unavailable      → server-side outage; retry, do not start over.
 * Unknown codes fall back to INTERVIEW_SIGN_IN_HELP. The route file stays the
 * single source of truth — if it gains a code, add it here, never the reverse.
 */
export const INTERVIEW_SESSION_ERROR_HELP: Record<string, string> = {
  session_expired_or_missing: INTERVIEW_SIGN_IN_HELP,
  invalid_enrollment: 'This interview link is not valid. Ask your operator for a fresh private link — your saved answers are still there and will resume once you sign in with it.',
  enrollment_session_mismatch: 'You are signed in as a different person than this link was issued for. Sign out, then re-open your own private interview link.',
  interview_already_complete: 'This interview is already complete — there is nothing left to sign in to. Your operator can confirm the finished result.',
  enrollment_unavailable: 'Sign-in is temporarily unavailable. Please retry; there is no need to start over.',
};
export function signInHelpForSessionError(code: string | null | undefined): string {
  if (code && Object.prototype.hasOwnProperty.call(INTERVIEW_SESSION_ERROR_HELP, code)) {
    return INTERVIEW_SESSION_ERROR_HELP[code];
  }
  return INTERVIEW_SIGN_IN_HELP;
}
export const INTERVIEW_RETRY_HELP = 'Your saved progress is temporarily unavailable. Please retry; there is no need to start over.';

export function verifiedProgress(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return state.ok === true && !!state.session && !!state.resume && !!state.structured;
}

/** A stale invitation must never override an existing authenticated session. */
export async function recoverInterviewAccess(ticket: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const current = await fetcher('/api/interview/state', { cache: 'no-store' });
    if (current.ok) return verifiedProgress(await current.json()) ? null : INTERVIEW_RETRY_HELP;
    if (current.status !== 401 && current.status !== 403) return INTERVIEW_RETRY_HELP;
    const response = await fetcher('/api/auth/interview-session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    if (response.ok) return null;
    // Item (8): read the route's own error code (ILF-005-owned strings, used
    // read-only) so the client gets the per-code message, not a generic line.
    // A non-JSON or code-less refusal falls back to the status-based default.
    if ([401, 403, 409].includes(response.status)) {
      try {
        const payload: unknown = await response.clone().json();
        const code = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).error : null;
        return signInHelpForSessionError(typeof code === 'string' ? code : null);
      } catch {
        return INTERVIEW_SIGN_IN_HELP;
      }
    }
    return INTERVIEW_RETRY_HELP;
  } catch {
    return INTERVIEW_RETRY_HELP;
  }
}

export function resumePhase(nextStructured: number | null, flags: {
  genuineTranscriptReady: boolean; decisionCoverageComplete: boolean; noUnprovenancedDeclines: boolean;
}): 'structured' | 'conversation' | 'departments' | 'review' {
  if (nextStructured !== null) return 'structured';
  if (!flags.genuineTranscriptReady) return 'conversation';
  return flags.decisionCoverageComplete && flags.noUnprovenancedDeclines ? 'review' : 'departments';
}

export function interviewDraftScope(state: { companyId?: string; installationId?: string; buildId?: string | null; session?: { interviewSessionId: string | null } } | null): string | null {
  if (!state?.companyId || !state.installationId) return null;
  const interview = state.session?.interviewSessionId || state.buildId;
  return interview ? JSON.stringify([state.companyId, state.installationId, interview]) : null;
}
