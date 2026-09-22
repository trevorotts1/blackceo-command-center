/**
 * STRANDED-01 — a card the scheduler dropped is re-queued or blocked, never
 * left in a lane nothing will look at again.
 *
 * THE DEFECT (measured live, card d5635f63): the card sat in `backlog` for
 * 10.5h after its last auto-route died with
 * `dispatch_pipeline_error: [auto-route] scheduler_lease_lost`, carrying 5
 * dispatch attempts, no hold and no `next_dispatch_eligible_at`. Two halves:
 *
 *   A. autoDispatchTask's outer catch recorded a lost scheduler lease ONLY as a
 *      `dispatch_pipeline_error` event — no attempt accounting, no backoff, no
 *      block, no alert. A lost lease is a TRANSIENT infrastructure failure (the
 *      sweep outran its 90s lease), so it now goes through the same
 *      recordDispatchFailure path every other transient failure uses.
 *
 *   B. intake-advance — the SINGLE live advancer since SWEEP-01 paused
 *      backlog-redispatch — selects only `dispatch_attempts < cap`, and its
 *      cap-out surfacing keyed on `qc_reroute_attempts` alone. A card put back
 *      into an intake lane with the dispatch counter already at the cap (the
 *      Resume route preserves it by the U061 PRESERVE decision) was therefore
 *      selected by nothing and surfaced by nothing. It is now blocked with an
 *      honest reason and the operator told once.
 *
 * Hermetic: temp DB, temp HOME, gateway boundary stubbed, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-stranded-lease-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';

// A real per-department runtime dir + dev-open write auth + a REAL sovereign
// model, so a dispatch reaches the lease checkpoint instead of stopping at an
// unrelated gate. Same recipe as dispatch-idempotency-window.test.ts.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-stranded-home-'));
fs.mkdirSync(path.join(TMP_HOME, '.openclaw', 'agents', 'testdept'), { recursive: true });
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.OPENCLAW_PLATFORM = 'mac-mini';
process.env.ALLOW_INSECURE_OPEN_API = 'true';
process.env.SOVEREIGN_DEFAULT_MODEL = 'test-provider/test-model-v1';
process.env.CC_SKILL_ROOTS = path.join(TMP_HOME, 'no-skills-here');
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type DispatcherModule = typeof import('../../src/lib/task-dispatcher');
let autoDispatchTask: DispatcherModule['autoDispatchTask'];
type LeaseModule = typeof import('../../src/lib/jobs/job-lease');
let runLeasedJob: LeaseModule['runLeasedJob'];
type IntakeModule = typeof import('../../src/lib/jobs/intake-advance-sweep');
let runIntakeAdvanceSweep: IntakeModule['runIntakeAdvanceSweep'];

const WS_ID = 'ws-stranded';
const AGENT_ID = 'agent-stranded';
const MODEL_ID = 'test-provider/test-model-v1';
const SOP_ID = 'sop-stranded';
/** MAX_DISPATCH_ATTEMPTS default — asserted against the exported constant below. */
const CAP = 5;

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run; queryOne = db.queryOne; queryAll = db.queryAll; closeDb = db.closeDb;
  db.getDb();

  const now = new Date().toISOString();
  run(`INSERT OR IGNORE INTO workspaces (id, slug, name, company_id) VALUES (?, 'testdept', 'Test Dept', 'default')`, [WS_ID]);
  run(
    `INSERT INTO agents (id, name, role, is_master, specialist_type, workspace_id, status, created_at, updated_at)
     VALUES (?, 'Stranded Test Agent', 'Test Operations', 0, 'permanent', ?, 'standby', ?, ?)`,
    [AGENT_ID, WS_ID, now, now],
  );
  run(
    `INSERT INTO agent_settings (id, department_id, role_id, setting_type, value)
     VALUES ('as-stranded', 'testdept', ?, 'model', ?)`,
    [AGENT_ID, MODEL_ID],
  );
  run(
    `INSERT INTO model_registry (model_id, label, provider, capabilities, status)
     VALUES (?, 'Test Model', 'test-provider', '["text"]', 'active')`,
    [MODEL_ID],
  );
  run(
    `INSERT INTO sops (id, name, slug, steps, success_criteria, department) VALUES (?, ?, ?, ?, ?, 'testdept')`,
    [SOP_ID, 'Stranded SOP', 'stranded-sop', 'Step 1: do the thing.', 'It is done.'],
  );

  // A second department with NO ~/.openclaw/agents/<slug>/ runtime directory —
  // the genuine, non-transient dispatch refusal this suite contrasts against.
  run(`INSERT OR IGNORE INTO workspaces (id, slug, name, company_id) VALUES ('ws-norun', 'norundept', 'No Runtime Dept', 'default')`);
  run(
    `INSERT INTO agents (id, name, role, is_master, specialist_type, workspace_id, status, created_at, updated_at)
     VALUES ('agent-norun', 'No Runtime Agent', 'Test Operations', 0, 'permanent', 'ws-norun', 'standby', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT INTO agent_settings (id, department_id, role_id, setting_type, value)
     VALUES ('as-norun', 'norundept', 'agent-norun', 'model', ?)`,
    [MODEL_ID],
  );

  const dispatcher = (await import('../../src/lib/task-dispatcher')) as DispatcherModule;
  autoDispatchTask = dispatcher.autoDispatchTask;
  assert.equal(dispatcher.MAX_DISPATCH_ATTEMPTS, CAP, 'this suite assumes the default dispatch cap');
  runLeasedJob = ((await import('../../src/lib/jobs/job-lease')) as LeaseModule).runLeasedJob;
  runIntakeAdvanceSweep = ((await import('../../src/lib/jobs/intake-advance-sweep')) as IntakeModule).runIntakeAdvanceSweep;

  // Gateway boundary: connected, and every call succeeds. Nothing leaves the
  // process — the dispatch is stopped by the lease, not by the network.
  const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
  const client = getOpenClawClient();
  client.isConnected = () => true;
  client.call = (async () => ({ ok: true })) as typeof client.call;
});

test.after(async () => {
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try {
    const g = globalThis as Record<string, NodeJS.Timeout | undefined>;
    const timer = g['__openclaw_cache_cleanup_timer__'];
    if (timer) { clearInterval(timer); delete g['__openclaw_cache_cleanup_timer__']; }
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface SeedOpts {
  status?: string;
  dispatchAttempts?: number;
  sopId?: string | null;
  description?: string;
  blockReason?: string | null;
}

function seedCard(id: string, opts: SeedOpts = {}): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id,
        business_id, department, sop_id, persona_id, dispatch_attempts, block_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'medium', ?, ?, NULL, 'testdept', ?, 'hormozi-100m-offers', ?, ?, ?, ?)`,
    [
      id,
      `Stranded card ${id}`,
      opts.description ?? 'A description long enough to satisfy the Triad gate on this card.',
      opts.status ?? 'backlog',
      AGENT_ID,
      WS_ID,
      opts.sopId === undefined ? SOP_ID : opts.sopId,
      opts.dispatchAttempts ?? 0,
      opts.blockReason ?? null,
      now,
      now,
    ],
  );
}

/** Drive one dispatch whose scheduler lease dies before the card is claimed. */
async function dispatchWithLostLease(taskId: string, jobName: string): Promise<void> {
  await runLeasedJob(jobName, async () => {
    run(`DELETE FROM scheduler_leases WHERE job_name = ?`, [jobName]);
    return autoDispatchTask(taskId, 'auto-route');
  });
}

const cardOf = (id: string) =>
  queryOne<{ status: string; dispatch_attempts: number | null; next_dispatch_eligible_at: string | null; block_reason: string | null }>(
    'SELECT status, dispatch_attempts, next_dispatch_eligible_at, block_reason FROM tasks WHERE id = ?',
    [id],
  )!;

const eventTypes = (id: string): string[] =>
  queryAll<{ type: string }>('SELECT type FROM events WHERE task_id = ? ORDER BY created_at', [id]).map((r) => r.type);

// ── A. A lost lease is transient: bounded retry, then the advancer re-claims ──

test('[STRANDED-01/A] a lost lease sets a bounded retry and the live advancer re-claims the card', async () => {
  const taskId = 'stranded-lease-retry';
  seedCard(taskId);

  await dispatchWithLostLease(taskId, 'lease-retry-job');

  const card = cardOf(taskId);
  assert.equal(card.status, 'backlog', 'a transient abort never moves the card');
  assert.equal(card.dispatch_attempts, 1, 'the lost lease is accounted for as one failed advance attempt');
  assert.ok(card.next_dispatch_eligible_at, 'a bounded backoff window is stamped');
  assert.ok(
    new Date(card.next_dispatch_eligible_at!).getTime() > Date.now(),
    'the backoff window is in the future, so the sweep cannot re-fire immediately',
  );
  assert.ok(
    new Date(card.next_dispatch_eligible_at!).getTime() - Date.now() <= 3_600_000,
    'the backoff is BOUNDED — never an open-ended park',
  );

  // The abort stays visible AND is now accounted for.
  const types = eventTypes(taskId);
  assert.ok(types.includes('dispatch_pipeline_error'), 'the pipeline error is still recorded');
  assert.ok(types.includes('task_dispatch_deferred'), 'the transient retry is recorded');

  // Once the window elapses, the SINGLE live advancer selects the card again.
  run(`UPDATE tasks SET next_dispatch_eligible_at = ?, updated_at = ? WHERE id = ?`, [
    new Date(Date.now() - 60_000).toISOString(),
    new Date(Date.now() - 10 * 60_000).toISOString(), // past the 120s grace window
    taskId,
  ]);
  const reclaimed: string[] = [];
  await runIntakeAdvanceSweep({
    dispatch: async (id: string) => {
      reclaimed.push(id);
      return { status: 'acknowledged' as const, reason: 'test-stub' };
    },
  });
  assert.ok(reclaimed.includes(taskId), 'intake-advance re-claims the card on its next tick');
});

// ── B. A genuine refusal is never laundered into a transient retry ───────────

test('[STRANDED-01/B] a non-lease pipeline error gets no transient retry accounting', async () => {
  const taskId = 'stranded-other-error';
  seedCard(taskId);

  const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
  const client = getOpenClawClient();
  const goodCall = client.call;
  client.call = (async () => { throw new Error('gateway exploded'); }) as typeof client.call;
  try {
    await autoDispatchTask(taskId, 'auto-route');
  } finally {
    client.call = goodCall;
  }

  const card = cardOf(taskId);
  assert.notEqual(card.block_reason, 'scheduler_lease_lost', 'an unrelated fault is never reported as a lost lease');
  assert.ok(
    !eventTypes(taskId).some((t) => t === 'task_dispatch_deferred' && card.block_reason === 'scheduler_lease_lost'),
    'the lease-loss recovery does not fire for a failure it does not own',
  );
});

test('[STRANDED-01/B] a genuine dispatch refusal keeps its OWN failure class', async () => {
  const taskId = 'stranded-genuine-refusal';
  // A department with no OpenClaw runtime directory is a genuine, NON-transient
  // dispatch refusal: no retry can materialize a runtime, so it hard-blocks on
  // its own reason. That gate runs before the lease checkpoint, so the lost
  // lease never gets to re-label it as a transient infrastructure abort.
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id,
        business_id, department, sop_id, persona_id, dispatch_attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', 'agent-norun', 'ws-norun', NULL, 'norundept', ?, 'hormozi-100m-offers', 0, ?, ?)`,
    [taskId, 'Refusal card', 'A description long enough to satisfy the Triad gate on this card.', SOP_ID, now, now],
  );

  await dispatchWithLostLease(taskId, 'genuine-refusal-job');

  const card = cardOf(taskId);
  assert.equal(card.status, 'blocked', 'a non-transient refusal blocks immediately');
  assert.equal(card.block_reason, 'no_specialist_runtime', 'the refusal keeps its OWN reason');
  assert.notEqual(card.block_reason, 'scheduler_lease_lost', 'it is never re-labelled as a lost lease');
  assert.equal(card.dispatch_attempts, 1, 'blocked on attempt 1 — no transient retry ladder is granted');
});

// ── C. The retry cap blocks with a reason and alerts once ────────────────────

test('[STRANDED-01/C] at the cap a lost lease blocks with an honest reason and alerts once', async () => {
  const taskId = 'stranded-lease-cap';
  seedCard(taskId, { dispatchAttempts: CAP - 1 });

  await dispatchWithLostLease(taskId, 'lease-cap-job');

  const card = cardOf(taskId);
  assert.equal(card.status, 'blocked', 'the exhausted card is blocked, never left in backlog');
  assert.equal(card.dispatch_attempts, CAP);
  assert.equal(card.block_reason, 'scheduler_lease_lost', 'the block names what actually failed');
  assert.equal(card.next_dispatch_eligible_at, null, 'a blocked card carries no pending retry');
  const blocked = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'task_blocked'`, [taskId]);
  assert.equal(blocked.length, 1, 'exactly one block alert');
  assert.match(blocked[0].message, /scheduler_lease_lost/);

  // A second lost lease on the SAME card must not re-alert: the card is no
  // longer in a pre-dispatch lane, so the recovery does not touch it.
  await dispatchWithLostLease(taskId, 'lease-cap-job-2');
  assert.equal(
    queryAll(`SELECT id FROM events WHERE task_id = ? AND type = 'task_blocked'`, [taskId]).length,
    1,
    'the alert fires once per card, not once per tick',
  );
  assert.equal(cardOf(taskId).dispatch_attempts, CAP, 'an already-blocked card is not re-counted');
});

// ── D. A card that is genuinely held is untouched ───────────────────────────

test('[STRANDED-01/D] a card already blocked is untouched by the lease-loss recovery', async () => {
  const taskId = 'stranded-real-hold';
  seedCard(taskId, { status: 'blocked', dispatchAttempts: 2, blockReason: 'awaiting owner decision' });

  await dispatchWithLostLease(taskId, 'real-hold-job');

  const card = cardOf(taskId);
  assert.equal(card.status, 'blocked');
  assert.equal(card.block_reason, 'awaiting owner decision', 'an existing hold reason is never overwritten');
  assert.equal(card.dispatch_attempts, 2, 'no attempt is charged to a card that is not waiting to dispatch');
  assert.equal(card.next_dispatch_eligible_at, null, 'no backoff is stamped onto held work');
});

// ── E. The already-stranded card: at the cap, in backlog, seen by nobody ─────

test('[STRANDED-01/E] a backlog card at the dispatch cap is blocked with a reason and alerted once', async () => {
  const taskId = 'stranded-cap-in-backlog';
  // The shape a Resume leaves behind (U061 PRESERVE): back in backlog, the
  // exhausted dispatch budget preserved, no backoff, no hold.
  seedCard(taskId, { dispatchAttempts: CAP });
  run(`UPDATE tasks SET updated_at = ? WHERE id = ?`, [new Date(Date.now() - 6 * 3_600_000).toISOString(), taskId]);

  const noop = async () => ({ status: 'held' as const, reason: 'test-stub' });
  const first = await runIntakeAdvanceSweep({ dispatch: noop });
  assert.ok((first.capped ?? 0) >= 1, 'the cap-out is surfaced');

  const card = cardOf(taskId);
  assert.equal(card.status, 'blocked', 'the card stops being invisible queued work');
  assert.match(String(card.block_reason), /dispatch-attempt cap/, 'the reason names the cap that was hit');
  const capEvents = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'task_dispatch_capped'`, [taskId]);
  assert.equal(capEvents.length, 1, 'exactly one operator alert');
  assert.match(capEvents[0].message, /5\/5/, 'the alert states the budget that was spent');

  // A second tick must not re-alert.
  await runIntakeAdvanceSweep({ dispatch: noop });
  assert.equal(
    queryAll(`SELECT id FROM events WHERE task_id = ? AND type = 'task_dispatch_capped'`, [taskId]).length,
    1,
    'the cap alert is once per card, not once per tick',
  );
});

test('[STRANDED-01/E] a card under the cap, and an owner-killed card, are left alone', async () => {
  const underCap = 'stranded-under-cap';
  seedCard(underCap, { dispatchAttempts: CAP - 1 });
  const killed = 'stranded-killed-at-cap';
  seedCard(killed, {
    dispatchAttempts: CAP,
    description: 'OWNER KILLED — this card is dead and must never be re-surfaced.',
  });
  for (const id of [underCap, killed]) {
    run(`UPDATE tasks SET updated_at = ? WHERE id = ?`, [new Date(Date.now() - 6 * 3_600_000).toISOString(), id]);
  }

  await runIntakeAdvanceSweep({ dispatch: async () => ({ status: 'held' as const, reason: 'test-stub' }) });

  assert.notEqual(cardOf(underCap).status, 'blocked', 'a card with budget left is never cap-blocked');
  assert.equal(
    queryAll(`SELECT id FROM events WHERE task_id = ? AND type = 'task_dispatch_capped'`, [killed]).length,
    0,
    'an OWNER-KILLED card is never woken by the cap surfacing',
  );
});
