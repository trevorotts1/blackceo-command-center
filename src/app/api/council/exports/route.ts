import type { NextRequest } from 'next/server';
import {
  authorizeSessionMutate,
  checkBodyScope,
  handleCouncil,
  parseJsonBody,
  requireIdempotencyKey,
  requireMutationProof,
  respondOk,
  schemaValidation,
} from '@/lib/council/api/foundation';
import { createExportRoute } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/exports (CWE-050, CWE-038's CC remainder).
 *
 * Creates a report export from the session's one committed verdict:
 * the report model is built once from the validated verdict, the
 * frozen brief, and the final cards; Markdown, the canonical record
 * JSON, and print HTML render deterministically from it; each
 * artifact journals a report_export record binding the exact
 * verdict revision and content hash, and registers through the
 * Command Center evidence path when the session has a parent task
 * (B15). A request naming PDF refuses EXPORT_FORMAT_NOT_READY
 * naming the missing renderer — no bytes are faked (Section 24.3).
 * The session is mutate-authorized from the body's session_id.
 */
export async function POST(request: NextRequest) {
  return handleCouncil(request, async (ctx) => {
    await requireMutationProof(request);
    const body = await parseJsonBody(request);
    checkBodyScope(ctx.principal, body);
    const idempotencyKey = requireIdempotencyKey(request, body, 'report export');
    if (typeof body.session_id !== 'string' || body.session_id.length === 0) {
      throw schemaValidation('Field "session_id" is required and must be a non-empty string.');
    }
    const authorized = authorizeSessionMutate(ctx, body.session_id);
    const result = createExportRoute(ctx, authorized, body, idempotencyKey);
    return respondOk(ctx, result, {
      status: 201,
      meta: { access_via: authorized.accessVia },
    });
  });
}
