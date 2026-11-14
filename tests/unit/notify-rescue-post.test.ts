/**
 * RRX-017 — the Rescue Rangers POST inside notifySystem().
 *
 * The defect: the POST was fire-and-forget with a `.catch()` that only logged a
 * warning, so a refused alert (403 from the receiver, a transport failure)
 * ceased to exist — no durable record anywhere. The body also carried only the
 * identity fields, so intake could not place the case (no problem text, no
 * person, no version, no already-tried, no return-to), and every alert was an
 * anonymous duplicate: a retry or a second process opened a second ticket.
 *
 * This file proves the repair:
 *   (a) a 200 answer writes NO line to notification-failures.jsonl;
 *   (b) a  403 answer writes one line, kind `rescue_rangers_post_refused`;
 *   (c) a rejected promise writes one line, kind `rescue_rangers_post_failed`;
 *   (d) the body carries request_id, problem, person, alreadyTried,
 *       openclawVersion and returnTo;
 *   (e) two calls with the same message inside one window send the same
 *       request_id.
 *
 * SAFETY: no packet leaves the process — globalThis.fetch is replaced with a
 * double for every case and restored in `finally`; OPENCLAW_WORKSPACE_PATH
 * points at a temporary folder so the ledger lands there, never on a real box.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-notify-rrpost-'));

/** Fresh workspace per case so the JSONL ledger starts empty. */
function freshWorkspace(name: string): string {
  const dir = path.join(TMP_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ledgerLines(workspace: string): Array<Record<string, any>> {
  const file = path.join(workspace, 'notification-failures.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** The POST is fire-and-forget; let its .then/.catch chain settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

type NotifyModule = typeof import('../../src/lib/notify');

/** Run one notifySystem() call against a fetch double, isolated. */
async function runNotifySystem(opts: {
  workspace: string;
  message: string;
  fetchDouble: () => Promise<{ ok: boolean; status: number }>;
  bodies: string[];
  calls?: number;
}): Promise<void> {
  const savedWorkspace = process.env.OPENCLAW_WORKSPACE_PATH;
  const savedWebhook = process.env.RESCUE_RANGERS_WEBHOOK_URL;
  const savedOptIn = process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
  const savedFetch = globalThis.fetch;

  process.env.OPENCLAW_WORKSPACE_PATH = opts.workspace;
  // A webhook must be configured for rung 1 to run at all.
  process.env.RESCUE_RANGERS_WEBHOOK_URL = 'https://rescue.invalid/webhook';
  // Deliberate opt-in, coupled to the fetch double below (SAFETY-06 contract).
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    opts.bodies.push(String(init?.body ?? ''));
    return opts.fetchDouble();
  }) as unknown as typeof fetch;

  try {
    const { notifySystem } = (await import('../../src/lib/notify')) as NotifyModule;
    // `action: 'escalate'` is required by the F51 allow-list; a fresh message
    // per case keeps it out of no housekeeping class.
    for (let i = 0; i < (opts.calls ?? 1); i += 1) {
      notifySystem(opts.message, { agent: 'notify-rrx017', action: 'escalate' });
    }
    await settle();
  } finally {
    globalThis.fetch = savedFetch;
    if (savedWorkspace === undefined) delete process.env.OPENCLAW_WORKSPACE_PATH;
    else process.env.OPENCLAW_WORKSPACE_PATH = savedWorkspace;
    if (savedWebhook === undefined) delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
    else process.env.RESCUE_RANGERS_WEBHOOK_URL = savedWebhook;
    if (savedOptIn === undefined) delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
    else process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = savedOptIn;
  }
}

// ── (a) a 200 answer writes no line ──────────────────────────────────────────
test('RRX-017: a 200 answer from the receiver writes no line to the ledger', async () => {
  const workspace = freshWorkspace('ok');
  const bodies: string[] = [];

  await runNotifySystem({
    workspace,
    message: '[rrx017-ok] accepted alert',
    fetchDouble: async () => ({ ok: true, status: 200 }),
    bodies,
  });

  assert.equal(bodies.length, 1, 'exactly one POST must be sent');
  assert.deepEqual(ledgerLines(workspace), [], 'a delivered alert must leave no failure line');
});

// ── (b) a 403 answer writes one refusal line ─────────────────────────────────
test('RRX-017: a 403 answer writes one rescue_rangers_post_refused line', async () => {
  const workspace = freshWorkspace('refused');
  const bodies: string[] = [];

  await runNotifySystem({
    workspace,
    message: '[rrx017-refused] unauthorized alert',
    fetchDouble: async () => ({ ok: false, status: 403 }),
    bodies,
  });

  const lines = ledgerLines(workspace);
  assert.equal(lines.length, 1, 'a refused alert must leave exactly one durable line');
  assert.equal(lines[0].kind, 'rescue_rangers_post_refused');
  assert.match(String(lines[0].message), /HTTP 403/);
  assert.match(String(lines[0].message), /rrx017-refused/);
});

// ── (c) a rejected promise writes one failure line ───────────────────────────
test('RRX-017: a rejected POST writes one rescue_rangers_post_failed line', async () => {
  const workspace = freshWorkspace('failed');
  const bodies: string[] = [];

  await runNotifySystem({
    workspace,
    message: '[rrx017-failed] transport down alert',
    fetchDouble: async () => {
      throw new Error('socket hang up');
    },
    bodies,
  });

  const lines = ledgerLines(workspace);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'rescue_rangers_post_failed');
  assert.match(String(lines[0].message), /socket hang up/);
  assert.match(String(lines[0].message), /rrx017-failed/);
});

// ── (d) the body carries the full intake field set ───────────────────────────
test('RRX-017: the POST body carries request_id, problem, person, alreadyTried, openclawVersion, returnTo', async () => {
  const workspace = freshWorkspace('fields');
  const bodies: string[] = [];

  await runNotifySystem({
    workspace,
    message: '[rrx017-fields] a full alert',
    fetchDouble: async () => ({ ok: true, status: 200 }),
    bodies,
  });

  assert.equal(bodies.length, 1);
  const body = JSON.parse(bodies[0]) as Record<string, unknown>;
  for (const key of [
    'request_id',
    'problem',
    'person',
    'alreadyTried',
    'openclawVersion',
    'returnTo',
  ]) {
    assert.ok(key in body, `body must carry ${key}`);
    assert.notEqual(String(body[key] ?? '').length, 0, `${key} must not be empty`);
  }
  assert.equal(body.problem, '[rrx017-fields] a full alert');
  assert.equal(body.person, 'operator');
  // The legacy field is kept for the existing receiver.
  assert.equal(body.message, '[rrx017-fields] a full alert');
});

// ── (e) two calls in one window share one request_id ─────────────────────────
test('RRX-017: two calls with the same message inside one window send the same request_id', async () => {
  const workspace = freshWorkspace('dedup');
  const bodies: string[] = [];

  await runNotifySystem({
    workspace,
    message: '[rrx017-dedup] same alert twice',
    fetchDouble: async () => ({ ok: true, status: 200 }),
    bodies,
    calls: 2,
  });

  assert.equal(bodies.length, 2, 'both calls POST');
  const first = JSON.parse(bodies[0]) as Record<string, unknown>;
  const second = JSON.parse(bodies[1]) as Record<string, unknown>;
  assert.ok(typeof first.request_id === 'string' && String(first.request_id).length > 0);
  assert.match(String(first.request_id), /^cc-[0-9a-f]{40}$/);
  assert.equal(
    first.request_id,
    second.request_id,
    'the same alert inside one 15-minute window must carry ONE identifier',
  );
});
