/**
 * Interview seam — filesystem path resolution (P0-1).
 *
 * The Skill-23 AI-Workforce interview keeps its canonical state on disk, in two
 * different trees whose ROOTS differ by host. This module is the SINGLE place
 * that resolves those roots so every interview API route reads/writes the exact
 * same files the Telegram agent + the Skill-23 shell scripts touch.
 *
 *   ── State tree (workspace) ──────────────────────────────────────────────
 *     VPS / Hostinger Docker : /data/.openclaw/workspace
 *     Mac / bare install     : $HOME/.openclaw/workspace
 *   These are the EXACT two branches update-interview-state.sh and
 *   record-dept-decision.sh probe (in this order) — mirrored here so the app
 *   and the scripts always agree on which .workforce-build-state.json is live.
 *
 *   ── Skill tree (scripts) ────────────────────────────────────────────────
 *     VPS : /data/.openclaw/skills/23-ai-workforce-blueprint/scripts
 *     Mac : $HOME/.openclaw/skills/23-ai-workforce-blueprint/scripts
 *   Mirrors the resolution already used by
 *   src/app/api/departments/route.ts and src/lib/persona-selector.ts.
 *
 * Env overrides (test / non-standard installs) always win when set:
 *   OPENCLAW_WORKSPACE_ROOT  — force the workspace dir
 *   OPENCLAW_SKILL23_SCRIPTS — force the scripts dir
 *
 * Nothing here throws: a missing tree resolves to the canonical default path so
 * callers get a stable, inspectable path (and a clear ENOENT downstream) rather
 * than an exception.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const VPS_WORKSPACE = '/data/.openclaw/workspace';
const VPS_SKILLS = '/data/.openclaw/skills';
const SKILL23 = '23-ai-workforce-blueprint';

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function macWorkspace(): string {
  return path.join(os.homedir(), '.openclaw', 'workspace');
}

/**
 * Resolve the live OpenClaw workspace directory the SAME way the Skill-23 shell
 * scripts do: env override → /data/.openclaw/workspace (if it EXISTS) →
 * $HOME/.openclaw/workspace. The `/data` branch is only taken when the dir
 * actually exists (exactly `if [ -d /data/.openclaw/workspace ]` in the scripts),
 * so a Mac install with no /data never mis-resolves.
 */
export function resolveWorkspaceDir(): string {
  const override = process.env.OPENCLAW_WORKSPACE_ROOT;
  if (override && override.trim()) return override;
  if (safeIsDir(VPS_WORKSPACE)) return VPS_WORKSPACE;
  return macWorkspace();
}

/** The canonical build-state file: <workspace>/.workforce-build-state.json */
export function buildStatePath(): string {
  return path.join(resolveWorkspaceDir(), '.workforce-build-state.json');
}

/**
 * The company-discovery subdir where the interview transcript + handoff live.
 * Skill-23 writes workforce-interview-answers.md and interview-handoff.md under
 * <workspace>/company-discovery/. Older / alternate layouts drop them at the
 * workspace root, so the file resolvers below probe both.
 */
export function companyDiscoveryDir(): string {
  return path.join(resolveWorkspaceDir(), 'company-discovery');
}

/**
 * Resolve the interview-answers transcript. Probes, in order:
 *   1. an explicit path recorded in build-state (interviewProgress.answersFilePath)
 *   2. <workspace>/company-discovery/workforce-interview-answers.md   (canonical)
 *   3. <workspace>/workforce-interview-answers.md                     (flat fallback)
 * Returns the first path that EXISTS; if none exist, returns the canonical
 * default (#2) so callers have a stable path to report / create against.
 *
 * @param recordedPath optional interviewProgress.answersFilePath from build-state
 */
export function answersFilePath(recordedPath?: string | null): string {
  const canonical = path.join(companyDiscoveryDir(), 'workforce-interview-answers.md');
  const candidates = [
    recordedPath && recordedPath.trim() ? recordedPath : null,
    canonical,
    path.join(resolveWorkspaceDir(), 'workforce-interview-answers.md'),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (safeIsFile(c)) return c;
  }
  return canonical;
}

/**
 * Resolve the interview-handoff tracker. Probes company-discovery first, then
 * the workspace root; falls back to the canonical company-discovery path.
 */
export function handoffFilePath(): string {
  const canonical = path.join(companyDiscoveryDir(), 'interview-handoff.md');
  const candidates = [canonical, path.join(resolveWorkspaceDir(), 'interview-handoff.md')];
  for (const c of candidates) {
    if (safeIsFile(c)) return c;
  }
  return canonical;
}

/**
 * Resolve the Skill-23 scripts directory: env override → first existing of the
 * VPS then Mac skill-tree candidate → Mac default. Mirrors
 * src/app/api/departments/route.ts / persona-selector.ts.
 */
export function resolveSkillScriptsDir(): string {
  const override = process.env.OPENCLAW_SKILL23_SCRIPTS;
  if (override && override.trim()) return override;
  const macScripts = path.join(os.homedir(), '.openclaw', 'skills', SKILL23, 'scripts');
  const candidates = [path.join(VPS_SKILLS, SKILL23, 'scripts'), macScripts];
  for (const c of candidates) {
    if (safeIsDir(c)) return c;
  }
  return macScripts;
}

/** Absolute path to update-interview-state.sh (the --phase / --complete writer). */
export function updateInterviewStateScript(): string {
  return path.join(resolveSkillScriptsDir(), 'update-interview-state.sh');
}

/** Absolute path to record-dept-decision.sh (the provenanced decision writer). */
export function recordDeptDecisionScript(): string {
  return path.join(resolveSkillScriptsDir(), 'record-dept-decision.sh');
}

/** Absolute path to list-canonical-departments.py (the live floor printer). */
export function listCanonicalDepartmentsScript(): string {
  return path.join(resolveSkillScriptsDir(), 'list-canonical-departments.py');
}

/**
 * Absolute path to vertical-derivation-guard.py (U107 / E5-2, closes G2a) —
 * the independent auditor that asserts a vertical-specific department is
 * never provisioned unless the interview declared that vertical. Mirrors the
 * resolution used by listCanonicalDepartmentsScript() above.
 */
export function verticalDerivationGuardScript(): string {
  return path.join(resolveSkillScriptsDir(), 'vertical-derivation-guard.py');
}

/** True when the given script file is present (for 503/graceful-degrade paths). */
export function scriptExists(scriptPath: string): boolean {
  return safeIsFile(scriptPath);
}
