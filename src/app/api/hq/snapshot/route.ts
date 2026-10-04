/**
 * GET /api/hq/snapshot (unit B08, milestone V08).
 *
 * Next 16 type-checks every generated route entry and rejects any export the route
 * contract does not name, so this file may export ONLY its handler and the segment
 * config. The route body, its collaborator seam and the assembly binding live in
 * `@/lib/hq/snapshot-route` (the repo's own location for route-supporting modules);
 * this file is the binding, and nothing about the endpoint changed in the move.
 */

import { createHqSnapshotRoute, hqSnapshotRouteDeps } from '@/lib/hq/snapshot-route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const GET = createHqSnapshotRoute(hqSnapshotRouteDeps);
