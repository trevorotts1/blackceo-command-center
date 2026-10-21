/**
 * launch-runs.ts — the DISK view of launch automation runs for the Command
 * Center.
 *
 * Two files per launch, both owned by the launch skills:
 *   plan     — `launch-plan.schema.json` v1.0.0 (approved plan)
 *   progress — `progress_file.schema.json` v1.0  (WF-SWARM resumable progress,
 *              carrying `launch_id`, `plan_hash`, `updated_at` and per-unit states)
 *
 * Storage contract: `src/lib/launch-schema.ts`; typed discovery, canonical
 * plan hashing and manifest validation: `src/lib/launch-storage.ts`.
 *
 * The database/ability view is a SEPARATE store (`launch-ability-runs.ts`) and
 * is not merged into this one — see `relateLaunchViews()` for the explicit
 * relationship. Reading a plan with no progress file is honest pending; it is
 * never reported as complete.
 *
 * Quarantine rule (fail closed): a progress file whose launch id, plan hash or
 * revision does not match its plan, whose schema is unknown, or that conflicts
 * with a duplicate, is NOT consumed. Every unit reports `unknown`, completion
 * stays at zero, and the run carries an actionable issue. Missing, unreadable
 * or non-object manifests are isolated per file — one bad file never hides the
 * others, and an unreadable directory is `unavailable`, never `empty`.
 *
 * Read-only: this module never writes, never sends, never touches an account.
 * Server-only (imports fs/path).
 */

import path from 'path';

import {
  discoverLaunchFiles,
  fileLastUpdated,
  planHash,
  readLaunchJsonFile,
  validateLaunchPlan,
  validateLaunchProgress,
  type LaunchIssue,
  type LaunchIssueCode,
  type LaunchPlanManifest,
  type LaunchProgressManifest,
} from './launch-storage';

export type LaunchUnitKind = 'page' | 'email' | 'text' | 'automation' | 'conversation_ai';

export type LaunchUnitState =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'blocked'
  | 'dropped'
  /** A state that could not be trusted (quarantined run). Never counts as done. */
  | 'unknown';

export type LaunchRunAvailability = 'ok' | 'quarantined';

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
  /** doneUnits / totalUnits, rounded. 0 when the plan has no units or the run is quarantined. */
  percentage: number;
  /** Non-fatal problems (bad progress file, launch_id mismatch). */
  warnings: string[];
  /** `quarantined` = a manifest could not be trusted; no state was consumed. */
  availability: LaunchRunAvailability;
  /** Actionable issue text, one line per problem. */
  issues: string[];
  issueCodes: LaunchIssueCode[];
  /** Other file that claims the same launch, when a conflicting duplicate was found. */
  duplicateOf: string | null;
  /** Units whose state is unknown (a quarantined run reports every unit unknown). */
  unknownUnits: number;
  /** Planned email sequences (the count a client reads as "sequences"). */
  sequenceCount: number;
  /** Every planned email + text message across the plan. */
  messageCount: number;
  /** Producer's `updated_at` when present, else the plan file's mtime. */
  lastUpdated: string | null;
  /** Kinds the plan does not include at all. Render as "Not included", never 0/0. */
  notIncluded: LaunchUnitKind[];
  /** Approved plan hash (computed from the parsed plan) when the plan is valid. */
  planHash: string | null;
  revision: number | null;
}

export interface LaunchRunsResult {
  dir: string;
  runs: LaunchRun[];
  /** Files that could not be read or parsed. */
  errors: string[];
  /** `unavailable` = the directory itself could not be read. */
  availability: 'ok' | 'unavailable';
  /** A genuinely empty directory is `empty`; an unreadable one is `unavailable`. */
  status: 'ok' | 'empty' | 'unavailable';
  issues: LaunchIssue[];
  quarantined: number;
}

/** Neutral label for a plan section that does not exist. Never "0/0 complete". */
export const NOT_INCLUDED_LABEL = 'Not included';

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
  unknown: 'unknown',
  unrecognized: 'unknown',
};

/**
 * Normalize a raw progress-file state. Unknown or missing states are
 * `unknown` — never silently coerced to `pending`. A unit whose state the
 * producer did not report honestly is unresolved: it must not count toward
 * completion or imply go-live. (The typed validator in launch-storage.ts
 * rejects unknown states first; this is the defense in depth for states
 * that arrive through unvalidated shapes.)
 */
export function normalizeState(value: unknown): LaunchUnitState {
  if (typeof value !== 'string') return 'unknown';
  return STATE_ALIASES[value.trim().toLowerCase()] ?? 'unknown';
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

function positive(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Pure projection: a plan object + trusted states → one run. */
export function buildLaunchRun(
  plan: Record<string, unknown>,
  states: Map<string, LaunchUnitState>,
  sourceFile = '',
): LaunchRun {
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
    (r) => `${positive(r.email_count)} emails · drafts only`,
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
      return `${positive(r.messages)} messages · ${r.promotional === true ? 'promotional' : 'non-promotional'}${hours}`;
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
  const aiUnit = units.find((u) => u.kind === 'conversation_ai');

  const emailSequences = Array.isArray(plan.email_sequences) ? plan.email_sequences : [];
  const textSets = Array.isArray(plan.text_sets) ? plan.text_sets : [];
  const messageCount = [...emailSequences, ...textSets].reduce((sum: number, row) => {
    if (!row || typeof row !== 'object') return sum;
    const rec = row as Record<string, unknown>;
    return sum + positive(rec.email_count) + positive(rec.messages);
  }, 0);

  const notIncluded: LaunchUnitKind[] = [];
  for (const kind of ['page', 'email', 'text', 'automation'] as const) {
    if (counts[kind].total === 0) notIncluded.push(kind);
  }
  if (ai.requested !== true) notIncluded.push('conversation_ai');

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
    availability: 'ok',
    issues: [],
    issueCodes: [],
    duplicateOf: null,
    unknownUnits: 0,
    sequenceCount: emailSequences.length,
    messageCount,
    lastUpdated: null,
    notIncluded,
    planHash: null,
    revision: typeof plan.revision === 'number' ? plan.revision : null,
  };
}

export function launchPlansDir(): string {
  return process.env.LAUNCH_PLANS_DIR || path.join(process.cwd(), 'data', 'launch-plans');
}

/** Put a run into quarantine: no state is trusted, completion stays at zero. */
function quarantine(run: LaunchRun, issue: LaunchIssue, duplicateOf: string | null = null): void {
  run.availability = 'quarantined';
  if (!run.issueCodes.includes(issue.code)) run.issueCodes.push(issue.code);
  run.issues.push(issue.message);
  if (!run.warnings.includes(issue.message)) run.warnings.push(issue.message);
  if (duplicateOf) run.duplicateOf = duplicateOf;
  run.doneUnits = 0;
  run.percentage = 0;
  for (const kind of Object.keys(run.counts) as LaunchUnitKind[]) {
    run.counts[kind].done = 0;
  }
  for (const unit of run.units) unit.state = 'unknown';
  if (run.conversationAi.requested) run.conversationAi.state = 'unknown';
  run.unknownUnits = run.units.length;
}

interface PlanRecord {
  file: string;
  raw: Record<string, unknown>;
  manifest: LaunchPlanManifest;
  hash: string;
  run: LaunchRun;
  ignored: boolean;
}

/**
 * List launch runs on disk, newest launch id first.
 *
 * The result distinguishes three states a caller must never conflate:
 *   `ok`          — directory read; every file accounted for (issues isolated per file)
 *   `empty`       — directory read, genuinely no launch manifests
 *   `unavailable` — directory could not be read; this is NOT an empty launch list
 */
export function listLaunchRuns(dir = launchPlansDir()): LaunchRunsResult {
  const discovery = discoverLaunchFiles(dir);
  const issues: LaunchIssue[] = [...discovery.errors];
  const errors: string[] = discovery.errors.map((issue) => issue.message);

  if (discovery.availability === 'unavailable') {
    return {
      dir,
      runs: [],
      errors,
      availability: 'unavailable',
      status: 'unavailable',
      issues,
      quarantined: 0,
    };
  }

  const plans: PlanRecord[] = [];
  for (const file of discovery.files.filter((f) => f.kind === 'plan')) {
    const read = readLaunchJsonFile(file);
    if (!read.ok) {
      issues.push(read.issue);
      errors.push(read.issue.message);
      continue;
    }
    const validation = validateLaunchPlan(read.value);
    if (!validation.ok) {
      const issue: LaunchIssue = {
        file: file.name,
        code: validation.code,
        message: `${file.name}: ${validation.errors.join('; ')}`,
      };
      issues.push(issue);
      errors.push(issue.message);
      continue;
    }
    const raw = read.value as Record<string, unknown>;
    const manifest = validation.manifest;
    const hash = planHash(raw);
    const run = buildLaunchRun(raw, new Map(), file.name);
    run.planHash = hash;
    run.revision = manifest.revision ?? null;
    run.lastUpdated = fileLastUpdated(file.fullPath);
    plans.push({ file: file.name, raw, manifest, hash, run, ignored: false });
  }

  // Conflicting duplicates: same launch id, different approved hash → neither
  // file may claim completion. Identical duplicates are harmless: keep the
  // first, ignore the rest, never double-count.
  const byLaunch = new Map<string, PlanRecord[]>();
  for (const record of plans) {
    const list = byLaunch.get(record.manifest.launch_id) ?? [];
    list.push(record);
    byLaunch.set(record.manifest.launch_id, list);
  }
  for (const [launchId, records] of byLaunch) {
    if (records.length < 2) continue;
    const distinctHashes = new Set(records.map((record) => record.hash));
    if (distinctHashes.size === 1) {
      for (const record of records.slice(1)) {
        record.ignored = true;
        const issue: LaunchIssue = {
          file: record.file,
          code: 'conflicting_duplicate',
          message: `${record.file} duplicates ${records[0].file} for launch "${launchId}"; the duplicate is ignored`,
        };
        issues.push(issue);
        errors.push(issue.message);
      }
      continue;
    }
    for (const record of records) {
      const others = records.filter((other) => other !== record).map((other) => other.file);
      quarantine(
        record.run,
        {
          file: record.file,
          code: 'conflicting_duplicate',
          message:
            `${record.file} and ${others.join(', ')} both claim launch "${launchId}" with different plans; ` +
            'both are quarantined until one file is removed',
        },
        others[0],
      );
    }
  }

  // Progress files: parse + validate. A malformed or duplicated progress file
  // quarantines the plan(s) it claims instead of leaving optimistic pending.
  const progressByLaunch = new Map<string, { file: string; manifest: LaunchProgressManifest }>();
  const brokenProgress: LaunchIssue[] = [];
  const duplicatedProgress = new Set<string>();
  for (const file of discovery.files.filter((f) => f.kind === 'progress')) {
    const read = readLaunchJsonFile(file);
    if (!read.ok) {
      issues.push(read.issue);
      errors.push(read.issue.message);
      brokenProgress.push(read.issue);
      continue;
    }
    const validation = validateLaunchProgress(read.value);
    if (!validation.ok) {
      const issue: LaunchIssue = {
        file: file.name,
        code: validation.code,
        message: `${file.name}: ${validation.errors.join('; ')}`,
      };
      issues.push(issue);
      errors.push(issue.message);
      brokenProgress.push(issue);
      continue;
    }
    const manifest = validation.manifest;
    const prior = progressByLaunch.get(manifest.launch_id);
    if (prior) {
      duplicatedProgress.add(manifest.launch_id);
      const issue: LaunchIssue = {
        file: file.name,
        code: 'conflicting_duplicate',
        message:
          `${file.name} and ${prior.file} both claim progress for launch "${manifest.launch_id}"; ` +
          'both are ignored until one file is removed',
      };
      issues.push(issue);
      errors.push(issue.message);
      continue;
    }
    progressByLaunch.set(manifest.launch_id, { file: file.name, manifest });
  }

  // Attach a malformed progress file to its sibling plan when the name pairs,
  // so "could not read progress" is never mistaken for "no progress yet".
  for (const record of plans) {
    const sibling = record.file.replace(/\.plan\.json$/, '').replace(/\.json$/, '');
    const issue = brokenProgress.find((candidate) => {
      const base = candidate.file.replace(/\.progress\.json$/, '');
      return base === sibling || base === `progress-${record.manifest.launch_id}`;
    });
    if (issue) quarantine(record.run, issue);
  }

  for (const record of plans) {
    const progress = progressByLaunch.get(record.manifest.launch_id);
    if (!progress) continue;
    const manifest = progress.manifest;

    // A quarantined plan stays quarantined: progress NEVER revives it. The
    // conflicting-duplicate block above already zeroed it with an actionable
    // issue; consuming a matching progress file here would turn one side of a
    // conflict back into N% / OK. Record the skip and move on.
    if (record.run.availability === 'quarantined') {
      const issue: LaunchIssue = {
        file: progress.file,
        code: 'conflicting_duplicate',
        message:
          `${progress.file} matches quarantined plan ${record.file}; progress is not consumed ` +
          'until the conflict is resolved',
      };
      issues.push(issue);
      errors.push(issue.message);
      continue;
    }

    if (record.manifest.launch_id !== manifest.launch_id) {
      quarantine(record.run, {
        file: progress.file,
        code: 'foreign_launch',
        message:
          `${progress.file} names launch "${manifest.launch_id}" but is paired with ` +
          `"${record.manifest.launch_id}"; progress is not consumed`,
      });
      continue;
    }
    if (manifest.plan_hash !== record.hash) {
      quarantine(record.run, {
        file: progress.file,
        code: 'plan_hash_mismatch',
        message:
          `${progress.file} belongs to plan hash ${manifest.plan_hash}, but ${record.file} hashes to ` +
          `${record.hash}; progress is not consumed`,
      });
      continue;
    }
    if (
      manifest.revision !== undefined &&
      record.manifest.revision !== undefined &&
      manifest.revision !== record.manifest.revision
    ) {
      quarantine(record.run, {
        file: progress.file,
        code: 'revision_mismatch',
        message:
          `${progress.file} is revision ${manifest.revision} but ${record.file} is revision ` +
          `${record.manifest.revision}; progress is not consumed`,
      });
      continue;
    }
    if (duplicatedProgress.has(manifest.launch_id)) {
      quarantine(record.run, {
        file: progress.file,
        code: 'conflicting_duplicate',
        message: `launch "${manifest.launch_id}" has conflicting progress files; none are consumed`,
      });
      continue;
    }

    const states = new Map<string, LaunchUnitState>();
    for (const [id, unit] of Object.entries(manifest.units)) {
      states.set(id, normalizeState(unit.state));
    }
    const rebuilt = buildLaunchRun(record.raw, states, record.file);
    rebuilt.planHash = record.hash;
    rebuilt.revision = record.manifest.revision ?? null;
    rebuilt.lastUpdated = manifest.updated_at;
    record.run = rebuilt;
  }

  // A progress file whose launch never appears as an approved plan is reported,
  // never silently dropped and never counted.
  for (const [launchId, progress] of progressByLaunch) {
    if (byLaunch.has(launchId)) continue;
    const issue: LaunchIssue = {
      file: progress.file,
      code: 'foreign_launch',
      message: `${progress.file} names launch "${launchId}" but no approved plan exists for it; progress is not consumed`,
    };
    issues.push(issue);
    errors.push(issue.message);
  }

  const visible = plans.filter((record) => !record.ignored).map((record) => record.run);
  visible.sort((a, b) => b.launchId.localeCompare(a.launchId));
  return {
    dir,
    runs: visible,
    errors,
    availability: 'ok',
    status: visible.length === 0 ? 'empty' : 'ok',
    issues,
    quarantined: visible.filter((run) => run.availability === 'quarantined').length,
  };
}

export function getLaunchRun(launchId: string, dir = launchPlansDir()): LaunchRun | null {
  return listLaunchRuns(dir).runs.find((run) => run.launchId === launchId) ?? null;
}
