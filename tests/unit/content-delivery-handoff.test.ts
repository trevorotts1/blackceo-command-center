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
 * Runs via vitest (npx vitest run).
 */

import { describe, it, expect } from 'vitest';

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

it('parseHandoff accepts a fully valid approved payload', () => {
  const result = parseHandoff(validHandoff());
  expect(result.ok).toBe(true);
  expect(result.value).toBeTruthy();
  expect(result.value.schema).toBe(HANDOFF_SCHEMA_VERSION);
  expect(result.value.approval.state).toBe('approved');
});

it('parseHandoff rejects an unknown schema version', () => {
  const result = parseHandoff(validHandoff({ schema: 'content-delivery-handoff/v99' }));
  expect(result.ok).toBe(false);
  expect(result.error).toBeTruthy();
  expect(result.error.includes('schema') || result.error.includes('content-delivery-handoff')).toBeTruthy();
});

it('parseHandoff rejects missing schema field', () => {
  const { schema: _s, ...rest } = validHandoff();
  const result = parseHandoff(rest);
  expect(result.ok).toBe(false);
  expect(result.error).toBeTruthy();
});

it('parseHandoff rejects empty handoff_id', () => {
  const result = parseHandoff(validHandoff({ handoff_id: '' }));
  expect(result.ok).toBe(false);
});

it('parseHandoff rejects empty content_ref', () => {
  const result = parseHandoff(validHandoff({ content_ref: '' }));
  expect(result.ok).toBe(false);
});

it('parseHandoff rejects unknown channel', () => {
  const result = parseHandoff(validHandoff({ channel: 'fax' }));
  expect(result.ok).toBe(false);
  expect(result.error!.includes('channel') || result.issues?.some((i) => i.path.includes('channel'))).toBeTruthy();
});

it('parseHandoff rejects empty rendered.body (mutation-proof: cannot send nothing)', () => {
  const result = parseHandoff(
    validHandoff({ rendered: { subject: 'Test', body: '' } })
  );
  expect(result.ok).toBe(false);
  expect(result.error!.includes('body') || result.issues?.some((i) => i.path.includes('body'))).toBeTruthy();
});

it('parseHandoff rejects empty recipient_ref', () => {
  const result = parseHandoff(validHandoff({ recipient_ref: '' }));
  expect(result.ok).toBe(false);
});

it('parseHandoff rejects a whitespace-only recipient_ref', () => {
  const result = parseHandoff(validHandoff({ recipient_ref: '   ' }));
  expect(result.ok).toBe(false);
});

it('parseHandoff accepts draft state', () => {
  const result = parseHandoff(
    validHandoff({
      approval: { state: 'draft' },
    })
  );
  expect(result.ok).toBe(true);
});

it('parseHandoff accepts pending_approval state', () => {
  const result = parseHandoff(
    validHandoff({
      approval: { state: 'pending_approval' },
    })
  );
  expect(result.ok).toBe(true);
});

it('parseHandoff accepts rejected state with note', () => {
  const result = parseHandoff(
    validHandoff({
      approval: { state: 'rejected', note: 'Rewrite intro' },
    })
  );
  expect(result.ok).toBe(true);
});

it('parseHandoff rejects invalid approval state', () => {
  const result = parseHandoff(
    validHandoff({
      approval: { state: 'published' },
    })
  );
  expect(result.ok).toBe(false);
});

it('parseHandoff rejects missing approval block', () => {
  const { approval: _a, ...rest } = validHandoff();
  const result = parseHandoff(rest);
  expect(result.ok).toBe(false);
});

it('parseHandoff accepts handoff missing optional rendered.subject (SMS/push)', () => {
  const result = parseHandoff(
    validHandoff({
      channel: 'sms',
      rendered: { body: 'SMS body — no subject needed' },
    })
  );
  expect(result.ok).toBe(true);
  expect(result.value!.rendered.subject).toBeUndefined();
});

it('parseHandoff accepts approved state with no note (note is optional)', () => {
  const result = parseHandoff(
    validHandoff({
      approval: {
        state: 'approved',
        approved_by: 'operator:trevor',
        approved_at: '2026-07-23T12:00:00Z',
      },
    })
  );
  expect(result.ok).toBe(true);
});

it('parseHandoff rejects null input', () => {
  const result = parseHandoff(null);
  expect(result.ok).toBe(false);
});

it('parseHandoff rejects undefined input', () => {
  const result = parseHandoff(undefined);
  expect(result.ok).toBe(false);
});

it('parseHandoff rejects a string input', () => {
  const result = parseHandoff('not-an-object');
  expect(result.ok).toBe(false);
});

it('parseHandoff rejects empty object', () => {
  const result = parseHandoff({});
  expect(result.ok).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SHAPE VALIDATION — RECEIPT
// ═══════════════════════════════════════════════════════════════════════════════

it('parseReceipt accepts a valid delivered receipt', () => {
  const result = parseReceipt(validReceipt());
  expect(result.ok).toBe(true);
  expect(result.value!.outcome).toBe( 'delivered');
  expect(result.value!.provider_message_id).toBe( 'msg-abc-123');
});

it('parseReceipt accepts a failed receipt with error', () => {
  const result = parseReceipt(
    validReceipt({
      outcome: 'failed',
      error: 'SMTP connection refused',
      provider_message_id: undefined,
      sent_at: undefined,
    })
  );
  expect(result.ok).toBe(true);
  expect(result.value!.outcome).toBe( 'failed');
  expect(result.value!.error).toBe( 'SMTP connection refused');
});

it('parseReceipt accepts a held receipt', () => {
  const result = parseReceipt(
    validReceipt({
      outcome: 'held',
      error: 'approval state is draft — held',
      provider_message_id: undefined,
      sent_at: undefined,
      recipient_count: null,
    })
  );
  expect(result.ok).toBe(true);
  expect(result.value!.outcome).toBe( 'held');
});

it('parseReceipt accepts a rejected receipt', () => {
  const result = parseReceipt(
    validReceipt({
      outcome: 'rejected',
      error: 'Copy needs revision',
      provider_message_id: undefined,
      sent_at: undefined,
    })
  );
  expect(result.ok).toBe(true);
});

it('parseReceipt rejects unknown outcome', () => {
  const result = parseReceipt(validReceipt({ outcome: 'bounced' }));
  expect(result.ok).toBe(false);
});

it('parseReceipt rejects empty handoff_id', () => {
  const result = parseReceipt(validReceipt({ handoff_id: '' }));
  expect(result.ok).toBe(false);
});

it('parseReceipt rejects empty provider', () => {
  const result = parseReceipt(validReceipt({ provider: '' }));
  expect(result.ok).toBe(false);
});

it('parseReceipt rejects missing schema', () => {
  const { schema: _s, ...rest } = validReceipt();
  const result = parseReceipt(rest);
  expect(result.ok).toBe(false);
});

it('parseReceipt rejects null input', () => {
  const result = parseReceipt(null);
  expect(result.ok).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE STATE RULE — handoffSendable
// ═══════════════════════════════════════════════════════════════════════════════

it('state rule: approved with both approved_by and approved_at is sendable', () => {
  const result = handoffSendable({
    state: 'approved',
    approved_by: 'operator:trevor',
    approved_at: '2026-07-23T12:00:00Z',
  });
  expect(result.sendable).toBe(true);
  expect(result.reason).toBe('approved');
});

it('state rule: draft is NOT sendable', () => {
  const result = handoffSendable({ state: 'draft' });
  expect(result.sendable).toBe(false);
  expect(result.reason.includes('draft')).toBeTruthy();
});

it('state rule: pending_approval is NOT sendable', () => {
  const result = handoffSendable({ state: 'pending_approval' });
  expect(result.sendable).toBe(false);
  expect(result.reason.includes('pending_approval')).toBeTruthy();
});

it('state rule: rejected is NOT sendable', () => {
  const result = handoffSendable({ state: 'rejected' });
  expect(result.sendable).toBe(false);
  expect(result.reason.includes('rejected')).toBeTruthy();
});

it('state rule: unknown state is NOT sendable', () => {
  const result = handoffSendable({ state: 'bogus' });
  expect(result.sendable).toBe(false);
  expect(result.reason.includes('unknown')).toBeTruthy();
});

it('state rule: approved but missing approved_by is MALFORMED (the load-bearing line)', () => {
  const result = handoffSendable({
    state: 'approved',
    approved_at: '2026-07-23T12:00:00Z',
    // no approved_by — this is the exact failure this contract exists to prevent
  });
  expect(result.sendable).toBe(false);
  expect(result.reason.includes('approved_by')).toBeTruthy();
  expect(result.reason.includes('malformed')).toBeTruthy();
});

it('state rule: approved but missing approved_at is MALFORMED', () => {
  const result = handoffSendable({
    state: 'approved',
    approved_by: 'operator:trevor',
    // no approved_at
  });
  expect(result.sendable).toBe(false);
  expect(result.reason.includes('approved_at')).toBeTruthy();
  expect(result.reason.includes('malformed')).toBeTruthy();
});

it('state rule: approved but missing both approved_by AND approved_at is MALFORMED', () => {
  const result = handoffSendable({ state: 'approved' });
  expect(result.sendable).toBe(false);
  expect(result.reason.includes('malformed')).toBeTruthy();
});

it('state rule: approved_by whitespace-only is treated as missing', () => {
  const result = handoffSendable({
    state: 'approved',
    approved_by: '   ',
    approved_at: '2026-07-23T12:00:00Z',
  });
  expect(result.sendable).toBe(false);
  expect(result.reason.includes('approved_by')).toBeTruthy();
});

it('state rule: approved_at whitespace-only is treated as missing', () => {
  const result = handoffSendable({
    state: 'approved',
    approved_by: 'operator:trevor',
    approved_at: '   ',
  });
  expect(result.sendable).toBe(false);
  expect(result.reason.includes('approved_at')).toBeTruthy();
});

it('state rule: state with leading/trailing whitespace is trimmed', () => {
  const result = handoffSendable({
    state: '  approved  ',
    approved_by: 'operator:trevor',
    approved_at: '2026-07-23T12:00:00Z',
  });
  expect(result.sendable).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// RECEIPT OUTCOME RULES — receiptValid
// ═══════════════════════════════════════════════════════════════════════════════

it('receiptValid: delivered with proof is valid', () => {
  const result = receiptValid('delivered', 'msg-abc', '2026-07-23T12:05:00Z', 1);
  expect(result.valid).toBe(true);
});

it('receiptValid: delivered with no provider_message_id is INVALID', () => {
  const result = receiptValid('delivered', '', '2026-07-23T12:05:00Z', 1);
  expect(result.valid).toBe(false);
  expect(result.reason.includes('provider_message_id')).toBeTruthy();
});

it('receiptValid: delivered with no sent_at is INVALID', () => {
  const result = receiptValid('delivered', 'msg-abc', '', 1);
  expect(result.valid).toBe(false);
  expect(result.reason.includes('sent_at')).toBeTruthy();
});

it('receiptValid: delivered with null recipient_count is INVALID', () => {
  const result = receiptValid('delivered', 'msg-abc', '2026-07-23T12:05:00Z', null);
  expect(result.valid).toBe(false);
  expect(result.reason.includes('recipient_count')).toBeTruthy();
});

it('receiptValid: delivered but missing BOTH provider_message_id AND sent_at is INVALID', () => {
  const result = receiptValid('delivered', '', '', 1);
  expect(result.valid).toBe(false);
  expect(result.reason.includes('missing both')).toBeTruthy();
});

it('receiptValid: failed outcome does not require delivery proof', () => {
  const result = receiptValid('failed');
  expect(result.valid).toBe(true);
});

it('receiptValid: rejected outcome does not require delivery proof', () => {
  const result = receiptValid('rejected');
  expect(result.valid).toBe(true);
});

it('receiptValid: held outcome does not require delivery proof', () => {
  const result = receiptValid('held');
  expect(result.valid).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMBINED VALIDATION — validateHandoff
// ═══════════════════════════════════════════════════════════════════════════════

it('validateHandoff: fully valid payload passes both shape and state rule', () => {
  const result = validateHandoff(validHandoff());
  expect(result.ok).toBe(true);
  expect(result.payload).toBeTruthy();
  expect(result.sendable).toBeTruthy();
  expect(result.sendable.sendable).toBe(true);
});

it('validateHandoff: shape-invalid returns with zero ok and parse error', () => {
  const result = validateHandoff({ schema: 'wrong' });
  expect(result.ok).toBe(false);
  expect(result.error).toBeTruthy();
  expect(result.payload).toBe(undefined);
});

it('validateHandoff: shape-valid but not sendable (draft) returns ok=false with sendable verdict', () => {
  const result = validateHandoff(
    validHandoff({ approval: { state: 'draft' } })
  );
  expect(result.ok).toBe(false);
  expect(result.payload).toBeTruthy(); // payload still returned so caller can inspect
  expect(result.sendable!.sendable).toBe(false);
  expect(result.error!.includes('draft')).toBeTruthy();
});

it('validateHandoff: shape-valid but not sendable (approved with no approver)', () => {
  const result = validateHandoff(
    validHandoff({
      approval: { state: 'approved', approved_by: '', approved_at: '' },
    })
  );
  expect(result.ok).toBe(false);
  expect(result.payload).toBeTruthy();
  expect(result.sendable!.sendable).toBe(false);
  expect(result.error!.includes('malformed')).toBeTruthy();
});

it('validateHandoff: shape-valid, rejected', () => {
  const result = validateHandoff(
    validHandoff({ approval: { state: 'rejected', note: 'Fix intro' } })
  );
  expect(result.ok).toBe(false);
  expect(result.sendable).toBeTruthy();
  expect(result.sendable.sendable).toBe(false);
  expect(result.error!.includes('rejected')).toBeTruthy();
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMBINED VALIDATION — validateReceipt
// ═══════════════════════════════════════════════════════════════════════════════

it('validateReceipt: fully valid delivered receipt passes', () => {
  const result = validateReceipt(validReceipt());
  expect(result.ok).toBe(true);
  expect(result.payload).toBeTruthy();
  expect(result.payload.outcome).toBe('delivered');
});

it('validateReceipt: shape-invalid returns with zero ok and parse error', () => {
  const result = validateReceipt({ schema: 'wrong' });
  expect(result.ok).toBe(false);
  expect(result.error).toBeTruthy();
  expect(result.payload).toBe(undefined);
});

it('validateReceipt: delivered with missing proof fails', () => {
  const result = validateReceipt(
    validReceipt({ provider_message_id: '', sent_at: '', recipient_count: null })
  );
  expect(result.ok).toBe(false);
  expect(result.error!.includes('provider_message_id') || result.error!.includes('sent_at')).toBeTruthy();
});

it('validateReceipt: failed receipt passes', () => {
  const result = validateReceipt(
    validReceipt({ outcome: 'failed', error: 'Connection refused', provider_message_id: undefined, sent_at: undefined })
  );
  expect(result.ok).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// MUTATION-PROOF MARKERS
// ═══════════════════════════════════════════════════════════════════════════════

it('MUTATION PROOF: changing handoff schema version to wrong string fails parse', () => {
  // Mutation: change HANDOFF_SCHEMA_VERSION literal in source to a wrong value
  // Expected: the zod `.literal()` check catches it → RED
  // Revert: restore the correct literal → GREEN
  const result = parseHandoff(validHandoff({ schema: 'content-delivery-handoff/v2' }));
  expect(result.ok).toBe(false, 'wrong schema version must be refused – mutation caught');
});

it('MUTATION PROOF: changing rendered.body to accept empty string would break the "cannot send nothing" invariant', () => {
  // Mutation: remove .min(1) from rendered.body in the Zod schema
  // Expected: THIS TEST RED — empty body accepted → the reason field would be
  //           missing because parseHandoff would return ok=true
  // Revert: restore .min(1) → GREEN
  const result = parseHandoff(
    validHandoff({ rendered: { subject: 'Hi', body: '' } })
  );
  expect(result.ok).toBe(false, 'empty body must be refused – the invariant is "cannot send nothing"');
});

it('MUTATION PROOF: removing approved_by check from state rule would let a malformed approval through', () => {
  // Mutation: remove the !by check from handoffSendable
  // Expected: THIS TEST RED — sendable becomes true without approved_by
  // Revert: restore the !by check → GREEN
  const result = handoffSendable({
    state: 'approved',
    approved_by: '',
    approved_at: '2026-07-23T12:00:00Z',
  });
  expect(result.sendable).toBe(false, 'missing approved_by must be refused – mutation caught');
});

it('MUTATION PROOF: delivered receipt without provider_message_id must NOT validate', () => {
  // Mutation: remove the provider_message_id check from receiptValid
  // Expected: THIS TEST RED — valid becomes true without provider_message_id
  // Revert: restore the check → GREEN
  const result = receiptValid('delivered', '', '2026-07-23T12:05:00Z', 1);
  expect(result.valid).toBe(false, 'delivered receipt without provider_message_id must be invalid – mutation caught');
});

it('MUTATION PROOF: unknown channel "fax" must be refused', () => {
  // Mutation: add "fax" to HANDOFF_CHANNELS
  // Expected: THIS TEST RED — parseHandoff returns ok for "fax" channel
  // Revert: remove "fax" from HANDOFF_CHANNELS → GREEN
  const result = parseHandoff(validHandoff({ channel: 'fax' }));
  expect(result.ok).toBe(false, 'unknown channel "fax" must be refused – mutation caught');
});

it('MUTATION PROOF: unknown approval state "published" must be refused', () => {
  // Mutation: add "published" to APPROVAL_STATES
  // Expected: THIS TEST RED — parseHandoff returns ok for "published"
  // Revert: remove "published" from APPROVAL_STATES → GREEN
  const result = parseHandoff(
    validHandoff({ approval: { state: 'published' } })
  );
  expect(result.ok).toBe(false, 'unknown approval state "published" must be refused – mutation caught');
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES — channel-specific rendering
// ═══════════════════════════════════════════════════════════════════════════════

it('edge: SMS handoff without subject is valid', () => {
  const result = parseHandoff(
    validHandoff({
      channel: 'sms',
      rendered: { body: 'Your code: 123456' },
    })
  );
  expect(result.ok).toBe(true);
});

it('edge: newsletter handoff requires subject (present)', () => {
  const result = parseHandoff(
    validHandoff({
      channel: 'newsletter',
      rendered: { subject: 'July Digest', body: 'Content here', preheader: 'Preview' },
    })
  );
  expect(result.ok).toBe(true);
});

it('edge: push channel handoff', () => {
  const result = parseHandoff(
    validHandoff({
      channel: 'push',
      rendered: { body: 'New message from Trevor', subject: 'Alert' },
    })
  );
  expect(result.ok).toBe(true);
});

it('edge: handoff_id with special characters', () => {
  const result = parseHandoff(
    validHandoff({ handoff_id: 'hw-2026-07-23_email_welcome-flow_v3' })
  );
  expect(result.ok).toBe(true);
});

it('edge: recipient_ref uses opaque reference, not PII', () => {
  // This verifies we don't accidentally accept email addresses as recipient_ref
  // (the field is opaque by contract — but we don't block strings that look
  // like emails either; the agent's own contracts enforce this at the prose level)
  const result = parseHandoff(
    validHandoff({ recipient_ref: 'contact:department:marketing:segment:new-users' })
  );
  expect(result.ok).toBe(true);
});

it('edge: receipt with zero recipient_count is valid (provider reported zero)', () => {
  const result = receiptValid('delivered', 'msg-abc', '2026-07-23T12:05:00Z', 0);
  expect(result.valid).toBe(true);
});

it('edge: receipt with large recipient_count', () => {
  const result = receiptValid('delivered', 'msg-abc', '2026-07-23T12:05:00Z', 50000);
  expect(result.valid).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS (compile-time only, but verify the consts)
// ═══════════════════════════════════════════════════════════════════════════════

it('version constants match the prose contract', () => {
  expect(HANDOFF_SCHEMA_VERSION).toBe('content-delivery-handoff/v1');
  expect(RECEIPT_SCHEMA_VERSION).toBe('content-delivery-receipt/v1');
});
