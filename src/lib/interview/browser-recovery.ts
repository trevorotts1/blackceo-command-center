/** Browser-only recovery decisions. Saved server progress is authoritative. */
/** The link is re-openable until the interview is complete — never single-use,
 *  never a 24h clock. Sign-in help must never promise or imply a fresh link is
 *  needed when re-opening the same one works. */
export const INTERVIEW_SIGN_IN_HELP = 'Your sign-in has expired. Your saved answers are still there. Re-open your private interview link to sign in again and continue where you left off — the same link works until your interview is complete, on any device. If that link no longer opens, send “resume my interview” in your Telegram conversation with your AI assistant for a fresh one.';
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
    return [401, 403, 409].includes(response.status) ? INTERVIEW_SIGN_IN_HELP : INTERVIEW_RETRY_HELP;
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
