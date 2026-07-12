/**
 * P1-08 (2026-07-11 spec) part (c) step 3 — end-to-end Cloudflare Access
 * login posture probe: scripts/cloudflare/probe-access-login.sh.
 *
 * FAIL-FIRST: scripts/cloudflare/probe-access-login.sh did not exist before
 * this unit's fix. Every test below invokes that exact path — on the
 * pre-fix tree spawnSync fails to exec it (status 127 / ENOENT), so every
 * assertion here fails pre-fix and passes only once the script exists with
 * the documented contract.
 *
 * The probe answers a narrower, security-posture question than
 * cc-health-check.sh's "is the app up" — "is Cloudflare Access actually
 * gating this hostname" — via a single unauthenticated request:
 *   - 3xx to an OFF-ORIGIN host             -> protected        (exit 0)
 *   - 200 (no gate at all)                  -> cc_unprotected   (exit 1)
 *   - 3xx to a SAME-ORIGIN path             -> unknown          (exit 3)
 *   - network error / timeout / ambiguous   -> unknown          (exit 3)
 *
 * Run: node --import tsx --test tests/unit/p1-08-access-login-probe.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'p1-08-probe-'));
}

function resolveBash(): string {
  try { return execSync('which bash').toString().trim(); } catch { return '/opt/homebrew/bin/bash'; }
}

/**
 * Writes a stub `curl` to `binDir` that answers ONLY the two request shapes
 * the probe script issues:
 *   1. The unauthenticated GET to https://<hostname>/  (no CF-Access-* headers)
 *   2. The optional service-token GET to https://<hostname>/api/health
 *      (carries CF-Access-Client-Id / CF-Access-Client-Secret headers)
 *
 * Both are distinguished by presence of `-H` `CF-Access-Client-Id:` in argv.
 * curl's real contract used by the probe: -o file (discarded, script never
 * reads a body) and -w '%{http_code} %{redirect_url}' printed to stdout.
 */
function writeCurlStub(
  binDir: string,
  cfg: {
    mainHttpCode: string; // e.g. "302", "200", "000", "500"
    mainRedirect?: string; // e.g. "https://team.cloudflareaccess.com/cdn-cgi/access/login/..."
    authHttpCode?: string; // response for the service-token /api/health probe
  }
): void {
  const { mainHttpCode, mainRedirect = '', authHttpCode = '200' } = cfg;
  const stub = `#!/usr/bin/env bash
# Stub curl for P1-08 probe-access-login.sh fixture tests.
is_auth_probe=0
for a in "$@"; do
  if [[ "$a" == "CF-Access-Client-Id: "* ]]; then
    is_auth_probe=1
  fi
done
if [[ "$is_auth_probe" -eq 1 ]]; then
  printf '%s' "${authHttpCode}"
else
  printf '%s %s' "${mainHttpCode}" "${mainRedirect}"
fi
`;
  writeFileSync(path.join(binDir, 'curl'), stub, { mode: 0o755 });
}

function runProbe(
  binDir: string,
  args: string[]
): { exitCode: number; stdout: string; stderr: string } {
  const scriptPath = path.join(process.cwd(), 'scripts', 'cloudflare', 'probe-access-login.sh');
  const result = spawnSync(resolveBash(), [scriptPath, ...args], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    timeout: 30_000,
    encoding: 'utf8',
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ─── Structural: the script exists and is executable ────────────────────────

test('P1-08 step 3 structural: probe-access-login.sh exists and is executable', () => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'cloudflare', 'probe-access-login.sh');
  assert.ok(existsSync(scriptPath), 'scripts/cloudflare/probe-access-login.sh must exist');
  const stat = require('node:fs').statSync(scriptPath);
  assert.ok((stat.mode & 0o111) !== 0, 'probe-access-login.sh must be executable');
});

test('P1-08 step 3 structural: never logs a raw secret value, only uses it as a header', () => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'cloudflare', 'probe-access-login.sh');
  const src = readFileSync(scriptPath, 'utf8');
  assert.ok(
    src.includes('CF-Access-Client-Secret'),
    'must send the service token secret as the CF-Access-Client-Secret header',
  );
  // The log() calls must never interpolate SERVICE_TOKEN_SECRET directly.
  const logLines = src.split('\n').filter((l) => l.includes('log "'));
  for (const line of logLines) {
    assert.ok(
      !line.includes('SERVICE_TOKEN_SECRET'),
      `log line must never echo the raw service token secret: ${line}`,
    );
  }
});

// ─── Scenario 1: off-origin 302 → protected, exit 0 ─────────────────────────

test('P1-08 step 3 (a): unauthenticated 302 to an OFF-ORIGIN Access login page → protected, exit 0', () => {
  const binDir = makeTmpDir();
  try {
    writeCurlStub(binDir, {
      mainHttpCode: '302',
      mainRedirect: 'https://myteam.cloudflareaccess.com/cdn-cgi/access/login/acme.zerohumanworkforce.com',
    });
    const { exitCode, stdout, stderr } = runProbe(binDir, ['acme.zerohumanworkforce.com']);

    assert.strictEqual(exitCode, 0, `Expected exit 0 (protected) but got ${exitCode}.\nstderr:\n${stderr}`);

    const json = JSON.parse(stdout.trim());
    assert.strictEqual(json.status, 'protected');
    assert.strictEqual(json.hostname, 'acme.zerohumanworkforce.com');
    assert.strictEqual(json.unauthenticated_http_code, 302);
    assert.ok(
      json.redirect_target.includes('cloudflareaccess.com'),
      'redirect_target must be recorded in the JSON verdict',
    );
    assert.strictEqual(json.service_token_probed, false, 'no service token was supplied');
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

// ─── Scenario 2: 200 unauthenticated → cc_unprotected, exit 1 ───────────────

test('P1-08 step 3 (b): unauthenticated 200 (no Access app) → cc_unprotected, exit 1', () => {
  const binDir = makeTmpDir();
  try {
    writeCurlStub(binDir, { mainHttpCode: '200' });
    const { exitCode, stdout, stderr } = runProbe(binDir, ['unprotected.zerohumanworkforce.com']);

    assert.strictEqual(exitCode, 1, `Expected exit 1 (cc_unprotected) but got ${exitCode}.\nstderr:\n${stderr}`);

    const json = JSON.parse(stdout.trim());
    assert.strictEqual(json.status, 'cc_unprotected');
    assert.strictEqual(json.unauthenticated_http_code, 200);
    assert.ok(
      stderr.includes('cc_unprotected'),
      'stderr must name the cc_unprotected verdict so it is flagged to the operator lane',
    );
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

// ─── Scenario 3: network error → unknown, exit 3 ────────────────────────────

test('P1-08 step 3 (c): network error / timeout (HTTP 000) → unknown, exit 3', () => {
  const binDir = makeTmpDir();
  try {
    writeCurlStub(binDir, { mainHttpCode: '000' });
    const { exitCode, stdout } = runProbe(binDir, ['unreachable.zerohumanworkforce.com']);

    assert.strictEqual(exitCode, 3, `Expected exit 3 (unknown) but got ${exitCode}`);
    const json = JSON.parse(stdout.trim());
    assert.strictEqual(json.status, 'unknown');
    assert.strictEqual(json.unauthenticated_http_code, null);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

// ─── Scenario 4: same-origin redirect → unknown, exit 3 (not silently trusted) ──

test('P1-08 step 3 (d): 302 to a SAME-ORIGIN path (e.g. in-app redirect) → unknown, exit 3, NOT protected', () => {
  const binDir = makeTmpDir();
  try {
    writeCurlStub(binDir, {
      mainHttpCode: '302',
      mainRedirect: 'https://plain.zerohumanworkforce.com/interview',
    });
    const { exitCode, stdout } = runProbe(binDir, ['plain.zerohumanworkforce.com']);

    assert.strictEqual(exitCode, 3, `Expected exit 3 (unknown, not confirmed protected) but got ${exitCode}`);
    const json = JSON.parse(stdout.trim());
    assert.strictEqual(json.status, 'unknown');
    assert.notStrictEqual(json.status, 'protected', 'a same-origin redirect must never be reported as protected');
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

// ─── Scenario 5: protected + service token supplied + reachable ────────────

test('P1-08 step 3 (e): protected + service token supplied + /api/health reachable → service_token_reachable true, still exit 0', () => {
  const binDir = makeTmpDir();
  try {
    writeCurlStub(binDir, {
      mainHttpCode: '302',
      mainRedirect: 'https://myteam.cloudflareaccess.com/cdn-cgi/access/login/svc.zerohumanworkforce.com',
      authHttpCode: '200',
    });
    const { exitCode, stdout } = runProbe(binDir, [
      'svc.zerohumanworkforce.com',
      'fake-service-token-id',
      'fake-service-token-secret',
    ]);

    assert.strictEqual(exitCode, 0, 'a reachable authenticated probe must not change the protected verdict');
    const json = JSON.parse(stdout.trim());
    assert.strictEqual(json.status, 'protected');
    assert.strictEqual(json.service_token_probed, true);
    assert.strictEqual(json.service_token_reachable, true);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

// ─── Scenario 6: usage error ────────────────────────────────────────────────

test('P1-08 step 3 (f): no hostname argument → usage error, exit 2', () => {
  const binDir = makeTmpDir();
  try {
    writeCurlStub(binDir, { mainHttpCode: '200' });
    const { exitCode, stderr } = runProbe(binDir, []);
    assert.strictEqual(exitCode, 2, 'missing hostname argument must exit 2 (usage error)');
    assert.ok(stderr.toLowerCase().includes('usage'), 'must print a usage message');
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});
