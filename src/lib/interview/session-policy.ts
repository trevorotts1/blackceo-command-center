/**
 * Interview enrollment links do NOT expire on a clock. An invitation stays
 * valid until the interview it opens is complete; only then may it be rejected.
 * The completion check lives in lib/interview/enrollment-window.ts and runs at
 * redemption (api/auth/interview-session). Browser access is bounded separately.
 */

/**
 * Legacy wire field only. The interview-invitation.v1 receipt still carries an
 * `expiresAt`, and onboarding validators already deployed across the fleet
 * bound-check it against 24h (+10s skew) before they will deliver a link. This
 * TTL keeps that field inside their bound so a box running the older validator
 * still accepts a link minted here. Nothing in redemption reads it.
 */
export const INTERVIEW_INVITATION_TTL_SECONDS = 24 * 60 * 60;

/** Truthful validity contract, published as the receipt's `validUntil`. */
export const INTERVIEW_INVITATION_VALID_UNTIL = 'interview-complete';

export const INTERVIEW_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
