import { NextRequest, NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';
import { getClientContext, toPublicClient, clientToOpenClawTarget } from '@/lib/clients';
import { getOpenClawClient } from '@/lib/openclaw/client';
import type { Event } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/events/client-feed
 *
 * E23: Returns recent events scoped to the SELECTED client.
 *
 * FEED OF RECORD (DATA-07): the self/local path reads the legacy `events` table
 * — the authoritative activity feed (see the header note in /api/events/route.ts).
 * `task_events` is a partial sink until DISP-10 routes all status writes through
 * transition(); do NOT repoint this feed at it before then. Migration is tracked
 * with DISP-10 (lane L3).
 *
 * Self-client: reads the local SQLite events table (same as /api/events).
 * Remote client: attempts to connect to the client's OpenClaw gateway and
 *   surfaces recent sessions as feed items. Falls back gracefully to an empty
 *   list with a `gateway_unreachable: true` flag so the UI can show an honest
 *   error state instead of stale data.
 *
 * Always returns:
 *   {
 *     events: Event[],
 *     client: PublicClient,
 *     source: 'local_db' | 'gateway_sessions' | 'gateway_unreachable',
 *     gateway_error?: string,
 *   }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
  const since = searchParams.get('since'); // ISO timestamp for polling

  const clientCtx = getClientContext();
  const publicClient = clientCtx ? toPublicClient(clientCtx) : null;

  // ── Self / local client: read the DB directly ────────────────────────────
  if (!clientCtx || clientCtx.is_self) {
    let sql = `
      SELECT e.*, a.name as agent_name, a.avatar_emoji as agent_emoji, t.title as task_title
      FROM events e
      LEFT JOIN agents a ON e.agent_id = a.id
      LEFT JOIN tasks t ON e.task_id = t.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (since) {
      sql += ' AND e.created_at > ?';
      params.push(since);
    }

    sql += ' ORDER BY e.created_at DESC LIMIT ?';
    params.push(limit);

    try {
      const rows = queryAll<Event & { agent_name?: string; agent_emoji?: string; task_title?: string }>(
        sql,
        params,
      );
      const events = rows.map((e) => ({
        ...e,
        agent: e.agent_id ? { id: e.agent_id, name: e.agent_name, avatar_emoji: e.agent_emoji } : undefined,
        task: e.task_id ? { id: e.task_id, title: e.task_title } : undefined,
      }));
      return NextResponse.json({
        events,
        client: publicClient,
        source: 'local_db' as const,
      });
    } catch (err) {
      console.error('[/api/events/client-feed] DB read failed:', err);
      return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
    }
  }

  // ── Remote client: pull sessions from the client's OpenClaw gateway ──────
  try {
    const target = clientToOpenClawTarget(clientCtx);
    const oc = getOpenClawClient(target);

    if (!oc.isConnected()) {
      await oc.connect(); // throws on failure — caught below
    }

    const rawSessions = await oc.listSessions();

    // Shape gateway sessions into the Event interface so the LiveFeed can
    // render them without knowing they came from a gateway rather than the DB.
    const now = new Date().toISOString();
    const events: Event[] = (rawSessions as Array<{
      id?: string;
      session_id?: string;
      channel?: string;
      peer?: string;
      status?: string;
      created_at?: string;
      updated_at?: string;
    }>)
      .slice(0, limit)
      .map((s, i) => ({
        id: s.id ?? s.session_id ?? `gw-${i}`,
        type: 'agent_joined' as const,
        agent_id: undefined,
        task_id: undefined,
        message: s.peer
          ? `Gateway session: ${s.channel ?? 'unknown'} with ${s.peer}${s.status ? ` (${s.status})` : ''}`
          : `Gateway session: ${s.channel ?? 'unknown channel'}${s.status ? ` — ${s.status}` : ''}`,
        metadata: undefined,
        created_at: s.created_at ?? s.updated_at ?? now,
      }));

    return NextResponse.json({
      events,
      client: publicClient,
      source: 'gateway_sessions' as const,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gateway unreachable';
    console.warn(`[/api/events/client-feed] Remote gateway error for client ${clientCtx.id}:`, message);

    // Return an empty list with an explicit flag — the LiveFeed shows an
    // honest error state instead of stale/empty content with no explanation.
    return NextResponse.json({
      events: [],
      client: publicClient,
      source: 'gateway_unreachable' as const,
      gateway_error: message,
    });
  }
}
