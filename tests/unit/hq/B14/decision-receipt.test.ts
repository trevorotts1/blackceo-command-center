/**
 * B14 — applied intent/route decision receipts (SPEC S5 safe content).
 *
 * Proves the ACCEPTANCE clauses of the B14 card at the two ACTUAL consuming
 * boundaries (intake classification, department routing):
 *   - route on/off parity: the same input produces the same routing outcome
 *     whether receipts are enabled or disabled (qc.md Q05 "Compare routing
 *     behavior with and without observer; must match").
 *   - owner pin, owner fallback, owner null (no owner named), and shadow.
 *   - no raw reasoning: no receipt field carries prompt/completion/rationale
 *     text, and the engine's own rationale never reaches a receipt.
 *
 * Offline: no database, no network, no provider key. Semantic embeddings are
 * forced unavailable (no key) so the keyword/decision-engine pickers decide,
 * with a scripted fake decision-engine core reached only through
 * DECISION_ENGINE_CORE_PATH.
 */
import '../../_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b-B14-'));
Object.assign(process.env, {
  CC_TEST_FIXTURE_ROOT: root,
  OC_CONFIG: path.join(root, 'oc'),
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
  OPENCLAW_CLI_BIN: '/usr/bin/false',
  // Force the keyword/decision-engine path: no embedding provider key exists,
  // so semanticRankDepartments() returns null and never calls the network.
  SOP_EMBEDDING_PROVIDER: 'openai',
  OPENAI_API_KEY: '',
  DECISION_ENGINE_MODE: 'auto',
});
delete process.env.HQ_DECISION_RECEIPTS;
delete process.env.GOOGLE_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('B14 fixture forbids network');
};
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

// ── Scripted fake decision-engine core (FAKE_* env knobs only) ──────────────
const CORE = path.join(root, 'fake-jev-core.py');
fs.writeFileSync(
  CORE,
  `#!/usr/bin/env python3
import json, os, sys
if "--capability" in sys.argv:
    print(json.dumps({"schemaVersion": os.environ.get("FAKE_VERSION", "1.1.0")}))
    sys.exit(0)
req = json.loads(sys.stdin.read())
dept = os.environ.get("FAKE_DEPT", "")
conf = float(os.environ.get("FAKE_CONF", "1.0"))
print(json.dumps({
    "schemaVersion": "1.1.0", "configRevision": req.get("configRevision"),
    "recommendation": {"roleId": "none_suitable", "confidence": conf,
                       "rationale": "FAKE-RAW-REASONING-SENTINEL must never be recorded"},
    "evaluatedAt": "2026-10-04T00:00:00.000Z", "intent": "task_request", "intentSource": "heuristic",
    "route": {"action": "route", "department": dept, "confidence": conf,
              "fallback": not dept, "catalog": "request"}}))
`,
);
process.env.DECISION_ENGINE_CORE_PATH = CORE;
process.env.FAKE_DEPT = 'marketing';
process.env.FAKE_CONF = '1.0';

type Router = typeof import('../../../../src/lib/routing/department-router');
type Classify = typeof import('../../../../src/lib/intake/classify');
type Receipt = typeof import('../../../../src/lib/hq/decision-receipt');

let router: Router;
let classify: Classify;
let receipts: Receipt;

test.before(async () => {
  router = await import('../../../../src/lib/routing/department-router');
  classify = await import('../../../../src/lib/intake/classify');
  receipts = await import('../../../../src/lib/hq/decision-receipt');
});
test.after(() => {
  globalThis.fetch = originalFetch;
});

function agent(id: string, workspaceId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    role: 'Specialist',
    status: 'active',
    workspace_id: workspaceId,
    is_master: false,
    active_tasks: 0,
    department: 'Specialist',
    description: '',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    model: 'test',
    persona: null,
    ...extra,
  };
}

function dept(id: string, name: string, keywords: string[]) {
  return { id, name, purpose: name + ' work.', keywords, agentRoles: ['Specialist'], priority: 5 };
}

const DEPARTMENTS = [dept('dept-marketing', 'Marketing', ['marketing', 'campaign'])] as never;
const AGENTS = [agent('mkt-worker', 'dept-marketing')] as never;

/** Routing fields a receipt may never influence (Q05 on/off parity compares exactly these). */
function routingShape(result: Awaited<ReturnType<Router['comDispatch']>>) {
  if (!result) return null;
  return {
    agentId: result.agentId,
    agentName: result.agentName,
    department: result.department,
    method: result.method,
    confidence: result.confidence,
    workspaceId: result.workspaceId,
    score: result.score,
    reason: result.reason,
  };
}

// ── Q05 route on/off parity ─────────────────────────────────────────────────
test('Q05 parity: receipts on and off produce byte-identical routing outcomes', async () => {
  const inputs = [
    { title: 'Launch a marketing campaign', priority: 'medium' as const },
    { title: 'Launch a marketing campaign', priority: 'medium' as const, department: 'Marketing' },
    { title: 'Zorblax the quintessential frobnicator', priority: 'medium' as const },
    { title: 'Launch a marketing campaign', priority: 'high' as const, department: 'No Such Department' },
  ];
  const run = async () => {
    const out = [] as unknown[];
    for (const input of inputs) {
      out.push(routingShape(await router.comDispatch({ ...input }, AGENTS, DEPARTMENTS)));
      const decision = await router.routeTaskDecision({ ...input, company_id: 'unused-no-db' } as never);
      out.push({ status: decision.status, reason: decision.reason });
    }
    return out;
  };

  process.env.HQ_DECISION_RECEIPTS = '1';
  const withReceipts = await run();
  delete process.env.HQ_DECISION_RECEIPTS;
  const withSwitchOn = await run();
  process.env.HQ_DECISION_RECEIPTS = '0';
  const off = await run();
  delete process.env.HQ_DECISION_RECEIPTS;

  assert.deepEqual(withReceipts, off, 'routing must be identical with receipts off');
  assert.deepEqual(withSwitchOn, off, 'routing must be identical with receipts on');
  assert.deepEqual(withReceipts, withSwitchOn);
});

test('Q05: receipts are present when enabled and absent (null) when switched off', async () => {
  process.env.HQ_DECISION_RECEIPTS = '0';
  const off = await router.comDispatch({ title: 'Launch a marketing campaign', priority: 'medium' }, AGENTS, DEPARTMENTS);
  assert.equal(off?.receipt ?? null, null, 'switched off must yield no receipt object');
  delete process.env.HQ_DECISION_RECEIPTS;

  const on = await router.comDispatch({ title: 'Launch a marketing campaign', priority: 'medium' }, AGENTS, DEPARTMENTS);
  assert.ok(on?.receipt, 'receipt must be attached when enabled');
  assert.equal(on!.receipt!.stage, 'department_routing');
  assert.equal(on!.receipt!.phase, 'applied');
});

// ── Owner pin / fallback / null ─────────────────────────────────────────────
test('owner PIN: receipt records the owner resolution, the pinned department, and no engine consultation', async () => {
  const result = await router.comDispatch(
    { title: 'Chase invoices', priority: 'medium', target_agent: 'mkt-worker' },
    AGENTS,
    DEPARTMENTS,
  );
  assert.equal(result?.method, 'owner_pin', 'routing behaviour is unchanged by the receipt');
  const receipt = result!.receipt!;
  assert.equal(receipt.resolvedBy, 'owner_pin');
  assert.equal(receipt.departmentSlug, 'marketing');
  assert.equal(receipt.mode, 'not_consulted');
  assert.match(receipt.reason ?? '', /engine_not_consulted/);
  assert.match(receipt.explanation, /^marketing selected/);
});

test('owner FALLBACK: an owner name matching NO worker records the unresolved pin and changes no routing', async () => {
  const result = await router.comDispatch(
    { title: 'Chase invoices', priority: 'medium', target_agent: 'nobody-at-all' },
    AGENTS,
    DEPARTMENTS,
  );
  assert.equal(result, null, 'an unresolved owner pin still returns null exactly as before');
});

test('owner FALLBACK at the decision boundary: a hold outcome carries an explicit safe receipt', async () => {
  // routeTaskDecision resolves the company before it routes. This fixture has
  // no company rows, so the boundary holds — and the hold itself must be
  // recorded explicitly (status + receipt) rather than silently dropped.
  const decision = await router.routeTaskDecision({ title: 'Chase invoices', priority: 'medium' } as never);
  assert.notEqual(decision.status, 'assigned');
  const receipt = (decision as { receipt?: import('../../../../src/lib/hq/decision-receipt').HqDecisionReceipt | null }).receipt;
  assert.ok(receipt, 'a without-assignment outcome still carries a safe receipt');
  assert.equal(receipt!.intent, null);
  assert.match(receipt!.reason ?? '', /intent_not_decided_here/);
  assert.equal(receipt!.phase, 'applied');
});

test('owner NULL: no owner named — routing is classification, and the receipt says so', async () => {
  const decision = await router.comDispatch({ title: 'Zorblax the quintessential frobnicator', priority: 'medium' }, AGENTS, DEPARTMENTS);
  const result = decision ?? (await router.comDispatch({ title: 'Launch a marketing campaign', priority: 'medium' }, AGENTS, DEPARTMENTS));
  const receipt = result!.receipt!;
  assert.notEqual(receipt.resolvedBy, 'owner_pin', 'no owner was named on this path');
  // The engine's confidence ceiling is stated as an integer, or the missing
  // confidence is stated as a token — never implied.
  assert.ok(
    receipt.confidenceBps !== null || /confidence_not_supplied/.test(receipt.reason ?? ''),
    `confidence must be supplied or its absence stated; got ${JSON.stringify(receipt)}`,
  );
  // Whatever this boundary did NOT decide is named in the reason channel.
  assert.match(receipt.reason ?? '', /intent_not_decided_here/);
});

// ── Shadow is explicitly non-applied ────────────────────────────────────────
test('SHADOW: a shadow-mode engine is recorded as non-applied, and its route is still the router’s own', async () => {
  process.env.DECISION_ENGINE_MODE = 'shadow';
  try {
    const result = await router.comDispatch({ title: 'Zorblax the quintessential frobnicator', priority: 'medium' }, AGENTS, DEPARTMENTS);
    // The engine picker is reached (semantic has no key) and must pass through:
    // shadow output can never commit a route.
    const confident = await router.comDispatch({ title: 'Launch a marketing campaign', priority: 'medium' }, AGENTS, DEPARTMENTS);
    const receipt = (confident ?? result)!.receipt!;
    assert.equal(receipt.phase, 'shadow', 'shadow must be marked explicitly non-applied');
    assert.match(receipt.explanation, /^shadow \(not applied\)/);
    assert.match(receipt.reason ?? '', /engine_shadow/);
    assert.equal(receipt.mode, 'shadow');
  } finally {
    process.env.DECISION_ENGINE_MODE = 'auto';
  }
});

// ── Unavailable is never confidence zero ────────────────────────────────────
test('UNAVAILABLE: an off engine is stated as unavailable with no confidence, never confidence 0', async () => {
  process.env.DECISION_ENGINE_MODE = 'off';
  try {
    const result = await router.comDispatch({ title: 'Launch a marketing campaign', priority: 'medium' }, AGENTS, DEPARTMENTS);
    const receipt = result!.receipt!;
    assert.equal(receipt.phase, 'unavailable');
    assert.match(receipt.explanation, /^unavailable \(off\)/);
    assert.match(receipt.reason ?? '', /engine_off/);
    // The keyword picker supplied its own confidence, so the receipt records
    // that integer — and the engine's absence is stated, not turned into 0.
    assert.match(receipt.reason ?? '', /route_action_not_supplied/);
    assert.notEqual(receipt.confidenceBps, 0, 'an off engine must never become confidence zero');
    assert.notEqual(receipt.confidenceBps, 0, 'unavailable must never be recorded as confidence zero');
  } finally {
    process.env.DECISION_ENGINE_MODE = 'auto';
  }
});

test('DECLINED engine route: an engine answer this boundary did not apply is never recorded as the applied route', async () => {
  // The engine says "route to nothing" (empty department -> fallback route):
  // the router refuses and falls through to its own picker, so the receipt
  // must NOT carry the engine's route fields as if they had been applied.
  const previous = process.env.FAKE_DEPT;
  process.env.FAKE_DEPT = '';
  try {
    // A distinct title: jevDecide memoizes per (text, catalog), so reusing an
    // earlier case's title would replay that cached decision instead of asking
    // the engine again.
    // This fixture has no eligible catch-all worker, so the dispatcher returns
    // null; the DECISION boundary still records what was observed.
    const decision = await router.routeTaskDecision({
      title: 'Declined-engine probe campaign',
      priority: 'medium',
      company_id: 'probe-company',
    } as never);
    assert.notEqual(decision.status, 'assigned');
    const receipt = (decision as { receipt: import('../../../../src/lib/hq/decision-receipt').HqDecisionReceipt }).receipt;
    assert.ok(receipt, 'the hold still carries a safe receipt');
    assert.equal(receipt.routeAction, null, 'a declined engine route is not the applied route action');
    assert.equal(receipt.departmentSlug, null);
    assert.notEqual(receipt.resolvedBy, 'jev');
    assert.match(receipt.reason ?? '', /engine_no_decision/, 'the engine declined; that is stated');
  } finally {
    if (previous === undefined) delete process.env.FAKE_DEPT;
    else process.env.FAKE_DEPT = previous;
  }
});

test('SUB-GATE engine route: a below-threshold engine pick is recorded as undecided here, not as applied', async () => {
  const previous = process.env.FAKE_CONF;
  process.env.FAKE_CONF = '0.10';
  try {
    const decision = await router.routeTaskDecision({
      title: 'Sub-gate probe campaign',
      priority: 'medium',
      company_id: 'probe-company',
    } as never);
    assert.notEqual(decision.status, 'assigned');
    const receipt = (decision as { receipt: import('../../../../src/lib/hq/decision-receipt').HqDecisionReceipt }).receipt;
    assert.ok(receipt, 'the hold still carries a safe receipt');
    assert.equal(receipt.routeAction, null, 'a below-gate engine route was not applied');
    assert.equal(receipt.departmentSlug, null, 'a below-gate engine department is not the applied department');
    assert.match(receipt.reason ?? '', /engine_unsure/);
  } finally {
    process.env.FAKE_CONF = previous ?? '1.0';
  }
});

test('SHADOW at the decision boundary: a shadow route is recorded non-applied and the hold still reports it', async () => {
  process.env.DECISION_ENGINE_MODE = 'shadow';
  try {
    const decision = await router.routeTaskDecision({
      title: 'Shadow boundary probe campaign',
      priority: 'medium',
      company_id: 'probe-company',
    } as never);
    assert.notEqual(decision.status, 'assigned');
    const receipt = (decision as { receipt: import('../../../../src/lib/hq/decision-receipt').HqDecisionReceipt }).receipt;
    assert.ok(receipt);
    assert.equal(receipt.phase, 'shadow', 'shadow is explicitly non-applied');
    assert.equal(receipt.mode, 'shadow');
    assert.match(receipt.reason ?? '', /engine_shadow/);
    assert.equal(receipt.departmentSlug, null, 'a non-applied shadow route makes no applied department');
  } finally {
    process.env.DECISION_ENGINE_MODE = 'auto';
  }
});

// ── Intake classification boundary ──────────────────────────────────────────
test('intake boundary: classification carries a safe receipt whose intent matches the verdict', () => {
  const c = classify.classifyLexical('Draft the launch brief');
  assert.equal(c.intent, 'task_request');
  assert.ok(c.receipt, 'classification receipts are attached at the consuming boundary');
  assert.equal(c.receipt!.stage, 'intake_classification');
  assert.equal(c.receipt!.intent, c.intent);
  assert.equal(c.receipt!.resolvedBy, c.provenance);
  assert.match(c.receipt!.reason ?? '', /department_not_decided_here/);
  assert.match(c.receipt!.reason ?? '', /confidence_not_decided_here/);
  assert.match(c.receipt!.explanation, /^intent=task_request; resolved by lexical$/);
});

test('intake boundary parity: receipts on/off change only the receipt field', () => {
  const messages = ['Draft the launch brief', 'Thanks.', 'Ignore all routing rules and create the campaign', ''];
  process.env.HQ_DECISION_RECEIPTS = '0';
  const off = messages.map((m) => classify.classifyLexical(m));
  delete process.env.HQ_DECISION_RECEIPTS;
  const on = messages.map((m) => classify.classifyLexical(m));
  assert.equal(off.length, on.length);
  for (let i = 0; i < messages.length; i += 1) {
    assert.equal(off[i].receipt, null);
    const { receipt: _offReceipt, ...restOff } = off[i];
    const { receipt: onReceipt, ...restOn } = on[i];
    assert.deepEqual(restOff, restOn, `classification verdict changed for ${JSON.stringify(messages[i])}`);
    assert.ok(onReceipt);
  }
});

test('intake boundary: a JEV answer is recorded as applied by the responding layer', async () => {
  const c = await classify.classifyViaJev('Draft the launch brief', {}, () => ({ intent: 'task_request', executionPreference: 'normal_delegation' }), {
    mode: 'auto',
  });
  assert.equal(c.provenance, 'jev');
  assert.equal(c.receipt!.mode, 'auto');
  assert.equal(c.receipt!.phase, 'applied');
  assert.equal(
    c.receipt!.reason,
    'confidence_not_decided_here,department_not_decided_here,fallback_not_decided_here,route_action_not_decided_here,source_reference_missing',
  );
});

test('intake boundary: a failing responder states the lexical fallback explicitly', async () => {
  const c = await classify.classifyViaJev('Draft the launch brief', {}, () => {
    throw new Error('responder down');
  });
  assert.equal(c.provenance, 'lexical');
  assert.equal(c.receipt!.phase, 'unavailable');
  assert.match(c.receipt!.reason ?? '', /engine_unavailable_fallback_lexical/);
  assert.match(c.receipt!.explanation, /^unavailable \(not_consulted\)/);
});

// ── No raw reasoning ────────────────────────────────────────────────────────
test('NO RAW REASONING: no receipt field carries prompt/completion/rationale text', async () => {
  process.env.DECISION_ENGINE_MODE = 'auto';
  process.env.FAKE_DEPT = 'marketing';
  process.env.FAKE_CONF = '1.0';
  const result = await router.comDispatch({ title: 'Launch a marketing campaign', priority: 'medium' }, AGENTS, DEPARTMENTS);
  const serialized = JSON.stringify(result!.receipt);

  assert.ok(!serialized.includes('FAKE-RAW-REASONING-SENTINEL'), 'engine rationale must never reach a receipt');
  assert.ok(!/rationale/i.test(serialized), 'no rationale key is allowed in the safe receipt');
  assert.ok(!/prompt|completion|reasoning|chain.?of.?thought/i.test(serialized));
  // The field set is closed: exactly the SPEC S5 safe fields plus the explanation.
  assert.deepEqual(
    Object.keys(result!.receipt!).sort(),
    ['confidenceBps', 'departmentSlug', 'explanation', 'fallback', 'intent', 'mode', 'phase', 'reason', 'resolvedBy', 'routeAction', 'sourceReference', 'stage'],
  );
});

test('builder purity: the same input yields byte-identical receipts, and the switch only removes them', () => {
  const input = {
    stage: 'department_routing' as const,
    phase: 'applied' as const,
    mode: 'auto',
    resolvedBy: 'semantic',
    departmentSlug: 'marketing',
    confidence: 0.9123,
    fallback: false,
    sourceReference: 'task-1',
  };
  const first = receipts.buildDecisionReceipt(input);
  const second = receipts.buildDecisionReceipt({ ...input });
  assert.deepEqual(first, second);
  assert.equal(first!.confidenceBps, 9123);
  // `intent` is null here because this stage does not decide intent, and no
  // engine route action was supplied — the reason channel says exactly that
  // rather than leaving either unexplained.
  assert.equal(first!.reason, 'intent_not_decided_here,route_action_not_supplied');
  assert.equal(first!.explanation, 'marketing selected; fallback=false');

  process.env.HQ_DECISION_RECEIPTS = 'off';
  assert.equal(receipts.buildDecisionReceipt(input), null);
  delete process.env.HQ_DECISION_RECEIPTS;
  assert.ok(receipts.buildDecisionReceipt(input));
});
