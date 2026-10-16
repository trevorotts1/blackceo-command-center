/**
 * POST /api/hq/chat/sessions — open a private head conversation (SPEC S8/S9).
 *
 * This route family is the ONLY private chat boundary Headquarters ships: it never
 * reuses `POST /api/ceo-chat/message`, never calls `forwardToAgent` and never touches
 * the gateway (S9 "New route/library under /api/hq/chat"). Persistence, the lease/CAS
 * turn state machine and gateway lifecycle belong to B09/B11/B13; this file owns the
 * HTTP boundary only.
 *
 * Boundary rules owned here
 *   • Identity first — `requireHqContext` (B02) resolves the verified subject and
 *     installation through the existing tenant resolver. Bearer-only `operator:api`
 *     and `development:local` can never satisfy a private chat route (S7).
 *   • Strict body — P01's frozen `hqChatSessionCreateSchema` (`{headAgentId}`),
 *     unknown keys rejected (S8 "strict request validation with installed validator").
 *   • Server-minted id — the service mints the session; this route never accepts a
 *     caller-supplied session id and never returns a gateway session key (S6/S9).
 *   • Envelope — success carries `schemaVersion,generatedAt,companyId`; every error is
 *     `{error:{code,message,retryable},requestId}` with no raw exception or secret (S8).
 *     Status-only SPEC errors (409 runtime unavailable) use the code chosen by the
 *     owning route — gap G-14.
 */
import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { HqContextError, requireHqContext, type HqContext } from '@/lib/hq/context';
import { createHqSession } from '@/lib/hq/chat';
import { hqChatSessionCreateSchema } from '@/lib/hq/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** S8 error envelope. `retryable` stays false for refusals the client must not blindly repeat. */
function fail(requestId: string, status: number, code: string, message: string, retryable = false): NextResponse {
  return NextResponse.json({ error: { code, message, retryable }, requestId }, { status });
}

/** S8 success envelope: `schemaVersion:1`, `generatedAt`, `companyId` on every 2xx. */
function success(status: number, companyId: string, body: Record<string, unknown>): NextResponse {
  return NextResponse.json({ schemaVersion: 1, generatedAt: new Date().toISOString(), companyId, ...body }, { status });
}

export async function POST(request: NextRequest) {
  const requestId = uuidv4();

  let ctx: HqContext;
  try {
    ctx = await requireHqContext(request);
  } catch (err) {
    if (err instanceof HqContextError) {
      // Narrowed through a local shape so this boundary reads only the refusal fields it
      // publishes; the class itself stays B02's (guarded by the P02 contract §d.4 matrix).
      const refusal = err as { status: number; code: string; message: string; retryable?: boolean };
      return fail(requestId, refusal.status, refusal.code, refusal.message, refusal.retryable ?? false);
    }
    return fail(requestId, 401, 'unauthenticated', 'A verified tenant identity is required.');
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(requestId, 400, 'invalid_request', 'A JSON body is required.');
  }

  const parsed = hqChatSessionCreateSchema.safeParse(raw);
  if (!parsed.success) return fail(requestId, 400, 'invalid_request', 'Body must be {headAgentId}.');

  // S8 fixes session creation to 201 or 409 — there is no reuse path, because the
  // session id is always server-minted (S6 line 255).
  const result = await createHqSession(ctx, parsed.data.headAgentId);
  if (!result.ok) return fail(requestId, result.status, result.code, result.message, result.retryable);
  return success(201, ctx.companyId, { session: result.session });
}
