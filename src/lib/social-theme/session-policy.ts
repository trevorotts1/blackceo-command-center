/**
 * src/lib/social-theme/session-policy.ts — F27 bounded lifetimes.
 *
 * Mirrors src/lib/interview/session-policy.ts but with an INDEPENDENT
 * namespace: the social-theme invitation is a weekly cycle ticket, shorter
 * than a 30-day interview session, and the mini-app browser session is
 * bounded separately from the ticket itself (QC-F27: link expires, resume
 * survives on another device via renew).
 */
export const SOCIAL_THEME_INVITATION_TTL_SECONDS = 24 * 60 * 60;
export const SOCIAL_THEME_SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

/** POST /api/social-theme/exchange + /renew — per-IP+company sliding window. */
export const SOCIAL_THEME_EXCHANGE_RATE_LIMIT = { windowSeconds: 300, max: 20 };

/** Autosave debounce (SPEC mini-app screens: ~750 ms). */
export const SOCIAL_THEME_AUTOSAVE_DEBOUNCE_MS = 750;