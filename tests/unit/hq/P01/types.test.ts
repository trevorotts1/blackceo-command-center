/**
 * P01 contract checks: SPEC S7 canonical serialization rules and envelope
 * validators. Focused on the frozen contract only; no database, no fixtures.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hqActivityForwardQuerySchema,
  hqActivityOlderQuerySchema,
  hqChatSessionCreateSchema,
  hqChatTurnCreateSchema,
  hqHasDuplicateObjectKeys,
  hqProducerEnvelopeSchema,
  hqSemanticSerialize,
} from '../../../../src/lib/hq/types';

test('hqSemanticSerialize: lexicographic sorted keys at every level, no whitespace', () => {
  assert.equal(hqSemanticSerialize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(hqSemanticSerialize({ z: { beta: 1, alpha: [2, 3] }, a: null }), '{"a":null,"z":{"alpha":[2,3],"beta":1}}');
});

test('hqSemanticSerialize: UTF-8 Unicode emitted directly, control chars escaped', () => {
  assert.equal(hqSemanticSerialize({ k: 'é☃' }), '{"k":"é☃"}');
  assert.equal(hqSemanticSerialize({ k: 'a\nb\tc\u0001' }), '{"k":"a\\nb\\tc\\u0001"}');
  assert.equal(hqSemanticSerialize({ k: 'quote"slash\\' }), '{"k":"quote\\"slash\\\\"}');
});

test('hqSemanticSerialize: null, booleans and integers only', () => {
  assert.equal(hqSemanticSerialize(null), 'null');
  assert.equal(hqSemanticSerialize([true, false, 0, -7]), '[true,false,0,-7]');
  assert.throws(() => hqSemanticSerialize(1.5), /non-integer/);
  assert.throws(() => hqSemanticSerialize(Number.NaN), /non-integer/);
  assert.throws(() => hqSemanticSerialize(Number.MAX_SAFE_INTEGER + 2), /non-integer/);
  assert.throws(() => hqSemanticSerialize(undefined), /unsupported type/);
});

test('hqSemanticSerialize: rejects lone surrogates', () => {
  assert.throws(() => hqSemanticSerialize('\ud800'), /lone surrogate/);
  assert.throws(() => hqSemanticSerialize({ k: 'a\udc00' }), /lone surrogate/);
  assert.equal(hqSemanticSerialize('😀'), '"😀"');
});

test('hqHasDuplicateObjectKeys: detects duplicates including escaped spellings', () => {
  assert.equal(hqHasDuplicateObjectKeys('{"a":1,"a":2}'), true);
  assert.equal(hqHasDuplicateObjectKeys('{"a":1,"\\u0061":2}'), true);
  assert.equal(hqHasDuplicateObjectKeys('{"a":1,"b":{"a":1}}'), false);
  assert.equal(hqHasDuplicateObjectKeys('[{"a":1},{"a":1}]'), false);
  assert.equal(hqHasDuplicateObjectKeys('{"a":"x,}\\"y","b":2}'), false);
  assert.equal(hqHasDuplicateObjectKeys('17'), false);
});

const baseEvent = {
  eventId: '2b0f5e2a-3d2e-4f4a-8f9b-3a2d4c5b6a70',
  sourceKey: 'exchange:abc:requested',
  installationId: 'inst-1',
  companyId: 'co-1',
  issuedAt: '2026-10-03T21:00:00Z',
  occurredAt: null,
  taskId: null,
  actorRuntimeId: 'rt-1',
  recipientRuntimeId: null,
  fromWorkspaceId: null,
  toWorkspaceId: null,
  exchangeId: 'abc',
};

test('envelope: valid task event accepted, all keys present, strict about unknown keys', () => {
  const event = { ...baseEvent, kind: 'task', phase: 'created', payload: { status: 'open', previousStatus: null } };
  const envelope = { schemaVersion: 1, sentAt: '2026-10-03T21:00:01Z', event, contentHash: 'x'.repeat(64) };
  assert.equal(hqProducerEnvelopeSchema.safeParse(envelope).success, true);
  const withExtra = { ...event, payload: { status: 'open', previousStatus: null, zz: 1 } };
  assert.equal(hqProducerEnvelopeSchema.safeParse({ ...envelope, event: withExtra }).success, false);
  const missing = { ...envelope, event: { ...event, payload: { status: 'open' } } };
  assert.equal(hqProducerEnvelopeSchema.safeParse(missing).success, false);
  assert.equal(hqProducerEnvelopeSchema.safeParse({ ...event }).success, false);
});

test('envelope: kind/phase pairing enforced by the discriminated union', () => {
  const wrongPhase = { ...baseEvent, kind: 'task', phase: 'replied', payload: { status: null, previousStatus: null } };
  assert.equal(hqProducerEnvelopeSchema.safeParse({ schemaVersion: 1, sentAt: 's', event: wrongPhase, contentHash: 'h' }).success, false);
});

test('envelope: decision confidence is integer basis points, exchange rejects unknown native status', () => {
  const decision = {
    ...baseEvent,
    kind: 'decision',
    phase: 'applied',
    payload: { intent: 'i', routeAction: 'a', departmentSlug: 'd', confidenceBps: 8000, fallback: false, mode: 'live', resolvedBy: 'r' },
  };
  assert.equal(hqProducerEnvelopeSchema.safeParse({ schemaVersion: 1, sentAt: 's', event: decision, contentHash: 'h' }).success, true);
  const floatBps = { ...decision, payload: { ...decision.payload, confidenceBps: 80.5 } };
  assert.equal(hqProducerEnvelopeSchema.safeParse({ schemaVersion: 1, sentAt: 's', event: floatBps, contentHash: 'h' }).success, false);
  const exchange = {
    ...baseEvent,
    kind: 'exchange',
    phase: 'replied',
    payload: {
      message: 'hello', summary: 'replied', toolName: 'sessions_send', toolCallId: null, callerRunId: 'r1', targetRunId: 'r2',
      callerSessionKey: null, targetSessionKey: null, sourceHook: 'lifecycle', nativeStatus: 'ok', targetDisposition: null, correlationStatus: 'linked',
    },
  };
  assert.equal(hqProducerEnvelopeSchema.safeParse({ schemaVersion: 1, sentAt: 's', event: exchange, contentHash: 'h' }).success, true);
  const badStatus = { ...exchange, payload: { ...exchange.payload, nativeStatus: 'invented' } };
  assert.equal(hqProducerEnvelopeSchema.safeParse({ schemaVersion: 1, sentAt: 's', event: badStatus, contentHash: 'h' }).success, false);
});

test('request schemas: activity pagination exclusivity, chat body trim and 32k cap', () => {
  assert.equal(hqActivityForwardQuerySchema.safeParse({ after: 0, through: 10 }).data?.limit, 100);
  assert.equal(hqActivityForwardQuerySchema.safeParse({ after: -1, through: 10 }).success, false);
  assert.equal(hqActivityOlderQuerySchema.safeParse({ before: 5, after: 1 }).success, false);
  assert.equal(hqActivityOlderQuerySchema.safeParse({ before: 5, limit: 201 }).success, false);
  assert.equal(hqChatSessionCreateSchema.safeParse({ headAgentId: 'a' }).success, true);
  assert.equal(hqChatSessionCreateSchema.safeParse({}).success, false);
  assert.equal(hqChatTurnCreateSchema.safeParse({ clientRequestId: 'c', message: '  hi  ' }).data?.message, 'hi');
  assert.equal(hqChatTurnCreateSchema.safeParse({ clientRequestId: 'c', message: 'x'.repeat(32001) }).success, false);
  assert.equal(hqChatTurnCreateSchema.safeParse({ clientRequestId: 'c', message: 'x'.repeat(32000) }).success, true);
});
