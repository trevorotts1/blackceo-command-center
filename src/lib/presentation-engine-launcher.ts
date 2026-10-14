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
 * SERVER-ONLY. Never import from a 'use client' module.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
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

/**
 * Where the engine scripts live on this box. First the operator's explicit
 * setting (PRESENTATION_ENGINE_SCRIPTS_DIR); then the Command Center's own
 * directory, which carries the vendored presentation_job package the CC
 * engine sync maintains. A candidate counts only when it actually contains
 * the launcher module — a configured-but-wrong path is a refusal, never a
 * silent fallthrough to a directory that cannot run the engine.
 */
export function resolveEngineScriptsDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | null {
  const candidates: string[] = [];
  const explicit = env.PRESENTATION_ENGINE_SCRIPTS_DIR?.trim();
  if (explicit) candidates.push(explicit);
  candidates.push(cwd);
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'presentation_job', 'launcher.py'))) {
      return dir;
    }
  }
  return null;
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
): Promise<EngineLaunchResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'python3',
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
