/**
 * F51 (Rescue Rangers 2026-10) — rung 1 of notifySystem() is an ALLOW-LIST.
 *
 * Rescue Rangers is posted only when the caller sets meta.action === 'escalate'
 * AND the alert is not board housekeeping. meta.action is otherwise an event type
 * ('qc_starved', 'daily_digest', 'publish_failed'...), and callers with no meta
 * stay on the box. Offline: fetch is a test double, the webhook host is .invalid.
 *
 * Run: node --import tsx --test tests/unit/notify-rr-allowlist.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function capture() {
  const posts: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init?: { body?: string }) => {
    posts.push(JSON.parse(String(init?.body ?? '{}')));
    return { ok: true } as Response;
  }) as typeof globalThis.fetch;
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
  process.env.RESCUE_RANGERS_WEBHOOK_URL = 'https://rescue.example.invalid/hook';
  return {
    posts,
    restore: () => {
      globalThis.fetch = realFetch;
      delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
      delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
    },
  };
}

// The nine real caller shapes named in RR-011-02 (message text trimmed, agent/action exact).
const CHATTER: Array<[string, string, { agent?: string; action?: string }]> = [
  ['task-dispatcher routed_but_not_dispatched', '[routed_but_not_dispatched] Task "t" (id) routed to "a" but NO runtime', { agent: 'auto-dispatch', action: 'escalate' }],
  ['task-dispatcher podcast_activation_refused', '[podcast_activation_refused] Task "t" (id) is a podcast task', { agent: 'auto-dispatch', action: 'escalate' }],
  ['task-dispatcher podcast_skill_not_resolvable', '[podcast_skill_not_resolvable] Task "t" (id) is a podcast task', { agent: 'auto-dispatch', action: 'escalate' }],
  ['board-jobs-watchdog', '[BOARD JOBS WATCHDOG] sweep stalled', { agent: 'board-jobs-watchdog', action: 'escalate' }],
  ['trust-engine', '[trust-engine] completion_notification_held: x', { agent: 'trust-engine', action: 'escalate' }],
  ['social-publish-dispatcher publish_failed', 'Skill 35 publish p1 (topic "t") FAILED after 3 attempts: x', { agent: 'social-publish-dispatcher', action: 'publish_failed' }],
  ['social-account-health', 'Social delivery for provider "x" is PAUSED', { agent: 'social-account-health', action: 'provider_delivery_paused' }],
  ['stage-timings-guard', '[STAGE TIMINGS FLOOD] too many rows', { agent: 'stage-timings-ingest', action: 'escalate' }],
  ['operator-column-age-digest', 'Cards waiting in columns: 3', { agent: 'operator-column-age-digest', action: 'daily_digest' }],
  ['board-hygiene event type', 'QC starvation: 4 cards', { agent: 'board-hygiene', action: 'qc_starved' }],
  ['persona-grounding event type', 'Persona grounding degraded', { agent: 'persona-grounding-sweep', action: 'grounding_degraded' }],
  ['no meta at all (social/summary.ts defaultSend)', 'weekly social summary', {}],
];

test('F51: board chatter shapes are NOT posted to Rescue Rangers', async () => {
  const cap = capture();
  try {
    const { notifySystem, shouldPostToRescueRangers } = await import('../../src/lib/notify');
    for (const [label, message, meta] of CHATTER) {
      assert.equal(shouldPostToRescueRangers(message, meta), false, `${label}: predicate`);
      notifySystem(message, meta.agent || meta.action ? meta : undefined);
    }
    assert.equal(cap.posts.length, 0, 'zero Rescue Rangers posts for every chatter shape');
  } finally {
    cap.restore();
  }
});

test('F51: an action "escalate" outage IS posted', async () => {
  const cap = capture();
  try {
    const { notifySystem } = await import('../../src/lib/notify');
    notifySystem('🚨 Model catalog: refused mass deprecation', { agent: 'refresh-models', action: 'escalate' });
    notifySystem('port-integrity: CC port/ingress drift detected — listening on 4001', { agent: 'port-integrity', action: 'escalate' });
    assert.equal(cap.posts.length, 2, 'both genuine outages reach Rescue Rangers');
    assert.equal(cap.posts[0].action, 'escalate');
    assert.equal(cap.posts[1].agent, 'port-integrity');
  } finally {
    cap.restore();
  }
});

test('F51: action "escalate" does not rescue a housekeeping alert; a non-escalate word does not post an outage', async () => {
  const cap = capture();
  try {
    const { shouldPostToRescueRangers } = await import('../../src/lib/notify');
    assert.equal(shouldPostToRescueRangers('[STALE-BLOCKED] t waiting', { agent: 'stale-task-sweep', action: 'escalate' }), false);
    assert.equal(shouldPostToRescueRangers('real outage', { agent: 'refresh-models', action: 'qc_starved' }), false);
    assert.equal(shouldPostToRescueRangers('real outage', { agent: 'refresh-models' }), false);
    assert.equal(shouldPostToRescueRangers('real outage'), false);
    assert.equal(shouldPostToRescueRangers('real outage', { agent: 'refresh-models', action: 'escalate' }), true);
  } finally {
    cap.restore();
  }
});

test('F51: isTestEnvironment still blocks the POST unless the test opts in', async () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called++;
    return { ok: true } as Response;
  }) as typeof globalThis.fetch;
  delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
  process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
  process.env.RESCUE_RANGERS_WEBHOOK_URL = 'https://rescue.example.invalid/hook';
  try {
    const { notifySystem } = await import('../../src/lib/notify');
    notifySystem('real outage', { agent: 'refresh-models', action: 'escalate' });
    assert.equal(called, 0, 'no network from a test run without the explicit opt-in');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
  }
});
