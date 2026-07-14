/**
 * notify-escalation-attribution.test.ts — FIX-5.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `notifySystem()` POSTed `{action, agent, message}` to the Rescue Rangers
 * escalation webhook and nothing else. No client. No box. Two consequences, both
 * observed live during an escalation flood:
 *
 *   1. NOT ATTRIBUTABLE — every escalation from every box in the fleet arrived
 *      anonymous. With the channel flooded, the operator could not tell WHICH box
 *      was screaming; the source was identified only by tracing the webhook's
 *      `x-real-ip`.
 *   2. ONE SHARED CAP — the fleet's documented escalation budget is "25 exchanges
 *      per client per day". With no client on the payload the receiver has no key
 *      to bucket by, so ALL boxes share ONE counter: a single runaway box eats the
 *      whole fleet's budget and silences everyone else.
 *
 * THE FIX IS ATTRIBUTION, NOT MUTING. Nothing here reduces how often an escalation
 * fires. The payload just now says who it is from — using the SAME field names the
 * rest of the fleet already sends (clientName / agentName / boxName / boxType; see
 * fleet-heartbeat/scripts/propagate-rescue-webhook.sh), plus a derived stable
 * `boxId` for the receiver to key its per-client cap and dedup on.
 *
 * PROVES:
 *   1. An escalation payload CARRIES the client/box identity fields. (Fails on
 *      pre-fix code: every identity field is `undefined`.)
 *   2. Two different boxes produce DIFFERENT cap keys — so a per-client cap is
 *      possible at all. (Fails on pre-fix code: the two bodies are byte-identical.)
 *   3. FAIL-OPEN: an unbranded/unresolvable box STILL escalates — it just does so
 *      as `unknown-client`. Identity can never suppress an alarm.
 *   4. No real client name is compiled into this fleet-wide repo: identity comes
 *      from env / the box's own config, and the unpopulated repo template resolves
 *      to `unknown-client`, never to a brand.
 *   5. The durable last-rung record (notification-failures.jsonl) is attributable
 *      too — a human reading it cold can tell which box wrote it.
 *
 * Run: node --import tsx --test tests/unit/notify-escalation-attribution.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const WEBHOOK = 'https://rescue.example.invalid/webhook/escalate';

interface EscalationBody {
  action?: string;
  agent?: string;
  agentName?: string;
  clientName?: string;
  boxName?: string;
  boxType?: string;
  boxId?: string;
  message?: string;
}

/** Capture every escalation POST the module fires, without leaving the process. */
function captureWebhook(): { posts: EscalationBody[]; restore: () => void } {
  const posts: EscalationBody[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    posts.push(JSON.parse(String(init?.body ?? '{}')) as EscalationBody);
    return { ok: true } as Response;
  }) as typeof globalThis.fetch;
  return {
    posts,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/** A throwaway workspace with NO operator/owner chat — Telegram rungs stay quiet. */
function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-attribution-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'openclaw.json'),
    JSON.stringify({ channels: { telegram: { allowFrom: [] } } }),
    'utf8',
  );
  process.env.OPENCLAW_WORKSPACE_PATH = workspace;
  return workspace;
}

/** notify.ts reads env at import time — each scenario gets its own instance. */
async function freshNotify() {
  const mod = await import(`../../src/lib/notify?u=${Math.random()}`);
  return mod as typeof import('../../src/lib/notify');
}

function cleanEnv(): void {
  delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
  delete process.env.CC_CLIENT_NAME;
  delete process.env.CC_BOX_NAME;
  delete process.env.OPENCLAW_BOX_NAME;
  delete process.env.CC_BOX_TYPE;
  delete process.env.CC_OPERATOR_CHAT_ID;
  delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
  delete process.env.OPENCLAW_OWNER_CHAT_ID;
  // NOTE: COMPANY_NAME is deliberately never set by this suite — company-config
  // caches its parse, so touching it would leak state across scenarios.
  process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
}

// ─── 1. THE HEADLINE: the escalation payload is ATTRIBUTABLE ─────────────────
test('FIX-5: an escalation payload carries the box/client identity fields', async () => {
  cleanEnv();
  makeWorkspace();
  process.env.RESCUE_RANGERS_WEBHOOK_URL = WEBHOOK;
  process.env.CC_CLIENT_NAME = 'Placeholder Client A';
  process.env.CC_BOX_NAME = 'box-alpha-01';
  process.env.CC_BOX_TYPE = 'VPS';

  const cap = captureWebhook();
  try {
    const notify = await freshNotify();
    const dispatched = notify.notifySystem('71 tasks blocked on human input', {
      agent: 'stale-task-sweep',
      action: 'escalate',
    });

    assert.equal(dispatched, true, 'the escalation must still fire — this fix never mutes');
    assert.equal(cap.posts.length, 1, 'exactly one escalation POST');

    const body = cap.posts[0];
    // The identity half of the fleet's canonical escalation schema.
    assert.equal(body.clientName, 'Placeholder Client A', 'the payload names the CLIENT');
    assert.equal(body.boxName, 'box-alpha-01', 'the payload names the BOX');
    assert.equal(body.boxType, 'VPS', 'the payload states the box TYPE');
    assert.equal(
      body.boxId,
      'placeholder-client-a:box-alpha-01',
      'a stable <client>:<box> key the receiver can bucket the 25/day cap on',
    );
    assert.equal(body.agentName, 'stale-task-sweep', 'canonical agentName field is present');

    // …and the pre-existing contract is untouched (backward compatible).
    assert.equal(body.action, 'escalate');
    assert.equal(body.agent, 'stale-task-sweep');
    assert.equal(body.message, '71 tasks blocked on human input');
  } finally {
    cap.restore();
  }
});

// ─── 2. THE CAP: two boxes must be DISTINGUISHABLE, or the cap cannot bucket ──
test('FIX-5: two different boxes produce different cap keys (no shared fleet counter)', async () => {
  cleanEnv();
  makeWorkspace();
  process.env.RESCUE_RANGERS_WEBHOOK_URL = WEBHOOK;

  const cap = captureWebhook();
  try {
    process.env.CC_CLIENT_NAME = 'Placeholder Client A';
    process.env.CC_BOX_NAME = 'box-alpha-01';
    const notifyA = await freshNotify();
    notifyA.notifySystem('same message text from both boxes', { agent: 'board-hygiene' });

    process.env.CC_CLIENT_NAME = 'Placeholder Client B';
    process.env.CC_BOX_NAME = 'box-bravo-01';
    const notifyB = await freshNotify();
    notifyB.notifySystem('same message text from both boxes', { agent: 'board-hygiene' });

    assert.equal(cap.posts.length, 2);
    const [a, b] = cap.posts;
    assert.notEqual(
      a.clientName,
      b.clientName,
      'the receiver must be able to tell the two clients apart to cap them separately',
    );
    assert.notEqual(a.boxId, b.boxId, 'distinct cap/dedup keys per box');
    assert.equal(a.message, b.message, 'identical text — ONLY the identity distinguishes them');
  } finally {
    cap.restore();
  }
});

// ─── 3 + 4. FAIL-OPEN: an unidentifiable box still escalates, and no brand leaks ─
test('FIX-5: an unbranded box still escalates — anonymously, never silently', async () => {
  cleanEnv();
  makeWorkspace();
  process.env.RESCUE_RANGERS_WEBHOOK_URL = WEBHOOK;
  // No CC_CLIENT_NAME, no COMPANY_NAME: the repo template config is all there is.

  const cap = captureWebhook();
  try {
    const notify = await freshNotify();
    const dispatched = notify.notifySystem('gateway down', { agent: 'sweep-liveness' });

    assert.equal(dispatched, true, 'FAIL-OPEN: identity must NEVER be a reason not to escalate');
    assert.equal(cap.posts.length, 1, 'the escalation still goes out');

    const body = cap.posts[0];
    assert.equal(
      body.clientName,
      'unknown-client',
      'an unbranded box is honestly anonymous — never mis-attributed to a brand',
    );
    assert.ok(body.boxName && body.boxName.length > 0, 'the box still names itself (hostname)');
    assert.equal(body.message, 'gateway down', 'the alarm content is unchanged');
  } finally {
    cap.restore();
  }
});

// ─── 5. The durable last rung is attributable too ────────────────────────────
test('FIX-5: the durable undeliverable record names the client and box', async () => {
  cleanEnv();
  const workspace = makeWorkspace();
  // No webhook, no operator chat: nothing is reachable — the worst case.
  process.env.CC_CLIENT_NAME = 'Placeholder Client A';
  process.env.CC_BOX_NAME = 'box-alpha-01';

  const cap = captureWebhook();
  try {
    const notify = await freshNotify();
    const dispatched = notify.notifySystem('nothing reachable');
    assert.equal(dispatched, false, 'nothing was reachable…');

    const ledger = path.join(workspace, 'notification-failures.jsonl');
    assert.ok(fs.existsSync(ledger), '…so the alert must still leave a durable trace');
    const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
    const rec = JSON.parse(lines[lines.length - 1]) as {
      kind: string;
      message: string;
      clientName?: string;
      boxName?: string;
      boxId?: string;
    };
    assert.equal(rec.kind, 'system_alert');
    assert.equal(rec.message, 'nothing reachable');
    assert.equal(rec.clientName, 'Placeholder Client A', 'the record says WHOSE box wrote it');
    assert.equal(rec.boxName, 'box-alpha-01');
    assert.equal(rec.boxId, 'placeholder-client-a:box-alpha-01');
  } finally {
    cap.restore();
  }
});
