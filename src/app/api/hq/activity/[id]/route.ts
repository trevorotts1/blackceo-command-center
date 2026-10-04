/**
 * Company Headquarters activity detail — SPEC rev 4 S8 line 306:
 * "Authorized sanitized detail; 404 foreign/unknown; source tombstone if
 * deleted."
 *
 * Owned by B07 together with the collection route; the two share one company
 * resolution and one public projection policy — the projection itself is B05's
 * `toPublicActivityEvent`/`toPublicPayload`, so a detail read can never expose a
 * field the feed hid. Nothing but `/api/hq/activity*` is touched.
 *
 * Authority: SPEC.md rev 4 (S5 line 217 safe content, S6 line 235 physical source
 * deletion does not cascade-delete activity, S7 line 267 ownership on
 * snapshot/pagination/chat reads, S8 line 306). Frozen response names come from
 * `src/lib/hq/types.ts` (P01) and are imported, never redeclared.
 *
 * DECLARED CONTRACT IMPORTS. Both are other units' owned paths, absent from this
 * worktree because it bases on `hq/contracts`:
 *   - `@/lib/hq/context`  → `requireHqContext` (B02; the one shared identity
 *     helper SPEC S7 line 263 requires on every /api/hq/* route).
 *   - `@/lib/hq/activity` → `toPublicActivityEvent` (B05; owner of the S5/S6
 *     public projection, gaps G-08/G-09).
 * Joined to their real published shapes, read from unit/B05-builder. This unit's
 * focused tests supply private test-only stubs mirroring those shapes; none is
 * shipped.
 *
 * CARRIED — the tombstone shape (interfaces.md G-15, owner B07): the SPEC
 * requires "source tombstone if deleted" and freezes no shape, so the only honest
 * shape is one whose fields this route actually observed. `removedAt` is
 * deliberately null: the SPEC prescribes no tombstone timestamp, and inventing
 * one would be a fabricated fact. P01's `tombstone: unknown` is narrowed here by
 * its first consumer, per S17 change control.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type HqActivityKind, type HqApiErrorResponse } from '@/lib/hq/types';
import { getDb } from '@/lib/db';
import { requireHqContext } from '@/lib/hq/context';
import { toPublicActivityEvent } from '@/lib/hq/activity';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** S8 detail tombstone — the first consumer of gap G-15 freezes the shape. */
const hqActivityTombstoneSchema = z.object({
  removed: z.literal(true),
  reference: z.string(),
  kind: z.string(),
  receivedAt: z.string(),
  removedAt: z.string().nullable(),
  reason: z.string(),
});

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

function fail(status: number, code: string, message: string, retryable = false): NextResponse {
  const body: HqApiErrorResponse = { error: { code, message, retryable }, requestId: randomUUID() };
  return NextResponse.json(body, { status });
}

function ok<T extends Record<string, unknown>>(companyId: string, payload: T): NextResponse {
  return NextResponse.json({ schemaVersion: 1, generatedAt: new Date().toISOString(), companyId, ...payload });
}

function isMissingHqTable(err: unknown): boolean {
  return /no such table: hq_/i.test(err instanceof Error ? err.message : String(err));
}

/** Resolve the caller's authorized company through the one shared helper (S7 line 263). */
async function resolveCompanyId(request: NextRequest): Promise<string | NextResponse> {
  try {
    const ctx = await requireHqContext(request);
    if (!ctx || typeof ctx.companyId !== 'string' || !ctx.companyId) {
      return fail(403, 'company_not_bound', 'No authorized company is resolved for this request');
    }
    return ctx.companyId;
  } catch (err) {
    const status = (err as { status?: number }).status;
    return fail(typeof status === 'number' ? status : 401, 'unauthorized', 'A verified Headquarters identity is required');
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const companyId = await resolveCompanyId(request);
  if (companyId instanceof NextResponse) return companyId;
  const { id } = await params;

  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT seq, id, company_id, source_key, kind, phase, task_id, actor_agent_id,
                recipient_agent_id, occurred_at, received_at, payload_json
           FROM hq_activity
          WHERE company_id = ? AND id = ?`,
      )
      .get(companyId, id) as HqActivityRow | undefined;

    // SPEC S7 line 267: foreign and unknown are the SAME 404 with the SAME
    // message — the response may not leak whether another company holds this id.
    if (!row) return fail(404, 'not_found', 'No such activity');

    // S6 line 235: "Physical source deletion does not cascade-delete the
    // activity. Query joins recheck current permissions; removed targets yield
    // tombstones with no retained secret names."
    const targetExists = (targetId: string | null, table: 'tasks' | 'agents'): boolean => {
      if (!targetId) return true;
      if (table === 'tasks') {
        return !!db
          .prepare(`SELECT 1 FROM tasks WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE company_id = ?)`)
          .get(targetId, companyId);
      }
      return !!db
        .prepare(`SELECT 1 FROM agents WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE company_id = ?)`)
        .get(targetId, companyId);
    };

    const missingTargets: Array<'task' | 'actor' | 'recipient'> = [];
    if (!targetExists(row.task_id, 'tasks')) missingTargets.push('task');
    if (!targetExists(row.actor_agent_id, 'agents')) missingTargets.push('actor');
    if (!targetExists(row.recipient_agent_id, 'agents')) missingTargets.push('recipient');

    if (missingTargets.length > 0) {
      const tombstone = hqActivityTombstoneSchema.parse({
        removed: true,
        reference: row.source_key,
        kind: row.kind,
        receivedAt: row.received_at,
        removedAt: null,
        reason: `source ${missingTargets.join(', ')} no longer present in current scope`,
      });
      // The event is NOT returned alongside a tombstone: the surviving payload
      // was addressed to the removed target, and S6 requires that a removed
      // target's tombstone retain no secret names.
      return ok(companyId, { event: null, tombstone, removedTargets: missingTargets });
    }

    const resolveLabel = (agentId: string): string | null => {
      const found = db
        .prepare(
          `SELECT a.name AS name FROM agents a
             JOIN workspaces w ON w.id = a.workspace_id
            WHERE a.id = ? AND w.company_id = ?`,
        )
        .get(agentId, companyId) as { name: string | null } | undefined;
      return found?.name ?? null;
    };

    return ok(companyId, {
      event: toPublicActivityEvent({ ...row, kind: row.kind as HqActivityKind }, resolveLabel),
      tombstone: null,
    });
  } catch (err) {
    if (isMissingHqTable(err)) {
      return fail(503, 'hq_storage_unavailable', 'Headquarters storage is not migrated on this installation', true);
    }
    throw err;
  }
}
