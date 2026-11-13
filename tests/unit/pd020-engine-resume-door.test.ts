/**
 * PD-020 — resume with the department's engine and interpreter.
 *
 * The defect: the board's resume ran whatever engine sat in the Command
 * Center directory under a hardcoded `python3`. A run started by the
 * department's materialized engine was resumed by the vendored copy, and an
 * operator repair receipt (tied to the hash of the dispatcher file that
 * issued it) was then refused by the engine that actually ran.
 *
 * What this pins:
 *   1. the four-candidate engine order — PRESENTATION_ENGINE_SCRIPTS_DIR,
 *      the run's own recorded `engine_origin.package_dir`, the department
 *      scripts folder under the OpenClaw workspace, the vendored copy last;
 *   2. a configured-but-wrong explicit path is a refusal, never a silent
 *      fallthrough to a different engine;
 *   3. a stored department folder still wins when the vendored copy exists;
 *   4. the interpreter order — PRESENTATION_PIPELINE_INTERPRETER when it is
 *      an executable file, the department venv's Python, then `python3`;
 *   5. the version refusal: a chosen engine whose content digest differs
 *      from the digest the run recorded never spawns the launcher;
 *   6. the dispatch outcome names the folder and interpreter it used.
 *
 * The process spawn is the only stubbed seam; every resolver runs for real.
 */

import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../../src/lib/db';
import { resolveActiveCompanyId } from '../../src/lib/company';
import { registerPresentationRun } from '../../src/lib/presentation-run-bindings';
import {
  departmentScriptsDir,
  enginePackageDigest,
  openclawRoot,
  readEngineOrigin,
  resolveEngineScriptsDir,
  resolveEngineScriptsDirDetail,
  resolvePipelineInterpreter,
} from '../../src/lib/presentation-engine-launcher';

const launcherMock = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@/lib/presentation-engine-launcher', async (importOriginal) => {
  const orig =
    await importOriginal<typeof import('../../src/lib/presentation-engine-launcher')>();
  return { ...orig, launchEngineResume: launcherMock.launch };
});

import { resumeParkedEngineRun } from '../../src/lib/presentation-engine-resume';

// ── Fixtures ────────────────────────────────────────────────────────────────

const ROOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'pd020-roots-'));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pd020-scratch-'));
process.env.PRESENTATION_RUNS_DIRS = ROOTS;

const MUTATED_ENV = [
  'PRESENTATION_ENGINE_SCRIPTS_DIR',
  'PRESENTATION_PIPELINE_INTERPRETER',
  'HOME',
  'OPENCLAW_ROOT',
  'OC_ROOT',
] as const;
const SAVED_ENV: Record<string, string | undefined> = {};
for (const name of MUTATED_ENV) SAVED_ENV[name] = process.env[name];

afterAll(() => {
  for (const name of MUTATED_ENV) {
    if (SAVED_ENV[name] === undefined) delete process.env[name];
    else process.env[name] = SAVED_ENV[name];
  }
});

let seq = 0;
function scratchDir(prefix: string): string {
  seq += 1;
  const dir = path.join(SCRATCH, `${prefix}-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A directory that can run the engine: presentation_job/launcher.py. */
function engineDir(extraFiles: Record<string, string> = {}): string {
  const dir = scratchDir('engine');
  fs.mkdirSync(path.join(dir, 'presentation_job'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'presentation_job', 'launcher.py'), '# stub launcher\n');
  for (const [name, body] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, 'presentation_job', name), body);
  }
  return dir;
}

function executableFile(body = '#!/bin/sh\nexit 0\n'): string {
  const dir = scratchDir('interp');
  const p = path.join(dir, 'python');
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: path.join(SCRATCH, 'no-home') };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function makeRunDir(taskId: string): string {
  const dir = path.join(ROOTS, `run-${taskId}`);
  fs.mkdirSync(path.join(dir, 'working', 'checkpoints'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'working', 'checkpoints', 'process_manifest.json'),
    JSON.stringify({ cc_task_id: taskId, run_id: `run-${taskId}` }),
  );
  return dir;
}

function writeState(runDir: string, state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2));
}

function insertTask(taskId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const workspaceId = `pd020-workspace`;
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, slug, company_id) VALUES (?, ?, ?, ?)')
    .run(workspaceId, 'PD-020 fixture', workspaceId, resolveActiveCompanyId(db));
  db.prepare(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, department, source, parent_task_id, created_at, updated_at)
     VALUES (?, ?, 'Deck build.', 'blocked', 'medium', ?, 'default', 'presentations', 'build_deck', NULL, ?, ?)`,
  ).run(taskId, `PD-020 ${taskId}`, workspaceId, now, now);
}

// ── 1. The four-candidate engine order ──────────────────────────────────────

describe('PD-020 engine directory: the four-candidate order', () => {
  it('candidate 1: PRESENTATION_ENGINE_SCRIPTS_DIR wins over everything', () => {
    const env = engineDir();
    const recorded = engineDir();
    const vendored = engineDir();
    const resolved = resolveEngineScriptsDirDetail(
      childEnv({ PRESENTATION_ENGINE_SCRIPTS_DIR: env }),
      vendored,
      { recordedPackageDir: recorded },
    );
    expect(resolved).toEqual({ dir: env, source: 'env' });
  });

  it('a configured-but-wrong explicit path is a REFUSAL, not a fallthrough', () => {
    const wrong = scratchDir('wrong');
    const recorded = engineDir();
    const vendored = engineDir();
    const env = childEnv({ PRESENTATION_ENGINE_SCRIPTS_DIR: wrong });
    expect(resolveEngineScriptsDirDetail(env, vendored, { recordedPackageDir: recorded })).toBeNull();
    expect(resolveEngineScriptsDir(env, vendored, { recordedPackageDir: recorded })).toBeNull();
  });

  it('candidate 2: the run state’s recorded engine folder is used when nothing is configured', () => {
    const recorded = engineDir();
    const vendored = engineDir();
    expect(
      resolveEngineScriptsDirDetail(childEnv(), vendored, { recordedPackageDir: recorded }),
    ).toEqual({ dir: recorded, source: 'state_origin' });
  });

  it('candidate 3: the department scripts folder beats the vendored copy', () => {
    const home = scratchDir('home');
    const vendored = engineDir();
    const env = childEnv({ HOME: home });
    const dept = departmentScriptsDir(env);
    fs.mkdirSync(path.join(dept, 'presentation_job'), { recursive: true });
    fs.writeFileSync(path.join(dept, 'presentation_job', 'launcher.py'), '# dept launcher\n');
    expect(resolveEngineScriptsDirDetail(env, vendored)).toEqual({ dir: dept, source: 'department' });
  });

  it('candidate 4: the vendored copy is last, and only when it carries the launcher', () => {
    const home = scratchDir('home');
    const vendored = engineDir();
    expect(resolveEngineScriptsDirDetail(childEnv({ HOME: home }), vendored)).toEqual({
      dir: vendored,
      source: 'vendored',
    });
    const empty = scratchDir('empty');
    expect(resolveEngineScriptsDirDetail(childEnv({ HOME: home }), empty)).toBeNull();
  });

  it('amendment: a state recording the department folder resumes with it even when the vendored copy exists', () => {
    const home = scratchDir('home');
    const env = childEnv({ HOME: home });
    const dept = departmentScriptsDir(env);
    fs.mkdirSync(path.join(dept, 'presentation_job'), { recursive: true });
    fs.writeFileSync(path.join(dept, 'presentation_job', 'launcher.py'), '# dept launcher\n');
    const vendored = engineDir();
    const resolved = resolveEngineScriptsDirDetail(env, vendored, { recordedPackageDir: dept });
    expect(resolved).toEqual({ dir: dept, source: 'state_origin' });
    expect(resolved?.dir).not.toBe(vendored);
  });

  it('the OpenClaw root honors an explicit pin before $HOME', () => {
    const pin = scratchDir('oc-root');
    expect(openclawRoot(childEnv({ OPENCLAW_ROOT: pin, HOME: scratchDir('home') }))).toBe(pin);
  });
});

// ── 2. The interpreter order ────────────────────────────────────────────────

describe('PD-020 interpreter: the pipeline order', () => {
  it('an executable PRESENTATION_PIPELINE_INTERPRETER wins', () => {
    const pin = executableFile();
    expect(resolvePipelineInterpreter(childEnv({ PRESENTATION_PIPELINE_INTERPRETER: pin }))).toEqual({
      path: pin,
      source: 'env',
    });
  });

  it('an unusable pin falls through to the department environment’s Python, never silently claimed', () => {
    const home = scratchDir('home');
    const venv = path.join(home, '.openclaw', '.venv-presentations', 'bin');
    fs.mkdirSync(venv, { recursive: true });
    const python = path.join(venv, 'python');
    fs.writeFileSync(python, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const resolved = resolvePipelineInterpreter(
      childEnv({
        HOME: home,
        PRESENTATION_PIPELINE_INTERPRETER: path.join(scratchDir('missing'), 'python'),
      }),
    );
    expect(resolved).toEqual({ path: python, source: 'department_venv' });
  });

  it('with neither a pin nor a department venv the answer is python3', () => {
    expect(resolvePipelineInterpreter(childEnv())).toEqual({ path: 'python3', source: 'python3' });
  });
});

// ── 3. The engine identity record ───────────────────────────────────────────

describe('PD-020 engine identity', () => {
  it('the content digest covers .py/.json files and excludes the parity manifest', () => {
    const dir = engineDir({
      'a.py': 'A = 1\n',
      'b.json': '{}\n',
      'PARITY-MANIFEST.json': '{"generated":true}\n',
      'README.md': 'not counted\n',
    });
    const digest = enginePackageDigest(dir);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic for identical bytes.
    expect(enginePackageDigest(dir)).toBe(digest);
    // The parity manifest is excluded: adding it changes nothing.
    fs.writeFileSync(path.join(dir, 'presentation_job', 'PARITY-MANIFEST.json'), '{"x":1}\n');
    expect(enginePackageDigest(dir)).toBe(digest);
    // A byte change in a counted file is a different engine.
    fs.writeFileSync(path.join(dir, 'presentation_job', 'a.py'), 'A = 2\n');
    expect(enginePackageDigest(dir)).not.toBe(digest);
    // A directory with no package at all is UNDETERMINED, never a digest.
    expect(enginePackageDigest(scratchDir('no-engine'))).toBeNull();
  });

  it('the recorded origin is read from state.json, and absence is null', () => {
    const runDir = scratchDir('state-run');
    writeState(runDir, {
      job_id: 'job-1',
      engine_origin: {
        distributor: 'ONB',
        package_dir: '/somewhere/presentations/scripts',
        package_digest: 'f'.repeat(64),
        package_files: 42,
        contract_version: 1,
        distributor_commit: { repo: '/repo', commit: 'a'.repeat(40) },
      },
    });
    expect(readEngineOrigin(runDir)).toEqual({
      packageDir: '/somewhere/presentations/scripts',
      packageDigest: 'f'.repeat(64),
      contractVersion: 1,
      distributor: 'ONB',
      packageFiles: 42,
      commit: 'a'.repeat(40),
    });

    const bare = scratchDir('state-bare');
    writeState(bare, { job_id: 'job-2' });
    expect(readEngineOrigin(bare)).toBeNull();
    expect(readEngineOrigin(scratchDir('state-missing'))).toBeNull();
  });
});

// ── 4. The resume: version refusal and the dispatch it names ────────────────

describe('PD-020 resume with the recorded engine', () => {
  const MISMATCH_TASK = 'pd020-mismatch';
  const MATCH_TASK = 'pd020-match';
  let chosen = '';
  let mismatchDir = '';
  let matchDir = '';

  beforeAll(() => {
    insertTask(MISMATCH_TASK);
    insertTask(MATCH_TASK);

    chosen = engineDir({ 'a.py': 'A = 1\n' });
    process.env.PRESENTATION_ENGINE_SCRIPTS_DIR = chosen;

    const parked = {
      job_id: 'job-parked',
      terminal: 'BLOCKED',
      blocked: { phase: 'P4-RENDER', reason: 'engine diagnostic', at: '2026-10-03T09:00:00.000Z' },
      resume_history: [],
    };

    mismatchDir = makeRunDir(MISMATCH_TASK);
    writeState(mismatchDir, {
      ...parked,
      engine_origin: { package_dir: chosen, package_digest: 'ab'.repeat(32) },
    });
    registerPresentationRun({ taskId: MISMATCH_TASK, runRoot: mismatchDir, runId: `run-${MISMATCH_TASK}` });

    matchDir = makeRunDir(MATCH_TASK);
    writeState(matchDir, {
      ...parked,
      engine_origin: {
        package_dir: chosen,
        package_digest: enginePackageDigest(chosen),
      },
    });
    registerPresentationRun({ taskId: MATCH_TASK, runRoot: matchDir, runId: `run-${MATCH_TASK}` });
  });

  afterAll(() => {
    delete process.env.PRESENTATION_ENGINE_SCRIPTS_DIR;
  });

  it('a different engine version refuses in plain words and never spawns', async () => {
    launcherMock.launch.mockReset();
    const outcome = await resumeParkedEngineRun(MISMATCH_TASK, { settleMs: 0 });
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.code).toBe('engine_version_mismatch');
    expect(outcome.refusal).toBe(
      'This build was started with a different engine version. Update this box, then press Resume again.',
    );
    expect(launcherMock.launch).not.toHaveBeenCalled();
  });

  it('the matching engine resumes through the recorded folder and interpreter, and says so', async () => {
    launcherMock.launch.mockReset();
    launcherMock.launch.mockImplementation(async () => {
      const state = JSON.parse(fs.readFileSync(path.join(matchDir, 'state.json'), 'utf8'));
      state.terminal = null;
      state.blocked = null;
      state.resume_history = [{ at: '2026-10-03T10:00:00.000Z', by: 'cc-board-resume' }];
      writeState(matchDir, state);
      return { exitCode: 0, output: 'launcher: spawned engine pid 5150' };
    });

    const interpreter = resolvePipelineInterpreter(process.env).path;
    const outcome = await resumeParkedEngineRun(MATCH_TASK, { settleMs: 0 });

    expect(outcome.kind).toBe('resumed');
    if (outcome.kind !== 'resumed') return;
    expect(outcome.scriptsDir).toBe(chosen);
    expect(outcome.interpreter).toBe(interpreter);
    expect(outcome.detail).toContain(chosen);
    expect(outcome.detail).toContain(interpreter);
    expect(launcherMock.launch).toHaveBeenCalledTimes(1);
    expect(launcherMock.launch).toHaveBeenCalledWith(matchDir, chosen, interpreter);
  });
});
