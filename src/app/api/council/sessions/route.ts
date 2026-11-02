import { NextResponse, type NextRequest } from 'next/server';
import {
  checkBodyScope,
  handleCouncil,
  parseJsonBody,
  requireIdempotencyKey,
  requireMutationProof,
  schemaValidation,
} from '@/lib/council/api/foundation';
import { assertNoConfiguredSecretsInPayload } from '@/lib/council/auth';
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
        `SELECT s.id, s.mode, s.visibility, s.state, s.state_version, s.brief_revision, s.archived,
                s.owner_subject, s.created_at, s.updated_at,
                (SELECT br.question FROM council_brief_revisions br
                  WHERE br.tenant_id = s.tenant_id AND br.company_id = s.company_id
                    AND br.session_id = s.id AND br.revision = s.brief_revision
                  LIMIT 1) AS question
           FROM council_sessions s
          WHERE s.tenant_id = ? AND s.company_id = ? AND s.installation_id = ?
          ORDER BY s.created_at DESC, s.id ASC`,
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
      question: string | null;
    }>;
    const visible = rows.filter(
      (row) =>
        row.visibility === 'company' ||
        row.owner_subject === ctx.principal.subject ||
        ctx.principal.supportAccess,
    );
    const page = visible.slice(offset, offset + limit);
    const data = {
      sessions: page.map((row) => ({
        session_id: row.id,
        // CTR-191: the canonical chamber labels a session by its question.
        question: row.question,
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
    };
    // The CC React client unwraps `{ok,data}`; the canonical chamber reads
    // `body.sessions` directly (chamber-live.js refreshList). One authorized
    // read, both shapes, no second source of truth.
    assertNoConfiguredSecretsInPayload(data);
    return NextResponse.json({
      ok: true,
      data,
      request_id: ctx.requestId,
      meta: { support_access: ctx.principal.supportAccess },
      ...data,
    });
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
