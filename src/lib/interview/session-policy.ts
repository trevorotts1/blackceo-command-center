/**
 * An interview enrollment link does not expire, and is not spent by being used.
 * It stays valid until the interview it opens is complete, and only then may it
 * be refused. Three separate clocks used to end it early and none of them do now:
 *
 *   1. The ticket's own `exp`, enforced in lib/auth/tenant-context.ts. Enforced
 *      for browser SESSION grants only; an enrollment grant's `exp` is never
 *      compared to the clock.
 *   2. The one-use nonce burn in api/auth/interview-session. Now an audit record
 *      rather than a gate, so a client on a second device, with cleared cookies,
 *      or returning after the browser session lapsed can open the same link.
 *   3. The browser session lifetime below. Still bounded, and now recoverable:
 *      a lapsed session falls back to re-opening the link.
 *
 * The one thing that ends a link is completion — see enrollment-window.ts.
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

/**
 * Truthful redemption contract, published as the receipt's `redeemable`. The
 * receipt's `oneUse: true` is a legacy constant kept only so deployed
 * validators accept the receipt; this field is what actually describes it.
 */
export const INTERVIEW_INVITATION_REDEEMABLE = 'until-interview-complete';

/**
 * Browser session lifetime. Deliberately still bounded: a stolen or abandoned
 * cookie should not be permanent. It no longer strands anyone, because a lapsed
 * session re-opens the same link.
 */
export const INTERVIEW_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
