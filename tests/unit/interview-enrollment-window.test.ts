/**
 * ILJ-002 — enrollment-window tenant scope.
 *
 * One tenant's operator build state must never close another tenant's
 * enrollment window. Asymmetries locked here (see enrollment-window.ts):
 *   • absent/unreadable state = UNDETERMINED (never complete)
 *   • state naming a DIFFERENT company says nothing about this grant
 *   • state with NO company recorded is still honoured
 *
 * Pure interviewFinished() cases run in-process; enrollmentWindowClosed()
 * cases run against a throwaway OPENCLAW_WORKSPACE_ROOT. No DB, no network.
 *
 * C8: enrollment-window.ts imports @/lib/interview/seam for readBuildState,
 * and seam statically reaches @/lib/db via foundation-verification. The pure
 * behaviour is unchanged — this import only points DATABASE_PATH at a unique
 * temp file so the transitive reach can never touch the live mission-control.db.
 */
import './_isolated-db';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  enrollmentWindowClosed,
  enrollmentExpired,
  interviewFinished,
} from '../../src/lib/interview/enrollment-window';

const OWN = 'own-company';
const FOREIGN = 'someone-else';
const STAMP = '2026-09-18T00:00:00.000Z';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ilj002-enrollment-window-'));
process.env.OPENCLAW_WORKSPACE_ROOT = workspace;
const statePath = path.join(workspace, '.workforce-build-state.json');
const writeState = (state: unknown) => fs.writeFileSync(statePath, JSON.stringify(state));
const clearState = () => {
  try {
    fs.rmSync(statePath);
  } catch {
    /* absent is a case, not an error */
  }
};

beforeEach(() => {
  clearState();
});

test('own-company interviewComplete closes own window', () => {
  assert.equal(
    interviewFinished({ companyId: OWN, interviewComplete: true }, OWN),
    true,
  );
});

test('own-company buildCompletedAt closes own window', () => {
  assert.equal(
    interviewFinished({ companyId: OWN, buildCompletedAt: STAMP }, OWN),
    true,
  );
});

test('foreign-company interviewComplete never closes own window', () => {
  assert.equal(
    interviewFinished({ companyId: FOREIGN, interviewComplete: true }, OWN),
    false,
  );
});

test('foreign-company buildCompletedAt never closes own window', () => {
  assert.equal(
    interviewFinished({ companyId: FOREIGN, buildCompletedAt: STAMP }, OWN),
    false,
  );
});

test('state with no company recorded is still honoured', () => {
  assert.equal(interviewFinished({ interviewComplete: true }, OWN), true);
  assert.equal(interviewFinished({ buildCompletedAt: STAMP }, OWN), true);
  assert.equal(
    interviewFinished({ companyId: '   ', interviewComplete: true }, OWN),
    true,
    'blank owner = no company recorded, still honoured',
  );
});

test('absent state is undetermined, never complete', () => {
  assert.equal(interviewFinished(null, OWN), false);
  assert.equal(interviewFinished(null), false);
});

test('unfinished own state leaves window open', () => {
  assert.equal(
    interviewFinished({ companyId: OWN, interviewComplete: false }, OWN),
    false,
  );
  assert.equal(
    interviewFinished({ companyId: OWN, buildCompletedAt: '   ' }, OWN),
    false,
  );
});

test('legacy caller with no company presents no scope, honours completion', () => {
  // The sole caller (interview-session route) always passes the grant company;
  // this pins the backward-compatible contract for a missing argument only.
  assert.equal(
    interviewFinished({ companyId: FOREIGN, interviewComplete: true }),
    true,
  );
});

test('enrollmentWindowClosed: absent file is undetermined', () => {
  clearState();
  assert.equal(enrollmentWindowClosed(OWN), false);
});

test('enrollmentWindowClosed: unreadable file is undetermined', () => {
  fs.writeFileSync(statePath, 'not json at all');
  assert.equal(enrollmentWindowClosed(OWN), false);
});

test('enrollmentWindowClosed: own complete file closes, foreign never does', () => {
  writeState({ companyId: OWN, interviewComplete: true });
  assert.equal(enrollmentWindowClosed(OWN), true);
  writeState({ companyId: FOREIGN, interviewComplete: true });
  assert.equal(enrollmentWindowClosed(OWN), false);
  writeState({ companyId: FOREIGN, buildCompletedAt: STAMP });
  assert.equal(enrollmentWindowClosed(OWN), false);
});

const completedMs = Date.parse(STAMP);
const graceMs = 24 * 60 * 60 * 1000;
test('completion grace is open through 23:59:59.999 and closes exactly at 24 hours', () => {
  const state = { companyId: OWN, interviewComplete: true, interviewCompletedAt: STAMP };
  assert.equal(interviewFinished(state, OWN), true, 'grace does not undo completion');
  for (const elapsed of [0, 1, graceMs - 1]) {
    assert.equal(enrollmentExpired(state, OWN, completedMs + elapsed), false);
  }
  for (const elapsed of [graceMs, graceMs + 1, 365 * graceMs]) {
    assert.equal(enrollmentExpired(state, OWN, completedMs + elapsed), true);
  }
});

test('missing or invalid legacy completion timestamp cannot start a sliding grace', () => {
  for (const stamp of [undefined, '', 'not-a-date', '2026-09-18', '2026-99-18T00:00:00Z']) {
    const state = { companyId: OWN, interviewComplete: true, interviewCompletedAt: stamp };
    assert.equal(enrollmentExpired(state, OWN, completedMs), true);
    assert.equal(enrollmentExpired(state, OWN, completedMs + graceMs), true);
  }
  assert.equal(enrollmentExpired({ companyId: OWN, interviewComplete: true, interviewCompletedAt: STAMP }, OWN, completedMs - 1), true, 'future completion timestamp is not a trustworthy deadline');
});

test('later build completion does not move the interview deadline or fill a legacy missing timestamp', () => {
  const state = { companyId: OWN, interviewComplete: true, interviewCompletedAt: STAMP, buildCompletedAt: new Date(completedMs + graceMs).toISOString() };
  const before = JSON.stringify(state);
  assert.equal(enrollmentExpired(state, OWN, completedMs + graceMs), true);
  assert.equal(JSON.stringify(state), before, 'admission never rewrites canonical completion');
  assert.equal(enrollmentExpired({ companyId: OWN, buildCompletedAt: STAMP }, OWN, completedMs), true);
});

test('foreign completion never starts or ends this tenant grace and unfinished state ignores stale timestamps', () => {
  assert.equal(enrollmentExpired({ companyId: FOREIGN, interviewComplete: true, interviewCompletedAt: STAMP }, OWN, completedMs + 2 * graceMs), false);
  assert.equal(enrollmentExpired({ companyId: OWN, interviewComplete: false, interviewCompletedAt: STAMP }, OWN, completedMs + 2 * graceMs), false);
  assert.equal(enrollmentExpired({ interviewComplete: true, interviewCompletedAt: STAMP }, OWN, completedMs + graceMs - 1), false);
});
