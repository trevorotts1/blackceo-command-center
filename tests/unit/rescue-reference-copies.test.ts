/**
 * rescue-reference-copies.test.ts — acceptance for RRX-014 (lane C3).
 *
 * Runs the PUBLIC reference copy of fleet-heartbeat/scripts/rescue-rangers-poller.sh
 * under /bin/bash with every outside dependency shadowed by a stub in a temporary
 * folder: `curl` (records each request and answers with a chosen code and body),
 * `python3` (passthrough to the real interpreter, so the script's own inline python
 * still runs) and `openclaw` (records each call and prints a chosen reply).
 *
 * No network, no live box, no gateway.
 *
 * Proves, per the unit card:
 *   (a) a 500 from the relay makes the poller exit 1, never "zero tickets";
 *   (b) an empty agent reply posts nothing (zero `action":"answer"` requests), and
 *       before that, the `openclaw` stub WAS called exactly once — without that
 *       control the next assertion also passes when the loop died early (RRX-108:
 *       the default tier leaves MODEL_ARGS empty and `"${MODEL_ARGS[@]}"` aborts
 *       under `set -u` on stock macOS bash 3.2);
 *   (c) with RESCUE_RANGERS_WEBHOOK_SECRET unset the poller does not abort with
 *       "unbound variable" (the empty _SECRET_ARGS array).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const POLLER = path.join(repoRoot, 'fleet-heartbeat', 'scripts', 'rescue-rangers-poller.sh');

// A stub `curl`: prints the pending body, a newline and the HTTP code (the poller
// calls it with -w '\n%{http_code}' and no -o). Answer requests get a healthy 200.
// Every invocation's arguments are appended to FAKE_CURL_LOG, one line each.
const CURL_STUB = [
  '#!/bin/sh',
  'set -u',
  'printf \'%s\\n\' "$*" >> "${FAKE_CURL_LOG:?}"',
  'case "$*" in',
  '  *\'"action":"pending"\'*)',
  '    printf \'%s\\n%s\' "${FAKE_CURL_BODY:-}" "${FAKE_CURL_CODE:-000}"',
  '    exit "${FAKE_CURL_RC:-0}"',
  '    ;;',
  '  *)',
  '    printf \'%s\\n%s\' \'{"ok":true}\' \'200\'',
  '    exit 0',
  '    ;;',
  'esac',
  '',
].join('\n');

// A stub `openclaw`: records the call, prints FAKE_OPENCLAW_OUTPUT (empty by default).
const OPENCLAW_STUB = [
  '#!/bin/sh',
  'set -u',
  'printf \'%s\\n\' "$*" >> "${FAKE_OPENCLAW_LOG:?}"',
  '[ -n "${FAKE_OPENCLAW_OUTPUT:-}" ] && printf \'%s\' "$FAKE_OPENCLAW_OUTPUT"',
  'exit "${FAKE_OPENCLAW_RC:-0}"',
  '',
].join('\n');

function realPython(): string {
  for (const candidate of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    if (existsSync(candidate)) return candidate;
  }
  const found = spawnSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' });
  const resolved = (found.stdout ?? '').trim();
  if (!resolved) throw new Error('no python3 found to pass through to the poller stub');
  return resolved;
}

function writeStub(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

type Run = {
  status: number | null;
  stdout: string;
  stderr: string;
  curlCalls: string[];
  openclawCalls: string[];
  pollerLog: string;
};

function runPoller(opts: { code: string; body: string; openclawOutput?: string }): { work: string; run: Run } {
  const work = mkdtempSync(path.join(os.tmpdir(), 'rr-refcopies-'));
  const bin = path.join(work, 'bin');
  const home = path.join(work, 'home');
  mkdirSync(bin);
  mkdirSync(home);

  writeStub(bin, 'curl', CURL_STUB);
  writeStub(bin, 'openclaw', OPENCLAW_STUB);
  writeFileSync(path.join(bin, 'python3'), `#!/bin/sh\nexec "${realPython()}" "$@"\n`, { mode: 0o755 });
  chmodSync(path.join(bin, 'python3'), 0o755);

  const curlLog = path.join(work, 'curl.log');
  const openclawLog = path.join(work, 'openclaw.log');
  const pollerLog = path.join(work, 'poller.log');
  writeFileSync(curlLog, '');
  writeFileSync(openclawLog, '');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: home,
    TMPDIR: work,
    OPENCLAW_BIN: path.join(bin, 'openclaw'),
    RESCUE_RELAY_URL: 'http://relay.invalid/webhook/rr-v2-intake',
    RESCUE_POLLER_LOG: pollerLog,
    RESCUE_AGENT_TIMEOUT: '5',
    FAKE_CURL_LOG: curlLog,
    FAKE_CURL_CODE: opts.code,
    FAKE_CURL_BODY: opts.body,
    FAKE_OPENCLAW_LOG: openclawLog,
    FAKE_OPENCLAW_OUTPUT: opts.openclawOutput ?? '',
  };
  // Case (c) needs the secret genuinely unset, not inherited from the runner.
  delete env.RESCUE_RANGERS_WEBHOOK_SECRET;

  const result = spawnSync('/bin/bash', [POLLER], { cwd: work, env, encoding: 'utf8', timeout: 120_000 });

  const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
  return {
    work,
    run: {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      curlCalls: lines(curlLog),
      openclawCalls: lines(openclawLog),
      pollerLog: existsSync(pollerLog) ? readFileSync(pollerLog, 'utf8') : '',
    },
  };
}

const healthyPull = (tickets: unknown[]) => JSON.stringify({ count: tickets.length, tickets });

test('RRX-014 (a): a 500 from the relay is a failed fetch, not zero tickets', () => {
  const { work, run } = runPoller({ code: '500', body: 'oops' });
  try {
    assert.equal(run.status, 1, `poller must exit 1 on HTTP 500:\n${run.stdout}${run.stderr}\n${run.pollerLog}`);
    assert.equal(run.curlCalls.length, 1, 'only the pull is attempted');
    assert.equal(run.openclawCalls.length, 0, 'no agent turn on a failed pull');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('RRX-014 (b): an empty agent reply posts nothing, and the agent really was called', () => {
  const ticket = {
    ticketId: 'T-RRX-014',
    client: 'placeholder-client',
    agent: 'main',
    // Matches none of the tier rules (no destructive, structured or light keyword).
    message: 'The agent is unsure about the next step and would like some guidance.',
  };
  const { work, run } = runPoller({
    code: '200',
    body: healthyPull([ticket]),
    openclawOutput: '',
  });
  try {
    // Control first: the loop reached the agent turn exactly once (RRX-108).
    assert.equal(
      run.openclawCalls.length,
      1,
      `the openclaw stub must be called exactly once (the default tier leaves MODEL_ARGS empty):\n${run.stdout}${run.stderr}\n${run.pollerLog}`,
    );
    const answerRequests = run.curlCalls.filter((line) => /"action"\s*:\s*"answer"/.test(line));
    assert.deepEqual(answerRequests, [], 'an empty reply must never be posted as an answer');
    assert.equal(run.status, 0, `the poller finishes cleanly:\n${run.stdout}${run.stderr}\n${run.pollerLog}`);
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /unbound variable/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('RRX-014 (c): with no webhook secret the poller does not abort on the empty array', () => {
  const { work, run } = runPoller({ code: '200', body: healthyPull([]) });
  try {
    assert.equal(run.status, 0, `poller must exit 0 on a healthy empty pull:\n${run.stdout}${run.stderr}\n${run.pollerLog}`);
    assert.doesNotMatch(`${run.stdout}${run.stderr}${run.pollerLog}`, /unbound variable/);
    assert.equal(run.curlCalls.length, 1, 'the pull happens exactly once');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
