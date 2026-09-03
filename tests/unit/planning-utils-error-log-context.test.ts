/**
 * planning-utils.ts — getMessagesFromOpenClaw()'s error log carries sessionKey.
 *
 * Before this fix, the catch at the bottom of getMessagesFromOpenClaw()
 * logged `console.error('[Planning Utils] Failed to get messages from
 * OpenClaw:', err)` with ZERO session or task context — so the log could
 * never answer "which sessions/agents are failing", only that something,
 * somewhere, did. sessionKey is the only identifier this function has (it
 * takes no task id), so this pins that it now appears in the log line.
 *
 * The caller in execution-watcher.ts has its own session-aware catch that
 * can never fire for this failure mode, because getMessagesFromOpenClaw()
 * swallows the error internally and returns `[]` — this function's own log
 * line is the only place the failure is ever recorded. (Not fixed here —
 * out of scope, see the PR description; execution-watcher.ts is owned by a
 * concurrently-running fix.)
 *
 * Real, not mocked: points OPENCLAW_GATEWAY_URL at a port nothing listens
 * on (127.0.0.1:1) so client.connect() fails fast (~10-20ms, refused, not
 * the 10s handshake-timeout path) and getMessagesFromOpenClaw() takes its
 * real catch branch — proving the actual log line, not a stand-in for it.
 *
 *   node --import tsx --test tests/unit/planning-utils-error-log-context.test.ts
 */

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must be set BEFORE the first import of client.ts (which reads
// OPENCLAW_GATEWAY_URL into a module-level const at load time) — an
// unreachable/refused local port so connect() fails fast and deterministically,
// with no real gateway required.
process.env.OPENCLAW_GATEWAY_URL = 'ws://127.0.0.1:1';
process.env.BCC_DEVICE_IDENTITY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-planning-utils-log-'));

let getMessagesFromOpenClaw: typeof import('../../src/lib/planning-utils').getMessagesFromOpenClaw;

before(async () => {
  ({ getMessagesFromOpenClaw } = await import('../../src/lib/planning-utils'));
});

/** Mirrors the console-capture idiom in tests/unit/b-u7-ingest-persona-parity.test.ts. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; errorLines: string[] }> {
  const errorLines: string[] = [];
  const origError = console.error;
  console.error = ((...args: unknown[]) => {
    errorLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }) as typeof console.error;
  try {
    const result = await fn();
    return { result, errorLines };
  } finally {
    console.error = origError;
  }
}

test('getMessagesFromOpenClaw() error log carries the sessionKey (regression guard for the context-free log)', async () => {
  const sessionKey = 'sess-planning-log-guard-abc123';

  const { result, errorLines } = await captureConsole(() => getMessagesFromOpenClaw(sessionKey));

  // Swallowed, not thrown — the existing fail-closed-to-empty-array contract
  // for callers is unchanged by this fix.
  assert.deepEqual(result, [], 'still swallows the connect failure and returns []');

  assert.ok(errorLines.length >= 1, 'the failure is logged at least once');
  const logged = errorLines.join('\n');
  assert.ok(
    logged.includes(sessionKey),
    `error log must carry the sessionKey so it can answer "which session failed" — got: ${logged}`,
  );
  assert.ok(logged.includes('[Planning Utils]'), 'keeps the existing log prefix (no regression on the rest of the message)');
});

test('getMessagesFromOpenClaw() error log distinguishes two different sessions (not a hardcoded placeholder)', async () => {
  const first = await captureConsole(() => getMessagesFromOpenClaw('sess-first-11111'));
  const second = await captureConsole(() => getMessagesFromOpenClaw('sess-second-22222'));

  assert.ok(first.errorLines.join('\n').includes('sess-first-11111'));
  assert.ok(second.errorLines.join('\n').includes('sess-second-22222'));
  // Neither log carries the OTHER call's session — proves this is the real
  // per-call sessionKey, not a module-level constant that happens to match.
  assert.ok(!first.errorLines.join('\n').includes('sess-second-22222'));
  assert.ok(!second.errorLines.join('\n').includes('sess-first-11111'));
});
