/**
 * Disk probe — reports free space on the vault volume and the operator
 * scratch volume. Threshold logic:
 *   - < 1 GiB free anywhere: degraded
 *   - < 5 GiB free anywhere: busy
 *   - otherwise: live
 *
 * Uses statfs (POSIX) where available. Falls back to `unknown` when the
 * volume cannot be inspected, rather than reporting a false `live`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

const statfsAsync = promisify(fs.statfs as unknown as (
  p: string,
  cb: (err: NodeJS.ErrnoException | null, stats: { bsize: number; blocks: number; bavail: number; bfree: number }) => void
) => void);

interface VolumeFree {
  path: string;
  freeBytes: number | null;
  totalBytes: number | null;
  error?: string;
}

async function inspectVolume(p: string): Promise<VolumeFree> {
  try {
    // Best-effort: walk up until we find an existing directory.
    let probe = p;
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) {
      probe = path.dirname(probe);
    }
    if (typeof fs.statfs !== 'function') {
      return { path: p, freeBytes: null, totalBytes: null, error: 'statfs not supported' };
    }
    const s = await statfsAsync(probe);
    return {
      path: p,
      freeBytes: s.bavail * s.bsize,
      totalBytes: s.blocks * s.bsize,
    };
  } catch (err) {
    return {
      path: p,
      freeBytes: null,
      totalBytes: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function probeDisk(): Promise<ProbeResult> {
  const start = Date.now();

  return withTimeout<ProbeResult>(
    async () => {
      const home = os.homedir();
      const vaultRoot = process.env.VAULT_ROOT || path.join(home, 'clawd');
      const scratchRoot = process.env.SCRATCH_ROOT || path.join(home, 'clawd', 'scratch');

      const [vault, scratch] = await Promise.all([
        inspectVolume(vaultRoot),
        inspectVolume(scratchRoot),
      ]);

      const samples = [vault, scratch].filter((v) => typeof v.freeBytes === 'number');
      let status: ProbeResult['status'] = 'live';
      let error: string | undefined;

      if (samples.length === 0) {
        status = 'unknown';
      } else {
        const minFree = Math.min(...samples.map((v) => v.freeBytes as number));
        const GiB = 1024 ** 3;
        if (minFree < 1 * GiB) {
          status = 'degraded';
          error = `low disk: ${(minFree / GiB).toFixed(2)} GiB free`;
        } else if (minFree < 5 * GiB) {
          status = 'busy';
        }
      }

      return {
        component: 'disk',
        label: 'Disk',
        status,
        latencyMs: Date.now() - start,
        error,
        detail: {
          vault,
          scratch,
        },
        probedAt: new Date().toISOString(),
      };
    },
    PROBE_TIMEOUT_MS,
    () => ({
      component: 'disk',
      label: 'Disk',
      status: 'unknown',
      latencyMs: Date.now() - start,
      error: 'probe timed out',
      probedAt: new Date().toISOString(),
    })
  );
}
