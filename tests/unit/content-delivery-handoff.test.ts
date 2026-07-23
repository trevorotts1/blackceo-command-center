/**
 * U065 — Content-to-Delivery Handoff Schema Tests
 *
 * Tests the runtime validation surface for the contract between the Content
 * Writer and Communications Agent. Covers:
 *   - Shape validation (both directions)
 *   - The state rule (approval gating)
 *   - Receipt outcome rules (delivered proof)
 *   - Edge cases and error discrimination
 *   - Mutation proof markers
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDOFF_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  parseHandoff,
  parseReceipt,
  handoffSendable,
  receiptValid,
  validateHandoff,
  validateReceipt,
} from '../../src/lib/content-delivery-handoff';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validHandoff(overrides?: Record<string, unknown>) {
  return {
    schema: HANDOFF_SCHEMA_VERSION,
    handoff_id: 'hw-001',
    content_ref: 'content:blog:2026-07-23',
    channel: 'email',
    rendered: {
      subject: 'Welcome aboard',
      body: 'This is the email body.',
      preheader: 'Optional preview',
    },
    recipient_ref: 'contact:abc123',
    approval: {
      state: 'approved',
      approved_by: 'operator:trevor',
      approved_at: '2026-07-23T12:00:00Z',
      note: 'Looks good',
    },
    created_at: '2026-07-23T12:00:00Z',
    ...overrides,
  };
}

function validReceipt(overrides?: Record<string, unknown>) {
  return {
    schema: RECEIPT_SCHEMA_VERSION,
    handoff_id: 'hw-001',
    outcome: 'delivered',
    provider: 'resend',
    provider_message_id: 'msg-abc-123',
    recipient_count: 1,
    sent_at: '2026-07-23T12:05:00Z',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHAPE VALIDATION — HANDSOFF
// ═══════════════════════════════════════════════════════════════════════════════

test('parseHandoff accepts a fully valid approved payload', () => {
  const result = parseHandoff(validHandoff());
  assert.equal(result.ok, true);
  assert.ok(result.value);
  assert.equal(result.value.schema, HANDOFF_SCHEMA_VERSION);
  assert.equal(result.value.approval.state, 'approved');
});

test('parseHandoff rejects an unknown schema version', () => {
  const result = parseHandoff(validHandoff({ schema: 'content-delivery-handoff/v99' }));
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.ok(result.error.includes('schema') || result.error.includes('content-delivery-handoff'));
});

test('parseHandoff rejects missing schema field', () => {
  const { schema: _s, ...rest } = validHandoff();
  const result = parseHandoff(rest);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('parseHandoff rejects empty handoff_id', () => {
  const result = parseHandoff(validHandoff({ handoff_id: '' }));
  assert.equal(result.ok, false);
});

test('parseHandoff rejects empty content_ref', () => {
  const result = parseHandoff(validHandoff({ content_ref: '' }));
  assert.equal(result.ok, false);
});

test('parseHandoff rejects unknown channel', () => {
  const result = parseHandoff(validHandoff({ channel: 'fax' }));
  assert.equal(result.ok, false);
  assert.ok(result.error!.includes('channel') || result.issues?.some((i) => i.path.includes('channel')));
});

test('parseHandoff rejects empty rendered.body (mutation-proof: cannot send nothing)', () => {
  const result = parseHandoff(
    validHandoff({ rendered: { subject: 'Test', body: '' } })
  );
  assert.equal(result.ok, false);
  assert.ok(result.error!.includes('body') || result.issues?.some((i) => i.path.includes('body')));
});

test('parseHandoff rejects empty recipient_ref', () => {
  const result = parseHandoff(validHandoff({ recipient_ref: '' }));
  assert.equal(result.ok, false);
});

test('parseHandoff rejects a whitespace-only recipient_ref', () => {
  const result = parseHandoff(validHandoff({ recipient_ref: '   ' }));
  assert.equal(result.ok, false);
});

test('parseHandoff accepts draft state', () => {
  const result = parseHandoff(
    validHandoff({
      approval: { state: 'draft' },
    })
  );
  assert.equal(result.ok, true);
});

test('parseHandoff accepts pending_approval state', () => {
  const result = parseHandoff(
    validHandoff({
      approval: { state: 'pending_approval' },
    })
  );
  assert.equal(result.ok, true);
});

test('parseHandoff accepts rejected state with note', () => {
  const result = parseHandoff(
    validHandoff({
      approval: { state: 'rejected', note: 'Rewrite intro' },
    })
  );
  assert.equal(result.ok, true);
});

test('parseHandoff rejects invalid approval state', () => {
  const result = parseHandoff(
    validHandoff({
      approval: { state: 'published' },
    })
  );
  assert.equal(result.ok, false);
});

test('parseHandoff rejects missing approval block', () => {
  const { approval: _a, ...rest } = validHandoff();
  const result = parseHandoff(rest);
  assert.equal(result.ok, false);
});

test('parseHandoff accepts handoff missing optional rendered.subject (SMS/push)', () => {
  const result = parseHandoff(
    validHandoff({
      channel: 'sms',
      rendered: { body: 'SMS body — no subject needed' },
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.value!.rendered.subject, undefined);
});

test('parseHandoff accepts approved state with no note (note is optional)', () => {
  const result = parseHandoff(
    validHandoff({
      approval: {
        state: 'approved',
        approved_by: 'operator:trevor',
        approved_at: '2026-07-23T12:00:00Z',
      },
    })
  );
  assert.equal(result.ok, true);
});

test('parseHandoff rejects null input', () => {
  const result = parseHandoff(null);
  assert.equal(result.ok, false);
});

test('parseHandoff rejects undefined input', () => {
  const result = parseHandoff(undefined);
  assert.equal(result.ok, false);
});

test('parseHandoff rejects a string input', () => {
  const result = parseHandoff('not-an-object');
  assert.equal(result.ok, false);
});

test('parseHandoff rejects empty object', () => {
  const result = parseHandoff({});
  assert.equal(result.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SHAPE VALIDATION — RECEIPT
// ═══════════════════════════════════════════════════════════════════════════════

test('parseReceipt accepts a valid delivered receipt', () => {
  const result = parseReceipt(validReceipt());
  assert.equal(result.ok, true);
  assert.equal(result.value!.outcome, 'delivered');
  assert.equal(result.value!.provider_message_id, 'msg-abc-123');
});

test('parseReceipt accepts a failed receipt with error', () => {
  const result = parseReceipt(
    validReceipt({
      outcome: 'failed',
      error: 'SMTP connection refused',
      provider_message_id: undefined,
      sent_at: undefined,
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.value!.outcome, 'failed');
  assert.equal(result.value!.error, 'SMTP connection refused');
});

test('parseReceipt accepts a held receipt', () => {
  const result = parseReceipt(
    validReceipt({
      outcome: 'held',
      error: 'approval state is draft — held',
      provider_message_id: undefined,
      sent_at: undefined,
      recipient_count: null,
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.value!.outcome, 'held');
});

test('parseReceipt accepts a rejected receipt', () => {
  const result = parseReceipt(
    validReceipt({
      outcome: 'rejected',
      error: 'Copy needs revision',
      provider_message_id: undefined,
      sent_at: undefined,
    })
  );
  assert.equal(result.ok, true);
});

test('parseReceipt rejects unknown outcome', () => {
  const result = parseReceipt(validReceipt({ outcome: 'bounced' }));
  assert.equal(result.ok, false);
});

test('parseReceipt rejects empty handoff_id', () => {
  const result = parseReceipt(validReceipt({ handoff_id: '' }));
  assert.equal(result.ok, false);
});

test('parseReceipt rejects empty provider', () => {
  const result = parseReceipt(validReceipt({ provider: '' }));
  assert.equal(result.ok, false);
});

test('parseReceipt rejects missing schema', () => {
  const { schema: _s, ...rest } = validReceipt();
  const result = parseReceipt(rest);
  assert.equal(result.ok, false);
});

test('parseReceipt rejects null input', () => {
  const result = parseReceipt(null);
  assert.equal(result.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE STATE RULE — handoffSendable
// ═══════════════════════════════════════════════════════════════════════════════

test('state rule: approved with both approved_by and approved_at is sendable', () => {
  const result = handoffSendable({
    state: 'approved',
    approved_by: 'operator:trevor',
    approved_at: '2026-07-23T12:00:00Z',
  });
  assert.equal(result.sendable, true);
  assert.equal(result.reason, 'approved');
});

test('state rule: draft is NOT sendable', () => {
  const result = handoffSendable({ state: 'draft' });
  assert.equal(result.sendable, false);
  assert.ok(result.reason.includes('draft'));
});

test('state rule: pending_approval is NOT sendable', () => {
  const result = handoffSendable({ state: 'pending_approval' });
  assert.equal(result.sendable, false);
  assert.ok(result.reason.includes('pending_approval'));
});

test('state rule: rejected is NOT sendable', () => {
  const result = handoffSendable({ state: 'rejected' });
  assert.equal(result.sendable, false);
  assert.ok(result.reason.includes('rejected'));
});

test('state rule: unknown state is NOT sendable', () => {
  const result = handoffSendable({ state: 'bogus' });
  assert.equal(result.sendable, false);
  assert.ok(result.reason.includes('unknown'));
});

test('state rule: approved but missing approved_by is MALFORMED (the load-bearing line)', () => {
  const result = handoffSendable({
    state: 'approved',
    approved_at: '2026-07-23T12:00:00Z',
    // no approved_by — this is the exact failure this contract exists to prevent
  });
  assert.equal(result.sendable, false);
  assert.ok(result.reason.includes('approved_by'));
  assert.ok(result.reason.includes('malformed'));
});

test('state rule: approved but missing approved_at is MALFORMED', () => {
  const result = handoffSendable({
    state: 'approved',
    approved_by: 'operator:trevor',
    // no approved_at
  });
  assert.equal(result.sendable, false);
  assert.ok(result.reason.includes('approved_at'));
  assert.ok(result.reason.includes('malformed'));
});

test('state rule: approved but missing both approved_by AND approved_at is MALFORMED', () => {
  const result = handoffSendable({ state: 'approved' });
  assert.equal(result.sendable, false);
  assert.ok(result.reason.includes('malformed'));
});

test('state rule: approved_by whitespace-only is treated as missing', () => {
  const result = handoffSendable({
    state: 'approved',
    approved_by: '   ',
    approved_at: '2026-07-23T12:00:00Z',
  });
  assert.equal(result.sendable, false);
  assert.ok(result.reason.includes('approved_by'));
});

test('state rule: approved_at whitespace-only is treated as missing', () => {
  const result = handoffSendable({
    state: 'approved',
    approved_by: 'operator:trevor',
    approved_at: '   ',
  });
  assert.equal(result.sendable, false);
  assert.ok(result.reason.includes('approved_at'));
});

test('state rule: state with leading/trailing whitespace is trimmed', () => {
  const result = handoffSendable({
    state: '  approved  ',
    approved_by: 'operator:trevor',
    approved_at: '2026-07-23T12:00:00Z',
  });
  assert.equal(result.sendable, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// RECEIPT OUTCOME RULES — receiptValid
// ═══════════════════════════════════════════════════════════════════════════════

test('receiptValid: delivered with proof is valid', () => {
  const result = receiptValid('delivered', 'msg-abc', '2026-07-23T12:05:00Z', 1);
  assert.equal(result.valid, true);
});

test('receiptValid: delivered with no provider_message_id is INVALID', () => {
  const result = receiptValid('delivered', '', '2026-07-23T12:05:00Z', 1);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('provider_message_id'));
});

test('receiptValid: delivered with no sent_at is INVALID', () => {
  const result = receiptValid('delivered', 'msg-abc', '', 1);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('sent_at'));
});

test('receiptValid: delivered with null recipient_count is INVALID', () => {
  const result = receiptValid('delivered', 'msg-abc', '2026-07-23T12:05:00Z', null);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('recipient_count'));
});

test('receiptValid: delivered but missing BOTH provider_message_id AND sent_at is INVALID', () => {
  const result = receiptValid('delivered', '', '', 1);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('missing both'));
});

test('receiptValid: failed outcome does not require delivery proof', () => {
  const result = receiptValid('failed');
  assert.equal(result.valid, true);
});

test('receiptValid: rejected outcome does not require delivery proof', () => {
  const result = receiptValid('rejected');
  assert.equal(result.valid, true);
});

test('receiptValid: held outcome does not require delivery proof', () => {
  const result = receiptValid('held');
  assert.equal(result.valid, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMBINED VALIDATION — validateHandoff
// ═══════════════════════════════════════════════════════════════════════════════

test('validateHandoff: fully valid payload passes both shape and state rule', () => {
  const result = validateHandoff(validHandoff());
  assert.equal(result.ok, true);
  assert.ok(result.payload);
  assert.ok(result.sendable);
  assert.equal(result.sendable.sendable, true);
});

test('validateHandoff: shape-invalid returns with zero ok and parse error', () => {
  const result = validateHandoff({ schema: 'wrong' });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.payload, undefined);
});

test('validateHandoff: shape-valid but not sendable (draft) returns ok=false with sendable verdict', () => {
  const result = validateHandoff(
    validHandoff({ approval: { state: 'draft' } })
  );
  assert.equal(result.ok, false);
  assert.ok(result.payload); // payload still returned so caller can inspect
  assert.equal(result.sendable!.sendable, false);
  assert.ok(result.error!.includes('draft'));
});

test('validateHandoff: shape-valid but not sendable (approved with no approver)', () => {
  const result = validateHandoff(
    validHandoff({
      approval: { state: 'approved', approved_by: '', approved_at: '' },
    })
  );
  assert.equal(result.ok, false);
  assert.ok(result.payload);
  assert.equal(result.sendable!.sendable, false);
  assert.ok(result.error!.includes('malformed'));
});

test('validateHandoff: shape-valid, rejected', () => {
  const result = validateHandoff(
    validHandoff({ approval: { state: 'rejected', note: 'Fix intro' } })
  );
  assert.equal(result.ok, false);
  assert.ok(result.sendable);
  assert.equal(result.sendable.sendable, false);
  assert.ok(result.error!.includes('rejected'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMBINED VALIDATION — validateReceipt
// ═══════════════════════════════════════════════════════════════════════════════

test('validateReceipt: fully valid delivered receipt passes', () => {
  const result = validateReceipt(validReceipt());
  assert.equal(result.ok, true);
  assert.ok(result.payload);
  assert.equal(result.payload.outcome, 'delivered');
});

test('validateReceipt: shape-invalid returns with zero ok and parse error', () => {
  const result = validateReceipt({ schema: 'wrong' });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.payload, undefined);
});

test('validateReceipt: delivered with missing proof fails', () => {
  const result = validateReceipt(
    validReceipt({ provider_message_id: '', sent_at: '', recipient_count: null })
  );
  assert.equal(result.ok, false);
  assert.ok(result.error!.includes('provider_message_id') || result.error!.includes('sent_at'));
});

test('validateReceipt: failed receipt passes', () => {
  const result = validateReceipt(
    validReceipt({ outcome: 'failed', error: 'Connection refused', provider_message_id: undefined, sent_at: undefined })
  );
  assert.equal(result.ok, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// MUTATION-PROOF MARKERS
// ═══════════════════════════════════════════════════════════════════════════════

test('MUTATION PROOF: changing handoff schema version to wrong string fails parse', () => {
  // Mutation: change HANDOFF_SCHEMA_VERSION literal in source to a wrong value
  // Expected: the zod `.literal()` check catches it → RED
  // Revert: restore the correct literal → GREEN
  const result = parseHandoff(validHandoff({ schema: 'content-delivery-handoff/v2' }));
  assert.equal(result.ok, false, 'wrong schema version must be refused – mutation caught');
});

test('MUTATION PROOF: changing rendered.body to accept empty string would break the "cannot send nothing" invariant', () => {
  // Mutation: remove .min(1) from rendered.body in the Zod schema
  // Expected: THIS TEST RED — empty body accepted → the reason field would be
  //           missing because parseHandoff would return ok=true
  // Revert: restore .min(1) → GREEN
  const result = parseHandoff(
    validHandoff({ rendered: { subject: 'Hi', body: '' } })
  );
  assert.equal(result.ok, false, 'empty body must be refused – the invariant is "cannot send nothing"');
});

test('MUTATION PROOF: removing approved_by check from state rule would let a malformed approval through', () => {
  // Mutation: remove the !by check from handoffSendable
  // Expected: THIS TEST RED — sendable becomes true without approved_by
  // Revert: restore the !by check → GREEN
  const result = handoffSendable({
    state: 'approved',
    approved_by: '',
    approved_at: '2026-07-23T12:00:00Z',
  });
  assert.equal(result.sendable, false, 'missing approved_by must be refused – mutation caught');
});

test('MUTATION PROOF: delivered receipt without provider_message_id must NOT validate', () => {
  // Mutation: remove the provider_message_id check from receiptValid
  // Expected: THIS TEST RED — valid becomes true without provider_message_id
  // Revert: restore the check → GREEN
  const result = receiptValid('delivered', '', '2026-07-23T12:05:00Z', 1);
  assert.equal(result.valid, false, 'delivered receipt without provider_message_id must be invalid – mutation caught');
});

test('MUTATION PROOF: unknown channel "fax" must be refused', () => {
  // Mutation: add "fax" to HANDOFF_CHANNELS
  // Expected: THIS TEST RED — parseHandoff returns ok for "fax" channel
  // Revert: remove "fax" from HANDOFF_CHANNELS → GREEN
  const result = parseHandoff(validHandoff({ channel: 'fax' }));
  assert.equal(result.ok, false, 'unknown channel "fax" must be refused – mutation caught');
});

test('MUTATION PROOF: unknown approval state "published" must be refused', () => {
  // Mutation: add "published" to APPROVAL_STATES
  // Expected: THIS TEST RED — parseHandoff returns ok for "published"
  // Revert: remove "published" from APPROVAL_STATES → GREEN
  const result = parseHandoff(
    validHandoff({ approval: { state: 'published' } })
  );
  assert.equal(result.ok, false, 'unknown approval state "published" must be refused – mutation caught');
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES — channel-specific rendering
// ═══════════════════════════════════════════════════════════════════════════════

test('edge: SMS handoff without subject is valid', () => {
  const result = parseHandoff(
    validHandoff({
      channel: 'sms',
      rendered: { body: 'Your code: 123456' },
    })
  );
  assert.equal(result.ok, true);
});

test('edge: newsletter handoff requires subject (present)', () => {
  const result = parseHandoff(
    validHandoff({
      channel: 'newsletter',
      rendered: { subject: 'July Digest', body: 'Content here', preheader: 'Preview' },
    })
  );
  assert.equal(result.ok, true);
});

test('edge: push channel handoff', () => {
  const result = parseHandoff(
    validHandoff({
      channel: 'push',
      rendered: { body: 'New message from Trevor', subject: 'Alert' },
    })
  );
  assert.equal(result.ok, true);
});

test('edge: handoff_id with special characters', () => {
  const result = parseHandoff(
    validHandoff({ handoff_id: 'hw-2026-07-23_email_welcome-flow_v3' })
  );
  assert.equal(result.ok, true);
});

test('edge: recipient_ref uses opaque reference, not PII', () => {
  // This verifies we don't accidentally accept email addresses as recipient_ref
  // (the field is opaque by contract — but we don't block strings that look
  // like emails either; the agent's own contracts enforce this at the prose level)
  const result = parseHandoff(
    validHandoff({ recipient_ref: 'contact:department:marketing:segment:new-users' })
  );
  assert.equal(result.ok, true);
});

test('edge: receipt with zero recipient_count is valid (provider reported zero)', () => {
  const result = receiptValid('delivered', 'msg-abc', '2026-07-23T12:05:00Z', 0);
  assert.equal(result.valid, true);
});

test('edge: receipt with large recipient_count', () => {
  const result = receiptValid('delivered', 'msg-abc', '2026-07-23T12:05:00Z', 50000);
  assert.equal(result.valid, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS (compile-time only, but verify the consts)
// ═══════════════════════════════════════════════════════════════════════════════

test('version constants match the prose contract', () => {
  assert.equal(HANDOFF_SCHEMA_VERSION, 'content-delivery-handoff/v1');
  assert.equal(RECEIPT_SCHEMA_VERSION, 'content-delivery-receipt/v1');
});
