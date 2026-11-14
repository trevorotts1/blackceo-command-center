/**
 * interview-workspace-resolution.test.ts — BU-22, WF-022.
 *
 * THE BUG THIS PREVENTS: the Command Center resolved the interview workspace by
 * its OWN rule (OPENCLAW_WORKSPACE_ROOT → /data/.openclaw/workspace → $HOME),
 * while the onboarding scripts also honour `agents.defaults.workspace` from the
 * box configuration file. On a box configured that way the app read one
 * `.workforce-build-state.json` and the scripts wrote another.
 *
 * Proves, with a temp configuration file naming a custom workspace:
 *   1. `resolveWorkspaceDir()` follows the contract order —
 *      OPENCLAW_WORKSPACE_ROOT → OPENCLAW_WORKSPACE_PATH →
 *      agents.defaults.workspace → /data (if a dir) → $HOME;
 *   2. `buildStatePath()` is inside the configured workspace;
 *   3. every `updateInterviewState()` call passes `--state <buildStatePath()>`
 *      to update-interview-state.sh (the script is a stand-in that records the
 *      argument list it received; no live box, no real Skill-23 script).
 *
 * No DB, no network. One temp HOME and one temp scripts dir per case.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildStatePath, resolveWorkspaceDir } from '../../src/lib/interview/paths';
import { updateInterviewState } from '../../src/lib/interview/seam';

const VPS_CONFIG = '/data/.openclaw/openclaw.json';
const VPS_WORKSPACE = '/data/.openclaw/workspace';
const ENV_KEYS = [
  'OPENCLAW_WORKSPACE_ROOT',
  'OPENCLAW_WORKSPACE_PATH',
  'OPENCLAW_SKILL23_SCRIPTS',
] as const;

/** One throwaway HOME; nothing outside it is read or written. */
function isolatedHome(t: TestContext): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bu22-workspace-'));
  t.mock.method(os, 'homedir', () => home);
  t.after(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (const key of ENV_KEYS) delete process.env[key];
  return home;
}

/**
 * Make the two /data probes report absent regardless of the host, so the Mac
 * branch of the order is decided by this test's own fixtures — never by
 * whatever exists on the machine running it.
 */
function noVpsPaths(t: TestContext): void {
  const realStatSync = fs.statSync as (...a: unknown[]) => fs.Stats;
  t.mock.method(fs, 'statSync', ((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p) === VPS_CONFIG || String(p) === VPS_WORKSPACE) {
      const err = new Error(`ENOENT: no such file or directory, stat '${String(p)}'`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    return realStatSync(p, ...rest);
  }) as unknown as typeof fs.statSync);
}

/** Write $HOME/.openclaw/openclaw.json naming `workspace` (or raw text). */
function writeBoxConfig(home: string, workspace: string | null, raw?: string): void {
  const dir = path.join(home, '.openclaw');
  fs.mkdirSync(dir, { recursive: true });
  const body =
    raw ??
    JSON.stringify({ agents: { defaults: { workspace } } }, null, 2) + '\n';
  fs.writeFileSync(path.join(dir, 'openclaw.json'), body, 'utf-8');
}

/**
 * A stand-in update-interview-state.sh: records the exact argument list it was
 * handed, one argument per line, and exits 0. This is how the test observes the
 * argv the seam builds without mocking child_process.
 */
function fakeScriptsDir(t: TestContext, home: string): { dir: string; argsFile: string } {
  const dir = path.join(home, 'skill23-scripts');
  const argsFile = path.join(home, 'update-interview-state.argv');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'update-interview-state.sh');
  fs.writeFileSync(
    script,
    ['#!/bin/sh', ': > "$0.args"', 'for a in "$@"; do printf \'%s\\n\' "$a" >> "$0.args"; done', 'exit 0', ''].join('\n'),
    { encoding: 'utf-8', mode: 0o755 },
  );
  // `$0.args` puts the recording file beside the script itself; the test reads
  // it from there instead of depending on a shell environment variable.
  return { dir, argsFile: `${script}.args` };
}

function readArgv(argsFile: string): string[] {
  return fs.readFileSync(argsFile, 'utf-8').split('\n').filter((line) => line !== '');
}

test('a configured agents.defaults.workspace is the workspace, and buildStatePath() is inside it', (t) => {
  const home = isolatedHome(t);
  noVpsPaths(t);
  const custom = path.join(home, 'custom-workspace');
  writeBoxConfig(home, custom);

  assert.equal(resolveWorkspaceDir(), custom);
  assert.equal(buildStatePath(), path.join(custom, '.workforce-build-state.json'));
});

test('the resolution order is ROOT → PATH → configured workspace → $HOME', (t) => {
  const home = isolatedHome(t);
  noVpsPaths(t);
  const configured = path.join(home, 'from-config');
  writeBoxConfig(home, configured);

  assert.equal(resolveWorkspaceDir(), configured, 'config file decides with no override');

  process.env.OPENCLAW_WORKSPACE_PATH = path.join(home, 'from-path');
  assert.equal(resolveWorkspaceDir(), path.join(home, 'from-path'), 'PATH beats the config file');

  process.env.OPENCLAW_WORKSPACE_ROOT = path.join(home, 'from-root');
  assert.equal(resolveWorkspaceDir(), path.join(home, 'from-root'), 'ROOT beats PATH');
});

test('an unreadable or malformed configuration file is ignored, not obeyed', (t) => {
  const home = isolatedHome(t);
  noVpsPaths(t);
  writeBoxConfig(home, null, '{ not json at all\n');

  assert.equal(
    resolveWorkspaceDir(),
    path.join(home, '.openclaw', 'workspace'),
    'bad JSON falls through to the $HOME workspace',
  );

  writeBoxConfig(home, null, JSON.stringify({ agents: { defaults: { workspace: 42 } } }) + '\n');
  assert.equal(
    resolveWorkspaceDir(),
    path.join(home, '.openclaw', 'workspace'),
    'a non-string workspace falls through to the $HOME workspace',
  );
});

test('a `~` in the configured workspace is expanded, as platform/common.sh does', (t) => {
  const home = isolatedHome(t);
  noVpsPaths(t);
  writeBoxConfig(home, '~/clients/acme');

  assert.equal(
    resolveWorkspaceDir(),
    path.join(home, 'clients', 'acme'),
    'a tilde must resolve to the real home, never to a path relative to the cwd',
  );
  assert.equal(
    buildStatePath(),
    path.join(home, 'clients', 'acme', '.workforce-build-state.json'),
  );

  // The scripts refuse a workspace that is not absolute, so a relative value is
  // ignored here rather than silently used from the server's cwd.
  writeBoxConfig(home, 'relative/ws');
  assert.equal(
    resolveWorkspaceDir(),
    path.join(home, '.openclaw', 'workspace'),
    'a relative configured workspace falls through to the $HOME workspace',
  );
});

test('updateInterviewState passes --state <buildStatePath()> to the script', async (t) => {
  const home = isolatedHome(t);
  noVpsPaths(t);
  const custom = path.join(home, 'configured-workspace');
  writeBoxConfig(home, custom);

  const { dir, argsFile } = fakeScriptsDir(t, home);
  process.env.OPENCLAW_SKILL23_SCRIPTS = dir;

  const expectedState = path.join(custom, '.workforce-build-state.json');
  assert.equal(buildStatePath(), expectedState);

  await updateInterviewState({
    phase: 'identity',
    questionNumber: 3,
    askedBy: 'interview-web',
  });

  const argv = readArgv(argsFile);
  const stateIndex = argv.indexOf('--state');
  assert.ok(stateIndex >= 0, `argv has no --state flag: ${JSON.stringify(argv)}`);
  assert.equal(
    argv[stateIndex + 1],
    expectedState,
    `--state is not followed by buildStatePath(): ${JSON.stringify(argv)}`,
  );

  // The existing flags are still there — this unit appends --state, it does not
  // replace the rest of the argument list.
  assert.equal(argv[argv.indexOf('--phase') + 1], 'identity');
  assert.equal(argv[argv.indexOf('--question-number') + 1], '3');
  assert.equal(argv[argv.indexOf('--asked-by') + 1], 'interview-web');
});

test('--complete also carries --state (the completion write is pinned too)', async (t) => {
  const home = isolatedHome(t);
  noVpsPaths(t);
  const custom = path.join(home, 'second-workspace');
  writeBoxConfig(home, custom);

  const { dir, argsFile } = fakeScriptsDir(t, home);
  process.env.OPENCLAW_SKILL23_SCRIPTS = dir;

  await updateInterviewState({ complete: true, askedBy: 'interview-web' });

  const argv = readArgv(argsFile);
  assert.ok(argv.includes('--complete'), `argv is missing --complete: ${JSON.stringify(argv)}`);
  const stateIndex = argv.indexOf('--state');
  assert.ok(stateIndex >= 0, `argv has no --state flag: ${JSON.stringify(argv)}`);
  assert.equal(argv[stateIndex + 1], buildStatePath());
  assert.equal(argv[stateIndex + 1], path.join(custom, '.workforce-build-state.json'));
});
