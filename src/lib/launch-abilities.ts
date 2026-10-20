/**
 * launch-abilities.ts — the launch skill-ability registry (WF-CC).
 *
 * Command Center registers the five launch abilities so runs and progress for
 * each one flow through the SAME contracts the Command Center already reads:
 *
 *   - run events   : the frozen Skill 71 run-events contract (v1.0) —
 *                    `71-blackceo-signature-page/references/run-events.schema.md`;
 *                    `src/lib/launch-run-events.ts` mirrors it field for field.
 *   - progress     : the launch progress sample contract —
 *                    `shared-utils/signature_launch/domain/progress.schema.json`
 *                    (`build_percent`, `batch_merge_percent`, `batch_status`, …).
 *   - launch identity: `launch_id` from the U-CONTRACT launch plan —
 *                    `shared-utils/signature_launch_contract/launch-plan.schema.json`.
 *
 * This module is PURE (no fs, no db, no node builtins) so both server code and
 * client components can import it, and so it can be unit-tested without a DB.
 *
 * Registration is additive: adding an ability here is the ONLY change needed
 * for its runs and progress to be accepted, listed and scored — the ingestion
 * core (`launch-ability-runs.ts`), the read/ingest API and the progress math
 * all read this registry.
 *
 * No client names, credentials, plan copy or page text live here: the registry
 * carries identifiers, stage orders and contract references only.
 */

/** A single launch skill the Command Center knows how to display. */
export interface LaunchAbility {
  /** Skill number as it appears in the onboarding repo directory (e.g. 49). */
  readonly skill: number;
  /** Directory slug, e.g. `signature-funnel`. */
  readonly slug: string;
  /** Full directory name in the onboarding repo. */
  readonly directory: string;
  /** Human-readable label for screens. */
  readonly displayName: string;
  /** Spec row this ability answers to (`launch-automations.spec.md` §1). */
  readonly specRow: string;
  /** Lane that builds it (swarm-management §1 exact lane folders). */
  readonly lane: 'WF-SWARM' | 'WF-LAUNCHERS' | 'WF-AUTO' | 'WF-EMAIL' | 'WF-AI';
  /** Fail-closed entrypoint that must exist before the ability can run. */
  readonly entrypoint: string;
  /**
   * Stage order, in the order the skill actually executes them. Progress is
   * scored against this list; a stage that is not named here is rejected by
   * the ingestion validator.
   */
  readonly stageOrder: readonly string[];
  /**
   * Launch-plan sections this ability produces
   * (`shared-utils/signature_launch_contract/launch-plan.schema.json`).
   */
  readonly planSections: readonly LaunchPlanSection[];
}

export type LaunchPlanSection =
  | 'pages'
  | 'email_sequences'
  | 'text_sets'
  | 'automations'
  | 'conversation_ai'
  | 'launch_calendar';

/**
 * The five launch abilities. Names and stage orders mirror the skill trees as
 * inventoried (U-INV-49-83, U-INV-38, U-INV-44, U-INV-50) — do not rename a
 * stage without changing the skill that emits it.
 */
export const LAUNCH_ABILITIES: readonly LaunchAbility[] = [
  {
    skill: 49,
    slug: 'signature-funnel',
    directory: '49-signature-funnel',
    displayName: 'Signature Funnel',
    specRow: 'Skill 49 Signature Funnel — plans every page; single conductor for page dispatch',
    lane: 'WF-SWARM',
    entrypoint: '49-signature-funnel/signature-funnel-entry.sh',
    stageOrder: [
      'intake',
      'launch_plan',
      'approval',
      'route_graph',
      'page_dispatch',
      'page_results',
      'receipts',
    ],
    planSections: ['pages'],
  },
  {
    skill: 50,
    slug: 'email-engine',
    directory: '50-email-engine',
    displayName: 'Email Engine',
    specRow: 'Skill 50 Email Engine — launch email sequences and text sets',
    lane: 'WF-EMAIL',
    entrypoint: '50-email-engine/email-library/sequences',
    stageOrder: [
      'sequence_selected',
      'copy',
      'catalog_index',
      'render',
      'schedule_plan',
    ],
    planSections: ['email_sequences', 'text_sets'],
  },
  {
    skill: 44,
    slug: 'convert-and-flow-operator',
    directory: '44-convert-and-flow-operator',
    displayName: 'Convert and Flow Operator',
    specRow: 'Skill 44 Convert and Flow Operator — launch automations from templates',
    lane: 'WF-AUTO',
    entrypoint: '44-convert-and-flow-operator/automation-templates',
    stageOrder: [
      'template_selected',
      'spec',
      'build',
      'qc',
      'install',
    ],
    planSections: ['automations'],
  },
  {
    skill: 38,
    slug: 'conversational-ai-system',
    directory: '38-conversational-ai-system',
    displayName: 'Conversational AI System',
    specRow: 'Skill 38 Conversational AI System — launch bot (Conversation AI)',
    lane: 'WF-AI',
    entrypoint: '38-conversational-ai-system/launch',
    stageOrder: [
      'persona',
      'knowledge',
      'prompts',
      'qc',
      'activation',
    ],
    planSections: ['conversation_ai'],
  },
  {
    skill: 83,
    slug: 'black-friday-launcher',
    directory: '83-black-friday-launcher',
    displayName: 'Black Friday Launcher',
    specRow: 'Skill 83 Black Friday Launcher — calendar, completeness, package (builds pages through 49)',
    lane: 'WF-LAUNCHERS',
    entrypoint: '83-black-friday-launcher/launcher_core/cli.py',
    stageOrder: [
      'intake',
      'launch_record',
      'dispatch',
      'pieces',
      'assemble',
      'checks',
    ],
    planSections: ['launch_calendar'],
  },
] as const;

const BY_SKILL = new Map<number, LaunchAbility>(LAUNCH_ABILITIES.map((a) => [a.skill, a]));
const BY_SLUG = new Map<string, LaunchAbility>(LAUNCH_ABILITIES.map((a) => [a.slug, a]));

/** Resolve an ability by skill number (`49`) or numeric string (`"49"`). */
export function getLaunchAbility(skill: number | string | null | undefined): LaunchAbility | null {
  if (skill === null || skill === undefined) return null;
  const n = typeof skill === 'number' ? skill : Number(skill);
  if (!Number.isInteger(n)) return null;
  return BY_SKILL.get(n) ?? null;
}

/** Resolve an ability by directory slug (`signature-funnel`). */
export function getLaunchAbilityBySlug(slug: string | null | undefined): LaunchAbility | null {
  if (!slug) return null;
  return BY_SLUG.get(slug) ?? null;
}

/** All registered skill numbers, in registry order. */
export function launchAbilitySkillNumbers(): number[] {
  return LAUNCH_ABILITIES.map((a) => a.skill);
}

/** True when `stage` is one of the ability's declared stages. */
export function isLaunchStage(ability: LaunchAbility, stage: unknown): boolean {
  return typeof stage === 'string' && ability.stageOrder.includes(stage);
}

/**
 * The single receipt rule the Command Center already applies (Skill 71 runs):
 * a close whose receipt_status is `not_authorized` is NOT a pass and never
 * counts toward progress.
 */
export interface LaunchStageRow {
  stage: string;
  status: string;
  receipt_status?: string | null;
}

export interface LaunchProgress {
  launch_id: string;
  skill: number;
  ability_slug: string;
  stages_closed: number;
  stages_total: number;
  /** 0–100, matching `build_percent` in the launch progress contract. */
  build_percent: number;
  blocked_stages: string[];
  next_stage: string | null;
}

/**
 * Score one ability's stage rows against its declared stage order. Pure: the
 * caller passes what the database (or a run folder) reported.
 *
 * `build_percent` is the integer share of declared stages closed with a pass
 * receipt. A blocked stage never counts as closed.
 */
export function computeLaunchProgress(
  ability: LaunchAbility,
  launchId: string,
  rows: readonly LaunchStageRow[],
): LaunchProgress {
  const byStage = new Map(rows.map((r) => [r.stage, r]));
  const closed = ability.stageOrder.filter((stage) => {
    const row = byStage.get(stage);
    return Boolean(row) && row!.status === 'closed' && row!.receipt_status !== 'not_authorized';
  });
  const blocked = ability.stageOrder.filter((stage) => byStage.get(stage)?.status === 'blocked');
  const next = ability.stageOrder.find((stage) => !closed.includes(stage)) ?? null;
  const total = ability.stageOrder.length;
  return {
    launch_id: launchId,
    skill: ability.skill,
    ability_slug: ability.slug,
    stages_closed: closed.length,
    stages_total: total,
    build_percent: total === 0 ? 0 : Math.round((closed.length / total) * 100),
    blocked_stages: blocked,
    next_stage: next,
  };
}

/**
 * The exact field names of the launch progress sample contract
 * (`shared-utils/signature_launch/domain/progress.schema.json`). Kept here so
 * the ingestion validator rejects any field the contract does not name.
 */
export const PROGRESS_SAMPLE_KEYS = [
  'schema_version',
  'project_id',
  'room_id',
  'scope_version',
  'observed_at',
  'build_percent',
  'batch_merge_percent',
  'batch_status',
  'hourly_net_pp',
  'rate_window_minutes',
  'swarm_score',
  'swarm_coverage',
  'active_agents',
  'eligible_capacity',
  'verified_task_ids',
  'blocked_task_ids',
  'decision_ids',
  'next_task_ids',
  'evidence_refs',
] as const;

export type ProgressSampleKey = (typeof PROGRESS_SAMPLE_KEYS)[number];

export const PROGRESS_BATCH_STATUSES = [
  'awaiting_owner_approval',
  'approved_not_started',
  'merging',
  'verified',
  'blocked',
] as const;

/**
 * The launch-plan sections a client-visible launch row uses to prove the plan
 * was actually accepted, keyed by the ability that produces them. Used by the
 * read surface to show what each ability contributes to one launch.
 */
export function abilitiesForPlanSection(section: LaunchPlanSection): LaunchAbility[] {
  return LAUNCH_ABILITIES.filter((a) => a.planSections.includes(section));
}

// ---------------------------------------------------------------------------
// Progress sample — the launch progress contract
// (`shared-utils/signature_launch/domain/progress.schema.json`), field for
// field. `project_id` carries the launch plan's `launch_id`. Kept in this pure
// module so it can be validated and unit-tested without a database.
// ---------------------------------------------------------------------------

export interface ProgressSample {
  schema_version: '1.0';
  project_id: string;
  room_id: string;
  scope_version: number;
  observed_at: string;
  build_percent: number;
  batch_merge_percent: number;
  batch_status: (typeof PROGRESS_BATCH_STATUSES)[number];
  hourly_net_pp: number | null;
  rate_window_minutes: number;
  swarm_score: number | null;
  swarm_coverage: number;
  active_agents: number;
  eligible_capacity: number;
  verified_task_ids: string[];
  blocked_task_ids: string[];
  decision_ids: string[];
  next_task_ids: string[];
  evidence_refs: string[];
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const STRING_ARRAY_FIELDS = [
  'verified_task_ids', 'blocked_task_ids', 'decision_ids',
  'next_task_ids', 'evidence_refs',
] as const;

export type ProgressValidationResult =
  | { ok: true; sample: ProgressSample }
  | { ok: false; errors: string[] };

/** Validate one sample against the launch progress contract. Fail-closed. */
export function validateProgressSample(raw: unknown): ProgressValidationResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['progress sample is not a JSON object'] };
  }
  const s = raw as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!(PROGRESS_SAMPLE_KEYS as readonly string[]).includes(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }
  for (const key of PROGRESS_SAMPLE_KEYS) {
    if (s[key] === undefined) errors.push(`${key} is required`);
  }
  if (s.schema_version !== '1.0') errors.push('schema_version must be "1.0"');
  if (typeof s.project_id !== 'string' || s.project_id.length < 1) errors.push('project_id must be a non-empty string');
  if (typeof s.room_id !== 'string' || s.room_id.length < 1) errors.push('room_id must be a non-empty string');
  if (!Number.isInteger(s.scope_version) || (s.scope_version as number) < 1) errors.push('scope_version must be an integer >= 1');
  if (typeof s.observed_at !== 'string' || !DATETIME_RE.test(s.observed_at) || Number.isNaN(Date.parse(s.observed_at))) {
    errors.push('observed_at must be an ISO-8601 date-time');
  }
  const pct = (k: string) => {
    const v = s[k];
    if (typeof v !== 'number' || v < 0 || v > 100) errors.push(`${k} must be a number 0–100`);
  };
  pct('build_percent');
  pct('batch_merge_percent');
  if (!(PROGRESS_BATCH_STATUSES as readonly string[]).includes(s.batch_status as string)) {
    errors.push(`batch_status must be one of ${PROGRESS_BATCH_STATUSES.join(', ')}`);
  }
  if (s.hourly_net_pp !== null && typeof s.hourly_net_pp !== 'number') errors.push('hourly_net_pp must be a number or null');
  if (typeof s.rate_window_minutes !== 'number' || (s.rate_window_minutes as number) < 0) {
    errors.push('rate_window_minutes must be a non-negative number');
  }
  if (s.swarm_score !== null &&
      (!Number.isInteger(s.swarm_score) || (s.swarm_score as number) < 0 || (s.swarm_score as number) > 100)) {
    errors.push('swarm_score must be an integer 0–100 or null');
  }
  if (typeof s.swarm_coverage !== 'number' || s.swarm_coverage < 0 || s.swarm_coverage > 1) {
    errors.push('swarm_coverage must be a number 0–1');
  }
  if (!Number.isInteger(s.active_agents) || (s.active_agents as number) < 0 || (s.active_agents as number) > 500) {
    errors.push('active_agents must be an integer 0–500');
  }
  if (!Number.isInteger(s.eligible_capacity) || (s.eligible_capacity as number) < 0 || (s.eligible_capacity as number) > 500) {
    errors.push('eligible_capacity must be an integer 0–500');
  }
  for (const key of STRING_ARRAY_FIELDS) {
    if (!Array.isArray(s[key]) || (s[key] as unknown[]).some((v) => typeof v !== 'string' || v.length < 1)) {
      errors.push(`${key} must be an array of non-empty strings`);
    }
  }
  // Contract allOf: awaiting owner approval means nothing has merged yet.
  if (s.batch_status === 'awaiting_owner_approval' && s.batch_merge_percent !== 0) {
    errors.push('batch_merge_percent must be 0 while batch_status is awaiting_owner_approval');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, sample: s as unknown as ProgressSample };
}
