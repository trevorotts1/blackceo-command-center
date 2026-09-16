/**
 * notify-rescue-webhook-auth-header.test.ts — 2026-09-16.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * notifySystem() POSTed to the Rescue Rangers escalation webhook WITHOUT the
 * X-Rescue-Secret header. RR-01-intake's webhook auth is fail-closed, so every
 * escalation from this module was rejected at 'Respond - Unauthorized'. Observed
 * live on 2026-09-16: 55 of the latest 60 intake executions were this module's
 * POSTs (grounding_degraded / triad_stall actions), all rejected.
 *
 * PROVES:
 *   1. When RESCUE_RANGERS_WEBHOOK_SECRET is set, the POST carries it in
 *      X-Rescue-Secret (value sourced from env, never hardcoded).
 *   2. When the var is unset, no header is sent (the receiver still rejects;
 *      the best-effort contract is unchanged).
 *
 * Run: node --import tsx --test tests/unit/notify-rescue-webhook-auth-header.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const WEBHOOK = 'https://rescue.example.invalid/webhook/escalate';

interface CapturedPost {
  url: string;
  headers: Record<string, string> | undefined;
  body: string;
}

function captureWebhook(): { posts: CapturedPost[]; restore: () => void } {
  const posts: CapturedPost[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string>; body?: string }) => {
    posts.push({ url: String(url), headers: { ...(init?.headers ?? {}) }, body: String(init?.body ?? '{}') });
    return { ok: true } as Response;
  }) as typeof globalThis.fetch;
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  return {
    posts,
    restore: () => {
      globalThis.fetch = realFetch;
      delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
    },
  };
}

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-webhook-auth-'));
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

async function freshNotify() {
  const mod = await import(`../../src/lib/notify?u=${Math.random()}`);
  return mod as typeof import('../../src/lib/notify');
}

function cleanEnv(): void {
  delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
  delete process.env.RESCUE_RANGERS_WEBHOOK_SECRET;
  delete process.env.CC_CLIENT_NAME;
  delete process.env.CC_BOX_NAME;
  delete process.env.OPENCLAW_BOX_NAME;
  delete process.env.CC_BOX_TYPE;
  delete process.env.CC_OPERATOR_CHAT_ID;
  delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
  delete process.env.OPENCLAW_OWNER_CHAT_ID;
  process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
}

test('AUTH: when the secret is configured the escalation POST carries X-Rescue-Secret from env', async () => {
  cleanEnv();
  makeWorkspace();
  process.env.RESCUE_RANGERS_WEBHOOK_URL = WEBHOOK;
  process.env.RESCUE_RANGERS_WEBHOOK_SECRET = 'test-secret-value-0001';

  const cap = captureWebhook();
  try {
    const notify = await freshNotify();
    const dispatched = notify.notifySystem('71 tasks blocked on human input', {
      agent: 'stale-task-sweep',
      action: 'triad_stall',
    });

    assert.equal(dispatched, true, 'the escalation must still fire');
    assert.equal(cap.posts.length, 1, 'exactly one POST');
    assert.equal(cap.posts[0].url, WEBHOOK);
    assert.equal(
      cap.posts[0].headers['X-Rescue-Secret'],
      'test-rescue-webhook-auth-header-test-value-0001'.slice(0, 0) || 'test-secret-value-0001',
      'the header must carry the env value verbatim',
    );
    assert.equal(cap.posts[0].headers['Content-Type'], 'application/json');
  } finally {
    cap.restore();
  }
});

test('AUTH: without the secret the module sends no auth header and still best-effort fires', async () => {
  cleanEnv();
  makeWorkspace();
  process.env.RESCUE_RANGERS_WEBHOOK_URL = WEBHOOK;

  const cap = captureWebhook();
  try {
    const notify = await freshNotify();
    const dispatched = notify.notifySystem('sweep blocked', {
      agent: 'board-hygiene',
      action: 'triad_stall',
    });

    assert.equal(dispatched, true, 'best-effort dispatch unchanged when unset');
    assert.equal(cap.posts.length, 1, 'exactly one POST');
    assert.equal('X-Rescue-Secret' in cap.posts[0].headers, false, 'no empty header is sent');
  } finally {
    cap.restore();
  }
});
