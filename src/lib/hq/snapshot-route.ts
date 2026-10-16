/**
 * GET /api/hq/snapshot — route body, collaborator seam and assembly binding (unit B08).
 *
 * WHY THIS IS NOT `snapshot/route.ts`. Next 16 type-checks every generated route entry
 * against `{ [K in keyof Base]?: ... }` and rejects any export the route contract does
 * not name, so a shipped `route.ts` may export ONLY its handlers and the segment config.
 * This module held three non-route values (`hqSnapshotRouteDeps`,
 * `HQ_SNAPSHOT_ASSEMBLY_PATHS`, `createHqSnapshotRoute`) and that failed the build with
 * `TS2344 ... Property 'hqSnapshotRouteDeps' is incompatible with index signature`.
 * The repo's own layout for route-supporting code is a module under `src/lib/**`
 * (`src/app/api/**` carries zero non-`route.ts` TypeScript files), so the body lives
 * here and `route.ts` keeps only its bindings. No behavior changed in the move.
 *
 * SPEC.md revision 4 §S8, verbatim: *"Authorized current roster, derived layout,
 * connection/capture health, current task links, latest 100 public activities,
 * `highSeq`, `prunedThroughSeq`, `layoutRevision`. State and cursors read in one
 * consistent DB transaction."* §S8 also fixes the envelope: *"All successful
 * responses carry `schemaVersion:1`, `generatedAt`, `companyId`. All errors
 * `{error:{code,message,retryable},requestId}` without raw exceptions/secrets."*
 *
 * AUTHORIZATION BOUNDARY (S7). A Headquarters route must resolve the tenant
 * itself and refuse anything unproven:
 *   - *"Every `/api/hq/*` route resolves `resolveTenantContext(request)` itself
 *     through one shared proposed `requireHqContext` helper; it must receive a
 *     verified subject and installation."* This route calls the repo's existing
 *     verified resolver. B02 owns the shared `requireHqContext` wrapper and its
 *     owner-grant/private-scope rules; when that module is assembled, the call
 *     below is replaced by it — the checks here are a subset of that boundary,
 *     never a competing authority.
 *   - *"`/api/hq` and descendants require direct registration `kind:'self'` and
 *     matching installation"*, and *"a shared client-host request gets 403
 *     `hq_direct_origin_required`"*. Both are enforced before any read.
 *   - The company is the registration's company — *"Client tenant uses its
 *     registered company ID"* — never a request-supplied value.
 *   - *"Check task/workspace/agent/session ownership on snapshot"*: every row the
 *     snapshot reads is filtered by that company id inside the SQL, and labels
 *     resolve in the same scope, so a foreign row cannot arrive through a join.
 *
 * THE ASSEMBLY SEAM (stated, not hidden). The roster projection (B03) and
 * `buildLayout` (B04) and the public activity projection (B05) do not exist on
 * this unit's base `hq/contracts`; `swarm-plan.json` gives each of them its own
 * owner and assigns route/server assembly to A01/A04 ("Assemble actual server
 * exports…"/"Wire direct-host HQ routes"). So the route body is a factory
 * (`createHqSnapshotRoute`) and the default `GET` is bound to
 * `hqSnapshotRouteDeps()`. Until that function returns the real collaborators,
 * every request fails LOUDLY with `hq_modules_not_assembled` naming the exact
 * modules — never a fabricated roster and never an empty office (S10: "disabled
 * if schema unavailable with descriptive setup status"; todo V02: "schema failure
 * is explicit not empty office"). Assembly is a one-line change at that function.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { resolveTenantContext, tenantRegistration, TenantAccessError } from '@/lib/auth/tenant-context';
import type { HqDepartment } from '@/lib/hq/types';
import {
  loadHqSnapshot,
  parseHqSnapshotCursor,
  type HqSnapshotDeps,
  type HqSnapshotState,
} from '@/lib/hq/snapshot';

/** S8 error shape, per the SPEC's own field list. */
function hqError(
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  requestId: string,
): NextResponse {
  return NextResponse.json({ error: { code, message, retryable }, requestId }, { status });
}

export type HqRouteDeps = HqSnapshotDeps & {
  /** B03's roster projection: company scope -> the departments of that company only. */
  loadRoster: (companyId: string) => Promise<{
    departments: HqDepartment[];
    masterWorkspaceId?: string | null;
    sortOrder?: Readonly<Record<string, number>> | null;
  }>;
};

/** Named so the error text and the receipt point at the same path. */
export const HQ_SNAPSHOT_ASSEMBLY_PATHS = [
  'src/lib/hq/roster.ts (B03 — loadRoster)',
  'src/lib/hq/layout.ts (B04 — buildLayout)',
  'src/lib/hq/activity.ts (B05 — toPublicActivityEvent)',
] as const;

/**
 * The collaborators this route needs but does not own. This function is the
 * single place assembly binds them; until then the failure is explicit.
 *
 * TODO(assembly: A01/A04): return the real collaborators —
 *   `loadRoster`  from '@/lib/hq/roster'
 *   `buildLayout` from '@/lib/hq/layout'
 *   `projectEvent` from '@/lib/hq/activity' (toPublicActivityEvent)
 */
export async function hqSnapshotRouteDeps(): Promise<HqRouteDeps> {
  throw new Error(
    `Headquarters snapshot collaborators are not assembled in this tree: ${HQ_SNAPSHOT_ASSEMBLY_PATHS.join(', ')}`,
  );
}

/** The route body, with its collaborators injected so it is testable without a server. */
export function createHqSnapshotRoute(resolveDeps: () => Promise<HqRouteDeps>) {
  return async function GET(request: NextRequest): Promise<NextResponse> {
    const requestId = randomUUID();
    try {
      const context = await resolveTenantContext(request);
      const registration = tenantRegistration(context.host);

      // S7: Headquarters is served directly by the customer's installation.
      if (registration.kind !== 'self' || registration.installationId !== context.installationId) {
        return hqError(
          403,
          'hq_direct_origin_required',
          'Headquarters is served directly by this installation. Open it on the configured customer origin.',
          false,
          requestId,
        );
      }

      // S10: operational fallback flag. Disabled means "say so", not "serve empty".
      if (process.env.HEADQUARTERS_ENABLED === '0') {
        return hqError(503, 'headquarters_disabled', 'Headquarters is not enabled on this installation.', true, requestId);
      }

      const deps = await resolveDeps();
      const companyId = context.companyId;
      const roster = await deps.loadRoster(companyId);
      const snapshot: HqSnapshotState = await loadHqSnapshot(
        getDb(),
        {
          companyId,
          departments: roster.departments,
          masterWorkspaceId: roster.masterWorkspaceId ?? null,
          sortOrder: roster.sortOrder ?? null,
          previousCursor: parseHqSnapshotCursor(request.nextUrl.searchParams.get('after')),
        },
        deps,
      );

      // S8 response: schemaVersion/generatedAt/companyId plus the SPEC-named fields.
      return NextResponse.json({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        companyId,
        roster: roster.departments,
        layout: snapshot.layout,
        layoutRevision: snapshot.layout.revision,
        captureHealth: snapshot.captureHealth,
        taskLinks: snapshot.taskLinks,
        activities: snapshot.activities,
        highSeq: snapshot.highSeq,
        prunedThroughSeq: snapshot.prunedThroughSeq,
        stateSeq: snapshot.stateSeq,
        feedCursor: snapshot.feedCursor,
        feedStart: snapshot.feedStart,
        resetRequired: snapshot.resetRequired,
      });
    } catch (err) {
      if (err instanceof TenantAccessError) {
        return hqError(401, 'unauthenticated', 'A verified tenant identity is required.', false, requestId);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[GET /api/hq/snapshot] failed:', message);
      // An unassembled collaborator is a NAMED condition, not a generic outage.
      if (message.includes('not assembled')) {
        return hqError(503, 'hq_modules_not_assembled', message, true, requestId);
      }
      return hqError(500, 'snapshot_unavailable', 'The Headquarters snapshot could not be read.', true, requestId);
    }
  };
}
