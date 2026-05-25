/**
 * GET /api/operator/bridge/stream
 *
 * Replays a Bridge session's message history as Server-Sent Events.
 *
 * Query params:
 *   - `session_id`  required. The `operator_chat_sessions.id` to replay.
 *   - `agent_id`    optional. If provided AND no session matches, the route
 *                   returns the most recent session for that agent.
 *   - `limit`       optional. Max messages to emit (default 200, cap 1000).
 *
 * Why a GET and not a WebSocket: the active turn streams over the POST
 * /send response (the request stays open until the agent finishes). The
 * GET stream is for two cases:
 *   1. Re-attaching the UI to a session after navigation or refresh, so the
 *      operator does not lose context.
 *   2. Future Track B8 (Call Mode) listening for assistant deltas while
 *      voice mode is active.
 *
 * The route emits one `message` SSE per row in chronological order, then
 * a final `done` event with `{ count, session_id }`. The client closes
 * the reader on `done`.
 *
 * PRD 4.3 reuses BlackCEO's existing SSE infrastructure (`src/lib/events.ts`)
 * for global broadcast events. This route does NOT broadcast; it serves a
 * single client's replay. Keeping replay separate from the broadcast bus
 * avoids cross-session bleed and keeps the broadcaster's client set small.
 */

import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MessageRow {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  agent_id: string;
  title: string | null;
  scratch_dir: string | null;
  updated_at: string;
}

function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function resolveSession(args: {
  sessionId?: string;
  agentId?: string;
}): SessionRow | null {
  const db = getDb();
  if (args.sessionId) {
    const row = db
      .prepare(
        `SELECT id, agent_id, title, scratch_dir, updated_at
         FROM operator_chat_sessions WHERE id = ?`,
      )
      .get(args.sessionId) as SessionRow | undefined;
    if (row) return row;
  }
  if (args.agentId) {
    const row = db
      .prepare(
        `SELECT id, agent_id, title, scratch_dir, updated_at
         FROM operator_chat_sessions
         WHERE agent_id = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(args.agentId) as SessionRow | undefined;
    if (row) return row;
  }
  return null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('session_id') ?? undefined;
  const agentId = url.searchParams.get('agent_id') ?? undefined;
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;

  if (!sessionId && !agentId) {
    return new Response(
      JSON.stringify({
        error: 'invalid_request',
        detail: 'session_id or agent_id is required',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const session = resolveSession({ sessionId, agentId });
  if (!session) {
    return new Response(
      JSON.stringify({ error: 'session_not_found', session_id: sessionId ?? null }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, role, content, metadata, created_at
       FROM operator_chat_messages
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(session.id, limit) as MessageRow[];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        sseEvent('session', {
          session_id: session.id,
          agent_id: session.agent_id,
          title: session.title,
          scratch_dir: session.scratch_dir,
          updated_at: session.updated_at,
        }),
      );

      for (const row of rows) {
        let metadata: Record<string, unknown> = {};
        try {
          metadata = row.metadata ? JSON.parse(row.metadata) : {};
        } catch {
          metadata = {};
        }
        controller.enqueue(
          sseEvent('message', {
            id: row.id,
            role: row.role,
            content: row.content,
            metadata,
            created_at: row.created_at,
          }),
        );
      }

      controller.enqueue(
        sseEvent('done', { count: rows.length, session_id: session.id }),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
