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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  computeSkillRuntime,
  createBoundedCache,
  findOnPath,
  friendlySkillName,
  parseRequirement,
  parseSkillNeeds,
  resolveSkillsDir,
  runProcess,
  skillMessage,
  summarizeSkill,
  toClientSkills,
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

test('parser: only a >= requirement is a floor', () => {
  assert.deepEqual(parseRequirement('jsonschema>=4.0', 'x'), { dist: 'jsonschema', floor: [4, 0] });
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
    'Needs a quick fix: Black Friday Launcher is missing a helper it needs. Your system will repair this on the next update.',
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
    'Needs a quick fix: Black Friday Launcher is missing a helper it needs. Your system will repair this on the next update.',
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
  assert.deepEqual(args.slice(2), ['jsonschema', 'jsonschema', '4', '0'], 'module, package and floor travel as argv');
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

// ── cache: brief, shared, never blocks ──────────────────────────────────────

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
    'Needs a quick fix: Black Friday Launcher is missing a helper it needs. Your system will repair this on the next update.',
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
  assert.match(visible, /Needs a quick fix: Black Friday Launcher is missing a helper it needs/);
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
