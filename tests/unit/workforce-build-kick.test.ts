/**
 * Unit tests for the workforce build kick (src/lib/jobs/workforce-build-kick.ts,
 * AI Workforce Interview BU-30). Runs under `npm run test:unit`
 * (node --import tsx --test).
 *
 * Strategy: point OPENCLAW_WORKSPACE_ROOT at a throwaway workspace holding a
 * fabricated .workforce-build-state.json plus the wanted file, and inject a
 * stub gateway client — no network, no real gateway, no timer. `now` is
 * injected so the 20-minute window and the 12-kick ceiling are driven without
 * waiting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-kick-ws-'));
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-kick-db-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_WORKSPACE_ROOT = WORKSPACE;
delete process.env.MC_TENANT_REGISTRY_JSON;

const STATE_FILE = path.join(WORKSPACE, '.workforce-build-state.json');
const WANTED_FILE = path.join(WORKSPACE, '.workforce-build-wanted.json');
const KICK_FILE = path.join(WORKSPACE, '.workforce-build-kick.json');
const BUILD_ID = 'build-abc-123';
const NOW = Date.parse('2026-02-01T12:00:00.000Z');
const MINUTE = 60_000;

type Mod = typeof import('../../src/lib/jobs/workforce-build-kick');
let kickWorkforceBuild: Mod['kickWorkforceBuild'];

test.before(async () => {
  // The seam reads through the DB-backed foundation verifier on import; run the
  // migration chain first so nothing lazy-initialises against a missing file.
  const db = await import('../../src/lib/db');
  db.getDb();
  const mod = await import('../../src/lib/jobs/workforce-build-kick');
  kickWorkforceBuild = mod.kickWorkforceBuild;
});

function writeState(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        interviewComplete: true,
        interviewQc: { status: 'pass' },
        interviewSessionId: 'sess-abc-123',
        ...extra,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

function writeWanted(): void {
  fs.writeFileSync(
    WANTED_FILE,
    JSON.stringify({ wantedAt: '2026-02-01T11:00:00.000Z', reason: 'interview-complete', buildId: BUILD_ID }),
    'utf-8',
  );
}

function clearKick(): void {
  fs.rmSync(KICK_FILE, { force: true });
}

/** A stub gateway: records every send, can be made to throw. */
function stubClient(opts: { failSend?: boolean } = {}) {
  const sent: Array<{ sessionKey: string; content: string }> = [];
  const created: string[] = [];
  const client = {
    isConnected: () => true,
    connect: async () => {},
    createSession: async (_channel: string, _peer?: string, o?: { key?: string }) => {
      created.push(o?.key ?? '');
      return {} as never;
    },
    sendMessage: async (sessionKey: string, content: string) => {
      if (opts.failSend) throw new Error('gateway refused the send');
      sent.push({ sessionKey, content });
    },
  };
  return { client, sent, created };
}

function readKick(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(KICK_FILE, 'utf-8')) as Record<string, unknown>;
}

test('eligible state plus a wanted file sends exactly one [WORKFORCE-RESUME] message', async () => {
  writeState();
  writeWanted();
  clearKick();
  const { client, sent } = stubClient();

  const r = await kickWorkforceBuild('interview-complete', { client, now: NOW });

  assert.equal(r.kicked, true);
  assert.equal(r.sessionKey, `agent:main:workforce-build-${BUILD_ID}`);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].content.startsWith('[WORKFORCE-RESUME]'), 'the one message carries the resume marker');
  assert.match(sent[0].content, /Do not message the owner\./);
  const record = readKick();
  assert.equal(record.sessionKey, r.sessionKey);
  assert.equal(record.kicks, 1);
  assert.equal(typeof record.kickedAt, 'string');
});

test('needs-review is build-eligible too', async () => {
  writeState({ interviewQc: { status: 'needs-review' } });
  writeWanted();
  clearKick();
  const { client, sent } = stubClient();

  const r = await kickWorkforceBuild('interview-complete', { client, now: NOW });

  assert.equal(r.kicked, true);
  assert.equal(sent.length, 1);
});

test('a second call inside 20 minutes sends nothing', async () => {
  writeState();
  writeWanted();
  clearKick();
  const { client, sent } = stubClient();

  const first = await kickWorkforceBuild('interview-complete', { client, now: NOW });
  assert.equal(first.kicked, true);

  const second = await kickWorkforceBuild('interview-complete', { client, now: NOW + 19 * MINUTE });
  assert.equal(second.kicked, false);
  assert.equal(second.skippedReason, undefined, 'nothing to do is never a skippedReason');
  assert.match(second.reason ?? '', /less than 20 minutes/);
  assert.equal(sent.length, 1, 'no second message');

  const third = await kickWorkforceBuild('scheduled-job', { client, now: NOW + 21 * MINUTE });
  assert.equal(third.kicked, true, 'the window expires at 20 minutes');
  assert.equal(sent.length, 2);
  assert.equal(readKick().kicks, 2);
});

test('wanted file absent sends nothing', async () => {
  writeState();
  fs.rmSync(WANTED_FILE, { force: true });
  clearKick();
  const { client, sent } = stubClient();

  const r = await kickWorkforceBuild('interview-complete', { client, now: NOW });

  assert.equal(r.kicked, false);
  assert.match(r.reason ?? '', /no build is wanted/);
  assert.equal(sent.length, 0);
});

test('interviewComplete not true sends nothing', async () => {
  writeState({ interviewComplete: false });
  writeWanted();
  clearKick();
  const { client, sent } = stubClient();

  const r = await kickWorkforceBuild('interview-complete', { client, now: NOW });

  assert.equal(r.kicked, false);
  assert.match(r.reason ?? '', /interview is not complete/);
  assert.equal(sent.length, 0);
});

test('a QC status of fail sends nothing', async () => {
  writeState({ interviewQc: { status: 'fail' } });
  writeWanted();
  clearKick();
  const { client, sent } = stubClient();

  const r = await kickWorkforceBuild('interview-complete', { client, now: NOW });

  assert.equal(r.kicked, false);
  assert.match(r.reason ?? '', /QC status is fail/);
  assert.equal(sent.length, 0);
});

test('a completed build sends nothing', async () => {
  writeState({ buildCompletedAt: '2026-01-31T09:00:00Z' });
  writeWanted();
  clearKick();
  const { client, sent } = stubClient();

  const r = await kickWorkforceBuild('interview-complete', { client, now: NOW });

  assert.equal(r.kicked, false);
  assert.match(r.reason ?? '', /already complete/);
  assert.equal(sent.length, 0);
});

test('a gateway that throws records lastError and does not throw', async () => {
  writeState();
  writeWanted();
  clearKick();
  const { client, created } = stubClient({ failSend: true });

  const r = await kickWorkforceBuild('interview-complete', { client, now: NOW });

  assert.equal(r.kicked, false);
  assert.match(r.lastError ?? '', /gateway refused the send/);
  assert.equal(created[0], `agent:main:workforce-build-${BUILD_ID}`, 'the session is opened at the stable key');
  const record = readKick();
  assert.match(String(record.lastError), /gateway refused the send/);
  assert.equal(record.kicks, 0, 'a failed attempt never counts as a kick, so the next run retries');
  assert.equal(record.kickedAt, undefined, 'nor does it start the 20-minute window');
});

test('the 13th kick is refused', async () => {
  writeState();
  writeWanted();
  clearKick();
  const { client, sent } = stubClient();

  for (let i = 0; i < 12; i++) {
    const r = await kickWorkforceBuild('scheduled-job', { client, now: NOW + i * 21 * MINUTE });
    assert.equal(r.kicked, true, `kick ${i + 1} should be sent`);
  }
  assert.equal(sent.length, 12);

  const thirteenth = await kickWorkforceBuild('scheduled-job', { client, now: NOW + 12 * 21 * MINUTE });
  assert.equal(thirteenth.kicked, false);
  assert.match(thirteenth.reason ?? '', /gave up after 12 kicks/);
  assert.equal(sent.length, 12, 'no thirteenth message');
  assert.equal(readKick().gaveUp, true);

  const nextRun = await kickWorkforceBuild('scheduled-job', { client, now: NOW + 13 * 21 * MINUTE });
  assert.equal(nextRun.kicked, false, 'gaveUp is permanent for this build');
});

test('a new build starts its own kick count', async () => {
  writeState();
  writeWanted();
  fs.writeFileSync(
    KICK_FILE,
    JSON.stringify({
      kickedAt: '2026-02-01T10:00:00.000Z',
      sessionKey: 'agent:main:workforce-build-an-older-build',
      reason: 'scheduled-job',
      kicks: 12,
      gaveUp: true,
    }),
    'utf-8',
  );
  const { client, sent } = stubClient();

  const r = await kickWorkforceBuild('scheduled-job', { client, now: NOW });

  assert.equal(r.kicked, true, "an older build's give-up never blocks this build");
  assert.equal(sent.length, 1);
  assert.equal(readKick().kicks, 1);
});
