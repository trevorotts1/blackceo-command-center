/** Explicit runtime isolation shared by dispatch and QC session evidence. */
import path from 'path';
import os from 'os';
import { detectPlatform } from '@/lib/platform';
export function resolveOpenClawRuntimeRoot(): string {
  if (process.env.OPENCLAW_ROOT !== undefined) {
    if (!process.env.OPENCLAW_ROOT || !path.isAbsolute(process.env.OPENCLAW_ROOT)) throw new Error('openclaw_runtime_root_invalid');
    return process.env.OPENCLAW_ROOT;
  }
  return detectPlatform() === 'vps-docker' ? '/data/.openclaw' : path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.openclaw');
}
