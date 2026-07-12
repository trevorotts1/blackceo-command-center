/**
 * P1-08 (2026-07-11 spec) part (c) steps 2 and 4 —
 * scripts/cloudflare/setup-access-app.sh must provision BOTH Google (where
 * the account has it configured) and One-Time PIN, idempotently
 * (GET-check-then-create-only-missing), and must fall back loudly to
 * PIN-only when no Google IdP exists at the account level (spec Section 9,
 * decision D-3: "keep PIN as the automated default, add Google IdP at the
 * account level once, and let the updated script attach both").
 *
 * FAIL-FIRST: on the pre-fix tree, setup-access-app.sh (a) never sends
 * `allowed_idps` on Access App creation/update at all, and (b) always POSTs
 * a policy with `"require":[{"login_method":{"id":"onetimepin"}}]`, which
 * forces every allowed user through One-Time PIN specifically even when
 * Google is enabled on the account — the exact discrepancy the spec names.
 * Every scenario below reads the ACTUAL request bodies the script sent (via
 * a fixture curl stub's call log) and asserts on them directly, so these
 * tests fail against the pre-fix script and pass only once the fix lands.
 *
 * Run: node --import tsx --test tests/unit/p1-08-cf-access-google-pin.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── fixture plumbing ────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'p1-08-cf-'));
}

function resolveBash(): string {
  try { return execSync('which bash').toString().trim(); } catch { return '/opt/homebrew/bin/bash'; }
}

interface RouteFixture {
  method: string;
  urlContains: string;
  httpCode?: number;
  body: unknown;
}

interface CallLogEntry {
  method: string;
  url: string;
  data: string | null;
}

/**
 * Writes the curl-dispatch.py fixture server + a curl stub that forwards
 * every invocation to it. Real curl semantics are preserved exactly as
 * setup-access-app.sh's cf_call() uses them: `-o <file>` receives the
 * response body, `-w '%{http_code}'` is printed to stdout, and every raw
 * argv is appended (as JSON) to a call log file the test reads back to
 * inspect the EXACT request bodies the script sent.
 */
function buildFixture(routes: RouteFixture[]): {
  baseDir: string;
  binDir: string;
  callLogPath: string;
  cleanup(): void;
  readCallLog(): CallLogEntry[];
} {
  const baseDir = makeTmpDir();
  const binDir = path.join(baseDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const routesPath = path.join(baseDir, 'routes.json');
  writeFileSync(routesPath, JSON.stringify(routes));

  const callLogPath = path.join(baseDir, 'call-log.jsonl');
  writeFileSync(callLogPath, '');

  const dispatchPath = path.join(baseDir, 'curl-dispatch.py');
  writeFileSync(
    dispatchPath,
    `#!/usr/bin/env python3
import sys, os, json

def main():
    argv = sys.argv[1:]
    method = "GET"
    outfile = None
    url = None
    data = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "-X":
            i += 1; method = argv[i]
        elif a == "-o":
            i += 1; outfile = argv[i]
        elif a == "--data":
            i += 1; data = argv[i]
        elif a.startswith("http://") or a.startswith("https://"):
            url = a
        i += 1

    with open(os.environ["CF_FIXTURE_ROUTES"]) as f:
        routes = json.load(f)

    log_path = os.environ.get("CF_FIXTURE_CALL_LOG")
    if log_path:
        with open(log_path, "a") as f:
            f.write(json.dumps({"method": method, "url": url, "data": data}) + "\\n")

    # Pick the MOST SPECIFIC match (longest urlContains) among candidates —
    # substrings like "/apps/app-existing" also match
    # "/apps/app-existing/policies", so first-match-wins would silently pick
    # the wrong fixture route. Longest-match-wins makes route order in the
    # test irrelevant and disambiguates correctly.
    matched = None
    best_len = -1
    for r in routes:
        if r.get("method", "GET") != method:
            continue
        needle = r.get("urlContains", "")
        if needle and needle not in (url or ""):
            continue
        if len(needle) > best_len:
            matched = r
            best_len = len(needle)

    if matched is None:
        if outfile:
            with open(outfile, "w") as f:
                f.write(json.dumps({"success": False, "errors": [{"message": "no fixture route matched: %s %s" % (method, url)}]}))
        sys.stdout.write("404")
        return

    body = matched.get("body", "")
    if not isinstance(body, str):
        body = json.dumps(body)
    if outfile:
        with open(outfile, "w") as f:
            f.write(body)
    sys.stdout.write(str(matched.get("httpCode", 200)))

if __name__ == "__main__":
    main()
`,
    { mode: 0o755 }
  );

  writeFileSync(
    path.join(binDir, 'curl'),
    `#!/usr/bin/env bash\nexec python3 "\${CURL_DISPATCH_SCRIPT}" "$@"\n`,
    { mode: 0o755 }
  );

  return {
    baseDir,
    binDir,
    callLogPath,
    cleanup() {
      rmSync(baseDir, { recursive: true, force: true });
    },
    readCallLog(): CallLogEntry[] {
      const raw = readFileSync(callLogPath, 'utf8').trim();
      if (!raw) return [];
      return raw.split('\n').map((line) => JSON.parse(line) as CallLogEntry);
    },
    // expose for env wiring below
    ...({ dispatchPath, routesPath } as unknown as Record<string, never>),
  };
}

function runSetupScript(
  fixture: ReturnType<typeof buildFixture> & { dispatchPath?: string; routesPath?: string },
  args: string[]
): { exitCode: number; stdout: string; stderr: string } {
  const scriptPath = path.join(process.cwd(), 'scripts', 'cloudflare', 'setup-access-app.sh');
  const baseDir = fixture.baseDir;
  const result = spawnSync(
    resolveBash(),
    [scriptPath, ...args],
    {
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
        CLOUDFLARE_API_TOKEN: 'fixture-token',
        CLOUDFLARE_ACCOUNT_ID: 'fixture-account',
        CURL_DISPATCH_SCRIPT: path.join(baseDir, 'curl-dispatch.py'),
        CF_FIXTURE_ROUTES: path.join(baseDir, 'routes.json'),
        CF_FIXTURE_CALL_LOG: fixture.callLogPath,
      },
      timeout: 30_000,
      encoding: 'utf8',
    }
  );
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function findCall(log: CallLogEntry[], method: string, urlContains: string): CallLogEntry | undefined {
  return log.find((c) => c.method === method && (c.url ?? '').includes(urlContains));
}

function parseData(entry: CallLogEntry | undefined): any {
  if (!entry || !entry.data) return undefined;
  return JSON.parse(entry.data);
}

// ─── Scenario A: Google IdP present, NEW app → allowed_idps has both, no login_method require ──

test('P1-08 step 2/3 (a): Google IdP configured at account level, new app → allowed_idps=[otp,google], policy has NO login_method require', () => {
  const routes: RouteFixture[] = [
    {
      method: 'GET',
      urlContains: '/identity_providers',
      body: {
        success: true,
        result: [
          { id: 'otp-111', type: 'onetimepin', name: 'One-time PIN login' },
          { id: 'goog-222', type: 'google', name: 'Google Workspace' },
        ],
      },
    },
    { method: 'GET', urlContains: '/apps?per_page=1000', body: { success: true, result: [] } },
    {
      method: 'POST',
      urlContains: '/apps',
      body: { success: true, result: { id: 'app-333', aud: 'aud-444', domain: 'acme.zerohumanworkforce.com' } },
    },
    {
      method: 'GET',
      urlContains: '/apps/app-333',
      body: {
        success: true,
        result: { id: 'app-333', aud: 'aud-444', domain: 'acme.zerohumanworkforce.com', allowed_idps: ['otp-111', 'goog-222'] },
      },
    },
    { method: 'GET', urlContains: '/apps/app-333/policies', body: { success: true, result: [] } },
    { method: 'POST', urlContains: '/apps/app-333/policies', body: { success: true, result: { id: 'pol-555' } } },
  ];

  const fixture = buildFixture(routes) as any;
  try {
    const { exitCode, stdout, stderr } = runSetupScript(fixture, [
      'acme.zerohumanworkforce.com',
      'owner@acme.com',
    ]);
    assert.strictEqual(exitCode, 0, `Expected exit 0 but got ${exitCode}.\nstderr:\n${stderr}`);

    const log = fixture.readCallLog();

    // The app-creation POST body must include allowed_idps with BOTH ids.
    // Pre-fix: setup-access-app.sh never sends allowed_idps at all — this
    // assertion fails against the pre-fix script.
    const appCreateCall = findCall(log, 'POST', '/accounts/fixture-account/access/apps');
    assert.ok(appCreateCall, 'must POST to /apps to create the Access App');
    const appBody = parseData(appCreateCall);
    assert.ok(appBody, 'app creation call must carry a JSON body');
    assert.ok(Array.isArray(appBody.allowed_idps), 'app creation body must include an allowed_idps array');
    assert.ok(appBody.allowed_idps.includes('otp-111'), 'allowed_idps must include the One-Time PIN id');
    assert.ok(appBody.allowed_idps.includes('goog-222'), 'allowed_idps must include the Google id');

    // The policy POST body must NOT hardcode a login_method requirement.
    // Pre-fix: the policy body always contains
    // "require":[{"login_method":{"id":"onetimepin"}}] — this assertion
    // fails against the pre-fix script.
    const policyCall = findCall(log, 'POST', '/apps/app-333/policies');
    assert.ok(policyCall, 'must POST to /apps/app-333/policies to create the Allow policy');
    const policyBody = parseData(policyCall);
    assert.ok(policyBody, 'policy creation call must carry a JSON body');
    assert.strictEqual(
      JSON.stringify(policyBody).includes('login_method'),
      false,
      'policy body must not restrict login_method — login method is now enforced via the app allowed_idps',
    );
    assert.deepStrictEqual(
      policyBody.include,
      [{ email: { email: 'owner@acme.com' } }],
      'policy include must still list the supplied email(s)',
    );

    // Operator-facing summary must reflect both methods.
    assert.ok(stdout.includes('Google'), 'summary output must mention Google when it was attached');
  } finally {
    fixture.cleanup();
  }
});

// ─── Scenario B: no Google IdP at account level → loud fallback, PIN-only allowed_idps ──

test('P1-08 step 2 (b): NO Google IdP at account level → loud WARNING + D-3 reference, allowed_idps=[otp] only', () => {
  const routes: RouteFixture[] = [
    {
      method: 'GET',
      urlContains: '/identity_providers',
      body: { success: true, result: [{ id: 'otp-111', type: 'onetimepin', name: 'One-time PIN login' }] },
    },
    { method: 'GET', urlContains: '/apps?per_page=1000', body: { success: true, result: [] } },
    {
      method: 'POST',
      urlContains: '/apps',
      body: { success: true, result: { id: 'app-666', aud: 'aud-777', domain: 'noidp.zerohumanworkforce.com' } },
    },
    {
      method: 'GET',
      urlContains: '/apps/app-666',
      body: {
        success: true,
        result: { id: 'app-666', aud: 'aud-777', domain: 'noidp.zerohumanworkforce.com', allowed_idps: ['otp-111'] },
      },
    },
    { method: 'GET', urlContains: '/apps/app-666/policies', body: { success: true, result: [] } },
    { method: 'POST', urlContains: '/apps/app-666/policies', body: { success: true, result: { id: 'pol-888' } } },
  ];

  const fixture = buildFixture(routes) as any;
  try {
    const { exitCode, stdout, stderr } = runSetupScript(fixture, [
      'noidp.zerohumanworkforce.com',
      'owner@noidp.com',
    ]);
    assert.strictEqual(exitCode, 0, `Expected exit 0 but got ${exitCode}.\nstderr:\n${stderr}`);

    // Loud, specific fallback message. Pre-fix: this text does not exist
    // anywhere in the script at all — fails against the pre-fix script.
    assert.ok(stderr.includes('WARNING'), 'must print a WARNING when no Google IdP is configured');
    assert.ok(stderr.includes('Google'), 'WARNING must name Google specifically');
    assert.ok(stderr.includes('D-3'), 'WARNING must point at the Section 9 D-3 operator decision');

    const log = fixture.readCallLog();
    const appCreateCall = findCall(log, 'POST', '/accounts/fixture-account/access/apps');
    const appBody = parseData(appCreateCall);
    assert.ok(Array.isArray(appBody.allowed_idps), 'app creation body must include allowed_idps even in PIN-only mode');
    assert.deepStrictEqual(appBody.allowed_idps, ['otp-111'], 'allowed_idps must be PIN-only when Google is unavailable');

    assert.ok(
      stdout.includes('One-Time PIN only'),
      'operator summary must clearly state PIN-only when Google is unavailable',
    );
  } finally {
    fixture.cleanup();
  }
});

// ─── Scenario C: existing app missing Google, Google now available → attach (PUT) ──

test('P1-08 step 2b (c): existing app without Google + Google now available at account level → PUT attaches Google', () => {
  const routes: RouteFixture[] = [
    {
      method: 'GET',
      urlContains: '/identity_providers',
      body: {
        success: true,
        result: [
          { id: 'otp-111', type: 'onetimepin', name: 'One-time PIN login' },
          { id: 'goog-222', type: 'google', name: 'Google Workspace' },
        ],
      },
    },
    {
      method: 'GET',
      urlContains: '/apps?per_page=1000',
      body: {
        success: true,
        result: [{ id: 'app-existing', domain: 'existing.zerohumanworkforce.com' }],
      },
    },
    {
      method: 'GET',
      urlContains: '/apps/app-existing',
      body: {
        success: true,
        result: {
          id: 'app-existing',
          aud: 'aud-999',
          domain: 'existing.zerohumanworkforce.com',
          allowed_idps: ['otp-111'],
        },
      },
    },
    {
      method: 'PUT',
      urlContains: '/apps/app-existing',
      body: { success: true, result: { id: 'app-existing', aud: 'aud-999' } },
    },
    {
      method: 'GET',
      urlContains: '/apps/app-existing/policies',
      body: { success: true, result: [{ id: 'pol-existing', name: 'Allowed users' }] },
    },
  ];

  const fixture = buildFixture(routes) as any;
  try {
    const { exitCode, stderr } = runSetupScript(fixture, [
      'existing.zerohumanworkforce.com',
      'owner@existing.com',
    ]);
    assert.strictEqual(exitCode, 0, `Expected exit 0 but got ${exitCode}.\nstderr:\n${stderr}`);

    const log = fixture.readCallLog();

    // Pre-fix: the script never issues any PUT/PATCH to the app at all —
    // this call simply does not exist pre-fix, so this assertion fails
    // against the pre-fix script.
    const attachCall = log.find(
      (c) => c.method === 'PUT' && (c.url ?? '').includes('/apps/app-existing') && !(c.url ?? '').includes('policies'),
    );
    assert.ok(attachCall, 'must PUT /apps/app-existing to attach Google once it becomes available');
    const attachBody = parseData(attachCall);
    assert.ok(attachBody.allowed_idps.includes('goog-222'), 'the PUT body must add the Google id to allowed_idps');
    assert.ok(attachBody.allowed_idps.includes('otp-111'), 'the PUT body must retain the One-Time PIN id');

    assert.ok(
      stderr.includes('Attaching Google IdP to Access App app-existing'),
      'must log that it is attaching Google to the pre-existing app',
    );

    // The policy already existed ("Allowed users") — must be left alone,
    // no policy-creation POST issued.
    const policyCreateCall = log.find(
      (c) => c.method === 'POST' && (c.url ?? '').includes('/apps/app-existing/policies'),
    );
    assert.strictEqual(policyCreateCall, undefined, 'an existing policy must not be re-created');
  } finally {
    fixture.cleanup();
  }
});

// ─── Scenario D: existing app already has Google attached → idempotent no-op ──

test('P1-08 step 2b (d): existing app already has Google attached → no redundant PUT (idempotent)', () => {
  const routes: RouteFixture[] = [
    {
      method: 'GET',
      urlContains: '/identity_providers',
      body: {
        success: true,
        result: [
          { id: 'otp-111', type: 'onetimepin', name: 'One-time PIN login' },
          { id: 'goog-222', type: 'google', name: 'Google Workspace' },
        ],
      },
    },
    {
      method: 'GET',
      urlContains: '/apps?per_page=1000',
      body: { success: true, result: [{ id: 'app-full', domain: 'full.zerohumanworkforce.com' }] },
    },
    {
      method: 'GET',
      urlContains: '/apps/app-full',
      body: {
        success: true,
        result: {
          id: 'app-full',
          aud: 'aud-000',
          domain: 'full.zerohumanworkforce.com',
          allowed_idps: ['otp-111', 'goog-222'],
        },
      },
    },
    {
      method: 'GET',
      urlContains: '/apps/app-full/policies',
      body: { success: true, result: [{ id: 'pol-full', name: 'Allowed users' }] },
    },
  ];

  const fixture = buildFixture(routes) as any;
  try {
    const { exitCode, stderr } = runSetupScript(fixture, ['full.zerohumanworkforce.com', 'owner@full.com']);
    assert.strictEqual(exitCode, 0, `Expected exit 0 but got ${exitCode}.\nstderr:\n${stderr}`);

    const log = fixture.readCallLog();
    const attachCall = log.find(
      (c) => c.method === 'PUT' && (c.url ?? '').includes('/apps/app-full') && !(c.url ?? '').includes('policies'),
    );
    assert.strictEqual(attachCall, undefined, 'must NOT issue a redundant PUT when Google is already attached');
    assert.ok(stderr.includes('already has Google attached'), 'must log that no update was needed');
  } finally {
    fixture.cleanup();
  }
});

// ─── Scenario E: existing app, existing 'Allowed users' policy carries a stale
// login_method:onetimepin require clause, Google now available → the script must
// reconcile (PUT) the policy so the stale clause is gone. This is the exact
// discrepancy the P1-08 code comments describe: an app the OLD script
// provisioned kept the restrictive clause and Google login was rejected at
// policy eval even though Google is in allowed_idps.
//
// FAIL-FIRST: before this fix, the "policy already exists" branch always
// skipped entirely (POLICY_PRESENT=yes -> no PUT is ever issued to the
// policy). This test asserts a PUT to the policy IS issued and that its body
// no longer contains "login_method" -- it fails against the pre-reconciliation
// branch (no such PUT call exists in the log) and passes once the fix lands ──

test('P1-08 policy reconciliation: existing app + stale login_method:onetimepin policy + Google available → PUT removes the clause', () => {
  const routes: RouteFixture[] = [
    {
      method: 'GET',
      urlContains: '/identity_providers',
      body: {
        success: true,
        result: [
          { id: 'otp-111', type: 'onetimepin', name: 'One-time PIN login' },
          { id: 'goog-222', type: 'google', name: 'Google Workspace' },
        ],
      },
    },
    {
      method: 'GET',
      urlContains: '/apps?per_page=1000',
      body: { success: true, result: [{ id: 'app-stale', domain: 'stale.zerohumanworkforce.com' }] },
    },
    {
      method: 'GET',
      urlContains: '/apps/app-stale',
      body: {
        success: true,
        result: {
          id: 'app-stale',
          aud: 'aud-stale',
          domain: 'stale.zerohumanworkforce.com',
          // Already carries both IdPs (e.g. reconciled by a prior run of
          // Step 2b) so this scenario isolates the POLICY reconciliation
          // path specifically -- no Step 2b app PUT should fire here.
          allowed_idps: ['otp-111', 'goog-222'],
        },
      },
    },
    {
      method: 'GET',
      urlContains: '/apps/app-stale/policies',
      body: {
        success: true,
        result: [
          {
            id: 'pol-stale',
            name: 'Allowed users',
            decision: 'allow',
            include: [{ email: { email: 'owner@stale.com' } }],
            // The stale, over-restrictive clause the OLD (pre-P1-08) script
            // always attached -- this is what makes Google logins fail at
            // policy eval on apps that script provisioned.
            require: [{ login_method: { id: 'onetimepin' } }],
          },
        ],
      },
    },
    {
      method: 'PUT',
      urlContains: '/apps/app-stale/policies/pol-stale',
      body: { success: true, result: { id: 'pol-stale' } },
    },
  ];

  const fixture = buildFixture(routes) as any;
  try {
    const { exitCode, stderr } = runSetupScript(fixture, ['stale.zerohumanworkforce.com', 'owner@stale.com']);
    assert.strictEqual(exitCode, 0, `Expected exit 0 but got ${exitCode}.\nstderr:\n${stderr}`);

    const log = fixture.readCallLog();

    // No Step 2b app PUT expected -- allowed_idps already had both ids.
    const appAttachCall = log.find(
      (c) => c.method === 'PUT' && (c.url ?? '').includes('/apps/app-stale') && !(c.url ?? '').includes('policies'),
    );
    assert.strictEqual(appAttachCall, undefined, 'app already has both IdPs — Step 2b must not issue a redundant app PUT');

    // The policy reconciliation PUT must exist and must NOT carry login_method.
    // Pre-fix: this call does not exist at all (the branch skipped entirely on
    // POLICY_PRESENT=yes) — this assertion fails against the pre-fix/pre-
    // reconciliation script.
    const policyUpdateCall = log.find(
      (c) => c.method === 'PUT' && (c.url ?? '').includes('/apps/app-stale/policies/pol-stale'),
    );
    assert.ok(policyUpdateCall, 'must PUT /apps/app-stale/policies/pol-stale to reconcile the stale policy');
    const policyUpdateBody = parseData(policyUpdateCall);
    assert.ok(policyUpdateBody, 'policy update call must carry a JSON body');
    assert.strictEqual(
      JSON.stringify(policyUpdateBody).includes('login_method'),
      false,
      'reconciled policy body must not contain login_method — the stale require clause must be dropped',
    );
    // The email allow-list itself must survive the reconciliation.
    assert.deepStrictEqual(
      policyUpdateBody.include,
      [{ email: { email: 'owner@stale.com' } }],
      'reconciled policy must retain the existing include list',
    );

    assert.ok(
      stderr.includes('stale login_method:onetimepin require clause'),
      'must log that it detected and is removing the stale clause',
    );
  } finally {
    fixture.cleanup();
  }
});

// ─── Structural: the script file exists (behavioral proof lives in Scenario A/B/C/D above —
// per spec 2.4, correctness of the emitted request bodies is judged by executing the
// script and reading its ACTUAL runtime call log, never by grepping the script source) ──

test('P1-08 structural: setup-access-app.sh exists and is executable', () => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'cloudflare', 'setup-access-app.sh');
  assert.ok(existsSync(scriptPath), 'setup-access-app.sh must exist');
  const stat = require('node:fs').statSync(scriptPath);
  assert.ok((stat.mode & 0o111) !== 0, 'setup-access-app.sh must be executable');
});
