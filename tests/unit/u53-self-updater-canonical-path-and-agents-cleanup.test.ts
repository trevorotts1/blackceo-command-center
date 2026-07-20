/**
 * U53 [HL/U68] — Self-updater: fix check-updates.sh canonical paths +
 * AGENTS.md cleanup; crown ONE executor (D12); prove the loop.
 *
 * Scope built here (D-HL-3 / D12 UNRATIFIED at build time — see the master
 * decisions register; only D2, D3, D5 are ratified — so step 3, "execute
 * D-HL-3's ratified routing," and step 4, the live operator-box proof run +
 * fleet roll, are correctly NOT executed by this unit and are deferred to a
 * future unit once D-HL-3 is ratified and an operator-box session is
 * available):
 *
 *   Step 1 — check-updates.sh's install-dir CANDIDATES list was ONLY the
 *   legacy layouts (`~/clawd/projects/blackceo-command-center`,
 *   `/data/clawd/projects/blackceo-command-center`, `~/blackceo-command-center`,
 *   `/data/blackceo-command-center`) and never honored a CC_APP_DIR override —
 *   unlike update.sh, which already lists the canonical
 *   `~/projects/command-center` / `/data/projects/command-center` layout
 *   FIRST and honors CC_APP_DIR (see tests/unit/p1-07-update-sh-install-dir.test.ts,
 *   the prior fix to update.sh alone). Consequence on every canonically
 *   installed box: INSTALL_DIR resolved empty -> LOCAL_VERSION empty ->
 *   HAS_UPDATE computed true whenever the GitHub fetch succeeded ->
 *   permanent false "update available" on the Sunday cron, and
 *   .last-update-check was never written. Fixed by mirroring
 *   update.sh:27-57 exactly.
 *
 *   Step 2 — update.sh's AGENTS.md flag cleanup was `grep -v "COMMAND CENTER
 *   UPDATE PENDING"`, which stripped only the HEADER line of a previous
 *   flag, leaving the prior section's body text (the "was updated from X to
 *   Y" line through the numbered steps through the "Backup of pre-update
 *   state:" line) orphaned in AGENTS.md forever, accumulating on every
 *   repeat update. Fixed to remove the entire section as one block
 *   (self-healing header-less legacy orphans too).
 *
 * These tests exercise the ACTUAL logic extracted from check-updates.sh and
 * update.sh (not a reimplementation) via shell fixture harnesses, following
 * the same extraction pattern as tests/unit/p1-07-update-sh-install-dir.test.ts.
 *
 * Run: node --import tsx --test tests/unit/u53-self-updater-canonical-path-and-agents-cleanup.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHECK_UPDATES_SH = path.join(REPO_ROOT, 'check-updates.sh');
const UPDATE_SH = path.join(REPO_ROOT, 'update.sh');
const CC_ORIGIN = 'https://github.com/trevorotts1/blackceo-command-center.git';

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'u53-self-updater-'));
}

/**
 * TRAP-2: check-updates.sh mirrors update.sh's install-dir validation, so its
 * fixtures must be REAL checkouts — a bare package.json is no longer a
 * Command Center install. Keep in sync with makeCheckout() in
 * tests/unit/p1-07-update-sh-install-dir.test.ts and with check-updates.sh's
 * CC_REQUIRED_MARKERS.
 */
function makeCheckout(dir: string, opts: { origin?: string; pkgName?: string; markers?: boolean } = {}): string {
  const origin = opts.origin ?? CC_ORIGIN;
  const pkgName = opts.pkgName ?? 'mission-control';
  const markers = opts.markers ?? true;
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'origin', origin);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName, version: '0.0.0' }, null, 2));
  if (markers) {
    writeFileSync(path.join(dir, 'next.config.mjs'), '');
    writeFileSync(path.join(dir, 'ecosystem.config.cjs'), '');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts', 'atomic-deploy.sh'), '');
    writeFileSync(path.join(dir, 'version'), '0.0.0\n');
  }
  return dir;
}

function readFile(p: string): string {
  return readFileSync(p, 'utf8');
}

// ------------------------------------------------------------------
// Step 1 — check-updates.sh canonical-path + CC_APP_DIR detection
// ------------------------------------------------------------------

/**
 * Extract JUST the install-dir detection block out of check-updates.sh (from
 * the "# Detect install location" comment through the end of the detection
 * for-loop's closing "fi") into a standalone script that echoes the
 * resolved INSTALL_DIR. Exercises the REAL logic living in check-updates.sh.
 */
function extractCheckUpdatesDetectionScript(contents: string): string {
  const startMarker = '# Detect install location';
  const endMarker = '# Detect platform';
  const startIdx = contents.indexOf(startMarker);
  const endIdx = contents.indexOf(endMarker);
  assert.ok(startIdx >= 0, 'extraction anchor "# Detect install location" not found in check-updates.sh — anchors drifted');
  assert.ok(endIdx >= 0, 'extraction anchor "# Detect platform" not found in check-updates.sh — anchors drifted');
  const block = contents.slice(startIdx, endIdx);
  // The block compares the candidate's origin remote against REPO_NAME, which
  // is assigned ABOVE the extraction anchor. Carry the REAL line over rather
  // than hardcoding it.
  const repoNameLine = contents.split('\n').find((l) => /^REPO_NAME=/.test(l));
  assert.ok(repoNameLine, 'REPO_NAME= assignment not found in check-updates.sh — anchors drifted');
  return [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    repoNameLine,
    block,
    'echo "RESOLVED:$INSTALL_DIR"',
    'echo "STATUS:$INSTALL_DIR_STATUS"',
  ].join('\n');
}

function runScript(script: string, env: NodeJS.ProcessEnv): { stdout: string; status: number | null } {
  const dir = makeTmpDir();
  const scriptPath = path.join(dir, 'run.sh');
  writeFileSync(scriptPath, script, { mode: 0o755 });
  const result = spawnSync('bash', [scriptPath], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { stdout: result.stdout, status: result.status };
}

test('U53(a): check-updates.sh CC_APP_DIR env override is honored, skipping autodetection', () => {
  const home = makeTmpDir();
  const override = makeTmpDir();
  makeCheckout(override);
  // A checkout the pin must BEAT: autodetection would find this one.
  makeCheckout(path.join(home, 'projects', 'command-center'));
  try {
    const script = extractCheckUpdatesDetectionScript(readFile(CHECK_UPDATES_SH));
    const { stdout, status } = runScript(script, { HOME: home, CC_APP_DIR: override });
    assert.equal(status, 0, `expected success, got: ${stdout}`);
    assert.match(stdout, new RegExp(`RESOLVED:${realpathSync(override)}$`, 'm'));
    assert.match(stdout, /^STATUS:pinned$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(override, { recursive: true, force: true });
  }
});

test('U53(a): check-updates.sh fallback autodetection finds the canonical ~/projects/command-center layout (the fix)', () => {
  const home = makeTmpDir();
  const canonical = path.join(home, 'projects', 'command-center');
  makeCheckout(canonical);
  try {
    const script = extractCheckUpdatesDetectionScript(readFile(CHECK_UPDATES_SH));
    const { stdout, status } = runScript(script, { HOME: home });
    assert.equal(status, 0, `expected success, got: ${stdout}`);
    assert.match(stdout, new RegExp(`RESOLVED:${realpathSync(canonical)}$`, 'm'));
    assert.match(stdout, /^STATUS:autodetected$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('U53(a): check-updates.sh still finds the legacy last-resort layout when nothing canonical exists (no regression)', () => {
  const home = makeTmpDir();
  const legacy = path.join(home, 'blackceo-command-center');
  makeCheckout(legacy);
  try {
    const script = extractCheckUpdatesDetectionScript(readFile(CHECK_UPDATES_SH));
    const { stdout, status } = runScript(script, { HOME: home });
    assert.equal(status, 0, `expected success, got: ${stdout}`);
    assert.match(stdout, new RegExp(`RESOLVED:${realpathSync(legacy)}$`, 'm'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('TRAP-2: check-updates.sh never reports against a non-git decoy', () => {
  // Same operator-Mac-mini shape as the update.sh test: the FIRST candidate
  // path exists but is a data directory, not a checkout.
  const home = makeTmpDir();
  const decoy = path.join(home, 'projects', 'command-center');
  mkdirSync(path.join(decoy, 'config'), { recursive: true });
  writeFileSync(path.join(decoy, 'package.json'), JSON.stringify({ name: 'mission-control' }));
  const real = makeCheckout(path.join(home, 'blackceo-command-center'));
  try {
    const script = extractCheckUpdatesDetectionScript(readFile(CHECK_UPDATES_SH));
    const { stdout, status } = runScript(script, { HOME: home });
    assert.equal(status, 0, `expected success, got: ${stdout}`);
    assert.match(stdout, new RegExp(`RESOLVED:${realpathSync(real)}$`, 'm'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('TRAP-2: check-updates.sh reports ambiguity instead of picking one — read-only, so status not exit code', () => {
  // check-updates.sh is READ-ONLY and its JSON feeds the Sunday cron agent, so
  // it cannot abort the way update.sh does. It must instead refuse to resolve
  // and say why, rather than silently reporting the wrong checkout's version.
  const home = makeTmpDir();
  makeCheckout(path.join(home, 'projects', 'command-center'));
  makeCheckout(path.join(home, 'blackceo-command-center'));
  try {
    const script = extractCheckUpdatesDetectionScript(readFile(CHECK_UPDATES_SH));
    const { stdout, status } = runScript(script, { HOME: home });
    assert.equal(status, 0, `expected the read-only script to still exit 0, got: ${stdout}`);
    assert.match(stdout, /^RESOLVED:$/m, `resolved a directory despite ambiguity: ${stdout}`);
    assert.match(stdout, /^STATUS:ambiguous$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('TRAP-2: check-updates.sh flags an invalid CC_APP_DIR pin instead of falling through', () => {
  const home = makeTmpDir();
  const decoy = makeTmpDir();
  writeFileSync(path.join(decoy, 'package.json'), '{}');
  makeCheckout(path.join(home, 'projects', 'command-center'));
  try {
    const script = extractCheckUpdatesDetectionScript(readFile(CHECK_UPDATES_SH));
    const { stdout, status } = runScript(script, { HOME: home, CC_APP_DIR: decoy });
    assert.equal(status, 0, `expected the read-only script to still exit 0, got: ${stdout}`);
    assert.match(stdout, /^RESOLVED:$/m, `fell through to autodetection: ${stdout}`);
    assert.match(stdout, /^STATUS:pin_invalid$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('TRAP-2: check-updates.sh emits parseable JSON carrying the install_dir status', () => {
  // The two new fields must survive into the JSON the cron agent parses.
  const home = makeTmpDir();
  makeCheckout(path.join(home, 'projects', 'command-center'));
  makeCheckout(path.join(home, 'blackceo-command-center'));
  const result = spawnSync('bash', [CHECK_UPDATES_SH], {
    env: { PATH: process.env.PATH, HOME: home },
    encoding: 'utf8',
  });
  try {
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.install_dir, '');
    assert.equal(parsed.install_dir_status, 'ambiguous');
    assert.match(parsed.install_dir_detail, /pin CC_APP_DIR/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('U53 FAIL-FIRST PROOF: the canonical layout does NOT resolve against the pre-fix CANDIDATES list', () => {
  // Reconstructs the ORIGINAL (pre-U53) check-updates.sh CANDIDATES list
  // verbatim and proves it does NOT find the canonical
  // ~/projects/command-center layout — the grounded defect this fix closes.
  const home = makeTmpDir();
  const canonical = path.join(home, 'projects', 'command-center');
  mkdirSync(canonical, { recursive: true });
  writeFileSync(path.join(canonical, 'package.json'), '{}');
  const preFixScript = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    'CANDIDATES=(',
    '  "$HOME/clawd/projects/blackceo-command-center"',
    '  "/data/clawd/projects/blackceo-command-center"',
    '  "$HOME/blackceo-command-center"',
    '  "/data/blackceo-command-center"',
    ')',
    'INSTALL_DIR=""',
    'for c in "${CANDIDATES[@]}"; do',
    '  if [ -d "$c" ] && [ -f "$c/package.json" ]; then',
    '    INSTALL_DIR="$c"',
    '    break',
    '  fi',
    'done',
    'echo "RESOLVED:$INSTALL_DIR"',
  ].join('\n');
  try {
    const { stdout, status } = runScript(preFixScript, { HOME: home });
    assert.equal(status, 0);
    assert.match(stdout, /^RESOLVED:$/m, `pre-fix CANDIDATES list unexpectedly resolved the canonical layout (bug not reproduced): ${stdout}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------
// Step 2 — update.sh AGENTS.md section cleanup (whole section, not just header)
// ------------------------------------------------------------------

/**
 * Extract JUST the AGENTS.md flag-cleanup block out of update.sh (from the
 * "# Remove old command-center flag" comment through the matching `mv`
 * line immediately after it) into a standalone script the test drives
 * directly against a fixture AGENTS.md.
 */
function extractAgentsCleanupScript(contents: string): string {
  const startMarker = '# Remove old command-center flag';
  const idx = contents.indexOf(startMarker);
  assert.ok(idx >= 0, 'extraction anchor "# Remove old command-center flag" not found in update.sh — anchors drifted');
  const afterStart = contents.slice(idx);
  const mvMarker = 'mv "$AGENTS_FILE.tmp" "$AGENTS_FILE"';
  const mvIdx = afterStart.indexOf(mvMarker);
  assert.ok(mvIdx >= 0, 'extraction anchor for the cleanup mv line not found in update.sh — anchors drifted');
  const mvLineEnd = afterStart.indexOf('\n', mvIdx);
  const block = afterStart.slice(0, mvLineEnd >= 0 ? mvLineEnd : undefined);
  return ['#!/usr/bin/env bash', 'set -uo pipefail', 'AGENTS_FILE="$1"', block].join('\n');
}

function countSections(agentsContents: string): number {
  return (agentsContents.match(/COMMAND CENTER UPDATE PENDING/g) || []).length;
}

function appendFlagSection(agentsFile: string, oldV: string, newV: string, backupDir: string): void {
  const section = `\n## \u{1F534} COMMAND CENTER UPDATE PENDING\n\nBlackCEO Command Center was updated from ${oldV} to ${newV} on 2026-07-15T00:00:00Z.\n\nRead \`/foo/CHANGELOG.md\` (top entry) and:\n1. Verify the app is running (curl http://localhost:4000/api/health or check pm2 status)\n2. Run any SQL migrations if the changelog mentions schema changes\n3. Tell the owner: "Command Center updated to ${newV}. [list any items that need owner action]"\n4. Remove this section from AGENTS.md when complete\n\nBackup of pre-update state: ${backupDir}\n`;
  writeFileSync(agentsFile, readFileSync(agentsFile, 'utf8') + section);
}

test('U53(b): cleanup removes the ENTIRE prior section (header through the backup line), not just the header', () => {
  const dir = makeTmpDir();
  const agentsFile = path.join(dir, 'AGENTS.md');
  writeFileSync(agentsFile, '# Pre-existing content\nThis line must survive.\n');
  appendFlagSection(agentsFile, 'v6.0.1', 'v6.0.2', '/some/backup/dir');
  try {
    const script = extractAgentsCleanupScript(readFile(UPDATE_SH));
    const scriptPath = path.join(dir, 'cleanup.sh');
    writeFileSync(scriptPath, script, { mode: 0o755 });
    const result = spawnSync('bash', [scriptPath, agentsFile], { encoding: 'utf8' });
    assert.equal(result.status, 0, `cleanup script failed: ${result.stderr}`);

    const finalContents = readFile(agentsFile);
    assert.equal(countSections(finalContents), 0, `expected the section fully removed, still present:\n${finalContents}`);
    assert.match(finalContents, /Pre-existing content/, 'unrelated pre-existing content must survive');
    assert.match(finalContents, /This line must survive\./, 'unrelated pre-existing content must survive');
    assert.doesNotMatch(finalContents, /BlackCEO Command Center was updated from/, 'orphaned body text must be gone, not just the header');
    assert.doesNotMatch(finalContents, /Backup of pre-update state:/, 'orphaned body text must be gone, not just the header');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('U53(c) — BINARY ACCEPTANCE: after TWO consecutive appends+cleanups, AGENTS.md contains exactly ONE section', () => {
  const dir = makeTmpDir();
  const agentsFile = path.join(dir, 'AGENTS.md');
  writeFileSync(agentsFile, '# Pre-existing content\n');
  try {
    const script = extractAgentsCleanupScript(readFile(UPDATE_SH));
    const scriptPath = path.join(dir, 'cleanup.sh');
    writeFileSync(scriptPath, script, { mode: 0o755 });

    // Run 1: simulate update.sh's real sequence — cleanup (no-op, nothing to
    // remove yet) then append.
    let result = spawnSync('bash', [scriptPath, agentsFile], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    appendFlagSection(agentsFile, 'v6.0.1', 'v6.0.2', '/backup/run1');
    assert.equal(countSections(readFile(agentsFile)), 1, 'expected exactly one section after run 1');

    // Run 2: cleanup (must remove run 1's section) then append again.
    result = spawnSync('bash', [scriptPath, agentsFile], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    appendFlagSection(agentsFile, 'v6.0.2', 'v6.0.3', '/backup/run2');

    const finalContents = readFile(agentsFile);
    assert.equal(countSections(finalContents), 1, `expected exactly ONE section after two consecutive runs (acceptance c), found ${countSections(finalContents)}:\n${finalContents}`);
    assert.match(finalContents, /v6\.0\.2 to v6\.0\.3/, 'the surviving section must be the SECOND (latest) run, not the stale first one');
    assert.doesNotMatch(finalContents, /v6\.0\.1 to v6\.0\.2/, 'the first run body must not have survived as an orphan');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('U53 FAIL-FIRST PROOF: the pre-fix `grep -v` header-only cleanup orphans the body across two runs', () => {
  const dir = makeTmpDir();
  const agentsFile = path.join(dir, 'AGENTS.md');
  writeFileSync(agentsFile, '# Pre-existing content\n');
  const preFixScript = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    'AGENTS_FILE="$1"',
    'grep -v "COMMAND CENTER UPDATE PENDING" "$AGENTS_FILE" > "$AGENTS_FILE.tmp" 2>/dev/null || true',
    'mv "$AGENTS_FILE.tmp" "$AGENTS_FILE" 2>/dev/null || true',
  ].join('\n');
  const scriptPath = path.join(dir, 'cleanup.sh');
  writeFileSync(scriptPath, preFixScript, { mode: 0o755 });
  try {
    spawnSync('bash', [scriptPath, agentsFile], { encoding: 'utf8' });
    appendFlagSection(agentsFile, 'v6.0.1', 'v6.0.2', '/backup/run1');
    spawnSync('bash', [scriptPath, agentsFile], { encoding: 'utf8' });
    appendFlagSection(agentsFile, 'v6.0.2', 'v6.0.3', '/backup/run2');

    const finalContents = readFile(agentsFile);
    // The bug: both bodies' text survive (only the headers were stripped),
    // proving the orphan-accumulation defect this unit fixes.
    assert.match(finalContents, /v6\.0\.1 to v6\.0\.2/, 'pre-fix cleanup unexpectedly removed the first run body (bug not reproduced)');
    assert.match(finalContents, /v6\.0\.2 to v6\.0\.3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
