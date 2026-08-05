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
import { detectPlatform } from '@/lib/platform';

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

/**
 * Is the Skill 58 processor ACTIVATED on this box?
 *
 * Two layers must both pass:
 *   1. The capability manifest is installed AND parseable.
 *   2. The dept-podcast runtime dir exists (the department_agent activation
 *      layer). The runtime dir is the load-bearing proof that a processor can
 *      actually hold the intake session — the master plan (unit 3.5) requires
 *      ~/.openclaw/agents/dept-podcast/ to exist before dispatch can push.
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

  const runtimeDir = podcastAgentRuntimeDir();
  let runtimeExists = false;
  try {
    runtimeExists = fs.existsSync(runtimeDir);
  } catch {
    runtimeExists = false;
  }
  if (!runtimeExists) {
    return {
      activated: false,
      reason:
        `Skill 58 capability manifest present, but the dept-podcast runtime dir ` +
        `(${runtimeDir}) does not exist on this box — the processor cannot hold the ` +
        'intake session. Run install-podcast-department.sh (part of SOP-PODCAST-07) to materialize it.',
    };
  }

  return { activated: true, reason: 'Skill 58 processor activated (manifest present + dept-podcast runtime dir exists)' };
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
