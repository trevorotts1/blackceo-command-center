import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { queryOne } from '@/lib/db';
import type { PersonaBundle, TaskPersonaBundleRow } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/tasks/[id]/persona-bundle — B-U1 (master id U15) rung 2 of the
 * persona-bundle-acquisition ladder in `06-ghl-install-pages/tools/
 * v2_dispatcher.py`'s `_resolve_persona_bundle`.
 *
 * The ladder's rung 1 (threaded) needs the Command Center dispatch payload to
 * carry `task_persona_bundle.bundle_json` directly (a separate, ONB-side
 * threading change — not this unit). Rung 2 is THIS endpoint: a read-only
 * fetch a standalone/offline-dispatched build can make against the Command
 * Center for a task id it already knows, so it gets the SAME blend bundle the
 * Command Center already resolved instead of re-selecting a second time.
 * Mirrors the `task_persona_bundle` row (migration 090) verbatim — this route
 * has no write path and no side effects.
 *
 * ── Auth: Bearer-only (NOT the full HMAC+Bearer webhook scheme) ────────────
 * The real, already-shipped caller — `fetch_persona_bundle()` in
 * `06-ghl-install-pages/tools/cc_board.py` — documents its own auth
 * explicitly: "Bearer only (same class as `post_activity` — a read endpoint,
 * no HMAC per-route layer)." It sends `Authorization: Bearer $MC_API_TOKEN`
 * and NEVER an `x-webhook-signature` header for this GET. `/api/tasks/[id]/
 * status`'s two-layer `authenticate()` (Bearer + HMAC-over-rawBody) is the
 * scheme for the WRITE/webhook family (ingest, status, agent-completion) —
 * mandating that same HMAC layer here would 401 this endpoint's one real
 * caller on any box with WEBHOOK_SECRET configured, since it never sends the
 * signature header for a read. So this route reuses ONLY Layer 1 of that
 * scheme (byte-identical constant-time Bearer comparison) — it is not a new,
 * invented auth path, it is the same Bearer check every other task-scoped GET
 * (`/activities`, `/deliverables`) already relies on via the global
 * middleware Gate B (`src/middleware.ts`). This route additionally enforces
 * that same Bearer check INLINE (not middleware-only) so the guard is
 * directly exercised by a route-level test without having to drive the Edge
 * middleware — defense in depth, identical actor (`MC_API_TOKEN`), same
 * skip-when-unset posture as every sibling route (dev / same-origin).
 * Consistent with this route NOT being listed in `WEBHOOK_SECRET_ROUTES` /
 * `WEBHOOK_SECRET_DYNAMIC_ROUTES` (middleware.ts): it stays in the
 * same-origin-passthrough-eligible, Bearer-gated-for-external-callers read
 * family, not the fail-closed-without-WEBHOOK_SECRET webhook family.
 */

/**
 * Constant-time string comparison (byte-identical to `/api/tasks/[id]/
 * status/route.ts`'s `safeEqual`). Returns false without leaking timing
 * beyond length, since `timingSafeEqual` throws on unequal buffer lengths.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

type AuthResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Bearer-only auth — Layer 1 ONLY of the cc_board two-layer scheme (see file
 * header). Enforced only when MC_API_TOKEN is configured, matching every
 * sibling route's dev/same-origin posture.
 */
function authenticate(request: NextRequest): AuthResult {
  const token = process.env.MC_API_TOKEN;
  if (!token) return { ok: true };

  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  const presented = authHeader.slice(7);
  if (!safeEqual(presented, token)) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = authenticate(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const { id } = await params;

    const task = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [id]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const row = queryOne<TaskPersonaBundleRow>(
      'SELECT * FROM task_persona_bundle WHERE task_id = ?',
      [id],
    );

    // No bundle yet (task never ran through resolvePersonaAndPin /
    // pinProducerPersonaBundle) — a real, expected state, not an error. The
    // caller's fetch_persona_bundle() treats any falsy/absent bundle as "not
    // fetched" and falls through to its local rung, so 200 + null is exactly
    // as fail-soft as a 404 for that caller while staying more diagnosable
    // for a human hitting this route directly (distinguishes "no bundle yet"
    // from "unknown task id" / "route not shipped on this box").
    if (!row) {
      return NextResponse.json(
        { task_id: id, bundle: null, confirm_state: null, catalog_version: null },
        { status: 200 },
      );
    }

    let bundle: PersonaBundle | null;
    try {
      bundle = JSON.parse(row.bundle_json) as PersonaBundle;
    } catch {
      // Stored JSON is corrupt — fail loud rather than handing the caller a
      // bundle it cannot trust.
      return NextResponse.json(
        { error: 'Stored persona bundle is malformed' },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        task_id: id,
        bundle,
        confirm_state: row.confirm_state,
        catalog_version: row.catalog_version,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[tasks persona-bundle] Failed to read persona bundle:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
