import { NextRequest, NextResponse } from 'next/server';
import {
  eventContradictsToken,
  ingestSkill71Event,
  validateSkill71Event,
  verifySkill71IngestToken,
} from '@/lib/skill71-runs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/skill-runs/ingest: Skill 71 run events, HTTP transport.
 *
 * Fix plan Item 26 (Amendment 1 rider): fleet-hostinger boxes push their
 * run events here; a fleet-mac deployment does the same only when it has
 * opted into Command Center visibility; fleet-contabo uses the file
 * transport instead (same ingestion core in src/lib/skill71-runs.ts).
 *
 * AUTH: `Authorization: Bearer <per-client token>`. The token record
 * (skill71_ingest_tokens, hash only) binds client_slug + host_shape; an
 * event whose claimed slug or shape contradicts its token is rejected.
 * This route authenticates itself and is deliberately NOT in
 * src/lib/bearer-required-routes.ts: the global MC_API_TOKEN is the
 * operator's credential, and client boxes must never hold it.
 *
 * BODY: one event object, { "events": [ ... ] }, or a JSONL string.
 * Delivery is at-least-once: duplicates (same event_id) are reported as
 * duplicates, never errors, so a shipper re-sending after a crash is
 * safe. Per-event results come back in the response; a batch with at
 * least one accepted or duplicate event answers 200, a batch where
 * every event was rejected answers 422.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
  const token = verifySkill71IngestToken(bearer);
  if (!token) {
    return NextResponse.json({ error: 'Invalid or missing ingest token' }, { status: 401 });
  }

  const rawBody = await request.text();
  let candidates: unknown[] = [];
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return NextResponse.json({ error: 'Empty body' }, { status: 400 });
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      candidates = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { events?: unknown }).events)) {
      candidates = (parsed as { events: unknown[] }).events;
    } else {
      candidates = [parsed];
    }
  } catch {
    // Not a single JSON document: try JSONL (one event per line).
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    try {
      candidates = lines.map((l) => JSON.parse(l) as unknown);
    } catch {
      return NextResponse.json({ error: 'Body is neither JSON nor JSONL' }, { status: 400 });
    }
  }
  if (candidates.length === 0) {
    return NextResponse.json({ error: 'No events in body' }, { status: 400 });
  }
  if (candidates.length > 500) {
    return NextResponse.json({ error: 'Batch too large (max 500 events)' }, { status: 413 });
  }

  const results: Array<{
    event_id: string | null;
    status: 'inserted' | 'duplicate' | 'rejected';
    errors?: string[];
  }> = [];
  for (const candidate of candidates) {
    const validation = validateSkill71Event(candidate);
    if (!validation.ok) {
      const id = (candidate as { event_id?: unknown })?.event_id;
      results.push({
        event_id: typeof id === 'string' ? id : null,
        status: 'rejected',
        errors: validation.errors,
      });
      continue;
    }
    const contradiction = eventContradictsToken(validation.event, token);
    if (contradiction) {
      results.push({
        event_id: validation.event.event_id,
        status: 'rejected',
        errors: [contradiction],
      });
      continue;
    }
    try {
      const outcome = ingestSkill71Event(validation.event, {
        source: `http:${token.client_slug}`,
        client_slug: token.client_slug,
        host_shape: token.host_shape,
      });
      results.push({ event_id: outcome.event_id, status: outcome.status });
    } catch (err) {
      console.error('[skill-runs ingest] failed:', err);
      results.push({
        event_id: validation.event.event_id,
        status: 'rejected',
        errors: ['ingestion error'],
      });
    }
  }

  const rejected = results.filter((r) => r.status === 'rejected').length;
  const status = rejected === results.length ? 422 : 200;
  return NextResponse.json(
    {
      accepted: results.filter((r) => r.status === 'inserted').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      rejected,
      results,
    },
    { status },
  );
}
