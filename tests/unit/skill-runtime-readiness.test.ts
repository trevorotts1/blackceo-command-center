/**
 * Skill runtime readiness — "installed" must not read as "ready to run".
 *
 * The failure this pins: a skill folder was on disk and reported ready, but a
 * Python package it imports (jsonschema) was missing, so its build would have
 * crashed halfway. These tests drive the parser, the result mapping, the
 * time-bounded cache and the setup-readiness wiring with the child process
 * mocked, so each outcome (ok / missing / too old / could not tell) is reached
 * on purpose. One test runs a real python3 through the real runner to prove the
 * fixed import script itself.
 *
 * Run: node --import tsx --test tests/unit/skill-runtime-readiness.test.ts
 */
import './_isolated-db'; // MUST be first: never touch a real database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  computeSkillRuntime,
  createBoundedCache,
  findOnPath,
  friendlySkillName,
  parseRequirement,
  PAGE_BUDGET_MS,
  parseSkillNeeds,
  resolveSkillsDir,
  runProcess,
  skillMessage,
  summarizeSkill,
  toClientSkills,
  versionAtLeast,
  type ProcessResult,
  type SkillCheckDetail,
  type SkillRuntimeDeps,
  type SkillRuntimeResult,
} from '../../src/lib/readiness/skills';
import { computeSetupReadiness, type SetupDeps } from '../../src/lib/readiness/setup';
import { ItemRow } from '../../src/components/setup/SetupReadinessPanel';

const SKILL_83 = '83-black-friday-launcher';

// The shape the real Skill 83 file ships: a python3 binary need, and a
// jsonschema need typed "manual"/"optional" (that is exactly why it was missed).
const PREREQS_83 = JSON.stringify({
  skill: SKILL_83,
  prerequisites: [
    { id: 'python3', type: 'binary', label: 'python3', check: { binary: 'python3' }, severity: 'required', satisfy: 'x' },
    {
      id: 'jsonschema', type: 'manual', label: 'jsonschema', check: { note: 'n' },
      pythonModule: 'jsonschema', requirement: 'jsonschema>=4.0', severity: 'optional', satisfy: 'x',
    },
  ],
});

const OK: ProcessResult = { rc: 0, stdout: '', stderr: '', timedOut: false, spawnError: null };

interface Harness {
  deps: SkillRuntimeDeps;
  spawned: Array<{ file: string; args: string[] }>;
}

function harness(opts: {
  skills?: Record<string, string | null | Error>;
  onPath?: Record<string, string | null>;
  process?: (file: string, args: string[]) => ProcessResult;
  dirError?: Error;
}): Harness {
  const skills = opts.skills ?? { [SKILL_83]: PREREQS_83 };
  const onPath = opts.onPath ?? { python3: '/usr/bin/python3' };
  const spawned: Harness['spawned'] = [];
  return {
    spawned,
    deps: {
      skillsDir: () => 'skills-dir',
      listSkillDirs: async () => {
        if (opts.dirError) throw opts.dirError;
        return Object.keys(skills);
      },
      readPrereqs: async (_dir, skill) => {
        const v = skills[skill];
        if (v instanceof Error) throw v;
        return v ?? null;
      },
      findOnPath: async (binary) => onPath[binary] ?? null,
      runProcess: async (file, args) => {
        spawned.push({ file, args });
        return (opts.process ?? (() => OK))(file, args);
      },
    },
  };
}

function only(results: SkillRuntimeResult[], skill = SKILL_83): SkillRuntimeResult {
  const row = results.find((r) => r.skill === skill);
  assert.ok(row, `expected a row for ${skill}`);
  return row;
}

// ── parser ──────────────────────────────────────────────────────────────────

test('parser: the real Skill 83 file yields a python3 binary need and a jsonschema>=4.0 module need', () => {
  const needs = parseSkillNeeds(PREREQS_83);
  assert.deepEqual(needs, [
    { kind: 'binary', binary: 'python3' },
    { kind: 'python_module', module: 'jsonschema', dist: 'jsonschema', requirement: 'jsonschema>=4.0', floor: [4, 0] },
  ]);
});

test('parser: a pythonModule counts whatever its severity; optional, conditional and non-binary entries do not', () => {
  const needs = parseSkillNeeds(JSON.stringify({
    prerequisites: [
      { type: 'binary', check: { binary: 'ffmpeg' }, severity: 'required' },
      { type: 'binary', check: { binary: 'tesseract' }, severity: 'optional' },
      { type: 'binary', check: { binary: 'mediapipe' }, severity: 'required', when: 'some-feature' },
      { type: 'credential', check: { envVar: 'SOME_KEY' }, severity: 'required' },
      { type: 'skill', check: { skill: '01-x' }, severity: 'required' },
      { type: 'manual', pythonModule: 'numpy', severity: 'optional' },
      { type: 'manual', pythonModule: 'scipy', severity: 'optional', when: 'some-feature' },
    ],
  }));
  assert.deepEqual(needs, [
    { kind: 'binary', binary: 'ffmpeg' },
    { kind: 'python_module', module: 'numpy', dist: 'numpy', requirement: 'numpy', floor: null },
  ]);
});

test('parser: names that could smuggle anything past a fixed argv are dropped', () => {
  const needs = parseSkillNeeds(JSON.stringify({
    prerequisites: [
      { pythonModule: 'os; import shutil', severity: 'optional' },
      { pythonModule: '../evil', severity: 'optional' },
      { pythonModule: '', severity: 'optional' },
      { type: 'binary', check: { binary: '../../bin/sh' }, severity: 'required' },
      { type: 'binary', check: { binary: 'a b' }, severity: 'required' },
      { type: 'binary', check: { binary: '-c' }, severity: 'required' },
    ],
  }));
  assert.deepEqual(needs, []);
});

test('parser: unusable files are null (reported UNKNOWN), valid-but-empty files are [] (nothing to check)', () => {
  assert.equal(parseSkillNeeds('{not json'), null);
  assert.equal(parseSkillNeeds('[]'), null);
  assert.equal(parseSkillNeeds('"str"'), null);
  assert.equal(parseSkillNeeds(JSON.stringify({ prerequisites: 'nope' })), null);
  assert.equal(parseSkillNeeds(JSON.stringify({ prerequisites: [] }))?.length, 0);
  assert.equal(parseSkillNeeds('{}')?.length, 0);
  assert.equal(parseSkillNeeds(' '.repeat(300_000)), null, 'an oversized file is refused, not parsed');
});

test('parser: only a >= requirement is a floor, and its patch number is kept', () => {
  assert.deepEqual(parseRequirement('jsonschema>=4.0', 'x'), { dist: 'jsonschema', floor: [4, 0] });
  assert.deepEqual(parseRequirement('jsonschema>=4.0.1', 'x'), { dist: 'jsonschema', floor: [4, 0, 1] });
  assert.deepEqual(parseRequirement('PyYAML >= 6', 'yaml'), { dist: 'PyYAML', floor: [6, 0] });
  assert.deepEqual(parseRequirement('numpy', 'numpy'), { dist: 'numpy', floor: null });
  assert.deepEqual(parseRequirement('numpy==1.2', 'numpy'), { dist: 'numpy', floor: null });
});

test('friendly name comes from the folder name', () => {
  assert.equal(friendlySkillName(SKILL_83), 'Black Friday Launcher');
  assert.equal(friendlySkillName('09-context7'), 'Context7');
  assert.equal(friendlySkillName('weird'), 'Weird');
});

// ── result mapping ──────────────────────────────────────────────────────────

const chk = (outcome: SkillCheckDetail['outcome']): SkillCheckDetail => ({
  kind: 'binary', target: 'x', outcome, detail: 'd',
});

test('mapping: any proven fault is BLOCKED, any undecided check is UNKNOWN, all ok is READY', () => {
  assert.equal(summarizeSkill(SKILL_83, [chk('ok'), chk('ok')]).state, 'READY');
  assert.equal(summarizeSkill(SKILL_83, [chk('ok'), chk('unknown')]).state, 'UNKNOWN');
  assert.equal(summarizeSkill(SKILL_83, [chk('missing'), chk('ok')]).state, 'BLOCKED');
  assert.equal(summarizeSkill(SKILL_83, [chk('unknown'), chk('missing')]).state, 'BLOCKED', 'a fault outranks "could not tell"');
  assert.equal(summarizeSkill(SKILL_83, []).state, 'UNKNOWN', 'zero evidence is never READY');
});

test('mapping: the client lines are exact and carry no technical words', () => {
  assert.equal(skillMessage('READY', 'Black Friday Launcher'), 'Ready');
  assert.equal(
    skillMessage('BLOCKED', 'Black Friday Launcher'),
    'Needs a quick fix: Black Friday Launcher is missing something it needs. Please let your support team know.',
  );
  for (const state of ['READY', 'BLOCKED', 'UNKNOWN'] as const) {
    assert.doesNotMatch(
      skillMessage(state, 'Black Friday Launcher'),
      /python|module|import|jsonschema|pip|install|interpreter|rc\b|exit|PATH/i,
      `${state} line must be jargon-free`,
    );
  }
});

test('mapping: the client projection drops every technical field', () => {
  const blocked = summarizeSkill(SKILL_83, [{
    kind: 'python_module', target: 'jsonschema', outcome: 'missing', rc: 1,
    resolvedPath: '/usr/bin/python3', detail: "ModuleNotFoundError: No module named 'jsonschema'",
  }]);
  const [line] = toClientSkills([blocked]);
  assert.deepEqual(Object.keys(line).sort(), ['message', 'name', 'skill', 'state']);
  assert.doesNotMatch(JSON.stringify(line), /jsonschema|python3|ModuleNotFound/);
});

// ── checks through the mocked child process ─────────────────────────────────

test('missing package: the Skill 83 case is BLOCKED, with module, interpreter and rc as operator detail', async () => {
  const h = harness({
    process: () => ({ rc: 1, stdout: "ModuleNotFoundError: No module named 'jsonschema'\n", stderr: '', timedOut: false, spawnError: null }),
  });
  const row = only(await computeSkillRuntime(h.deps));
  assert.equal(row.state, 'BLOCKED');
  assert.equal(row.name, 'Black Friday Launcher');
  assert.equal(
    row.message,
    'Needs a quick fix: Black Friday Launcher is missing something it needs. Please let your support team know.',
  );
  const py = row.checks.find((c) => c.kind === 'python_module');
  assert.ok(py);
  assert.equal(py.outcome, 'missing');
  assert.equal(py.target, 'jsonschema');
  assert.equal(py.requirement, 'jsonschema>=4.0');
  assert.equal(py.resolvedPath, '/usr/bin/python3');
  assert.equal(py.rc, 1);
  assert.match(py.detail, /No module named 'jsonschema'/);
  assert.equal(row.checks.find((c) => c.kind === 'binary')?.outcome, 'ok', 'python3 itself is fine');
});

test('present package: READY', async () => {
  const row = only(await computeSkillRuntime(harness({}).deps));
  assert.equal(row.state, 'READY');
  assert.equal(row.message, 'Ready');
});

test('too old: the >= floor is enforced (rc 3 is BLOCKED)', async () => {
  const h = harness({
    process: () => ({ rc: 3, stdout: 'installed 3.2 is older than the required 4.0\n', stderr: '', timedOut: false, spawnError: null }),
  });
  const row = only(await computeSkillRuntime(h.deps));
  assert.equal(row.state, 'BLOCKED');
  assert.match(row.checks.find((c) => c.kind === 'python_module')!.detail, /older than the required 4\.0/);
});

test('could not tell: timeout, spawn failure, version unreadable and odd exit codes are UNKNOWN, never READY or BLOCKED', async () => {
  const cases: Array<[string, ProcessResult]> = [
    ['timeout', { rc: null, stdout: '', stderr: '', timedOut: true, spawnError: null }],
    ['spawn failure', { rc: null, stdout: '', stderr: '', timedOut: false, spawnError: 'EACCES' }],
    ['version unreadable (rc 4)', { rc: 4, stdout: 'version unreadable: PackageNotFoundError: x\n', stderr: '', timedOut: false, spawnError: null }],
    ['interpreter usage error (rc 2)', { rc: 2, stdout: '', stderr: 'usage: python3\n', timedOut: false, spawnError: null }],
  ];
  for (const [label, result] of cases) {
    const row = only(await computeSkillRuntime(harness({ process: () => result }).deps));
    assert.equal(row.state, 'UNKNOWN', label);
    assert.equal(row.checks.find((c) => c.kind === 'python_module')!.outcome, 'unknown', label);
  }
});

test('no python3 on PATH: the binary need is BLOCKED, the import is UNKNOWN (never tried), and nothing is spawned', async () => {
  const h = harness({ onPath: {} });
  const row = only(await computeSkillRuntime(h.deps));
  assert.equal(row.state, 'BLOCKED');
  assert.equal(row.checks.find((c) => c.kind === 'binary')!.outcome, 'missing');
  assert.equal(row.checks.find((c) => c.kind === 'python_module')!.outcome, 'unknown');
  assert.equal(h.spawned.length, 0);
});

/** Run `fn` with env vars set (undefined deletes), restoring the originals after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('R3: exit 1 is "missing" only when the script printed its own Name: message line; a crash or stub is UNKNOWN', async () => {
  const run = async (stdout: string, stderr = '') =>
    only(await computeSkillRuntime(harness({ process: () => ({ rc: 1, stdout, stderr, timedOut: false, spawnError: null }) }).deps))
      .checks.find((c) => c.kind === 'python_module')!;

  const crashed = await run('', 'Traceback (most recent call last):\nValueError: invalid literal for int()\n');
  assert.equal(crashed.outcome, 'unknown', 'a traceback on stderr with nothing on stdout is a crash');
  assert.match(crashed.detail, /did not answer/);
  assert.equal((await run('', 'xcode-select: note: no developer tools were found')).outcome, 'unknown', 'the macOS developer-tools stub');
  assert.equal((await run('hello from a shim\n')).outcome, 'unknown', 'stdout that is not the script\'s own line');

  assert.equal((await run("ModuleNotFoundError: No module named 'jsonschema'\n")).outcome, 'missing');
  const noisy = await run("loading plugins...\nImportError: cannot import name 'x'\n");
  assert.equal(noisy.outcome, 'missing', 'what a module printed before failing does not hide the script\'s own answer');
  assert.match(noisy.detail, /ImportError/);
  assert.equal(only(await computeSkillRuntime(harness({ process: () => ({ rc: 1, stdout: '', stderr: '', timedOut: false, spawnError: null }) }).deps)).state, 'UNKNOWN');
});

test('R2: CC_PYTHON pins the interpreter for the import AND the python3 binary check, and a bad pin is never swapped', async () => {
  const pin = '/opt/pinned/python3';
  const pinned = harness({ onPath: { python3: '/usr/bin/python3', [pin]: pin } });
  const row = await withEnv({ CC_PYTHON: pin }, async () => only(await computeSkillRuntime(pinned.deps)));
  assert.equal(row.state, 'READY');
  assert.equal(pinned.spawned[0].file, pin, 'the import ran under the pinned interpreter');
  assert.equal(row.checks.find((c) => c.kind === 'binary')!.resolvedPath, pin);

  const bad = harness({ onPath: { python3: '/usr/bin/python3' } });
  const badRow = await withEnv({ CC_PYTHON: '/nope/python3' }, async () => only(await computeSkillRuntime(bad.deps)));
  assert.equal(badRow.state, 'UNKNOWN', 'an unusable pin is not a proven fault and is not replaced by another python3');
  assert.equal(bad.spawned.length, 0);
  assert.match(badRow.checks.find((c) => c.kind === 'python_module')!.detail, /CC_PYTHON/);
  assert.equal(badRow.checks.find((c) => c.kind === 'binary')!.outcome, 'unknown');

  const unset = harness({});
  await withEnv({ CC_PYTHON: undefined }, async () => computeSkillRuntime(unset.deps));
  assert.equal(unset.spawned[0].file, '/usr/bin/python3');
});

test('binary minVersion: parsed, read with --version, compared part by part; an unreadable floor or answer is UNKNOWN, never READY', async () => {
  const node = (minVersion: unknown) => JSON.stringify({
    prerequisites: [{ type: 'binary', check: { binary: 'node', minVersion }, severity: 'required' }],
  });
  assert.deepEqual(parseSkillNeeds(node('22.13.0')), [{ kind: 'binary', binary: 'node', minVersion: [22, 13, 0] }]);
  assert.deepEqual(parseSkillNeeds(node('18')), [{ kind: 'binary', binary: 'node', minVersion: [18, 0] }]);
  assert.deepEqual(parseSkillNeeds(node('latest')), [{ kind: 'binary', binary: 'node', minVersion: null }]);
  assert.deepEqual(parseSkillNeeds(node(18)), [{ kind: 'binary', binary: 'node', minVersion: null }]);

  const SK = '77-council-of-wise-elders';
  const say = (rc: number | null, stdout: string, extra: Partial<ProcessResult> = {}) =>
    (): ProcessResult => ({ rc, stdout, stderr: '', timedOut: false, spawnError: null, ...extra });
  const state = async (minVersion: unknown, answer: () => ProcessResult) => {
    const h = harness({ skills: { [SK]: node(minVersion) }, onPath: { node: '/usr/bin/node' }, process: answer });
    const row = only(await computeSkillRuntime(h.deps), SK);
    return { row, h };
  };

  const ok = await state('22.13.0', say(0, 'v22.13.0\n'));
  assert.equal(ok.row.state, 'READY');
  assert.deepEqual(ok.h.spawned, [{ file: '/usr/bin/node', args: ['--version'] }]);
  assert.equal(ok.row.checks[0].requirement, '>=22.13.0');

  const old = await state('22.13.0', say(0, 'v22.12.9\n'));
  assert.equal(old.row.state, 'BLOCKED', 'the patch number counts');
  assert.match(old.row.checks[0].detail, /22\.12\.9 is older than the required 22\.13\.0/);

  assert.equal((await state('18', say(0, 'v20.1.0\n'))).row.state, 'READY');
  assert.equal((await state('18', say(0, 'v16.0.0\n'))).row.state, 'BLOCKED');
  assert.equal((await state('18', say(0, 'no digits here\n'))).row.state, 'UNKNOWN');
  assert.equal((await state('18', say(1, 'v20.1.0\n'))).row.state, 'UNKNOWN', 'a failing --version is not trusted');
  assert.equal((await state('18', say(null, '', { timedOut: true }))).row.state, 'UNKNOWN');
  const unread = await state('latest', say(0, 'v20.1.0\n'));
  assert.equal(unread.row.state, 'UNKNOWN', 'a floor that cannot be read is never passed on presence alone');
  assert.equal(unread.h.spawned.length, 0);
});

test('version floors compare part by part, with missing parts as zero', () => {
  assert.equal(versionAtLeast([4, 0, 0], [4, 0, 1]), false);
  assert.equal(versionAtLeast([4, 0, 1], [4, 0, 1]), true);
  assert.equal(versionAtLeast([4, 0], [4, 0, 0]), true);
  assert.equal(versionAtLeast([4, 0, 0, 1], [4, 0, 1]), false);
  assert.equal(versionAtLeast([3, 11, 2], [3, 9]), true);
  assert.equal(versionAtLeast([3, 8, 9], [3, 9]), false);
});

test('R4: a cold probe holds a request for at most two seconds', () => {
  assert.ok(PAGE_BUDGET_MS <= 2_000, `the route comment says 2 seconds; the budget is ${PAGE_BUDGET_MS} ms`);
});

test('a required binary is a PATH lookup, with no child process', async () => {
  const h = harness({
    skills: { '75-drama-song-ad-factory': JSON.stringify({ prerequisites: [{ type: 'binary', check: { binary: 'ffmpeg' }, severity: 'required' }] }) },
    onPath: { ffmpeg: null },
  });
  const row = only(await computeSkillRuntime(h.deps), '75-drama-song-ad-factory');
  assert.equal(row.state, 'BLOCKED');
  assert.equal(h.spawned.length, 0);
  const found = harness({
    skills: { '75-drama-song-ad-factory': JSON.stringify({ prerequisites: [{ type: 'binary', check: { binary: 'ffmpeg' }, severity: 'required' }] }) },
    onPath: { ffmpeg: '/opt/bin/ffmpeg' },
  });
  assert.equal(only(await computeSkillRuntime(found.deps), '75-drama-song-ad-factory').state, 'READY');
});

test('read-only and no shell: a fixed argv, the module as data, and never pip or install', async () => {
  const h = harness({});
  await computeSkillRuntime(h.deps);
  assert.equal(h.spawned.length, 1);
  const { file, args } = h.spawned[0];
  assert.equal(file, '/usr/bin/python3');
  assert.equal(args[0], '-c');
  assert.deepEqual(args.slice(2), ['jsonschema', 'jsonschema', '4.0'], 'module, package and floor travel as argv');
  assert.match(args[1], /import_module/, 'a real import, not a file lookup');
  assert.doesNotMatch(args[1], /jsonschema/, 'no value is interpolated into the script');
  for (const a of h.spawned.flatMap((s) => s.args)) {
    assert.ok(a !== 'pip' && a !== 'install' && a !== '-m', `argv must never ask for an install: ${a}`);
  }
  assert.doesNotMatch(args[1], /pip|subprocess|os\.system/);
});

test('identical checks run once however many skills share them', async () => {
  const shared = JSON.stringify({ prerequisites: [{ pythonModule: 'jsonschema', requirement: 'jsonschema>=4.0', severity: 'optional' }] });
  const h = harness({ skills: { '49-a': shared, '71-b': shared, '78-c': shared } });
  const results = await computeSkillRuntime(h.deps);
  assert.equal(results.length, 3);
  assert.equal(h.spawned.length, 1);
});

test('skills with no checkable need get no row; unusable files get an UNKNOWN row; unreadable folder is one UNKNOWN row', async () => {
  const h = harness({
    skills: {
      '01-none': null,
      '02-empty': JSON.stringify({ prerequisites: [{ type: 'credential', check: { envVar: 'K' }, severity: 'required' }] }),
      '03-broken': '{oops',
      '04-unreadable': new Error('EACCES'),
      [SKILL_83]: PREREQS_83,
    },
  });
  const results = await computeSkillRuntime(h.deps);
  assert.deepEqual(results.map((r) => r.skill), ['03-broken', '04-unreadable', SKILL_83]);
  assert.equal(only(results, '03-broken').state, 'UNKNOWN');
  assert.equal(only(results, '04-unreadable').state, 'UNKNOWN');
  assert.equal(only(results).state, 'READY');

  const dirGone = await computeSkillRuntime(harness({ dirError: new Error('ENOENT: no such directory') }).deps);
  assert.equal(dirGone.length, 1);
  assert.equal(dirGone[0].skill, 'all');
  assert.equal(dirGone[0].state, 'UNKNOWN');
  assert.match(dirGone[0].checks[0].detail, /could not be read/);
});

// ── skills folder location (Mac, VPS, Docker) ───────────────────────────────

test('skills folder: OPENCLAW_ROOT wins, VPS Docker is /data/.openclaw, Mac is under the home folder', () => {
  const saved = { root: process.env.OPENCLAW_ROOT, platform: process.env.OPENCLAW_PLATFORM, home: process.env.HOME };
  try {
    process.env.OPENCLAW_ROOT = '/srv/oc';
    assert.equal(resolveSkillsDir(), '/srv/oc/skills');
    delete process.env.OPENCLAW_ROOT;
    process.env.OPENCLAW_PLATFORM = 'vps-docker';
    assert.equal(resolveSkillsDir(), '/data/.openclaw/skills');
    process.env.OPENCLAW_PLATFORM = 'mac-mini';
    process.env.HOME = '/home/someone';
    assert.match(resolveSkillsDir().replace(/\\/g, '/'), /\.openclaw\/skills$/);
    process.env.OPENCLAW_ROOT = 'relative/path';
    assert.throws(() => resolveSkillsDir(), /openclaw_runtime_root_invalid/);
  } finally {
    for (const [key, value] of [['OPENCLAW_ROOT', saved.root], ['OPENCLAW_PLATFORM', saved.platform], ['HOME', saved.home]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ── cache: brief, shared, bounded ───────────────────────────────────────────

test('cache: fresh within the window, recomputed after it, one shared in-flight run', async () => {
  let clock = 1_000;
  let runs = 0;
  const get = createBoundedCache(async () => ++runs, { ttlMs: 60_000, budgetMs: 1_000, onTimeout: () => -1, now: () => clock });
  const [a, b] = await Promise.all([get(), get()]);
  assert.deepEqual([a, b, runs], [1, 1, 1], 'concurrent callers share one run');
  clock += 59_000;
  assert.equal(await get(), 1, 'still fresh');
  clock += 2_000;
  assert.equal(await get(), 2, 'recomputed after the window');
  assert.equal(runs, 2);
});

test('cache: a slow probe hands the caller the fallback at the budget and still fills the cache when it lands', async () => {
  let release!: (n: number) => void;
  const slow = new Promise<number>((resolve) => { release = resolve; });
  let runs = 0;
  const get = createBoundedCache(() => { runs += 1; return slow; }, { ttlMs: 60_000, budgetMs: 20, onTimeout: () => -1 });
  assert.equal(await get(), -1, 'the page is not held past the budget');
  release(7);
  await slow;
  await new Promise((r) => setImmediate(r));
  assert.equal(await get(), 7, 'the finished result is served from cache');
  assert.equal(runs, 1);
});

test('cache: a rejection is not cached and does not wedge the next call', async () => {
  let n = 0;
  const get = createBoundedCache(async () => { if (++n === 1) throw new Error('boom'); return n; }, { ttlMs: 60_000, budgetMs: 1_000, onTimeout: () => -1 });
  await assert.rejects(get(), /boom/);
  assert.equal(await get(), 2);
});

// ── wiring into setup readiness ─────────────────────────────────────────────

function setupDeps(skillRuntime: SetupDeps['skillRuntime']): Partial<SetupDeps> {
  return {
    openDb: () => { throw new Error('database_unavailable'); },
    companyId: () => null,
    host: () => 'localhost',
    probeGateway: async () => ({ ok: true, detail: { probe: 'tcp_connect', host: '127.0.0.1', port: 18789 } }),
    skillRuntime,
    now: () => '2026-11-04T00:00:00.000Z',
  };
}

test('setup readiness: a skill missing its helper is a BLOCKED row with the plain line, and the box is not READY', async () => {
  const blocked = summarizeSkill(SKILL_83, [{
    kind: 'python_module', target: 'jsonschema', requirement: 'jsonschema>=4.0', outcome: 'missing',
    resolvedPath: '/usr/bin/python3', rc: 1, detail: "ModuleNotFoundError: No module named 'jsonschema'",
  }]);
  const readiness = await computeSetupReadiness({ deps: setupDeps(async () => [blocked]) });
  const item = readiness.items.find((i) => i.id === `skill_runtime:${SKILL_83}`);
  assert.ok(item, 'the skill has its own row');
  assert.equal(item.state, 'BLOCKED');
  assert.equal(item.group, 'runtime');
  assert.equal(item.label, 'Black Friday Launcher can run');
  assert.equal(
    item.reason,
    'Needs a quick fix: Black Friday Launcher is missing something it needs. Please let your support team know.',
  );
  assert.equal(item.evidence.probe, 'skill_runtime(PREREQS.json)');
  const checks = item.evidence.observed.checks as SkillCheckDetail[];
  assert.equal(checks[0].target, 'jsonschema');
  assert.equal(checks[0].rc, 1);
  assert.equal(checks[0].resolvedPath, '/usr/bin/python3');
  assert.equal(readiness.overall, 'BLOCKED');
});

test('setup readiness: a ready skill is a READY row; a probe that throws is one UNKNOWN row, not a missing section', async () => {
  const ready = summarizeSkill(SKILL_83, [chk('ok')]);
  const good = await computeSetupReadiness({ deps: setupDeps(async () => [ready]) });
  assert.equal(good.items.find((i) => i.id === `skill_runtime:${SKILL_83}`)?.state, 'READY');

  const boom = await computeSetupReadiness({ deps: setupDeps(async () => { throw new Error('probe exploded'); }) });
  const row = boom.items.find((i) => i.id === 'skill_runtime:all');
  assert.ok(row);
  assert.equal(row.state, 'UNKNOWN');
  assert.equal(row.evidence.observed.error, 'probe exploded');

  const sync = await computeSetupReadiness({ deps: setupDeps(() => { throw new Error('sync throw'); }) });
  assert.equal(sync.items.find((i) => i.id === 'skill_runtime:all')?.state, 'UNKNOWN');
});

test('setup readiness: no skills to check adds no rows', async () => {
  const readiness = await computeSetupReadiness({ deps: setupDeps(async () => []) });
  assert.equal(readiness.items.some((i) => i.id.startsWith('skill_runtime')), false);
});

test('panel: a blocked skill row shows the plain line and keeps the technical detail behind an expandable', async () => {
  const blocked = summarizeSkill(SKILL_83, [{
    kind: 'python_module', target: 'jsonschema', outcome: 'missing', rc: 1, resolvedPath: '/usr/bin/python3', detail: 'x',
  }]);
  const readiness = await computeSetupReadiness({ deps: setupDeps(async () => [blocked]) });
  const item = readiness.items.find((i) => i.id === `skill_runtime:${SKILL_83}`)!;
  const html = renderToStaticMarkup(createElement(ItemRow, { item }));
  const [visible, detail] = html.split('<details');
  assert.match(visible, /Needs a quick fix: Black Friday Launcher is missing something it needs/);
  assert.match(html, /Blocked/, 'the badge still reads Blocked');
  assert.doesNotMatch(visible, /jsonschema|python3/, 'technical words stay out of the always-visible text');
  assert.match(detail, /Technical detail/);
  assert.match(detail, /jsonschema/);
});

// ── the real runner and the real script ─────────────────────────────────────

test('real python3: the fixed import script reports present, missing and too-old correctly', async (t) => {
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('python3', ['-c', 'import importlib.metadata'], { stdio: 'ignore' });
  } catch {
    t.skip('python3 with importlib.metadata is not available on this machine');
    return;
  }
  // Real PATH lookup and real child process; only the skills folder is faked.
  const real = (skills: Record<string, string>) =>
    computeSkillRuntime({ ...harness({ skills }).deps, findOnPath, runProcess });
  const need = (pythonModule: string, requirement: string) =>
    JSON.stringify({ prerequisites: [{ type: 'manual', pythonModule, requirement, severity: 'optional' }] });

  const results = await real({
    '10-present': need('json', 'json'),
    '11-absent': need('cc_no_such_module_for_tests', 'cc_no_such_module_for_tests>=1.0'),
    '12-too-old': need('pip', 'pip>=9999.0'),
  });
  assert.equal(only(results, '10-present').state, 'READY');
  const absent = only(results, '11-absent');
  assert.equal(absent.state, 'BLOCKED');
  assert.equal(absent.checks[0].rc, 1);
  assert.match(absent.checks[0].detail, /ModuleNotFoundError/);
  const old = only(results, '12-too-old');
  assert.ok(old.state === 'BLOCKED' || old.state === 'UNKNOWN', 'pip may be absent on a minimal python; it must never read READY');
  assert.notEqual(old.state, 'READY');
});

// ── real programs: the private package folders, the wider PATH search, the pin ──

const POSIX = process.platform !== 'win32';

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cc-skill-${label}-`));
}

function writeExe(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

/** A real python3 and its X.Y, or null when this machine has none. */
async function realPython(): Promise<{ python: string; tag: string } | null> {
  const { execFileSync } = await import('node:child_process');
  const python = await withEnv({ CC_PYTHON: undefined }, () => findOnPath('python3'));
  if (!python) return null;
  try {
    const tag = execFileSync(python, ['-c', 'import importlib.metadata,sys;print("py%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' }).trim();
    return { python, tag };
  } catch {
    return null;
  }
}

// ccpydepstest (a made-up package) planted directly in `dir`, at the given version.
function plantPackage(dir: string, version = '4.0.0'): void {
  fs.mkdirSync(path.join(dir, 'ccpydepstest'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ccpydepstest', '__init__.py'), 'VALUE = 1\n');
  fs.mkdirSync(path.join(dir, `ccpydepstest-${version}.dist-info`), { recursive: true });
  fs.writeFileSync(path.join(dir, `ccpydepstest-${version}.dist-info`, 'METADATA'), `Metadata-Version: 2.1\nName: ccpydepstest\nVersion: ${version}\n`);
}

const pydepsNeed = (requirement: string) => JSON.stringify({
  prerequisites: [{ type: 'manual', pythonModule: 'ccpydepstest', requirement, severity: 'optional' }],
});

/** The real runner and the real import script, with only the environment set. */
const pydepsState = (vars: Record<string, string | undefined>, requirement = 'ccpydepstest>=4.0.0') =>
  withEnv({ OC_PYDEPS_DIR: undefined, OPENCLAW_ROOT: '/cc-no-such-root', HOME: '/cc-no-such-home', CC_PYTHON: undefined, ...vars }, async () =>
    only(await computeSkillRuntime({ ...harness({ skills: { '20-pydeps': pydepsNeed(requirement) } }).deps, findOnPath, runProcess }), '20-pydeps'));

test('R1: real python3 finds a package in the private pydeps folders (OC_PYDEPS_DIR as-is, OPENCLAW_ROOT, ~/.claude) and reads its patch version', async (t) => {
  const py = await realPython();
  if (!py || !POSIX) { t.skip('a real python3 with importlib.metadata is needed'); return; }

  const root = tmpDir('pydeps');
  const home = tmpDir('home');
  // OC_PYDEPS_DIR is the package folder itself; the other two roots carry pydeps/py<X.Y>.
  plantPackage(path.join(root, 'explicit'));
  plantPackage(path.join(root, 'oc', 'pydeps', py.tag));
  plantPackage(path.join(home, '.claude', 'pydeps', py.tag));
  // A package under <OC_PYDEPS_DIR>/py<X.Y> is NOT on the list: the variable is used as-is.
  plantPackage(path.join(root, 'appended', py.tag));

  try {
    const without = await pydepsState({});
    assert.equal(without.state, 'BLOCKED', 'with no private folder on the list the package is genuinely missing');
    assert.match(without.checks[0].detail, /ModuleNotFoundError/);

    assert.equal((await pydepsState({ OC_PYDEPS_DIR: path.join(root, 'explicit') })).state, 'READY', 'OC_PYDEPS_DIR is the package folder itself');
    assert.equal((await pydepsState({ OC_PYDEPS_DIR: path.join(root, 'appended') })).state, 'BLOCKED', 'no py<X.Y> is appended to OC_PYDEPS_DIR');
    assert.equal((await pydepsState({ OPENCLAW_ROOT: path.join(root, 'oc') })).state, 'READY', '<OPENCLAW_ROOT>/pydeps/py<X.Y>');
    assert.equal((await pydepsState({ HOME: home })).state, 'READY', '~/.claude/pydeps/py<X.Y>');

    const tooOld = await pydepsState({ OC_PYDEPS_DIR: path.join(root, 'explicit') }, 'ccpydepstest>=4.0.1');
    assert.equal(tooOld.state, 'BLOCKED', 'the floor keeps its patch number: 4.0.0 is older than 4.0.1');
    assert.match(tooOld.checks[0].detail, /installed 4\.0\.0 is older than the required 4\.0\.1/);
    assert.equal((await pydepsState({ OC_PYDEPS_DIR: path.join(root, 'explicit') }, 'ccpydepstest>=3.9.9')).state, 'READY');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('R1b: precedence when two private folders hold the same package: OC_PYDEPS_DIR, then OPENCLAW_ROOT, then ~/.claude', async (t) => {
  const py = await realPython();
  if (!py || !POSIX) { t.skip('a real python3 with importlib.metadata is needed'); return; }

  const root = tmpDir('prec');
  const home = tmpDir('prec-home');
  try {
    // New copy (5.0.0) in OC_PYDEPS_DIR, old copy (1.0.0) in ~/.claude: the first folder answers, floor >=3.0 is met.
    plantPackage(path.join(root, 'explicit'), '5.0.0');
    plantPackage(path.join(home, '.claude', 'pydeps', py.tag), '1.0.0');
    const wins = await pydepsState({ OC_PYDEPS_DIR: path.join(root, 'explicit'), HOME: home }, 'ccpydepstest>=3.0');
    assert.equal(wins.state, 'READY', 'OC_PYDEPS_DIR (5.0.0) shadows ~/.claude (1.0.0)');

    // Reversed: old copy first, so the new copy further down the list must NOT rescue it.
    fs.rmSync(path.join(root, 'explicit'), { recursive: true, force: true });
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    plantPackage(path.join(root, 'explicit'), '1.0.0');
    plantPackage(path.join(home, '.claude', 'pydeps', py.tag), '5.0.0');
    const loses = await pydepsState({ OC_PYDEPS_DIR: path.join(root, 'explicit'), HOME: home }, 'ccpydepstest>=3.0');
    assert.equal(loses.state, 'BLOCKED', 'OC_PYDEPS_DIR (1.0.0) shadows ~/.claude (5.0.0)');
    assert.match(loses.checks[0].detail, /installed 1\.0\.0 is older than the required 3\.0/);

    // The middle rung: <OPENCLAW_ROOT>/pydeps beats ~/.claude when OC_PYDEPS_DIR is unset.
    // Start ~/.claude clean: the block above left a 5.0.0 copy there, which would also satisfy >=3.0 and hide a swapped rung.
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    plantPackage(path.join(root, 'oc', 'pydeps', py.tag), '5.0.0');
    plantPackage(path.join(home, '.claude', 'pydeps', py.tag), '1.0.0');
    assert.equal((await pydepsState({ OPENCLAW_ROOT: path.join(root, 'oc'), HOME: home }, 'ccpydepstest>=3.0')).state, 'READY', '<OPENCLAW_ROOT>/pydeps (5.0.0) shadows ~/.claude (1.0.0)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('R1c: a child that sleeps past the 4 s cap is cut off and reads UNKNOWN, never READY or BLOCKED', async (t) => {
  if (!POSIX) { t.skip('shell stub'); return; }
  const dir = tmpDir('hang');
  try {
    // `exec` so the sleeper IS the pinned interpreter: the timeout kill reaches it and frees the pipes.
    const stub = path.join(dir, 'python3');
    writeExe(stub, '#!/bin/sh\nexec sleep 60\n');
    const started = Date.now();
    const row = await pydepsState({ CC_PYTHON: stub });
    const elapsedMs = Date.now() - started;
    assert.equal(row.state, 'UNKNOWN', 'a hang is "could not tell"');
    assert.equal(row.checks[0].outcome, 'unknown');
    assert.equal(row.checks[0].rc, null, 'no exit code: the child was killed');
    assert.match(row.checks[0].detail, /timed out/);
    assert.ok(elapsedMs < 30_000, `the check must give up near the cap, not wait out the 60 s sleep (took ${elapsedMs} ms)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R2: a program in a standard folder that is missing from PATH is found; absent everywhere is still missing', async (t) => {
  if (!POSIX) { t.skip('POSIX folders'); return; }
  const home = tmpDir('bin');
  try {
    writeExe(path.join(home, '.local', 'bin', 'cc-fake-tool'), '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(home, '.local', 'bin', 'cc-not-runnable'), 'x', { mode: 0o644 });
    await withEnv({ HOME: home, PATH: '/cc-no-such-folder' }, async () => {
      assert.equal(await findOnPath('cc-fake-tool'), path.join(home, '.local', 'bin', 'cc-fake-tool'), '~/.local/bin is searched after PATH');
      assert.equal(await findOnPath('cc-not-runnable'), null, 'a file that is not executable is not a program');
      assert.equal(await findOnPath('cc-no-such-program-anywhere'), null);
      // Control for the instrument: a real program is found with a PATH that does not list it.
      const sh = await findOnPath('sh');
      assert.ok(sh && /\/(usr\/)?bin\/sh$/.test(sh), `sh should be found in a standard folder, got ${sh}`);
    });
    // The whole-skill path: PATH is empty, python3 still resolves, and a real import runs.
    await withEnv({ PATH: '/cc-no-such-folder', HOME: home, CC_PYTHON: undefined }, async () => {
      const row = only(await computeSkillRuntime({ ...harness({ skills: { [SKILL_83]: PREREQS_83 } }).deps, findOnPath, runProcess }));
      const bin = row.checks.find((c) => c.kind === 'binary')!;
      if (bin.outcome === 'missing') t.diagnostic('no python3 in any standard folder on this machine');
      else assert.equal(bin.outcome, 'ok', 'python3 is not BLOCKED just because the service PATH is short');
    });
    // A name with a folder in it (the pin) is checked directly, never searched for.
    assert.equal(await findOnPath(path.join(home, '.local', 'bin', 'cc-fake-tool')), path.join(home, '.local', 'bin', 'cc-fake-tool'));
    assert.equal(await findOnPath(path.join(home, 'nope')), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('R2+R3: CC_PYTHON through the real runner; a pinned stub that crashes is UNKNOWN, a missing pin is UNKNOWN, neither is swapped', async (t) => {
  if (!POSIX) { t.skip('shell stub'); return; }
  const dir = tmpDir('pin');
  try {
    const stub = path.join(dir, 'python3');
    writeExe(stub, '#!/bin/sh\necho "xcode-select: note: no developer tools were found" >&2\nexit 1\n');
    const real = (vars: Record<string, string | undefined>) => withEnv(vars, async () =>
      only(await computeSkillRuntime({ ...harness({ skills: { [SKILL_83]: PREREQS_83 } }).deps, findOnPath, runProcess })));

    const crashed = await real({ CC_PYTHON: stub });
    assert.equal(crashed.state, 'UNKNOWN', 'exit 1 with nothing on stdout is not a proven missing package');
    const py = crashed.checks.find((c) => c.kind === 'python_module')!;
    assert.equal(py.resolvedPath, stub, 'the pinned interpreter is the one that ran');
    assert.equal(py.rc, 1);
    assert.equal(py.outcome, 'unknown');

    const gone = await real({ CC_PYTHON: path.join(dir, 'does-not-exist') });
    assert.equal(gone.state, 'UNKNOWN');
    assert.ok(gone.checks.every((c) => c.outcome === 'unknown'), 'no other python3 was tried in its place');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real python3: a binary minVersion is read with --version', async (t) => {
  const py = await realPython();
  if (!py) { t.skip('a real python3 is needed'); return; }
  const need = (minVersion: string) => JSON.stringify({
    prerequisites: [{ type: 'binary', check: { binary: 'python3', minVersion }, severity: 'required' }],
  });
  const state = (minVersion: string) => withEnv({ CC_PYTHON: undefined }, async () =>
    only(await computeSkillRuntime({ ...harness({ skills: { '27-video': need(minVersion) } }).deps, findOnPath, runProcess }), '27-video'));
  assert.equal((await state('3.0')).state, 'READY');
  const tooNew = await state('99.0');
  assert.equal(tooNew.state, 'BLOCKED');
  assert.match(tooNew.checks[0].detail, /is older than the required 99\.0/);
});
