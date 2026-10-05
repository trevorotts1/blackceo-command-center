/**
 * GET /api/hq/chat/sessions/{id}/turns/{turnId} — authorized turn state with the
 * persisted reply or the labelled partial reply (SPEC S8 line 311, S9 line 366
 * "Receipt reads remain available after page disconnect").
 *
 * The response carries P01's frozen `HqChatTurn`: `partial:true` while nonterminal,
 * truthful state, never the gateway key (gap G-17). Both ids are ownership-checked —
 * the turn is looked up inside the session that owns it, never by turn id alone, so a
 * turn id leaked from another session cannot be read.
 */
import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { HqContextError, requireHqContext, type HqContext } from '@/lib/hq/context';
import { getHqSession, getHqTurn } from '@/lib/hq/chat';

/** B02's refusal class publishes exactly the four fields this boundary returns. */
type HqContextRefusal = { status: number; code: string; message: string; retryable?: boolean };

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function fail(requestId: string, status: number, code: string, message: string, retryable = false): NextResponse {
  return NextResponse.json({ error: { code, message, retryable }, requestId }, { status });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; turnId: string }> }) {
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

  const turn = await getHqTurn(ctx, id, turnId);
  if (!turn.ok) return fail(requestId, turn.status, turn.code, turn.message, turn.retryable ?? false);

  return NextResponse.json({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    companyId: ctx.companyId,
    turn: turn.turn,
  });
}
