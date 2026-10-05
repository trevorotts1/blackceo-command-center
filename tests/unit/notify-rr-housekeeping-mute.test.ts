/**
 * Board-housekeeping alerts (stale-task-sweep, board-hygiene, stop-card, QC holds)
 * must NEVER file a Rescue Rangers ticket; a genuine escalation still does.
 * Run: node --import tsx --test tests/unit/notify-rr-housekeeping-mute.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function capture() {
  const posts: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init?: { body?: string }) => {
    posts.push(JSON.parse(String(init?.body ?? '{}')));
    return { ok: true } as Response;
  }) as typeof globalThis.fetch;
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
  process.env.RESCUE_RANGERS_WEBHOOK_URL = 'https://rescue.example.invalid/hook';
  return { posts, restore: () => { globalThis.fetch = realFetch; delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST; delete process.env.RESCUE_RANGERS_WEBHOOK_URL; } };
}

test('housekeeping alerts produce zero Rescue Rangers posts', async () => {
  const cap = capture();
  try {
    const { notifySystem } = await import('../../src/lib/notify');
    notifySystem('[STALE-BLOCKED] Task "x" has been waiting in Blocked for over 2h. Missing: SOP', { agent: 'stale-task-sweep', action: 'escalate' });
    notifySystem('blocked task needs a persona', { agent: 'board-hygiene', action: 'escalate' });
    notifySystem('[stopped] card stopped', { agent: 'some-source', action: 'escalate' });
    notifySystem('[QC-SYSTEM-BLOCK] "t" failed QC', { agent: 'qc-scorer', action: 'system_block' });
    notifySystem('[persona-grounding] sweep found gaps');
    assert.equal(cap.posts.length, 0);
  } finally { cap.restore(); }
});

test('a genuine escalation still posts to Rescue Rangers', async () => {
  const cap = capture();
  try {
    const { notifySystem } = await import('../../src/lib/notify');
    assert.equal(notifySystem('model catalog refused mass deprecation', { agent: 'refresh-models', action: 'escalate' }), true);
    assert.equal(cap.posts.length, 1);
  } finally { cap.restore(); }
});
