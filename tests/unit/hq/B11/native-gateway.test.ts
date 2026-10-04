/**
 * B11 — SPEC S9 native wire adapter (HQ chat payload normalization).
 *
 * Proves, against the REAL `runHqNativeTurn` and the REAL `OpenClawClient`
 * frame dispatcher (in-memory socket, no live gateway):
 *
 *   Q07-list: native EventFrame success; cumulative-message vs delta
 *   replacement; duplicate/old seq; foreign session/run; final-empty /
 *   yielded / aborted / error; subscribe failure; timeout after partial
 *   output; late-A-after-B leaves B unchanged; legacy method notification
 *   positive control (pre-existing callers unchanged).
 *
 * Every assertion below is one S9 clause. Deleting the clause's line in
 * `src/lib/ceo-chat/gateway.ts` fails exactly the matching test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

// The real client reads/creates a device identity at construction. Seed a
// private ephemeral identity so no installed key is read or copied.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-b-B11-identity-'));
process.env.BCC_DEVICE_IDENTITY_DIR = fixture;
{
  const pair = generateKeyPairSync('ed25519');
  fs.writeFileSync(
    path.join(fixture, 'device.json'),
    JSON.stringify({
      version: 1,
      deviceId: 'fixture',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      createdAtMs: Date.now(),
    }),
    { mode: 0o600 },
  );
}

const CLIENT = '../../../../src/lib/openclaw/client';
const GATEWAY = '../../../../src/lib/ceo-chat/gateway';

type Frame = { type?: string; id?: string; method?: string; payload?: unknown; [k: string]: unknown };

/** In-memory gateway socket: records requests, replays scripted responses. */
class FixtureSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static latest: FixtureSocket;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  requests: Frame[] = [];
  /** method -> responder */
  responders = new Map<string, (frame: Frame, socket: FixtureSocket) => void>();

  constructor() {
    FixtureSocket.latest = this;
    queueMicrotask(() => {
      this.onopen?.();
      this.receive({ type: 'event', event: 'connect.challenge', payload: { nonce: randomUUID() } });
    });
  }
  receive(frame: Frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  send(raw: string) {
    const frame = JSON.parse(raw) as Frame;
    this.requests.push(frame);
    const responder = frame.method ? this.responders.get(frame.method) : undefined;
    if (frame.method === 'connect') {
      queueMicrotask(() => this.receive({ type: 'res', id: frame.id, ok: true, payload: {} }));
      return;
    }
    if (responder) queueMicrotask(() => responder(frame, this));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  framesFor(method: string): Frame[] {
    return this.requests.filter((r) => r.method === method);
  }
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** Connect the real client to the fixture socket and return both. */
async function connectedClient() {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  const { OpenClawClient } = await import(CLIENT);
  const client = new OpenClawClient('ws://127.0.0.1:1', 'fixture-only');
  await client.connect();
  const socket = FixtureSocket.latest;
  return { client, socket, restore: () => { globalThis.WebSocket = original; } };
}

const TURN = { sessionId: 'hq-session-1', turnId: 'turn-1', runtimeId: 'head-a', message: 'hello' };
const KEY = 'agent:head-a:hq-turn-1';

/** Script: subscribe ok, send ok. Returns nothing — frames are injected by the caller. */
function scriptHappyPath(socket: FixtureSocket) {
  socket.responders.set('sessions.messages.subscribe', (frame, s) =>
    s.receive({ type: 'res', id: frame.id, ok: true, payload: { subscribed: true, key: KEY, agentId: 'head-a' } }),
  );
  socket.responders.set('sessions.send', (frame, s) =>
    s.receive({ type: 'res', id: frame.id, ok: true, payload: { ok: true, runId: 'run-A', sessionKey: KEY } }),
  );
  socket.responders.set('sessions.messages.unsubscribe', (frame, s) =>
    s.receive({ type: 'res', id: frame.id, ok: true, payload: { subscribed: false, key: KEY } }),
  );
}

/** A real server chat frame: `{type:'event',event:'chat',payload,seq}` where
 *  the channel-level `seq` sits BESIDE the payload (frameWithSequence in the
 *  installed gateway), not inside it. */
function chatFrame(payload: Record<string, unknown>): Frame {
  return { type: 'event', event: 'chat', seq: payload.seq, payload };
}

test('B11/S9 native EventFrame: subscribe precedes send, success requires final with visible text', async (t) => {
  const { client, socket, restore } = await connectedClient();
  try {
    const { runHqNativeTurn } = await import(GATEWAY);
    scriptHappyPath(socket);
    const lifecycle: string[] = [];
    const promise = runHqNativeTurn(TURN, {
      client,
      onLifecycle: (e) => lifecycle.push(e.kind),
    });
    await flush();

    // 1. ORDER: subscribe was issued, and send came AFTER it.
    const subscribeIdx = socket.requests.findIndex((r) => r.method === 'sessions.messages.subscribe');
    const sendIdx = socket.requests.findIndex((r) => r.method === 'sessions.send');
    assert.notEqual(subscribeIdx, -1, 'subscribe must be issued');
    assert.notEqual(sendIdx, -1, 'send must be issued');
    assert.ok(subscribeIdx < sendIdx, 'subscription must be established BEFORE send is issued');

    // Unique per-turn key and the S9 subscriptionId.
    const subParams = socket.framesFor('sessions.messages.subscribe')[0].params as Record<string, unknown>;
    assert.equal(subParams.key, KEY, 'gateway key is agent:<runtimeId>:hq-<turnId>');
    assert.equal(subParams.agentId, 'head-a');
    assert.equal(subParams.subscriptionId, 'hq-turn-1', "subscriptionId is 'hq-' + turnId");
    const sendParams = socket.framesFor('sessions.send')[0].params as Record<string, unknown>;
    assert.equal(sendParams.key, KEY, 'send addresses the same unique per-turn key');

    // 2. Delta streaming, then a final with visible text == replied.
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, agentId: 'head-a', seq: 1, state: 'delta', deltaText: 'Hel' }));
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, agentId: 'head-a', seq: 2, state: 'delta', deltaText: 'lo' }));
    socket.receive(chatFrame({
      runId: 'run-A', sessionKey: KEY, agentId: 'head-a', seq: 3, state: 'final',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    }));
    const result = await promise;
    assert.equal(result.outcome, 'replied');
    assert.equal(result.text, 'Hello');
    assert.equal(result.partial, false, 'a replied turn is no longer partial');
    assert.equal(result.runId, 'run-A');
    assert.ok(lifecycle.includes('send_accepted'), 'send_accepted fires after the send response');
    assert.ok(lifecycle.includes('completion_observed'), 'completion_observed fires on matching final');

    // 3. Cleanup released THIS turn's subscription by matching id.
    await flush();
    const unsub = socket.framesFor('sessions.messages.unsubscribe');
    assert.equal(unsub.length, 1, 'exactly one unsubscribe');
    assert.equal((unsub[0].params as Record<string, unknown>).subscriptionId, 'hq-turn-1');
  } finally {
    client.disconnect();
    restore();
  }
});

test('B11/S9 delta: cumulative assistant message REPLACES and never concatenates with deltaText', async (t) => {
  const { client, socket, restore } = await connectedClient();
  try {
    const { runHqNativeTurn } = await import(GATEWAY);
    scriptHappyPath(socket);
    const promise = runHqNativeTurn(TURN, { client });
    await flush();
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, seq: 1, state: 'delta', deltaText: 'abc' }));
    // Cumulative authoritative message + deltaText in the SAME frame: the
    // message wins outright; 'XYZ' must never be appended to it.
    socket.receive(chatFrame({
      runId: 'run-A', sessionKey: KEY, seq: 2, state: 'delta', deltaText: 'XYZ',
      message: { role: 'assistant', content: [{ type: 'text', text: 'abcd' }] },
    }));
    // replace:true with no cumulative message replaces with deltaText.
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, seq: 3, state: 'delta', deltaText: 'fresh', replace: true }));
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, seq: 4, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text: 'fresh' }] } }));
    const result = await promise;
    assert.equal(result.outcome, 'replied');
    assert.equal(result.text, 'fresh', 'cumulative replaces; replace:true replaces; never concatenated');
  } finally {
    client.disconnect();
    restore();
  }
});

test('B11/S9 seq dedup + only text blocks visible: duplicate/old seq dropped, thinking bodies never rendered', async (t) => {
  const { client, socket, restore } = await connectedClient();
  try {
    const { runHqNativeTurn } = await import(GATEWAY);
    scriptHappyPath(socket);
    const promise = runHqNativeTurn(TURN, { client });
    await flush();
    // Same (runId,seq) with DIFFERENT text: the client's content-hash cache
    // cannot catch these, so this is the adapter's OWN seq dedup under test.
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, seq: 5, state: 'delta', deltaText: 'one' }));
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, seq: 5, state: 'delta', deltaText: 'REPLAY' })); // same seq, new content
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, seq: 4, state: 'delta', deltaText: 'stale' })); // older seq
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, seq: 6, state: 'delta', deltaText: 'two' }));
    // Thinking/tool/attachment blocks are not visible text.
    socket.receive(chatFrame({
      runId: 'run-A', sessionKey: KEY, seq: 7, state: 'final',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'onetwo' }] },
    }));
    const result = await promise;
    assert.equal(result.outcome, 'replied');
    assert.equal(result.text, 'onetwo', 'duplicates and stale seq dropped; non-text blocks excluded');
  } finally {
    client.disconnect();
    restore();
  }
});

test('B11/S9 matching: a foreign session key and a foreign run never touch this turn', async (t) => {
  const { client, socket, restore } = await connectedClient();
  try {
    const { runHqNativeTurn } = await import(GATEWAY);
    scriptHappyPath(socket);
    const promise = runHqNativeTurn(TURN, { client, timeoutMs: 150 });
    await flush();
    // Foreign session key: dropped outright.
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: 'agent:other:hq-other', seq: 1, state: 'delta', deltaText: 'FOREIGN' }));
    // Same key, DIFFERENT run id: ignored/flagged, never relabeled.
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, seq: 2, state: 'delta', deltaText: 'mine' }));
    socket.receive(chatFrame({ runId: 'run-B', sessionKey: KEY, seq: 3, state: 'delta', deltaText: 'OTHER-RUN' }));
    socket.receive(chatFrame({ runId: 'run-B', sessionKey: KEY, seq: 4, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text: 'OTHER-RUN' }] } }));
    const result = await promise;
    assert.equal(result.runId, 'run-A', 'first observed run id is this turn\'s run');
    assert.notEqual(result.outcome, 'replied', 'a foreign run cannot complete this turn');
    assert.equal(result.foreignRunIgnored, true, 'the foreign run id is flagged, not silently dropped');
    assert.ok(!result.text.includes('FOREIGN') && !result.text.includes('OTHER-RUN'), 'foreign text never enters the accumulator');
  } finally {
    client.disconnect();
    restore();
  }
});

test('B11/S9 terminal honesty: final-empty, yielded, aborted and error are NOT replied', async (t) => {
  const { client, socket, restore } = await connectedClient();
  try {
    const { runHqNativeTurn } = await import(GATEWAY);
    const cases: Array<{ name: string; frames: Record<string, unknown>[]; expect: string }> = [
      { name: 'final with no visible text', frames: [{ state: 'final', message: { role: 'assistant', content: [] } }], expect: 'no_visible_reply' },
      { name: 'final with no message at all', frames: [{ state: 'final' }], expect: 'no_visible_reply' },
      { name: 'yielded final is not this turn reply', frames: [{ state: 'final', yielded: true, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }], expect: 'no_visible_reply' },
      { name: 'aborted', frames: [{ state: 'aborted', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } }], expect: 'aborted' },
      { name: 'error', frames: [{ state: 'error', errorMessage: 'boom' }], expect: 'error' },
    ];
    for (const c of cases) {
      scriptHappyPath(socket);
      const kinds: string[] = [];
      const promise = runHqNativeTurn(TURN, { client, timeoutMs: 200, onLifecycle: (e) => kinds.push(e.kind) });
      await flush();
      let seq = 1;
      for (const frame of c.frames) {
        socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, seq: seq++, ...frame }));
      }
      const result = await promise;
      assert.notEqual(result.outcome, 'replied', `${c.name} must never be replied`);
      assert.equal(result.outcome, c.expect, c.name);
      // Non-success terminals are NOT completion observations. Only a matching
      // final with visible text may report completion_observed.
      assert.ok(!kinds.includes('completion_observed'), `${c.name} is not a completion observation`);
      await flush();
    }
  } finally {
    client.disconnect();
    restore();
  }
});

test('B11/S9 subscribe refusal is positively unsent: no send is ever issued', async (t) => {
  const { client, socket, restore } = await connectedClient();
  try {
    const { runHqNativeTurn } = await import(GATEWAY);
    socket.responders.set('sessions.messages.subscribe', (frame, s) =>
      s.receive({ type: 'res', id: frame.id, ok: true, payload: { subscribed: false, key: KEY } }),
    );
    socket.responders.set('sessions.send', (frame, s) =>
      s.receive({ type: 'res', id: frame.id, ok: true, payload: { ok: true } }),
    );
    const kinds: string[] = [];
    const result = await runHqNativeTurn(TURN, { client, onLifecycle: (e) => kinds.push(e.kind) });
    assert.equal(result.outcome, 'subscribe_failed');
    assert.equal(socket.framesFor('sessions.send').length, 0, 'refused subscription means NO send');
    assert.ok(kinds.includes('failed_before_send'), 'refusal is reported as positively unsent');
    assert.ok(!kinds.includes('send_accepted'));
    assert.ok(!kinds.includes('completion_observed'), 'a failed attempt never observes completion');
    await flush();
    assert.equal(socket.framesFor('sessions.messages.unsubscribe').length, 1, 'cleanup runs exactly once, even on the refusal path');
  } finally {
    client.disconnect();
    restore();
  }
});

test('B11/S9 timeout after partial output: explicit timeout, partial labelled, never completion', async (t) => {
  const { client, socket, restore } = await connectedClient();
  try {
    const { runHqNativeTurn } = await import(GATEWAY);
    scriptHappyPath(socket);
    const kinds: string[] = [];
    // NOTE: not `await`ed here — the delta must land while the turn is live.
    const pending = runHqNativeTurn(TURN, { client, timeoutMs: 150, onLifecycle: (e) => kinds.push(e.kind) });
    await flush();
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: KEY, seq: 1, state: 'delta', deltaText: 'half a reply' }));
    const settled = await pending;
    assert.equal(settled.outcome, 'timeout');
    assert.equal(settled.text, 'half a reply', 'partial text is retained');
    assert.equal(settled.partial, true, 'buffered partial text stays labelled partial');
    assert.ok(kinds.includes('timeout'), 'explicit timeout callback');
    assert.ok(!kinds.includes('completion_observed'), 'timeout is NEVER completion');
  } finally {
    client.disconnect();
    restore();
  }
});

test('B11/S9 late-A-after-B: a delayed turn-A frame leaves turn B unchanged', async (t) => {
  const { client, socket, restore } = await connectedClient();
  try {
    const { runHqNativeTurn } = await import(GATEWAY);
    scriptHappyPath(socket);

    // Turn B runs first and completes.
    const turnB = { sessionId: 'hq-session-1', turnId: 'turn-B', runtimeId: 'head-a', message: 'B' };
    const keyB = 'agent:head-a:hq-turn-B';
    const bPromise = runHqNativeTurn(turnB, { client });
    await flush();
    socket.receive(chatFrame({ runId: 'run-B', sessionKey: keyB, seq: 1, state: 'delta', deltaText: 'B-reply' }));
    socket.receive(chatFrame({ runId: 'run-B', sessionKey: keyB, seq: 2, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text: 'B-reply' }] } }));
    const bResult = await bPromise;
    assert.equal(bResult.outcome, 'replied');
    assert.equal(bResult.text, 'B-reply');
    const bTextAtSettle = bResult.text;
    await flush();

    // Turn A starts (a NEW key — never reused) and is abandoned.
    const turnA = { sessionId: 'hq-session-1', turnId: 'turn-A', runtimeId: 'head-a', message: 'A' };
    const keyA = 'agent:head-a:hq-turn-A';
    scriptHappyPath(socket);
    const aPromise = runHqNativeTurn(turnA, { client, timeoutMs: 400 });
    await flush();
    assert.notEqual(keyA, keyB, 'per-turn gateway keys are unique');

    // A late frame addressed to turn-A's key arrives after B settled. It is
    // legitimately A's own frame (A is still awaiting its reply), and it must
    // land ONLY on A — B's settled text/outcome can never move.
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: keyA, seq: 9, state: 'delta', deltaText: 'LATE-A' }));
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: keyA, seq: 10, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text: 'LATE-A' }] } }));

    const aResult = await aPromise;
    assert.equal(aResult.outcome, 'replied', 'the frame addressed to A completes A');
    assert.equal(aResult.text, 'LATE-A', 'and never leaks into B');
    assert.equal(bResult.text, bTextAtSettle, 'B text unchanged by the late A frame');
    assert.equal(bResult.outcome, 'replied', 'B outcome unchanged by the late A frame');

    // The converse: a frame carrying B's text on A's key is ignored by A too
    // (B's key is not A's key, so A never accepts B-labelled content either).
    assert.notEqual(keyA, keyB);
    assert.ok(!aResult.text.includes('B-reply'), 'A never absorbs B content');
  } finally {
    client.disconnect();
    restore();
  }
});

test('B11/S9 SPEC order — A times out, B starts on a NEW key, late A completion leaves B unchanged', async (t) => {
  const { client, socket, restore } = await connectedClient();
  try {
    const { runHqNativeTurn } = await import(GATEWAY);
    scriptHappyPath(socket);

    // 1. Turn A times out with partial output only.
    const turnA = { sessionId: 'hq-session-1', turnId: 'turn-A', runtimeId: 'head-a', message: 'A' };
    const keyA = 'agent:head-a:hq-turn-A';
    const aPromise = runHqNativeTurn(turnA, { client, timeoutMs: 80 });
    await flush();
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: keyA, seq: 1, state: 'delta', deltaText: 'A-partial' }));
    const aResult = await aPromise;
    assert.equal(aResult.outcome, 'timeout', 'A times out');
    assert.equal(aResult.partial, true, 'A partial remains labelled partial');

    // 2. Turn B starts with a NEW key and completes.
    const turnB = { sessionId: 'hq-session-1', turnId: 'turn-B', runtimeId: 'head-a', message: 'B' };
    const keyB = 'agent:head-a:hq-turn-B';
    assert.notEqual(keyA, keyB, 'B never reuses A gateway key');
    const bPromise = runHqNativeTurn(turnB, { client });
    await flush();
    socket.receive(chatFrame({ runId: 'run-B', sessionKey: keyB, seq: 1, state: 'delta', deltaText: 'B-text' }));
    socket.receive(chatFrame({ runId: 'run-B', sessionKey: keyB, seq: 2, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text: 'B-text' }] } }));
    const bResult = await bPromise;
    assert.equal(bResult.outcome, 'replied');
    assert.equal(bResult.text, 'B-text');

    // 3. A's completion arrives LATE, on A's own key. B must not move.
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: keyA, seq: 5, state: 'delta', deltaText: 'LATE-A' }));
    socket.receive(chatFrame({ runId: 'run-A', sessionKey: keyA, seq: 6, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text: 'LATE-A' }] } }));
    await flush();
    assert.equal(bResult.text, 'B-text', 'B text unchanged by the late A completion');
    assert.equal(bResult.outcome, 'replied', 'B state unchanged by the late A completion');
    assert.ok(!bResult.text.includes('LATE-A'), 'late A text never reaches B');
  } finally {
    client.disconnect();
    restore();
  }
});

test('B11 legacy positive control: unchanged client emits NO native-event for method frames or res frames', async (t) => {
  const { client, socket, restore } = await connectedClient();
  try {
    // LEGACY CONTROL — a caller that never opts in must see exactly the old
    // surface: 'notification' + the method event, and NOTHING else.
    const notifications: unknown[] = [];
    const methodEvents: unknown[] = [];
    const nativeEvents: unknown[] = [];
    client.on('notification', (n: unknown) => notifications.push(n));
    client.on('sessions.changed', (p: unknown) => methodEvents.push(p));
    client.on('native-event', (e: unknown) => nativeEvents.push(e));

    // Legacy method notifications, in the shape the real gateway sends (both
    // `params` and `payload`; the client's PRE-EXISTING content-hash cache
    // collapses frames with no distinguishable payload, so distinct payloads
    // are used — that cache is untouched by B11 and behaves identically at
    // base, verified by running this same probe against hq/contracts).
    socket.receive({ method: 'sessions.changed', params: { key: 'agent:main:peer' }, payload: { key: 'agent:main:peer' } });
    socket.receive({ method: 'sessions.changed', params: { key: 'agent:main:peer-2' }, payload: { key: 'agent:main:peer-2' } });
    socket.receive({ type: 'event', event: 'chat', seq: 1, payload: { runId: 'r', sessionKey: 'k', seq: 1, state: 'delta', deltaText: 'x' } });

    assert.deepEqual(methodEvents, [{ key: 'agent:main:peer' }, { key: 'agent:main:peer-2' }], 'legacy method events unchanged');
    assert.equal(notifications.length, 2, 'legacy notification surface unchanged');
    assert.deepEqual(nativeEvents, [], 'no native-event emitted unless the caller opts in');

    // Opt in: same frame, now surfaced natively — and ONLY natively. The
    // frame carries the channel-level `seq` the real server stamps on every
    // frame (`frameWithSequence`).
    client.enableNativeEvents(true);
    assert.equal(client.isNativeEventsEnabled(), true);
    socket.receive({ type: 'event', event: 'chat', seq: 2, payload: { runId: 'r', sessionKey: 'k', seq: 2, state: 'delta', deltaText: 'y' } });
    assert.equal(nativeEvents.length, 1, 'opt-in emits native-event');
    assert.deepEqual(nativeEvents[0], { event: 'chat', payload: { runId: 'r', sessionKey: 'k', seq: 2, state: 'delta', deltaText: 'y' }, seq: 2 });

    // A `res` frame — even one shaped like an event — is NEVER an event.
    socket.receive({ type: 'res', id: randomUUID(), ok: true, payload: {}, event: 'chat' });
    assert.equal(nativeEvents.length, 1, 'res frames are never reported as events');

    // A malformed event frame (missing/non-string event name) is not an event.
    socket.receive({ type: 'event', payload: { runId: 'r' } });
    socket.receive({ type: 'event', event: 42, payload: {} });
    assert.equal(nativeEvents.length, 1, 'only type:event with a string event name is an EventFrame');
  } finally {
    client.disconnect();
    restore();
  }
});
