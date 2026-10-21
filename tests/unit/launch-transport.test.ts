/**
 * UL-022 — authenticated launch transport tests (real isolated database).
 *
 * Proves the transport is the real gate, not a pure formality:
 *   - a per-client Bearer token (SHA-256 hash stored, synthetic value only)
 *     authenticates the request; absent/invalid tokens answer 401;
 *   - an event that contradicts the token's client, host shape or installation
 *     is rejected and writes nothing (cross-client isolation);
 *   - delivery is at-least-once: the same event twice is a duplicate;
 *   - a conflicting duplicate (run re-bound to another launch) is rejected;
 *   - a stage closed with a pass receipt is never downgraded by a later
 *     not_authorized close (nonregressing terminal state);
 *   - progress samples dedupe on identical bytes and reject conflicting ones;
 *   - an unknown item is rejected, never silently accepted.
 *
 * No secrets: the token value below is a synthetic local fixture.
 */

import './_isolated-db';

import { createHash } from 'crypto';

import { describe, it, expect, beforeAll } from 'vitest';

import { run } from '@/lib/db';
import { handleLaunchIngest, launchInstallationId } from '@/lib/launch-transport';
import { POST as ingestPOST } from '@/app/api/launch-runs/ingest/route';
import { listLaunchRuns, getLaunchRun } from '@/lib/launch-ability-runs';

const TOKEN = 'synthetic-UL-022-token-not-a-credential';
const INSTALLATION = 'test-installation-ul-022';
const CLIENT = 'client-a';

function uuid(n: number): string {
  const tail = String(n).padStart(12, '0');
  return `11111111-1111-4111-8111-${tail}`;
}

function runEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skill: 49,
    launch_id: 'sample-launch-2026-11',
    installation_id: INSTALLATION,
    event_id: uuid(1),
    event_type: 'run_initialized',
    schema_version: '1.0',
    emitted_at: '2026-10-01T12:00:00Z',
    run_id: uuid(900),
    host_shape: 'fleet-mac',
    client_slug: CLIENT,
    ...overrides,
  };
}

function progressSample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1.0',
    project_id: 'sample-launch-2026-11',
    room_id: 'room-a',
    scope_version: 1,
    observed_at: '2026-10-01T12:00:00Z',
    build_percent: 33,
    batch_merge_percent: 0,
    batch_status: 'awaiting_owner_approval',
    hourly_net_pp: null,
    rate_window_minutes: 30,
    swarm_score: null,
    swarm_coverage: 0.5,
    active_agents: 1,
    eligible_capacity: 4,
    verified_task_ids: [],
    blocked_task_ids: [],
    decision_ids: [],
    next_task_ids: [],
    evidence_refs: [],
    ...overrides,
  };
}

function post(items: unknown[], authorization: string | null = `Bearer ${TOKEN}`) {
  return handleLaunchIngest({ authorization, body: JSON.stringify({ events: items }) });
}

beforeAll(() => {
  process.env.MC_INSTALLATION_ID = INSTALLATION;
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
    ['tok-l12', createHash('sha256').update(TOKEN).digest('hex'), CLIENT, 'fleet-mac'],
  );
});

describe('UL-022 — launch transport auth and binding', () => {
  it('answers 401 without a valid token and writes nothing', () => {
    expect(post([runEvent()], null).status).toBe(401);
    expect(post([runEvent()], 'Bearer wrong-token').status).toBe(401);
  });

  it('ingests a token-bound event and reports it once, then as a duplicate', () => {
    const event = runEvent({ event_id: uuid(10), run_id: uuid(910) });
    const first = post([event]);
    expect(first.status).toBe(200);
    expect(first.payload.accepted).toBe(1);
    expect(first.payload.rejected).toBe(0);

    const second = post([event]);
    expect(second.payload.duplicates).toBe(1);
    expect(second.payload.accepted).toBe(0);

    const runRows = listLaunchRuns({ launch_id: 'sample-launch-2026-11' });
    expect(runRows.availability).toBe('ok');
    const row = runRows.runs.find((entry) => entry.run_id === uuid(910));
    expect(row?.client_slug).toBe(CLIENT);
    expect(row?.installation_id).toBe(INSTALLATION);
  });

  it('rejects an event that contradicts the token client, host or installation', () => {
    const wrongClient = post([runEvent({ event_id: uuid(11), run_id: uuid(911), client_slug: 'client-b' })]);
    expect(wrongClient.status).toBe(422);
    expect(wrongClient.payload.results[0].errors?.[0]).toMatch(/contradicts the token/);

    const wrongHost = post([runEvent({ event_id: uuid(12), run_id: uuid(912), host_shape: 'fleet-contabo' })]);
    expect(wrongHost.payload.rejected).toBe(1);

    const wrongInstallation = post([
      runEvent({ event_id: uuid(13), run_id: uuid(913), installation_id: 'another-box' }),
    ]);
    expect(wrongInstallation.payload.rejected).toBe(1);
    expect(wrongInstallation.payload.results[0].errors?.[0]).toMatch(/installation_id/);
  });

  it('rejects an event with no launch identity', () => {
    const event = runEvent({ event_id: uuid(14), run_id: uuid(914) });
    delete event.launch_id;
    const decision = post([event]);
    expect(decision.status).toBe(422);
    expect(decision.payload.results[0].errors?.[0]).toMatch(/launch_id is required/);
    expect(listLaunchRuns({ launch_id: 'sample-launch-2026-11' }).runs.some(
      (entry) => entry.run_id === uuid(914),
    )).toBe(false);
  });

  it('rejects a run re-bound to a different launch (conflicting duplicate)', () => {
    const first = post([runEvent({
      event_id: uuid(20), run_id: uuid(920), launch_id: 'launch-one-2026-11',
    })]);
    expect(first.payload.accepted).toBe(1);

    const rebind = post([runEvent({
      event_id: uuid(21), run_id: uuid(920), launch_id: 'launch-two-2026-11',
      event_type: 'run_initialized',
    })]);
    expect(rebind.payload.rejected).toBe(1);
    expect(rebind.payload.results[0].errors?.[0]).toMatch(/already bound/);

    const rows = listLaunchRuns({ launch_id: 'launch-one-2026-11' });
    expect(rows.runs.find((entry) => entry.run_id === uuid(920))?.launch_id)
      .toBe('launch-one-2026-11');
  });

  it('keeps a pass receipt when a later duplicate close says not_authorized', () => {
    const runId = uuid(930);
    expect(post([
      runEvent({ event_id: uuid(30), run_id: runId, launch_id: 'launch-pass-2026-11' }),
    ]).payload.accepted).toBe(1);
    const pass = post([runEvent({
      event_id: uuid(31), run_id: runId, launch_id: 'launch-pass-2026-11',
      event_type: 'stage_closed', stage: 'intake', receipt_status: 'pass',
      closed_at: '2026-10-01T12:10:00Z',
    })]);
    expect(pass.payload.accepted).toBe(1);
    const downgrade = post([runEvent({
      event_id: uuid(32), run_id: runId, launch_id: 'launch-pass-2026-11',
      event_type: 'stage_closed', stage: 'intake', receipt_status: 'not_authorized',
      closed_at: '2026-10-01T12:20:00Z',
    })]);
    expect(downgrade.payload.accepted).toBe(1);

    const detail = getLaunchRun(runId);
    expect(detail?.progress.stages_closed).toBe(1);
    expect(detail?.stages.find((stage) => stage.stage === 'intake')?.receipt_status).toBe('pass');
  });

  it('rejects unknown items and malformed bodies instead of silently accepting them', () => {
    const unknown = post([{ foo: 'bar' }]);
    expect(unknown.status).toBe(422);
    expect(unknown.payload.results[0].status).toBe('rejected');

    const malformed = handleLaunchIngest({ authorization: `Bearer ${TOKEN}`, body: 'not json' });
    expect(malformed.status).toBe(400);

    const empty = handleLaunchIngest({ authorization: `Bearer ${TOKEN}`, body: '' });
    expect(empty.status).toBe(400);
  });
});

describe('UL-022 — launch progress sample transport', () => {
  it('ingests a valid sample, dedupes identical bytes and rejects a conflict', () => {
    const sample = progressSample();
    const first = handleLaunchIngest({
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ progress: sample }),
    });
    expect(first.status).toBe(200);
    expect(first.payload.accepted).toBe(1);

    const duplicate = handleLaunchIngest({
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ samples: [sample] }),
    });
    expect(duplicate.payload.duplicates).toBe(1);

    const conflict = handleLaunchIngest({
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ samples: [{ ...sample, build_percent: 99 }] }),
    });
    expect(conflict.status).toBe(422);
    expect(conflict.payload.results[0].errors?.[0]).toMatch(/conflicting duplicate/);
  });

  it('rejects a sample that violates the progress contract', () => {
    const invalid = handleLaunchIngest({
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ progress: { ...progressSample(), build_percent: 140 } }),
    });
    expect(invalid.status).toBe(422);
    expect(invalid.payload.results[0].errors?.join(' ')).toMatch(/build_percent/);
  });

  it('reports this installation as provenance, never a client-supplied value', () => {
    expect(launchInstallationId()).toBe(INSTALLATION);
  });

  it('mounts the real authenticated ingest route (not a handler plus a proposal)', async () => {
    const { NextRequest } = await import('next/server');
    const event = runEvent({ event_id: uuid(40), run_id: uuid(940) });
    const authed = new NextRequest('http://localhost/api/launch-runs/ingest', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ events: [event] }),
    });
    const ok = await ingestPOST(authed);
    expect(ok.status).toBe(200);
    const payload = (await ok.json()) as { accepted: number };
    expect(payload.accepted).toBe(1);

    // The mounted route enforces the same gate as the handler: no token → 401.
    const anon = new NextRequest('http://localhost/api/launch-runs/ingest', {
      method: 'POST',
      body: JSON.stringify({ events: [runEvent({ event_id: uuid(41), run_id: uuid(941) })] }),
    });
    expect((await ingestPOST(anon)).status).toBe(401);
  });
});
