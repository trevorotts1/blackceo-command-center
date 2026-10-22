/**
 * launch-transport.ts — the authenticated HTTP transport adapter for launch
 * ingest (run events + progress samples).
 *
 * One handler, one gate, two event families:
 *   { "events": [...] }                 → launch run events (frozen contract v1.0
 *                                         + launch extensions skill/launch_id/
 *                                         installation_id)
 *   { "progress": <sample> }            → launch progress sample
 *   { "samples": [<sample>, ...] }      → launch progress samples
 *   a single object (either family)     → accepted directly
 *   JSONL, one object per line          → accepted directly
 *
 * AUTH: `Authorization: Bearer <per-client token>`. The token record
 * (`skill71_ingest_tokens`, hash only) binds client_slug + host_shape; this
 * installation's `MC_INSTALLATION_ID` is added as the third binding. An event
 * or sample that CONTRADICTS the token is rejected before a row is written.
 * The token value is never logged, echoed or stored.
 *
 * The Next.js route that mounts this is a one-line adapter; because a new
 * mutating route changes the U052 write census (a shared file this lane does
 * not own), the mount is recorded as a patch proposal under the lane folder
 * instead of being added here. The handler itself is the real transport:
 * tested against a real isolated database with a real hashed token.
 */

import {
  ingestAuthenticatedLaunchRunEvent,
  ingestAuthenticatedProgressSample,
} from './launch-ability-runs';
import { verifySkill71IngestToken } from './skill71-runs';
import type { LaunchIngestToken } from './launch-run-events';

export interface LaunchTransportRequest {
  authorization: string | null;
  body: string;
}

export interface LaunchTransportItemResult {
  kind: 'event' | 'progress' | 'unknown';
  id: string | null;
  status: 'inserted' | 'duplicate' | 'rejected';
  errors?: string[];
}

export interface LaunchTransportResponse {
  status: number;
  payload: {
    accepted: number;
    duplicates: number;
    rejected: number;
    results: LaunchTransportItemResult[];
    error?: string;
  };
}

const MAX_BATCH = 500;
const MAX_BODY_CHARS = 2_000_000;

/** This installation's identity. Never a client-supplied value. */
export function launchInstallationId(): string {
  return (process.env.MC_INSTALLATION_ID || 'local').trim() || 'local';
}

function emptyResponse(status: number, error: string): LaunchTransportResponse {
  return {
    status,
    payload: { accepted: 0, duplicates: 0, rejected: 0, results: [], error },
  };
}

function parseBody(rawBody: string): { ok: true; items: unknown[] } | { ok: false; error: string } {
  const trimmed = rawBody.trim();
  if (!trimmed) return { ok: false, error: 'Empty body' };
  if (trimmed.length > MAX_BODY_CHARS) return { ok: false, error: 'Body too large' };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return { ok: true, items: parsed };
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.events)) return { ok: true, items: record.events };
      if (Array.isArray(record.samples)) return { ok: true, items: record.samples };
      if (record.progress !== undefined) return { ok: true, items: [record.progress] };
      return { ok: true, items: [parsed] };
    }
    return { ok: false, error: 'Body is not a launch event or progress sample' };
  } catch {
    try {
      const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
      return { ok: true, items: lines.map((line) => JSON.parse(line) as unknown) };
    } catch {
      return { ok: false, error: 'Body is neither JSON nor JSONL' };
    }
  }
}

function itemKind(value: unknown): 'event' | 'progress' | 'unknown' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const record = value as Record<string, unknown>;
  if (typeof record.event_type === 'string') return 'event';
  if (record.project_id !== undefined && record.room_id !== undefined) return 'progress';
  return 'unknown';
}

function itemId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.event_id === 'string') return record.event_id;
  if (typeof record.project_id === 'string' && typeof record.room_id === 'string') {
    return `${record.project_id}/${record.room_id}`;
  }
  return null;
}

/**
 * Handle one authenticated launch-ingest request. Never throws: a database
 * failure is a 503 with an actionable error, never an empty success.
 */
export function handleLaunchIngest(request: LaunchTransportRequest): LaunchTransportResponse {
  const auth = request.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
  let stored: { client_slug: string; host_shape: string } | null;
  try {
    stored = verifySkill71IngestToken(bearer);
  } catch (error) {
    return emptyResponse(
      503,
      `launch ingest store unavailable: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
  if (!stored) return emptyResponse(401, 'Invalid or missing ingest token');
  if (!(stored.host_shape === 'fleet-mac' || stored.host_shape === 'fleet-hostinger' || stored.host_shape === 'fleet-contabo')) {
    return emptyResponse(422, 'Ingest token has an unknown host shape');
  }
  const token: LaunchIngestToken = {
    client_slug: stored.client_slug,
    host_shape: stored.host_shape,
    installation_id: launchInstallationId(),
  };

  const parsed = parseBody(request.body);
  if (!parsed.ok) return emptyResponse(400, parsed.error);
  if (parsed.items.length === 0) return emptyResponse(400, 'No events in body');
  if (parsed.items.length > MAX_BATCH) {
    return emptyResponse(413, `Batch too large (max ${MAX_BATCH} items)`);
  }

  const source = `http:${token.client_slug}`;
  const results: LaunchTransportItemResult[] = [];

  for (const item of parsed.items) {
    const kind = itemKind(item);
    if (kind === 'event') {
      const decision = ingestAuthenticatedLaunchRunEvent(item, token, source);
      results.push(decision.ok
        ? { kind, id: decision.outcome.event_id, status: decision.outcome.status }
        : { kind, id: itemId(item), status: 'rejected', errors: decision.errors });
      continue;
    }
    if (kind === 'progress') {
      const outcome = ingestAuthenticatedProgressSample(item, token, source);
      results.push(outcome.status === 'rejected'
        ? { kind, id: itemId(item), status: 'rejected', errors: outcome.errors }
        : { kind, id: itemId(item), status: outcome.status });
      continue;
    }
    results.push({
      kind: 'unknown',
      id: itemId(item),
      status: 'rejected',
      errors: ['item is neither a launch run event nor a launch progress sample'],
    });
  }


  const accepted = results.filter((r) => r.status === 'inserted').length;
  const duplicates = results.filter((r) => r.status === 'duplicate').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;
  return {
    status: rejected === results.length ? 422 : 200,
    payload: { accepted, duplicates, rejected, results },
  };
}
