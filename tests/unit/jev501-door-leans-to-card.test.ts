/**
 * JEV-501 — the raw ingest door leans to a card, and a failed engine probe
 * recovers without a restart.
 *
 *  - "Refund the customer" / "Pay the electric bill" make ONE card with the
 *    decision engine OFF, TIMING OUT and MISSING (review landmine 1 + 6).
 *  - "Change the price to $997" makes a card unless the request says a
 *    question is pending (landmine 3).
 *  - A probe failure followed by success recovers in-process, and the state
 *    is visible in /api/health (landmine 2).
 *
 * Offline: a scripted fake core (FAKE_* env knobs) stands in for
 * decision-engine.py via DECISION_ENGINE_CORE_PATH; network is blocked.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-jev501-'));
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
  OC_CONFIG: path.join(root, 'oc'), // no decision-engine-mode.conf here
  MC_INSTALLATION_ID: 'jev501-fixture',
});
fs.mkdirSync(path.join(root, 'oc'), { recursive: true });
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENCLAW_DECISION_ENGINE_MODE;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('JEV-501 fixture forbids network');
};

const SPAWN_LOG = path.join(root, 'spawn.log');
fs.writeFileSync(SPAWN_LOG, '');
const FAKE_CORE = path.join(root, 'fake-core.py');
fs.writeFileSync(
  FAKE_CORE,
  `#!/usr/bin/env python3
import json, os, sys, time
def log(kind):
    with open(os.environ["SPAWN_LOG"], "a") as f:
        f.write(kind + "\\n")
if "--capability" in sys.argv:
    log("capability")
    if os.environ.get("FAKE_CAP_FAIL") == "1":
        sys.exit(1)
    print(json.dumps({"schemaVersion": "1.1.0"}))
    sys.exit(0)
if "--evaluate" in sys.argv:
    log("evaluate")
    req = json.loads(sys.stdin.read())
    ms = int(os.environ.get("FAKE_EVAL_SLEEP_MS", "0") or "0")
    if ms:
        time.sleep(ms / 1000.0)
    print(json.dumps({
        "schemaVersion": "1.1.0",
        "configRevision": req.get("configRevision"),
        "recommendation": {"roleId": "none_suitable", "confidence": 0.0, "rationale": "fake"},
        "evaluatedAt": "2026-09-29T00:00:00.000Z",
        "intent": os.environ.get("FAKE_INTENT", "task_request"),
        "intentSource": "heuristic",
        "route": {"action": os.environ.get("FAKE_ACTION", "route"), "department": None,
                  "confidence": 0.5, "fallback": True, "catalog": "empty"},
    }))
    sys.exit(0)
sys.exit(2)
`,
);
fs.chmodSync(FAKE_CORE, 0o755);
process.env.DECISION_ENGINE_CORE_PATH = FAKE_CORE;
process.env.SPAWN_LOG = SPAWN_LOG;

const spawns = (kind: string) => fs.readFileSync(SPAWN_LOG, 'utf8').split('\n').filter((l) => l === kind).length;

type LiveModule = typeof import('../../src/lib/decision-engine/live');
type DbModule = typeof import('../../src/lib/db');
type RouteModule = typeof import('../../src/app/api/tasks/ingest/route');
let live: LiveModule;
let db: DbModule;
let POST: RouteModule['POST'];
let healthGET: () => Promise<Response>;

test.before(async () => {
  live = await import('../../src/lib/decision-engine/live');
  db = await import('../../src/lib/db');
  db.getDb();
  POST = (await import('../../src/app/api/tasks/ingest/route')).POST;
  healthGET = (await import('../../src/app/api/health/route')).GET as unknown as () => Promise<Response>;
  fs.mkdirSync(path.join(root, 'openclaw', 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'openclaw', 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'main' }] } }));
});
test.after(() => {
  globalThis.fetch = originalFetch;
  db?.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

// A fresh company per case, so the message-hash dedupe of one case never
// answers for another.
let serial = 0;
function freshCompany(): string {
  const id = `jev501-${++serial}`;
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [id, id, id]);
  process.env.MC_COMPANY_ID = id;
  return id;
}

async function ingest(payload: Record<string, unknown>) {
  const req = new NextRequest('http://localhost/api/tasks/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const res = (await POST(req)) as unknown as Response;
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as { created?: boolean; intent?: string; task_id: string | null }, text };
}

const cards = () => db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n;

async function assertOneCard(message: string, extra: Record<string, unknown> = {}) {
  freshCompany();
  const before = cards();
  const r = await ingest({ message, ...extra });
  assert.equal(r.status, 201, `"${message}" must make a card, got ${r.status}: ${r.text}`);
  assert.ok(r.body.task_id, `"${message}" must return the card id`);
  assert.equal(cards(), before + 1, `"${message}" must make exactly one card`);
}

async function assertNoCard(message: string, intent: string, extra: Record<string, unknown> = {}) {
  freshCompany();
  const before = cards();
  const r = await ingest({ message, ...extra });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.created, false, `"${message}" must make no card: ${r.text}`);
  assert.equal(r.body.intent, intent);
  assert.equal(cards(), before, `"${message}" must make no card`);
}

// ── landmine 2: a failed probe recovers without a restart ──────────────────
test('a probe failure is retried after backoff and recovers in-process; /api/health shows it', async (t) => {
  process.env.DECISION_ENGINE_MODE = 'auto';
  process.env.FAKE_CAP_FAIL = '1';
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  const realNow = Date.now;
  try {
    assert.equal(await live.jevDecide('JEV501 probe case one'), null, 'failed probe → no decision');
    const failed = live.jevEngineState();
    assert.equal(failed.core, 'failed');
    assert.equal(failed.live, false);
    assert.ok(failed.retryAt, 'the next retry time is exposed');

    const probesAfterFail = spawns('capability');
    assert.equal(await live.jevDecide('JEV501 probe case two'), null);
    assert.equal(spawns('capability'), probesAfterFail, 'inside the backoff window nothing is spawned');

    delete process.env.FAKE_CAP_FAIL;
    Date.now = () => realNow() + 31_000; // past the 30 s first backoff
    const decision = await live.jevDecide('JEV501 probe case three');
    assert.ok(decision, 'after the backoff the probe is retried and the engine recovers');
    assert.equal(spawns('capability'), probesAfterFail + 1, 'exactly one retry probe');
    assert.equal(live.jevEngineState().core, 'ready');
    assert.equal(live.jevEngineState().live, true);
  } finally {
    Date.now = realNow;
  }
  const stateLines = warnings.filter((w) => w.includes('decision engine'));
  assert.equal(stateLines.length, 2, `one warning per state change, got ${JSON.stringify(stateLines)}`);
  assert.match(stateLines[0], /unprobed -> failed/);
  assert.match(stateLines[1], /failed -> ready/);

  const health = (await (await healthGET()).json()) as { decisionEngine?: { live: boolean; core: string; mode: string } };
  assert.deepEqual(
    { live: health.decisionEngine?.live, core: health.decisionEngine?.core, mode: health.decisionEngine?.mode },
    { live: true, core: 'ready', mode: 'auto' },
  );
});

// ── landmine 3: "change … to" is only an answer when a question is pending ──
test('"Change the price to $997" with the engine on and no pending question makes a card', async () => {
  process.env.DECISION_ENGINE_MODE = 'auto';
  process.env.FAKE_INTENT = 'task_request';
  await assertOneCard('Change the price to $997');
  await assertOneCard('Change the price on the coaching page to $997');
});

test('"Change the price to $997" with the engine off and no pending question makes a card', async () => {
  process.env.DECISION_ENGINE_MODE = 'off';
  await assertOneCard('Change the price to $997', { pending_question: false });
});

test('the same message answering a pending question makes no card (engine off and on)', async () => {
  process.env.DECISION_ENGINE_MODE = 'off';
  await assertNoCard('Change the price to $997', 'clarification_response', { pending_question: true });
  process.env.DECISION_ENGINE_MODE = 'auto';
  process.env.FAKE_INTENT = 'task_request';
  await assertNoCard('Change the price to $997', 'clarification_response', { pending_question: true });
});

// ── landmines 1 + 6: engine off / slow / missing → still one card ──────────
for (const message of ['Refund the customer', 'Pay the electric bill']) {
  test(`engine OFF: "${message}" makes one card`, async () => {
    process.env.DECISION_ENGINE_MODE = 'off';
    await assertOneCard(message);
  });
}

test('engine SHADOW / LEGACY: "Refund the customer" still makes one card', async () => {
  for (const mode of ['shadow', 'legacy']) {
    process.env.DECISION_ENGINE_MODE = mode;
    await assertOneCard('Refund the customer');
  }
});

for (const message of ['Refund the customer', 'Pay the electric bill']) {
  test(`engine TIMING OUT: "${message}" makes one card`, async () => {
    process.env.DECISION_ENGINE_MODE = 'auto';
    process.env.FAKE_EVAL_SLEEP_MS = '5000';
    try {
      await assertOneCard(message);
    } finally {
      delete process.env.FAKE_EVAL_SLEEP_MS;
    }
  });
}

// Pure small talk may stay card-less without an engine verdict; existing-task
// control never mints a new card.
test('engine off: exact small talk and existing-task control make no card', async () => {
  process.env.DECISION_ENGINE_MODE = 'off';
  await assertNoCard('Thanks!', 'social_conversation');
  await assertNoCard('Good morning', 'unresolved');
  await assertNoCard('Stop that task.', 'existing_task_control');
});

// Last: pointing at a missing core puts the probe into backoff for the rest
// of the process.
for (const message of ['Refund the customer', 'Pay the electric bill']) {
  test(`engine MISSING: "${message}" makes one card`, async () => {
    process.env.DECISION_ENGINE_MODE = 'auto';
    process.env.DECISION_ENGINE_CORE_PATH = path.join(root, 'no-such-core.py');
    await assertOneCard(message);
  });
}
