/**
 * POST /api/hq/chat/sessions/{id}/turns — S9 durable turn creation (SPEC S9 line 354,
 * S8 line 310). Body `{clientRequestId, message}`, strict, trimmed, 32,000-character
 * cap REJECTED with 413 and never truncated (S9 line 338, P01 `hqChatTurnCreateSchema`).
 *
 * Order of decisions is the acceptance:
 *   1. Identity — verified subject + installation, no bearer-only operator, no local
 *      development fallback (S7).
 *   2. Body — strict schema; oversize is 413 before any storage or dedupe lookup.
 *   3. Foreign session BEFORE dedupe — a session the caller does not own is 404/410 even
 *      when the request id was used before, so a foreign caller learns nothing from the
 *      duplicate path (S6 line 251, Q07 "foreign-before-dedupe").
 *   4. Dedupe / conflict / one-active-turn are B09's decisions: identical duplicate
 *      returns the existing turn, changed content under the same key is 409
 *      `request_conflict`, a second turn while one is nonterminal is 409
 *      `turn_in_progress` preserving the browser draft.
 *
 * The route persists nothing and sends nothing: persistence and the pre-send
 * correlation claim live in the B09 service, whose claim is fenced by a lease. It never
 * returns a gateway session key.
 */
import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { HqContextError, requireHqContext, type HqContext } from '@/lib/hq/context';
import { createHqTurn, getHqSession } from '@/lib/hq/chat';
import { hqChatTurnCreateSchema } from '@/lib/hq/types';

/** B02's refusal class publishes exactly the four fields this boundary returns. */
type HqContextRefusal = { status: number; code: string; message: string; retryable?: boolean };

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function fail(requestId: string, status: number, code: string, message: string, retryable = false): NextResponse {
  return NextResponse.json({ error: { code, message, retryable }, requestId }, { status });
}

function success(status: number, companyId: string, body: Record<string, unknown>): NextResponse {
  return NextResponse.json({ schemaVersion: 1, generatedAt: new Date().toISOString(), companyId, ...body }, { status });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = uuidv4();

  let ctx: HqContext;
  try {
    ctx = await requireHqContext(request);
  } catch (err) {
    if (err instanceof HqContextError) {
      const refusal = err as HqContextRefusal;
      return fail(requestId, refusal.status, refusal.code, refusal.message, refusal.retryable ?? false);
    }
    return fail(requestId, 401, 'unauthenticated', 'A verified tenant identity is required.');
  }

  const { id } = await params;
  if (!id) return fail(requestId, 404, 'not_found', 'Session not found.');

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(requestId, 400, 'invalid_request', 'A JSON body is required.');
  }

  const parsed = hqChatTurnCreateSchema.safeParse(raw);
  if (!parsed.success) {
    // P01's schema trims BEFORE the cap, so whitespace padding cannot smuggle an
    // oversize message past the trim; anything escaping the schema as too long is a
    // genuine 413 (S9 "reject oversize with 413, never truncate") — status-only in
    // SPEC, so the code is this route's own choice (gap G-14).
    const oversize = parsed.error.issues.some((issue) => issue.code === 'too_big');
    if (oversize) return fail(requestId, 413, 'message_too_large', 'message exceeds 32000 characters.');
    return fail(requestId, 400, 'invalid_request', 'Body must be {clientRequestId,message}.');
  }

  // Ownership gate FIRST — before any dedupe/duplicate read of this request id.
  const session = await getHqSession(ctx, id);
  if (!session.ok) return fail(requestId, session.status, session.code, session.message, session.retryable ?? false);

  const result = await createHqTurn(ctx, id, parsed.data);
  if (!result.ok) return fail(requestId, result.status, result.code, result.message, result.retryable ?? false);
  return success(result.duplicate ? 200 : 201, ctx.companyId, { turn: result.turn, duplicate: result.duplicate });
}
