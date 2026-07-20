/**
 * Per-box runtime configuration.
 *
 * Runtime files intentionally keep their historical paths so every installer
 * and external Skill continues to work, but Git ignores them. Fresh installs
 * lazily copy a tracked *.example.json template before the first read/write.
 * update.sh performs the equivalent one-time migration for existing boxes.
 */

import fs from 'fs';
import path from 'path';

export type RuntimeConfigName =
  | 'company-config.json'
  | 'departments.json'
  | 'board-slas.json'
  | 'logo-config.json';

const PUBLIC_CONFIGS = new Set<RuntimeConfigName>(['logo-config.json']);

function configDirectory(name: RuntimeConfigName, root: string): string {
  return path.join(root, PUBLIC_CONFIGS.has(name) ? 'public' : 'config');
}

export function runtimeConfigPath(name: RuntimeConfigName, root = process.cwd()): string {
  return path.join(configDirectory(name, root), name);
}

export function runtimeConfigTemplatePath(name: RuntimeConfigName, root = process.cwd()): string {
  return path.join(configDirectory(name, root), name.replace(/\.json$/, '.example.json'));
}

/**
 * Return the ignored runtime path, generating it atomically from its tracked
 * template when absent. Concurrent first readers are safe: only one exclusive
 * temp-file creation wins, and every caller observes the final runtime file.
 */
export function ensureRuntimeConfigFile(name: RuntimeConfigName, root = process.cwd()): string {
  const runtimePath = runtimeConfigPath(name, root);
  if (fs.existsSync(runtimePath)) return runtimePath;

  const templatePath = runtimeConfigTemplatePath(name, root);
  if (!fs.existsSync(templatePath)) return runtimePath;

  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  const tmpPath = `${runtimePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.copyFileSync(templatePath, tmpPath, fs.constants.COPYFILE_EXCL);
    try {
      fs.linkSync(tmpPath, runtimePath);
    } catch (error) {
      // Another process may have won the first-use race.
      if (!fs.existsSync(runtimePath)) throw error;
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Removed after linking, or never created.
    }
  }
  return runtimePath;
}
