/**
 * launch-runs.ts — launch automation runs for the Command Center.
 *
 * Reads the SAME launch plan contract the skills emit
 * (onboarding `shared-utils/signature_launch_contract/launch-plan.schema.json`)
 * plus the run's progress file, and derives the launch percentage.
 *
 * Read-only: this module never writes, never sends, never touches an account.
 * Server-only (imports fs/path) — imported by server components and the read
 * API only.
 *
 * Storage: one directory, one plan per file (`<name>.json`), optional sibling
 * progress file (`<name>.progress.json`). Directory comes from
 * `LAUNCH_PLANS_DIR`, default `<cwd>/data/launch-plans`. An absent or empty
 * directory is an honest empty state, not an error.
 *
 * ponytail: files on disk are the whole store (the skills already write one
 * progress file per run — the spec's §4.4). Swap the two `readFileSync` calls
 * for DB reads if launches ever need per-user access rules.
 */

import fs from 'fs';
import path from 'path';

export type LaunchUnitKind = 'page' | 'email' | 'text' | 'automation' | 'conversation_ai';

export type LaunchUnitState =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'blocked'
  | 'dropped';

export interface LaunchUnit {
  id: string;
  kind: LaunchUnitKind;
  /** Human label, e.g. "pre launch" for kind `pre_launch`. */
  label: string;
  /** Short detail: "4 emails", "template x", "trigger: purchase". */
  detail: string;
  state: LaunchUnitState;
  waits_for: string[];
}

export interface LaunchCounts {
  total: number;
  done: number;
}

export interface LaunchRun {
  launchId: string;
  sourceFile: string;
  offerName: string;
  a2pReady: boolean;
  calendar: {
    launchAt?: string;
    doorsOpenAt?: string;
    doorsCloseAt?: string;
    timezone?: string;
  };
  conversationAi: {
    requested: boolean;
    mode: string;
    channels: string[];
    /** State of the single conversation_ai unit (requested runs only). */
    state: LaunchUnitState;
  };
  units: LaunchUnit[];
  counts: Record<LaunchUnitKind, LaunchCounts>;
  totalUnits: number;
  doneUnits: number;
  /** doneUnits / totalUnits, rounded. 0 when the plan has no units. */
  percentage: number;
  /** Non-fatal problems (bad progress file, launch_id mismatch). */
  warnings: string[];
}

export interface LaunchRunsResult {
  dir: string;
  runs: LaunchRun[];
  /** Files that could not be read or parsed. */
  errors: string[];
}

/** States that count toward the launch percentage. Dropped is NOT done: the
 *  run is not complete until a unit is fixed or the client drops it (§4.5). */
export const DONE_STATES: ReadonlySet<LaunchUnitState> = new Set<LaunchUnitState>([
  'complete',
]);

const STATE_ALIASES: Record<string, LaunchUnitState> = {
  complete: 'complete',
  completed: 'complete',
  done: 'complete',
  passed: 'complete',
  built: 'complete',
  running: 'running',
  in_progress: 'running',
  inprogress: 'running',
  failed: 'failed',
  error: 'failed',
  blocked: 'blocked',
  dropped: 'dropped',
  skipped: 'dropped',
  cancelled: 'dropped',
  canceled: 'dropped',
  pending: 'pending',
  queued: 'pending',
  waiting: 'pending',
};

export function normalizeState(value: unknown): LaunchUnitState {
  if (typeof value !== 'string') return 'pending';
  return STATE_ALIASES[value.trim().toLowerCase()] ?? 'pending';
}

/** Accepts the progress shapes the swarm may emit: an array of
 *  `{id,state}`, a map `id -> state | {state}`, or top-level `states`. */
export function parseProgressStates(raw: unknown): Map<string, LaunchUnitState> {
  const states = new Map<string, LaunchUnitState>();
  const absorb = (source: unknown) => {
    if (!source) return;
    if (Array.isArray(source)) {
      for (const entry of source) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        if (typeof rec.id !== 'string') continue;
        states.set(rec.id, normalizeState(rec.state));
      }
      return;
    }
    if (typeof source !== 'object') return;
    for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        const rec = value as Record<string, unknown>;
        states.set(id, normalizeState(rec.state));
      } else {
        states.set(id, normalizeState(value));
      }
    }
  };
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    absorb(rec.units);
    absorb(rec.progress);
    absorb(rec.states);
  }
  return states;
}

function pretty(text: string): string {
  return text.replace(/_/g, ' ');
}

function planUnits(plan: Record<string, unknown>, states: Map<string, LaunchUnitState>): LaunchUnit[] {
  const units: LaunchUnit[] = [];
  const push = (
    raw: unknown,
    kind: LaunchUnitKind,
    labelOf: (rec: Record<string, unknown>) => string,
    detailOf: (rec: Record<string, unknown>) => string,
  ) => {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.id !== 'string') continue;
      units.push({
        id: rec.id,
        kind,
        label: labelOf(rec),
        detail: detailOf(rec),
        state: states.get(rec.id) ?? 'pending',
        waits_for: Array.isArray(rec.waits_for)
          ? rec.waits_for.filter((x): x is string => typeof x === 'string')
          : [],
      });
    }
  };

  push(
    plan.pages,
    'page',
    (r) => `${pretty(String(r.kind ?? 'page'))} page`,
    (r) => (typeof r.url === 'string' && r.url ? r.url : 'planned, no URL yet'),
  );
  push(
    plan.email_sequences,
    'email',
    (r) => pretty(String(r.kind ?? 'email')),
    (r) => `${Number(r.email_count ?? 0)} emails · drafts only`,
  );
  push(
    plan.text_sets,
    'text',
    (r) => pretty(String(r.kind ?? 'text')),
    (r) => {
      const window = r.send_window as Record<string, unknown> | undefined;
      const hours = window && typeof window.start === 'string' && typeof window.end === 'string'
        ? ` · ${window.start}–${window.end}`
        : '';
      return `${Number(r.messages ?? 0)} messages · ${r.promotional === true ? 'promotional' : 'non-promotional'}${hours}`;
    },
  );
  push(
    plan.automations,
    'automation',
    (r) => pretty(String(r.family ?? 'automation')),
    (r) => {
      const trigger = r.trigger as Record<string, unknown> | undefined;
      const triggerText = trigger && typeof trigger.type === 'string' ? trigger.type : 'no trigger';
      return `template: ${String(r.template ?? 'new')} · trigger: ${triggerText} · ${String(r.build_rail ?? 'unknown')}`;
    },
  );

  const ai = (plan.conversation_ai ?? {}) as Record<string, unknown>;
  if (ai.requested === true) {
    const channels = Array.isArray(ai.channels)
      ? ai.channels.filter((x): x is string => typeof x === 'string')
      : [];
    units.push({
      id: 'conversation_ai',
      kind: 'conversation_ai',
      label: 'Conversation AI',
      detail: `mode: ${String(ai.mode ?? 'unknown')}${channels.length ? ` · ${channels.join(', ')}` : ''}`,
      state: states.get('conversation_ai') ?? 'pending',
      waits_for: [],
    });
  }
  return units;
}

export function buildLaunchRun(
  plan: Record<string, unknown>,
  states: Map<string, LaunchUnitState>,
  sourceFile = '',
): LaunchRun {
  const units = planUnits(plan, states);
  const counts: Record<LaunchUnitKind, LaunchCounts> = {
    page: { total: 0, done: 0 },
    email: { total: 0, done: 0 },
    text: { total: 0, done: 0 },
    automation: { total: 0, done: 0 },
    conversation_ai: { total: 0, done: 0 },
  };
  for (const unit of units) {
    counts[unit.kind].total += 1;
    if (DONE_STATES.has(unit.state)) counts[unit.kind].done += 1;
  }
  const totalUnits = units.length;
  const doneUnits = units.filter((u) => DONE_STATES.has(u.state)).length;

  const offer = (plan.offer ?? {}) as Record<string, unknown>;
  const calendar = (plan.launch_calendar ?? {}) as Record<string, unknown>;
  const ai = (plan.conversation_ai ?? {}) as Record<string, unknown>;
  const aiUnit = units.find((u) => u.kind === 'conversation_ai');

  return {
    launchId: typeof plan.launch_id === 'string' ? plan.launch_id : sourceFile.replace(/\.json$/, ''),
    sourceFile,
    offerName: typeof offer.name === 'string' ? offer.name : 'Unnamed offer',
    a2pReady: plan.a2p_ready === true,
    calendar: {
      launchAt: typeof calendar.launch_at === 'string' ? calendar.launch_at : undefined,
      doorsOpenAt: typeof calendar.doors_open_at === 'string' ? calendar.doors_open_at : undefined,
      doorsCloseAt: typeof calendar.doors_close_at === 'string' ? calendar.doors_close_at : undefined,
      timezone: typeof calendar.timezone === 'string' ? calendar.timezone : undefined,
    },
    conversationAi: {
      requested: ai.requested === true,
      mode: typeof ai.mode === 'string' ? ai.mode : 'none',
      channels: Array.isArray(ai.channels)
        ? ai.channels.filter((x): x is string => typeof x === 'string')
        : [],
      state: aiUnit ? aiUnit.state : ai.requested === true ? 'pending' : 'dropped',
    },
    units,
    counts,
    totalUnits,
    doneUnits,
    percentage: totalUnits === 0 ? 0 : Math.round((doneUnits / totalUnits) * 100),
    warnings: [],
  };
}

export function launchPlansDir(): string {
  return process.env.LAUNCH_PLANS_DIR || path.join(process.cwd(), 'data', 'launch-plans');
}

/** Newest launches first by id (the contract's ids are date-stamped). */
export function listLaunchRuns(dir = launchPlansDir()): LaunchRunsResult {
  const errors: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { dir, runs: [], errors };
  }

  const runs: LaunchRun[] = [];
  for (const file of entries.filter((f) => f.endsWith('.json') && !f.endsWith('.progress.json')).sort()) {
    const full = path.join(dir, file);
    let plan: Record<string, unknown>;
    try {
      plan = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : 'unreadable'}`);
      continue;
    }

    const states = new Map<string, LaunchUnitState>();
    const progressFile = /\.plan\.json$/.test(full)
      ? full.replace(/\.plan\.json$/, '.progress.json')
      : full.replace(/\.json$/, '.progress.json');
    let progressWarning: string | null = null;
    if (fs.existsSync(progressFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(progressFile, 'utf8')) as Record<string, unknown>;
        for (const [id, state] of parseProgressStates(raw)) states.set(id, state);
        const progressId = typeof raw.launch_id === 'string' ? raw.launch_id : null;
        if (progressId && plan.launch_id && progressId !== plan.launch_id) {
          progressWarning = `progress file launch_id "${progressId}" does not match plan "${String(plan.launch_id)}"`;
        }
      } catch (error) {
        progressWarning = `progress file unreadable: ${error instanceof Error ? error.message : 'unknown'}`;
      }
    }

    const run = buildLaunchRun(plan, states, file);
    if (progressWarning) run.warnings.push(progressWarning);
    runs.push(run);
  }

  runs.sort((a, b) => b.launchId.localeCompare(a.launchId));
  return { dir, runs, errors };
}

export function getLaunchRun(launchId: string, dir = launchPlansDir()): LaunchRun | null {
  return listLaunchRuns(dir).runs.find((run) => run.launchId === launchId) ?? null;
}
