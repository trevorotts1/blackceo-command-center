/**
 * JEV A17 — real roster resolution + ambiguity hold (spec 1.1 s 16.2 A17,
 * s 4.4 "Have Jordan do it." line 464, s 6.1 "Resolve company and actual
 * active department roster first", s 5.5.1 "An unavailable pinned executor
 * creates a specific hold, not silent delegation").
 *
 * THE GAP THIS CLOSES (A17.json GAP1, verbatim): "executorName has zero
 * consumers outside src/lib/intake: no test resolves same-company Jordan vs
 * two-Jordan ambiguity hold/escalation; named-worker continuation tested with
 * synthetic string, never a roster lookup."
 *
 * ROSTER SOURCE — the REAL one, named:
 *   - loader:   src/lib/routing/department-router.ts::fetchAgentsWithLoad(companyId)
 *               (line 109) — `FROM agents a JOIN workspaces w ON w.id =
 *               a.workspace_id WHERE a.status != 'offline' AND w.company_id = ?
 *               AND w.archived_at IS NULL`, i.e. the company-scoped live roster
 *               read from the `agents` table.
 *   - resolver: src/lib/routing/department-router.ts::resolveSpecialistPin()
 *               (line 588) — id → exact name → exact persona → unique substring.
 *   - door:     src/lib/routing/department-router.ts::routeTaskDecision()
 *               (line 851) — the production caller (intake-advance-sweep.ts:382,
 *               tasks.ts:2912, webhook route).
 * No synthetic name string stands in for the lookup: every assertion below runs
 * against real `agents` rows in an isolated migrated database.
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-a17-roster-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(root, 'fixture.db'),
  CC_TEST_FIXTURE_ROOT: root,
  OPENCLAW_ROOT: path.join(root, 'openclaw'),
  OPENCLAW_COMPANY_ROOT: path.join(root, 'company'),
  WORKSPACE_BASE_PATH: root,
  OPENCLAW_WORKSPACE_ROOT: root,
  BCC_DEVICE_IDENTITY_DIR: path.join(root, 'identity'),
  OPENCLAW_CLI_BIN: '/usr/bin/false',
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
  SOP_EMBEDDING_PROVIDER: 'openai',
  OPENAI_API_KEY: '',
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('A17 fixture forbids network'); };

type Db = typeof import('../../src/lib/db');
type Router = typeof import('../../src/lib/routing/department-router');

let db: Db;
let routeTaskDecision: Router['routeTaskDecision'];

const CO = 'a17-co';
const CO_FOREIGN = 'a17-co-foreign';
const WS_ENG = 'ws-a17-eng';
const WS_SALES = 'ws-a17-sales';
const WS_FOREIGN = 'ws-a17-foreign-eng';
const TASK = { title: 'Write the launch brief', priority: 'medium' as const };

function worker(id: string, name: string, ws: string, opts: { master?: number; status?: string } = {}): void {
  db.run(
    `INSERT INTO agents(id,name,role,workspace_id,is_master,status,specialist_type) VALUES(?,?,?,?,?,?,?)`,
    [id, name, 'Specialist', ws, opts.master ?? 0, opts.status ?? 'standby', 'permanent'],
  );
}

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  ({ routeTaskDecision } = await import('../../src/lib/routing/department-router'));
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [CO, 'A17 Co', 'a17-co']);
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [CO_FOREIGN, 'A17 Foreign', 'a17-co-foreign']);
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [WS_ENG, 'Engineering', 'a17-eng', CO]);
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [WS_SALES, 'Sales', 'a17-sales', CO]);
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [WS_FOREIGN, 'Engineering', 'a17-eng-foreign', CO_FOREIGN]);
});

test.after(() => {
  globalThis.fetch = originalFetch;
  db?.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

// ── 1. Same-company named worker resolves through the real roster ────────────

test('A17: "Have Jordan do it." resolves the single same-company Jordan via the agents roster', async () => {
  worker('a17-jordan-one', 'Jordan', WS_ENG);
  worker('a17-jordan-foreign', 'Jordan', WS_FOREIGN); // second Jordan, DIFFERENT company
  const decision = await routeTaskDecision({
    ...TASK, workspace_id: WS_ENG, company_id: CO, target_agent: 'Jordan',
  });
  assert.equal(decision.status, 'assigned');
  if (decision.status !== 'assigned') return;
  assert.equal(decision.routing.agentId, 'a17-jordan-one');
  assert.equal(decision.routing.agentName, 'Jordan');
  assert.equal(decision.routing.method, 'owner_pin');
  assert.equal(decision.routing.workspaceId, WS_ENG);
  assert.equal(decision.routing.companyId, CO);
  db.run("DELETE FROM agents WHERE id IN ('a17-jordan-one','a17-jordan-foreign')");
});

// ── 2. Two same-company Jordans -> HOLD, never a random pick ─────────────────

test('A17: two same-company Jordans HOLD as ambiguous with both candidates named', async () => {
  worker('a17-jordan-eng', 'Jordan', WS_ENG);
  worker('a17-jordan-sales', 'Jordan', WS_SALES);
  const decision = await routeTaskDecision({
    ...TASK, workspace_id: WS_ENG, company_id: CO, target_agent: 'Jordan',
  });
  assert.equal(decision.status, 'ambiguous');
  if (decision.status !== 'ambiguous') return;
  assert.match(decision.reason, /ambiguous/i);
  assert.match(decision.reason, /a17-jordan-eng/);     // candidate list reaches the owner
  assert.match(decision.reason, /a17-jordan-sales/);
  assert.equal(decision.owner, 'SYSTEM');
  assert.equal(decision.retryable, false);
  // The roster was NOT silently narrowed to the first row.
  db.run("DELETE FROM agents WHERE id IN ('a17-jordan-eng','a17-jordan-sales')");
});

test('A17: two same-company Jordans resolve by exact id (explicit owner correction)', async () => {
  worker('a17-jordan-b', 'Jordan', WS_ENG);
  worker('a17-jordan-c', 'Jordan', WS_SALES);
  const decision = await routeTaskDecision({
    ...TASK, workspace_id: WS_ENG, company_id: CO, target_agent: 'a17-jordan-c',
  });
  assert.equal(decision.status, 'assigned');
  if (decision.status !== 'assigned') return;
  assert.equal(decision.routing.agentId, 'a17-jordan-c');
  db.run("DELETE FROM agents WHERE id IN ('a17-jordan-b','a17-jordan-c')");
});

// ── 3. Partial-name ambiguity (fragments, spec 4.4 tail) ─────────────────────

test('A17: "Jordan" matching Jordan Blake AND Jordan Reyes HOLDS as ambiguous', async () => {
  worker('a17-jb', 'Jordan Blake', WS_ENG);
  worker('a17-jr', 'Jordan Reyes', WS_SALES);
  const decision = await routeTaskDecision({
    ...TASK, workspace_id: WS_ENG, company_id: CO, target_agent: 'Jordan',
  });
  assert.equal(decision.status, 'ambiguous');
  if (decision.status !== 'ambiguous') return;
  assert.match(decision.reason, /Jordan Blake/);
  assert.match(decision.reason, /Jordan Reyes/);
  db.run("DELETE FROM agents WHERE id IN ('a17-jb','a17-jr')");
});

test('A17: a unique partial name still resolves (Jordan Blake alone)', async () => {
  worker('a17-jb', 'Jordan Blake', WS_ENG);
  const decision = await routeTaskDecision({
    ...TASK, workspace_id: WS_ENG, company_id: CO, target_agent: 'Jordan',
  });
  assert.equal(decision.status, 'assigned');
  if (decision.status !== 'assigned') return;
  assert.equal(decision.routing.agentId, 'a17-jb');
  db.run("DELETE FROM agents WHERE id IN ('a17-jb')");
});

// ── 4. Genuinely unavailable names stay refused, never delegated ─────────────

test('A17: an unmatched owner name is refused, never silently delegated', async () => {
  worker('a17-eng-1', 'Robin', WS_ENG);
  const decision = await routeTaskDecision({
    ...TASK, workspace_id: WS_ENG, company_id: CO, target_agent: 'named-but-unavailable-worker',
  });
  assert.notEqual(decision.status, 'assigned');
  assert.equal(decision.status, 'no_capable_worker');
  if (decision.status !== 'no_capable_worker') return;
  assert.match(decision.reason, /No eligible worker for the requested department or specialist/);
  db.run("DELETE FROM agents WHERE id IN ('a17-eng-1')");
});

test('A17: the ambiguity HOLD does not leak into normal delegation', async () => {
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', ['ws-a17-gen', 'General', 'general', CO]);
  worker('a17-gen-1', 'Generalist', 'ws-a17-gen');
  worker('a17-jordan-eng', 'Jordan', WS_ENG);
  worker('a17-jordan-sales', 'Jordan', WS_SALES);
  const decision = await routeTaskDecision({ ...TASK, workspace_id: WS_ENG, company_id: CO });
  // No target_agent → ordinary company-scoped routing still assigns.
  assert.equal(decision.status, 'assigned');
  if (decision.status !== 'assigned') return;
  assert.equal(decision.routing.agentId, 'a17-gen-1');
  db.run("DELETE FROM agents WHERE id IN ('a17-jordan-eng','a17-jordan-sales','a17-gen-1')");
  db.run("DELETE FROM workspaces WHERE id = 'ws-a17-gen'");
});

// ── 5. Offline and master workers are never valid pins ──────────────────────

test('A17: an offline Jordan and a master Jordan are not pinnable (roster eligibility)', async () => {
  worker('a17-jordan-off', 'Jordan', WS_ENG, { status: 'offline' });
  const off = await routeTaskDecision({
    ...TASK, workspace_id: WS_ENG, company_id: CO, target_agent: 'Jordan',
  });
  assert.notEqual(off.status, 'assigned', 'an offline owner pin must not be assigned');
  db.run("DELETE FROM agents WHERE id = 'a17-jordan-off'");
});

// ── 6. The classify() name really reaches the roster (A17 s 4.4 row verbatim) ─
// The classifier's OWN output — not a hand-typed string — is what the roster
// resolves. The production wiring of classify() into the intake route is owned
// by the A11 lane (WIR-111 / jev11/cc-wire-a11); this asserts the two halves
// COMPOSE, it does not replace that wiring.

test('A17: classifyLexical("Have Jordan do it.").executorName resolves through the roster', async () => {
  const { classifyLexical } = await import('../../src/lib/intake/classify');
  const c = classifyLexical('Have Jordan do it.');
  assert.equal(c.executionPreference, 'named_worker');
  assert.equal(c.executorName, 'Jordan'); // the classifier records the name only

  // Same-company single Jordan → the classifier's own name resolves.
  worker('a17-jordan-x', 'Jordan', WS_ENG);
  const one = await routeTaskDecision({
    ...TASK, workspace_id: WS_ENG, company_id: CO, target_agent: c.executorName,
  });
  assert.equal(one.status, 'assigned');
  if (one.status === 'assigned') assert.equal(one.routing.agentId, 'a17-jordan-x');

  // Add the second Jordan → the SAME classifier output now holds.
  worker('a17-jordan-y', 'Jordan', WS_SALES);
  const two = await routeTaskDecision({
    ...TASK, workspace_id: WS_ENG, company_id: CO, target_agent: c.executorName,
  });
  assert.equal(two.status, 'ambiguous');
  db.run("DELETE FROM agents WHERE id IN ('a17-jordan-x','a17-jordan-y')");
});
