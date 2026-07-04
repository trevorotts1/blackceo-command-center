/**
 * Unit tests for the interview re-engagement nudge sweep
 * (src/lib/jobs/interview-nudge-sweep.ts). Runs under `npm run test:unit`
 * (node --import tsx --test).
 *
 * Strategy: point DATABASE_PATH at a throwaway DB and OPENCLAW_WORKSPACE_ROOT at
 * a throwaway workspace holding a fabricated .workforce-build-state.json +
 * company-discovery/interview-handoff.md, then drive the sweep with an injected
 * `sendOwner` (so no real Telegram) and an injected `now` (so we control idle
 * windows without touching file mtimes).
 *
 * Verifies:
 *   1. Dormant by default (INTERVIEW_NUDGE_SWEEP_ENABLED unset) → no send.
 *   2. A completed interview is never nudged.
 *   3. An in-progress, idle interview gets exactly ONE nudge at the crossed tier,
 *      with a P0-7 slug-contract link, and the send is idempotent (second run
 *      no-ops via the events ledger).
 *   4. Only the HIGHEST crossed tier is sent (no backlog), and a later higher
 *      tier can still fire once.
 *   5. A failed send is NOT recorded (retries next sweep — no silent swallow).
 *   6. DISABLE_INTERVIEW_NUDGE_SWEEP overrides ENABLED.
 *   7. buildResumeLink honours OPENCLAW_DASHBOARD_URL and the slug contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-nudge-ws-'));
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-nudge-db-')),
  'mission-control.test.db',
);

process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_WORKSPACE_ROOT = WORKSPACE;
process.env.OPENCLAW_DASHBOARD_URL = 'https://acme.zerohumanworkforce.com';
delete process.env.DISABLE_INTERVIEW_NUDGE_SWEEP;
delete process.env.INTERVIEW_NUDGE_TIER_HOURS;

const SESSION_ID = 'sess-abc-123';
const LAST_ACTIVITY_ISO = '2026-01-01T00:00:00.000Z';
const LAST_ACTIVITY_MS = Date.parse(LAST_ACTIVITY_ISO);
const HOUR = 60 * 60 * 1000;

function writeBuildState(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(WORKSPACE, '.workforce-build-state.json'),
    JSON.stringify({ interviewSessionId: SESSION_ID, ...extra }, null, 2),
    'utf-8',
  );
}

function writeHandoff(): void {
  const dir = path.join(WORKSPACE, 'company-discovery');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'interview-handoff.md'),
    [
      '---',
      'status: in_progress',
      'next_question_number: 12',
      'last_question_number: 11',
      `last_updated: ${LAST_ACTIVITY_ISO}`,
      '---',
      '',
      'Resume here.',
      '',
    ].join('\n'),
    'utf-8',
  );
}

type Mod = typeof import('../../src/lib/jobs/interview-nudge-sweep');
let runInterviewNudgeSweep: Mod['runInterviewNudgeSweep'];
let buildResumeLink: Mod['buildResumeLink'];

test.before(async () => {
  const db = await import('../../src/lib/db');
  db.getDb(); // run full migration chain so the events table exists
  const mod = await import('../../src/lib/jobs/interview-nudge-sweep');
  runInterviewNudgeSweep = mod.runInterviewNudgeSweep;
  buildResumeLink = mod.buildResumeLink;
});

test('dormant by default when ENABLED is not set', async () => {
  delete process.env.INTERVIEW_NUDGE_SWEEP_ENABLED;
  writeBuildState();
  writeHandoff();
  let sent = 0;
  const r = await runInterviewNudgeSweep({ sendOwner: () => (sent++, true), now: LAST_ACTIVITY_MS + 30 * HOUR });
  assert.equal(r.nudged, 0);
  assert.equal(sent, 0);
  assert.match(r.skippedReason ?? '', /ENABLED not set/);
});

test('never nudges a completed interview', async () => {
  process.env.INTERVIEW_NUDGE_SWEEP_ENABLED = '1';
  writeBuildState({ interviewComplete: true });
  writeHandoff();
  let sent = 0;
  const r = await runInterviewNudgeSweep({ sendOwner: () => (sent++, true), now: LAST_ACTIVITY_MS + 500 * HOUR });
  assert.equal(r.nudged, 0);
  assert.equal(sent, 0);
  assert.match(r.skippedReason ?? '', /already complete/);
});

test('sends exactly one tier-24 nudge and is idempotent', async () => {
  process.env.INTERVIEW_NUDGE_SWEEP_ENABLED = '1';
  writeBuildState(); // in-progress
  writeHandoff();
  const sent: string[] = [];
  const now = LAST_ACTIVITY_MS + 30 * HOUR; // crosses 24, not 72

  const r1 = await runInterviewNudgeSweep({ sendOwner: (m) => (sent.push(m), true), now });
  assert.equal(r1.nudged, 1);
  assert.equal(r1.tier, 24);
  assert.equal(sent.length, 1);
  assert.equal(r1.link, `https://acme.zerohumanworkforce.com/onboarding/resume/${SESSION_ID}`);
  assert.ok(sent[0].includes(r1.link!), 'message carries the resume link');

  // Second run at the same window → idempotent no-op (no second send).
  const r2 = await runInterviewNudgeSweep({ sendOwner: (m) => (sent.push(m), true), now });
  assert.equal(r2.nudged, 0);
  assert.equal(sent.length, 1, 'no duplicate nudge');
  assert.match(r2.skippedReason ?? '', /already nudged/);
});

test('sends only the highest crossed tier, then the next tier once', async () => {
  process.env.INTERVIEW_NUDGE_SWEEP_ENABLED = '1';
  // Fresh session so the ledger from the previous test does not apply.
  const freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-nudge-ws2-'));
  process.env.OPENCLAW_WORKSPACE_ROOT = freshWorkspace;
  fs.writeFileSync(
    path.join(freshWorkspace, '.workforce-build-state.json'),
    JSON.stringify({ interviewSessionId: 'sess-tier-jump' }, null, 2),
  );
  const hd = path.join(freshWorkspace, 'company-discovery');
  fs.mkdirSync(hd, { recursive: true });
  fs.writeFileSync(
    path.join(hd, 'interview-handoff.md'),
    `---\nstatus: in_progress\nlast_updated: ${LAST_ACTIVITY_ISO}\n---\n`,
  );

  const sent: string[] = [];
  // Box was "down" for 100h → crosses 24 and 72; only 72 (highest) should fire.
  const r1 = await runInterviewNudgeSweep({ sendOwner: (m) => (sent.push(m), true), now: LAST_ACTIVITY_MS + 100 * HOUR });
  assert.equal(r1.nudged, 1);
  assert.equal(r1.tier, 72);
  assert.equal(sent.length, 1);

  // Later, idle past 168h → the 168 tier is now the highest un-sent tier.
  const r2 = await runInterviewNudgeSweep({ sendOwner: (m) => (sent.push(m), true), now: LAST_ACTIVITY_MS + 200 * HOUR });
  assert.equal(r2.nudged, 1);
  assert.equal(r2.tier, 168);
  assert.equal(sent.length, 2);

  // No tier remains → subsequent runs are silent.
  const r3 = await runInterviewNudgeSweep({ sendOwner: (m) => (sent.push(m), true), now: LAST_ACTIVITY_MS + 300 * HOUR });
  assert.equal(r3.nudged, 0);
  assert.equal(sent.length, 2);

  process.env.OPENCLAW_WORKSPACE_ROOT = WORKSPACE; // restore
});

test('a failed send is not recorded and retries next sweep', async () => {
  process.env.INTERVIEW_NUDGE_SWEEP_ENABLED = '1';
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-nudge-ws3-'));
  process.env.OPENCLAW_WORKSPACE_ROOT = ws;
  fs.writeFileSync(
    path.join(ws, '.workforce-build-state.json'),
    JSON.stringify({ interviewSessionId: 'sess-retry' }, null, 2),
  );
  const hd = path.join(ws, 'company-discovery');
  fs.mkdirSync(hd, { recursive: true });
  fs.writeFileSync(
    path.join(hd, 'interview-handoff.md'),
    `---\nstatus: in_progress\nlast_updated: ${LAST_ACTIVITY_ISO}\n---\n`,
  );
  const now = LAST_ACTIVITY_MS + 30 * HOUR;

  const fail = await runInterviewNudgeSweep({ sendOwner: () => false, now });
  assert.equal(fail.nudged, 0);
  assert.match(fail.skippedReason ?? '', /will retry/);

  // Not recorded → a subsequent successful send goes through.
  let sent = 0;
  const ok = await runInterviewNudgeSweep({ sendOwner: () => (sent++, true), now });
  assert.equal(ok.nudged, 1);
  assert.equal(sent, 1);

  process.env.OPENCLAW_WORKSPACE_ROOT = WORKSPACE; // restore
});

test('DISABLE_INTERVIEW_NUDGE_SWEEP overrides ENABLED', async () => {
  process.env.INTERVIEW_NUDGE_SWEEP_ENABLED = '1';
  process.env.DISABLE_INTERVIEW_NUDGE_SWEEP = '1';
  writeBuildState();
  writeHandoff();
  let sent = 0;
  const r = await runInterviewNudgeSweep({ sendOwner: () => (sent++, true), now: LAST_ACTIVITY_MS + 999 * HOUR });
  assert.equal(r.nudged, 0);
  assert.equal(sent, 0);
  assert.match(r.skippedReason ?? '', /DISABLE_INTERVIEW_NUDGE_SWEEP/);
  delete process.env.DISABLE_INTERVIEW_NUDGE_SWEEP;
});

test('buildResumeLink honours OPENCLAW_DASHBOARD_URL and the slug contract', () => {
  process.env.OPENCLAW_DASHBOARD_URL = 'https://acme.zerohumanworkforce.com/';
  assert.equal(
    buildResumeLink('slug-xyz'),
    'https://acme.zerohumanworkforce.com/onboarding/resume/slug-xyz',
  );
});
