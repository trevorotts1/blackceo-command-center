import type { NextRequest } from 'next/server';
import {
  checkBodyScope,
  handleCouncil,
  parseJsonBody,
  requireIdempotencyKey,
  requireMutationProof,
  respondOk,
  schemaValidation,
} from '@/lib/council/api/foundation';
import { createDraftSession, parseDraftInput } from '@/lib/council/api/drafts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/sessions (CWE-029 foundation).
 * Lists committed sessions inside the caller's trusted tenant,
 * company, and installation scope. Private sessions appear only for
 * their owner, or through an auditable support read. Reads return
 * committed store state only.
 */
export async function GET(request: NextRequest) {
  return handleCouncil(request, async (ctx) => {
    const url = new URL(request.url);
    const claimed: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) claimed[key] = value;
    checkBodyScope(ctx.principal, claimed);
    const limitRaw = url.searchParams.get('limit');
    const offsetRaw = url.searchParams.get('offset');
    const limit = limitRaw === null ? 50 : Number(limitRaw);
    const offset = offsetRaw === null ? 0 : Number(offsetRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw schemaValidation('limit must be an integer between 1 and 100.');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw schemaValidation('offset must be a non-negative integer.');
    }
    const rows = ctx.store
      .handle()
      .prepare(
        `SELECT id, mode, visibility, state, state_version, brief_revision, archived,
                owner_subject, created_at, updated_at
           FROM council_sessions
          WHERE tenant_id = ? AND company_id = ? AND installation_id = ?
          ORDER BY created_at DESC, id ASC`,
      )
      .all(
        ctx.principal.scope.tenant_id,
        ctx.principal.scope.company_id,
        ctx.principal.scope.installation_id,
      ) as Array<{
      id: string;
      mode: string;
      visibility: string;
      state: string;
      state_version: number;
      brief_revision: number;
      archived: number;
      owner_subject: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const visible = rows.filter(
      (row) =>
        row.visibility === 'company' ||
        row.owner_subject === ctx.principal.subject ||
        ctx.principal.supportAccess,
    );
    const page = visible.slice(offset, offset + limit);
    return respondOk(ctx, {
      sessions: page.map((row) => ({
        session_id: row.id,
        mode: row.mode,
        visibility: row.visibility,
        state: row.state,
        state_version: row.state_version,
        brief_revision: row.brief_revision,
        archived: row.archived === 1,
        owner_subject: row.owner_subject,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      count: page.length,
      total_in_scope: visible.length,
    }, { meta: { support_access: ctx.principal.supportAccess } });
  });
}

/**
 * POST /api/council/sessions (CWE-029 foundation).
 * Creates a session DRAFT through the CWE-006 store: validated
 * SessionSpec, DecisionBrief, and state record, owned by the caller.
 * Draft creation runs no inference and dispatches no task (Section
 * 17.2). Requires CSRF proof and an idempotency key (Section 17.1).
 */
export async function POST(request: NextRequest) {
  return handleCouncil(request, async (ctx) => {
    await requireMutationProof(request);
    const body = await parseJsonBody(request);
    checkBodyScope(ctx.principal, body);
    const idempotencyKey = requireIdempotencyKey(request, body, 'session draft creation');
    const input = parseDraftInput(body);
    const result = createDraftSession(ctx, input, idempotencyKey);
    return respondOk(ctx, result.session, {
      status: result.replayed ? 200 : 201,
      meta: { replayed: result.replayed },
    });
  });
}
