/**
 * pd063-stale-sweep-budget.test.ts — PD-TEST-063.
 *
 * THE DEFECT: the Command Center's own stale-task-sweep silently RE-OPENED a
 * dispatch budget that other protections exist to preserve.
 *
 * `returnToOrchestrator()` (SWEEP-03) zeroed `dispatch_attempts` on every
 * blocked→backlog return "to escape the drag-back trap". Proven live on task
 * 1d269693-ff54-4b1f-b45a-61dc7d8ca4d4:
 *   • 6e1ffc5c 00:47:03Z  backlog→blocked  "[dispatch-blocked] … after 8 failed"
 *   • d3d7f3ce 06:50:00Z  blocked→backlog  actor 'stale-task-sweep' (6h window)
 *   • 22b564a8 06:52:00Z  backlog→blocked  re-dispatched TWO MINUTES LATER
 * The sweep destroyed the record of 8 consumed attempts and handed the card a
 * brand-new budget, so the exhausted card was dispatchable again.
 *
 * That reset contradicted the codebase's own documented contract three times over:
 *   • U061 ticket, src/app/api/tasks/[id]/resume/route.ts:15-17 — "A Resume that
 *     resets dispatch_attempts to 0 would turn a capped retry loop into an
 *     unbounded one." A HUMAN Resume preserves; a watchdog has less authority.
 *   • src/lib/task-dispatcher.ts:304-308 recordDispatchSuccess({preserveAttempts})
 *     — the exhausted budget is kept "so a later ordinary backlog sweep cannot
 *     turn this exception into a fresh budget". That comment names THIS sweep.
 *   • FIX 41 in this very file — the sweep already stopped writing
 *     qc_reroute_attempts because "the stale sweep is a WATCHDOG, not a QC
 *     attempt". The dispatch_attempts reset was the un-migrated other half.
 * And the skill's documented contract (skills/stale-task-sweeper/SKILL.md) grants
 * only `action: re-route | escalate | auto-resolve` plus a diagnostic `reason` —
 * no authority to mint retry budget.
 *
 * THE REPAIR (see src/lib/jobs/stale-task-sweep.ts):
 *   1. returnToOrchestrator no longer writes dispatch_attempts at all — the
 *      counter is READ-ONLY here, exactly like qc_reroute_attempts under FIX 41.
 *      It still clears the stale BACKOFF WINDOW (a time gate, not a budget).
 *   2. The blocked branch gains a dispatch-budget END-STATE guard, mirroring the
 *      existing FIX 41 QC-cap guard but read from the same MAX_DISPATCH_ATTEMPTS
 *      the dispatcher blocks at. An exhausted card is NOT returned to backlog
 *      (the return is the only writer that can launder the budget) and is NOT
 *      dropped silently (that would be the trap the other way) — it keeps
 *      escalating to the named human on the ordinary deduped window.
 * This is what makes the SWEEP-03 drag-back trap structurally unreachable
 * instead of "fixed" by a counter reset: an exhausted card never reaches the
 * return path, so the trap it was guarding against cannot occur.
 *
 *   3. Afterwards exactly TWO sites in the shipped tree may zero the counter, and
 *      the sweep is neither of them: task-dispatcher's recordDispatchSuccess (a
 *      genuine successful advance, non-preserve branch only) and the
 *      operator-invoked, --apply-gated scripts/remediate/unfreeze-sovereignty-blocks.ts.
 *      Pinned by the source-scan tests (d)/(d2)/(d3) below.
 *
 * The trap is real and must stay fixed in BOTH directions:
 *   (a) an exhausted card must NOT become re-dispatchable on a zeroed budget;
 *   (b) a genuinely stale card with remaining budget must STILL be triaged —
 *       returned to backlog, not left stuck;
 *   (c) the prior attempt count must survive in the audit trail;
 *   (d) existing sweep behaviour (2h re-ping band, dedup, non-blocked returns)
 *       must be unchanged.
 *
 *   node --import tsx --test tests/unit/pd063-stale-sweep-budget.test.ts
 */

// SAFETY: mute every outbound escalation channel BEFORE anything is imported.
// The owner re-ping path does a bare fetch() to getMissionControlUrl(), whose
// default is http://localhost:4000 — the LIVE Command Center. Without the
// override below a sweep in this suite could POST an event into live operator
// state. MISSION_CONTROL_URL is pointed at this suite's own 127.0.0.1 sink in
// before(), and RESCUE_RANGERS_WEBHOOK_URL (the operator rung) is deleted so
// notifySystem() has no live endpoint to reach even if it were called.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.DISABLE_STALE_TASK_SWEEP;
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
// Exercise the SHIPPED defaults: cap 5, re-ping 2h, return 6h, dedup 24h.
delete process.env.MAX_DISPATCH_ATTEMPTS;
delete process.env.STALE_BLOCKED_REPING_HOURS;
delete process.env.STALE_BLOCKED_REPINGED_HOURS;
delete process.env.STALE_REPING_DEDUP_HOURS;
delete process.env.STALE_IN_PROGRESS_HOURS;

import './_isolated-db'; // MUST be first: redirects DATABASE_PATH to a throwaway file.

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne, queryAll } from '../../src/lib/db';
import { runStaleTaskSweep } from '../../src/lib/jobs/stale-task-sweep';
import { MAX_DISPATCH_ATTEMPTS } from '../../src/lib/task-dispatcher';

const SHIPPED_CAP = 5;
/** Every task id this suite creates — the causal proof that nothing reached the live DB. */
const fixtureIds: string[] = [];

/** POSTs the sweep made to this suite's own Mission Control sink. */
let escalations: string[] = [];
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      escalations.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // Point EVERY Command Center URL at the local sink so no packet can reach the
  // live app on :4000 (the getMissionControlUrl() default).
  process.env.MISSION_CONTROL_URL = `http://127.0.0.1:${port}`;
});

after(async () => {
  delete process.env.MISSION_CONTROL_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  escalations = [];
  // ARCHIVE (never DELETE) every fixture an earlier test created, so this test's
  // sweep sees only its OWN candidates and the per-tick counters are unambiguous.
  // The sweep filters `archived_at IS NULL`, so this is the app's own semantics.
  // Earlier end-stated cards are deliberately still in the DB (and still counted
  // by the live-leak check) — they are simply out of this tick's candidate set.
  if (fixtureIds.length > 0) {
    const placeholders = fixtureIds.map(() => '?').join(',');
    run(`UPDATE tasks SET archived_at = ? WHERE id IN (${placeholders})`, [
      new Date().toISOString(),
      ...fixtureIds,
    ]);
  }
});

/**
 * The sweep's blocked→backlog return is deliberately FIRE-AND-FORGET
 * (`returnToOrchestrator(...).catch(...)` with no `await` — see the blocked
 * branch), so `await runStaleTaskSweep()` can resolve with that transition still
 * in flight. Give the pending write a beat before asserting on the resulting
 * row. The end-state guard path (test (a)) `continue`s before the call, so it is
 * race-free by construction.
 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60));
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function seedWorkspace(label: string): string {
  const id = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [
    id,
    label,
    `${label}-${uuidv4().slice(0, 8)}`,
  ]);
  return id;
}

/**
 * A BLOCKED card, exactly like the live one. `blocked_on_human: 'owner'` routes
 * the escalation through repingBlockedHuman()'s owner branch → the suite's sink.
 * A non-empty `ask` is required by the migration-104 invariant (blocked_on_human
 * set ⇒ ask non-blank); blocked_reason is CHECK-constrained.
 *
 * `nextEligibleInFuture` reproduces the SWEEP-03 "stale backoff window": the card
 * is blocked with a backoff timer still in the future.
 */
function seedBlockedTask(opts: {
  label: string;
  ageHours: number;
  dispatchAttempts: number;
  qcRerouteAttempts?: number;
  nextEligibleInFuture?: boolean;
}): string {
  const id = uuidv4();
  fixtureIds.push(id);
  const ws = seedWorkspace(opts.label);
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, blocked_on_human, blocked_reason, ask,
                        dispatch_attempts, qc_reroute_attempts, next_dispatch_eligible_at,
                        updated_at, last_progress_at)
     VALUES (?, ?, 'blocked', ?, 'owner', 'decision', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `${opts.label} ${id.slice(0, 8)}`,
      ws,
      'Operator must supply a fresh presentation contract (fixture)',
      opts.dispatchAttempts,
      opts.qcRerouteAttempts ?? 0,
      opts.nextEligibleInFuture ? new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() : null,
      hoursAgo(opts.ageHours),
      hoursAgo(opts.ageHours),
    ],
  );
  return id;
}

function seedStaleInProgress(label: string, ageHours: number): string {
  const id = uuidv4();
  fixtureIds.push(id);
  const ws = seedWorkspace(label);
  const agentId = uuidv4();
  run(
    'INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)',
    [agentId, 'Deck Designer', 'Department Head', ws, 'working'],
  );
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, assigned_agent_id, updated_at, last_progress_at)
     VALUES (?, ?, 'in_progress', ?, ?, ?, ?)`,
    [id, `${label} ${id.slice(0, 8)}`, ws, agentId, hoursAgo(ageHours), hoursAgo(ageHours)],
  );
  return id;
}

function taskRow(id: string) {
  return queryOne<{
    status: string;
    dispatch_attempts: number | null;
    next_dispatch_eligible_at: string | null;
    description: string | null;
  }>('SELECT status, dispatch_attempts, next_dispatch_eligible_at, description FROM tasks WHERE id = ?', [id]);
}

/** The blocked→backlog transitions THIS sweep authored — the exact live defect row. */
function sweepReturnEvents(id: string) {
  return queryAll<{ from_status: string; to_status: string; actor: string; reason: string }>(
    `SELECT from_status, to_status, actor, reason FROM task_events
      WHERE task_id = ? AND actor = 'stale-task-sweep' AND from_status = 'blocked' AND to_status = 'backlog'`,
    [id],
  );
}

/** Every task_events reason for a card, joined — used to prove the audit trail survives. */
function allReasons(id: string): string {
  return queryAll<{ reason: string | null }>('SELECT reason FROM task_events WHERE task_id = ?', [id])
    .map((r) => r.reason ?? '')
    .join('\n');
}

/**
 * The gate every advancer applies (intake-advance-sweep.ts:319,
 * backlog-redispatch-sweep.ts:262). Reproduced here so "is it re-dispatchable?"
 * is answered by the SAME predicate the dispatch conveyor uses, not a proxy.
 */
function isDispatchableByAdvancers(id: string): boolean {
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks
      WHERE id = ?
        AND status IN ('backlog','todo','inbox')
        AND archived_at IS NULL
        AND (dispatch_attempts IS NULL OR dispatch_attempts < ?)`,
    [id, MAX_DISPATCH_ATTEMPTS],
  );
  return (row?.n ?? 0) > 0;
}

async function settle(expected: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (escalations.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 120));
}

/** Escalations that actually left the process FOR THIS TASK (bodies carry the id). */
function escalationsFor(taskId: string): number {
  return escalations.filter((body) => body.includes(taskId)).length;
}

// ── ISOLATION ───────────────────────────────────────────────────────────────────
// FAIL-CLOSED. A sibling lane already caused an incident by letting a test suite
// write live operator state; this suite refuses to run against anything but a
// throwaway file, and names the live path so a regression is loud, not silent.
/**
 * Canonicalise a path so a symlinked temp root cannot disguise a location.
 * macOS is the reason this exists: `os.tmpdir()` is `/var/folders/.../T` (really
 * `/private/var/folders/...`) while a runner commonly hands us `/tmp` (really
 * `/private/tmp`). Comparing raw strings across those two roots rejects a
 * CORRECTLY isolated run on a path technicality — which is exactly what the
 * first draft of this assertion did.
 *
 * Resolves the deepest EXISTING ancestor and re-appends the remainder, because
 * the DB file itself need not exist yet at assertion time (it is created on the
 * first getDb()).
 */
function realOrResolved(p: string): string {
  const abs = path.resolve(p);
  let dir = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(dir);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs; // nothing resolvable — fall back unchanged
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

test('ISOLATION: this suite runs against a throwaway DB, never the live operator DB', () => {
  const raw = process.env.DATABASE_PATH;
  assert.ok(raw, 'DATABASE_PATH must be set for this suite (see tests/unit/_isolated-db.ts)');

  // Compare REAL paths: a symlink pointing at the live DB must not slip through.
  const dbPath = realOrResolved(raw);
  const livePath = realOrResolved(path.join(os.homedir(), 'data', 'mission-control.db'));

  assert.notEqual(
    dbPath,
    livePath,
    'refusing to run: DATABASE_PATH points at the LIVE Command Center DB',
  );
  assert.ok(
    !dbPath.endsWith(`${path.sep}data${path.sep}mission-control.db`),
    `refusing to run: DATABASE_PATH looks like a live CC DB (${dbPath})`,
  );

  // Must live under a REAL temp root (both sides canonicalised, see above).
  const tempRoots = [os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'].map(realOrResolved);
  const underTemp = tempRoots.some((root) => dbPath === root || dbPath.startsWith(root + path.sep));
  assert.ok(
    underTemp || path.basename(dbPath).includes('cc-isolated-'),
    `DATABASE_PATH must be a temp file, got ${dbPath} ` +
      `(raw ${raw}, exists=${fs.existsSync(path.resolve(raw))}, temp roots: ${tempRoots.join(', ')})`,
  );
});

// ── (a) THE REGRESSION ──────────────────────────────────────────────────────────
// This is the acceptance criterion for PD-TEST-063. It FAILS on pre-fix code:
// the sweep returned the card to backlog with dispatch_attempts = 0, making it
// re-dispatchable — exactly the live 06:50Z → 06:52Z sequence.
test('(a) exhausted blocked card swept as stale does NOT get a zeroed budget and does NOT become re-dispatchable', async () => {
  // Mirrors the live row: 8 consumed attempts, blocked, stale past the 6h window.
  const id = seedBlockedTask({ label: 'exhausted', ageHours: 8, dispatchAttempts: 8 });
  assert.equal(isDispatchableByAdvancers(id), false, 'precondition: a blocked card is not advancer-dispatchable');

  const result = await runStaleTaskSweep();

  const row = taskRow(id);
  // THE DEFECT, asserted directly: pre-fix this read 'backlog' / 0.
  assert.equal(row?.status, 'blocked', 'an exhausted card must NOT be returned to backlog');
  assert.equal(
    row?.dispatch_attempts,
    8,
    'the consumed budget MUST NOT be zeroed — pre-fix this was 0 (the live defect)',
  );
  assert.ok(
    (row?.dispatch_attempts ?? 0) >= MAX_DISPATCH_ATTEMPTS,
    'the card is still over the cap the dispatcher blocks at',
  );
  assert.equal(
    isDispatchableByAdvancers(id),
    false,
    'the card must NOT be re-dispatchable: it is not in an advanceable column and its budget is exhausted',
  );

  // The exact live audit row (blocked→backlog by stale-task-sweep) must not exist.
  assert.deepEqual(
    sweepReturnEvents(id),
    [],
    'the sweep authored NO blocked→backlog transition — this is the event (d3d7f3ce) that laundered the budget',
  );

  // And the end-state decision is reported, not silent.
  assert.equal(result.budgetEndStated, 1, 'the end-state decision is counted');
  assert.deepEqual(result.budgetEndStatedIds, [id]);

  // NOT left silently stuck either: the card still reaches its named human.
  await settle(1);
  assert.equal(escalationsFor(id), 1, 'an end-stated card is re-escalated, never dropped without a word');
});

// ── (a2) "NOT re-dispatchable" at the cap boundary, keyed on the shared constant ─
test('(a2) the guard keys on the SAME cap the dispatcher blocks at — cap-1 is returned, cap is end-stated', async () => {
  assert.equal(
    MAX_DISPATCH_ATTEMPTS,
    SHIPPED_CAP,
    'sanity: the shipped default cap the dispatcher exports and blocks at',
  );

  const belowCap = seedBlockedTask({ label: 'below-cap', ageHours: 8, dispatchAttempts: SHIPPED_CAP - 1 });
  const atCap = seedBlockedTask({ label: 'at-cap', ageHours: 8, dispatchAttempts: SHIPPED_CAP });

  const result = await runStaleTaskSweep();

  assert.equal(
    taskRow(belowCap)?.status,
    'backlog',
    'one attempt of budget left ⇒ the card is genuinely stale, not end-stated ⇒ still triaged back to backlog',
  );
  assert.equal(taskRow(atCap)?.status, 'blocked', 'at the cap the dispatcher blocks at ⇒ end-stated, kept blocked');
  assert.equal(result.budgetEndStated, 1, 'only the at-cap card is end-stated');
  assert.deepEqual(result.budgetEndStatedIds, [atCap]);
});

// ── (b) A GENUINELY STALE CARD IS STILL TRIAGED, NOT TRAPPED ────────────────────
test('(b) a genuinely stale blocked card with remaining budget is STILL returned to backlog (the sweep still sweeps)', async () => {
  const id = seedBlockedTask({ label: 'genuine', ageHours: 9, dispatchAttempts: 2 });

  const result = await runStaleTaskSweep();
  await flush(); // the return is fire-and-forget

  const row = taskRow(id);
  assert.equal(row?.status, 'backlog', 'the sweep still re-routes a stale card — its purpose is intact');
  assert.equal(result.returned, 1);
  assert.equal(result.budgetEndStated, 0, 'an un-exhausted card is not end-stated');
  assert.ok(
    sweepReturnEvents(id).length === 1,
    'and it is still the ordinary audited blocked→backlog return',
  );
});

test('(b2) the SWEEP-03 drag-back trap stays fixed: the stale backoff window is cleared', async () => {
  // A card blocked with a backoff timer still in the FUTURE — pre-SWEEP-03 this
  // was the "rot in backlog" state. The window must still be cleared so the card
  // is immediately re-eligible; only the BUDGET is out of the sweep's hands.
  const id = seedBlockedTask({ label: 'backoff', ageHours: 7, dispatchAttempts: 3, nextEligibleInFuture: true });
  assert.ok(taskRow(id)?.next_dispatch_eligible_at, 'precondition: a live backoff window is set');

  await runStaleTaskSweep();
  await flush(); // the return is fire-and-forget

  assert.equal(taskRow(id)?.status, 'backlog');
  assert.equal(
    taskRow(id)?.next_dispatch_eligible_at,
    null,
    'the stale BACKOFF WINDOW is still cleared (a time gate) so the re-routed card is not held behind an expired timer',
  );
  assert.equal(taskRow(id)?.dispatch_attempts, 3, 'while the BUDGET (a count) is untouched');
});

test('(b3) an end-stated card is NOT trapped silently — it keeps escalating every window', async () => {
  const id = seedBlockedTask({ label: 'endstate-antisilence', ageHours: 8, dispatchAttempts: 6 });

  await runStaleTaskSweep();
  await settle(1);
  assert.equal(escalationsFor(id), 1, 'window 1: the end-stated card reaches a human');

  // Still within the dedup window ⇒ capped, not repeated.
  await runStaleTaskSweep();
  await settle(1);
  assert.equal(escalationsFor(id), 1, 'within the window the re-ping is still deduped');

  // Window passes and the card is STILL blocked with no human ⇒ escalate again.
  run('UPDATE events SET created_at = ? WHERE task_id = ?', [hoursAgo(25), id]);
  await runStaleTaskSweep();
  await settle(2);
  assert.equal(
    escalationsFor(id),
    2,
    'window 2: still stuck ⇒ escalates again. End-stating CAPS the budget, it never MUTES the human',
  );
});

// ── (c) THE AUDIT TRAIL PRESERVES THE PRIOR ATTEMPT COUNT ───────────────────────
test('(c) the consumed attempt count survives on the row, in the card note, and in task_events', async () => {
  const id = seedBlockedTask({ label: 'audit', ageHours: 9, dispatchAttempts: 4, qcRerouteAttempts: 2 });

  await runStaleTaskSweep();
  await flush(); // the return is fire-and-forget

  // 1. The COLUMN survives — a re-opened card cannot masquerade as brand new.
  assert.equal(taskRow(id)?.dispatch_attempts, 4, 'the counter is preserved on the row itself');

  // 2. The HAND-BACK NOTE shows the budget it already burned.
  assert.match(
    taskRow(id)?.description ?? '',
    /dispatch_attempts=4\/5 PRESERVED/,
    'the note handed to the orchestrator states the preserved budget',
  );
  assert.match(taskRow(id)?.description ?? '', /qc_reroute_attempts=2/, 'and the QC-reroute counter (FIX 41)');

  // 3. The AUDIT ROW records it, so the ledger alone tells the story.
  const reasons = allReasons(id);
  assert.match(
    reasons,
    /dispatch_attempts=4\/5 PRESERVED/,
    'the task_events reason carries the preserved count — the audit trail is self-describing',
  );

  // 4. And the sweep authored no counter-mutating write at all.
  const events = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'task_returned'`,
    [id],
  );
  assert.ok(events.length >= 1, 'the return is still announced on the event feed');
  assert.match(events[0].message, /dispatch_attempts=4\/5 PRESERVED/, 'the feed row carries it too');
});

test('(c2) the sweep never DECREASES a dispatch budget on any path it drives', async () => {
  // A spread of stale cards across every branch the sweep can take.
  const blockedRemaining = seedBlockedTask({ label: 'c2-blocked', ageHours: 9, dispatchAttempts: 3 });
  const blockedExhausted = seedBlockedTask({ label: 'c2-exhausted', ageHours: 9, dispatchAttempts: 9 });
  const blockedRepingBand = seedBlockedTask({ label: 'c2-reping', ageHours: 3, dispatchAttempts: 4 });
  const inProgressStale = seedStaleInProgress('c2-inprogress', 30);

  const before = new Map(
    [blockedRemaining, blockedExhausted, blockedRepingBand, inProgressStale].map((id) => [
      id,
      taskRow(id)?.dispatch_attempts,
    ]),
  );

  await runStaleTaskSweep();
  await flush(); // the returns are fire-and-forget

  for (const [id, prior] of before) {
    const now = taskRow(id)?.dispatch_attempts;
    assert.ok(
      (now ?? 0) >= (prior ?? 0),
      `task ${id}: dispatch_attempts went ${prior} → ${now} — the sweep must NEVER reduce a consumed budget`,
    );
  }
  // Spot-check that these branches really did run (not a vacuous pass).
  assert.equal(taskRow(blockedRemaining)?.status, 'backlog', 'from-blocked return path exercised');
  assert.equal(taskRow(blockedExhausted)?.status, 'blocked', 'end-state guard path exercised');
  assert.equal(taskRow(inProgressStale)?.status, 'backlog', 'non-blocked return path exercised');
});

// ── (e) EXISTING BEHAVIOUR IS UNCHANGED ─────────────────────────────────────────
test('(e) the ordinary 2h re-ping band still re-pings once per window (SWEEP-DEDUP intact)', async () => {
  const id = seedBlockedTask({ label: 'd-reping', ageHours: 4, dispatchAttempts: 1 });

  await runStaleTaskSweep();
  await settle(1);
  assert.equal(escalationsFor(id), 1, 'the first tick re-pings a card in the 2h..6h band');
  assert.equal(taskRow(id)?.status, 'blocked', 'a re-ping band card is not returned yet');

  await runStaleTaskSweep();
  await settle(1);
  assert.equal(escalationsFor(id), 1, 'the next tick is deduped to zero');
});

test('(e) a stale non-blocked card still returns to backlog with an untouched budget', async () => {
  const id = seedStaleInProgress('d-inprogress', 30);

  const result = await runStaleTaskSweep();
  await flush(); // the return is fire-and-forget

  assert.equal(taskRow(id)?.status, 'backlog', 'the in_progress stale return still works');
  assert.equal(result.returned, 1);
  assert.equal(result.budgetEndStated, 0);
});

test('(e) an exhausted card that is NOT yet stale is left completely alone', async () => {
  // Fresh + exhausted: no threshold reached, so the sweep must not touch it —
  // and in particular must not end-state or escalate it.
  const id = seedBlockedTask({ label: 'd-fresh', ageHours: 1, dispatchAttempts: 8 });

  const result = await runStaleTaskSweep();
  await settle(0);

  assert.equal(taskRow(id)?.status, 'blocked');
  assert.equal(taskRow(id)?.dispatch_attempts, 8, 'untouched');
  assert.equal(result.budgetEndStated, 0, 'the end-state guard only fires at the stale threshold');
  assert.equal(escalationsFor(id), 0, 'and nothing is escalated below the re-ping window');
});

// ── (d) SOURCE SCAN: only a SANCTIONED writer may zero the counter ──────────────
//
// PD-TEST-063 was a WRITE, not merely a behaviour: `extraCols.dispatch_attempts = 0`
// inside the sweep's blocked→backlog return. The behavioural tests above can only
// pin the paths they exercise — they cannot stop a NEW writer appearing in a file
// nobody thought to test. This scan is that guard. It walks the SHIPPED source and
// fails if anything zeroes the counter outside the sanctioned sites below.
//
// SANCTIONED #1 — src/lib/task-dispatcher.ts, recordDispatchSuccess():
//     The only zeroing writer on any automatic path, and it is reached only after
//     a GENUINE SUCCESSFUL ADVANCE (the task was actually handed to an agent, or a
//     signed operator contract was acknowledged). Its { preserveAttempts: true }
//     branch deliberately does NOT zero — that is the pre-engine recovery contract
//     ("so a later ordinary backlog sweep cannot turn this exception into a fresh
//     budget"). The structural assertions below pin the zeroing into the
//     NON-preserve branch specifically, so moving it is also a test failure.
//
// SANCTIONED #2 — scripts/remediate/unfreeze-sovereignty-blocks.ts:
//     An OPERATOR-INVOKED, dry-run-by-default, one-shot P1-01 rollout remediation.
//     This is the "a human grants fresh budget" escape hatch the design intends to
//     keep. It is not a background sweep, it cannot fire on its own, and it
//     requires an explicit --apply. (The crashed lane's claim that task-dispatcher
//     was the ONLY remaining zeroing writer MISSED this file; the allowlist below
//     names it rather than silently ignoring it.)
//
// ANYTHING ELSE — and in particular src/lib/jobs/stale-task-sweep.ts — fails.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['src', 'scripts'];
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'coverage', 'build', '.turbo']);

/**
 * A zeroing write, in either form this codebase uses:
 *   • `dispatch_attempts = 0|null`  — a SQL SET, or an `extraCols.dispatch_attempts = 0`
 *   • `dispatch_attempts: 0|null`   — an object literal handed to transition()
 * The trailing lookahead keeps `dispatch_attempts = ?` (the INCREMENT) and
 * `dispatch_attempts: t.dispatch_attempts` (a read/copy) from matching.
 */
const ZEROING_PATTERNS: RegExp[] = [
  /dispatch_attempts\s*=\s*(?:0|null|NULL)(?![\w.])/g,
  /dispatch_attempts\s*:\s*(?:0|null|NULL)(?![\w.])/g,
];

/**
 * Every ASSIGNMENT form of the column — the sweep must contain NONE of them.
 * Deliberately does NOT include a bare `dispatch_attempts:` object key, because
 * that is indistinguishable from the TypeScript interface member this file's own
 * `StaleTaskRow` declares; a literal-zero object key is already caught by
 * ZEROING_PATTERNS above. Covered here: SQL `SET col =`, `obj.col =`, `obj['col'] =`.
 */
const ANY_WRITE_FORM =
  /(?:SET\s+dispatch_attempts|\.\s*dispatch_attempts\s*=|\[\s*['"]dispatch_attempts['"]\s*\]\s*=)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

interface ScanHit { file: string; line: number; text: string }

/** Every zeroing write in the shipped source, with 1-based line numbers. */
function scanZeroingWrites(): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const src = fs.readFileSync(file, 'utf8');
      const lines = src.split('\n');
      for (const re of ZEROING_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          const line = src.slice(0, m.index).split('\n').length;
          hits.push({ file: path.relative(REPO_ROOT, file), line, text: (lines[line - 1] ?? '').trim() });
          if (m.index === re.lastIndex) re.lastIndex++; // zero-length safety
        }
      }
    }
  }
  return hits;
}

test('(d) SOURCE SCAN: exactly the sanctioned writers zero dispatch_attempts — the sweep is not one of them', () => {
  const SANCTIONED = new Map<string, string>([
    [
      'src/lib/task-dispatcher.ts',
      'recordDispatchSuccess — the single success-path reset, non-preserve branch only',
    ],
    [
      'scripts/remediate/unfreeze-sovereignty-blocks.ts',
      'operator-invoked, --apply-gated, dry-run-by-default P1-01 rollout remediation',
    ],
  ]);

  const hits = scanZeroingWrites();
  const byFile = new Map<string, ScanHit[]>();
  for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);

  const describeHits = (hs: ScanHit[]) => hs.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n');

  // 1. Nothing outside the allowlist may zero the counter.
  const rogue = hits.filter((h) => !SANCTIONED.has(h.file));
  assert.deepEqual(
    rogue,
    [],
    `UNSANCTIONED dispatch_attempts zeroing write(s) found — a new writer must not be able to ` +
      `silently re-open an exhausted dispatch budget:\n${describeHits(rogue)}`,
  );

  // 2. The allowlist must not rot into a lie: each sanctioned file must still
  //    actually contain the write it is excused for.
  for (const [file, why] of SANCTIONED) {
    assert.ok(
      (byFile.get(file) ?? []).length > 0,
      `allowlist entry ${file} no longer zeroes dispatch_attempts — remove it from SANCTIONED ` +
        `(it was excused for: ${why})`,
    );
  }

  // 3. THE REGRESSION GUARD, named explicitly so a reintroduction is unmistakable.
  const sweepRel = 'src/lib/jobs/stale-task-sweep.ts';
  assert.deepEqual(
    byFile.get(sweepRel) ?? [],
    [],
    `the stale-task-sweep must NEVER write dispatch_attempts — it is a WATCHDOG, not a dispatch ` +
      `attempt (same rule FIX 41 already applies to qc_reroute_attempts). Found:\n` +
      describeHits(byFile.get(sweepRel) ?? []),
  );

  // 3b. Stronger than "does not zero": the sweep contains NO write form at all.
  //     It READS the column (SELECT + the cap guard + the audit note) — that is fine.
  const sweepSrc = fs.readFileSync(path.join(REPO_ROOT, sweepRel), 'utf8');
  assert.ok(
    !ANY_WRITE_FORM.test(sweepSrc),
    'the stale-task-sweep contains a dispatch_attempts WRITE form; it must only ever READ the counter',
  );

  // 3c. The sweep must gate on the SAME cap the dispatcher blocks at — never a
  //     re-derived copy that could drift.
  assert.ok(
    /import\s*\{[^}]*\bMAX_DISPATCH_ATTEMPTS\b[^}]*\}\s*from\s*'@\/lib\/task-dispatcher'/.test(sweepSrc),
    'the sweep must import MAX_DISPATCH_ATTEMPTS from the dispatcher, not define its own cap',
  );
});

test('(d2) SOURCE SCAN: the one automatic writer zeroes ONLY on a genuine successful advance', () => {
  const rel = 'src/lib/task-dispatcher.ts';
  const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const lines = src.split('\n');
  const lineOf = (needle: string, from = 0): number => {
    const i = lines.findIndex((l, idx) => idx >= from && l.includes(needle));
    assert.ok(i >= 0, `expected to find ${JSON.stringify(needle)} in ${rel}`);
    return i + 1; // 1-based
  };

  const fnLine = lineOf('function recordDispatchSuccess');
  const preserveBranchLine = lineOf('opts.preserveAttempts', fnLine);
  const zeroingHit = scanZeroingWrites().find((h) => h.file === rel);
  assert.ok(zeroingHit, `${rel} must contain exactly the sanctioned zeroing write`);

  // The reset must sit AFTER the preserveAttempts branch, i.e. it is the ELSE —
  // the ordinary success path — and the recovery path provably does not zero.
  assert.ok(
    fnLine < preserveBranchLine && preserveBranchLine < zeroingHit.line,
    `recordDispatchSuccess must zero dispatch_attempts only in the NON-preserve branch ` +
      `(fn@${fnLine}, preserveAttempts@${preserveBranchLine}, zeroing@${zeroingHit.line})`,
  );

  // And the preserve branch itself must not zero (belt and braces on the same fact).
  const preserveBlock = lines.slice(preserveBranchLine - 1, zeroingHit.line - 1).join('\n');
  assert.ok(
    !/dispatch_attempts\s*=\s*(?:0|null|NULL)/.test(preserveBlock),
    'the { preserveAttempts: true } branch must NOT zero dispatch_attempts',
  );
});

test('(d3) SOURCE SCAN: the only other zeroing site is the operator-gated remediation script', () => {
  const rel = 'scripts/remediate/unfreeze-sovereignty-blocks.ts';
  const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const lines = src.split('\n');

  // It must be dry-run by default and require an explicit --apply, so it can never
  // grant budget as a side effect of anything a scheduler does.
  const applyLine = lines.findIndex((l) => l.includes("process.argv.includes('--apply')"));
  assert.ok(applyLine >= 0, `${rel} must gate on an explicit --apply flag`);

  const zeroLine = lines.findIndex((l) => /dispatch_attempts\s*=\s*0/.test(l));
  assert.ok(zeroLine >= 0, `${rel} is allowlisted for a zeroing write it no longer contains`);
  assert.ok(
    applyLine < zeroLine,
    `${rel} must declare its --apply gate BEFORE the zeroing write`,
  );

  // The write must live inside an `if (APPLY ...)` block — not in the dry-run path.
  assert.ok(
    lines.slice(0, zeroLine).some((l) => /if\s*\(\s*APPLY\b/.test(l)),
    `${rel} must execute the counter reset only inside an "if (APPLY ...)" guard`,
  );
});

// ── CAUSAL NON-INTERFERENCE: nothing this suite did can be found in the live DB ─
test('ISOLATION: no fixture this suite created exists in the LIVE operator DB', () => {
  const livePath = path.join(os.homedir(), 'data', 'mission-control.db');
  if (!fs.existsSync(livePath)) {
    // The live DB is not on this box — isolation is trivially satisfied.
    return;
  }
  // Read the live DB strictly READ-ONLY (mode=ro). Opening it read-write merely
  // to check would itself be a write vector. Loaded lazily so the driver is only
  // pulled in when a live DB actually exists on this box.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  try {
    assert.ok(fixtureIds.length > 0, 'this suite created fixtures worth checking for');
    const placeholders = fixtureIds.map(() => '?').join(',');
    const rows = live
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE id IN (${placeholders})`)
      .get(...fixtureIds) as { n: number };
    assert.equal(
      rows.n,
      0,
      `LEAK: ${rows.n} of this suite's fixtures were written into the LIVE DB — tests must never touch live operator state`,
    );
  } finally {
    live.close();
  }
});
