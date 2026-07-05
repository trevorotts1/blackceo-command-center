// === Rescue Rangers — CONSTANT-TIME SECRET COMPARE (FIX-RESCUE-11 ii) =======
//
// The relay's inbound auth check compared the presented secret with plain
// JavaScript equality / Set membership — an early-exit, input-length-dependent
// comparison that leaks timing about how many leading bytes matched. This util
// replaces it with a constant-time compare.
//
// BOTH sides are first hashed to a fixed 32-byte SHA-256 digest, so:
//   * `timingSafeEqual` never throws on a length mismatch (its inputs are
//     always equal length), and
//   * the comparison leaks neither the secret's length nor a byte-position of
//     first difference.
//
// This is client-name-free and secret-free: the expected secret is always
// passed in by the caller (read from the credential store), never hardcoded.
// ---------------------------------------------------------------------------

import { createHash, timingSafeEqual } from "node:crypto";

// Constant-time equality of two strings/buffers. Returns false for nullish on
// either side (an absent presented token can never equal a configured secret).
export function constantTimeEqual(presented, expected) {
  if (presented == null || expected == null) return false;
  const a = createHash("sha256").update(String(presented), "utf8").digest();
  const b = createHash("sha256").update(String(expected), "utf8").digest();
  // Both are 32 bytes, so timingSafeEqual is always length-safe.
  return timingSafeEqual(a, b);
}

// Convenience for a header-style check: true only when a non-empty secret is
// configured AND the presented value matches it in constant time.
export function authHeaderOk(presented, expectedSecret) {
  if (!expectedSecret) return false; // fail closed: no configured secret => deny
  return constantTimeEqual(presented, expectedSecret);
}
