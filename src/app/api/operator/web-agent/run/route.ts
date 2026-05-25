/**
 * POST /api/operator/web-agent/run
 *
 * Start a new Web Agent session.
 *
 * Request body:  { task: string, start_url?: string }
 * Response:      { session_id, status, started_at, screenshots_dir }
 *
 * Track B9 (SCOPE-ADDITION Section 7).
 *
 * The route persists the session row, returns its id immediately, and fires
 * `runSession` on a detached promise. The operator UI then opens the SSE
 * stream at `/api/operator/web-agent/session/[id]/stream` to follow progress
 * in real time. Keeping the run in-process keeps Wave 1 simple; a future
 * revision can move the runner to a worker without changing this route's
 * client contract.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createSession, runSession } from '@/lib/web-agent/runner';

const requestSchema = z.object({
  task: z.string().min(1).max(4000),
  start_url: z.string().url().optional(),
});

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof requestSchema>;
  try {
    const json = await req.json();
    parsed = requestSchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_request', detail: err instanceof Error ? err.message : 'bad body' },
      { status: 400 }
    );
  }

  const session = createSession({ task: parsed.task });

  // Fire and forget. The runner publishes every meaningful state change over
  // the SSE bus and persists status changes to the DB, so a route-level
  // failure here is observable from both surfaces.
  void runSession(session.id, { startUrl: parsed.start_url }).catch((err) => {
    // Last-resort logger. The runner already catches everything internally;
    // this only fires for a synchronous throw before the try/catch arms.
    console.error('[web-agent] runSession crashed:', err);
  });

  return NextResponse.json({
    session_id: session.id,
    status: session.status,
    started_at: session.started_at,
    screenshots_dir: session.screenshots_dir,
  });
}
