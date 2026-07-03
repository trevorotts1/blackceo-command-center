/**
 * presentations-cert-contract.test.ts — CONTRACT lockstep between the
 * request-validation TaskStatus enum (src/lib/validation.ts) and the
 * presentations no-skip cert gate's terminal-status set
 * (src/lib/presentations-cert-gate.ts).
 *
 * Guards the July-3 P1 gap: the two files disagreed. The gate listed a
 * `'delivered'` terminal status that the validation enum has NEVER accepted, so
 * a status='delivered' PATCH was rejected with a 400 by the schema while the
 * gate still treated 'delivered' as a valid terminal state — a presentations
 * card could therefore never reach a terminal closed state through the contract.
 *
 * Agreed single-valued contract: a completed deck closes via task
 * `status='done'` + a matching `process_certificate_sha`. `'delivered'` is a
 * note the onboarding caller may record, NOT a task status.
 *
 *   node --import tsx --test tests/unit/presentations-cert-contract.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStatus, UpdateTaskSchema } from '../../src/lib/validation';
import {
  PRESENTATIONS_TERMINAL_STATUSES,
  evaluatePresentationsDoneGate,
} from '../../src/lib/presentations-cert-gate';

const VALID_SHA = 'a'.repeat(64);

// (a) No orphan terminal status can recur: every terminal status the gate
// governs MUST be a real member of the authoritative TaskStatus enum.
test('gate terminal statuses are a SUBSET of the validation.ts TaskStatus enum', () => {
  const enumValues = new Set<string>(TaskStatus.options);
  for (const s of PRESENTATIONS_TERMINAL_STATUSES) {
    assert.ok(
      enumValues.has(s),
      `terminal status "${s}" is not a member of validation.ts TaskStatus — orphan / contract drift`,
    );
  }
});

// The single terminal transition for a presentations task is 'done'; the removed
// 'delivered' orphan must NOT reappear in the gate's terminal set.
test("'done' is the presentations terminal status and 'delivered' is not", () => {
  assert.ok(PRESENTATIONS_TERMINAL_STATUSES.has('done'));
  assert.ok(!PRESENTATIONS_TERMINAL_STATUSES.has('delivered'));
});

// (b) A status='done' + valid cert PATCH is accepted: the schema validates it
// AND the presentations gate passes (persisting the newly-presented cert),
// closing the card. Anti-spoof match check is exercised in the sibling suite.
test("status='done' + valid process_certificate_sha is accepted (schema + gate)", () => {
  const parsed = UpdateTaskSchema.safeParse({
    status: 'done',
    process_certificate_sha: VALID_SHA,
  });
  assert.equal(parsed.success, true);

  const gate = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: null,
    providedCert: VALID_SHA,
  });
  assert.equal(gate.applies, true);
  assert.equal(gate.ok, true);
  assert.equal(gate.persistCert, VALID_SHA);
});

// (c) A status='delivered' PATCH is rejected by the schema (returns a 400 at the
// gate before any transition), because 'delivered' is not a TaskStatus member.
test("status='delivered' is rejected by UpdateTaskSchema", () => {
  const parsed = UpdateTaskSchema.safeParse({ status: 'delivered' });
  assert.equal(parsed.success, false);
});
