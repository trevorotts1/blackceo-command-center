/**
 * Company Headquarters activity — SPEC rev 4 S7 producer ingest and S8
 * forward/older read. One file owns BOTH verbs (swarm-plan B07): the signed
 * producer boundary and the scoped cursor read share one company resolution so
 * the write half and the read half can never disagree about whose rows they
 * touch.
 *
 * Authority: SPEC.md rev 4 (S5 activity/capture, S6 storage, S7 producer
 * envelope, S8 read interfaces). Frozen types come from `src/lib/hq/types.ts`
 * (P01) and are imported, never redeclared.
 *
 * DECLARED CONTRACT IMPORTS. Both are other units' owned paths, and neither is
 * present in this worktree because it bases on `hq/contracts`:
 *   - `@/lib/hq/context`  → `requireHqContext`  (B02; SPEC S7 line 263 requires
 *     every /api/hq/* route to resolve identity through this one helper).
 *   - `@/lib/hq/activity` → `appendHqActivity`, `toPublicActivityEvent` (B05;
 *     SPEC S5 line 182 — the ONLY writer of Headquarters activity, and the owner
 *     of the S5/S6 public projection for gaps G-08/G-09).
 * Both are joined to their real published shape, read from unit/B05-builder, and
 * wired exactly as the SPEC names them (swarm-plan.base_policy: a contract
 * consumer imports declared names while the implementation is absent; the
 * INTERFACE_PASS at assembly proves the imports actually resolve). This unit's
 * focused tests supply private test-only stubs for those two names, mirroring
 * the real shapes; no stub is shipped.
 *
 * WHERE EACH RULE LIVES (one owner per rule — duplication is what drifts):
 *   - bearer, signature over exact raw bytes, byte cap, duplicate-key scan,
 *     envelope validation, the five-minute `sentAt` window: THIS route, because
 *     only the route sees the raw request.
 *   - company/installation binding, `issuedAt` acceptance window, content-hash
 *     dedupe, duplicate/conflict policy, retention bounds, capture degradation:
 *     `appendHqActivity` (B05), enforced before persistence.
 *
 * CARRIED — older-history pages have no SPEC-given response field names (S8
 * defines the response only for the forward page). This route answers both with
 * the frozen `HqActivityPageResponse`, and for `before` pages sets `nextAfter`
 * to the smallest seq returned: `before` is exclusive, so that value is the
 * correct next `before` cursor. Recorded for the first client that freezes the
 * older-page shape.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  hqActivityForwardQuerySchema,
  hqActivityOlderQuerySchema,
  hqHasDuplicateObjectKeys,
  hqProducerEnvelopeSchema,
  hqSemanticSerialize,
  type HqActivityKind,
  type HqApiErrorResponse,
} from '@/lib/hq/types';
import { getDb, queryAll } from '@/lib/db';
import { tenantRegistration } from '@/lib/auth/tenant-context';
import { verifyWebhookSignatureStrict } from '@/lib/webhook-signature';
import { requireHqContext } from '@/lib/hq/context';
import { appendHqActivity, toPublicActivityEvent, type HqAppendResult } from '@/lib/hq/activity';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** S5: serialized UTF-8 payload max 128 KiB (accommodates 8,000-char message + 2,000-char summary). */
const MAX_ENVELOPE_BYTES = 131_072;
const SIGNED_SENT_WINDOW_MS = 5 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** S7 line 295: native exchangeId is exactly 64 lowercase hex characters. */
const EXCHANGE_ID_PATTERN = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ *
 * Shared shapes and responses
 * ------------------------------------------------------------------ */

/** The S6 `hq_activity` columns this route reads (B01 owns the row decoder). */
type HqActivityRow = {
  seq: number;
  id: string;
  company_id: string;
  source_key: string;
  kind: string;
  phase: string;
  task_id: string | null;
  actor_agent_id: string | null;
  recipient_agent_id: string | null;
  occurred_at: string | null;
  received_at: string;
  payload_json: string;
};

const ACTIVITY_COLUMNS = `seq, id, company_id, source_key, kind, phase, task_id, actor_agent_id,
                          recipient_agent_id, occurred_at, received_at, payload_json`;

/** S8 error shape: `{error:{code,message,retryable},requestId}`, never a raw exception. */
function fail(status: number, code: string, message: string, retryable = false): NextResponse {
  const body: HqApiErrorResponse = { error: { code, message, retryable }, requestId: randomUUID() };
  return NextResponse.json(body, { status });
}

function ok<T extends Record<string, unknown>>(companyId: string, payload: T, status = 200): NextResponse {
  return NextResponse.json(
    { schemaVersion: 1, generatedAt: new Date().toISOString(), companyId, ...payload },
    { status },
  );
}

/** True only for the SQLite "the HQ migration has not run" class. */
function isMissingHqTable(err: unknown): boolean {
  return /no such table: hq_/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * S5: actor and recipient labels are resolved from CURRENT scope, so a target
 * removed since the event yields null instead of a retained name (S6 line 235).
 *
 * The id space is the WRITER's acceptance set, never a narrower one: B05 stores
 * the envelope's runtime binding verbatim and accepts it against
 * `a.id OR a.openclaw_agent_id`, so a reader resolving only `a.id` would report
 * a LIVE runtime-bound target as removed. Both bindings, same company.
 */
function labelResolver(companyId: string): (agentId: string) => string | null {
  return (agentId) => {
    const row = getDb()
      .prepare(
        `SELECT a.name AS name FROM agents a
           JOIN workspaces w ON w.id = a.workspace_id
          WHERE (a.id = ? OR a.openclaw_agent_id = ?) AND w.company_id = ?`,
      )
      .get(agentId, agentId, companyId) as { name: string | null } | undefined;
    return row?.name ?? null;
  };
}

/* ------------------------------------------------------------------ *
 * POST — signed producer ingest (SPEC S5 line 182, S7 lines 287/291/295)
 * ------------------------------------------------------------------ */

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** B05's storage-boundary result → the SPEC's HTTP contract. */
function mapAppendResult(result: HqAppendResult, companyId: string): NextResponse {
  switch (result.status) {
    case 'appended':
      return ok(companyId, { duplicate: false, eventId: result.eventId, seq: result.seq }, 201);
    case 'duplicate':
      // S8 line 307 / S6 line 239: identical retry is 200 with the original seq,
      // and `visible:false` when retention already pruned that row.
      return ok(
        companyId,
        { duplicate: true, eventId: result.eventId, originalSeq: result.originalSeq, visible: result.visible },
        200,
      );
    case 'conflict':
      return fail(409, 'request_conflict', 'source_key already exists with different content');
    case 'event_expired':
      return fail(410, 'event_expired', 'issuedAt is older than the 24-hour acceptance window');
    case 'event_not_yet_valid':
      return fail(422, 'invalid_envelope', 'issuedAt is more than five minutes in the future');
    case 'receipt_capacity': {
      // S6 line 239: 429 with Retry-After; live dedup keys are all preserved.
      const response = fail(429, 'receipt_capacity', 'Receipt capacity reached for this company', true);
      response.headers.set('retry-after', '60');
      return response;
    }
    case 'oversize':
      return fail(413, 'payload_too_large', 'Event cannot be retained within the byte budget');
    case 'foreign_source_id':
      return fail(403, 'forged_source', 'Envelope company/installation does not match the registered source');
    case 'invalid_event':
      return fail(422, 'invalid_envelope', 'Envelope does not match the versioned producer contract');
    case 'capture_failed':
      // S5: telemetry failure never rolls back authorized business work. For
      // this route the append IS the work, so it reports retryable, not success.
      return fail(503, 'capture_failed', 'Headquarters capture failed; the event was not recorded', true);
    default: {
      // Fail closed on a storage outcome this route does not know: a new
      // HqAppendResult member must never be silently reported as success.
      const unknownStatus = (result as { status?: string }).status ?? 'unknown';
      return fail(503, 'hq_append_unknown', `Unrecognized append outcome: ${unknownStatus}`, true);
    }
  }
}

export async function POST(request: NextRequest) {
  // Gate 1 — the service credential must be configured at all. SPEC S7 line 287
  // requires BOTH the bearer and the webhook signature; an unconfigured box
  // cannot satisfy that, so it refuses rather than ingesting unauthenticated.
  const apiToken = process.env.MC_API_TOKEN;
  if (!apiToken || !process.env.WEBHOOK_SECRET) {
    return fail(503, 'producer_auth_not_configured', 'HQ producer ingest requires bearer and webhook secret', true);
  }

  // Gate 2 — bearer, constant time (same two-layer convention as
  // /api/tasks/[id]/status). SPEC S7 line 269: only signed producer ingest uses
  // the service bearer; browser and private-chat routes refuse it.
  const presented = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!constantTimeEquals(presented, apiToken)) {
    return fail(401, 'unauthorized', 'A valid producer bearer is required');
  }

  // Gate 3 — size on the wire, then on the exact received bytes.
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ENVELOPE_BYTES) {
    return fail(413, 'payload_too_large', 'Envelope exceeds the 128 KiB cap');
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_ENVELOPE_BYTES) {
    return fail(413, 'payload_too_large', 'Envelope exceeds the 128 KiB cap');
  }

  // Gate 4 — signature over the EXACT raw bytes, never a re-serialization.
  if (!verifyWebhookSignatureStrict(request.headers.get('x-webhook-signature'), raw)) {
    return fail(401, 'unauthorized', 'x-webhook-signature does not cover the exact received bytes');
  }

  // Gate 5 — duplicate object keys, on the raw text: JSON.parse collapses them,
  // so the check must run before parsing (interfaces.md G-13).
  if (hqHasDuplicateObjectKeys(raw)) {
    return fail(422, 'duplicate_object_keys', 'Envelope JSON contains duplicate object keys');
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    return fail(400, 'invalid_json', 'Envelope is not valid JSON');
  }

  // Gate 6 — the frozen strict envelope: unknown keys rejected, every key
  // present, kind/phase pairing enforced by the discriminated union (S7 line 291).
  const envelope = hqProducerEnvelopeSchema.safeParse(parsedBody);
  if (!envelope.success) {
    return fail(422, 'invalid_envelope', 'Envelope does not match the versioned producer contract');
  }
  const event = envelope.data.event;

  // Gate 7 — event identity. SPEC S7 line 291: `eventId` UUID; line 295: the
  // native exchangeId is 64 lowercase hex, and a malformed one is not "roughly
  // right", it is unverifiable.
  if (!UUID_PATTERN.test(event.eventId)) {
    return fail(422, 'invalid_envelope', 'eventId is not a UUID');
  }
  if (event.exchangeId !== null && !EXCHANGE_ID_PATTERN.test(event.exchangeId)) {
    return fail(422, 'invalid_envelope', 'exchangeId is not 64 lowercase hexadecimal characters');
  }

  // Gate 8 — the five-minute signature window on `sentAt`, which is unhashed and
  // covered by the signature (S7 line 293). The `issuedAt` acceptance window is
  // NOT re-checked here: B05 owns it at the storage boundary so the rule has one
  // home, and its result maps back through mapAppendResult.
  const sentAtMs = Date.parse(envelope.data.sentAt);
  if (!Number.isFinite(sentAtMs) || Math.abs(Date.now() - sentAtMs) > SIGNED_SENT_WINDOW_MS) {
    return fail(422, 'invalid_envelope', 'sentAt is outside the five-minute signature window');
  }

  // Gate 9 — the receiver recomputes the semantic hash over `event` only (S7 line
  // 287): a body whose declared hash does not match its own event bytes is
  // rejected here, and B05 recomputes independently at storage.
  let recomputed: string;
  try {
    recomputed = createHash('sha256').update(hqSemanticSerialize(event), 'utf8').digest('hex');
  } catch {
    return fail(422, 'invalid_envelope', 'Semantic event cannot be canonically serialized');
  }
  if (envelope.data.contentHash !== recomputed) {
    return fail(422, 'hash_mismatch', 'contentHash does not match the semantic event bytes');
  }

  // Gate 10 — trusted source binding (SPEC S7 lines 265/287). The company and
  // installation come from THIS box's registered host, never from the body, and
  // are passed to the writer as trusted values for it to bind against.
  let registration: { companyId: string; installationId: string };
  try {
    const host = new URL(`http://${request.headers.get('host') ?? ''}`).hostname.toLowerCase();
    const reg = tenantRegistration(host);
    registration = { companyId: reg.companyId, installationId: reg.installationId };
  } catch {
    return fail(403, 'company_not_bound', 'Producer source is not bound to a registered installation');
  }

  try {
    // The ONLY writer of Headquarters activity (S5 line 182). It re-validates
    // company/installation/expiry and owns duplicate-vs-conflict policy.
    const result = appendHqActivity(getDb(), {
      companyId: registration.companyId,
      installationId: registration.installationId,
      event,
    });
    return mapAppendResult(result, registration.companyId);
  } catch (err) {
    if (isMissingHqTable(err)) {
      return fail(503, 'hq_storage_unavailable', 'Headquarters storage is not migrated on this installation', true);
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * GET — scoped cursor read (SPEC S8 lines 304-305, 316-324)
 * ------------------------------------------------------------------ */

async function resolveCompanyId(request: NextRequest): Promise<string | NextResponse> {
  try {
    // SPEC S7 line 263: this route resolves identity itself through the one
    // shared helper. S7 line 269: browser reads are direct self-origin only.
    const ctx = await requireHqContext(request);
    if (!ctx || typeof ctx.companyId !== 'string' || !ctx.companyId) {
      return fail(403, 'company_not_bound', 'No authorized company is resolved for this request');
    }
    return ctx.companyId;
  } catch (err) {
    // The guard's refusal carries the SPEC-named code and retryable flag
    // (B02 `HqContextError`: status/code/message/retryable/link). It is read
    // structurally rather than by class identity: SPEC S7 line 263 names only
    // `requireHqContext` as the shared helper, so this route must not require
    // the guard's class export as well. SPEC S7 line 265 names 409
    // `company_not_bound`, line 269 names 403 `hq_direct_origin_required`, and
    // S6's storage refusal is retryable — collapsing those to a generic 401
    // discards exactly the codes the frozen HQ_SPEC_ERROR_CODES set exists for.
    const refusal = err as { status?: unknown; code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof refusal.status === 'number' && typeof refusal.code === 'string' && refusal.code) {
      return fail(
        refusal.status,
        refusal.code,
        typeof refusal.message === 'string' && refusal.message ? refusal.message : 'Headquarters request refused',
        refusal.retryable === true,
      );
    }
    const status = (err as { status?: number }).status;
    return fail(typeof status === 'number' ? status : 401, 'unauthorized', 'A verified Headquarters identity is required');
  }
}

/** Cursor state (S6 `hq_activity_state`); absent means nothing has ever been appended. */
function readCursorState(companyId: string): { highSeq: number; prunedThroughSeq: number } {
  const state = getDb()
    .prepare(`SELECT high_seq, pruned_through_seq FROM hq_activity_state WHERE company_id = ?`)
    .get(companyId) as { high_seq: number; pruned_through_seq: number } | undefined;
  return { highSeq: state?.high_seq ?? 0, prunedThroughSeq: state?.pruned_through_seq ?? 0 };
}

export async function GET(request: NextRequest) {
  const companyId = await resolveCompanyId(request);
  if (companyId instanceof NextResponse) return companyId;

  const params = Object.fromEntries(request.nextUrl.searchParams);
  // Each strict object rejects the other mode's keys, so the two parses are
  // genuinely exclusive: `after`+`through` or `before`, never both, never
  // neither. S8 line 299 requires strict validation, and there is no third read
  // mode — an unshaped query is refused, not guessed.
  const forward = hqActivityForwardQuerySchema.safeParse(params);
  const older = hqActivityOlderQuerySchema.safeParse(params);
  if (!forward.success && !older.success) {
    return fail(400, 'invalid_query', 'Expected after+through (+limit) or before (+limit)');
  }
  // Narrowed once, so neither branch has to re-inspect a union it cannot see.
  const olderQuery = older.success ? older.data : null;

  const toEvents = (rows: HqActivityRow[]) => {
    const resolveLabel = labelResolver(companyId);
    return rows.map((row) => toPublicActivityEvent({ ...row, kind: row.kind as HqActivityKind }, resolveLabel));
  };

  try {
    if (forward.success) {
      const { after, through, limit } = forward.data;
      const { highSeq, prunedThroughSeq } = readCursorState(companyId);

      // SPEC S8 line 322: a cursor BELOW the pruned watermark, or ahead of the
      // server high-water mark after a restore, is an explicit reset with no
      // misleading delta. `after == prunedThroughSeq` is a legal cursor (all of
      // it already seen and evicted), and sequence GAPS alone are legal too —
      // never mistaken for expiry.
      if (after < prunedThroughSeq || after > highSeq) {
        return ok(companyId, {
          events: [],
          nextAfter: after,
          through,
          hasMore: false,
          resetRequired: true,
          prunedThroughSeq,
        });
      }

      // One extra row decides `hasMore`; N < seq <= M, ascending, same company.
      const rows = queryAll<HqActivityRow>(
        `SELECT ${ACTIVITY_COLUMNS} FROM hq_activity
          WHERE company_id = ? AND seq > ? AND seq <= ?
          ORDER BY seq ASC LIMIT ?`,
        [companyId, after, through, limit + 1],
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      // S8 line 320: the final page reports nextAfter = through even when no
      // scoped rows matched, so the client's cursor still freezes correctly.
      const nextAfter = hasMore ? (page[page.length - 1]?.seq ?? after) : through;
      return ok(companyId, {
        events: toEvents(page),
        nextAfter,
        through,
        hasMore,
        resetRequired: false,
        prunedThroughSeq,
      });
    }

    // Older retained history, descending; mutually exclusive with after/through
    // by the strict object (S8 line 305). No animation for history.
    const { before, limit } = olderQuery!;
    const { highSeq, prunedThroughSeq } = readCursorState(companyId);
    const rows =
      before <= prunedThroughSeq
        ? []
        : queryAll<HqActivityRow>(
            `SELECT ${ACTIVITY_COLUMNS} FROM hq_activity
              WHERE company_id = ? AND seq < ?
              ORDER BY seq DESC LIMIT ?`,
            [companyId, before, limit + 1],
          );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return ok(companyId, {
      events: toEvents(page),
      // `before` is exclusive, so the smallest seq on this page is the correct
      // next `before` cursor. Carried shape decision — see the file header.
      nextAfter: page.length > 0 ? (page[page.length - 1]?.seq ?? before) : before,
      through: highSeq,
      hasMore,
      resetRequired: false,
      prunedThroughSeq,
    });
  } catch (err) {
    if (isMissingHqTable(err)) {
      // Never a deceptive empty office (SPEC S10): an unmigrated box says so.
      return fail(503, 'hq_storage_unavailable', 'Headquarters storage is not migrated on this installation', true);
    }
    throw err;
  }
}
