/**
 * The route scorer: a decision an owner can read, and an "unknown" that never
 * refuses a provider.
 *
 * MUST import _isolated-db FIRST so getDb() opens a throwaway file.
 *
 * Every case below injects its own ledger, latency history and candidate list.
 * Nothing here reads this box's openclaw.json or its live pools: the scorer's
 * job is to turn three inputs into one decision, and a test that sourced those
 * inputs from the developer's own machine would pass or fail on whatever that
 * machine happened to be running.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '@/lib/db';
import {
  BALANCE_FLOOR,
  isBlocked,
  medianLatencyByProvider,
  qualityOrder,
  recordRoutingReason,
  scoreRoute,
  taskKind,
} from '@/lib/capacity/route-scorer';
import type { ProviderLedgerEntry } from '@/lib/capacity/resource-ledger';
import type { Agent } from '@/lib/types';

const AGENT = { id: 'scorer-agent', name: 'Scorer Agent', role: 'specialist' } as unknown as Agent;

function ledgerEntry(provider: string, over: Partial<ProviderLedgerEntry> = {}): ProviderLedgerEntry {
  return {
    provider,
    slotsFree: 5,
    slotsLimit: 5,
    effectiveLimit: 5,
    coolingUntil: null,
    balance: null,
    balanceCurrency: null,
    balanceAsOf: null,
    pricePerMTokIn: null,
    pricePerMTokOut: null,
    lastProbeError: null,
    ...over,
  };
}

// ── A. Sovereignty: the candidate set is the agent's own list ───────────────

test('an agent that declares one model has one candidate — the answer is queue, never substitute', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/deepseek-v4.1-flash:cloud'],
    ledger: [ledgerEntry('ollama', { slotsFree: 0 })],
    latency: {},
  });
  assert.equal(decision.candidates.length, 1);
  assert.equal(decision.preferred?.provider, 'ollama');
  assert.equal(decision.askWorthy, true, 'the agent\'s own preferred model cannot serve the card — that is the fact');
  assert.equal(decision.overflowTo, null, 'nothing to overflow onto');
  assert.equal(decision.allBlocked, true);
  assert.match(decision.reason, /declares no other model/);
});

test('the preferred candidate is the FIRST declared model, not the best-scoring one', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash', 'openrouter/minimax/minimax-m3'],
    ledger: [ledgerEntry('ollama', { slotsFree: 0 }), ledgerEntry('openrouter', { slotsFree: 12 })],
    latency: {},
  });
  assert.equal(decision.preferred?.provider, 'ollama', 'preferred is model.primary, whatever its score');
  assert.equal(decision.recommended?.provider, 'openrouter');
  assert.equal(decision.overflowTo?.provider, 'openrouter', 'the overflow target is the next USABLE entry in CONFIG order');
  assert.equal(decision.askWorthy, true);
});

// ── B. Every dimension can answer "undetermined", and never refuses on one ──

test('a null balance is undetermined, not empty — it never blocks a candidate', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash'],
    // Ollama Cloud publishes no balance. Scoring it as empty would refuse the
    // one provider a subscription client can always reach.
    ledger: [ledgerEntry('ollama', { balance: null, slotsFree: 3 })],
    latency: {},
  });
  assert.equal(decision.preferred?.affordable, null);
  assert.equal(isBlocked(decision.preferred!), false);
  assert.match(decision.reason, /^Running on/);
});

test('a KNOWN balance at or below the floor does block', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['deepseek/deepseek-flash'],
    ledger: [ledgerEntry('deepseek', { balance: BALANCE_FLOOR, slotsFree: 9 })],
    latency: {},
  });
  assert.equal(decision.preferred?.affordable, false);
  assert.equal(isBlocked(decision.preferred!), true);
  assert.match(decision.reason, /balance/);
});

test('a balance just above the floor does not block', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['deepseek/deepseek-flash'],
    ledger: [ledgerEntry('deepseek', { balance: BALANCE_FLOOR + 0.01, slotsFree: 9 })],
    latency: {},
  });
  assert.equal(decision.preferred?.affordable, true);
  assert.equal(isBlocked(decision.preferred!), false);
});

test('no measured latency means the deadline question is undetermined, not failed', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash'],
    ledger: [ledgerEntry('ollama', { slotsFree: 2 })],
    latency: {}, // this box has never completed a run on ollama
    needBy: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(decision.preferred?.medianLatencyMs, null);
  assert.equal(decision.preferred?.meetsDeadline, null);
  assert.equal(isBlocked(decision.preferred!), false, 'an unmeasured provider is not a late one');
});

test('a MEASURED median that overruns the deadline does block, and says by how much', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z');
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash'],
    ledger: [ledgerEntry('ollama', { slotsFree: 2 })],
    latency: { ollama: 30 * 60_000 }, // 30 minutes, measured
    needBy: new Date(now + 10 * 60_000).toISOString(), // due in 10
    nowMs: now,
  });
  assert.equal(decision.preferred?.meetsDeadline, false);
  assert.match(decision.reason, /typically takes 30m/);
});

test('no deadline on the card means the deadline is not a factor at all', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash'],
    ledger: [ledgerEntry('ollama', { slotsFree: 2 })],
    latency: { ollama: 99 * 60_000 },
    needBy: null,
  });
  assert.equal(decision.preferred?.meetsDeadline, null);
  assert.equal(isBlocked(decision.preferred!), false);
});

test('unknown pool state is undetermined too — a provider the pools do not track still runs', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['somevendor/model-x'],
    ledger: [],
    latency: {},
  });
  assert.equal(decision.preferred?.canStartNow, null);
  assert.equal(isBlocked(decision.preferred!), false);
});

// ── C. Definite refusals ───────────────────────────────────────────────────

test('a cooling pool is a definite no and the reason names the reopen time', () => {
  const until = '2026-09-21T12:30:00.000Z';
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash'],
    ledger: [ledgerEntry('ollama', { slotsFree: 3, coolingUntil: until })],
    latency: {},
  });
  assert.equal(decision.preferred?.canStartNow, false, 'a shut pool has no usable slots whatever the count says');
  assert.match(decision.reason, new RegExp(until));
});

test('a full pool is a definite no', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash'],
    ledger: [ledgerEntry('ollama', { slotsFree: 0, slotsLimit: 3, effectiveLimit: 3 })],
    latency: {},
  });
  assert.equal(decision.preferred?.canStartNow, false);
  assert.match(decision.reason, /pool full/);
});

// ── D. The pick is deterministic ───────────────────────────────────────────

test('the same inputs always produce the same pick, so the reason can be trusted', () => {
  const input = {
    agent: AGENT,
    candidateModels: ['ollama/flash', 'openrouter/m3', 'deepseek/flash'],
    ledger: [
      ledgerEntry('ollama', { slotsFree: 0 }),
      ledgerEntry('openrouter', { slotsFree: 4, pricePerMTokIn: 0.3 }),
      ledgerEntry('deepseek', { slotsFree: 4, pricePerMTokIn: 0.15 }),
    ],
    latency: {},
    title: 'Write a blog post',
  };
  const first = scoreRoute(input);
  for (let i = 0; i < 5; i++) assert.equal(scoreRoute(input).recommended?.modelId, first.recommended?.modelId);
});

test('an unblocked candidate always outranks a blocked one, whatever the quality order says', () => {
  // content order puts ollama first; ollama is full, so openrouter must win.
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['openrouter/m3', 'ollama/flash'],
    ledger: [ledgerEntry('openrouter', { slotsFree: 4 }), ledgerEntry('ollama', { slotsFree: 0 })],
    latency: {},
    title: 'Write a blog post',
  });
  assert.equal(decision.recommended?.provider, 'openrouter');
});

test('between two open candidates the quality order for the task kind decides', () => {
  const ledger = [ledgerEntry('openrouter', { slotsFree: 4 }), ledgerEntry('ollama', { slotsFree: 4 })];
  const code = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash', 'openrouter/m3'],
    ledger,
    latency: {},
    title: 'Fix the API deploy script bug',
  });
  assert.equal(code.recommended?.provider, 'openrouter', 'code work prefers openrouter');
  const content = scoreRoute({
    agent: AGENT,
    candidateModels: ['openrouter/m3', 'ollama/flash'],
    ledger,
    latency: {},
    title: 'Draft the weekly newsletter',
  });
  assert.equal(content.recommended?.provider, 'ollama', 'content work prefers the subscription');
});

test('the quality order is overridable per box', () => {
  const key = 'ROUTE_QUALITY_CONTENT';
  const prior = process.env[key];
  process.env[key] = 'deepseek,ollama';
  try {
    assert.deepEqual([...qualityOrder('content')], ['deepseek', 'ollama']);
  } finally {
    if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
  }
});

test('task kinds are classified from the title and department', () => {
  assert.equal(taskKind('Refactor the ingest API', null), 'code');
  assert.equal(taskKind('Competitor research for Q4', null), 'research');
  assert.equal(taskKind('Clear the invoice inbox', null), 'ops');
  assert.equal(taskKind('Write a landing page', null), 'content');
  assert.equal(taskKind(null, null), 'content', 'an unclassifiable card still gets a tie-breaker');
});

// ── E. askWorthy is only a REAL decision point ─────────────────────────────

test('a running primary is never ask-worthy, however good an alternate looks', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash', 'openrouter/m3'],
    ledger: [ledgerEntry('ollama', { slotsFree: 3 }), ledgerEntry('openrouter', { slotsFree: 20 })],
    latency: {},
  });
  assert.equal(decision.askWorthy, false);
  assert.match(decision.reason, /^Running on Ollama Cloud/);
});

test('every model blocked is reported as exactly that, with each reason', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash', 'openrouter/m3'],
    ledger: [ledgerEntry('ollama', { slotsFree: 0 }), ledgerEntry('openrouter', { slotsFree: 0 })],
    latency: {},
  });
  assert.equal(decision.allBlocked, true);
  assert.equal(decision.overflowTo, null);
  assert.equal(decision.askWorthy, true, 'the card cannot run at all — the gate decides whether to ask');
  assert.match(decision.reason, /Every other model this agent declares is blocked too/);
});

test('the queued reason names the model the run will actually overflow onto', () => {
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash', 'openrouter/minimax/minimax-m3'],
    ledger: [ledgerEntry('ollama', { slotsFree: 0 }), ledgerEntry('openrouter', { slotsFree: 12 })],
    latency: {},
  });
  assert.match(decision.reason, /openrouter\/minimax\/minimax-m3/);
  assert.match(decision.reason, /next model this agent declares/);
});

test('the overflow target follows CONFIG order, not the quality order', () => {
  // content quality order prefers ollama; config order puts deepseek second.
  // The run will land on deepseek because that is what the runtime walks to.
  const decision = scoreRoute({
    agent: AGENT,
    candidateModels: ['openrouter/m3', 'deepseek/flash', 'ollama/flash'],
    ledger: [
      ledgerEntry('openrouter', { slotsFree: 0 }),
      ledgerEntry('deepseek', { slotsFree: 7 }),
      ledgerEntry('ollama', { slotsFree: 3 }),
    ],
    latency: {},
    title: 'Draft the weekly newsletter',
  });
  assert.equal(decision.recommended?.provider, 'ollama', 'best FIT for content work');
  assert.equal(decision.overflowTo?.provider, 'deepseek', 'but the run goes where the runtime fails over');
  assert.match(decision.reason, /deepseek\/flash/);
});

test('the reason says whether the overflow costs more per million tokens', () => {
  const dearer = scoreRoute({
    agent: AGENT,
    candidateModels: ['ollama/flash', 'openrouter/m3'],
    ledger: [
      ledgerEntry('ollama', { slotsFree: 0, pricePerMTokIn: 0 }),
      ledgerEntry('openrouter', { slotsFree: 9, pricePerMTokIn: 0.3 }),
    ],
    latency: {},
  });
  assert.match(dearer.reason, /dearer per million tokens/);
  const notDearer = scoreRoute({
    agent: AGENT,
    candidateModels: ['openrouter/m3', 'ollama/flash'],
    ledger: [
      ledgerEntry('openrouter', { slotsFree: 0, pricePerMTokIn: 0.3 }),
      ledgerEntry('ollama', { slotsFree: 9, pricePerMTokIn: 0 }),
    ],
    latency: {},
  });
  assert.match(notDearer.reason, /no dearer per million tokens/);
});

// ── F. Measured latency comes from this box's own completed runs ───────────

test('the median latency is measured, and a provider with no completed run has none', () => {
  const db = getDb();
  db.exec("DELETE FROM task_executions WHERE id LIKE 'scorer-exec-%'");
  db.exec("DELETE FROM tasks WHERE id = 'scorer-task-1'");
  const agent = db.prepare('SELECT id FROM agents LIMIT 1').get() as { id: string };
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  assert.ok(agent && workspace, 'the fixture seeds agents and workspaces');
  db.prepare('INSERT INTO tasks (id,title,workspace_id) VALUES (?,?,?)').run(
    'scorer-task-1',
    'scorer latency fixture',
    workspace.id,
  );

  // Three completed ollama runs: 10s, 20s, 60s → median 20s.
  const start = Date.parse('2026-09-21T12:00:00.000Z');
  const insert = db.prepare(
    `INSERT INTO task_executions
      (id,task_id,assignment_version,agent_id,workspace_id,generation,worker_context,session_key,session_id,
       state,lease_owner,lease_expires_at,idempotency_key,provider,created_at,updated_at)
     VALUES (?,?,0,?,NULL,?,'[]',?,?,'succeeded','o','x',?,?,?,?)`,
  );
  [10_000, 20_000, 60_000].forEach((ms, i) => {
    insert.run(
      `scorer-exec-${i}`,
      'scorer-task-1',
      agent.id,
      800 + i,
      `scorer-sk-${i}`,
      `scorer-sid-${i}`,
      `scorer-idem-${i}`,
      'ollama',
      new Date(start).toISOString(),
      new Date(start + ms).toISOString(),
    );
  });

  const medians = medianLatencyByProvider();
  assert.ok(Math.abs(medians.ollama - 20_000) < 50, `expected ~20000ms, got ${medians.ollama}`);
  assert.equal(medians.openrouter, undefined, 'a provider with no completed run has no median, not a default');

  db.exec("DELETE FROM task_executions WHERE id LIKE 'scorer-exec-%'");
  db.exec("DELETE FROM tasks WHERE id = 'scorer-task-1'");
});

// ── G. Writing the reason onto the card ────────────────────────────────────

test('the reason is written, is idempotent, and never overwrites a catch-all authorization', () => {
  const db = getDb();
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  db.exec("DELETE FROM tasks WHERE id IN ('scorer-task-2','scorer-task-3')");
  db.prepare('INSERT INTO tasks (id,title,workspace_id) VALUES (?,?,?)').run('scorer-task-2', 'reason', workspace.id);
  db.prepare('INSERT INTO tasks (id,title,workspace_id,routing_reason) VALUES (?,?,?,?)').run(
    'scorer-task-3',
    'catch all',
    workspace.id,
    '[catch-all] CEO executes this one',
  );

  recordRoutingReason('scorer-task-2', 'Queued: Ollama Cloud pool full.');
  assert.equal(
    (db.prepare('SELECT routing_reason r FROM tasks WHERE id=?').get('scorer-task-2') as { r: string }).r,
    'Queued: Ollama Cloud pool full.',
  );
  recordRoutingReason('scorer-task-2', 'Queued: Ollama Cloud pool full.'); // idempotent
  assert.equal(
    (db.prepare('SELECT routing_reason r FROM tasks WHERE id=?').get('scorer-task-2') as { r: string }).r,
    'Queued: Ollama Cloud pool full.',
  );

  // A '[catch-all]' reason is an assignment AUTHORIZATION that migration 133
  // deliberately preserves. Overwriting it with a capacity note revokes it.
  recordRoutingReason('scorer-task-3', 'Queued: Ollama Cloud pool full.');
  assert.match(
    (db.prepare('SELECT routing_reason r FROM tasks WHERE id=?').get('scorer-task-3') as { r: string }).r,
    /^\[catch-all\]/,
  );

  db.exec("DELETE FROM tasks WHERE id IN ('scorer-task-2','scorer-task-3')");
});

// ── H. The intake contract lands on the card ───────────────────────────────

test('migration 153 columns exist and a card without them is still a normal card', () => {
  const db = getDb();
  const columns = new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));
  for (const column of ['route_lane', 'effort_steps', 'depts_touched']) {
    assert.ok(columns.has(column), `migration 153 must add ${column}`);
  }
  assert.ok(columns.has('due_date'), 'the deadline rides the existing due_date column, not a second one');

  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  db.exec("DELETE FROM tasks WHERE id = 'scorer-task-4'");
  db.prepare('INSERT INTO tasks (id,title,workspace_id) VALUES (?,?,?)').run('scorer-task-4', 'plain', workspace.id);
  const row = db.prepare('SELECT route_lane, effort_steps, depts_touched FROM tasks WHERE id=?').get('scorer-task-4') as {
    route_lane: string | null;
    effort_steps: number | null;
    depts_touched: number | null;
  };
  assert.deepEqual(row, { route_lane: null, effort_steps: null, depts_touched: null });
  db.exec("DELETE FROM tasks WHERE id = 'scorer-task-4'");
});
