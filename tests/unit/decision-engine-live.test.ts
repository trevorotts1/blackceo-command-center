/**
 * JGT105 — CC's live JEV wiring: src/lib/decision-engine/live.ts, the
 * department-router JEV hook, and the ingest raw-door jevResponder.
 *
 * Offline only: a scripted FAKE python core (temp dir, driven entirely by
 * FAKE_* env knobs — never by parsing task text) stands in for the installed
 * decision-engine.py, reached only via DECISION_ENGINE_CORE_PATH. Real
 * embeddings/network are blocked the same way tests/unit/catch-all-routing.
 * test.ts does, because department-router's semantic step can otherwise try
 * to reach a real provider using whatever key happens to be in this box's
 * environment.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-jev-live-'));
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
  // Force keyword-only routing: department-router's semantic step must never
  // make a real network call in this suite.
  SOP_EMBEDDING_PROVIDER: 'openai',
  OPENAI_API_KEY: '',
  MC_COMPANY_ID: 'jev-live-a',
  MC_INSTALLATION_ID: 'jev-live-fixture',
});
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('JEV-live fixture forbids network');
};

// ── Fake python core (temp dir; FAKE_* env-driven; one log line per spawn) ──
const SPAWN_LOG = path.join(root, 'spawn.log');
fs.writeFileSync(SPAWN_LOG, '');
const FAKE_CORE = path.join(root, 'fake-jev-core.py');
fs.writeFileSync(
  FAKE_CORE,
  `#!/usr/bin/env python3
import json, os, sys, time

def log(kind):
    with open(os.environ["SPAWN_LOG"], "a") as f:
        f.write(kind + "\\n")

def main(argv):
    if "--capability" in argv:
        log("capability")
        sleep_ms = int(os.environ.get("FAKE_CAP_SLEEP_MS", "0") or "0")
        if sleep_ms:
            time.sleep(sleep_ms / 1000.0)
        print(json.dumps({"schemaVersion": os.environ.get("FAKE_VERSION", "1.1.0")}))
        return 0
    if "--evaluate" in argv:
        log("evaluate")
        raw = sys.stdin.read()
        req = json.loads(raw)
        sleep_ms = int(os.environ.get("FAKE_EVAL_SLEEP_MS", "0") or "0")
        if sleep_ms:
            time.sleep(sleep_ms / 1000.0)
        base = {
            "schemaVersion": os.environ.get("FAKE_VERSION", "1.1.0"),
            "configRevision": req.get("configRevision"),
            "recommendation": {"roleId": "none_suitable", "confidence": 0.0, "rationale": "fake"},
            "evaluatedAt": "2026-09-29T00:00:00.000Z",
        }
        if os.environ.get("FAKE_LEGACY") == "1":
            print(json.dumps(base))
            return 0
        department = os.environ.get("FAKE_DEPT") or None
        hint = os.environ.get("FAKE_DEPT_HINT")
        if hint:
            for d in (req.get("departments") or []):
                name = str(d.get("name", "")).lower()
                slug = str(d.get("slug", "")).lower()
                if hint.lower() in name or hint.lower() in slug:
                    department = d.get("slug")
                    break
        base["intent"] = os.environ.get("FAKE_INTENT", "task_request")
        base["intentSource"] = "heuristic"
        base["route"] = {
            "action": os.environ.get("FAKE_ACTION", "route"),
            "department": department,
            "confidence": float(os.environ.get("FAKE_CONFIDENCE", "0.8")),
            "fallback": os.environ.get("FAKE_FALLBACK", "false") == "true",
            "catalog": os.environ.get("FAKE_CATALOG", "request" if req.get("departments") else "empty"),
        }
        print(json.dumps(base))
        return 0
    print("usage: fake-jev-core.py [--capability] [--evaluate]", file=sys.stderr)
    return 2

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`,
);
fs.chmodSync(FAKE_CORE, 0o755);

process.env.DECISION_ENGINE_CORE_PATH = FAKE_CORE;
process.env.SPAWN_LOG = SPAWN_LOG;

function spawnLogLines(): string[] {
  return fs.readFileSync(SPAWN_LOG, 'utf8').split('\n').filter(Boolean);
}
function resetFakeEnv(): void {
  for (const k of [
    'FAKE_VERSION', 'FAKE_CAP_SLEEP_MS', 'FAKE_EVAL_SLEEP_MS', 'FAKE_LEGACY',
    'FAKE_DEPT', 'FAKE_DEPT_HINT', 'FAKE_INTENT', 'FAKE_ACTION', 'FAKE_FALLBACK',
    'FAKE_CONFIDENCE', 'FAKE_CATALOG',
  ]) delete process.env[k];
}

// ── Modules under test (dynamic import: env above must land first) ─────────
type LiveModule = typeof import('../../src/lib/decision-engine/live');
type IndexModule = typeof import('../../src/lib/decision-engine/index');
type DbModule = typeof import('../../src/lib/db');
type RouterModule = typeof import('../../src/lib/routing/department-router');
type RouteModule = typeof import('../../src/app/api/tasks/ingest/route');

let live: LiveModule;
let idx: IndexModule;
let db: DbModule;
let routeTaskDecision: RouterModule['routeTaskDecision'];
let POST: RouteModule['POST'];

test.before(async () => {
  live = await import('../../src/lib/decision-engine/live');
  idx = await import('../../src/lib/decision-engine/index');
  db = await import('../../src/lib/db');
  db.getDb();
  routeTaskDecision = (await import('../../src/lib/routing/department-router')).routeTaskDecision;
  POST = (await import('../../src/app/api/tasks/ingest/route')).POST;
  for (const company of ['jev-live-a']) {
    db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [company, company, company]);
  }
  fs.mkdirSync(path.join(root, 'openclaw', 'agents', 'main'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'openclaw', 'openclaw.json'),
    JSON.stringify({ agents: { list: [{ id: 'main' }] } }),
  );
});
test.after(() => {
  globalThis.fetch = originalFetch;
  db?.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

// ── (a) jevMode(): env / file / default priority ────────────────────────────
test('jevMode: env off wins outright', () => {
  process.env.DECISION_ENGINE_MODE = 'off';
  delete process.env.OPENCLAW_DECISION_ENGINE_MODE;
  assert.equal(live.jevMode(), 'off');
  delete process.env.DECISION_ENGINE_MODE;
});

test('jevMode: OPENCLAW_DECISION_ENGINE_MODE is the second-priority env fallback', () => {
  delete process.env.DECISION_ENGINE_MODE;
  process.env.OPENCLAW_DECISION_ENGINE_MODE = 'shadow';
  assert.equal(live.jevMode(), 'shadow');
  delete process.env.OPENCLAW_DECISION_ENGINE_MODE;
});

test('jevMode: file value "shadow" is honoured when no env is set', () => {
  delete process.env.DECISION_ENGINE_MODE;
  delete process.env.OPENCLAW_DECISION_ENGINE_MODE;
  const confDir = fs.mkdtempSync(path.join(root, 'oc-shadow-'));
  fs.writeFileSync(path.join(confDir, 'decision-engine-mode.conf'), 'shadow\n');
  process.env.OC_CONFIG = confDir;
  assert.equal(live.jevMode(), 'shadow');
});

test('jevMode: a present-but-invalid file value resolves to off', () => {
  delete process.env.DECISION_ENGINE_MODE;
  delete process.env.OPENCLAW_DECISION_ENGINE_MODE;
  const confDir = fs.mkdtempSync(path.join(root, 'oc-garbage-'));
  fs.writeFileSync(path.join(confDir, 'decision-engine-mode.conf'), 'garbage-value');
  process.env.OC_CONFIG = confDir;
  assert.equal(live.jevMode(), 'off');
});

test('jevMode: no env and no file resolves to auto', () => {
  delete process.env.DECISION_ENGINE_MODE;
  delete process.env.OPENCLAW_DECISION_ENGINE_MODE;
  const confDir = fs.mkdtempSync(path.join(root, 'oc-none-'));
  process.env.OC_CONFIG = confDir;
  assert.equal(live.jevMode(), 'auto');
});

// ── (b) off → null, zero spawns ──────────────────────────────────────────────
test('jevDecide: mode off returns null and spawns nothing at all', async () => {
  process.env.DECISION_ENGINE_MODE = 'off';
  resetFakeEnv();
  const before = spawnLogLines().length;
  const result = await live.jevDecide('JGT105-CASE-B off-mode task text');
  assert.equal(result, null);
  assert.equal(spawnLogLines().length, before, 'off must not spawn the probe or the core');
});

// ── (c) auto → a decision; a repeat call hits the memo (no new spawn) ───────
test('jevDecide: auto produces a decision; an identical repeat call hits the memo', async () => {
  process.env.DECISION_ENGINE_MODE = 'auto';
  resetFakeEnv();
  process.env.FAKE_INTENT = 'task_request';
  process.env.FAKE_ACTION = 'route';
  process.env.FAKE_FALLBACK = 'true';
  const text = 'JGT105-CASE-C repeatable task text';

  const first = await live.jevDecide(text);
  assert.ok(first, 'first call must produce a decision');
  assert.equal(first!.intent, 'task_request');
  assert.equal(first!.route.action, 'route');

  const evalCountAfterFirst = spawnLogLines().filter((l) => l === 'evaluate').length;
  assert.ok(evalCountAfterFirst >= 1, 'first call must spawn --evaluate');

  const second = await live.jevDecide(text);
  assert.deepEqual(second, first, 'the memoized decision is returned verbatim');
  const evalCountAfterSecond = spawnLogLines().filter((l) => l === 'evaluate').length;
  assert.equal(evalCountAfterSecond, evalCountAfterFirst, 'a repeat call must not spawn --evaluate again');
});

// ── (d) a legacy response (no intent/route) → null ──────────────────────────
test('jevDecide: a core response missing intent/route (pre-JGT101 core) → null', async () => {
  process.env.DECISION_ENGINE_MODE = 'auto';
  resetFakeEnv();
  process.env.FAKE_LEGACY = '1';
  const result = await live.jevDecide('JGT105-CASE-D legacy-core task text');
  assert.equal(result, null);
});

// ── (e) a core that sleeps 5s → null within ~3.5s (the 3000ms root deadline) ─
test('jevDecide: a core that hangs 5s is killed by the 3000ms deadline, null within ~3.5s', async () => {
  process.env.DECISION_ENGINE_MODE = 'auto';
  resetFakeEnv();
  process.env.FAKE_EVAL_SLEEP_MS = '5000';
  const started = Date.now();
  const result = await live.jevDecide('JGT105-CASE-E slow-core task text');
  const elapsedMs = Date.now() - started;
  assert.equal(result, null);
  assert.ok(elapsedMs < 3500, `expected null within ~3.5s, took ${elapsedMs}ms`);
});

// ── liveJevResponder: existing_task_control / clarification_response win ───
test('liveJevResponder: lexical existing_task_control beats a live JEV answer', async () => {
  process.env.DECISION_ENGINE_MODE = 'auto';
  resetFakeEnv();
  process.env.FAKE_INTENT = 'task_request';
  process.env.FAKE_ACTION = 'route';
  process.env.FAKE_FALLBACK = 'true';
  const answer = await live.liveJevResponder({ message: 'Stop that task.', context: {} });
  assert.equal(answer.intent, 'existing_task_control', 'the lexical control-verb rule must win over JEV');
});

// ── (f) routeTaskDecision: JEV picks a department (fallback=false) vs the
//        existing keyword path deciding when JEV reports fallback=true ─────
let deptSerial = 0;
function deptFixture() {
  const suffix = String(++deptSerial);
  const company = `jev-dept-${suffix}`;
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [company, company, company]);
  function worker(name: 'Marketing' | 'Legal / Compliance') {
    const kind = name === 'Marketing' ? 'marketing' : 'legal';
    const workspace = `ws-${kind}-${suffix}`;
    const slug = `${kind}-${suffix}`;
    const agentId = `worker-${kind}-${suffix}`;
    db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [workspace, name, slug, company]);
    db.run(
      'INSERT INTO agents(id,name,role,workspace_id,is_master,status) VALUES(?,?,?,?,0,?)',
      [agentId, agentId, 'General Specialist', workspace, 'standby'],
    );
    fs.mkdirSync(path.join(root, 'openclaw', 'agents', `dept-${slug}`), { recursive: true });
    return { agentId, workspace, slug };
  }
  const task = { title: 'Launch the spring promotion campaign', priority: 'medium' as const, company_id: company };
  return { company, worker, task };
}

test('routeTaskDecision: JEV names a catalog department with fallback=false → dispatched explicitly', async () => {
  process.env.DECISION_ENGINE_MODE = 'auto';
  resetFakeEnv();
  process.env.FAKE_INTENT = 'task_request';
  process.env.FAKE_ACTION = 'route';
  process.env.FAKE_FALLBACK = 'false';
  process.env.FAKE_DEPT_HINT = 'legal';
  // JEV-502: only a full-confidence engine route is taken (the real engine's domain matches score 1.0).
  process.env.FAKE_CONFIDENCE = '1.0';

  const f = deptFixture();
  const legal = f.worker('Legal / Compliance');
  f.worker('Marketing');

  const decision = await routeTaskDecision(f.task);
  assert.equal(decision.status, 'assigned', JSON.stringify(decision));
  if (decision.status !== 'assigned') return;
  assert.equal(decision.routing.agentId, legal.agentId, 'JEV-named department must win over keyword scoring');
  assert.ok(
    decision.routing.reason.endsWith(' (department chosen by decision engine)'),
    `reason must end with the decision-engine suffix, got: ${decision.routing.reason}`,
  );
  assert.ok(!decision.routing.reason.startsWith('[catch-all]'), 'the suffix is never a prefix');
});

test('routeTaskDecision: JEV reports fallback=true → the existing keyword path decides (marketing)', async () => {
  process.env.DECISION_ENGINE_MODE = 'auto';
  resetFakeEnv();
  process.env.FAKE_INTENT = 'task_request';
  process.env.FAKE_ACTION = 'route';
  process.env.FAKE_FALLBACK = 'true';

  const f = deptFixture();
  f.worker('Legal / Compliance');
  const marketing = f.worker('Marketing');

  const decision = await routeTaskDecision(f.task);
  assert.equal(decision.status, 'assigned', JSON.stringify(decision));
  if (decision.status !== 'assigned') return;
  assert.equal(decision.routing.agentId, marketing.agentId, 'fallback=true must preserve the existing keyword path');
  assert.ok(
    !decision.routing.reason.endsWith(' (department chosen by decision engine)'),
    'fallback=true must never carry the decision-engine suffix',
  );
});

// ── (g) ingest raw door: JEV's intent decides card creation ─────────────────
function signedIngest(POSTfn: RouteModule['POST'], payload: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const req = new NextRequest('http://localhost/api/tasks/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  });
  return POSTfn(req) as unknown as Promise<Response>;
}

test('ingest raw door: fake answer_only → created:false (no card)', async () => {
  process.env.MC_COMPANY_ID = 'jev-live-a';
  process.env.DECISION_ENGINE_MODE = 'auto';
  resetFakeEnv();
  process.env.FAKE_INTENT = 'answer_only';
  process.env.FAKE_ACTION = 'answer';
  process.env.FAKE_FALLBACK = 'false';

  const res = await signedIngest(POST, { message: 'JGT105-CASE-G What time is it in Tokyo?' });
  const body = (await res.json()) as { created: boolean; intent: string };
  assert.equal(res.status, 200);
  assert.equal(body.created, false);
  assert.equal(body.intent, 'answer_only');
});

test('ingest raw door: fake task_request → a card (lexically unresolved on main)', async () => {
  process.env.MC_COMPANY_ID = 'jev-live-a';
  process.env.DECISION_ENGINE_MODE = 'auto';
  resetFakeEnv();
  process.env.FAKE_INTENT = 'task_request';
  process.env.FAKE_ACTION = 'route';
  process.env.FAKE_FALLBACK = 'true';

  const before = db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n;
  const message = 'JGT105-CASE-G Zorp the flange assembly';
  const res = await signedIngest(POST, { message });
  const bodyText = await res.text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${bodyText}`);
  const body = JSON.parse(bodyText) as { created?: boolean; task_id: string };
  assert.ok(body.task_id, 'a card must be created for a live JEV task_request verdict');
  const after = db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n;
  assert.equal(after, before + 1, 'exactly one new card');
});

// ── (h) default-vs-general-task exclusion in the ingest fallback query ──────
test('ingest raw door: a "default"/"General" row inserted first never wins over general-task', async () => {
  // Mode OFF on purpose: this case targets the SQL exclusion fix in
  // ingest/route.ts (item 4b, "AND id <> 'default' AND lower(slug) <> 'default'"
  // + the ORDER BY preferring the real slug), not JEV — routeTask() returns
  // null here purely because no seeded department matches the gibberish text,
  // which is true with or without a live core. Keeping it JEV-independent
  // means this assertion can never be masked by a fake-core scripting mistake.
  process.env.DECISION_ENGINE_MODE = 'off';
  resetFakeEnv();

  const company = 'jev-h-company';
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [company, company, company]);
  const now = new Date().toISOString();
  // The structural 'default' row, named 'General' — inserted FIRST, so the
  // pre-fix query (no id/slug exclusion, no ORDER BY) would have picked it.
  db.run(
    `INSERT INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('default', 'default', 'General', '🏠', ?, 0, ?, ?)`,
    [company, now, now],
  );
  const generalTaskWs = `ws-general-task-h`;
  db.run(
    `INSERT INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'general-task', 'General Task', '📋', ?, 99, ?, ?)`,
    [generalTaskWs, company, now, now],
  );
  // A real, unrelated department + a live worker, so isWorkforceProvisioned()
  // is true and the auto-route block actually runs.
  const salesWs = `ws-sales-h`;
  db.run(
    `INSERT INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'sales', 'Sales', '💰', ?, 1, ?, ?)`,
    [salesWs, company, now, now],
  );
  db.run(
    "INSERT INTO agents(id,name,role,workspace_id,is_master,status) VALUES(?,?,?,?,0,'standby')",
    ['sales-worker-h', 'sales-worker-h', 'General Specialist', salesWs],
  );
  // A fresh DB auto-seeds a self client row with interview_complete=0, which
  // alone makes isWorkforceProvisioned() false and SKIPS the auto-route block
  // this case targets — force it true so the block (and the SQL fix) actually run.
  db.run('UPDATE clients SET interview_complete = 1 WHERE is_self = 1');

  const prevCompanyId = process.env.MC_COMPANY_ID;
  process.env.MC_COMPANY_ID = company;
  try {
    const message = 'Draft a memo about the zzqrx nonsense filler project.';
    const res = await signedIngest(POST, { message });
    const bodyText = await res.text();
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${bodyText}`);
    const body = JSON.parse(bodyText) as { task_id: string };
    const row = db.queryOne<{ workspace_id: string }>('SELECT workspace_id FROM tasks WHERE id = ?', [body.task_id]);
    assert.equal(row?.workspace_id, generalTaskWs, 'a no-match bare task must land on the real general-task row, never the structural default');
  } finally {
    process.env.MC_COMPANY_ID = prevCompanyId;
  }
});

// ── (i) buildRequest / assertAssignmentReadOnly ─────────────────────────────
test('buildRequest omits departments unless non-empty; assertAssignmentReadOnly accepts intent/route', () => {
  const bare = idx.buildRequest({ configRevision: 'r1', taskId: 't1', taskDescription: 'd1' });
  assert.equal('departments' in bare, false, 'no departments field at all when none were given');

  const empty = idx.buildRequest({ configRevision: 'r1', taskId: 't1', taskDescription: 'd1', departments: [] });
  assert.equal('departments' in empty, false, 'an empty array is treated the same as absent');

  const withDepts = idx.buildRequest({
    configRevision: 'r1',
    taskId: 't1',
    taskDescription: 'd1',
    departments: [{ slug: 'legal', name: 'Legal' }],
  });
  assert.deepEqual(withDepts.departments, [{ slug: 'legal', name: 'Legal' }]);

  assert.doesNotThrow(() =>
    idx.assertAssignmentReadOnly({
      intent: 'task_request',
      intentSource: 'heuristic',
      route: { action: 'route', department: 'legal', confidence: 0.5, fallback: false, catalog: 'request' },
    }),
  );
});
