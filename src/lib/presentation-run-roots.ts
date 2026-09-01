/**
 * Run-root-agnostic resolution for Presentations run directories
 * (2026-08-27, OPUS-13).
 *
 * The department tree (<ws>/departments/Presentations/runs) is only ONE place
 * runs live; client deck runs legitimately land elsewhere (this box:
 * ~/webinar-decks/<client>/<deck>/<date>/). These helpers give every
 * component the SAME configurable multi-root setting:
 *
 *   PRESENTATION_RUNS_DIRS — os.pathsep-separated list of extra run roots.
 *   A leading "!" makes the list EXCLUSIVE (exactly these roots).
 *   The department tree remains the default primary root whenever the list
 *   is additive, so one component's extra roots never blind the others to
 *   dept-tree runs.
 *
 * BINDING DOCTRINE: absence of a run inside every scanned root is NEVER
 * proof the run does not exist. Callers must treat "nothing found" as
 * UNDETERMINED and must never block, heal, fail, or alarm on path absence
 * alone.
 */

import os from 'os';
import path from 'path';

export const DEPARTMENT_PRESENTATIONS_RUNS = path.join(
  process.env.HOME || os.homedir(),
  '.openclaw', 'workspace', 'departments', 'Presentations', 'runs',
);

/** Resolve the effective run-root list (order preserved, deduped). */
export function resolvePresentationRunRoots(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dept = path.join(
    env.HOME || os.homedir(),
    '.openclaw', 'workspace', 'departments', 'Presentations', 'runs',
  );
  const raw = (env.PRESENTATION_RUNS_DIRS || '').trim();
  if (!raw) return [dept];
  const exclusive = raw.startsWith('!');
  const parts = raw
    .replace(/^!/, '')
    .split(PATHSEP)
    .map((p) => p.trim())
    .filter(Boolean);
  const roots = parts.map((p) => expandTildeRoot(p, env));
  if (!exclusive && !roots.includes(dept)) roots.unshift(dept);
  return Array.from(new Set(roots));
}

/** Expand a leading ~ (alone or before a path separator) to $HOME. */
export function expandTildeRoot(p: string, env: NodeJS.ProcessEnv = process.env): string {
  if (p === '~') return env.HOME || os.homedir();
  if (p.startsWith('~/')) return path.join(env.HOME || os.homedir(), p.slice(2));
  return p;
}

const PATHSEP = process.platform === 'win32' ? ';' : ':';