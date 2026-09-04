/**
 * webhook-signature.ts — constant-time HMAC-SHA256 verification (FIX 56).
 *
 * The same `x-webhook-signature: HMAC-SHA256(WEBHOOK_SECRET, rawBody)` scheme
 * is verified in three places with three near-duplicate copies:
 *   /api/tasks/ingest, /api/tasks/[id]/status, /api/presentations/stage-timings.
 * The ingest and stage-timings copies compared the hex digests with plain
 * `===` — a string comparison whose early-exit leaks the comparison length and
 * first differing character timing (a side channel on the HMAC output; the
 * practical exposure is minimal for a random-looking hex digest, but a signed
 * webhook gate should never trade on that assumption). This module is the ONE
 * copy: it verifies in constant time and fails closed on a wrong-length
 * signature without throwing.
 *
 * Contract:
 *   - verifyWebhookSignature(signature, rawBody) → boolean
 *       true  iff signature is the exact lowercase hex HMAC-SHA256 of rawBody
 *             keyed by WEBHOOK_SECRET (or WEBHOOK_SECRET is unset → dev mode,
 *             skip = true, the legacy zero-config behavior every consumer kept).
 *       false otherwise — including a malformed / wrong-length signature.
 *       Never throws on a wrong-length signature (timingSafeEqual throws on
 *       unequal buffer lengths; the length check runs first and returns false).
 *   - verifyWebhookSignatureStrict(signature, rawBody)
 *       Same comparison, but dev-mode skip is NOT applied: returns true only
 *       for a valid signature. For callers that refuse to trust unset-secret
 *       boxes (the stage-timings route already 503s before it gets here).
 *
 * Upgrade note (FIX 56): this module carries the constant-time comparison;
 * ingest/status may adopt it in a follow-up. It is written so the swap is one
 * import + one call.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Lowercase hexadecimal digest length of HMAC-SHA256 (64 chars). */
export const HMAC_SHA256_HEX_LENGTH = 64;

/** Constant-time string comparison; lengths must match or returns false. */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return timingSafeEqual(ab, bb);
}

function computeExpected(rawBody: string): string | null {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) return null;
  return createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
}

/**
 * Verify `x-webhook-signature` over the raw request body in constant time.
 *
 * @param signature  the header value (or null when absent)
 * @param rawBody    the EXACT bytes the request carried (request.text())
 * @returns true when valid (or when WEBHOOK_SECRET is unset — dev skip);
 *          false on absence, wrong length, or wrong digest.
 */
export function verifyWebhookSignature(signature: string | null, rawBody: string): boolean {
  const expected = computeExpected(rawBody);
  if (expected === null) return true; // Dev mode — skip validation.
  if (!signature) return false;
  return constantTimeEqualHex(signature, expected);
}

/**
 * Strict variant — identical comparison, no dev-mode skip. For callers that
 * have already established WEBHOOK_SECRET is configured (fail-loud 503 paths)
 * and want the check to be unconditional.
 */
export function verifyWebhookSignatureStrict(
  signature: string | null,
  rawBody: string,
): boolean {
  const expected = computeExpected(rawBody);
  if (expected === null) return false; // Strict: unset secret is never "valid".
  if (!signature) return false;
  return constantTimeEqualHex(signature, expected);
}

/**
 * Compute the expected hex signature (exported for tests / producers' `_sign()`
 * parity checks).
 */
export function computeWebhookSignature(rawBody: string): string | null {
  return computeExpected(rawBody);
}
