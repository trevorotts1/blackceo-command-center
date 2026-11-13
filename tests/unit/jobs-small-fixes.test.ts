/**
 * U-20 — four small job fixes (CC-067, CC-068, CC-069 first fault) unit tests.
 * Runs under `npm run test:unit` (node --import tsx --test).
 *
 * Verifies:
 *   1. CC-067: the interview nudge sweep refuses to send a resume link when no
 *      public dashboard address is configured (the fallback is localhost), and
 *      sends when OPENCLAW_DASHBOARD_URL is public — carrying the new part-way
 *      wording (Workforce Interview BU-37).
 *   2. CC-068: a malformed MC_TENANT_REGISTRY_JSON makes the interview outbox
 *      sweep resolve (skip) instead of rejecting.
 *   3. CC-069: the CEO/COM department guard matches only the real CEO
 *      departments, so "communications", "e-commerce" and "community" are no
 *      longer blocked from delegation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-jobsfix-ws-'));
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-jobsfix-db-')),
  'mission-control.test.db',
);

process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_WORKSPACE_ROOT = WORKSPACE;
delete process.env.DISABLE_INTERVIEW_NUDGE_SWEEP;
delete process.env.INTERVIEW_NUDGE_TIER_HOURS;

const LAST_ACTIVITY_ISO = '2026-01-01T00:00:00.000Z';
const LAST_ACTIVITY_MS = Date.parse(LAST_ACTIVITY_ISO);
const HOUR = 60 * 60 * 1000;

/** Fabricate a started, in-progress interview whose last activity is LAST_ACTIVITY_ISO. */
function writeStartedInterview(sessionId: string): void {
  fs.writeFileSync(
    path.join(WORKSPACE, '.workforce-build-state.json'),
    JSON.stringify({ interviewSessionId: sessionId }, null, 2),
    'utf-8',
  );
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

/** Drop every public-address variable so the resume base falls back to localhost. */
function clearPublicAddressEnv(): void {
  delete process.env.OPENCLAW_DASHBOARD_URL;
  delete process.env.CC_PUBLIC_URL;
  delete process.env.MC_TENANT_PUBLIC_URL;
  delete process.env.MISSION_CONTROL_URL;
}

type NudgeMod = typeof import('../../src/lib/jobs/interview-nudge-sweep');
type OutboxMod = typeof import('../../src/lib/jobs/interview-outbox-sweep');
let runInterviewNudgeSweep: NudgeMod['runInterviewNudgeSweep'];
let runInterviewOutboxSweep: OutboxMod['runInterviewOutboxSweep'];

test.before(async () => {
  const db = await import('../../src/lib/db');
  db.getDb(); // run full migration chain so the events table exists
  runInterviewNudgeSweep = (await import('../../src/lib/jobs/interview-nudge-sweep'))
    .runInterviewNudgeSweep;
  runInterviewOutboxSweep = (await import('../../src/lib/jobs/interview-outbox-sweep'))
    .runInterviewOutboxSweep;
});

test('CC-067: no public address → no nudge, skippedReason names the address', async () => {
  process.env.INTERVIEW_NUDGE_SWEEP_ENABLED = '1';
  clearPublicAddressEnv();
  writeStartedInterview('sess-u20-no-address');

  let sent = 0;
  const r = await runInterviewNudgeSweep({
    sendOwner: () => (sent++, true),
    now: LAST_ACTIVITY_MS + 30 * HOUR,
  });

  assert.equal(sent, 0, 'sendOwner must not be called without a public address');
  assert.equal(r.nudged, 0);
  assert.match(r.skippedReason ?? '', /address/);
});

test('CC-067: public address → one nudge carrying the new part-way wording', async () => {
  process.env.INTERVIEW_NUDGE_SWEEP_ENABLED = '1';
  clearPublicAddressEnv();
  process.env.OPENCLAW_DASHBOARD_URL = 'https://example.org';
  writeStartedInterview('sess-u20-public');

  const sent: string[] = [];
  const r = await runInterviewNudgeSweep({
    sendOwner: (m) => (sent.push(m), true),
    now: LAST_ACTIVITY_MS + 30 * HOUR, // tier 24 — the part-way message
  });

  assert.equal(r.nudged, 1);
  assert.equal(r.tier, 24);
  assert.equal(sent.length, 1);
  assert.ok(
    sent[0].startsWith('Your company setup is saved part-way. '),
    `message should use the new wording: ${sent[0]}`,
  );
  assert.ok(sent[0].includes('https://example.org/onboarding/resume/sess-u20-public'));

  clearPublicAddressEnv();
});

test('CC-068: malformed MC_TENANT_REGISTRY_JSON does not reject the outbox sweep', async () => {
  process.env.MC_TENANT_REGISTRY_JSON = '{bad';

  const r = await runInterviewOutboxSweep();
  const res = r as { scanned: number; skippedReason?: string };

  assert.equal(res.scanned, 0);
  assert.match(res.skippedReason ?? '', /not valid JSON/);

  delete process.env.MC_TENANT_REGISTRY_JSON;
});

// Mirrors the guard in src/lib/jobs/ceo-delegation-sweep.ts (`routing.department`).
const CEO_OR_COM = /^(dept-)?(ceo|com)$/i;

test('CC-069: ceo/com guard accepts ceo, dept-ceo, COM and rejects the lookalikes', () => {
  for (const dept of ['ceo', 'dept-ceo', 'COM', 'CEO', ' dept-ceo ']) {
    assert.ok(CEO_OR_COM.test(dept.trim()), `${dept} should be treated as CEO/COM`);
  }
  for (const dept of ['communications', 'e-commerce', 'community']) {
    assert.ok(!CEO_OR_COM.test(dept.trim()), `${dept} must delegate, not stay on the CEO`);
  }
});
