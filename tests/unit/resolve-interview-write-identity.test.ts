/**
 * resolve-interview-write-identity.test.ts
 *
 * Pins the exact defaulting logic that caused a real client P0
 * incident: POST /api/interview/answer used to default `askedBy` to the
 * literal string 'interview-web' whenever no Cf-Access email / operator email
 * / explicit body.askedBy was present -- true for EVERY Telegram-conducted or
 * otherwise unauthenticated session -- and that literal was used directly as
 * the rate-limit bucket key by update-interview-state.sh, so every
 * unauthenticated interview on a box shared one 5-per-hour budget.
 *
 * seam.resolveInterviewWriteIdentity() is the extracted, pure decision point
 * (no fs, no DB, no Next.js request needed to test it) that now:
 *   - still returns askedBy='interview-web' for the unauthenticated case
 *     (recorded verbatim in lastQuestionAskedBy -- audit trail unchanged), but
 *   - ALSO returns a resolved rateLimitSessionId in that case, so the route
 *     can pass it through to update-interview-state.sh's rate-limit key
 *     instead of the shared literal.
 *   - returns rateLimitSessionId=undefined whenever a real identity is
 *     present, so the authenticated Cf-Access/operator path's behavior
 *     (bucket key = askedBy) is preserved EXACTLY.
 *
 * Runs via the Node built-in test runner (`node:test`), discovered by
 * `npm run test:unit`'s glob.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveInterviewWriteIdentity } from '../../src/lib/interview/seam';

test('no identity at all (Telegram / unauthenticated web session) -> askedBy defaults to the literal, but a resolved session id is returned for rate-limiting', () => {
  let calls = 0;
  const fakeSessionId = () => {
    calls += 1;
    return 'session-abc-123';
  };
  const result = resolveInterviewWriteIdentity(
    { bodyAskedBy: undefined, cfAccessEmail: null, operatorEmail: null },
    fakeSessionId,
  );
  assert.equal(result.askedBy, 'interview-web', 'askedBy must still default to the literal (audit trail unchanged)');
  assert.equal(result.rateLimitSessionId, 'session-abc-123', 'a real session id must be resolved for the rate-limit key');
  assert.equal(calls, 1, 'the session-id resolver must be invoked exactly once when there is no identity');
});

test('a Cf-Access authenticated email is used as askedBy, and rateLimitSessionId is left undefined (authenticated path unchanged)', () => {
  let calls = 0;
  const fakeSessionId = () => {
    calls += 1;
    return 'should-not-be-used';
  };
  const result = resolveInterviewWriteIdentity(
    { bodyAskedBy: undefined, cfAccessEmail: 'owner@example.com', operatorEmail: null },
    fakeSessionId,
  );
  assert.equal(result.askedBy, 'owner@example.com');
  assert.equal(result.rateLimitSessionId, undefined, 'a real identity must NOT be overridden by a session id');
  assert.equal(calls, 0, 'the session-id resolver must never run when a real identity is present (avoids an unnecessary build-state read/write too)');
});

test('an explicit body.askedBy wins over headers, and rateLimitSessionId stays undefined', () => {
  const result = resolveInterviewWriteIdentity({
    bodyAskedBy: 'explicit-caller',
    cfAccessEmail: 'owner@example.com',
    operatorEmail: 'operator@example.com',
  });
  assert.equal(result.askedBy, 'explicit-caller');
  assert.equal(result.rateLimitSessionId, undefined);
});

test('an x-operator-email header is used as askedBy when no body/Cf-Access identity is present', () => {
  const result = resolveInterviewWriteIdentity({
    bodyAskedBy: undefined,
    cfAccessEmail: null,
    operatorEmail: 'operator@example.com',
  });
  assert.equal(result.askedBy, 'operator@example.com');
  assert.equal(result.rateLimitSessionId, undefined);
});

test('a body.askedBy of empty/whitespace is treated as absent (falls through to the literal + session id), never crashes', () => {
  const result = resolveInterviewWriteIdentity(
    { bodyAskedBy: '   ', cfAccessEmail: null, operatorEmail: null },
    () => 'session-xyz',
  );
  assert.equal(result.askedBy, 'interview-web');
  assert.equal(result.rateLimitSessionId, 'session-xyz');
});

test("REGRESSION PIN: the literal 'interview-web' itself is never treated as a real identity even if a caller explicitly sends it as body.askedBy -- it still gets a resolved session id, not left to collide", () => {
  // This is the exact shape a caller mimicking the Command Center's own old
  // default would send. The route's OWN default is closed by this function
  // returning the same literal either way for askedBy (harmless, audit-only),
  // but the important pin here is that resolveInterviewWriteIdentity treats a
  // present, non-empty body.askedBy as A REAL IDENTITY (by design -- an
  // explicit caller-supplied value is trusted) and therefore leaves
  // rateLimitSessionId undefined. Session-key collision safety for THIS case
  // is enforced independently, at the shell-script layer, by
  // lib-interview-rate-limit.sh's shared-literal sentinel check (see
  // 23-ai-workforce-blueprint/scripts/test-interview-rate-limit-session-key.sh
  // in the onboarding repo) -- defense in depth across the two repos.
  const result = resolveInterviewWriteIdentity({
    bodyAskedBy: 'interview-web',
    cfAccessEmail: null,
    operatorEmail: null,
  });
  assert.equal(result.askedBy, 'interview-web');
  assert.equal(
    result.rateLimitSessionId,
    undefined,
    'an explicit (even if coincidentally literal-matching) caller-supplied askedBy is trusted here; ' +
      'the shell script is the fail-safe backstop against this exact value becoming a bucket key',
  );
});
