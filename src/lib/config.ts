/**
 * Server Configuration
 *
 * These values are environment-variable driven ONLY — Command Center's
 * runtime (dispatch, orchestration, QC scoring, job sweeps, etc.) reads
 * them exclusively from `process.env` on the server.
 *
 * HONESTY FIX (v4.63): this module used to also expose a localStorage-backed
 * `getConfig()`/`updateConfig()`/`resetConfig()` pair that the /settings page
 * read and wrote client-side, plus a client-side branch in each getter below
 * (`typeof window !== 'undefined' ? getConfig().x : process.env.X`). NO
 * server code path ever read that client-side value — every consumer of
 * `getMissionControlUrl()` / `getProjectsPath()` runs server-side (API
 * routes, dispatch, qc-scorer, job sweeps) and only ever hit the env-var
 * branch. So the Settings page's "Save" button silently lied: it wrote to
 * localStorage, the UI looked saved, and nothing on the server ever changed.
 * That dead mechanism (plus the `defaultProjectName` field, which had ZERO
 * consumers anywhere in the codebase) has been removed. To change one of
 * these values, set the corresponding env var and restart the server — see
 * /settings for the env-var reference.
 *
 * NEVER commit hardcoded IPs, paths, or sensitive data!
 */

/**
 * Get Command Center URL for API calls.
 * Used by orchestration, dispatch, and QC scoring modules.
 */
export function getMissionControlUrl(): string {
  return process.env.MISSION_CONTROL_URL || 'http://localhost:4000';
}

/**
 * Get workspace base path. Env-var driven; falls back to a sane default.
 */
export function getWorkspaceBasePath(): string {
  return process.env.WORKSPACE_BASE_PATH || '~/Documents/Shared';
}

/**
 * Get projects path. Env-var driven; falls back to a sane default.
 */
export function getProjectsPath(): string {
  return process.env.PROJECTS_PATH || '~/Documents/Shared/projects';
}

/**
 * Build project-specific path
 * @param projectName - Name of the project
 * @param subpath - Optional subpath within project (e.g., 'deliverables')
 */
export function getProjectPath(projectName: string, subpath?: string): string {
  const projectsPath = getProjectsPath();
  const base = `${projectsPath}/${projectName}`;
  return subpath ? `${base}/${subpath}` : base;
}

