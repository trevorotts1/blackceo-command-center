/**
 * B.1 Prerequisite Fixes — vitest/fixture coverage for P1–P4 (v4.34.0 bugs).
 *
 * PRD Addendum B, B.2 PREREQUISITE FIXES:
 *   P1  FALSE-FAIL: WRONG_MOUNT_PREFIXES=['/data'] + startsWith('/data/') rejects
 *       the canonical VPS app dir /data/mission-control → disk FAIL → deploy exit 1
 *       → auto-rollback, deterministically, on every VPS deploy.
 *       FIX: guard fires only when candidate === bare mount '/data' exactly.
 *       Truth-table row 35c: VPS at /data/<app>, DATABASE_PATH unset → disk PASS ok.
 *
 *   P2  FALSE-GREEN: outside-in asset probe finds no /_next/static ref → ASSET_PASS='skip'
 *       → skip ≠ fail → emitted pass=true.  A probe that verified nothing must not green.
 *       FIX: skip → FINAL_INDET=true (exit 3 UNKNOWN).
 *       Row: 'outside-in probe found no asset ref => UNKNOWN'.
 *
 *   P3  FALSE behaviour: HTTP 200 + non-JSON body from /api/health/deep → py() fallback
 *       returned 'false' for pass/indeterminate → exit 1 (definitive NOT-GREEN) when
 *       ambiguous.  Should be exit 3 UNKNOWN.
 *       Row added: 'HTTP 200 + non-JSON body from /api/health/deep => UNKNOWN'.
 *
 *   P4  VACUOUS CWD CHECK: deploy.sh called cc-health-check.sh without --canonical-dir,
 *       making pm2-analyze-cc.py receive no canonical_dir → cwd_ok always true (vacuous).
 *       FIX: deploy.sh passes --canonical-dir "$APP_DIR".
 *
 * P1 is exercised via vitest in deep-health.test.ts (rows 35c/35d/35b-updated).
 * P2/P3 are exercised here via shell fixture tests (Node built-in test runner).
 * P4 is exercised here via a structural assertion on deploy.sh source.
 *
 * Run: node --import tsx --test tests/unit/b1-prerequisite-fixes.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'b1-prereq-'));
}

function rmTmpDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const bashBin: string = (() => {
  try { return execSync('which bash').toString().trim(); } catch { return '/opt/homebrew/bin/bash'; }
})();

const CC_HEALTH_SCRIPT = path.join(process.cwd(), 'scripts', 'cc-health-check.sh');
const DEPLOY_SCRIPT = path.join(process.cwd(), 'scripts', 'deploy.sh');

// ─── Helper: build a minimal stub environment for cc-health-check.sh ────────
interface CcHealthStubConfig {
  /** HTTP code for /api/health/deep (default: 200) */
  deepHttpCode?: number;
  /** Body returned for /api/health/deep (default: valid JSON green) */
  deepBody?: string;
  /** HTML body returned for / (default: includes a /_next/static ref) */
  rootHtml?: string;
  /** Skip pm2 check entirely (default: true — avoids need for pm2 stub) */
  skipPm2?: boolean;
}

interface CcHealthStubFixture {
  baseDir: string;
  binDir: string;
  cleanup(): void;
}

function buildCcHealthStub(cfg: CcHealthStubConfig = {}): CcHealthStubFixture {
  const {
    deepHttpCode = 200,
    deepBody = '{"pass":true,"indeterminate":false,"checks":{}}',
    rootHtml = '<html><head></head><body><script src="/_next/static/chunks/main.js"></script></body></html>',
    skipPm2 = true,
  } = cfg;

  const baseDir = makeTmpDir();
  const binDir = path.join(baseDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  // ── stub python3 ────────────────────────────────────────────────────────────
  // Needs to parse JSON for py() calls in cc-health-check.sh.
  // We use the real python3 by NOT stubbing it — just ensure the real one is on PATH.

  // ── stub curl ─────────────────────────────────────────────────────────────
  // Respond to each URL differently based on arguments:
  //   /api/health/deep → deepHttpCode + deepBody
  //   / → 200 + rootHtml
  //   /_next/static/* → 200 + JS content
  const curlStub = `#!/usr/bin/env bash
# Stub curl for B.1 prerequisite fix tests
# Arguments: curl [options] URL
# Extract the URL (last non-flag arg) and the --write-out format if present.
URL=""
WRITE_OUT=""
HEAD_ONLY=0
for arg in "$@"; do
  case "$arg" in
    -w) WRITE_OUT_NEXT=1 ;;
    --write-out) WRITE_OUT_NEXT=1 ;;
    -I) HEAD_ONLY=1 ;;
    http://*) URL="$arg" ;;
    *) if [[ -n "\${WRITE_OUT_NEXT:-}" ]]; then WRITE_OUT="$arg"; WRITE_OUT_NEXT=""; fi ;;
  esac
done

emit_http_code() {
  local code="$1"
  if [[ "\$WRITE_OUT" == *"%{http_code}"* ]]; then
    printf '%s' "\$code"
  fi
}

if [[ "\$URL" == *"/api/health/deep"* ]]; then
  # Check if --write-out includes _http_code (the two-shot pattern)
  if [[ "\$WRITE_OUT" == *'{"_http_code":%{http_code}}'* ]]; then
    printf '%s\n{"_http_code":${deepHttpCode}}\n' '${deepBody.replace(/'/g, "'\\''").replace(/\n/g, '\\n')}'
  else
    printf '%s' '${deepBody.replace(/'/g, "'\\''")}'
    emit_http_code "${deepHttpCode}"
  fi
  exit 0
fi

if [[ "\$URL" == *"/_next/static/"* ]]; then
  if [[ "$HEAD_ONLY" -eq 1 ]]; then
    printf 'HTTP/1.1 200 OK\\r\\nContent-Type: application/javascript\\r\\n\\r\\n'
  else
    printf '/* js */\\n'
    emit_http_code "200"
  fi
  exit 0
fi

# Root URL /
if [[ "\$URL" == *"127.0.0.1"*"/" || "\$URL" == *"localhost"*"/" ]]; then
  printf '%s' '${rootHtml.replace(/'/g, "'\\''")}'
  emit_http_code "200"
  exit 0
fi

# Default: 200
emit_http_code "200"
exit 0
`;
  writeFileSync(path.join(binDir, 'curl'), curlStub, { mode: 0o755 });

  return { baseDir, binDir, cleanup() { rmTmpDir(baseDir); } };
}

function runCcHealthCheck(fixture: CcHealthStubFixture, extraArgs: string[] = [], extraEnv: Record<string, string> = {}): {
  exitCode: number; stdout: string; stderr: string;
} {
  const result = spawnSync(
    bashBin,
    [CC_HEALTH_SCRIPT, '--skip-pm2', '--port', '4000', ...extraArgs],
    {
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
        HOME: fixture.baseDir,
        ...extraEnv,
      },
      timeout: 30_000,
      encoding: 'utf8',
    },
  );
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ─── P2: outside-in probe found no asset ref => UNKNOWN ──────────────────────

test('P2: outside-in probe finds no /_next/static ref in root HTML → exit 3 UNKNOWN (never pass=true)', () => {
  // Root HTML has NO /_next/static reference — simulates an SPA shell or
  // a Next.js page that serves no static assets inline.
  const rootHtmlNoAssets = '<html><head></head><body><div id="root"></div></body></html>';

  const fixture = buildCcHealthStub({
    deepHttpCode: 200,
    deepBody: '{"pass":true,"indeterminate":false,"checks":{}}',
    rootHtml: rootHtmlNoAssets,
  });

  try {
    const { exitCode, stdout } = runCcHealthCheck(fixture);

    // Must exit 3 (UNKNOWN) — probe verified nothing, cannot confirm green
    assert.strictEqual(exitCode, 3,
      `P2: expected exit 3 (UNKNOWN, no asset ref found) but got exit ${exitCode}.\nstdout:\n${stdout}`);

    // Output must not claim pass=true
    if (stdout.trim()) {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(stdout.trim()); } catch { /* ok if not JSON */ }
      if (parsed) {
        assert.notStrictEqual(parsed.pass, true,
          `P2: pass must not be true when outside-in probe found no asset ref.\nstdout:\n${stdout}`);
      }
    }
  } finally {
    fixture.cleanup();
  }
});

test('P2 (baseline structural): when asset ref present, ASSET_INDET is NOT set — skip/pass/fail flow, not forced UNKNOWN', () => {
  // Structural: verify cc-health-check.sh only sets ASSET_INDET=true in the
  // "no asset ref found" branch, never in the "asset ref found" branch.
  // This ensures a working asset probe does not spuriously exit 3.
  const src = readFileSync(CC_HEALTH_SCRIPT, 'utf8');

  // The ASSET_INDET=true line must be inside the else branch (no ref found),
  // not in the if branch (ref found + asset checked).
  // Confirm: the script sets ASSET_INDET=true only when ASSET_REF is empty.
  // Pattern: 'if [[ -n "$ASSET_REF" ]]; then' ... 'else' ... ASSET_INDET=true
  const assetBlock = src.match(/# ── \(b2\) outside-in asset probe[\s\S]+?(?=# ── \(c\))/);
  const assetBlockSrc = assetBlock ? assetBlock[0] : src;

  // ASSET_INDET=true must appear after 'else' in the asset-ref check block
  const elseIdx = assetBlockSrc.lastIndexOf('\nelse\n');
  const assetIndetIdx = assetBlockSrc.indexOf('ASSET_INDET=true');
  assert.ok(
    elseIdx !== -1 && assetIndetIdx !== -1 && assetIndetIdx > elseIdx,
    `P2 baseline: ASSET_INDET=true must appear inside the 'else' (no-ref-found) branch, ` +
    `not in the if-branch (ref found). A successful asset probe must not force UNKNOWN.\n` +
    `else at: ${elseIdx}, ASSET_INDET at: ${assetIndetIdx}`
  );

  // The if-branch (when ASSET_REF found) must set ASSET_PASS to 'pass' or 'fail',
  // never ASSET_INDET=true
  const ifBranchEnd = elseIdx;
  const ifBranch = assetBlockSrc.slice(0, ifBranchEnd);
  assert.ok(
    !ifBranch.includes('ASSET_INDET=true'),
    `P2 baseline: ASSET_INDET=true must NOT appear in the 'if ASSET_REF found' branch`
  );
});

// ─── P3: HTTP 200 + non-JSON body from /api/health/deep => UNKNOWN ───────────

test('P3: /api/health/deep returns HTTP 200 + non-JSON HTML body → exit 3 UNKNOWN (not exit 1 definitive fail)', () => {
  // Simulate a proxy splash page or error page served as 200 with HTML body
  const htmlBody = '<!DOCTYPE html><html><head><title>Proxy</title></head><body><h1>Service Unavailable</h1></body></html>';

  const fixture = buildCcHealthStub({
    deepHttpCode: 200,
    deepBody: htmlBody,
    rootHtml: '<html><body><script src="/_next/static/chunks/main.js"></script></body></html>',
  });

  try {
    const { exitCode, stdout } = runCcHealthCheck(fixture);

    // Must exit 3 (UNKNOWN/indeterminate) — not exit 1 (definitive red)
    // Body is ambiguous (HTTP 200 but non-JSON) → cannot determine health
    assert.notStrictEqual(exitCode, 1,
      `P3: exit 1 (definitive NOT GREEN) must not fire on HTTP 200 + non-JSON body.\n` +
      `Expected exit 3 (UNKNOWN), got exit ${exitCode}.\nstdout:\n${stdout}`);
    assert.strictEqual(exitCode, 3,
      `P3: expected exit 3 (UNKNOWN for HTTP 200 + non-JSON body) but got exit ${exitCode}.\nstdout:\n${stdout}`);

    // Output must include indeterminate indicator
    if (stdout.trim()) {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(stdout.trim()); } catch { /* ok */ }
      if (parsed) {
        assert.notStrictEqual(parsed.pass, true,
          `P3: pass must not be true for HTTP 200 + non-JSON body.\nstdout:\n${stdout}`);
      }
    }
  } finally {
    fixture.cleanup();
  }
});

test('P3 (baseline structural): JSON validation only fires on HTTP 200 responses — 4xx paths are unaffected', () => {
  // Structural: confirm the P3 non-JSON guard is placed AFTER the HTTP 200 check
  // and before DEEP_PASS/DEEP_INDET parsing.  This ensures:
  //   - Non-200 responses still hit exit 1 (definitive red) as before.
  //   - Only HTTP 200 responses are subject to the JSON validation guard.
  const src = readFileSync(CC_HEALTH_SCRIPT, 'utf8');

  // The non-JSON guard must appear between the HTTP 200 check and the DEEP_PASS line.
  // Search for the actual guard code (python3 json.loads invocation), not the header comment.
  const http200CheckIdx = src.indexOf('if [[ "$HTTP_CODE" != "200" ]]; then');
  // The actual guard code: python3 json.loads invocation for the P3 check
  const nonJsonGuardIdx = src.indexOf("json.loads(sys.stdin.read())");
  const deepPassIdx = src.indexOf('DEEP_PASS=');

  assert.ok(http200CheckIdx !== -1, 'P3 baseline: HTTP 200 check block must exist');
  assert.ok(nonJsonGuardIdx !== -1, 'P3 baseline: P3 FIX non-JSON guard must exist in script');
  assert.ok(deepPassIdx !== -1, 'P3 baseline: DEEP_PASS= must exist');

  // Non-JSON guard must come AFTER the HTTP 200 check block
  assert.ok(
    nonJsonGuardIdx > http200CheckIdx,
    `P3 baseline: non-JSON guard must appear after HTTP 200 check ` +
    `(http200 at ${http200CheckIdx}, P3 guard at ${nonJsonGuardIdx})`
  );
  // Non-JSON guard must come BEFORE DEEP_PASS parsing
  assert.ok(
    nonJsonGuardIdx < deepPassIdx,
    `P3 baseline: non-JSON guard must appear before DEEP_PASS= parsing ` +
    `(P3 guard at ${nonJsonGuardIdx}, DEEP_PASS= at ${deepPassIdx})`
  );
});

// ─── P4: the deploy path passes --canonical-dir to cc-health-check.sh ─────────
// BUILD-04 (Wave-0) deprecated scripts/deploy.sh to a thin shim that FORWARDS to
// scripts/atomic-deploy.sh (which owns the non-vacuous canonical-dir health
// check end-to-end). The P4 guarantee therefore now lives in atomic-deploy.sh;
// deploy.sh's only job is to forward to it. This test asserts BOTH halves so the
// guarantee stays under test at its new home and the deprecation shim is real.
const ATOMIC_DEPLOY_SCRIPT = path.join(process.cwd(), 'scripts', 'atomic-deploy.sh');

test('P4 structural: the deploy path passes --canonical-dir to cc-health-check.sh (atomic-deploy)', () => {
  // Half 1: deploy.sh is the deprecated forwarder to atomic-deploy.sh.
  const deploySrc = readFileSync(DEPLOY_SCRIPT, 'utf8');
  assert.ok(
    deploySrc.includes('atomic-deploy.sh'),
    `P4/BUILD-04: deploy.sh must forward to atomic-deploy.sh (deprecation shim).`,
  );

  // Half 2: atomic-deploy.sh (the real deploy path) enforces the non-vacuous
  // canonical-dir health check against APP_DIR.
  const src = readFileSync(ATOMIC_DEPLOY_SCRIPT, 'utf8');
  assert.ok(
    src.includes('--canonical-dir') && src.includes('APP_DIR'),
    `P4: atomic-deploy.sh must pass --canonical-dir "$APP_DIR" to cc-health-check.sh.\n` +
    `This makes the pm2 cwd check non-vacuous (a real target for comparison).\n` +
    `Found: ${src.includes('--canonical-dir') ? '--canonical-dir present' : '--canonical-dir MISSING'}, ` +
    `APP_DIR: ${src.includes('APP_DIR') ? 'present' : 'MISSING'}`,
  );
});

test('P4 structural: cc-health-check.sh accepts --canonical-dir flag', () => {
  const src = readFileSync(CC_HEALTH_SCRIPT, 'utf8');
  assert.ok(
    src.includes('--canonical-dir'),
    `P4: cc-health-check.sh must accept --canonical-dir flag`
  );
});

// ─── P1 structural: resolveCheckPath uses exact-match only (not startsWith) ──

test('P1 structural: deep-checks.ts resolveCheckPath uses exact-match guard (not startsWith) in live code', () => {
  const deepChecksSrc = readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'health', 'deep-checks.ts'),
    'utf8',
  );

  // Extract only the resolveCheckPath function body (lines between 'export function resolveCheckPath' and its closing brace)
  const fnMatch = deepChecksSrc.match(/export function resolveCheckPath[\s\S]+?(?=\nexport |\nexport async |\n\/\/ ──)/);
  const fnBody = fnMatch ? fnMatch[0] : deepChecksSrc;

  // The function body must NOT contain startsWith(prefix + '/') as live code
  // (it may appear in surrounding JSDoc comments, but not in the function itself)
  assert.ok(
    !fnBody.includes("startsWith(prefix + '/')") ||
    // Allow it only if the occurrence is inside a comment (// or /* line)
    fnBody.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').indexOf("startsWith(prefix + '/') ") === -1,
    `P1: resolveCheckPath function body must NOT use startsWith(prefix + '/') as live code — ` +
    `this rejects valid app dirs under /data like /data/mission-control.\n` +
    `The guard must use exact match (candidate === prefix) only.`
  );

  // Must use exact match — isBareMountItself or equivalent
  assert.ok(
    deepChecksSrc.includes('candidate === prefix') || deepChecksSrc.includes('isBareMountItself'),
    `P1: resolveCheckPath must use exact-match guard (candidate === prefix)`
  );
});

test('P1 structural: cc-health-check.sh P1/P2/P3 fixes documented in header', () => {
  const src = readFileSync(CC_HEALTH_SCRIPT, 'utf8');
  assert.ok(src.includes('P2 FIX'), 'cc-health-check.sh must document P2 FIX');
  assert.ok(src.includes('P3 FIX'), 'cc-health-check.sh must document P3 FIX');
});

test('P1 structural: ASSET_INDET variable present in cc-health-check.sh (P2 fix mechanism)', () => {
  const src = readFileSync(CC_HEALTH_SCRIPT, 'utf8');
  assert.ok(
    src.includes('ASSET_INDET'),
    `P2: cc-health-check.sh must set ASSET_INDET=true when no asset ref found`
  );
  // Must check ASSET_INDET in verdict section
  assert.ok(
    src.includes('ASSET_INDET') && src.includes('FINAL_INDET'),
    `P2: ASSET_INDET must feed into FINAL_INDET in the verdict block`
  );
});
