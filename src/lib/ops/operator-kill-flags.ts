/**
 * F6 — DURABLE OPERATOR KILL-FLAGS.
 *
 * THE INCIDENT THIS EXISTS FOR
 * ----------------------------
 * A client box's escalation channel was flooded by the stale-task sweep
 * (thousands of duplicate open tasks x a ten-minute cron => hundreds of
 * escalations per hour). The operator stopped the flood by hand, by writing
 * `DISABLE_STALE_TASK_SWEEP=1` into the checkout's `.env.production.local`.
 *
 * That emergency stop is FRAGILE, and the fragility is silent:
 *
 *   1. `.env.production.local` is gitignored (.gitignore:27 `.env*.local`), so
 *      it exists ONLY as an untracked file inside the app checkout. A fresh
 *      clone (re-install / disaster recovery / container re-create / a box
 *      rebuilt from scripts/install/*-bootstrap.sh) and any `git clean -fdx`
 *      produce a checkout with NO flag — the sweep comes back ON.
 *   2. The app's env file is (re)written wholesale by the ONBOARDING-side half
 *      of the weekly update chain — see DEPLOYMENT.md "What runs, in order",
 *      step 3: Phase 6 "writes `.env.local` (gateway token / sovereign model /
 *      API-auth posture)" — code that lives OUTSIDE this repo and that this
 *      repo cannot audit or constrain. Any env file the deploy owns is a place
 *      an operator override can be dropped on the floor.
 *   3. Nothing ever announced the flag's state. The only signal was a log line
 *      emitted once per tick WHILE the sweep was disabled; a silently
 *      RE-ENABLED sweep produced no signal at all.
 *
 * THE FIX
 * -------
 * Resolve the kill-flag from TWO sources, and honour EITHER:
 *
 *   - `process.env` (unchanged — the existing emergency path keeps working), and
 *   - a DURABLE operator-overrides file that lives OUTSIDE the app checkout, so
 *     no deploy, no `git reset --hard`, no `git clean -fdx`, no re-clone, and no
 *     env-file regeneration can reach it.
 *
 * `disabled = truthy(env) OR truthy(durable file)`. Deliberately OR, not a
 * precedence chain: a regenerated env file can never UNDO a durable stop, and a
 * durable file can never BLOCK an env-var emergency stop. Turning the sweep
 * back on requires clearing it wherever it is set — and the banner below names
 * exactly which source is holding it down.
 *
 * FAIL-OPEN — NON-NEGOTIABLE
 * --------------------------
 * This module can only ever DISABLE the sweep on an EXPLICIT, successfully-read
 * truthy value. A missing file, an unreadable file, a malformed file, or any
 * thrown error resolves to NOT DISABLED — the sweep runs and stuck tasks still
 * reach a human. Silencing escalation by accident is the one outcome that is
 * never acceptable. Read failures are logged LOUDLY rather than swallowed.
 *
 * SECURITY: this file is an operator-override store for BOOLEAN kill-flags only.
 * Only keys in HONORED_FLAGS are ever read out of it, and no value from it is
 * ever injected into `process.env`. It is not a secret store and no value read
 * here is ever logged (the honored flags are booleans; unknown keys are named,
 * never valued).
 */

// Bare builtin specifiers (not `node:` URIs) — the Next/webpack config used by
// this app does not handle `node:` URIs in a module reachable from the server
// bundle, and every other src/lib module that touches the filesystem
// (notify.ts, env-auditor.ts, company-config.ts, ...) imports them this way.
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The ONLY keys this module honours out of the durable overrides file.
 * Deliberately an allowlist: the file must never be able to inject arbitrary
 * environment into the app.
 */
export const HONORED_FLAGS = ['DISABLE_STALE_TASK_SWEEP'] as const;
export type HonoredFlag = (typeof HONORED_FLAGS)[number];

export const STALE_TASK_SWEEP_KILL_FLAG: HonoredFlag = 'DISABLE_STALE_TASK_SWEEP';

/** Canonical filename, used by scripts/operator-flag.sh. Keep the two in sync. */
export const OVERRIDES_FILENAME = 'operator-overrides.env';

export interface KillFlagResolution {
  /** Flag name, e.g. DISABLE_STALE_TASK_SWEEP. */
  name: string;
  /** True only when an explicit truthy value was read from a source. */
  disabled: boolean;
  /** Human-readable source labels that set it truthy (may be >1). */
  sources: string[];
  /** The durable overrides file that was consulted, if one exists. */
  overrideFile: string | null;
  /** Non-null when the durable file existed but could not be read/parsed. */
  fileError: string | null;
}

/**
 * Candidate locations for the durable overrides file, in order. The first one
 * that EXISTS is used.
 *
 * All of them are OUTSIDE the app checkout — that is the entire point. A path
 * inside the checkout (like `.env.production.local`) is reachable by
 * `git clean -fdx`, by a re-clone, and by whatever the deploy chain decides to
 * regenerate; a path outside it is not.
 *
 *   - `CC_OPERATOR_OVERRIDES_FILE` — explicit pin. Set to an empty string to
 *     disable durable-file lookup entirely (used by tests for isolation).
 *   - `$HOME/.blackceo/command-center/operator-overrides.env` — Mac boxes.
 *   - `/data/.blackceo/command-center/operator-overrides.env` — VPS/Docker
 *     boxes, where `/data` is the only persistent volume (PRODUCTION_SETUP.md).
 */
export function overridesFileCandidates(): string[] {
  const pinned = process.env.CC_OPERATOR_OVERRIDES_FILE;
  if (pinned !== undefined) {
    return pinned.trim() === '' ? [] : [pinned];
  }
  const home = process.env.HOME || os.homedir() || '';
  const candidates: string[] = [];
  if (home) candidates.push(path.join(home, '.blackceo', 'command-center', OVERRIDES_FILENAME));
  candidates.push(path.join('/data', '.blackceo', 'command-center', OVERRIDES_FILENAME));
  return candidates;
}

/** '1' | 'true' | 'yes' | 'on' (case-insensitive) => true. Everything else false. */
export function isTruthyFlagValue(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export interface OverridesFileRead {
  path: string | null;
  values: Record<string, string>;
  /** Keys present in the file that this module does NOT honour. */
  ignoredKeys: string[];
  error: string | null;
}

/**
 * Read the durable overrides file. NEVER throws — every failure path returns an
 * empty value map plus an `error` string, which resolves the flag to NOT
 * DISABLED (fail-open: escalation keeps happening).
 *
 * Format: dotenv-ish `KEY=VALUE`, one per line. `#` comments and blank lines
 * are ignored. Surrounding single/double quotes on the value are stripped. No
 * dependency, no `export ` prefix magic beyond a leading `export ` being
 * tolerated.
 *
 * Read on EVERY resolution rather than cached at boot — deliberate. It means an
 * operator's emergency stop takes effect on the next sweep tick with no rebuild,
 * no pm2 restart, and no deploy. That is a strictly better kill switch than an
 * env file, which only takes effect on process start.
 */
export function readOperatorOverrides(): OverridesFileRead {
  const empty: OverridesFileRead = { path: null, values: {}, ignoredKeys: [], error: null };
  let candidates: string[];
  try {
    candidates = overridesFileCandidates();
  } catch (err) {
    return { ...empty, error: `cannot resolve overrides path: ${(err as Error).message}` };
  }

  for (const candidate of candidates) {
    let raw: string;
    try {
      if (!fs.existsSync(candidate)) continue;
      raw = fs.readFileSync(candidate, 'utf-8');
    } catch (err) {
      // The file EXISTS but we cannot read it (permissions, race, I/O). Do not
      // pretend it said anything — fail open and surface it LOUDLY.
      return { path: candidate, values: {}, ignoredKeys: [], error: (err as Error).message };
    }

    const values: Record<string, string> = {};
    const ignoredKeys: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
      const eq = withoutExport.indexOf('=');
      if (eq <= 0) continue; // not a KEY=VALUE line — skip, never throw
      const key = withoutExport.slice(0, eq).trim();
      let value = withoutExport.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if ((HONORED_FLAGS as readonly string[]).includes(key)) {
        values[key] = value;
      } else {
        ignoredKeys.push(key);
      }
    }
    return { path: candidate, values, ignoredKeys, error: null };
  }

  return empty;
}

/**
 * Resolve one kill-flag across BOTH sources. Never throws.
 */
export function resolveKillFlag(name: HonoredFlag): KillFlagResolution {
  const sources: string[] = [];
  let overrideFile: string | null = null;
  let fileError: string | null = null;

  if (isTruthyFlagValue(process.env[name])) {
    sources.push('env');
  }

  try {
    const file = readOperatorOverrides();
    overrideFile = file.path;
    fileError = file.error;
    if (file.error && file.path) {
      console.warn(
        `[kill-flags] LOUD WARNING: durable operator-overrides file ${file.path} exists but could NOT be read ` +
          `(${file.error}). FAILING OPEN — ${name} is treated as NOT set, so the sweep RUNS and escalation still ` +
          `happens. Fix the file's permissions/contents.`,
      );
    } else if (isTruthyFlagValue(file.values[name])) {
      sources.push(`operator-overrides file (${file.path})`);
    }
  } catch (err) {
    // Belt and braces: readOperatorOverrides() is already total, but a kill-flag
    // resolver must NEVER be able to throw into a cron tick.
    fileError = (err as Error).message;
    console.warn(
      `[kill-flags] LOUD WARNING: durable operator-overrides lookup threw (${fileError}). ` +
        `FAILING OPEN — ${name} treated as NOT set.`,
    );
  }

  return { name, disabled: sources.length > 0, sources, overrideFile, fileError };
}

/** The stale-task-sweep kill-flag specifically (the one this fix hardens). */
export function resolveStaleTaskSweepKillFlag(): KillFlagResolution {
  return resolveKillFlag(STALE_TASK_SWEEP_KILL_FLAG);
}

/**
 * The `skippedReason` string the sweep reports when the kill-flag is set. Keeps
 * the historical `DISABLE_STALE_TASK_SWEEP set` prefix (nothing should have to
 * re-learn it) and appends the WINNING SOURCE so a disabled sweep can never be
 * a mystery.
 */
export function killFlagSkipReason(res: KillFlagResolution): string {
  return `${res.name} set (source: ${res.sources.join(' + ')})`;
}

/**
 * Startup observability. Called once from registerCronJobs().
 *
 * Prints the sweep's kill-flag state on EVERY boot — ENABLED or DISABLED —
 * so neither a silently re-enabled sweep (deploy dropped the operator's stop:
 * the flood comes back) nor a silently disabled one (nobody remembers turning
 * it off: stuck tasks rot un-escalated) can hide in the logs.
 */
export function logKillFlagBanner(): void {
  let res: KillFlagResolution;
  try {
    res = resolveStaleTaskSweepKillFlag();
  } catch {
    return; // observability must never break boot
  }

  if (res.disabled) {
    console.warn('[kill-flags] ==================================================================');
    console.warn(`[kill-flags] stale-task-sweep is DISABLED by an operator kill-flag.`);
    console.warn(`[kill-flags]   flag:   ${res.name}`);
    console.warn(`[kill-flags]   set by: ${res.sources.join(' + ')}`);
    console.warn('[kill-flags] While this is set, STALE AND BLOCKED TASKS ARE NOT ESCALATED to a human.');
    console.warn('[kill-flags] This is an emergency stop, not a resting state. Clear it with:');
    console.warn(`[kill-flags]   bash scripts/operator-flag.sh unset ${res.name}`);
    console.warn('[kill-flags] ==================================================================');
    return;
  }

  const where = res.overrideFile ? res.overrideFile : '(no durable overrides file on this box)';
  console.log(
    `[kill-flags] stale-task-sweep is ENABLED (no operator kill-flag set). ` +
      `env ${res.name}=unset/false; durable overrides: ${where}`,
  );

  try {
    const file = readOperatorOverrides();
    if (file.path && file.ignoredKeys.length > 0) {
      console.warn(
        `[kill-flags] NOTE: ${file.path} contains key(s) this app does not honour and will IGNORE: ` +
          `${file.ignoredKeys.join(', ')}. Only ${HONORED_FLAGS.join(', ')} are read from that file.`,
      );
    }
  } catch {
    /* observability only */
  }
}
