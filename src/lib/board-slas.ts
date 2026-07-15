/**
 * Per-department Service-Level (SLA) table (U101 / v1 U25; v1 ref C12.3
 * item 8).
 *
 * `config/board-slas.json` lets the operator TIGHTEN (or loosen) the
 * currently-global lane thresholds board-hygiene.ts and stale-task-sweep.ts
 * already enforce, on a PER-DEPARTMENT basis — e.g. a department that needs
 * faster blocked-escalation than the fleet default without touching the
 * global env var (which every other department would also inherit).
 *
 * PRECEDENCE (highest wins):
 *   1. The matching env var, IF EXPLICITLY SET — an operator's global
 *      emergency override always wins, for every department, no exceptions.
 *   2. This department's entry in board-slas.json, IF present and valid.
 *   3. The hardcoded fallback default (today's shipped behavior).
 *
 * FAIL-CLOSED ON MALFORMED CONFIG — the load-bearing contract of this file:
 *   - Missing file            → empty table. Behavior is BYTE-IDENTICAL to
 *     today (every department reads the global default/env value).
 *   - Unparseable JSON        → empty table (logged), never a partial/garbage
 *     parse. The whole file is discarded, not "best-effort" merged.
 *   - Top-level shape wrong (not a plain object) → empty table (logged).
 *   - A single department's entry malformed (not an object) → THAT
 *     department's entry is dropped (logged); every other department's valid
 *     entries still apply. One bad department can never take down the table.
 *   - A single field malformed (non-finite, non-positive, or wrong type) →
 *     THAT field is dropped (logged) and falls through to precedence tier 3;
 *     the rest of that department's valid fields still apply.
 * Nothing here ever throws — a malformed config degrades toward the SAFE,
 * already-shipped global-default behavior, never toward an undefined or
 * corrupted threshold (e.g. a NaN or negative hour count reaching a SQL
 * `datetime('now', ?)` window).
 */

import fs from 'fs';
import path from 'path';

/** The full set of lane thresholds this table can override, one key per
 *  board-hygiene.ts / stale-task-sweep.ts tunable. Keys mirror the env var
 *  names those two files already accept (mixed-cased here; see ENV_VAR_MAP). */
export interface BoardSlaOverrides {
  // board-hygiene.ts (rules 1–5)
  blockedOwnerRepingHours?: number;
  blockedOperatorEscalateHours?: number;
  reviewUnscoredHours?: number;
  doneArchiveDays?: number;
  staleBacklogNudgeDays?: number;
  staleBacklogArchiveAfterNudgeDays?: number;
  // stale-task-sweep.ts (per-column thresholds)
  staleInProgressHours?: number;
  staleReviewHours?: number;
  staleBacklogHours?: number;
  staleTodoHours?: number;
  staleBlockedRepingedHours?: number;
}

export const BOARD_SLA_KEYS: (keyof BoardSlaOverrides)[] = [
  'blockedOwnerRepingHours',
  'blockedOperatorEscalateHours',
  'reviewUnscoredHours',
  'doneArchiveDays',
  'staleBacklogNudgeDays',
  'staleBacklogArchiveAfterNudgeDays',
  'staleInProgressHours',
  'staleReviewHours',
  'staleBacklogHours',
  'staleTodoHours',
  'staleBlockedRepingedHours',
];

/** The matching env var name for each key (must stay in lockstep with the
 *  numEnv()/STALE_THRESHOLDS constants in board-hygiene.ts / stale-task-sweep.ts). */
export const BOARD_SLA_ENV_VAR: Record<keyof BoardSlaOverrides, string> = {
  blockedOwnerRepingHours: 'BOARD_HYGIENE_BLOCKED_OWNER_REPING_HOURS',
  blockedOperatorEscalateHours: 'BOARD_HYGIENE_BLOCKED_ESCALATE_HOURS',
  reviewUnscoredHours: 'BOARD_HYGIENE_REVIEW_UNSCORED_HOURS',
  doneArchiveDays: 'BOARD_HYGIENE_DONE_ARCHIVE_DAYS',
  staleBacklogNudgeDays: 'BOARD_HYGIENE_STALE_BACKLOG_NUDGE_DAYS',
  staleBacklogArchiveAfterNudgeDays: 'BOARD_HYGIENE_STALE_ARCHIVE_AFTER_NUDGE_DAYS',
  staleInProgressHours: 'STALE_IN_PROGRESS_HOURS',
  staleReviewHours: 'STALE_REVIEW_HOURS',
  staleBacklogHours: 'STALE_BACKLOG_HOURS',
  staleTodoHours: 'STALE_TODO_HOURS',
  staleBlockedRepingedHours: 'STALE_BLOCKED_REPINGED_HOURS',
};

/** Human label for the settings-surface table (acceptance c). */
export const BOARD_SLA_LABEL: Record<keyof BoardSlaOverrides, string> = {
  blockedOwnerRepingHours: 'Blocked → owner re-ping (hours)',
  blockedOperatorEscalateHours: 'Blocked → operator escalate (hours)',
  reviewUnscoredHours: 'Review unscored → force QC (hours)',
  doneArchiveDays: 'Done → auto-archive (days)',
  staleBacklogNudgeDays: 'Stale backlog/inbox → nudge (days)',
  staleBacklogArchiveAfterNudgeDays: 'Nudge → auto-archive (days)',
  staleInProgressHours: 'Stale sweep: in_progress (hours)',
  staleReviewHours: 'Stale sweep: review (hours)',
  staleBacklogHours: 'Stale sweep: backlog (hours)',
  staleTodoHours: 'Stale sweep: to-do (hours)',
  staleBlockedRepingedHours: 'Stale sweep: blocked re-ping+return (hours)',
};

export type BoardSlaConfig = Record<string, BoardSlaOverrides>;

export interface BoardSlaLoadResult {
  config: BoardSlaConfig;
  /** Human-readable problems found while loading — never thrown, always
   *  fail-closed to a safe subset (or empty table). Empty array = clean load. */
  warnings: string[];
  /** True only when the file was present and parsed as a valid JSON object,
   *  even if individual entries/fields inside it were dropped. */
  sourcePresent: boolean;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Parse + validate a raw (untrusted) JSON value into a BoardSlaConfig,
 * dropping anything malformed at the narrowest possible scope (field, then
 * department, then — only if the top-level shape itself is wrong — the
 * whole table). Never throws.
 */
function validate(raw: unknown, warnings: string[]): BoardSlaConfig {
  const out: BoardSlaConfig = {};

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('board-slas.json top level must be a JSON object of { departmentSlug: { ...overrides } } — ignoring entire file.');
    return out;
  }

  for (const [deptSlug, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`board-slas.json: department "${deptSlug}" entry is not an object — dropping this department's overrides.`);
      continue;
    }

    const overrides: BoardSlaOverrides = {};
    let anyValid = false;
    for (const [field, value] of Object.entries(entry as Record<string, unknown>)) {
      if (!(BOARD_SLA_KEYS as string[]).includes(field)) {
        warnings.push(`board-slas.json: department "${deptSlug}" has unknown field "${field}" — dropping this field.`);
        continue;
      }
      if (!isFiniteNumber(value)) {
        warnings.push(
          `board-slas.json: department "${deptSlug}".${field} = ${JSON.stringify(value)} is not a positive finite number — dropping this field (falls through to the global default/env).`,
        );
        continue;
      }
      (overrides as Record<string, number>)[field] = value;
      anyValid = true;
    }

    if (anyValid) out[deptSlug] = overrides;
  }

  return out;
}

let cached: BoardSlaLoadResult | null = null;

function configPath(): string {
  return process.env.BOARD_SLAS_CONFIG_PATH
    ? path.resolve(process.env.BOARD_SLAS_CONFIG_PATH)
    : path.join(process.cwd(), 'config', 'board-slas.json');
}

/** Load + cache the SLA table. Fail-closed per the module-header contract —
 *  this function is guaranteed to never throw. */
export function loadBoardSlaConfig(): BoardSlaLoadResult {
  if (cached) return cached;

  const warnings: string[] = [];
  const p = configPath();

  if (!fs.existsSync(p)) {
    cached = { config: {}, warnings, sourcePresent: false };
    return cached;
  }

  let parsed: unknown;
  try {
    const content = fs.readFileSync(p, 'utf-8');
    parsed = JSON.parse(content);
  } catch (err) {
    warnings.push(`board-slas.json failed to read/parse (${(err as Error).message}) — falling back to the global default for every department.`);
    for (const w of warnings) console.warn(`[board-slas] ${w}`);
    cached = { config: {}, warnings, sourcePresent: false };
    return cached;
  }

  const config = validate(parsed, warnings);
  for (const w of warnings) console.warn(`[board-slas] ${w}`);
  cached = { config, warnings, sourcePresent: true };
  return cached;
}

/** Test-only: force a re-read on the next loadBoardSlaConfig() call. */
export function invalidateBoardSlaConfigCache(): void {
  cached = null;
}

function numEnvExplicit(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const v = parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Resolve the EFFECTIVE threshold for one lane rule + one task's department,
 * per the precedence contract in the file header: explicit env var > valid
 * per-department override > hardcoded global default.
 *
 * `department` is the task's raw `tasks.department` value — null/undefined
 * (no department stamped) always falls through to the global default, same
 * as an absent config file.
 */
export function resolveSlaThreshold(
  department: string | null | undefined,
  key: keyof BoardSlaOverrides,
  globalDefault: number,
): number {
  const envExplicit = numEnvExplicit(BOARD_SLA_ENV_VAR[key]);
  if (envExplicit !== undefined) return envExplicit;

  if (department) {
    const { config } = loadBoardSlaConfig();
    const override = config[department]?.[key];
    if (isFiniteNumber(override)) return override;
  }

  return globalDefault;
}

/**
 * The TIGHTEST (smallest) possible effective threshold for `key` across the
 * global default and every configured department override. Used by callers
 * whose candidate query has to be widened to a single SQL-time-window param
 * (e.g. board-hygiene's review-lane query) BEFORE per-row per-department
 * filtering can run in JS — querying at the tightest threshold guarantees no
 * department's candidates are ever missed, since every per-row filter below
 * only narrows further, never widens past the query's own window.
 * If an env var is explicitly set, it is the ONLY possible effective value
 * (env wins for every department), so it is returned directly.
 */
export function minPossibleSlaThreshold(key: keyof BoardSlaOverrides, globalDefault: number): number {
  const envExplicit = numEnvExplicit(BOARD_SLA_ENV_VAR[key]);
  if (envExplicit !== undefined) return envExplicit;

  const { config } = loadBoardSlaConfig();
  let min = globalDefault;
  for (const overrides of Object.values(config)) {
    const v = overrides[key];
    if (isFiniteNumber(v) && v < min) min = v;
  }
  return min;
}

/** Full effective table (global default + resolved-per-known-department) for
 *  the read-only settings surface (acceptance c). `departments` is the list
 *  of department slugs to render a row for, in addition to "(default)". */
export function buildEffectiveSlaTable(
  departments: string[],
  globalDefaults: Record<keyof BoardSlaOverrides, number>,
): { department: string; isDefault: boolean; values: Record<keyof BoardSlaOverrides, number>; overriddenKeys: (keyof BoardSlaOverrides)[] }[] {
  const { config } = loadBoardSlaConfig();
  const rows: { department: string; isDefault: boolean; values: Record<keyof BoardSlaOverrides, number>; overriddenKeys: (keyof BoardSlaOverrides)[] }[] = [];

  const defaultValues = {} as Record<keyof BoardSlaOverrides, number>;
  for (const key of BOARD_SLA_KEYS) {
    defaultValues[key] = resolveSlaThreshold(null, key, globalDefaults[key]);
  }
  rows.push({ department: '(default)', isDefault: true, values: defaultValues, overriddenKeys: [] });

  for (const dept of departments) {
    const values = {} as Record<keyof BoardSlaOverrides, number>;
    const overriddenKeys: (keyof BoardSlaOverrides)[] = [];
    for (const key of BOARD_SLA_KEYS) {
      values[key] = resolveSlaThreshold(dept, key, globalDefaults[key]);
      const raw = config[dept]?.[key];
      if (isFiniteNumber(raw) && values[key] === raw && values[key] !== defaultValues[key]) {
        overriddenKeys.push(key);
      }
    }
    rows.push({ department: dept, isDefault: false, values, overriddenKeys });
  }

  return rows;
}
