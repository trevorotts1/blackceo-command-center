/**
 * Ask-at-capacity: a rare question, with the numbers, that never strands work.
 *
 * MUST import _isolated-db FIRST so getDb() opens a throwaway file.
 *
 * Every send is a stub. The real sender resolves the owner's chat id from this
 * box's own config, and `notifyTelegram` is test-muted besides — but a test that
 * relied on that mute would be one config change away from messaging a real
 * person, so nothing here calls it at all.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '@/lib/db';
import {
  ASK_TIMEOUT_MS,
  applyProviderChoice,
  askExpired,
  askTriggers,
  buildQuestion,
  evaluateAskGate,
  holdForProviderChoice,
  latestAsk,
  recordRoutingCorrection,
  type AskGateDecision,
} from '@/lib/capacity/ask-at-capacity';
import type { RouteDecision, ScoredCandidate } from '@/lib/capacity/route-scorer';

function candidate(provider: string, over: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    modelId: `${provider}/model`,
    provider,
    canStartNow: true,
    slotsFree: 4,
    affordable: null,
    balance: null,
    medianLatencyMs: null,
    meetsDeadline: null,
    qualityRank: 0,
    pricePerMTokIn: null,
    coolingUntil: null,
    ...over,
  };
}

function decision(over: Partial<RouteDecision> = {}): RouteDecision {
  const preferred = over.preferred ?? candidate('ollama', { canStartNow: false, slotsFree: 0 });
  const candidates = over.candidates ?? [preferred];
  return {
    preferred,
    recommended: over.recommended ?? preferred,
    candidates,
    overflowTo: over.overflowTo ?? null,
    allBlocked: over.allBlocked ?? false,
    askWorthy: over.askWorthy ?? true,
    reason: over.reason ?? 'Queued.',
  };
}

/** A send stub that records what it was handed and never touches a network. */
function recorder() {
  const sent: { taskId: string; question: string }[] = [];
  return { sent, send: (taskId: string, question: string) => { sent.push({ taskId, question }); return 'telegram'; } };
}

function seedTask(id: string, title = 'A heavy card'): void {
  const db = getDb();
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  db.exec(`DELETE FROM provider_choice_asks WHERE task_id = '${id}'`);
  db.exec(`DELETE FROM tasks WHERE id = '${id}'`);
  db.prepare('INSERT INTO tasks (id,title,workspace_id) VALUES (?,?,?)').run(id, title, workspace.id);
}

function resetAsks(): void {
  getDb().exec('DELETE FROM provider_choice_asks');
}

// ── A. The bar for asking ───────────────────────────────────────────────────

test('a card whose preferred model can run is never asked about', () => {
  resetAsks();
  const gate = evaluateAskGate({
    taskId: 'ask-none-1',
    taskTitle: 'x',
    decision: decision({ askWorthy: false }),
  });
  assert.equal(gate.hold, false);
  assert.match(String(gate.skipped), /can serve this card/);
});

test('the ROUTE lane is never asked about — ordinary work routes silently', () => {
  resetAsks();
  const gate = evaluateAskGate({
    taskId: 'ask-none-2',
    taskTitle: 'x',
    routeLane: 'route',
    decision: decision({
      overflowTo: candidate('openrouter', { pricePerMTokIn: 10 }),
      preferred: candidate('ollama', { canStartNow: false, slotsFree: 0, pricePerMTokIn: 0 }),
    }),
  });
  assert.equal(gate.hold, false);
  assert.match(String(gate.skipped), /route lane/);
});

test('a card with NO lane recorded is still eligible — the triggers gate it', () => {
  resetAsks();
  seedTask('ask-lane-null');
  const gate = evaluateAskGate({
    taskId: 'ask-lane-null',
    taskTitle: 'x',
    routeLane: null,
    decision: decision({
      preferred: candidate('ollama', { canStartNow: false, slotsFree: 0, pricePerMTokIn: 0 }),
      overflowTo: candidate('openrouter', { pricePerMTokIn: 0.3 }),
      candidates: [candidate('ollama', { canStartNow: false, pricePerMTokIn: 0 }), candidate('openrouter', { pricePerMTokIn: 0.3 })],
    }),
  });
  assert.equal(gate.hold, true, 'a pre-intake card is not exempt');
});

test('a blocked card with nothing material at stake is queued in silence', () => {
  resetAsks();
  const gate = evaluateAskGate({
    taskId: 'ask-none-3',
    taskTitle: 'x',
    routeLane: 'heavy',
    // Blocked, but the overflow costs nothing more, takes no longer, no balance
    // is known low, no deadline, and something CAN run.
    decision: decision({
      preferred: candidate('ollama', { canStartNow: false, slotsFree: 0 }),
      overflowTo: candidate('openrouter'),
      candidates: [candidate('ollama', { canStartNow: false }), candidate('openrouter')],
    }),
  });
  assert.equal(gate.hold, false);
  assert.match(String(gate.skipped), /nothing material/);
});

// ── B. Each trigger, and the "both sides known" rule ────────────────────────

test('COST fires only when the overflow is materially dearer', () => {
  const preferred = candidate('ollama', { canStartNow: false, pricePerMTokIn: 1 });
  const dear = askTriggers(
    decision({ preferred, overflowTo: candidate('openrouter', { pricePerMTokIn: 2 }) }),
    null,
  );
  assert.ok(dear.some((t) => t.kind === 'cost'), '100% dearer must fire');
  const close = askTriggers(
    decision({ preferred, overflowTo: candidate('openrouter', { pricePerMTokIn: 1.1 }) }),
    null,
  );
  assert.ok(!close.some((t) => t.kind === 'cost'), '10% dearer is not worth an interruption');
});

test('COST does not fire when either price is unknown', () => {
  const triggers = askTriggers(
    decision({
      preferred: candidate('ollama', { canStartNow: false, pricePerMTokIn: null }),
      overflowTo: candidate('openrouter', { pricePerMTokIn: 9 }),
    }),
    null,
  );
  assert.ok(!triggers.some((t) => t.kind === 'cost'), 'a question whose numbers were guessed is not worth asking');
});

test('a free primary against a paid overflow fires COST', () => {
  // A subscription prices at 0. Any paid alternative is infinitely dearer in
  // relative terms, and that is exactly the case an owner wants to hear about.
  const triggers = askTriggers(
    decision({
      preferred: candidate('ollama', { canStartNow: false, pricePerMTokIn: 0 }),
      overflowTo: candidate('openrouter', { pricePerMTokIn: 0.3 }),
    }),
    null,
  );
  assert.ok(triggers.some((t) => t.kind === 'cost'));
});

test('TIME fires only on two MEASURED medians far enough apart', () => {
  const preferred = candidate('ollama', { canStartNow: false, medianLatencyMs: 60_000 });
  const slow = askTriggers(
    decision({ preferred, overflowTo: candidate('openrouter', { medianLatencyMs: 60_000 + 40 * 60_000 }) }),
    null,
  );
  assert.ok(slow.some((t) => t.kind === 'time'));
  const close = askTriggers(
    decision({ preferred, overflowTo: candidate('openrouter', { medianLatencyMs: 120_000 }) }),
    null,
  );
  assert.ok(!close.some((t) => t.kind === 'time'));
  const unmeasured = askTriggers(
    decision({ preferred, overflowTo: candidate('openrouter', { medianLatencyMs: null }) }),
    null,
  );
  assert.ok(!unmeasured.some((t) => t.kind === 'time'), 'an unmeasured provider produces no time trigger');
});

test('BALANCE fires on a known-low balance anywhere in the chain, and names the number', () => {
  const triggers = askTriggers(
    decision({
      preferred: candidate('ollama', { canStartNow: false }),
      candidates: [candidate('ollama', { canStartNow: false }), candidate('deepseek', { affordable: false, balance: 0.4 })],
    }),
    null,
  );
  const balance = triggers.find((t) => t.kind === 'balance');
  assert.ok(balance, 'a chain entry out of money is always worth saying');
  assert.match(balance.detail, /0\.4/);
});

test('DEADLINE fires when the preferred provider cannot make it', () => {
  const triggers = askTriggers(
    decision({ preferred: candidate('ollama', { canStartNow: false, meetsDeadline: false }) }),
    null,
  );
  assert.ok(triggers.some((t) => t.kind === 'deadline'));
});

test('NOTHING AVAILABLE fires when no declared model can run', () => {
  const triggers = askTriggers(decision({ allBlocked: true }), null);
  assert.ok(triggers.some((t) => t.kind === 'nothing_available'));
});

test('an always-ask department fires on its own, with nothing else at stake', () => {
  const key = 'ASK_ALWAYS_DEPARTMENTS';
  const prior = process.env[key];
  process.env[key] = 'legal,finance';
  try {
    assert.ok(askTriggers(decision({}), 'finance').some((t) => t.kind === 'always_ask'));
    assert.equal(askTriggers(decision({}), 'marketing').length, 0);
  } finally {
    if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
  }
});

// ── C. The question ─────────────────────────────────────────────────────────

test('the question names the card, the alternative, the reason and both answers', () => {
  const d = decision({
    preferred: candidate('ollama', { canStartNow: false, pricePerMTokIn: 0 }),
    overflowTo: candidate('openrouter', { pricePerMTokIn: 0.3 }),
  });
  const { question, recommendation } = buildQuestion('Rewrite the pricing page', d, askTriggers(d, null));
  assert.match(question, /Rewrite the pricing page/);
  assert.match(question, /Ollama Cloud/);
  assert.match(question, /OpenRouter/);
  assert.match(question, /GO/);
  assert.match(question, /WAIT/);
  assert.match(question, /minutes/, 'the owner must be told what silence means');
  assert.match(recommendation, /OpenRouter/);
});

test('with nothing to overflow onto the question offers to keep queueing, not to switch', () => {
  const d = decision({ allBlocked: true, overflowTo: null });
  const { question, recommendation } = buildQuestion('Big build', d, askTriggers(d, null));
  assert.match(question, /cannot start/);
  assert.match(recommendation, /waiting for a slot/);
});

// ── D. Budget and batching ──────────────────────────────────────────────────

test('past the hourly budget a card joins the open ask instead of sending again', () => {
  resetAsks();
  const now = Date.parse('2026-09-21T12:00:00.000Z');
  const rec = recorder();
  const d = decision({
    preferred: candidate('ollama', { canStartNow: false, pricePerMTokIn: 0 }),
    overflowTo: candidate('openrouter', { pricePerMTokIn: 0.3 }),
    candidates: [candidate('ollama', { canStartNow: false, pricePerMTokIn: 0 }), candidate('openrouter', { pricePerMTokIn: 0.3 })],
  });

  // Five cards, budget of four: four messages, five ask rows, one batch on the
  // fifth. No card is dropped for being the fifth.
  for (let i = 0; i < 5; i++) {
    const id = `ask-budget-${i}`;
    seedTask(id);
    const gate = evaluateAskGate({ taskId: id, taskTitle: `card ${i}`, routeLane: 'heavy', decision: d, nowMs: now });
    assert.equal(gate.hold, true, `card ${i} must be held`);
    holdForProviderChoice(id, gate, rec.send, now);
  }
  assert.equal(rec.sent.length, 4, 'the cap is on MESSAGES');
  const rows = getDb().prepare('SELECT delivered, batch_id FROM provider_choice_asks').all() as {
    delivered: string;
    batch_id: string;
  }[];
  assert.equal(rows.length, 5, 'every card is recorded');
  assert.equal(rows.filter((r) => r.delivered === 'batched').length, 1);
  const batched = rows.find((r) => r.delivered === 'batched');
  const sentBatches = new Set(rows.filter((r) => r.delivered !== 'batched').map((r) => r.batch_id));
  assert.ok(sentBatches.has(batched.batch_id), 'a batched card attaches to a question that was actually sent');
});

test('one answer clears every card batched behind the same question', () => {
  resetAsks();
  const now = Date.parse('2026-09-21T12:00:00.000Z');
  const rec = recorder();
  const d = decision({
    preferred: candidate('ollama', { canStartNow: false, pricePerMTokIn: 0 }),
    overflowTo: candidate('openrouter', { pricePerMTokIn: 0.3 }),
  });
  for (let i = 0; i < 5; i++) {
    const id = `ask-batch-${i}`;
    seedTask(id);
    holdForProviderChoice(id, evaluateAskGate({ taskId: id, taskTitle: `c${i}`, routeLane: 'heavy', decision: d, nowMs: now }), rec.send, now);
  }
  const batchedRow = getDb()
    .prepare("SELECT task_id, batch_id FROM provider_choice_asks WHERE delivered = 'batched'")
    .get() as { task_id: string; batch_id: string };
  const sibling = getDb()
    .prepare("SELECT task_id FROM provider_choice_asks WHERE batch_id = ? AND delivered <> 'batched'")
    .get(batchedRow.batch_id) as { task_id: string };

  const applied = applyProviderChoice(sibling.task_id, 'overflow_ok', now);
  assert.ok(applied.includes(batchedRow.task_id), 'the batched card must be released by the one answer');
  const stillOpen = getDb()
    .prepare('SELECT COUNT(*) n FROM provider_choice_asks WHERE batch_id = ? AND answered_at IS NULL')
    .get(batchedRow.batch_id) as { n: number };
  assert.equal(stillOpen.n, 0);
});

// ── E. Holding, timing out, and answering ──────────────────────────────────

test('a hold DEFERS the card rather than blocking it', () => {
  resetAsks();
  seedTask('ask-hold-1');
  const now = Date.parse('2026-09-21T12:00:00.000Z');
  const rec = recorder();
  const gate: AskGateDecision = {
    hold: true,
    triggers: [{ kind: 'cost', detail: 'dearer' }],
    question: 'GO or WAIT?',
    recommendation: 'run it on OpenRouter now',
    batched: false,
    skipped: null,
  };
  holdForProviderChoice('ask-hold-1', gate, rec.send, now);
  const row = getDb()
    .prepare('SELECT next_dispatch_eligible_at, dispatch_hold FROM tasks WHERE id=?')
    .get('ask-hold-1') as { next_dispatch_eligible_at: string; dispatch_hold: number };
  assert.equal(row.dispatch_hold, 0, 'a question is a deferral, never a block');
  assert.equal(row.next_dispatch_eligible_at, new Date(now + ASK_TIMEOUT_MS).toISOString());
  assert.equal(rec.sent.length, 1);
});

test('an unanswered ask holds inside the window and expires after it', () => {
  resetAsks();
  seedTask('ask-timeout-1');
  const asked = Date.parse('2026-09-21T12:00:00.000Z');
  const rec = recorder();
  const d = decision({
    preferred: candidate('ollama', { canStartNow: false, pricePerMTokIn: 0 }),
    overflowTo: candidate('openrouter', { pricePerMTokIn: 0.3 }),
  });
  holdForProviderChoice('ask-timeout-1', evaluateAskGate({ taskId: 'ask-timeout-1', taskTitle: 't', routeLane: 'heavy', decision: d, nowMs: asked }), rec.send, asked);

  const inside = evaluateAskGate({ taskId: 'ask-timeout-1', taskTitle: 't', routeLane: 'heavy', decision: d, nowMs: asked + 60_000 });
  assert.equal(inside.hold, true, 'still waiting for an answer');
  assert.equal(inside.batched, true, 'no second message for the same card');
  assert.equal(rec.sent.length, 1);

  const after = evaluateAskGate({ taskId: 'ask-timeout-1', taskTitle: 't', routeLane: 'heavy', decision: d, nowMs: asked + ASK_TIMEOUT_MS + 1 });
  assert.equal(after.hold, false, 'silence must never strand the work');
  assert.match(String(after.skipped), /timed out/);

  const ask = latestAsk('ask-timeout-1');
  assert.equal(askExpired(ask, asked + 60_000), false);
  assert.equal(askExpired(ask, asked + ASK_TIMEOUT_MS), true);
});

test('overflow_ok releases the card; primary_only keeps it waiting and is remembered', () => {
  resetAsks();
  const db = getDb();
  seedTask('ask-answer-1');
  seedTask('ask-answer-2');
  const now = Date.parse('2026-09-21T12:00:00.000Z');

  applyProviderChoice('ask-answer-1', 'overflow_ok', now);
  const go = db.prepare('SELECT provider_choice, next_dispatch_eligible_at FROM tasks WHERE id=?').get('ask-answer-1') as {
    provider_choice: string;
    next_dispatch_eligible_at: string | null;
  };
  assert.equal(go.provider_choice, 'overflow_ok');
  assert.equal(go.next_dispatch_eligible_at, null, 'GO must release the card immediately');

  applyProviderChoice('ask-answer-2', 'primary_only', now);
  const wait = db.prepare('SELECT provider_choice, next_dispatch_eligible_at FROM tasks WHERE id=?').get('ask-answer-2') as {
    provider_choice: string;
    next_dispatch_eligible_at: string | null;
  };
  assert.equal(wait.provider_choice, 'primary_only');
  assert.ok(wait.next_dispatch_eligible_at, 'WAIT keeps the card deferred');
});

test('an answered card is never asked again', () => {
  resetAsks();
  seedTask('ask-once-1');
  const gate = evaluateAskGate({
    taskId: 'ask-once-1',
    taskTitle: 't',
    routeLane: 'heavy',
    existingChoice: 'overflow_ok',
    decision: decision({ allBlocked: true }),
  });
  assert.equal(gate.hold, false);
  assert.match(String(gate.skipped), /already answered/);
});

// ── F. Lane corrections ─────────────────────────────────────────────────────

test('a correction records with a task, and also without one', () => {
  const db = getDb();
  db.exec('DELETE FROM routing_corrections');
  seedTask('ask-corr-1');
  assert.equal(recordRoutingCorrection({ taskId: 'ask-corr-1', fromLane: 'route', toLane: 'answer' }), true);
  // "route that" concerns a message that never became a card — refusing it
  // would lose half the signal the intake needs.
  assert.equal(recordRoutingCorrection({ taskId: null, fromLane: 'answer', toLane: 'route', note: 'owner said route that' }), true);
  const rows = db.prepare('SELECT task_id, from_lane, to_lane FROM routing_corrections ORDER BY created_at').all() as {
    task_id: string | null;
    from_lane: string;
    to_lane: string;
  }[];
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.task_id === null)?.to_lane, 'route');
});

test('migration 156 shipped the tables and the remembered answer', () => {
  const db = getDb();
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name),
  );
  assert.ok(tables.has('provider_choice_asks'));
  assert.ok(tables.has('routing_corrections'));
  const columns = new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));
  assert.ok(columns.has('provider_choice'));
});
