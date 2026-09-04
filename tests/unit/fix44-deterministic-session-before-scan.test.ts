/**
 * FIX 44 — deterministic session id before directory scan (B4).
 *
 * PROOF (QC.md FIX 44): trace a QC pass on a review card — NO `readdirSync` of
 * the agents root when the deterministic session file exists.
 *
 * Setup mirrors qc-gates-af-i14-af-lang-independent.test.ts: a TEMP $HOME and a
 * TEMP empty DATABASE_PATH (no openclaw_sessions table → the DB lookup misses →
 * the scorer must fall through to the DETERMINISTIC session-file probe).
 *
 * The deterministic session id is a pure function of the agent name
 * (`mission-control-<name-slug>` — same string the dispatcher stores), so the
 * file ~/.openclaw/agents/<agent-slug>/sessions/mission-control-<slug>.jsonl is
 * resolved by stat alone. A readdirSync spy is armed around the guardrail call;
 * PASS iff the guardrail resolves the trace AND the spy never saw the agents
 * root (or any directory at all).
 *
 * Run: node --import tsx --test tests/unit/fix44-deterministic-session-before-scan.test.ts
 */

// C8 — DB isolation MUST happen in an IMPORTED module, first import.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fix44-proof-'));
process.env.DATABASE_PATH = path.join(TMP, 'empty.db'); // no openclaw_sessions table
const FAKE_HOME = path.join(TMP, 'home');
const AGENT_NAME = 'Dept Presentations';
const AGENT_SLUG = 'dept-presentations';
const DETERMINISTIC_ID = `mission-control-${AGENT_NAME.toLowerCase().replace(/\s+/g, '-')}`;
const SESS_DIR = path.join(FAKE_HOME, '.openclaw', 'agents', AGENT_SLUG, 'sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });
process.env.HOME = FAKE_HOME;

// Spy on fs.readdirSync BEFORE importing the module under test so every fs
// call the scorer makes is captured. Import of 'node:fs' here is the same
// module instance qc-scorer binds its readdirSync to.
const readdirCalls: string[] = [];
const origReaddir = fs.readdirSync;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(fs as any).readdirSync = function spiedReaddir(p: any, ...rest: any[]) {
  readdirCalls.push(typeof p === 'string' ? p : String(p));
  return origReaddir.call(fs, p, ...rest);
};

import { runAFI14Guardrail } from '../../src/lib/qc-scorer';
import { run as dbRun, queryOne as dbQueryOne } from '../../src/lib/db';

/**
 * Seed the assigned-agent row the deterministic probe resolves by name. The
 * agents.name → mission-control-<slug> mapping is exactly what the dispatcher
 * stores, so a QC pass must re-derive the same id. One agent per unique agent
 * id used below; workspace FK satisfied by picking an existing workspace.
 */
function seedAgent(agentId: string): void {
  const existing = dbQueryOne<{ id: string }>('SELECT id FROM agents WHERE id = ?', [agentId]);
  if (existing) return;
  const ws = dbQueryOne<{ id: string }>('SELECT id FROM workspaces ORDER BY id LIMIT 1');
  if (!ws) throw new Error('no workspace to anchor the agent row — seeding bootstrap failed');
  dbRun(
    `INSERT INTO agents (id, name, role, model, status, workspace_id) VALUES (?, ?, 'worker', 'opus', 'standby', ?)`,
    [agentId, AGENT_NAME, ws.id],
  );
}

/** A trace that uses ONLY the mandated KIE.ai path → the guardrail PASSES. */
const CLEAN_TRACE = [
  { role: 'assistant', content: 'Generating slide images now.' },
  { type: 'tool_use', name: 'Bash', input: { command: 'python3 scripts/kie_generate.py prompts.json renders/' } },
  { type: 'tool_result', content: 'api.kie.ai /api/v1/jobs/createTask → 201 8 images' },
];

function writeTrace(name: string, lines: object[]): string {
  const file = path.join(SESS_DIR, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

test('FIX 44: deterministic session file resolves the trace with ZERO readdirSync', () => {
  seedAgent('agent-fix44-1');
  const traceFile = writeTrace(DETERMINISTIC_ID, CLEAN_TRACE);
  assert.ok(fs.existsSync(traceFile), 'fixture: deterministic session file must exist');

  readdirCalls.length = 0;
  const res = runAFI14Guardrail(
    'fix44-task-1',
    'agent-fix44-1', // agent id — NOT the slug; forces a name resolution
    'presentations',
    true, // image/deck deliverable shipped
    true, // fail-closed scope
  );

  assert.equal(res.traceFound, true, 'deterministic session file must be found');
  assert.equal(res.sessionId, DETERMINISTIC_ID, `sessionId must be the deterministic id ${DETERMINISTIC_ID}`);
  assert.equal(res.violated, false, 'clean KIE.ai trace must PASS the guardrail');
  assert.deepEqual(res.violations, []);

  assert.equal(readdirCalls.length, 0, `readdirSync must NEVER run when the deterministic file exists — saw: ${JSON.stringify(readdirCalls)}`);
});

test('FIX 44: agent-name slug directory layout (mission-control-<slug>.jsonl) is the resolved file', () => {
  seedAgent('agent-fix44-2');
  // The file lives at <agent-slug>/sessions/mission-control-<slug>.jsonl — the
  // exact layout the dispatcher + execution-watcher derive. Prove the guardrail
  // read THIS file's content by poisoning it with a VIOLATION-A marker.
  writeTrace(DETERMINISTIC_ID, [
    { type: 'tool_use', name: 'image_generate', input: { prompt: 'slide 1' } },
  ]);

  readdirCalls.length = 0;
  const res = runAFI14Guardrail('fix44-task-2', 'agent-fix44-2', 'presentations', true, true);

  assert.equal(res.traceFound, true);
  assert.equal(res.sessionId, DETERMINISTIC_ID);
  assert.equal(res.violated, true, 'poisoned deterministic trace must fire VIOLATION-A (proves this exact file was read)');
  assert.ok(res.violations.some((v) => v.includes('VIOLATION-A')));
  assert.equal(readdirCalls.length, 0, 'no readdirSync even on a violation trace');
});

test('FIX 44: last-resort scan still works when NO deterministic file exists', () => {
  seedAgent('agent-fix44-3');
  // Rename the deterministic file away → the DB misses, the deterministic probe
  // misses, and ONLY NOW may the scan run. The task id is planted in a trace
  // file under the agent's sessions dir (the scan matches on content).
  const stash = path.join(SESS_DIR, `${DETERMINISTIC_ID}.jsonl.stash`);
  fs.renameSync(path.join(SESS_DIR, `${DETERMINISTIC_ID}.jsonl`), stash);
  const scanTarget = path.join(SESS_DIR, 'legacy-session.jsonl');
  fs.writeFileSync(
    scanTarget,
    JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'python3 scripts/kie_generate.py x.json out/' } }) + '\nfix44-task-3\n',
  );

  readdirCalls.length = 0;
  const res = runAFI14Guardrail('fix44-task-3', 'agent-fix44-3', 'presentations', true, true);

  assert.equal(res.traceFound, true, 'last-resort scan must still locate the trace');
  assert.equal(res.sessionId, 'legacy-session');
  assert.equal(res.violated, false);
  assert.ok(readdirCalls.length > 0, 'last-resort path MAY readdirSync (scan is the escape hatch)');

  // Restore the fixture for the next test run.
  fs.renameSync(stash, path.join(SESS_DIR, `${DETERMINISTIC_ID}.jsonl`));
  fs.unlinkSync(scanTarget);
});
