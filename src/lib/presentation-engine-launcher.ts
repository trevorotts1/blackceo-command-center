/**
 * presentation-engine-launcher.ts — Item 19 (FIX-PLAN): the Command
 * Center's one door to the presentation engine's launcher.
 *
 * The engine-honored resume for a parked run is the dispatch the on-box
 * poller itself uses (presentation-intake-poll.sh's resume line):
 *
 *   python3 -m presentation_job.launcher --resume --run-dir <run_dir>
 *
 * executed FROM the engine scripts dir. The launcher applies the engine's
 * own gates before spawning anything (engine lease / already-running,
 * capacity, notify transport, model plan, manifest auto-repin) and spawns
 * the engine detached in its own session. Its exit code is the verdict:
 * 0 means an engine process was spawned; every nonzero code is a named
 * refusal family (capacity unmeasured, credit refused, notify
 * unconfigured, OCR missing, mode invalid, model plan unsatisfied, repin
 * failed, already running / already DONE) with NOTHING spawned, and the
 * refusal text is printed by the launcher itself.
 *
 * This module only runs that command and reports what it said. It never
 * writes engine state, never moves a board task, and never upgrades an
 * exit code into a success.
 *
 * WHICH engine and WHICH interpreter: the directory comes from the
 * four-candidate order in resolveEngineScriptsDirDetail (explicit setting,
 * the run's recorded origin, the department scripts folder, the vendored
 * copy last), and the interpreter from resolvePipelineInterpreter, which
 * mirrors the engine's own pipeline_interp.py order. A run started under
 * one engine is never resumed under a different one — the resume module
 * compares content digests and refuses on a mismatch.
 *
 * SERVER-ONLY. Never import from a 'use client' module.
 */

import { execFile } from 'child_process';
import { constants as fsConstants, existsSync, readFileSync, readdirSync, statSync, accessSync } from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface EngineLaunchResult {
  exitCode: number | null;
  /** Bounded tail of the launcher's combined output (its own words). */
  output: string;
}

const OUTPUT_TAIL_CHARS = 2000;
const LAUNCH_TIMEOUT_MS = 60_000;

/** Which candidate produced the engine directory the resume will use. */
export type EngineScriptsSource = 'env' | 'state_origin' | 'department' | 'vendored';

export interface EngineScriptsResolution {
  dir: string;
  source: EngineScriptsSource;
}

/** Which layer produced the interpreter the resume will run under. */
export type InterpreterSource = 'env' | 'department_venv' | 'python3';

export interface InterpreterResolution {
  path: string;
  source: InterpreterSource;
}

/** The run's recorded engine identity (`state.json` → `engine_origin`). */
export interface EngineOriginRecord {
  packageDir: string | null;
  packageDigest: string | null;
  contractVersion: number | null;
  distributor: string | null;
  packageFiles: number | null;
  commit: string | null;
}

/** The engine's own launcher module — the only proof a directory can run it. */
function carriesEngine(dir: string): boolean {
  try {
    return existsSync(path.join(dir, 'presentation_job', 'launcher.py'));
  } catch {
    return false;
  }
}

/**
 * The selected client's OpenClaw root (the same boundary the engine's
 * oc_paths uses): explicit pins win, then $HOME/.openclaw.
 */
export function openclawRoot(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of ['OPENCLAW_ROOT', 'OC_ROOT'] as const) {
    const raw = env[name]?.trim();
    if (raw) return raw;
  }
  return path.join(env.HOME?.trim() || os.homedir(), '.openclaw');
}

/**
 * The materialized department scripts folder under the OpenClaw workspace —
 * the path the department template materialization and the canonical door
 * both name (`$OC_WORKSPACE/departments/Presentations/scripts`).
 */
export function departmentScriptsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(openclawRoot(env), 'workspace', 'departments', 'Presentations', 'scripts');
}

/**
 * Where the engine scripts live, in the order the department's own repair
 * receipt requires:
 *   1. the operator's explicit setting (PRESENTATION_ENGINE_SCRIPTS_DIR);
 *   2. the scripts folder the run itself recorded (`state.json`
 *      `engine_origin.package_dir`) — the engine that STARTED the build;
 *   3. the materialized department scripts folder under the OpenClaw
 *      workspace;
 *   4. the Command Center directory (the vendored presentation_job package
 *      the CC engine sync maintains), last.
 *
 * A candidate counts only when it actually contains the launcher module.
 * A configured-but-wrong explicit path is a REFUSAL (null), never a silent
 * fallthrough to a different engine: the operator named that directory.
 */
export function resolveEngineScriptsDirDetail(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  opts?: { recordedPackageDir?: string | null },
): EngineScriptsResolution | null {
  const explicit = env.PRESENTATION_ENGINE_SCRIPTS_DIR?.trim();
  if (explicit) {
    return carriesEngine(explicit) ? { dir: explicit, source: 'env' } : null;
  }

  const recorded = opts?.recordedPackageDir?.trim();
  if (recorded && carriesEngine(recorded)) {
    return { dir: recorded, source: 'state_origin' };
  }

  const department = departmentScriptsDir(env);
  if (carriesEngine(department)) {
    return { dir: department, source: 'department' };
  }

  return carriesEngine(cwd) ? { dir: cwd, source: 'vendored' } : null;
}

/** Compatibility wrapper: just the directory, or null for the refusal. */
export function resolveEngineScriptsDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  opts?: { recordedPackageDir?: string | null },
): string | null {
  return resolveEngineScriptsDirDetail(env, cwd, opts)?.dir ?? null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!path.isAbsolute(candidate) || !statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The interpreter the pipeline runs under, mirroring the engine's own
 * pipeline_interp.py order (PRES-035): the operator's pin
 * (PRESENTATION_PIPELINE_INTERPRETER) when it is an executable file; then
 * the department environment's Python
 * (`<client-root>/.venv-presentations/bin/python`, the FIX 71 shape); then
 * PATH `python3`. A set-but-unusable pin is reported by falling through,
 * never by pretending it ran.
 */
export function resolvePipelineInterpreter(
  env: NodeJS.ProcessEnv = process.env,
): InterpreterResolution {
  const pin = env.PRESENTATION_PIPELINE_INTERPRETER?.trim();
  if (pin && isExecutableFile(pin)) return { path: pin, source: 'env' };

  const venv = path.join(openclawRoot(env), '.venv-presentations', 'bin', 'python');
  if (existsSync(venv)) return { path: venv, source: 'department_venv' };

  return { path: 'python3', source: 'python3' };
}

/**
 * The engine's content identity, computed the way its own
 * `engine_origin.package_digest` is: every `*.py`/`*.json` file directly in
 * `presentation_job` except the parity manifest, sorted by name, each
 * recorded as byte length + sha256, hashed as canonical JSON. Null when the
 * directory cannot be read (UNDETERMINED, never a guessed identity).
 */
export function enginePackageDigest(scriptsDir: string): string | null {
  const dir = path.join(scriptsDir, 'presentation_job');
  try {
    const names = readdirSync(dir)
      .filter((n) => n !== 'PARITY-MANIFEST.json' && (n.endsWith('.py') || n.endsWith('.json')))
      .sort();
    const files: Array<{ bytes: number; name: string; sha256: string }> = [];
    for (const name of names) {
      const p = path.join(dir, name);
      if (!statSync(p).isFile()) continue;
      files.push({
        bytes: statSync(p).size,
        name,
        sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
      });
    }
    return createHash('sha256').update(JSON.stringify(files)).digest('hex');
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The engine identity the run was STARTED under, from its own state.json.
 * Null when the file or the record is absent/unreadable — a pre-origin run
 * is UNDETERMINED, never assumed to match.
 */
export function readEngineOrigin(runDir: string): EngineOriginRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const origin = (raw as Record<string, unknown>).engine_origin;
  if (typeof origin !== 'object' || origin === null || Array.isArray(origin)) return null;
  const o = origin as Record<string, unknown>;
  const commitRec = o.distributor_commit;
  const commit =
    typeof commitRec === 'object' && commitRec !== null && !Array.isArray(commitRec)
      ? str((commitRec as Record<string, unknown>).commit)
      : null;
  return {
    packageDir: str(o.package_dir),
    packageDigest: str(o.package_digest),
    contractVersion: typeof o.contract_version === 'number' ? o.contract_version : null,
    distributor: str(o.distributor),
    packageFiles: typeof o.package_files === 'number' ? o.package_files : null,
    commit,
  };
}

/**
 * Dispatch the engine's resume for one run dir through its launcher.
 * Resolves with the launcher's exit code and output tail in ALL cases
 * (a nonzero exit is data, not an exception); rejects only when the
 * process could not be started at all or outlived the timeout, which the
 * caller reports as a transport refusal with the error's own words.
 */
export async function launchEngineResume(
  runDir: string,
  scriptsDir: string,
  interpreter: string = resolvePipelineInterpreter().path,
): Promise<EngineLaunchResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      interpreter,
      ['-m', 'presentation_job.launcher', '--resume', '--run-dir', runDir],
      {
        cwd: scriptsDir,
        timeout: LAUNCH_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        env: { ...process.env, PRESENTATION_LEASE_WHO: 'cc-board-resume' },
      },
    );
    return { exitCode: 0, output: tail(`${stdout}\n${stderr}`) };
  } catch (error) {
    const e = error as Error & {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    const exitCode = typeof e.code === 'number' ? e.code : null;
    const combined = `${typeof e.stdout === 'string' ? e.stdout : ''}\n${typeof e.stderr === 'string' ? e.stderr : ''}`;
    return {
      exitCode,
      output: tail(combined.trim().length > 0 ? combined : e.message),
    };
  }
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL_CHARS
    ? trimmed.slice(trimmed.length - OUTPUT_TAIL_CHARS)
    : trimmed;
}
