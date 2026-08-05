/**
 * capability-manifest.ts — Server-only.
 *
 * Unit 3.4 (master plan 2026-08-04) — the Command Center must NEVER dispatch a
 * podcast task to a box whose Podcast Production Engine (Skill 58) processor is
 * not activated. The incident: dispatch minted a phantom agent id
 * (`audio-podcast-editor`) from thin air and the heartbeat woke a tool-less
 * isolated sub-session that "did the work" by improvising — no skill bindings,
 * no engine connection, no quality control.
 *
 * The capability manifest is the machine-readable contract Skill 58 ships at
 * `config/capability-manifest.json` (onboarding repo, 58-podcast-production-engine).
 * On a client box it is installed at `<skills-root>/58-podcast-production-engine/
 * config/capability-manifest.json`. It declares:
 *   - the activation command pair (`install-podcast-department.sh` +
 *     `register-podcast-hook.sh`) and the rescue SOP (SOP-PODCAST-07),
 *   - the required env labels with SET / NOT-SET semantics,
 *   - the activation layer components (dept agent runtime dir, intake hook
 *     route, scheduler cron, controller / step driver),
 *   - the dispatch contract: refuse without activation, never invent an agent id.
 *
 * The dispatch resolver reads this manifest BEFORE assigning a podcast task.
 * When the manifest is absent OR the activation layer is incomplete, the task
 * is HELD loudly with "run SOP-PODCAST-07" and NO agent id is minted. This is
 * fail-closed: an unverifiable activation is a refusal, never a silent dispatch.
 *
 * This module is server-only (imports fs/path/os) and is imported ONLY by
 * server-only dispatch code (task-dispatcher.ts, tasks.ts). It is NEVER pulled
 * into the Next.js EDGE bundle (department-router.ts must stay edge-safe).
 */

import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { detectPlatform, openclawConfigPath } from '@/lib/platform';

export interface CapabilityManifest {
  schema_version?: string;
  skill?: {
    id?: number | string;
    slug?: string;
    name?: string;
    install_path?: string;
  };
  activation?: {
    command_pair?: string[];
    command_pair_exact?: string[];
    rescue_sop?: string;
    rescue_sop_path?: string;
    rescue_sop_message?: string;
    health_guard?: string;
  };
  entrypoints?: {
    intake_route_template?: string;
    step_driver?: string;
    state_writer?: string;
    intake_handler?: string;
    controller_id_template?: string;
    session_key_template?: string;
    route_id_template?: string;
    endpoint_template?: string;
  };
  required_env?: Record<string, { semantics?: string; required?: string; default?: string; mode?: string; secrecy?: string }>;
  activation_layer_components?: {
    department_agent?: {
      id?: string;
      runtime_dir?: string;
      required_files?: string[];
      missing_message?: string;
    };
    intake_hook_route?: { config_path?: string; route_id?: string; session_key?: string; missing_message?: string };
    scheduler?: { cron?: string; missing_message?: string };
    controller?: { runbook?: string; missing_message?: string };
  };
  dispatch_contract?: {
    refuse_without_activation?: boolean;
    refuse_message?: string;
    never_invent_agent_id?: boolean;
    forbidden_agent_ids?: string[];
    hold_reason_no_runtime?: string;
    hold_reason_no_skill?: string;
    required_skill_match?: { skill_id?: number | string; slug?: string; message?: string };
  };
}

export const PODCAST_SKILL_ID = 58;
export const PODCAST_SKILL_SLUG = 'podcast-production-engine';
export const PODCAST_DEPT_SLUG = 'podcast';

/** On-box skill install roots for Skill 58, per platform (mirrors the on-box
 * install layout the activation layer and guard-activation-health.py use). */
function podcastSkillRoots(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (detectPlatform() === 'vps-docker') {
    return [
      '/data/.openclaw/skills/58-podcast-production-engine',
      '/data/.openclaw/workspace/openclaw-onboarding/skills/58-podcast-production-engine',
      path.join('/data/.openclaw', 'skills', '58-podcast-production-engine'),
    ];
  }
  return [
    path.join(home, '.openclaw', 'skills', '58-podcast-production-engine'),
    path.join(home, '.claude', 'skills', '58-podcast-production-engine'),
    path.join(home, 'clawd', 'skills', '58-podcast-production-engine'),
    path.join(home, '.openclaw', 'workspace', 'openclaw-onboarding', '58-podcast-production-engine'),
    path.join(home, '.openclaw', 'workspace', 'openclaw-onboarding', 'skills', '58-podcast-production-engine'),
  ];
}

/** Locate the installed capability-manifest.json for Skill 58, or null. */
export function findPodcastCapabilityManifestPath(): string | null {
  const roots = podcastSkillRoots();
  const candidates = roots.map((r) => path.join(r, 'config', 'capability-manifest.json'));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* probe best-effort */
    }
  }
  return null;
}

/**
 * Read and parse the Skill 58 capability manifest. Returns the parsed manifest,
 * or null when absent/unreadable/unparseable (an unverifiable box is treated as
 * NOT activated — fail closed).
 */
export function loadPodcastCapabilityManifest(): CapabilityManifest | null {
  try {
    const manifestPath = findPodcastCapabilityManifestPath();
    if (!manifestPath) return null;
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as CapabilityManifest;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    console.warn(
      '[capability-manifest] Skill 58 manifest unreadable (treated as NOT activated):',
      (err as Error).message,
    );
    return null;
  }
}

/** The dept-podcast runtime dir, per platform (mirrors resolveSpecialistSessionKey). */
export function podcastAgentRuntimeDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (detectPlatform() === 'vps-docker') {
    return '/data/.openclaw/agents/dept-podcast';
  }
  return path.join(home, '.openclaw', 'agents', 'dept-podcast');
}

/** The installed skill 58 root on this box (parent of the manifest's config/). */
function podcastSkillRoot(): string | null {
  const manifestPath = findPodcastCapabilityManifestPath();
  if (!manifestPath) return null;
  const root = path.dirname(path.dirname(manifestPath)); // …/58-podcast-production-engine/config/capability-manifest.json → …/58-podcast-production-engine
  return root;
}

/**
 * Component 2 — intake hook route. The manifest declares the route lives at
 * openclaw.json > plugins.entries.webhooks.config.routes and is keyed
 * `podcast-intake-<slug>` with a `podcast:intake:<slug>` sessionKey. We verify
 * AT LEAST ONE such route is registered on this box (the gate cannot know the
 * client slug — any registered podcast-intake route proves the intake hook
 * activation layer is wired). Fail-closed: an unreadable/missing openclaw.json
 * or a config with no podcast route counts as NOT activated.
 */
function intakeHookRouteRegistered(): boolean {
  try {
    const cfgPath = openclawConfigPath();
    if (!cfgPath || !fs.existsSync(cfgPath)) return false;
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw) as {
      plugins?: {
        entries?: {
          webhooks?: { config?: { routes?: Record<string, unknown> } };
        };
      };
    };
    const routes = cfg?.plugins?.entries?.webhooks?.config?.routes;
    if (!routes || typeof routes !== 'object') return false;
    const routeIds = Object.keys(routes);
    return routeIds.some((id) => id.startsWith('podcast-intake-'));
  } catch {
    return false;
  }
}

/** Component 3 — scheduler. The manifest's one recurring podcast cron is the
 * daily smoke test (`podcast-smoke-<slug>`), stored in the OpenClaw cron store
 * (SQLite state db, `cron_jobs` table). We verify at least one enabled podcast
 * cron is registered. Fail-closed: an unreadable store or no podcast cron
 * counts as NOT activated. */
function schedulerRegistered(): boolean {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const ocRoot = detectPlatform() === 'vps-docker' ? '/data/.openclaw' : path.join(home, '.openclaw');
    const stateSqlite = path.join(ocRoot, 'state', 'openclaw.sqlite');
    if (!fs.existsSync(stateSqlite)) return false;
    const db = new Database(stateSqlite, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT job_id FROM cron_jobs
            WHERE enabled = 1
              AND (name LIKE 'podcast-smoke-%' OR name LIKE 'podcast-%')
            LIMIT 1`,
        )
        .get();
      return Boolean(row);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Component 4 — controller / step driver. The manifest declares the step
 * driver at `scripts/podcast_step_driver.py` (runbook: one bounded pass in the
 * agent's own turn). The processor CANNOT advance a flow without it, so a box
 * whose skill tree lacks the step driver is NOT activated — dispatching a
 * podcast task there would push into a session whose controller is missing. */
function stepDriverPresent(manifest: CapabilityManifest, skillRoot: string): boolean {
  const rel = manifest?.entrypoints?.step_driver;
  if (!rel) return false;
  const abs = path.resolve(skillRoot, rel);
  try {
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Per-agent files the installer materializes into the runtime dir. The
 * manifest's required_files ALSO lists `agent/openclaw-agent.sqlite`, but that
 * store is deliberately LAZY — the gateway creates it on the FIRST dispatch —
 * so it is NOT a materialization proof (QC's F7 doc/behavior mismatch). We
 * derive the required file set from the manifest and drop the lazy sqlite. */
function runtimeRequiredFiles(manifest: CapabilityManifest): string[] {
  const declared = manifest?.activation_layer_components?.department_agent?.required_files ?? [];
  const base = declared.length > 0 ? declared : ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'MEMORY.md', 'HEARTBEAT'];
  return base.filter((f) => f !== 'agent/openclaw-agent.sqlite');
}

/**
 * Is the Skill 58 processor ACTIVATED on this box?
 *
 * FOUR activation-layer components must ALL pass (per the capability manifest's
 * activation_layer_components), fail-closed on any miss:
 *   1. department_agent — the dept-podcast runtime dir exists AND carries the
 *      per-agent files the manifest's required_files declares (minus the lazy
 *      sqlite). A bare/existence-only dir is NOT proof (the shared materializer
 *      creates EMPTY agent dirs for every discovered department);
 *   2. intake_hook_route — openclaw.json has a registered `podcast-intake-*`
 *      webhook route (the intake activation layer is wired);
 *   3. scheduler — the OpenClaw cron store has an enabled `podcast-smoke-*`
 *      cron (the ONE recurring podcast job; no queue poller);
 *   4. controller — the step driver entrypoint
 *      (`scripts/podcast_step_driver.py`) is present under the installed skill
 *      root. Without it the processor CANNOT advance a flow — this is the
 *      component that is absent fleet-wide until unit 1.2 lands, so a box
 *      reporting "activated" while the driver is missing would dispatch into a
 *      session whose controller does not exist.
 *
 * The dept-podcast runtime dir is the load-bearing proof that a processor can
 * actually hold the intake session (master plan unit 3.5). The other three
 * components close the MEDIUM gap where activation reported green with an
 * unwired intake route, missing cron, or a missing step driver.
 *
 * Returns a reason string when NOT activated (for the loud refusal message),
 * or null when activated. Never throws (fail-soft reads).
 */
export function podcastProcessorActivationStatus(): { activated: boolean; reason: string } {
  const manifest = loadPodcastCapabilityManifest();
  if (!manifest) {
    return {
      activated: false,
      reason:
        'Skill 58 capability manifest not found on this box ' +
        '(missing config/capability-manifest.json under the installed 58-podcast-production-engine). ' +
        'An unverifiable podcast processor is treated as NOT activated — run SOP-PODCAST-07.',
    };
  }

  const skillRoot = podcastSkillRoot();

  // Component 1 — department_agent: runtime dir EXISTS and is MATERIALIZED
  // (carries the per-agent files from the manifest's required_files, minus the
  // lazy sqlite), not a bare empty dir.
  const runtimeDir = podcastAgentRuntimeDir();
  const runtimeRequired = runtimeRequiredFiles(manifest);
  let runtimeDirOk = false;
  let missingRuntimeFiles: string[] = [];
  try {
    if (fs.existsSync(runtimeDir) && fs.statSync(runtimeDir).isDirectory()) {
      missingRuntimeFiles = runtimeRequired.filter(
        (f) => !fs.existsSync(path.join(runtimeDir, f)),
      );
      runtimeDirOk = missingRuntimeFiles.length === 0;
    }
  } catch {
    runtimeDirOk = false;
  }
  if (!runtimeDirOk) {
    const detail =
      missingRuntimeFiles.length > 0
        ? `missing per-agent file(s) ${missingRuntimeFiles.join(', ')} in ${runtimeDir}`
        : `the dept-podcast runtime dir (${runtimeDir}) does not exist on this box`;
    return {
      activated: false,
      reason:
        `Skill 58 capability manifest present, but the department_agent layer is not ` +
        `materialized — ${detail}. The processor cannot hold the intake session. Run ` +
        'install-podcast-department.sh (part of SOP-PODCAST-07) to materialize it.',
    };
  }

  // Component 2 — intake_hook_route.
  if (!intakeHookRouteRegistered()) {
    return {
      activated: false,
      reason:
        'Skill 58 capability manifest present, but the intake_hook_route layer is not ' +
        'wired — openclaw.json has no registered podcast-intake-* webhook route. Run ' +
        'register-podcast-hook.sh --client-slug <slug> (part of SOP-PODCAST-07).',
    };
  }

  // Component 3 — scheduler (the one recurring podcast cron).
  if (!schedulerRegistered()) {
    return {
      activated: false,
      reason:
        'Skill 58 capability manifest present, but the scheduler layer is missing — ' +
        'no enabled podcast cron (podcast-smoke-<slug>) is registered in the OpenClaw ' +
        'cron store. Recreate it per SOP-PODCAST-04 Section 1 (part of SOP-PODCAST-07).',
    };
  }

  // Component 4 — controller / step driver.
  if (!stepDriverPresent(manifest, skillRoot ?? '')) {
    const stepDriverRel = manifest?.entrypoints?.step_driver || 'scripts/podcast_step_driver.py';
    return {
      activated: false,
      reason:
        `Skill 58 capability manifest present, but the controller layer is missing — the ` +
        `step driver (${stepDriverRel}) is absent under the installed skill root. Without ` +
        'it the processor cannot advance a flow. Run SOP-PODCAST-07 after the step driver ' +
        'is installed.',
    };
  }

  return {
    activated: true,
    reason:
      'Skill 58 processor activated (manifest present + department_agent materialized + ' +
      'intake_hook_route wired + scheduler cron registered + step driver present)',
  };
}

/** True when the task's department canonicalizes to the podcast department. */
export function isPodcastTask(department: string | null | undefined): boolean {
  if (!department) return false;
  const canon = department.trim().toLowerCase();
  return canon === PODCAST_DEPT_SLUG || canon === `dept-${PODCAST_DEPT_SLUG}`;
}

/**
 * The refusal message for a podcast task on a box without an activated
 * processor. NEVER mints an agent id. Names the rescue SOP exactly as the
 * manifest declares it.
 */
export function podcastActivationRefusalMessage(): string {
  const manifest = loadPodcastCapabilityManifest();
  const sop = manifest?.activation?.rescue_sop || 'SOP-PODCAST-07';
  const sopMessage =
    manifest?.activation?.rescue_sop_message ||
    `No podcast processor activated on this box — run ${sop} (ACTIVATION RESCUE): ` +
      'install-podcast-department.sh then register-podcast-hook.sh, then confirm with guard-activation-health.py.';
  return sopMessage;
}
