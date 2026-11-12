/**
 * U-12 (CC-037) — one answer to "is this company's workforce live?" for task
 * routing.
 *
 * The canonical build-state FILE decides when it can be read, in both
 * directions: a readable "complete" or "placeholder" file opens routing even
 * with a database flag of 0, and a readable "incomplete" file closes it even
 * with a flag of 1. The `clients.interview_complete` database flag counts only
 * when the file is absent or unreadable; a legacy box with neither a client row
 * nor a readable file keeps deferring to the materialized-departments signal.
 *
 * Temporary database (tests/unit/_isolated-db.ts) plus a temporary workspace:
 * `OPENCLAW_WORKSPACE_ROOT` points at it, so the file the unit reads is the
 * fixture file and never a real box's build state. One staffed department
 * (one live, non-master standby agent) for the routing-positive cases, and a
 * bare company with no departments for case 6.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { standardPlaceholderActive, verifiedBuild } from '../../src/lib/interview/build-verification';

const WORKSPACE_ROOT = path.join(process.env.CC_TEST_FIXTURE_ROOT!, 'u12-workspace');
process.env.OPENCLAW_WORKSPACE_ROOT = WORKSPACE_ROOT;
// The gate must never reach for a Skill-23 script on this box.
process.env.OPENCLAW_SKILL23_SCRIPTS = path.join(process.env.CC_TEST_FIXTURE_ROOT!, 'absent-skill23');

const STAFFED = 'u12-staffed-company';
const BARE = 'u12-bare-company';

type DbModule = typeof import('../../src/lib/db');
let db: DbModule;
let isWorkforceProvisioned: (companyId: string) => { provisioned: boolean; reason: string };
let readBuildState: () => Record<string, unknown> | null;

function buildStateFile(): string {
  return path.join(WORKSPACE_ROOT, '.workforce-build-state.json');
}

/** Write the fixture build-state (null deletes it) and prove the unit reads it. */
function writeBuildState(state: Record<string, unknown> | null): void {
  const file = buildStateFile();
  if (state === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state), 'utf-8');
  assert.deepEqual(readBuildState(), state, 'fixture build-state must be the file the unit reads');
}

/** Exactly one self row carrying `flag`, or no client row at all for null. */
function setSelfClientRow(flag: 0 | 1 | null): void {
  db.run('DELETE FROM clients');
  if (flag === null) return;
  db.run(
    "INSERT INTO clients(id,name,is_self,interview_complete) VALUES('self','This Box (Operator)',1,?)",
    [flag],
  );
}

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb(); // fresh temp DB: base schema, migrations, migration 048 seeds the self row
  ({ isWorkforceProvisioned } = await import('../../src/lib/routing/workforce-provisioned'));
  readBuildState = (await import('../../src/lib/interview/seam')).readBuildState as () => Record<
    string,
    unknown
  > | null;

  for (const id of [STAFFED, BARE]) {
    db.run('INSERT OR IGNORE INTO companies(id,name,slug) VALUES(?,?,?)', [id, id, id]);
  }
  // STAFFED has one real department with a live, non-master standby agent.
  // BARE deliberately has none: it exercises the departments half of the gate.
  db.run(
    "INSERT OR IGNORE INTO workspaces(id,name,slug,company_id) VALUES('u12-eng-ws','Engineering','u12-engineering',?)",
    [STAFFED],
  );
  db.run(
    "INSERT OR IGNORE INTO agents(id,name,role,workspace_id,is_master,status) VALUES('u12-eng-worker','Engineering Worker','Engineer','u12-eng-ws',0,'standby')",
  );
});

test.after(() => {
  db?.closeDb();
  fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

test('case 1: flag 0 with a file saying interviewComplete true → provisioned (the original bug)', () => {
  setSelfClientRow(0);
  writeBuildState({ interviewComplete: true });
  const result = isWorkforceProvisioned(STAFFED);
  assert.equal(result.provisioned, true, result.reason);
});

test('case 2: flag 0 with a file saying incomplete and no placeholder → not provisioned', () => {
  setSelfClientRow(0);
  writeBuildState({ interviewComplete: false });
  const result = isWorkforceProvisioned(STAFFED);
  assert.equal(result.provisioned, false, result.reason);
});

test('case 3: flag 1 with no file → provisioned (database flag is the only evidence)', () => {
  setSelfClientRow(1);
  writeBuildState(null);
  const result = isWorkforceProvisioned(STAFFED);
  assert.equal(result.provisioned, true, result.reason);
});

test('case 4: no client row and no file → provisioned (legacy behaviour kept)', () => {
  setSelfClientRow(null);
  writeBuildState(null);
  const result = isWorkforceProvisioned(STAFFED);
  assert.equal(result.provisioned, true, result.reason);
});

test('case 5: owner-ordered standard placeholder in the file → provisioned', () => {
  setSelfClientRow(0);
  const state = {
    interviewComplete: false,
    companyMode: 'standard-placeholder',
    standardPlaceholder: { status: 'active' },
  };
  assert.equal(standardPlaceholderActive(state), true, 'fixture must be an active standard placeholder');
  writeBuildState(state);
  const result = isWorkforceProvisioned(STAFFED);
  assert.equal(result.provisioned, true, result.reason);
});

test('case 6: file complete but zero department agents → not provisioned', () => {
  setSelfClientRow(0);
  writeBuildState({ interviewComplete: true });
  const result = isWorkforceProvisioned(BARE);
  assert.equal(result.provisioned, false, result.reason);
});

test('case 7: the reason names both interview sources and the departments signal', () => {
  setSelfClientRow(0);
  writeBuildState({ interviewComplete: true });
  const { reason } = isWorkforceProvisioned(STAFFED);
  assert.match(reason, /interview_db=false/);
  assert.match(reason, /interview_file=complete/);
  assert.match(reason, /materialized_depts=true/);
});

test('case 8: flag 1 with a readable unfinished file → not provisioned (CC-045 early flip)', () => {
  setSelfClientRow(1);
  writeBuildState({ interviewComplete: false });
  const result = isWorkforceProvisioned(STAFFED);
  assert.equal(result.provisioned, false, result.reason);
});

test('case 9: interview complete with a pending completion receipt → provisioned (a build falling back must not close routing)', () => {
  setSelfClientRow(0);
  const state = {
    interviewComplete: true,
    buildId: 'u12-build-1',
    completionVerification: {
      version: 1,
      status: 'pending',
      buildId: 'u12-build-1',
      unmetRequirements: [],
    },
  };
  assert.equal(verifiedBuild(state), false, 'fixture must not be a verified build');
  writeBuildState(state);
  const result = isWorkforceProvisioned(STAFFED);
  assert.equal(result.provisioned, true, result.reason);
});
