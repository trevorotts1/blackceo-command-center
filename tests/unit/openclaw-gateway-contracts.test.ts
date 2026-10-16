/**
 * openclaw-gateway-contracts.test.ts — the wire contract, the watchdog's
 * liveness reading, and the two log floods.
 *
 * WHY THESE TESTS LOOK LIKE THIS. Every defect covered here type-checked, built
 * and shipped. None of them could have been caught by asserting that the code
 * does what the code does, so each test asserts the shape that CROSSES A
 * BOUNDARY — the JSON on the wire, the row in the DB, the line in the log — and
 * each one is paired with a MUTATION PROOF: the pre-fix behaviour is executed in
 * the same test and shown to fail the same assertion. A test that cannot be made
 * to fail is not evidence.
 *
 * The gateway schemas are validated against the REAL installed openclaw protocol
 * module when one is present on the box, so "this payload is accepted" is proved
 * by the gateway's own validator rather than by a transcription of it. When no
 * openclaw is installed those two tests SKIP rather than pass — an absent
 * instrument is not a green result. scripts/openclaw-contract-check.mjs is the
 * gate that makes the schemas' absence loud in CI.
 *
 * Run: node --import tsx --test tests/unit/openclaw-gateway-contracts.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.DISABLE_BOARD_JOBS_WATCHDOG;
process.env.BOARD_JOBS_WATCHDOG_SELF_RESTART = '0';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gw-contract-runtime-'));
fs.mkdirSync(path.join(RUNTIME_ROOT, 'agents'), { recursive: true });
process.env.OPENCLAW_ROOT = RUNTIME_ROOT;
process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gw-contract-workspace-'));

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, run } from '../../src/lib/db';
import { OpenClawClient } from '../../src/lib/openclaw/client';
import {
  getWatchedJobLiveness,
  WATCHED_JOB_CADENCE_MINUTES,
  STALE_MULTIPLIER,
  type BoardJobsWatchdogRunResult,
} from '../../src/lib/jobs/board-jobs-watchdog';
import { recordJobTick, boardJobsWatchdogLogLine } from '../../src/lib/jobs/scheduler';
import { resolveSpecialistSessionKey, resetResolveWarnDedupe } from '../../src/lib/routing/executor-runtime';
import { candidateSessionKeys, resetUnresolvableTaskMemo } from '../../src/lib/jobs/execution-watcher';

getDb(); // apply the full migration chain

/* ───────────────────────────── shared helpers ───────────────────────────── */

function minutesAgoIso(mins: number): string {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

/** A client whose `call()` is replaced by a scripted gateway. Nothing dials out. */
function mockGateway(reply: (method: string, params?: Record<string, unknown>) => unknown) {
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  const client = new OpenClawClient('ws://127.0.0.1:0/never-dialled', 'test-token');
  (client as unknown as { call: unknown }).call = async (method: string, params?: Record<string, unknown>) => {
    sent.push({ method, params });
    return reply(method, params);
  };
  return { client, sent };
}

/** Capture console.warn for the duration of `fn`. */
async function capturedWarnings(fn: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.warn = original; }
  return lines;
}

/** The installed openclaw protocol module, or null when none is installed. */
async function loadProtocol(): Promise<Record<string, unknown> | null> {
  let dist = process.env.OPENCLAW_DIST;
  if (!dist) {
    for (const prefix of [
      path.join(os.homedir(), '.npm-global/lib/node_modules'),
      '/usr/local/lib/node_modules',
      '/opt/homebrew/lib/node_modules',
    ]) {
      const candidate = path.join(prefix, 'openclaw', 'dist');
      if (fs.existsSync(candidate)) { dist = candidate; break; }
    }
  }
  if (!dist) {
    try { dist = path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'openclaw', 'dist'); } catch { return null; }
  }
  const protoPath = path.join(dist, 'gateway', 'protocol', 'index.js');
  if (!fs.existsSync(protoPath)) return null;
  try { return (await import(pathToFileURL(protoPath).href)) as Record<string, unknown>; } catch { return null; }
}

/** Minimal JSON-Schema check for the closed param objects the gateway uses. */
function validateAgainst(schema: { required?: string[]; properties?: Record<string, unknown>; additionalProperties?: unknown },
                         payload: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of schema.required ?? []) if (!(key in payload)) problems.push(`missing required "${key}"`);
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(payload)) if (!allowed.has(key)) problems.push(`unexpected property "${key}"`);
  }
  return problems;
}

/* ══════════════════════════ B — the gateway client ═════════════════════════ */

test('listSessions unwraps the sessions.list ENVELOPE into the array every caller expects', async () => {
  // The exact payload the gateway's buildSessionsListResult() produces.
  const envelope = {
    ts: Date.now(),
    path: '/tmp/sessions',
    count: 2,
    defaults: { model: 'x' },
    sessions: [{ key: 'agent:dept-funnels:abc', model: 'kimi' }, { key: 'agent:main:def' }],
  };
  const { client, sent } = mockGateway(() => envelope);

  const sessions = await client.listSessions();
  assert.equal(sent[0].method, 'sessions.list');
  assert.ok(Array.isArray(sessions), 'listSessions must return an ARRAY');
  assert.equal(sessions.length, 2);
  assert.equal((sessions[0] as { key: string }).key, 'agent:dept-funnels:abc');

  // MUTATION PROOF — the pre-fix body returned the envelope untouched, so every
  // caller's Array.isArray guard was false and every .map()/.find() would throw.
  const preFix = envelope as unknown;
  assert.equal(Array.isArray(preFix), false, 'the raw envelope is NOT an array — this is the defect');
  assert.throws(() => (preFix as unknown as unknown[]).map((x) => x), TypeError);
});

test('listSessions still accepts a bare array, and never throws on an unknown shape', async () => {
  const bare = [{ key: 'agent:main:one' }];
  assert.deepEqual(await mockGateway(() => bare).client.listSessions(), bare);

  for (const weird of [null, undefined, 42, 'nope', { totally: 'different' }]) {
    const out = await mockGateway(() => weird).client.listSessions();
    assert.deepEqual(out, [], `an unrecognised sessions.list payload (${JSON.stringify(weird)}) must degrade to []`);
  }
});

test('sendMessage produces {key,message} — the shape SessionsSendParamsSchema actually accepts', async (t) => {
  const { client, sent } = mockGateway(() => ({ ok: true }));
  await client.sendMessage('agent:dept-funnels:abc', 'hello');

  assert.equal(sent[0].method, 'sessions.send');
  assert.deepEqual(sent[0].params, { key: 'agent:dept-funnels:abc', message: 'hello' });

  const proto = await loadProtocol();
  if (!proto) return t.skip('no openclaw installed on this box — the real schema could not be loaded');
  const schema = proto.SessionsSendParamsSchema as Parameters<typeof validateAgainst>[0];

  assert.deepEqual(validateAgainst(schema, sent[0].params!), [], 'the sent payload must satisfy the real schema');

  // MUTATION PROOF — the pre-fix payload, judged by the SAME validator.
  const preFix = { session_id: 'agent:dept-funnels:abc', content: 'hello' };
  const problems = validateAgainst(schema, preFix);
  assert.ok(problems.length >= 3, `the old {session_id,content} payload must be rejected; got ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.includes('missing required "key"')));
  assert.ok(problems.some((p) => p.includes('missing required "message"')));
  assert.ok(problems.some((p) => p.includes('unexpected property "session_id"')));
});

test('getSessionHistory calls chat.history (sessions.history has no handler) and unwraps .messages', async (t) => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }];
  const { client, sent } = mockGateway((method) => {
    if (method === 'sessions.history') throw new Error('unknown method: sessions.history');
    return { sessionKey: 'agent:main:abc', sessionId: 'abc', messages, pendingInputs: [] };
  });

  const history = await client.getSessionHistory('agent:main:abc');
  assert.equal(sent[0].method, 'chat.history', 'the RPC must be chat.history, never sessions.history');
  assert.deepEqual(sent[0].params, { sessionKey: 'agent:main:abc' });
  assert.deepEqual(history, messages, 'the messages array must be unwrapped for callers');

  // MUTATION PROOF — the pre-fix call names a method the gateway does not have.
  await assert.rejects(() => client.call('sessions.history', { session_id: 'abc' }), /unknown method/);

  const proto = await loadProtocol();
  if (!proto) return t.skip('no openclaw installed on this box — the real schema could not be loaded');
  const schema = proto.ChatHistoryParamsSchema as Parameters<typeof validateAgainst>[0];
  assert.deepEqual(validateAgainst(schema, sent[0].params!), []);
  // And the old param shape would have been rejected even if the method existed.
  assert.ok(validateAgainst(schema, { session_id: 'abc' }).length > 0);
});

/* ═══════════ D — a long-running sweep is ALIVE, not a stalled loop ══════════ */

/** Put `jobName` into the state a mid-run sweep is actually in. */
function seedRunningJob(jobName: string, startedMinutesAgo: number, leaseExpiresInMinutes: number | null): void {
  run('DELETE FROM job_liveness WHERE job_name=?', [jobName]);
  run('DELETE FROM scheduler_leases WHERE job_name=?', [jobName]);
  // last_ran_at only advances when a tick FINISHES, so an overrunning run ages
  // it exactly as a dead loop would — which is why the lease is the discriminator.
  run(`INSERT INTO job_liveness(job_name,last_ran_at,last_status,last_started_at,last_finished_at)
       VALUES(?,?,'ok',?,NULL)`, [jobName, minutesAgoIso(startedMinutesAgo), minutesAgoIso(startedMinutesAgo)]);
  if (leaseExpiresInMinutes !== null) {
    run(`INSERT INTO scheduler_leases(job_name,owner,expires_at,updated_at) VALUES(?,?,?,?)`,
      [jobName, 'test-owner', new Date(Date.now() + leaseExpiresInMinutes * 60_000).toISOString(), new Date().toISOString()]);
  }
}

function livenessFor(jobName: string) {
  const row = getWatchedJobLiveness().find((w) => w.jobName === jobName);
  assert.ok(row, `${jobName} must be a watched job`);
  return row!;
}

test('a sweep still RUNNING past cadence x3 is alive while it holds a fresh lease — and stale once the lease expires', () => {
  const jobName = 'qc-review-sweep';
  const threshold = WATCHED_JOB_CADENCE_MINUTES[jobName] * STALE_MULTIPLIER; // 6 minutes
  const overrun = threshold + 4; // a legitimate 10-minute QC sweep

  // Mid-run, lease live: ALIVE. This is the case that restarted the box twice.
  seedRunningJob(jobName, overrun, 1);
  const alive = livenessFor(jobName);
  assert.equal(alive.running, true);
  assert.equal(alive.leaseHeld, true);
  assert.equal(alive.stale, false, 'a running sweep holding a live lease is NOT a stalled scheduler');
  assert.equal(alive.failed, false, 'nor has it failed — it simply has not finished');

  // MUTATION PROOF — same row, lease gone. Now it IS stale, and the watchdog
  // keeps every bit of its power to detect a genuinely dead loop.
  run('DELETE FROM scheduler_leases WHERE job_name=?', [jobName]);
  const dead = livenessFor(jobName);
  assert.equal(dead.leaseHeld, false);
  assert.equal(dead.stale, true, 'with no live lease, an overrunning job is stale again');

  // An EXPIRED lease row is not a live lease.
  seedRunningJob(jobName, overrun, -1);
  assert.equal(livenessFor(jobName).stale, true, 'an expired lease must not suppress a real stall');
});

test('a lease cannot mask a job that is not running at all', () => {
  const jobName = 'intake-advance';
  const threshold = WATCHED_JOB_CADENCE_MINUTES[jobName] * STALE_MULTIPLIER;
  run('DELETE FROM job_liveness WHERE job_name=?', [jobName]);
  run('DELETE FROM scheduler_leases WHERE job_name=?', [jobName]);
  // A FINISHED tick, long ago, with a lease row left lying around.
  recordJobTick(jobName, minutesAgoIso(threshold + 30), 'ok');
  run(`INSERT INTO scheduler_leases(job_name,owner,expires_at,updated_at) VALUES(?,?,?,?)`,
    [jobName, 'stray', new Date(Date.now() + 60_000).toISOString(), new Date().toISOString()]);

  const row = livenessFor(jobName);
  assert.equal(row.running, false, 'the tick finished, so nothing is running');
  assert.equal(row.leaseHeld, false, 'leaseHeld is only meaningful for a RUNNING tick');
  assert.equal(row.stale, true, 'a silent scheduler must still be reported stale');
  run('DELETE FROM scheduler_leases WHERE job_name=?', [jobName]);
});

test('the watchdog log line says nothing during warm-up, and never claims an alert that did not happen', () => {
  const base: BoardJobsWatchdogRunResult = {
    ranAt: new Date().toISOString(),
    staleJobs: ['intake-advance', 'qc-review-sweep'],
    disabledJobs: [],
    failedJobs: [],
    alerted: false,
  };

  // WARM-UP: every row reads silent right after a boot. Nothing to say.
  assert.equal(boardJobsWatchdogLogLine({ ...base, notificationStatus: 'warmup', selfRestart: 'warmup' }, false), null,
    'warm-up is a boot, not a stall — it must produce NO warning line');

  // MUTATION PROOF — the pre-fix sentence, reconstructed from the same inputs.
  const preFix = `[cron] board-jobs-watchdog: NOT RUNNING — ${base.staleJobs.join(', ')} (cooldown, already alerted)`;
  assert.match(preFix, /already alerted/);
  assert.notEqual(boardJobsWatchdogLogLine({ ...base, notificationStatus: 'warmup' }, false), preFix,
    'the old line claimed an alert had already been sent during a boot; it had not');

  // COOLDOWN is the one state "already alerted" is true for.
  assert.match(boardJobsWatchdogLogLine({ ...base, notificationStatus: 'cooldown' }, false)!, /\(cooldown, already alerted\)$/);

  // UNAVAILABLE means NOBODY was told — the opposite of "already alerted".
  const unavailable = boardJobsWatchdogLogLine({ ...base, notificationStatus: 'unavailable' }, false)!;
  assert.match(unavailable, /NOT alerted/);
  assert.doesNotMatch(unavailable, /already alerted/);

  // A real alert says so, and a healthy tick stays silent.
  assert.match(boardJobsWatchdogLogLine({ ...base, alerted: true, notificationStatus: 'queued' }, false)!, /\(alerted\)$/);
  assert.equal(boardJobsWatchdogLogLine({ ...base, staleJobs: [], alerted: false }, false), null);
});

/* ═════════════════ E — the two log floods (7,788 lines, one task) ══════════ */

const WS_ID = 'ws-contract-test';
const AGENT_ID = 'agent-contract-test';

function seedUnresolvableAgent(agentId = AGENT_ID): void {
  run('DELETE FROM workspaces WHERE id=?', [WS_ID]);
  run('DELETE FROM agents WHERE id=?', [agentId]);
  run(`INSERT INTO workspaces(id,slug,name,created_at) VALUES(?,?,?,?)`,
    [WS_ID, 'no-such-department', 'No Such Department', new Date().toISOString()]);
}

const MISS_LINE = /has no runtime dir/;

test('the "no runtime dir" warning is logged ONCE per miss, not once per sweep tick', async () => {
  seedUnresolvableAgent();
  resetResolveWarnDedupe();
  const agent = { id: AGENT_ID, name: 'Contract Test', role: '', workspace_id: WS_ID } as never;

  // Twenty ticks of the two-minute sweep — forty minutes of real time.
  const lines = await capturedWarnings(() => {
    for (let i = 0; i < 20; i++) resolveSpecialistSessionKey(agent, 'sess-1', WS_ID, 'execution-watcher');
  });
  const misses = lines.filter((l) => MISS_LINE.test(l));
  assert.equal(misses.length, 1, `twenty identical misses must warn ONCE, got ${misses.length}`);
  assert.match(misses[0], /suppressed for 6h/, 'the line must say the suppression is happening');

  // MUTATION PROOF — clear the window and the SAME call warns again, so the
  // dedupe is suppressing duplicates rather than having silenced the condition.
  resetResolveWarnDedupe();
  const again = await capturedWarnings(() => { resolveSpecialistSessionKey(agent, 'sess-1', WS_ID, 'execution-watcher'); });
  assert.equal(again.filter((l) => MISS_LINE.test(l)).length, 1, 'the condition must still be reportable');

  // A DIFFERENT caller is never swallowed by an earlier caller's miss.
  const other = await capturedWarnings(() => { resolveSpecialistSessionKey(agent, 'sess-1', WS_ID, 'Dispatch'); });
  assert.equal(other.filter((l) => MISS_LINE.test(l)).length, 1, 'a dispatch miss must not hide behind a watcher miss');
});

test('a task with no execution stops being re-resolved until its assignment changes', async () => {
  seedUnresolvableAgent();
  resetResolveWarnDedupe();
  resetUnresolvableTaskMemo();

  const task = {
    id: 'task-contract-test',
    title: 'T',
    status: 'in_progress',
    assigned_agent_id: AGENT_ID,
    assigned_agent_name: 'Contract Test',
    assigned_agent_role: '',
    workspace_id: WS_ID,
    openclaw_session_id: 'sess-1',
  };

  const first = await capturedWarnings(() => { candidateSessionKeys(task); });
  assert.equal(first.filter((l) => MISS_LINE.test(l)).length, 1, 'the first miss is reported');

  // The warn dedupe is cleared, so ANY re-entry into the resolver would warn
  // again. Silence here proves the resolver was not called at all.
  resetResolveWarnDedupe();
  const later = await capturedWarnings(() => { for (let i = 0; i < 20; i++) candidateSessionKeys(task); });
  assert.equal(later.filter((l) => MISS_LINE.test(l)).length, 0, 'the resolver must not run again for an unchanged assignment');

  // The fallback key is still returned every time — behaviour is unchanged.
  assert.deepEqual(candidateSessionKeys(task), ['agent:main:sess-1']);

  // MUTATION PROOF 1 — a CHANGED assignment must re-resolve.
  resetResolveWarnDedupe();
  const reassigned = await capturedWarnings(() => { candidateSessionKeys({ ...task, assigned_agent_id: 'someone-else' }); });
  assert.equal(reassigned.filter((l) => MISS_LINE.test(l)).length, 1, 'a re-assigned task must be resolved again');

  // MUTATION PROOF 2 — clearing the memo restores the pre-fix behaviour, which
  // is what produced 7,788 lines for one task.
  resetUnresolvableTaskMemo();
  resetResolveWarnDedupe();
  const unmemoised = await capturedWarnings(() => { candidateSessionKeys(task); });
  assert.equal(unmemoised.filter((l) => MISS_LINE.test(l)).length, 1, 'without the memo the resolver runs every tick');
});

/* ═══════════ The guard itself: does it bite, and does it bite reliably? ═════ */

/**
 * A SYNTHETIC openclaw dist. Small enough to mutate one contract at a time, and
 * shaped like the real thing in the two ways that have already broken this
 * check: the protocol module is a real importable ES module, and each symbol is
 * present TWICE — once readable, once in a minified bundle that spells its
 * string literals with BACKTICKS.
 *
 * That second copy is not decoration. `grep -rl` returns files in filesystem
 * traversal order, which differs between macOS and Linux, and the first version
 * of this check sliced from whichever copy came first. It read the readable
 * chunk on a Mac and the minified one on a CI runner, found no `"entries"` in
 * the backticked body, and reported a contract break that did not exist — the
 * same openclaw version passing locally and failing in CI. A check whose verdict
 * depends on the filesystem is a broken instrument, so `minifiedFirst` exists to
 * pin both orders.
 */
function writeFakeDist(opts: {
  chatSendHasModel?: boolean;
  sendRequired?: string[];
  dropSessionsListBuilder?: boolean;
  listBeforeEntries?: boolean;
  dropRateLimit?: boolean;
  minifiedFirst?: boolean;
} = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fake-oc-dist-'));
  fs.mkdirSync(path.join(root, 'gateway', 'protocol'), { recursive: true });

  const closed = (props: string[], required: string[]) => ({
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])),
    required,
  });

  fs.writeFileSync(path.join(root, 'gateway', 'protocol', 'index.js'), `
export const ChatSendParamsSchema = ${JSON.stringify(closed(
    ['sessionKey', 'message', 'idempotencyKey', ...(opts.chatSendHasModel ? ['model'] : [])],
    ['sessionKey', 'message', 'idempotencyKey'],
  ))};
export const ChatHistoryParamsSchema = ${JSON.stringify(closed(['sessionKey', 'limit'], ['sessionKey']))};
export const SessionsCreateParamsSchema = ${JSON.stringify(closed(['key', 'label', 'model'], []))};
export const SessionsSendParamsSchema = ${JSON.stringify(closed(['key', 'message'], opts.sendRequired ?? ['key', 'message']))};
export const SessionsListParamsSchema = ${JSON.stringify(closed(['limit'], []))};
`);

  // The readable chunk, as upstream ships it.
  const readable = `
${opts.dropSessionsListBuilder ? '' : 'function buildSessionsListResult(params, list, sessions) { return { ts: 0, count: sessions.length, sessions }; }'}
const chatHistoryHandlers = { "chat.history": async () => {}, "chat.metadata": async () => {} };
const FAILOVER_REASONS = ["auth", ${opts.dropRateLimit ? '' : '"rate_limit",'} "overloaded"];
const TRANSIENT_FALLBACK_REASONS = ["overloaded"];
function readAgentRosterProperty(raw) {
${opts.listBeforeEntries
      ? '  const list = raw.agents["list"]; if (list !== undefined) return { kind: "list", value: list };\n  const entries = raw.agents["entries"]; if (entries !== undefined) return { kind: "entries", value: entries };'
      : '  const entries = raw.agents["entries"]; if (entries !== undefined) return { kind: "entries", value: entries };\n  const list = raw.agents["list"]; if (list !== undefined) return { kind: "list", value: list };'}
}
function collectAgentEntries(cfg) { const roster = readAgentRosterProperty(cfg); for (const [id, e] of Object.entries( roster.value )) void id, e; }
function resolveDefaultAgentMaxConcurrent() { return Math.min(MAX_AGENT_MAX_CONCURRENT, Math.max(MIN_AGENT_MAX_CONCURRENT, os.availableParallelism())); }
function resolveSessionModelRef(cfg, entry) { return { p: entry?.providerOverride, m: entry?.modelOverride }; }
const CONFIG_DOCS = { "models.providers.*.apiKey": "Provider credential." };
`;

  // The minified bundle: same symbols, BACKTICK literals, one long line.
  const minified = `function readAgentRosterProperty(Ot){let Zt=Ot.agents;${opts.listBeforeEntries
    ? 'let Dn=Zt.list;if(Object.hasOwn(Zt,`list`)&&Dn!==void 0)return{kind:`list`,value:Dn};let _n=Zt.entries;if(Object.hasOwn(Zt,`entries`)&&_n!==void 0)return{kind:`entries`,value:_n}'
    : 'let _n=Zt.entries;if(Object.hasOwn(Zt,`entries`)&&_n!==void 0)return{kind:`entries`,value:_n};let Dn=Zt.list;if(Object.hasOwn(Zt,`list`)&&Dn!==void 0)return{kind:`list`,value:Dn}'}}function resolveDefaultAgentMaxConcurrent(){return Math.min(16,Math.max(8,os.availableParallelism()))}`;

  // Filenames decide grep's order, and that is exactly what must not matter.
  const readableName = opts.minifiedFirst ? 'zz-readable.mjs' : 'aa-readable.mjs';
  const minifiedName = opts.minifiedFirst ? 'aa-worker.mjs' : 'zz-worker.mjs';
  fs.writeFileSync(path.join(root, readableName), readable);
  fs.writeFileSync(path.join(root, minifiedName), minified);
  return root;
}

/** Run the real script against a dist and return its exit code + output. */
function runGuard(dist: string): { code: number; out: string } {
  const script = path.join(process.cwd(), 'scripts', 'openclaw-contract-check.mjs');
  try {
    const out = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, OPENCLAW_DIST: dist, OPENCLAW_CONFIG: path.join(dist, 'no-such-config.json') },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('the contract guard PASSES a clean dist — in either file order, minified copy included', () => {
  for (const minifiedFirst of [false, true]) {
    const { code, out } = runGuard(writeFakeDist({ minifiedFirst }));
    assert.equal(code, 0, `a clean dist must pass with minifiedFirst=${minifiedFirst}:\n${out}`);
    assert.match(out, /all 10 hard contracts hold/);
  }
});

test('the contract guard BITES — each planted violation fails, naming its own contract', () => {
  const mutations: [string, Parameters<typeof writeFakeDist>[0], RegExp][] = [
    ['a `model` field appears on chat.send', { chatSendHasModel: true }, /ChatSendParamsSchema[\s\S]*model.*APPEARED|model` property APPEARED/],
    ['sessions.send stops requiring key+message', { sendRequired: ['session_id'] }, /SessionsSendParamsSchema/],
    ['the sessions.list result builder disappears', { dropSessionsListBuilder: true }, /sessions\.list result envelope/],
    ['roster precedence flips to list-first', { listBeforeEntries: true }, /agents roster precedence/],
    ['rate_limit drops out of the failover reasons', { dropRateLimit: true }, /FAILOVER_REASONS/],
  ];
  for (const [label, opts, expected] of mutations) {
    for (const minifiedFirst of [false, true]) {
      const { code, out } = runGuard(writeFakeDist({ ...opts, minifiedFirst }));
      assert.equal(code, 1, `${label} (minifiedFirst=${minifiedFirst}) must FAIL the guard:\n${out}`);
      assert.match(out, /FAILED — /);
      assert.match(out, expected, `${label} must name its own contract:\n${out}`);
    }
  }
});

test('the guard reports UNDETERMINED, never a contract break, when it cannot read a dist', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fake-oc-empty-'));
  const { code, out } = runGuard(empty);
  assert.equal(code, 1, 'an unreadable dist must still exit non-zero');
  assert.match(out, /UNDETERMINED/);
  assert.doesNotMatch(out, /contract\(s\) no longer hold/, 'a missing instrument is not a broken contract');
});

test('the maxConcurrent default is REPORTED and warns an unpinned box, but never gates', () => {
  const { code, out } = runGuard(writeFakeDist());
  assert.equal(code, 0, 'the concurrency default must never fail the gate');
  assert.match(out, /maxConcurrent default\s+INFO\s+formula: min\(MAX=16, max\(MIN=8, cpus\)\)/);
  assert.match(out, /sets no agents\.defaults\.maxConcurrent/, 'an unpinned box must be warned');
});
