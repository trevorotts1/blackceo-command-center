// === Relay "Auth Check (enforced)" — CONSTANT-TIME COMPARE (FIX-RESCUE-11 ii/iii)
//
// WHERE THIS GOES
// ---------------
// The n8n node currently named "Auth Check (soft)" already returns a hard 403
// on a bad secret — but its comparison is a plain equality / Set membership,
// which is (a) not constant-time and (b) mislabeled "(soft)".
//
//   iii) RENAME the node "Auth Check (soft)" -> "Auth Check (enforced)" so the
//        name matches the enforced 403 behavior.
//   ii)  REPLACE the comparison body with the constant-time compare below.
//
// The expected secret must come from an n8n CREDENTIAL / env, never a hardcoded
// literal (FIX-RESCUE-04 moved it to HTTP Header Auth credentials). Read it via
// $env or a credential reference — do NOT paste the secret here.
//
//   const presented = ($json.headers && ($json.headers['x-rescue-auth'] ||
//                      $json.headers['X-Rescue-Auth'])) || '';
//   const expected  = $env.RESCUE_WEBHOOK_SECRET;           // from credential/env
//   if (!rescueAuthOk(presented, expected)) {
//     return [{ json: { status: 403, error: 'unauthorized' } }];   // enforced
//   }
//   // ... authorized: continue ...
//
// This snippet is client-name-free and secret-free.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

// Constant-time equality: hash both sides to a fixed 32-byte digest so
// timingSafeEqual is always length-safe and leaks neither length nor the
// position of the first differing byte. Mirrors
// lib/rescue-constant-time-compare.mjs so the relay and the Node code agree.
function rescueConstantTimeEqual(presented, expected) {
  if (presented == null || expected == null) return false;
  const a = crypto.createHash('sha256').update(String(presented), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// Fail-closed auth gate: deny unless a non-empty secret is configured AND the
// presented value matches it in constant time.
function rescueAuthOk(presented, expectedSecret) {
  if (!expectedSecret) return false;
  return rescueConstantTimeEqual(presented, expectedSecret);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rescueConstantTimeEqual, rescueAuthOk };
}
