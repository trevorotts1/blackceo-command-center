/**
 * JGT-107 — General Task (slug general-task) is a REAL department, distinct
 * from the structural 'default' workspace seed.ts:137-140 names 'General'.
 *
 * Regression coverage for three name-based bugs that all treated the
 * structural 'default' row as if it were the General Task catch-all:
 *
 *   a) catch-all-policy.ts's isCatchAllWorkspace accepted the bare name
 *      'general', so a non-master agent agent-sync dumped into 'default'
 *      (name 'General') counted as a "General worker".
 *   b) That predicate is shared by department-router.ts's catchAllAssignment
 *      (the dispatch authorization choke point) — a no-match task could
 *      therefore land on an agent sitting in the schema's default bucket
 *      instead of the real general-task lane.
 *   c) ceo-chat/task/route.ts's resolveGeneralTaskWorkspace matched 'general'
 *      by NAME with no company filter and ORDER BY rowid — the 'default' row
 *      (inserted first, name 'General') could win outright, and nothing
 *      stopped a different company's row from winning either.
 *   d) agent-sync.ts's inferDeptFromAgentName substring-matched 'general',
 *      filing an agent named 'General Counsel' into General Task.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-general-vs-default-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(root, 'fixture.db'), CC_TEST_FIXTURE_ROOT: root,
  OPENCLAW_ROOT: path.join(root, 'openclaw'), OPENCLAW_COMPANY_ROOT: path.join(root, 'company'),
  WORKSPACE_BASE_PATH: root, OPENCLAW_WORKSPACE_ROOT: root,
  BCC_DEVICE_IDENTITY_DIR: path.join(root, 'identity'),
  OPENCLAW_CLI_BIN: '/usr/bin/false', DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1', SOP_EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: '',
  MC_INSTALLATION_ID: 'general-vs-default-fixture',
});
delete process.env.MC_COMPANY_ID;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('general-task-vs-default fixture forbids network'); };

let db: typeof import('../../src/lib/db');
let isCatchAllWorkspace: typeof import('../../src/lib/routing/catch-all-policy')['isCatchAllWorkspace'];
let routeTaskDecision: typeof import('../../src/lib/routing/department-router')['routeTaskDecision'];
let resolveGeneralTaskWorkspace: typeof import('../../src/app/api/ceo-chat/task/route')['resolveGeneralTaskWorkspace'];
let resolveAgentDeptWorkspace: typeof import('../../src/lib/openclaw/agent-sync')['resolveAgentDeptWorkspace'];

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb(); // runs the full migration chain against the temp DB

  ({ isCatchAllWorkspace } = await import('../../src/lib/routing/catch-all-policy'));
  ({ routeTaskDecision } = await import('../../src/lib/routing/department-router'));
  ({ resolveGeneralTaskWorkspace } = await import('../../src/app/api/ceo-chat/task/route'));
  ({ resolveAgentDeptWorkspace } = await import('../../src/lib/openclaw/agent-sync'));

  fs.mkdirSync(path.join(root, 'openclaw', 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'openclaw', 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'main' }] } }));

  // ── The structural 'default' row, inserted FIRST — exactly seed.ts:137-140's
  //    shape (id/slug 'default', name 'General'). Company omitted: it takes the
  //    schema DEFAULT ('default', already seeded by migration 113/064).
  db.run(
    `INSERT INTO workspaces (id, name, slug, description, sort_order)
     VALUES ('default', 'General', 'default', 'Structural default workspace (schema DEFAULT target)', 50000)`,
  );

  // ── Company acme: a master (CEO) workspace + a real general-task worker —
  //    PLUS the structural 'default' row re-scoped into this company, which is
  //    exactly the shape MR-14's agent-sync bug produced on a live box: a
  //    stray non-master agent sitting in 'default' under the client's own
  //    company, right alongside its real General Task lane.
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', ['acme', 'Acme', 'acme']);
  db.run(`UPDATE workspaces SET company_id = 'acme' WHERE id = 'default'`);

  db.run(
    'INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)',
    ['acme-ceo', 'Master Orchestrator', 'acme-master-orchestrator', 'acme'],
  );
  db.run(
    'INSERT INTO agents(id,name,role,workspace_id,is_master,status,openclaw_agent_id) VALUES(?,?,?,?,?,?,?)',
    ['acme-ceo-agent', 'main', 'CEO', 'acme-ceo', 1, 'standby', 'main'],
  );

  db.run(
    'INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)',
    ['acme-general-task', 'General Task', 'acme-general-task-slug', 'acme'],
  );
  db.run(
    'INSERT INTO agents(id,name,role,workspace_id,is_master,status) VALUES(?,?,?,?,?,?)',
    ['acme-general-worker', 'General Task Worker', 'General Specialist', 'acme-general-task', 0, 'standby'],
  );

  // A non-master agent parked in the structural 'default' workspace. Its id
  // sorts alphabetically BEFORE 'acme-general-worker' on purpose: catchAllAssignment
  // breaks ties by `a.id.localeCompare(b.id)`, so the pre-fix bug (which made
  // this agent count as an eligible "General worker") would actually be
  // PICKED over the real general-task worker, not just tied with it.
  db.run(
    'INSERT INTO agents(id,name,role,workspace_id,is_master,status) VALUES(?,?,?,?,?,?)',
    ['a0-stray-in-default', 'Stray Default Agent', 'Specialist', 'default', 0, 'standby'],
  );

  // Runtime dirs so catchAllAssignment's readiness filter treats BOTH the real
  // general-task worker and the stray default-workspace agent as live
  // candidates — otherwise readiness alone (not the isCatchAllWorkspace fix)
  // would decide the outcome and the test would pass on main and branch alike.
  fs.mkdirSync(path.join(root, 'openclaw', 'agents', 'dept-acme-general-task-slug'), { recursive: true });
  fs.mkdirSync(path.join(root, 'openclaw', 'agents', 'dept-default'), { recursive: true });
  fs.mkdirSync(path.join(root, 'openclaw', 'agents', 'default'), { recursive: true });

  // ── Company prio-co: proves resolveGeneralTaskWorkspace's ORDER BY makes a
  //    literal 'general-task' slug outrank a legacy 'dept-general-task' one.
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', ['prio-co', 'Prio Co', 'prio-co']);
  db.run(
    'INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)',
    ['prio-dept-general-task', 'General Task Legacy', 'dept-general-task', 'prio-co'],
  );
  db.run(
    'INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)',
    ['prio-general-task', 'General Task', 'general-task', 'prio-co'],
  );

  // ── Company other-co: proves resolveGeneralTaskWorkspace never crosses a
  //    company boundary (name-only match, no literal general-task slug).
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', ['other-co', 'Other Co', 'other-co']);
  db.run(
    'INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)',
    ['other-general-task', 'General Task', 'other-co-general-task-slug', 'other-co'],
  );

  // ── Company d-co: the agent-sync ID-vs-name seam (a real 'legal' workspace
  //    for the id-prefix inference case). The name-fallback case below reuses
  //    prio-co's 'prio-general-task' row (slug 'general-task') rather than
  //    minting a second one — agent-sync's resolveWorkspaceId is a bare
  //    slug/id lookup with no company scope, so it is the same lookup either
  //    way and a second literal 'general-task' slug would collide with it
  //    (slug is UNIQUE).
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', ['d-co', 'D Co', 'd-co']);
  db.run(
    'INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)',
    ['d-legal-ws', 'Legal', 'legal', 'd-co'],
  );
});

test.after(() => {
  globalThis.fetch = originalFetch;
  db?.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

// ── (a) isCatchAllWorkspace ──────────────────────────────────────────────────

test('isCatchAllWorkspace: the structural default workspace is never a catch-all, regardless of name', () => {
  assert.equal(isCatchAllWorkspace({ slug: 'default', name: 'General' }), false);
  assert.equal(isCatchAllWorkspace({ slug: 'DEFAULT', name: 'General' }), false, 'raw slug is checked lowercased');
});

test('isCatchAllWorkspace: general-task and ceo stay true', () => {
  assert.equal(isCatchAllWorkspace({ slug: 'general-task', name: 'General Task' }), true);
  assert.equal(isCatchAllWorkspace({ slug: 'dept-general-task', name: 'General Task' }), true);
  assert.equal(isCatchAllWorkspace({ slug: 'ceo', name: 'CEO' }), true);
  assert.equal(isCatchAllWorkspace({ slug: 'master-orchestrator', name: 'Master Orchestrator' }), true);
});

test('isCatchAllWorkspace: a legacy catch-all row with a non-default slug named General still counts', () => {
  assert.equal(isCatchAllWorkspace({ slug: 'legacy-catchall-slug', name: 'General' }), true);
  assert.equal(isCatchAllWorkspace({ slug: 'legacy-catchall-slug', name: 'General Task' }), true);
});

// ── (b) routeTaskDecision never dispatches to the default-workspace stray agent ──

test('a no-match task routes to the real General Task worker, never the structural default agent', async () => {
  const decision = await routeTaskDecision({
    title: 'zxqv blorpt task with no department match',
    priority: 'medium',
    company_id: 'acme',
    department: 'does-not-exist',
  });
  assert.equal(decision.status, 'assigned', JSON.stringify(decision));
  if (decision.status === 'assigned') {
    assert.equal(decision.routing.agentId, 'acme-general-worker');
    assert.notEqual(decision.routing.agentId, 'a0-stray-in-default');
  }
});

// ── (c) resolveGeneralTaskWorkspace ──────────────────────────────────────────

test('resolveGeneralTaskWorkspace: the real general-task workspace wins over the structural default row', () => {
  const ws = resolveGeneralTaskWorkspace('acme');
  assert.ok(ws, 'expected a general-task workspace to resolve for company acme');
  assert.equal(ws!.id, 'acme-general-task');
  assert.notEqual(ws!.id, 'default');
});

test('resolveGeneralTaskWorkspace: a literal general-task slug outranks a legacy dept-general-task row', () => {
  const ws = resolveGeneralTaskWorkspace('prio-co');
  assert.ok(ws);
  assert.equal(ws!.id, 'prio-general-task');
});

test('resolveGeneralTaskWorkspace: never returns another company\'s row', () => {
  const acme = resolveGeneralTaskWorkspace('acme');
  const other = resolveGeneralTaskWorkspace('other-co');
  assert.ok(acme && other);
  assert.equal(other!.id, 'other-general-task');
  assert.notEqual(other!.id, acme!.id);
});

// ── (d) agent-sync: ID inference wins when confirmed; name match needs the ──
//        full 'general task' phrase, never the bare substring 'general'.

test('resolveAgentDeptWorkspace: a dept-<slug> agent id resolves to its real department, not its name keywords', () => {
  const rawDb = db.getDb();
  const legal = resolveAgentDeptWorkspace(rawDb, 'dept-legal-compliance', 'General Counsel');
  assert.equal(legal.dept, 'legal');
  assert.equal(legal.workspaceId, 'd-legal-ws');
});

test('resolveAgentDeptWorkspace: "General Task Specialist" resolves to general-task via the name fallback', () => {
  const rawDb = db.getDb();
  const gts = resolveAgentDeptWorkspace(rawDb, 'spec-random-id', 'General Task Specialist');
  assert.equal(gts.dept, 'general-task');
  // Reuses prio-co's real 'general-task'-slug row: resolveWorkspaceId is a
  // bare slug/id lookup with no company scope, so this is the row it finds.
  assert.equal(gts.workspaceId, 'prio-general-task');
});

test('resolveAgentDeptWorkspace: a bare "General" substring with no id match and no "general task" phrase never resolves to general-task (MR-14 regression)', () => {
  const rawDb = db.getDb();
  const noIdCounsel = resolveAgentDeptWorkspace(rawDb, 'spec-another-id', 'General Counsel');
  assert.notEqual(noIdCounsel.dept, 'general-task');
  assert.notEqual(noIdCounsel.workspaceId, 'general-task');
});
