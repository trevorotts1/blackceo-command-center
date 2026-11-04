/**
 * Skill runtime readiness.
 *
 * WHY THIS EXISTS. "Installed" is not "can run". A skill folder can sit on disk
 * with every file present and still crash halfway through a long build because
 * a helper it imports (a Python package) or a program it shells out to is not
 * on the box. Nothing in the Command Center looked past the folder.
 *
 * WHAT IT DOES. For each installed skill that ships a PREREQS.json, it checks
 * the two kinds of requirement that can be decided by running something:
 *   - `pythonModule` entries: a REAL import in the box's python3 (never a
 *     file-existence guess), with the ">=X.Y" floor enforced. Always counted,
 *     whatever the entry's severity — a skill that imports it dies without it.
 *   - `binary` entries with severity "required": a PATH lookup.
 * Entries tied to an optional feature (`when`), credentials, other skills and
 * manual notes are out of scope here.
 *
 * READ-ONLY. This module never installs anything. The repair is the box
 * updater's job; the row only says whether the repair is still owed.
 *
 * NEVER BLOCKS THE PAGE. Child processes are bounded by a timeout, identical
 * checks run once, results are cached briefly, and the cached getter resolves
 * within a fixed budget (the slow probe finishes in the background).
 *
 * UNKNOWN IS NOT READY. A check that could not run (no interpreter, timeout,
 * unreadable file) is UNKNOWN and never rolls up to READY.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveOpenClawRuntimeRoot } from '@/lib/openclaw/runtime-root';

import type { ReadinessState } from './types';

const execFileAsync = promisify(execFile);

const CHILD_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 60_000;
const PAGE_BUDGET_MS = 6_000;
const MAX_PREREQS_BYTES = 262_144;

// Exit codes of the import check below. 1 and 3 are proven faults; 4 means the
// module imports but its version could not be read.
const RC_OK = 0;
const RC_IMPORT_FAILED = 1;
const RC_TOO_OLD = 3;

/**
 * Fixed script, passed with `-c`; the only variable parts arrive as argv, so no
 * value is ever interpolated into code or a shell. `import_module` really
 * imports (find_spec would pass a package whose own dependency is missing).
 * SystemExit is not an Exception, so the sys.exit calls pass through the except.
 */
const PY_IMPORT_CHECK = String.raw`import importlib, re, sys
mod, dist, major, minor = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
try:
    importlib.import_module(mod)
    if (major, minor) != (0, 0):
        try:
            from importlib.metadata import version
            got = (tuple(int(x) for x in re.findall(r"\d+", version(dist))[:2]) + (0, 0))[:2]
        except Exception as e:
            print("version unreadable: %s: %s" % (type(e).__name__, e))
            sys.exit(4)
        if got < (major, minor):
            print("installed %d.%d is older than the required %d.%d" % (got + (major, minor)))
            sys.exit(3)
except Exception as e:
    print("%s: %s" % (type(e).__name__, e))
    sys.exit(1)`;

const MODULE_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const BINARY_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const DIST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*/;
const FLOOR_RE = />=\s*(\d+)(?:\.(\d+))?/;

// ── types ───────────────────────────────────────────────────────────────────

export interface PythonModuleNeed {
  kind: 'python_module';
  module: string;
  /** Package name used for the version lookup (the name in `requirement`). */
  dist: string;
  /** The requirement text as the skill wrote it, e.g. "jsonschema>=4.0". */
  requirement: string;
  /** [major, minor] floor from a ">=" requirement, or null for "any version". */
  floor: [number, number] | null;
}

export interface BinaryNeed {
  kind: 'binary';
  binary: string;
}

export type SkillNeed = PythonModuleNeed | BinaryNeed;

export interface SkillCheckDetail {
  kind: SkillNeed['kind'] | 'prerequisites_file' | 'skills_dir';
  target: string;
  requirement?: string;
  outcome: 'ok' | 'missing' | 'unknown';
  /** Interpreter or program path that answered (operator detail only). */
  resolvedPath?: string;
  rc?: number | null;
  detail: string;
}

export interface SkillRuntimeResult {
  /** Skill folder name, e.g. "83-black-friday-launcher"; "all" for whole-directory faults. */
  skill: string;
  /** Plain-English name for people, e.g. "Black Friday Launcher". */
  name: string;
  state: ReadinessState;
  /** Plain-English line, safe to show a client. */
  message: string;
  /** Technical detail for operators. Never shown to clients. */
  checks: SkillCheckDetail[];
}

export interface ProcessResult {
  rc: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the program could not be started at all (e.g. ENOENT). */
  spawnError: string | null;
}

export interface SkillRuntimeDeps {
  skillsDir(): string;
  /** Throws when the directory cannot be read. */
  listSkillDirs(dir: string): Promise<string[]>;
  /** PREREQS.json text, or null when the skill ships none. */
  readPrereqs(dir: string, skill: string): Promise<string | null>;
  /** Absolute path of the first match on PATH, or null. */
  findOnPath(binary: string): Promise<string | null>;
  runProcess(file: string, args: string[]): Promise<ProcessResult>;
}

// ── pure parsing and mapping ────────────────────────────────────────────────

/** "jsonschema>=4.0" -> { dist: 'jsonschema', floor: [4, 0] }. Only ">=" is a floor. */
export function parseRequirement(requirement: string, fallbackDist: string): {
  dist: string;
  floor: [number, number] | null;
} {
  const dist = DIST_RE.exec(requirement.trim())?.[0] ?? fallbackDist;
  const m = FLOOR_RE.exec(requirement);
  return { dist, floor: m ? [Number(m[1]), Number(m[2] ?? 0)] : null };
}

/**
 * Extract the checkable requirements from PREREQS.json text.
 * Returns null when the file is not usable (so the caller reports UNKNOWN, not
 * "nothing to check"), and [] when it is valid but has nothing checkable.
 */
export function parseSkillNeeds(text: string): SkillNeed[] | null {
  if (text.length > MAX_PREREQS_BYTES) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const list = (doc as { prerequisites?: unknown }).prerequisites;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;

  const needs: SkillNeed[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    if (typeof p.pythonModule === 'string') {
      if (!MODULE_RE.test(p.pythonModule)) continue;
      const requirement = typeof p.requirement === 'string' ? p.requirement : p.pythonModule;
      const { dist, floor } = parseRequirement(requirement, p.pythonModule);
      needs.push({ kind: 'python_module', module: p.pythonModule, dist, requirement, floor });
      continue;
    }
    const check = p.check as { binary?: unknown } | null | undefined;
    if (
      p.type === 'binary' &&
      p.severity === 'required' &&
      p.when === undefined &&
      typeof check?.binary === 'string' &&
      BINARY_RE.test(check.binary)
    ) {
      needs.push({ kind: 'binary', binary: check.binary });
    }
  }
  return needs;
}

/** "83-black-friday-launcher" -> "Black Friday Launcher". */
export function friendlySkillName(skill: string): string {
  const words = skill.replace(/^\d+-/, '').split('-').filter(Boolean);
  return words.length === 0
    ? skill
    : words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** The client-facing line for each state. No module, interpreter or exit-code words. */
export function skillMessage(state: ReadinessState, name: string): string {
  if (state === 'READY') return 'Ready';
  if (state === 'BLOCKED') {
    return `Needs a quick fix: ${name} is missing a helper it needs. Your system will repair this on the next update.`;
  }
  return `${name} could not be checked right now.`;
}

/** Map a skill's individual check outcomes to one state. A proven fault outranks "could not tell". */
export function summarizeSkill(
  skill: string,
  checks: SkillCheckDetail[],
  name: string = friendlySkillName(skill),
): SkillRuntimeResult {
  const state: ReadinessState = checks.some((c) => c.outcome === 'missing')
    ? 'BLOCKED'
    : checks.length === 0 || checks.some((c) => c.outcome === 'unknown')
      ? 'UNKNOWN'
      : 'READY';
  return { skill, name, state, message: skillMessage(state, name), checks };
}

/** The shape the client-facing checklist exposes: no paths, modules or exit codes. */
export function toClientSkills(
  results: SkillRuntimeResult[],
): Array<Pick<SkillRuntimeResult, 'skill' | 'name' | 'state' | 'message'>> {
  return results.map(({ skill, name, state, message }) => ({ skill, name, state, message }));
}

// ── checks ──────────────────────────────────────────────────────────────────

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 200);
}

async function checkBinary(deps: SkillRuntimeDeps, need: BinaryNeed): Promise<SkillCheckDetail> {
  const found = await deps.findOnPath(need.binary);
  return found
    ? { kind: 'binary', target: need.binary, outcome: 'ok', resolvedPath: found, detail: 'found on PATH' }
    : { kind: 'binary', target: need.binary, outcome: 'missing', detail: 'not found on PATH' };
}

async function checkPythonModule(
  deps: SkillRuntimeDeps,
  need: PythonModuleNeed,
): Promise<SkillCheckDetail> {
  const base = { kind: 'python_module' as const, target: need.module, requirement: need.requirement };
  // Same interpreter the skills run under: python3 from PATH.
  const python = await deps.findOnPath('python3');
  if (!python) {
    return { ...base, outcome: 'unknown', detail: 'python3 not found on PATH, so the import could not be tried' };
  }
  const [major, minor] = need.floor ?? [0, 0];
  const res = await deps.runProcess(python, [
    '-c', PY_IMPORT_CHECK, need.module, need.dist, String(major), String(minor),
  ]);
  const common = { ...base, resolvedPath: python, rc: res.rc };
  if (res.timedOut) return { ...common, outcome: 'unknown', detail: 'import check timed out' };
  if (res.spawnError) return { ...common, outcome: 'unknown', detail: `could not start python3: ${res.spawnError}` };
  const said = firstLine(res.stdout) || firstLine(res.stderr);
  if (res.rc === RC_OK) return { ...common, outcome: 'ok', detail: 'imported' };
  if (res.rc === RC_IMPORT_FAILED || res.rc === RC_TOO_OLD) {
    return { ...common, outcome: 'missing', detail: said || 'import failed' };
  }
  return { ...common, outcome: 'unknown', detail: said || `import check exited ${res.rc}` };
}

/**
 * Check every installed skill. Identical checks run once however many skills
 * share them. Never throws: an unreadable skills directory is one UNKNOWN row.
 */
export async function computeSkillRuntime(
  deps: SkillRuntimeDeps = DEFAULT_DEPS,
): Promise<SkillRuntimeResult[]> {
  let dir: string;
  let skills: string[];
  try {
    dir = deps.skillsDir();
    skills = (await deps.listSkillDirs(dir)).slice().sort();
  } catch (err) {
    return [summarizeSkill('all', [{
      kind: 'skills_dir',
      target: 'skills',
      outcome: 'unknown',
      detail: `skills folder could not be read: ${err instanceof Error ? err.message : String(err)}`,
    }], 'Installed skills')];
  }

  const memo = new Map<string, Promise<SkillCheckDetail>>();
  const once = (key: string, run: () => Promise<SkillCheckDetail>) => {
    let p = memo.get(key);
    if (!p) memo.set(key, (p = run()));
    return p;
  };

  const perSkill = await Promise.all(skills.map(async (skill): Promise<SkillRuntimeResult | null> => {
    let text: string | null;
    try {
      text = await deps.readPrereqs(dir, skill);
    } catch (err) {
      return summarizeSkill(skill, [{
        kind: 'prerequisites_file', target: 'PREREQS.json', outcome: 'unknown',
        detail: `could not be read: ${err instanceof Error ? err.message : String(err)}`,
      }]);
    }
    if (text === null) return null;
    const needs = parseSkillNeeds(text);
    if (needs === null) {
      return summarizeSkill(skill, [{
        kind: 'prerequisites_file', target: 'PREREQS.json', outcome: 'unknown',
        detail: 'not valid prerequisites JSON',
      }]);
    }
    if (needs.length === 0) return null;
    const checks = await Promise.all(needs.map((need) =>
      need.kind === 'binary'
        ? once(`bin:${need.binary}`, () => checkBinary(deps, need))
        : once(`py:${need.module}:${need.dist}:${need.floor ?? ''}`, () => checkPythonModule(deps, need)),
    ));
    return summarizeSkill(skill, checks);
  }));
  return perSkill.filter((r): r is SkillRuntimeResult => r !== null);
}

// ── cache ───────────────────────────────────────────────────────────────────

/**
 * Wrap a slow probe: fresh result for `ttlMs`, one shared in-flight run, and a
 * hard `budgetMs` after which the caller gets `onTimeout()` while the probe
 * keeps going in the background and fills the cache when it lands.
 */
export function createBoundedCache<T>(
  compute: () => Promise<T>,
  opts: { ttlMs: number; budgetMs: number; onTimeout: () => T; now?: () => number },
): () => Promise<T> {
  const now = opts.now ?? Date.now;
  let cached: { at: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;
  return async () => {
    if (cached && now() - cached.at < opts.ttlMs) return cached.value;
    if (!inflight) {
      inflight = compute().then(
        (value) => {
          cached = { at: now(), value };
          inflight = null;
          return value;
        },
        (err) => {
          inflight = null;
          throw err;
        },
      );
      inflight.catch(() => undefined); // a late rejection after a timeout must not go unhandled
    }
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(opts.onTimeout()), opts.budgetMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([inflight, late]);
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── real dependencies ───────────────────────────────────────────────────────

/** `<OpenClaw root>/skills`: OPENCLAW_ROOT, else /data/.openclaw on VPS Docker, else ~/.openclaw. */
export function resolveSkillsDir(): string {
  return path.join(resolveOpenClawRuntimeRoot(), 'skills');
}

/** Run a program with a fixed argv (no shell), bounded by a timeout. */
export async function runProcess(file: string, args: string[]): Promise<ProcessResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      windowsHide: true,
      // Not the app's folder: with `-c` python puts the cwd first on sys.path.
      cwd: path.parse(process.cwd()).root,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    return { rc: 0, stdout, stderr, timedOut: false, spawnError: null };
  } catch (e) {
    const err = e as { code?: string | number | null; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string; message?: string };
    const out = { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    if (typeof err.code === 'number') return { ...out, rc: err.code, timedOut: false, spawnError: null };
    if (err.killed || err.signal) return { ...out, rc: null, timedOut: true, spawnError: null };
    return { ...out, rc: null, timedOut: false, spawnError: String(err.code ?? err.message ?? 'spawn_failed') };
  }
}

/** Absolute path of the first executable file named `binary` on PATH, or null. */
export async function findOnPath(binary: string): Promise<string | null> {
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, binary);
    try {
      if ((await fs.promises.stat(candidate)).isFile()) {
        await fs.promises.access(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      /* not here; keep looking */
    }
  }
  return null;
}

const DEFAULT_DEPS: SkillRuntimeDeps = {
  skillsDir: resolveSkillsDir,
  listSkillDirs: async (dir) =>
    (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
      .map((d) => d.name),
  readPrereqs: async (dir, skill) => {
    try {
      return await fs.promises.readFile(path.join(dir, skill, 'PREREQS.json'), 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
  },
  findOnPath,
  runProcess,
};

/** The cached, time-bounded read used by the readiness surfaces. */
export const getSkillRuntimeReadiness = createBoundedCache(() => computeSkillRuntime(), {
  ttlMs: CACHE_TTL_MS,
  budgetMs: PAGE_BUDGET_MS,
  onTimeout: () => [summarizeSkill('all', [{
    kind: 'skills_dir',
    target: 'skills',
    outcome: 'unknown',
    detail: `skill checks did not finish within ${PAGE_BUDGET_MS} ms`,
  }], 'Installed skills')],
});
