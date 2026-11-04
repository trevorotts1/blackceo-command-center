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
 *     file-existence guess), with the ">=X.Y[.Z]" floor enforced. Counted
 *     whatever the entry's severity — a skill that imports it dies without it.
 *   - `binary` entries with severity "required": a lookup on PATH and then the
 *     standard program folders (a service started by launchd or Docker often
 *     has a shorter PATH than a person's terminal), and, when the entry names a
 *     `minVersion`, a `--version` read against it.
 * Entries tied to an optional feature (`when`), credentials, other skills and
 * manual notes are out of scope here.
 *
 * SAME PYTHON AS THE SKILLS. python3 is the operator's pin (`CC_PYTHON`, the
 * name scripts/atomic-deploy.sh uses) or the first python3 found. The import is
 * tried with the box's private package folders on sys.path, because that is
 * where the updater puts what a skill needs: `$OC_PYDEPS_DIR/py<X.Y>`, then
 * `<OpenClaw root>/pydeps/py<X.Y>`, then `~/.claude/pydeps/py<X.Y>`.
 *
 * READ-ONLY. This module never installs anything. The repair is the box
 * updater's job; the row only says whether the repair is still owed.
 *
 * BOUNDED, NOT INSTANT. Child processes are bounded by a timeout, identical
 * checks run once, results are cached for a minute, and on a cold cache the
 * getter waits at most PAGE_BUDGET_MS and then hands back an UNKNOWN row while
 * the probe finishes in the background and fills the cache.
 *
 * UNKNOWN IS NOT READY. A check that could not run or whose answer cannot be
 * trusted (no interpreter, timeout, unreadable file, a crashed or stub
 * interpreter, a version that cannot be read) is UNKNOWN and never rolls up to
 * READY. Only an answer the check itself printed counts as "missing".
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveOpenClawRuntimeRoot } from '@/lib/openclaw/runtime-root';

import type { ReadinessState } from './types';

const execFileAsync = promisify(execFile);

const CHILD_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 60_000;
export const PAGE_BUDGET_MS = 2_000;
const MAX_PREREQS_BYTES = 262_144;

// Exit codes of the import check below. 3 is a proven fault (too old). 1 is a
// proven fault ONLY when stdout carries the script's own "Name: message" line:
// an interpreter that crashed, or a stub that is not Python at all, also exits 1
// with nothing on stdout, and that is "could not tell". 4 means the module
// imports but its version could not be read.
const RC_OK = 0;
const RC_IMPORT_FAILED = 1;
const RC_TOO_OLD = 3;
const SCRIPT_FAULT_LINE = /^[A-Za-z_][A-Za-z0-9_.]*:/;

/**
 * Fixed script, passed with `-c`; the only variable parts arrive as argv, so no
 * value is ever interpolated into code or a shell. `import_module` really
 * imports (find_spec would pass a package whose own dependency is missing).
 * SystemExit is not an Exception, so the sys.exit calls pass through the except.
 *
 * The first block puts the box's private package folders on sys.path before the
 * import, using THIS interpreter's own version for the folder name. The order
 * and names are the fleet contract: OC_PYDEPS_DIR (a full pydeps root), else
 * OPENCLAW_ROOT, else /data/.openclaw when that folder exists, else
 * ~/.openclaw; plus ~/.claude/pydeps. Anything before the try block that goes
 * wrong is a crash (exit 1, nothing on stdout), which reads as "could not tell".
 */
const PY_IMPORT_CHECK = String.raw`import importlib, os, re, sys
tag = "py%d.%d" % sys.version_info[:2]
home = os.path.expanduser("~")
root = os.environ.get("OPENCLAW_ROOT") or ("/data/.openclaw" if os.path.isdir("/data/.openclaw") else os.path.join(home, ".openclaw"))
cands = ([os.path.join(os.environ["OC_PYDEPS_DIR"], tag)] if os.environ.get("OC_PYDEPS_DIR") else []) + [os.path.join(root, "pydeps", tag), os.path.join(home, ".claude", "pydeps", tag)]
for p in reversed(cands):
    if os.path.isdir(p) and p not in sys.path:
        sys.path.insert(0, p)
mod, dist, floor = sys.argv[1], sys.argv[2], sys.argv[3]
want = tuple(int(x) for x in floor.split(".")) if floor else None
try:
    importlib.import_module(mod)
    if want:
        try:
            from importlib.metadata import version
            got = tuple(int(x) for x in re.match(r"\d+(?:\.\d+)*", version(dist)).group(0).split("."))
        except Exception as e:
            print("version unreadable: %s: %s" % (type(e).__name__, e))
            sys.exit(4)
        n = max(len(got), len(want))
        if got + (0,) * (n - len(got)) < want + (0,) * (n - len(want)):
            print("installed %s is older than the required %s" % (".".join(map(str, got)), floor))
            sys.exit(3)
except Exception as e:
    print("%s: %s" % (type(e).__name__, e))
    sys.exit(1)`;

const MODULE_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const BINARY_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const DIST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*/;
// Up to four dotted parts ("4.0.1" keeps its patch number), each bounded.
const VERSION = String.raw`\d{1,9}(?:\.\d{1,9}){0,3}`;
const FLOOR_RE = new RegExp(String.raw`>=\s*(${VERSION})`);
const VERSION_ONLY_RE = new RegExp(`^${VERSION}$`);
const VERSION_IN_TEXT_RE = new RegExp(VERSION);

/** Programs found here count even when the service's own PATH is short. */
const standardBinDirs = (home: string): string[] => [
  '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), '/usr/bin', '/bin',
];

// ── types ───────────────────────────────────────────────────────────────────

export interface PythonModuleNeed {
  kind: 'python_module';
  module: string;
  /** Package name used for the version lookup (the name in `requirement`). */
  dist: string;
  /** The requirement text as the skill wrote it, e.g. "jsonschema>=4.0". */
  requirement: string;
  /** Dotted floor from a ">=" requirement, patch number kept ("4.0.1" -> [4, 0, 1]), or null for "any version". */
  floor: number[] | null;
}

export interface BinaryNeed {
  kind: 'binary';
  binary: string;
  /**
   * Floor from `check.minVersion`. undefined: the skill asked for none.
   * null: it asked for one this module cannot read, so the check says UNKNOWN
   * rather than pass the program on presence alone.
   */
  minVersion?: number[] | null;
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
  /** Absolute path of the first match on PATH or in the standard program folders, or null. */
  findOnPath(binary: string): Promise<string | null>;
  runProcess(file: string, args: string[]): Promise<ProcessResult>;
}

// ── pure parsing and mapping ────────────────────────────────────────────────

/** "4.0.1" -> [4, 0, 1]; "6" -> [6, 0] (a floor always names at least major.minor). */
function dotted(text: string): number[] {
  const parts = text.split('.').map(Number);
  return parts.length < 2 ? [...parts, 0] : parts;
}

/** True when `got` is at least `floor`, comparing part by part with missing parts as 0. */
export function versionAtLeast(got: number[], floor: number[]): boolean {
  for (let i = 0; i < Math.max(got.length, floor.length); i += 1) {
    const g = got[i] ?? 0;
    const f = floor[i] ?? 0;
    if (g !== f) return g > f;
  }
  return true;
}

/** "jsonschema>=4.0.1" -> { dist: 'jsonschema', floor: [4, 0, 1] }. Only ">=" is a floor. */
export function parseRequirement(requirement: string, fallbackDist: string): {
  dist: string;
  floor: number[] | null;
} {
  const dist = DIST_RE.exec(requirement.trim())?.[0] ?? fallbackDist;
  const m = FLOOR_RE.exec(requirement);
  return { dist, floor: m ? dotted(m[1]) : null };
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
      // A module tied to an optional feature is out of scope, like a binary is.
      if (p.when !== undefined || !MODULE_RE.test(p.pythonModule)) continue;
      const requirement = typeof p.requirement === 'string' ? p.requirement : p.pythonModule;
      const { dist, floor } = parseRequirement(requirement, p.pythonModule);
      needs.push({ kind: 'python_module', module: p.pythonModule, dist, requirement, floor });
      continue;
    }
    const check = p.check as { binary?: unknown; minVersion?: unknown } | null | undefined;
    if (
      p.type === 'binary' &&
      p.severity === 'required' &&
      p.when === undefined &&
      typeof check?.binary === 'string' &&
      BINARY_RE.test(check.binary)
    ) {
      const asked = check.minVersion;
      needs.push(asked === undefined
        ? { kind: 'binary', binary: check.binary }
        : {
          kind: 'binary',
          binary: check.binary,
          minVersion: typeof asked === 'string' && VERSION_ONLY_RE.test(asked.trim()) ? dotted(asked.trim()) : null,
        });
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

/**
 * The client-facing line for each state. No module, interpreter or exit-code
 * words. It promises nothing the box cannot back: nothing here raises an alert,
 * and only some missing things are installed by the updater, so the line asks
 * the person to tell their support team instead of claiming a repair or a notice.
 */
export function skillMessage(state: ReadinessState, name: string): string {
  if (state === 'READY') return 'Ready';
  if (state === 'BLOCKED') {
    return `Needs a quick fix: ${name} is missing something it needs. Please let your support team know.`;
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

/** The last non-empty line: the check prints its own answer last, after anything a module printed on import. */
function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? '').slice(0, 200);
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 200);
}

/**
 * Where a program lives. python3 is the operator's pin (`CC_PYTHON`) when one
 * is set, and a pin is never swapped for another interpreter: if the pin does
 * not point at a runnable program the answer is "pinned, not found".
 */
async function locate(
  deps: SkillRuntimeDeps,
  binary: string,
): Promise<{ found: string | null; pinned: string | null }> {
  const pinned = binary === 'python3' ? process.env.CC_PYTHON?.trim() || null : null;
  return { found: await deps.findOnPath(pinned ?? binary), pinned };
}

async function checkBinary(deps: SkillRuntimeDeps, need: BinaryNeed): Promise<SkillCheckDetail> {
  const base = { kind: 'binary' as const, target: need.binary };
  const { found, pinned } = await locate(deps, need.binary);
  if (!found) {
    return pinned
      ? { ...base, outcome: 'unknown', detail: `CC_PYTHON is set to ${pinned}, which is not a runnable program; no other python3 was tried` }
      : { ...base, outcome: 'missing', detail: 'not found on PATH or in the standard program folders' };
  }
  const where = { ...base, resolvedPath: found };
  if (need.minVersion === undefined) {
    return { ...where, outcome: 'ok', detail: pinned ? 'found (CC_PYTHON)' : 'found' };
  }
  const floor = need.minVersion;
  if (floor === null) {
    return { ...where, outcome: 'unknown', detail: 'the skill asks for a minimum version this check cannot read' };
  }
  const res = await deps.runProcess(found, ['--version']);
  const said = firstLine(res.stdout) || firstLine(res.stderr);
  const got = VERSION_IN_TEXT_RE.exec(said)?.[0];
  const common = { ...where, requirement: `>=${floor.join('.')}`, rc: res.rc };
  if (res.timedOut) return { ...common, outcome: 'unknown', detail: '--version timed out' };
  if (res.spawnError) return { ...common, outcome: 'unknown', detail: `could not start it: ${res.spawnError}` };
  if (res.rc !== 0 || !got) {
    return { ...common, outcome: 'unknown', detail: `version could not be read: ${said || `--version exited ${res.rc}`}` };
  }
  return versionAtLeast(dotted(got), floor)
    ? { ...common, outcome: 'ok', detail: `version ${got}` }
    : { ...common, outcome: 'missing', detail: `version ${got} is older than the required ${floor.join('.')}` };
}

async function checkPythonModule(
  deps: SkillRuntimeDeps,
  need: PythonModuleNeed,
): Promise<SkillCheckDetail> {
  const base = { kind: 'python_module' as const, target: need.module, requirement: need.requirement };
  // Same interpreter the skills run under: the operator's pin, else python3.
  const { found: python, pinned } = await locate(deps, 'python3');
  if (!python) {
    return {
      ...base,
      outcome: 'unknown',
      detail: pinned
        ? `CC_PYTHON is set to ${pinned}, which is not a runnable program, so the import could not be tried`
        : 'python3 not found, so the import could not be tried',
    };
  }
  const res = await deps.runProcess(python, [
    '-c', PY_IMPORT_CHECK, need.module, need.dist, need.floor ? need.floor.join('.') : '',
  ]);
  const common = { ...base, resolvedPath: python, rc: res.rc };
  if (res.timedOut) return { ...common, outcome: 'unknown', detail: 'import check timed out' };
  if (res.spawnError) return { ...common, outcome: 'unknown', detail: `could not start python3: ${res.spawnError}` };
  const said = lastLine(res.stdout) || lastLine(res.stderr);
  if (res.rc === RC_OK) return { ...common, outcome: 'ok', detail: 'imported' };
  if (res.rc === RC_TOO_OLD) return { ...common, outcome: 'missing', detail: said || 'installed version is too old' };
  if (res.rc === RC_IMPORT_FAILED && SCRIPT_FAULT_LINE.test(lastLine(res.stdout))) {
    return { ...common, outcome: 'missing', detail: said };
  }
  if (res.rc === RC_IMPORT_FAILED) {
    return { ...common, outcome: 'unknown', detail: `the import check did not answer (crashed, or not a working python3): ${said || 'no output'}` };
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
        ? once(`bin:${need.binary}:${JSON.stringify(need.minVersion)}`, () => checkBinary(deps, need))
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
      // The whole environment travels: OC_PYDEPS_DIR, OPENCLAW_ROOT and HOME are
      // how the import script finds the box's private package folders.
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

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await fs.promises.stat(file)).isFile()) return false;
    await fs.promises.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of the first executable file named `binary`, or null. Looks on
 * PATH first, then the standard program folders (Homebrew, /usr/local, the
 * user's ~/.local/bin, /usr/bin, /bin): a service started by launchd or Docker
 * often has a shorter PATH than a terminal, and a program that is there is not
 * missing. A name with a folder in it (an operator's CC_PYTHON pin) is checked
 * directly and never searched for.
 */
export async function findOnPath(binary: string): Promise<string | null> {
  if (path.basename(binary) !== binary) return (await isExecutableFile(binary)) ? binary : null;
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    ...standardBinDirs(process.env.HOME || os.homedir()),
  ];
  for (const dir of new Set(dirs)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (await isExecutableFile(candidate)) return candidate;
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
