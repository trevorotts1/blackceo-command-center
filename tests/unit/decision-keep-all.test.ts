/**
 * decision-keep-all.test.ts — BU-15 acceptance (WF-016).
 *
 * THE BUG THIS PREVENTS: the team board made an owner press 29 buttons. "Looks
 * good — keep all" is now one tap. On an OLDER box the decision route records a
 * real, provenanced `yes` for every expected department that has no recorded
 * decision — one after another, stopping at the first failure — and on a
 * STANDARD-FIRST box it records NOTHING per department (they are already built;
 * silence is a keep). Both lanes answer the gate question `department_review`
 * from the page, never from this route.
 *
 * Runs the REAL route against a temp workspace and a temp scripts folder holding
 * a stub record-dept-decision.sh (which logs every call and writes the decision
 * into build-state exactly where the real one does) and a stub
 * list-canonical-departments.py (the live floor list). No network, no live box.
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const OPERATOR_TOKEN = 'bu15-keep-all-test-token';
process.env.MC_API_TOKEN = OPERATOR_TOKEN;
process.env.MC_INTERVIEW_SECRET = process.env.MC_INTERVIEW_SECRET || 'bu15-keep-all-test-secret';

const AUTH = { host: 'localhost', authorization: `Bearer ${OPERATOR_TOKEN}` };

/** 20 mandatory + 9 recommended = the 29 expected departments of the fixture. */
const MANDATORY_IDS = [
  'master-orchestrator',
  'general-task',
  'marketing',
  'sales',
  'finance',
  'accounting',
  'operations',
  'customer-support',
  'human-resources',
  'legal',
  'it',
  'product',
  'engineering',
  'design',
  'research',
  'logistics',
  'procurement',
  'admin',
  'executive',
  'data',
];
const RECOMMENDED_IDS = [
  'analytics',
  'content',
  'social-media',
  'public-relations',
  'partnerships',
  'recruiting',
  'training',
  'compliance',
  'security',
];
const EXPECTED_IDS = [...MANDATORY_IDS, ...RECOMMENDED_IDS];

/** The three departments that already carry a recorded decision in the fixture. */
const ALREADY_DECIDED = ['master-orchestrator', 'marketing', 'sales'];

interface Fixture {
  workspace: string;
  logPath: string;
}

/**
 * A fresh workspace + scripts folder. `buildState` is written verbatim; the two
 * stubs are the only "onboarding" the route gets.
 */
function fixture(buildState: Record<string, unknown>): Fixture {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bu15-keep-all-ws-'));
  const scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'bu15-keep-all-scripts-'));
  const logPath = path.join(workspace, 'recorder-calls.log');

  process.env.OPENCLAW_WORKSPACE_ROOT = workspace;
  process.env.OPENCLAW_SKILL23_SCRIPTS = scripts;

  fs.writeFileSync(
    path.join(workspace, '.workforce-build-state.json'),
    `${JSON.stringify(buildState, null, 2)}\n`,
  );

  // The live floor list the route reads before deciding what is still missing.
  fs.writeFileSync(
    path.join(scripts, 'list-canonical-departments.py'),
    [
      'import json',
      'print(json.dumps({',
      '  "source": "test-fixture",',
      '  "naming_map_version": "test",',
      `  "mandatory_count": ${MANDATORY_IDS.length},`,
      `  "mandatory": ${JSON.stringify(MANDATORY_IDS.map((id) => ({ id, display_name: id, one_liner: 'One line.' })))},`,
      `  "universal_primary_count": ${RECOMMENDED_IDS.length},`,
      `  "universal_primary_vertical": ${JSON.stringify(RECOMMENDED_IDS.map((id) => ({ id, display_name: id, one_liner: 'One line.' })))},`,
      `  "floor": ${EXPECTED_IDS.length}`,
      '}))',
      '',
    ].join('\n'),
  );

  // The recorder stub: logs one line per call, then writes the provenanced
  // decision into build-state exactly where record-dept-decision.sh writes it.
  const recorder = `#!/usr/bin/env bash
set -euo pipefail
dept=""
decision=""
state=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dept) dept="$2"; shift 2 ;;
    --decision) decision="$2"; shift 2 ;;
    --state) state="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "$dept $decision" >> "${logPath}"
python3 - "$state" "$dept" "$decision" <<'PY'
import json, sys
state_path, dept, decision = sys.argv[1], sys.argv[2], sys.argv[3]
with open(state_path) as fh:
    data = json.load(fh)
decisions = data.setdefault("canonicalReconciliation", {}).setdefault("decisions", {})
decisions[dept] = {
    "decision": decision,
    "source": "owner-interview-keep-all",
    "decidedAt": "2026-11-12T00:00:00Z",
    "decidedBy": "operator:api",
    "sessionId": "bu15-test-session",
}
with open(state_path, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\\n")
PY
`;
  fs.writeFileSync(path.join(scripts, 'record-dept-decision.sh'), recorder);

  return { workspace, logPath };
}

/** One line per recorder call: "<dept> <decision>". */
function readCalls(logPath: string): Array<{ dept: string; decision: string }> {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [dept, decision] = line.trim().split(/\s+/);
      return { dept, decision };
    });
}

/** The provenanced object record-dept-decision.sh writes for one department. */
function decided() {
  return {
    decision: 'yes',
    source: 'owner-interview',
    decidedAt: '2026-11-11T00:00:00Z',
    decidedBy: 'operator:api',
    sessionId: 'bu15-test-session',
  };
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/interview/decision', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('older box: {bulk:keep-all} records one provenanced yes for each of the 26 undecided departments', async () => {
  const { logPath } = fixture({
    canonicalReconciliation: {
      decisions: Object.fromEntries(ALREADY_DECIDED.map((id) => [id, decided()])),
    },
  });

  const { POST } = await import('../../src/app/api/interview/decision/route');
  const res = await POST(post({ bulk: 'keep-all', sessionId: 'bu15-test-session' }));
  const body = (await res.json()) as {
    ok: boolean;
    recorded: number;
    decisionCoverage: { complete: boolean; covered: string[]; missing: string[] };
  };

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.recorded, 26);

  const calls = readCalls(logPath);
  assert.equal(calls.length, 26, 'the recorder is called exactly 26 times');
  assert.deepEqual(
    calls.map((c) => c.decision),
    Array.from({ length: 26 }, () => 'yes'),
    'every recorder call is a yes',
  );
  assert.deepEqual(
    calls.map((c) => c.dept).sort(),
    EXPECTED_IDS.filter((id) => !ALREADY_DECIDED.includes(id)).sort(),
    'exactly the undecided expected departments are recorded',
  );

  assert.equal(body.decisionCoverage.complete, true);
  assert.deepEqual(body.decisionCoverage.missing, []);
});

test('standard-first box: {bulk:keep-all} records nothing per department', async () => {
  const { logPath } = fixture({
    buildType: 'standard-first',
    standardPrebuild: {
      status: 'done',
      prebuiltDepartments: EXPECTED_IDS.slice(0, 5),
    },
  });

  const { POST } = await import('../../src/app/api/interview/decision/route');
  const res = await POST(post({ bulk: 'keep-all', sessionId: 'bu15-test-session' }));
  const body = (await res.json()) as { ok: boolean; standardFirst: boolean; recorded: number };

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.standardFirst, true);
  assert.equal(body.recorded, 0);
  assert.deepEqual(readCalls(logPath), [], 'the recorder is never called on a standard-first box');
});

test('a single decision still needs both fields; the bulk form is the only one that may omit them', async () => {
  fixture({ canonicalReconciliation: { decisions: {} } });

  const { POST } = await import('../../src/app/api/interview/decision/route');
  const res = await POST(post({ sessionId: 'bu15-test-session' }));
  const body = (await res.json()) as { error: string };

  assert.equal(res.status, 400);
  assert.equal(body.error, 'invalid_request');
});
