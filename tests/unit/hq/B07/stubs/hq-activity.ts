/**
 * TEST-ONLY stub for `@/lib/hq/activity` (B05's owned path — the SPEC's sole
 * activity writer — not on disk in this worktree because B07 bases on
 * `hq/contracts`). Loaded ONLY by this unit's test file through
 * `hq-stub-register.mjs`; never shipped.
 *
 * The signatures below MIRROR the real `unit/B05-builder:src/lib/hq/activity.ts`
 * (read at build time): `appendHqActivity(db, {companyId, installationId, event,
 * nowMs?})` returning a discriminated `HqAppendResult`, and
 * `toPublicActivityEvent(row, resolveLabel)` returning the frozen
 * `HqActivityEvent`. The projection helper is re-implemented rather than faked
 * because it is the route's actual output contract, and the S7 routing-key strip
 * is exactly what these tests must prove.
 */
import type { HqActivityEvent, HqActivityKind, HqPublicActivityPayload } from '@/lib/hq/types';

export type StubAppendInput = {
  companyId: string;
  installationId: string;
  event: { eventId: string; companyId: string; installationId: string; sourceKey: string; kind: string; phase: string };
};

export type StubAppendResult =
  | { status: 'appended'; duplicate: false; eventId: string; seq: number; evictedThroughSeq: number | null }
  | { status: 'duplicate'; duplicate: true; eventId: string; originalSeq: number; visible: boolean }
  | { status: 'conflict'; code: 'content_conflict'; eventId: string }
  | { status: 'event_expired'; code: 'event_expired' }
  | { status: 'event_not_yet_valid'; code: 'event_not_yet_valid' }
  | { status: 'receipt_capacity'; code: 'receipt_capacity' }
  | { status: 'oversize'; code: 'insufficient_retention_capacity' }
  | { status: 'foreign_source_id'; code: 'foreign_source_id' }
  | { status: 'invalid_event'; code: 'invalid_event' }
  | { status: 'capture_failed'; code: 'capture_failed'; reason: string };

type StubBag = {
  appendHqActivity?: (db: unknown, input: StubAppendInput) => StubAppendResult;
};

export function appendHqActivity(db: unknown, input: StubAppendInput): StubAppendResult {
  const impl = (globalThis as unknown as { __B07_STUBS__?: StubBag }).__B07_STUBS__?.appendHqActivity;
  if (impl) return impl(db, input);
  return { status: 'appended', duplicate: false, eventId: input.event.eventId, seq: 1, evictedThroughSeq: null };
}

/** Mirrors B05's real projection: allowlisted fields only, routing keys stripped. */
export function toPublicActivityEvent(
  row: {
    id: string;
    seq: number;
    kind: HqActivityKind;
    phase: string;
    task_id: string | null;
    actor_agent_id: string | null;
    recipient_agent_id: string | null;
    payload_json: string;
    occurred_at: string | null;
    received_at: string;
    source_key: string;
  },
  resolveLabel: (agentId: string) => string | null,
): HqActivityEvent {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    phase: row.phase as HqActivityEvent['phase'],
    taskId: row.task_id ?? null,
    actorLabel: row.actor_agent_id ? resolveLabel(row.actor_agent_id) : null,
    recipientLabel: row.recipient_agent_id ? resolveLabel(row.recipient_agent_id) : null,
    occurredAt: row.occurred_at ?? null,
    receivedAt: row.received_at,
    reference: row.source_key,
    payload: toPublicPayload(row.kind, row.payload_json),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** S7 line 291: the internal routing keys are stripped from the public detail. */
function toPublicPayload(kind: HqActivityKind, payloadJson: string): HqPublicActivityPayload {
  const raw = JSON.parse(payloadJson) as Record<string, unknown>;
  switch (kind) {
    case 'task':
      return { status: nullableString(raw.status), previousStatus: nullableString(raw.previousStatus) };
    case 'owner_note':
      return { text: typeof raw.text === 'string' ? raw.text : '' };
    case 'decision':
      return {
        intent: nullableString(raw.intent),
        routeAction: nullableString(raw.routeAction),
        departmentSlug: nullableString(raw.departmentSlug),
        confidenceBps: typeof raw.confidenceBps === 'number' ? raw.confidenceBps : null,
        fallback: typeof raw.fallback === 'boolean' ? raw.fallback : null,
        mode: typeof raw.mode === 'string' ? raw.mode : 'unknown',
        resolvedBy: nullableString(raw.resolvedBy),
      };
    case 'exchange':
      return { message: nullableString(raw.message), summary: typeof raw.summary === 'string' ? raw.summary : '' };
  }
}
