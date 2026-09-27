/**
 * HEA-002 — the launchd leg of the Cloudflare Tunnel probe must read the PID
 * column, not just the label.
 *
 * DEFECT (src/lib/probes/cloudflare-tunnel-probe.ts, commit 15b174271): the
 * launchd fallback scanned `launchctl list` for a cloudflare-shaped LABEL in
 * the whole line, so a job that is merely LOADED (`-` in the PID column —
 * never started, or exited and not restarted) counted as "running outside
 * PM2" and the probe reported `live`.
 *
 * This suite drives the REAL probe against a PATH-shimmed `launchctl`/`pgrep`/
 * `pm2` so both rows can be exercised deterministically on any box:
 *   - fixture A: `-` in PID column  -> must NOT be live
 *   - fixture B: numeric PID column -> must be live
 *
 * Run: node --import tsx --test tests/unit/hea-002-launchd-pid-liveness.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LABEL = 'com.cloudflared.operator-gw';

/** Write `launchctl list` output with the given PID column value. */
function writeShims(pidColumn: string): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ltrn-hea2-launchd-'));
  const write = (name: string, body: string) => {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  };
  // No PM2 entry (normal launchd-managed Mac) — forces the launchd leg.
  write('pm2', '#!/bin/sh\necho "[]"\n');
  // No cloudflared process — isolates the launchd verdict from the pgrep leg.
  write('pgrep', '#!/bin/sh\nexit 1\n');
  write('launchctl', `#!/bin/sh\nprintf 'PID\\tStatus\\tLabel\\n${pidColumn}\\t0\\t${LABEL}\\n'\n`);
  return bin;
}

async function probeWith(pidColumn: string) {
  const bin = writeShims(pidColumn);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.OPENCLAW_PLATFORM = 'mac-mini';
  try {
    const probe = await import('../../src/lib/probes/cloudflare-tunnel-probe');
    return await probe.probeCloudflareTunnel();
  } finally {
    process.env.PATH = savedPath;
    delete process.env.OPENCLAW_PLATFORM;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

test('loaded-but-not-running launchd job ("-" PID) is NOT live', async () => {
  const result = await probeWith('-');
  assert.notEqual(
    result.status,
    'live',
    `a launchd job with "-" in the PID column is loaded, not running — probe said: ${result.status}`
  );
});

test('launchd job with a numeric PID IS live', async () => {
  const result = await probeWith('4242');
  assert.equal(result.status, 'live');
});
