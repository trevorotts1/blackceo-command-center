/**
 * Unit tests — H-4: durable canonical box identity for OUTBOUND escalations.
 *
 * ── WHAT BROKE ────────────────────────────────────────────────────────────────
 * `resolveBoxName()` resolved `CC_BOX_NAME` -> `OPENCLAW_BOX_NAME` -> `os.hostname()`.
 * Nothing sets those two pins on a normally-provisioned box, so every Command
 * Center escalation in the fleet was attributed by HOSTNAME:
 *
 *   - raw machine names landed in the operator's escalation ledger instead of the
 *     canonical slug the standing gate keys on;
 *   - inside Docker `os.hostname()` is the short CONTAINER ID — opaque, and it
 *     changes on every container recreate;
 *   - several fleet boxes report the IDENTICAL default hostname, so two different
 *     clients wrote the same identity. Because that identity is also the
 *     receiver's per-client dedup / rate-limit key, a collision lets one box eat
 *     another box's escalation budget.
 *
 * ── THE FIX (two halves — this file proves both) ───────────────────────────────
 *   H-4a  src/lib/box-identity.ts — `FLEET_STANDING_BOX_SLUG` joins the pin chain
 *         AHEAD of the hostname fallback.
 *   H-4b  scripts/cc-start.sh — seeds `FLEET_STANDING_BOX_SLUG` into the launch
 *         env from the box's own OpenClaw env store when it is not already set.
 *
 * Either half alone is inert: the env var is real but never reaches the CC
 * process (the gateway exports `env.vars` only to processes IT spawns, and the CC
 * is started by pm2/launchd/atomic-deploy). So H-4b is tested by running the
 * ACTUAL shipped block extracted out of scripts/cc-start.sh — not a transcription
 * of it — against sandbox `openclaw.json` fixtures.
 *
 * No client name appears anywhere in this file: every fixture identity is a
 * synthetic `h4-test-*` value.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * No network, no DB, no writes outside os.tmpdir().
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { resolveBoxName, resolveBoxIdentity, UNKNOWN_BOX, slugify } from '@/lib/box-identity';

// ── env isolation ─────────────────────────────────────────────────────────────
// resolveBoxName() reads process.env at CALL time (deliberately — env can change
// under a long-lived Next.js server), so per-test mutation is sound. We still
// snapshot/restore so a failure cannot leak a pin into a sibling suite.
const IDENTITY_KEYS = ['CC_BOX_NAME', 'OPENCLAW_BOX_NAME', 'FLEET_STANDING_BOX_SLUG'] as const;

let saved: Record<string, string | undefined> = {};

function clearIdentityEnv(): void {
  for (const k of IDENTITY_KEYS) delete process.env[k];
}

describe('H-4a — resolveBoxName() precedence', () => {
  beforeEach(() => {
    saved = {};
    for (const k of IDENTITY_KEYS) saved[k] = process.env[k];
    clearIdentityEnv();
  });

  afterEach(() => {
    for (const k of IDENTITY_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // ── THE REGRESSION THIS FIX EXISTS FOR ─────────────────────────────────────
  // This is the mutation-proof case: revert box-identity.ts and this FAILS,
  // because resolveBoxName() goes back to returning os.hostname().
  it('prefers FLEET_STANDING_BOX_SLUG over the hostname fallback', () => {
    const host = os.hostname().trim();
    assert.ok(host, 'precondition: this machine has a hostname to fall back to');

    process.env.FLEET_STANDING_BOX_SLUG = 'h4-test-canonical-slug';

    const resolved = resolveBoxName();
    assert.equal(resolved, 'h4-test-canonical-slug');
    assert.notEqual(
      resolved,
      host,
      'REGRESSION: the canonical slug was present and the hostname still won',
    );
  });

  it('CC_BOX_NAME still outranks FLEET_STANDING_BOX_SLUG (H-1/H-3 pins stay authoritative)', () => {
    process.env.CC_BOX_NAME = 'h4-test-explicit-pin';
    process.env.FLEET_STANDING_BOX_SLUG = 'h4-test-canonical-slug';
    assert.equal(resolveBoxName(), 'h4-test-explicit-pin');
  });

  it('OPENCLAW_BOX_NAME still outranks FLEET_STANDING_BOX_SLUG', () => {
    process.env.OPENCLAW_BOX_NAME = 'h4-test-gateway-pin';
    process.env.FLEET_STANDING_BOX_SLUG = 'h4-test-canonical-slug';
    assert.equal(resolveBoxName(), 'h4-test-gateway-pin');
  });

  it('CC_BOX_NAME outranks OPENCLAW_BOX_NAME (pre-existing order unchanged)', () => {
    process.env.CC_BOX_NAME = 'h4-test-explicit-pin';
    process.env.OPENCLAW_BOX_NAME = 'h4-test-gateway-pin';
    assert.equal(resolveBoxName(), 'h4-test-explicit-pin');
  });

  // ── THE FALLBACK CHAIN MUST BE UNCHANGED WHEN THE SLUG IS ABSENT ───────────
  it('falls back to the hostname when no pin of any kind is set', () => {
    const host = os.hostname().trim();
    assert.ok(host, 'precondition: this machine has a hostname');
    assert.equal(resolveBoxName(), host);
  });

  it('treats a whitespace-only FLEET_STANDING_BOX_SLUG as unset (no blank identity)', () => {
    process.env.FLEET_STANDING_BOX_SLUG = '   ';
    assert.equal(resolveBoxName(), os.hostname().trim());
  });

  it('treats an empty FLEET_STANDING_BOX_SLUG as unset', () => {
    process.env.FLEET_STANDING_BOX_SLUG = '';
    assert.equal(resolveBoxName(), os.hostname().trim());
  });

  it('trims a padded FLEET_STANDING_BOX_SLUG rather than shipping the padding', () => {
    process.env.FLEET_STANDING_BOX_SLUG = '  h4-test-padded-slug  ';
    assert.equal(resolveBoxName(), 'h4-test-padded-slug');
  });

  it('never returns UNKNOWN_BOX while a hostname is available (fail-open preserved)', () => {
    assert.notEqual(resolveBoxName(), UNKNOWN_BOX);
  });

  it('the canonical slug flows into boxId — the receiver dedup / cap key', () => {
    process.env.FLEET_STANDING_BOX_SLUG = 'h4-test-canonical-slug';
    const identity = resolveBoxIdentity();
    assert.equal(identity.boxName, 'h4-test-canonical-slug');
    assert.ok(
      identity.boxId.endsWith(`:${slugify('h4-test-canonical-slug')}`),
      `boxId should be keyed on the canonical slug, got: ${identity.boxId}`,
    );
    assert.ok(
      !identity.boxId.includes(slugify(os.hostname())),
      'REGRESSION: the hostname is still leaking into the per-client cap key',
    );
  });
});

// ── H-4b — the cc-start.sh seed ───────────────────────────────────────────────
// Extracts the REAL shipped block (between its own section markers) out of
// scripts/cc-start.sh and executes it under `set -euo pipefail` against sandbox
// fixtures. Testing the extracted original — rather than a copy pasted into this
// file — is what makes this a regression test instead of a tautology.

const CC_START = path.resolve(process.cwd(), 'scripts/cc-start.sh');
const BEGIN_MARK = '# ── 1c. CANONICAL BOX-IDENTITY SEED (H-4)';
const END_MARK = '# ── 2. ORPHAN-PORT KILLER';

function extractSeedBlock(): string {
  const src = fs.readFileSync(CC_START, 'utf8');
  const begin = src.indexOf(BEGIN_MARK);
  assert.notEqual(begin, -1, `cc-start.sh no longer contains the marker: ${BEGIN_MARK}`);
  const end = src.indexOf(END_MARK, begin);
  assert.notEqual(end, -1, `cc-start.sh no longer contains the marker: ${END_MARK}`);
  return src.slice(begin, end);
}

interface SeedRun {
  status: number;
  stdout: string;
  stderr: string;
  /** The value the block left in FLEET_STANDING_BOX_SLUG ('' when it seeded nothing). */
  slug: string;
}

/**
 * Run the extracted block (plus optional extra bash lines) under a sandbox HOME
 * and report exit status + BOTH streams.
 *
 * spawnSync, not execFileSync: execFileSync discards stderr on a zero exit, and
 * the block's diagnostics — the evidence that the seed actually fired — are on
 * stderr precisely because stdout belongs to `next start`.
 *
 * `preset` (when given) is placed in the env first, so we can prove the block
 * never clobbers an explicit value.
 */
function runSeedBlock(
  homeDir: string | null,
  opts: { preset?: string; extra?: string[] } = {},
): SeedRun {
  const script = [
    'set -euo pipefail',
    homeDir === null ? 'unset HOME' : '',
    extractSeedBlock(),
    // Emit on fd 1 so the block's own diagnostics (fd 2) stay separately assertable.
    'printf "SEEDED=%s\\n" "${FLEET_STANDING_BOX_SLUG:-}"',
    ...(opts.extra ?? []),
  ]
    .filter(Boolean)
    .join('\n');

  // A DELIBERATELY MINIMAL env — not `...process.env`. The block has to survive
  // the sparse environment pm2/launchd actually hand it, so the test gives it one.
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (homeDir !== null) env.HOME = homeDir;
  if (opts.preset !== undefined) env.FLEET_STANDING_BOX_SLUG = opts.preset;

  const res = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
  });
  const stdout = res.stdout ?? '';
  return {
    status: res.status ?? 1,
    stdout,
    stderr: res.stderr ?? '',
    slug: (stdout.match(/^SEEDED=(.*)$/m)?.[1] ?? '').trim(),
  };
}

function makeSandbox(openclawJson: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h4-boxid-'));
  if (openclawJson !== null) {
    fs.mkdirSync(path.join(dir, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.openclaw', 'openclaw.json'), openclawJson);
  }
  return dir;
}

describe('H-4b — scripts/cc-start.sh canonical-slug seed', () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    while (sandboxes.length) {
      const d = sandboxes.pop()!;
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  function sandbox(json: string | null): string {
    const d = makeSandbox(json);
    sandboxes.push(d);
    return d;
  }

  // The block probes /data/.openclaw/openclaw.json (VPS) before $HOME (Mac). On a
  // machine that HAS the VPS path, the $HOME fixtures below would be shadowed —
  // so state that precondition instead of silently testing nothing.
  const VPS_PATH = '/data/.openclaw/openclaw.json';
  const vpsPathPresent = fs.existsSync(VPS_PATH);

  const SLUG_FIXTURE = JSON.stringify({
    env: { vars: { FLEET_STANDING_BOX_SLUG: 'h4-test-box-alpha' } },
  });

  // Mutation-proof for H-4b: delete the seed block and this FAILS.
  it('exports the canonical slug read out of openclaw.json -> env.vars', (t) => {
    if (vpsPathPresent) return t.skip(`${VPS_PATH} exists on this machine and shadows the fixture`);
    const out = runSeedBlock(sandbox(SLUG_FIXTURE));
    assert.equal(out.status, 0, `stderr: ${out.stderr}`);
    assert.equal(out.slug, 'h4-test-box-alpha');
    assert.match(out.stderr, /seeded FLEET_STANDING_BOX_SLUG=h4-test-box-alpha/);
  });

  it('NEVER clobbers a slug already present in the environment', (t) => {
    if (vpsPathPresent) return t.skip(`${VPS_PATH} exists on this machine and shadows the fixture`);
    const home = sandbox(
      JSON.stringify({ env: { vars: { FLEET_STANDING_BOX_SLUG: 'h4-test-from-store' } } }),
    );
    const out = runSeedBlock(home, { preset: 'h4-test-from-env' });
    assert.equal(out.status, 0, `stderr: ${out.stderr}`);
    assert.equal(out.slug, 'h4-test-from-env');
  });

  it('trims whitespace around the stored slug', (t) => {
    if (vpsPathPresent) return t.skip(`${VPS_PATH} exists on this machine and shadows the fixture`);
    const home = sandbox(
      JSON.stringify({ env: { vars: { FLEET_STANDING_BOX_SLUG: '  h4-test-padded  ' } } }),
    );
    assert.equal(runSeedBlock(home).slug, 'h4-test-padded');
  });

  // ── FAIL-OPEN: identity is metadata on an ALARM and must never block a boot ──
  it('FAIL-OPEN: no openclaw.json at all — exits 0, seeds nothing', () => {
    const out = runSeedBlock(sandbox(null));
    assert.equal(out.status, 0, `block must not abort the boot; stderr: ${out.stderr}`);
    assert.equal(out.slug, '');
  });

  it('FAIL-OPEN: corrupt openclaw.json — exits 0, seeds nothing', (t) => {
    if (vpsPathPresent) return t.skip(`${VPS_PATH} exists on this machine and shadows the fixture`);
    const out = runSeedBlock(sandbox('{ this is not valid json '));
    assert.equal(out.status, 0, `block must not abort the boot; stderr: ${out.stderr}`);
    assert.equal(out.slug, '');
  });

  it('FAIL-OPEN: openclaw.json present but env.vars has no slug — exits 0, seeds nothing', (t) => {
    if (vpsPathPresent) return t.skip(`${VPS_PATH} exists on this machine and shadows the fixture`);
    const out = runSeedBlock(sandbox(JSON.stringify({ env: { vars: { SOME_OTHER_KEY: 'x' } } })));
    assert.equal(out.status, 0, `block must not abort the boot; stderr: ${out.stderr}`);
    assert.equal(out.slug, '');
    assert.match(out.stderr, /no FLEET_STANDING_BOX_SLUG/);
  });

  it('FAIL-OPEN: openclaw.json with no env key at all — exits 0, seeds nothing', (t) => {
    if (vpsPathPresent) return t.skip(`${VPS_PATH} exists on this machine and shadows the fixture`);
    const out = runSeedBlock(sandbox(JSON.stringify({ agents: [] })));
    assert.equal(out.status, 0, `block must not abort the boot; stderr: ${out.stderr}`);
    assert.equal(out.slug, '');
  });

  it('FAIL-OPEN: env.vars slug is null — exits 0, seeds nothing', (t) => {
    if (vpsPathPresent) return t.skip(`${VPS_PATH} exists on this machine and shadows the fixture`);
    const out = runSeedBlock(
      sandbox(JSON.stringify({ env: { vars: { FLEET_STANDING_BOX_SLUG: null } } })),
    );
    assert.equal(out.status, 0, `block must not abort the boot; stderr: ${out.stderr}`);
    assert.equal(out.slug, '');
  });

  it('survives an UNSET HOME under `set -u` (pm2/launchd minimal env)', () => {
    const out = runSeedBlock(null);
    assert.equal(out.status, 0, `block must not abort the boot; stderr: ${out.stderr}`);
  });

  it('leaves no helper variables behind in the launch env', (t) => {
    if (vpsPathPresent) return t.skip(`${VPS_PATH} exists on this machine and shadows the fixture`);
    const out = runSeedBlock(sandbox(SLUG_FIXTURE), {
      extra: ['printf "LEAK=%s|%s|%s\\n" "${_cc_oc_json:-}" "${_cc_slug:-}" "${_cand:-}"'],
    });
    assert.equal(out.status, 0, `stderr: ${out.stderr}`);
    assert.match(out.stdout, /^LEAK=\|\|$/m);
  });

  it('cc-start.sh as a whole still parses (bash -n)', () => {
    execFileSync('bash', ['-n', CC_START], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
});
