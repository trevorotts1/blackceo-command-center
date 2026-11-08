/**
 * CON-22 (U-cc-02) — /launch lists real runs without LAUNCH_PLANS_DIR, the
 * navigation names it, and ingest accepts the U-cc-01 emitter payload.
 *
 * Real isolated database; the token below is a synthetic fixture.
 */

import './_isolated-db';

import { createHash } from 'crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { describe, it, expect, beforeAll, vi } from 'vitest';

import { run, queryAll as query } from '@/lib/db';
import { OPERATOR_NAV } from '@/components/OperatorSidebar';
import { POST as ingestPOST } from '@/app/api/launch-runs/ingest/route';
import { GET as runsGET } from '@/app/api/launch-runs/route';
import { getLaunchAbility } from '@/lib/launch-abilities';
import LaunchListPage from '@/app/launch/page';
import { relateLaunchViews } from '@/lib/launch-storage';

vi.mock('@/lib/launch-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/launch-storage')>();
  return { ...actual, relateLaunchViews: vi.fn(actual.relateLaunchViews) };
});

const TOKEN = 'synthetic-cc-02-token-not-a-credential';
const LAUNCH_ID = 'black-friday-2026';

// Exactly what shared-utils/signature_launch/launch_events.py build_event()
// emits: POST {"events":[<event>]}, integer skill, string launch_id, run_id =
// uuid5(namespace, "<skill>:<launch_id>"), no client_slug / installation_id.
const RUN_ID = '08187815-3a6b-5f7a-b238-0d1d3efee110';
function emitterEvent(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    skill: 83,
    launch_id: LAUNCH_ID,
    run_id: RUN_ID,
    schema_version: '1.0',
    emitted_at: '2026-11-02T12:00:00Z',
    ...overrides,
  };
}

function ingest(events: unknown[], authorization: string | null = `Bearer ${TOKEN}`) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization) headers.authorization = authorization;
  return ingestPOST(
    new NextRequest('http://localhost/api/launch-runs/ingest', {
      method: 'POST',
      headers,
      body: JSON.stringify({ events }),
    }),
  );
}

beforeAll(() => {
  delete process.env.LAUNCH_PLANS_DIR;
  run(`CREATE TABLE IF NOT EXISTS skill71_ingest_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        client_slug TEXT NOT NULL,
        host_shape TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        revoked_at TEXT
      )`);
  run(
    `INSERT OR IGNORE INTO skill71_ingest_tokens (id, token_hash, client_slug, host_shape)
     VALUES (?, ?, ?, ?)`,
    ['tok-cc-02', createHash('sha256').update(TOKEN).digest('hex'), 'client-a', 'fleet-mac'],
  );
});

describe('CON-22 — /launch reads the ingest database', () => {
  it('shows an empty state, not a fault, before anything is reported and LAUNCH_PLANS_DIR is unset', () => {
    const html = renderToStaticMarkup(LaunchListPage());
    expect(html).toContain('No launch runs yet');
    expect(html).not.toContain('could not be read');
  });

  it('ingest accepts the emitter payload (200 accept, 200 duplicate, 422 contract reject, 401 no token)', async () => {
    const init = emitterEvent({
      event_id: '11111111-1111-4111-8111-000000000001',
      event_type: 'run_initialized',
      host_shape: 'fleet-mac',
    });
    const closed = emitterEvent({
      event_id: '11111111-1111-4111-8111-000000000002',
      event_type: 'stage_closed',
      stage: 'intake',
      receipt_status: 'pass',
      closed_at: '2026-11-02T12:01:00Z',
    });

    const first = await ingest([init]);
    expect(first.status).toBe(200);
    expect((await first.json()).accepted).toBe(1);
    expect((await (await ingest([closed])).json()).accepted).toBe(1);

    const again = await ingest([init]);
    expect(again.status).toBe(200);
    expect((await again.json()).duplicates).toBe(1);

    const bad = await ingest([emitterEvent({
      event_id: '11111111-1111-4111-8111-000000000003',
      event_type: 'stage_closed',
      stage: 'not-a-stage',
      receipt_status: 'pass',
      closed_at: '2026-11-02T12:02:00Z',
    })]);
    expect(bad.status).toBe(422);

    expect((await ingest([init], null)).status).toBe(401);
  });

  it('after an ingest POST the page lists the run with LAUNCH_PLANS_DIR unset and relates the two views', () => {
    expect(process.env.LAUNCH_PLANS_DIR).toBeUndefined();
    vi.mocked(relateLaunchViews).mockClear();

    const html = renderToStaticMarkup(LaunchListPage());

    expect(html).toContain(LAUNCH_ID);
    expect(html).toContain('Black Friday Launcher');
    // Denominator is skill 83's stageOrder (U-approval-01 added the approval stage: 6 -> 7).
    expect(html).toContain(`1/${getLaunchAbility(83)!.stageOrder.length} steps`);
    expect(html).not.toContain('No launch runs yet');
    expect(html).not.toContain('could not be read');
    expect(relateLaunchViews).toHaveBeenCalledWith([], [LAUNCH_ID]);
  });
});

describe('CON-22 — navigation', () => {
  it('lists /launch', () => {
    expect(OPERATOR_NAV.map((item) => item.href)).toContain('/launch');
  });
});

describe('CON-21/22 — /api/launch-runs shows ingested runs keyed by launch_id', () => {
  const get = (query = '') => runsGET(new NextRequest(`http://localhost/api/launch-runs${query}`));

  it('lists the ingested launch with LAUNCH_PLANS_DIR unset', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    const launch = body.ingested.find((l: { launch_id: string }) => l.launch_id === LAUNCH_ID);
    expect(launch.abilities.map((a: { skill: number }) => a.skill)).toContain(83);
  });

  it('returns one launch from the database with every stage of the ability', async () => {
    const res = await get(`?launch_id=${LAUNCH_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('database');
    const stages = body.abilities[0].stages as Array<{ stage: string; status: string }>;
    expect(stages.map((s) => s.stage)).toEqual(getLaunchAbility(83)!.stageOrder);
    const stored = query<{ status: string }>(
      `SELECT status FROM launch_run_stages WHERE run_id = ? AND stage = 'intake'`,
      [RUN_ID],
    );
    expect(stages.find((s) => s.stage === 'intake')!.status).toBe(stored[0].status);
    expect(stored[0].status).not.toBe('not_run');
  });

  it('404s an unknown launch and keeps the 503 honesty contract for a configured, unreadable directory', async () => {
    expect((await get('?launch_id=no-such-launch')).status).toBe(404);
    process.env.LAUNCH_PLANS_DIR = '/nonexistent/launch-plans-cc-02';
    try {
      const res = await get();
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('launch_store_unavailable');
    } finally {
      delete process.env.LAUNCH_PLANS_DIR;
    }
  });
});
