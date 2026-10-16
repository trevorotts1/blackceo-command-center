/**
 * HEA-003 — the pgrep leg of the Cloudflare Tunnel probe must count the
 * tunnel SERVICE, not the `cloudflared access` client helpers.
 *
 * DEFECT (src/lib/probes/cloudflare-tunnel-probe.ts): the fallback ran
 * `pgrep -f cloudflared`, which matches the FULL argv of ANY process whose
 * command line contains that string. This operator box runs one long-lived
 * `cloudflared access ssh --hostname rescue-*` helper per client box (spawned
 * by ordinary `ssh rescue-*` use, PIDs 42132 / 94727 measured 2026-09-26), so
 * a box whose tunnel service is dead still read as `live`.
 *
 * This suite drives the REAL exported probe against a PATH-shimmed `pgrep`
 * that implements real `pgrep -f` semantics (ERE match against the fixture
 * argv, bare PIDs on stdout, exit 1 on no match), so both directions are
 * exercised deterministically on any box:
 *   - helpers only               -> NOT live
 *   - a real tunnel argv         -> live
 *   - helper + real tunnel mixed -> live (guards against overcorrecting into
 *     "any access helper proves nothing", which would hide a live tunnel)
 *
 * Run: node --import tsx --test tests/unit/hea-003-pgrep-tunnel-identity.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HELPER_A =
  '/opt/homebrew/bin/cloudflared access ssh --hostname rescue-a.zerohumanworkforce.com';
const HELPER_B =
  '/opt/homebrew/bin/cloudflared access tcp --hostname rescue-x.zerohumanworkforce.com --url localhost:2222';
const TUNNEL =
  '/opt/homebrew/bin/cloudflared tunnel --config /Users/x/.cloudflared/config-operator-gw.yml run 00000000-0000-4000-8000-000000000000';

/** Write shims; the pgrep shim implements `pgrep -f` over the fixture argv. */
function writeShims(fixtureArgvs: string[]): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ltrn-hea3-pgrep-'));
  const write = (name: string, body: string) => {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  };
  // No PM2 entry and no launchd job: the verdict comes from the pgrep leg alone.
  write('pm2', '#!/bin/sh\necho "[]"\n');
  write('launchctl', "#!/bin/sh\nprintf 'PID\\tStatus\\tLabel\\n'\n");
  const fixture = fixtureArgvs.map((argv, i) => `${1000 + i}|${argv}`).join('\n');
  write(
    'pgrep',
    `#!/bin/sh\npat=""\nif [ "$1" = "-f" ]; then pat="$2"; fi\nfound=0\nwhile IFS='|' read -r pid argv; do\n  [ -n "$pid" ] || continue\n  if printf '%s\\n' "$argv" | grep -Eq "$pat"; then printf '%s\\n' "$pid"; found=1; fi\ndone <<'FIXTURE'\n${fixture}\nFIXTURE\nif [ "$found" = 1 ]; then exit 0; fi\nexit 1\n`
  );
  return bin;
}

async function probeWith(fixtureArgvs: string[]) {
  const bin = writeShims(fixtureArgvs);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.OPENCLAW_PLATFORM = 'mac-mini';
  try {
    const probe = await import('../../src/lib/probes/cloudflare-tunnel-probe');
    return {
      evidence: await probe.launchdTunnelEvidence(),
      result: await probe.probeCloudflareTunnel(),
    };
  } finally {
    process.env.PATH = savedPath;
    delete process.env.OPENCLAW_PLATFORM;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

test('helpers only (access ssh / access tcp) are NOT a running tunnel', async () => {
  const { evidence, result } = await probeWith([HELPER_A, HELPER_B]);
  assert.equal(
    evidence.processRunning,
    false,
    'a `cloudflared access ssh` client helper is not the tunnel service'
  );
  assert.notEqual(result.status, 'live', `helpers only — probe said: ${result.status}`);
  assert.equal(result.status, 'offline');
});

test('a real tunnel argv still counts as a running tunnel', async () => {
  const { evidence, result } = await probeWith([TUNNEL]);
  assert.equal(evidence.processRunning, true);
  assert.equal(result.status, 'live');
  assert.equal((result.detail as Record<string, unknown>).source, 'launchd');
});

test('helper alongside a real tunnel is still live', async () => {
  const { evidence, result } = await probeWith([HELPER_A, TUNNEL]);
  assert.equal(evidence.processRunning, true);
  assert.equal(result.status, 'live');
});
