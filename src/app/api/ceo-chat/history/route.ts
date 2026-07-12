/**
 * GET /api/ceo-chat/history?sessionId=... (P5-01 (c) step 1)
 *
 * Returns a ceo-chat session's transcript plus the "What's happening" side-rail
 * data: the tasks THIS chat spawned (requester_channel='ceo-chat' +
 * requester_chat_id=sessionId) with their live status, so the UI can render
 * status chips off the board (P5-01 step 3) exactly as the trust engine reports
 * them back into the transcript.
 *
 * Same-origin + session-gated by the existing middleware contract (a non-webhook
 * /api route: the board's own same-origin fetch passes; an external caller still
 * needs the MC_API_TOKEN bearer). Never throws to the client.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCeoChatHistory } from '@/lib/ceo-chat/store';
import { isMyAiCeoBetaEnabled, CEO_CHAT_CHANNEL } from '@/lib/ceo-chat/config';
import { queryAll } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface SpawnedTaskRow {
  id: string;
  title: string;
  status: string;
  department: string | null;
  updated_at: string;
}

export async function GET(request: NextRequest) {
  if (!isMyAiCeoBetaEnabled()) {
    return NextResponse.json({ ok: false, enabled: false, error: 'My AI CEO (BETA) is disabled on this box.' }, { status: 404 });
  }
  const sessionId = request.nextUrl.searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'sessionId is required' }, { status: 400 });
  }
  const limit = Number(request.nextUrl.searchParams.get('limit') || 200);

  try {
    const messages = getCeoChatHistory(sessionId, Number.isFinite(limit) ? limit : 200);

    // The tasks this chat spawned — the side rail. Best-effort: a very old box
    // without the requester_* columns simply returns no tasks (the try/catch),
    // never a 500.
    let tasks: SpawnedTaskRow[] = [];
    try {
      tasks = queryAll<SpawnedTaskRow>(
        `SELECT id, title, status, department, updated_at
           FROM tasks
          WHERE requester_channel = ? AND requester_chat_id = ?
          ORDER BY updated_at DESC
          LIMIT 100`,
        [CEO_CHAT_CHANNEL, sessionId],
      );
    } catch {
      tasks = [];
    }

    return NextResponse.json({ ok: true, enabled: true, sessionId, messages, tasks, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[/api/ceo-chat/history] failed:', err);
    return NextResponse.json({ ok: false, error: 'Failed to load history', messages: [], tasks: [] }, { status: 500 });
  }
}
