/**
 * GET /api/hq/chat/sessions/{id} — authorized session metadata + paginated private
 * turns (SPEC S8 line 309), never a gateway session key (S6 line 249, S9).
 *
 * Ownership is validated on EVERY access, including reads of a session the caller
 * already saw (S6 line 251 / S7 line 267). B09's `getHqSession` is that gate: unknown
 * or foreign returns 404 in the same shape as a genuinely missing record, and an
 * expired owned session returns 410 (S6 line 255). The route maps those outcomes and
 * adds nothing of its own.
 *
 * `limit` is a plain retention bound for this page (1..200, default 50) — the same
 * bound class as S8's activity page; it is not part of the frozen P01 request schemas,
 * which cover the two POST bodies.
 */
import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { HqContextError, requireHqContext, type HqContext } from '@/lib/hq/context';
import { getHqSession, listHqTurns } from '@/lib/hq/chat';

/** B02's refusal class publishes exactly the four fields this boundary returns. */
type HqContextRefusal = { status: number; code: string; message: string; retryable?: boolean };

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

function fail(requestId: string, status: number, code: string, message: string, retryable = false): NextResponse {
  return NextResponse.json({ error: { code, message, retryable }, requestId }, { status });
}

function success(companyId: string, body: Record<string, unknown>): NextResponse {
  return NextResponse.json({ schemaVersion: 1, generatedAt: new Date().toISOString(), companyId, ...body });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  // Foreign/unknown/expired are the service's decision — never inferred here, and
  // never resolved by falling back to a differently-scoped lookup.
  const session = await getHqSession(ctx, id);
  if (!session.ok) return fail(requestId, session.status, session.code, session.message, session.retryable ?? false);

  const rawLimit = request.nextUrl.searchParams.get('limit');
  const parsedLimit = rawLimit === null ? DEFAULT_PAGE : Number(rawLimit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_PAGE) {
    return fail(requestId, 400, 'invalid_request', `limit must be an integer 1..${MAX_PAGE}.`);
  }
  const before = request.nextUrl.searchParams.get('before') ?? undefined;

  const page = await listHqTurns(ctx, id, before === undefined ? { limit: parsedLimit } : { limit: parsedLimit, before });
  if (!page.ok) return fail(requestId, page.status, page.code, page.message, page.retryable ?? false);

  return success(ctx.companyId, {
    session: session.session,
    turns: page.turns,
    hasMore: page.hasMore,
    nextBefore: page.nextBefore,
  });
}
