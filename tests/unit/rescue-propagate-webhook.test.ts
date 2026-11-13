/**
 * rescue-propagate-webhook.test.ts — acceptance for RRX-131 (lane C3).
 *
 * Covers the PUBLIC reference copy of fleet-heartbeat/scripts/propagate-rescue-webhook.sh:
 *   (a) it carries no AGENTS.md section builder, no value-printing `printenv`, no
 *       operator name and no v2 form field, and every `docker exec` that runs `sh`
 *       also names `-u node` (openclaw.json is never rewritten as root);
 *   (b) `--dry-run` with one-line rosters walks both box types, prints two DRY-RUN
 *       lines, exits 0 and starts no `ssh` at all (a stub `ssh` first on PATH
 *       records every call; the expected count is zero).
 *
 * It also holds `bash -n` on the script. No network, no live box, no gateway, and
 * the script itself is never run without --dry-run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SCRIPT = path.join(repoRoot, 'fleet-heartbeat', 'scripts', 'propagate-rescue-webhook.sh');

const read = () => readFileSync(SCRIPT, 'utf8');

test('RRX-131 (a): the script writes no instructions and prints no secret', () => {
  const text = read();
  const lines = text.split('\n');

  for (const banned of ['make_section', 'printenv', 'Trevor']) {
    const hits = lines.filter((line) => line.includes(banned));
    assert.deepEqual(hits, [], `no line may contain ${JSON.stringify(banned)}`);
  }

  assert.equal(text.includes('"person":'), false, 'the v2 escalation form field is gone');

  // Every command that both runs docker exec and a shell must drop to the node user.
  const offenders = lines.filter((line) => line.includes('docker exec') && line.includes('sh') && !line.includes('-u node'));
  assert.deepEqual(offenders, [], 'every `docker exec ... sh` must carry -u node');
});

test('RRX-131: the script parses', () => {
  const result = spawnSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, `bash -n must exit 0:\n${result.stdout}${result.stderr}`);
});

test('RRX-131 (b): a dry run walks both box types and starts no ssh', () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'rr-propagate-'));
  const bin = path.join(work, 'bin');
  const home = path.join(work, 'home');
  mkdirSync(bin);
  mkdirSync(home);

  const sshLog = path.join(work, 'ssh.log');
  writeFileSync(sshLog, '');

  // A stub `ssh`: records the call and fails loudly, so a dry run that dialled out
  // would show up in the log rather than hang on a real tunnel.
  const sshStub = path.join(bin, 'ssh');
  writeFileSync(
    sshStub,
    ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "${FAKE_SSH_LOG:?}"', 'exit 97', ''].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(sshStub, 0o755);

  const vpsRoster = path.join(work, 'vps-roster.txt');
  const macRoster = path.join(work, 'mac-roster.txt');
  writeFileSync(vpsRoster, 'placeholder-client|203.0.113.10|openclaw-placeholder-openclaw-1|/docker/placeholder|placeholder-agent\n');
  writeFileSync(macRoster, 'placeholder-client|rescue-placeholder-client|placeholder-agent\n');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: home,
    TMPDIR: work,
    CLAWD_HOME: home,
    RESCUE_VPS_ROSTER_FILE: vpsRoster,
    RESCUE_MAC_ROSTER_FILE: macRoster,
    FAKE_SSH_LOG: sshLog,
  };
  delete env.RESCUE_RANGERS_WEBHOOK_SECRET;

  const result = spawnSync('/bin/bash', [SCRIPT, '--dry-run'], {
    cwd: work,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });

  try {
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const sshCalls = readFileSync(sshLog, 'utf8').split('\n').filter((line) => line.length > 0);
    assert.equal(result.status, 0, `--dry-run must exit 0:\n${out}`);
    assert.equal(
      (out.match(/DRY-RUN/g) ?? []).length,
      2,
      `one DRY-RUN line per rostered box:\n${out}`,
    );
    assert.match(out, /VPS placeholder-client: DRY-RUN/, 'the VPS box is walked');
    assert.match(out, /MAC placeholder-client: DRY-RUN/, 'the Mac box is walked');
    assert.deepEqual(sshCalls, [], 'a dry run must start no ssh process');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
