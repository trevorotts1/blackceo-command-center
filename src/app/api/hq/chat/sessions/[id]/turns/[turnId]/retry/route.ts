/**
 * POST /api/hq/chat/sessions/{id}/turns/{turnId}/retry — S9 retry of an EXISTING turn
 * (SPEC S8 line 312, S9 line 370). No body, no implicit new turn, no new request id.
 *
 * The route deliberately decides nothing about eligibility. S9's proof-of-not-sent rule
 * is owned by the B09 state machine, which accepts only: state `failed_unsent`,
 * `attempts < 3`, no known gateway acceptance, unexpired message content and an open
 * owned session — then re-claims with CAS under the SAME request id. Everything else is
 * a refusal the service reports:
 *   • a turn that is not positively-unsent → 409 (timeout is NOT proof of non-send),
 *   • a content-expired turn → 410 and it is never re-sent as an empty message,
 *   • missing/expired request or session → 404/410, never a fresh send.
 * A caller-supplied body is ignored on purpose: accepting one would let a retry carry
 * different content, which is the failure this endpoint exists to prevent.
 */
import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { HqContextError, requireHqContext, type HqContext } from '@/lib/hq/context';
import { getHqSession, retryHqTurn } from '@/lib/hq/chat';

/** B02's refusal class publishes exactly the four fields this boundary returns. */
type HqContextRefusal = { status: number; code: string; message: string; retryable?: boolean };

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function fail(requestId: string, status: number, code: string, message: string, retryable = false): NextResponse {
  return NextResponse.json({ error: { code, message, retryable }, requestId }, { status });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; turnId: string }> }) {
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

  const { id, turnId } = await params;
  if (!id || !turnId) return fail(requestId, 404, 'not_found', 'Turn not found.');

  const session = await getHqSession(ctx, id);
  if (!session.ok) return fail(requestId, session.status, session.code, session.message, session.retryable ?? false);

  const result = await retryHqTurn(ctx, id, turnId);
  if (!result.ok) return fail(requestId, result.status, result.code, result.message, result.retryable ?? false);

  return NextResponse.json({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    companyId: ctx.companyId,
    turn: result.turn,
  });
}
