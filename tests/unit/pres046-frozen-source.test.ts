/**
 * pres046-frozen-source.test.ts — end-to-end fixture tests for the
 * PRES-046 frozen-source + manifest + receipt contract in atomic-deploy.sh,
 * using the same harness shape as b2-atomic-deploy.test.ts.
 *
 * Covered here (behavior, not just grep):
 *   F1  FROZEN-SOURCE VIOLATION: a build stub that MUTATES a compile-affecting
 *       input mid-build makes atomic-deploy.sh exit 2 with the live .next
 *       untouched, and the receipt names the frozen-source violation.
 *   F2  GOOD deploy writes build-inventory.json INTO the swapped .next
 *       (the manifest travels with the artifact).
 *   F3  HEALTH-FAIL rollback writes the transaction-bound receipt binding
 *       the failed target content to the pre-build inventory, and the receipt
 *       is consumed (cleared) by a subsequent GOOD deploy of the SAME content.
 *
 * Run: node --import tsx --test tests/unit/pres046-frozen-source.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'p046-fs-'));
}

function writeFixtureDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS fixture_marker (id INTEGER PRIMARY KEY)');
  } finally {
    db.close();
  }
}

function rmTmpDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

interface Fx { baseDir: string; appDir: string; binDir: string; healthStub: string; deploy: string; cleanup(): void; }

function buildFixture(opts: {
  npmBody: string;          // shell body executed when npm run build is invoked
  healthJson?: string;
  healthExitCode?: number;
  rollbackHealthExitCode?: number;
}): Fx {
  const { npmBody, healthJson = '{"green":true,"timestamp":"2026-06-10T00:00:00Z","checks":{}}', healthExitCode = 0, rollbackHealthExitCode = 0 } = opts;
  const baseDir = makeTmpDir();
  const appDir = path.join(baseDir, 'app');
  const binDir = path.join(baseDir, 'bin');
  const stubsDir = path.join(baseDir, 'stubs');
  mkdirSync(appDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stubsDir, { recursive: true });

  writeFixtureDb(path.join(appDir, 'mission-control.db'));

  // compile-affecting source input
  mkdirSync(path.join(appDir, 'src'), { recursive: true });
  writeFileSync(path.join(appDir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(appDir, 'package.json'), '{"name":"fixture","version":"1.0.0","build":"next build"}\n');

  // existing live .next
  mkdirSync(path.join(appDir, '.next'), { recursive: true });
  writeFileSync(path.join(appDir, '.next', 'BUILD_ID'), 'old-build-id');

  const npmStub = `#!/usr/bin/env bash
if [[ "$1" == "run" && "$2" == "build" ]]; then
  # cwd IS the app dir (atomic-deploy.sh cd's into APP_DIR before building).
  ${npmBody}
  if [[ -n "\${BUILD_EXIT_FILE:-}" ]]; then echo 0 > "$BUILD_EXIT_FILE"; fi
  exit 0
fi
exit 0
`;
  writeFileSync(path.join(binDir, 'npm'), npmStub, { mode: 0o755 });

  const pm2Stub = `#!/usr/bin/env bash
case "$1" in
  jlist) echo '[]' ;;
  list)  echo 'mission-control' ;;
  restart|reload|start|delete|stop) exit 0 ;;
  *) exit 0 ;;
esac
`;
  writeFileSync(path.join(binDir, 'pm2'), pm2Stub, { mode: 0o755 });
  writeFileSync(path.join(binDir, 'sqlite3'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(binDir, 'df'), '#!/usr/bin/env bash\necho "Filesystem 1K-blocks Used Available Use% Mounted on"\necho "/dev/sda1 20971520 1000000 10485760 10% /"\n', { mode: 0o755 });
  writeFileSync(path.join(binDir, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  // python3 stub: exactly the B.2 fixture shape (drain stdin) — PRES-046 must
  // not depend on python3 for hashing (that dependency broke this harness once).
  writeFileSync(path.join(binDir, 'python3'), '#!/usr/bin/env bash\ncat >/dev/null 2>&1 || true\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  const healthStubPath = path.join(stubsDir, 'cc-health-check.sh');
  const healthJsonEscaped = healthJson.replace(/'/g, "'\\''");
  const rollbackGreen = rollbackHealthExitCode === 0 ? 'true' : 'false';
  writeFileSync(healthStubPath, `#!/usr/bin/env bash
COUNTER_FILE="${baseDir}/.health-call-count"
COUNT=0
[[ -f "$COUNTER_FILE" ]] && COUNT=$(cat "$COUNTER_FILE")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"
if [[ "$COUNT" -eq 1 ]]; then
  echo '${healthJsonEscaped}'
  exit ${healthExitCode}
else
  echo '{"green":${rollbackGreen},"timestamp":"2026-06-10T00:00:00Z","checks":{}}'
  exit ${rollbackHealthExitCode}
fi
`, { mode: 0o755 });

  const deploy = path.join(process.cwd(), 'scripts', 'atomic-deploy.sh');
  return {
    baseDir, appDir, binDir, healthStub: healthStubPath, deploy,
    cleanup() { rmTmpDir(baseDir); },
  };
}

function runDeploy(fixture: Fx, extraEnv: Record<string, string> = {}): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(
    (() => { try { return execSync('which bash').toString().trim(); } catch { return '/opt/homebrew/bin/bash'; } })(),
    [fixture.deploy,
      '--app-dir', fixture.appDir,
      '--pm2-app', 'mission-control',
      '--port', '4000',
      '--disk-min-gb', '5',
      '--health-retries', '2',
      '--health-retry-wait', '0'],
    {
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
        HOME: fixture.baseDir,
        CC_HEALTH_CHECK_PATH: fixture.healthStub,
        ...extraEnv,
      },
      cwd: fixture.appDir,
      timeout: 60_000,
      encoding: 'utf8',
    },
  );
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('PRES-046 F1: input mutated during build → FROZEN-SOURCE VIOLATION, exit 2, live .next untouched', () => {
  const fixture = buildFixture({
    npmBody: `# mutate a compile-affecting input DURING the build (old mtime: content is the oracle)
printf 'export const a = 999;\\n' > "$PWD/src/a.ts"
touch -t 202001010000 "$PWD/src/a.ts"
if [[ -n "\${NEXT_DIST_DIR:-}" ]]; then mkdir -p "$NEXT_DIST_DIR"; echo "new-build-id" > "$NEXT_DIST_DIR/BUILD_ID"; fi
`,
  });
  try {
    const { exitCode, stderr } = runDeploy(fixture);
    assert.equal(exitCode, 2, `expected exit 2 (frozen-source pre-flight abort), got ${exitCode}\nstderr:\n${stderr}`);
    assert.ok(stderr.includes('FROZEN-SOURCE VIOLATION'), 'output must name the frozen-source violation');
    const liveBuildId = readFileSync(path.join(fixture.appDir, '.next', 'BUILD_ID'), 'utf8').trim();
    assert.equal(liveBuildId, 'old-build-id', 'live .next must remain the old build');
    assert.ok(!existsSync(path.join(fixture.appDir, '.next', 'build-inventory.json')), 'no manifest must land on the untouched live build');
  } finally {
    fixture.cleanup();
  }
});

test('PRES-046 F2: good deploy writes the immutable manifest INTO the swapped .next', () => {
  const fixture = buildFixture({
    npmBody: `if [[ -n "\${NEXT_DIST_DIR:-}" ]]; then mkdir -p "$NEXT_DIST_DIR"; echo "new-build-id" > "$NEXT_DIST_DIR/BUILD_ID"; fi
`,
  });
  try {
    const { exitCode, stderr } = runDeploy(fixture);
    assert.equal(exitCode, 0, `good deploy must exit 0\nstderr:\n${stderr}`);
    const manifestPath = path.join(fixture.appDir, '.next', 'build-inventory.json');
    assert.ok(existsSync(manifestPath), 'manifest must travel with the swapped artifact');
    const mf = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/,\s*}/g, '\n}')) as Record<string, string>;
    assert.ok((mf.inventory_digest ?? '').length >= 8, 'manifest carries inventory_digest');
    assert.ok((mf.inventory_inputs_digest ?? '').length >= 8, 'manifest carries inventory_inputs_digest');
    assert.equal(mf.build_id, 'new-build-id');
  } finally {
    fixture.cleanup();
  }
});

test('PRES-046 F3: health-fail rollback writes a binding receipt; matching redeploy clears it; non-matching does not', () => {
  // Step 1: good deploy #1 (content X) → manifest sealed with content X.
  const npmBody = `if [[ -n "\${NEXT_DIST_DIR:-}" ]]; then mkdir -p "$NEXT_DIST_DIR"; echo "new-build-id" > "$NEXT_DIST_DIR/BUILD_ID"; fi
`;
  const fixture = buildFixture({ npmBody, healthExitCode: 0 });
  try {
    const first = runDeploy(fixture);
    assert.equal(first.exitCode, 0, 'first deploy green');
    const mf1 = JSON.parse(readFileSync(path.join(fixture.appDir, '.next', 'build-inventory.json'), 'utf8')) as Record<string, string>;
    const invX = mf1.inventory_digest;

    // Step 2: change source to Y, deploy again with health failing → auto-rollback to X.
    // The rollback receipt must bind: rolled_back_to=X (served prior), failed_target=Y.
    writeFileSync(path.join(fixture.appDir, 'src', 'a.ts'), 'export const a = 2;\n');
    // capture content-Y inventory via the lib (same oracle the deploy uses)
    const invY = execFileSync('bash', [path.join(process.cwd(), 'scripts', 'lib', 'build-inventory.sh'), '--digest', fixture.appDir], { encoding: 'utf8' }).trim();
    const healthStubPath = fixture.healthStub;
    // Reset counter so the first call of the new deploy fails, second (rollback) passes:
    rmSync(path.join(fixture.baseDir, '.health-call-count'), { force: true });
    writeFileSync(healthStubPath, `#!/usr/bin/env bash
COUNTER_FILE="${fixture.baseDir}/.health-call-count"
COUNT=0
[[ -f "$COUNTER_FILE" ]] && COUNT=$(cat "$COUNTER_FILE")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"
if [[ "$COUNT" -eq 1 ]]; then
  echo '{"green":false,"timestamp":"2026-06-10T00:00:00Z","checks":{}}'
  exit 1
else
  echo '{"green":true,"timestamp":"2026-06-10T00:00:00Z","checks":{}}'
  exit 0
fi
`);
    const secondRun = runDeploy(fixture);
    assert.equal(secondRun.exitCode, 1, `health-failed deploy must exit 1 (rollback)\nstderr:\n${secondRun.stderr}`);
    const receiptPath = path.join(fixture.appDir, '.deploy-rollback-state.json');
    assert.ok(existsSync(receiptPath), 'rollback receipt must exist after health-fail rollback');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, string>;
    assert.equal(receipt.type, 'deploy-rollback');
    assert.equal(receipt.pending_repair, 'true');
    // served artifact after rollback = content X manifest; failed_target = content Y inventory.
    const servedMf = JSON.parse(readFileSync(path.join(fixture.appDir, '.next', 'build-inventory.json'), 'utf8')) as Record<string, string>;
    assert.equal(receipt.rolled_back_to_inventory_digest, servedMf.inventory_digest,
      'receipt must bind the SERVED prior artifact (cp-r preserved manifest)');
    assert.equal(receipt.failed_target_inventory_digest, invY,
      'receipt failed_target must be the content that failed health (Y)');
    assert.notEqual(receipt.rolled_back_to_inventory_digest, receipt.failed_target_inventory_digest,
      'prior and failed target must be distinct artifacts');

    // Step 3: redeploy with the source STILL at Y (repair) and health green →
    // the receipt CLEARS (matching failed-target content verified green).
    rmSync(path.join(fixture.baseDir, '.health-call-count'), { force: true });
    writeFileSync(healthStubPath, `#!/usr/bin/env bash
echo '{"green":true,"timestamp":"2026-06-10T00:00:00Z","checks":{}}'
exit 0
`);
    const thirdRun = runDeploy(fixture);
    assert.equal(thirdRun.exitCode, 0, 'repair deploy of failed-target content must exit 0');
    assert.ok(!existsSync(receiptPath), 'matching verified-green deploy CLEARS the matching rollback receipt');
    assert.ok(thirdRun.stderr.includes('Rollback receipt cleared'), 'clear message must name the receipt clearing');

    // Step 4 (non-matching target never clears): re-create a receipt naming a
    // DIFFERENT failed target, run a green deploy, receipt must SURVIVE.
    writeFileSync(
      path.join(fixture.appDir, '.deploy-rollback-state.json'),
      JSON.stringify({ ...receipt, failed_target_inventory_digest: 'deadbeefdeadbeef' }),
    );
    rmSync(path.join(fixture.baseDir, '.health-call-count'), { force: true });
    const fourthRun = runDeploy(fixture);
    assert.equal(fourthRun.exitCode, 0, 'green deploy still exits 0');
    assert.ok(existsSync(receiptPath), 'non-matching receipt is NOT cleared by an unrelated green deploy');
    assert.ok(fourthRun.stderr.includes('does not match this deploy'), 'supersede-loudly message present');
  } finally {
    fixture.cleanup();
  }
});
