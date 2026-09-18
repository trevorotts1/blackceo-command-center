/**
 * cc-start-launcher-matrix.test.ts — maintained launcher acceptance gate.
 *
 * Runs the real scripts/cc-start.sh through the isolated seven-case matrix in
 * cc-start-launcher-matrix.fixture.sh. The fixture creates throwaway app trees,
 * stubs Node/next and port probes, proves launch state from a marker file, and
 * writes a dated JSON receipt for every case to a durable evidence directory that survives fixture cleanup.
 *
 * This wrapper keeps the matrix in npm run test:unit, so CI executes the real
 * launcher contract rather than only inspecting its source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'cc-start-launcher-matrix.fixture.sh');

test('cc-start real-launcher matrix holds all seven build-state contracts', () => {
  const result = spawnSync('bash', [fixture], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `launcher matrix failed:\n${output}`);
  assert.match(output, /ALL PASS/);
  const durable = output.match(/durable evidence directory: (\S+)/);
  assert.ok(durable, `durable evidence directory must be printed:\n${output}`);
  const evidenceDir = durable[1];
  assert.ok(existsSync(`${evidenceDir}/summary.json`), `summary receipt must exist after cleanup: ${evidenceDir}/summary.json`);
  const summary = JSON.parse(readFileSync(`${evidenceDir}/summary.json`, 'utf8'));
  assert.equal(summary.schema, 'cc-start-launcher-matrix-summary/1');
  assert.equal(summary.launcher_syntax_verified, true);
  assert.equal(summary.cases.length, 7);

  const expectedCases: Array<{ name: string; exitCode: number; launched: boolean; refusal: boolean }> = [
    { name: 'valid-manifest', exitCode: 0, launched: true, refusal: false },
    { name: 'missing-manifest', exitCode: 78, launched: false, refusal: true },
    { name: 'corrupt-manifest', exitCode: 78, launched: false, refusal: true },
    { name: 'mismatched-manifest-content', exitCode: 78, launched: false, refusal: true },
    { name: 'verifier-unavailable-fail-closed', exitCode: 78, launched: false, refusal: true },
    { name: 'legitimate-rollback-receipt', exitCode: 0, launched: true, refusal: false },
    { name: 'stale-rollback-receipt', exitCode: 78, launched: false, refusal: true },
  ];
  for (const expected of expectedCases) {
    const casePath = `${evidenceDir}/${expected.name}.json`;
    assert.ok(existsSync(casePath), `case receipt must exist after cleanup: ${casePath}`);
    const row = JSON.parse(readFileSync(casePath, 'utf8'));
    assert.equal(row.case, expected.name);
    assert.equal(row.exit_code, expected.exitCode);
    assert.equal(row.launched, expected.launched);
    if (expected.refusal) {
      assert.ok(existsSync(`${evidenceDir}/${expected.name}.refusal.json`), `refusal JSON must survive cleanup: ${evidenceDir}/${expected.name}.refusal.json`);
      const refusal = JSON.parse(readFileSync(`${evidenceDir}/${expected.name}.refusal.json`, 'utf8'));
      assert.equal(refusal.exit, 78);
      assert.deepEqual(row.refusal_receipt, refusal);
      assert.equal(row.refusal_receipt.exit, 78);
    } else {
      assert.equal(row.refusal_receipt, null);
      assert.equal(row.refusal_receipt_file, null);
    }
  }
});


test('cc-start verifier-exit regression fails against the historical masked-failure launcher and passes after restoration', () => {
  const source = path.join(here, '..', '..', 'scripts', 'cc-start.sh');
  const fixed = readFileSync(source, 'utf8');
  const fixedBlock = `  verify_rc=0\n  verify_json="$(bash "$inv_lib" --verify "$CC_DIR" 2>/dev/null)" || verify_rc=$?\n`;
  const historicalBugBlock = `  verify_json="$(bash "$inv_lib" --verify "$CC_DIR" 2>/dev/null)" || true\n  verify_rc=$?\n`;
  assert.ok(fixed.includes(fixedBlock), 'the fixed verifier-exit handling must remain present');

  const temp = mkdtempSync(path.join(os.tmpdir(), 'cc-start-verifier-exit-'));
  try {
    const buggy = fixed.replace(fixedBlock, historicalBugBlock, 1);
    assert.notEqual(buggy, fixed, 'the historical mutation must actually change the source');
    const buggyPath = path.join(temp, 'cc-start.sh');
    writeFileSync(buggyPath, buggy, { mode: 0o755 });

    const bugResult = spawnSync('bash', [fixture], {
      encoding: 'utf8',
      env: { ...process.env, CC_LAUNCHER_MATRIX_SCRIPT: buggyPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bugOutput = `${bugResult.stdout ?? ''}${bugResult.stderr ?? ''}`;
    assert.notEqual(bugResult.status, 0, 'the historical masked-failure launcher must fail the refusal matrix');
    assert.match(bugOutput, /FAIL: missing-manifest: expected exit 78, got 0/);
    assert.match(bugOutput, /FAIL: missing-manifest: durable refusal receipt is missing/);

    const fixedResult = spawnSync('bash', [fixture], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(fixedResult.status, 0, `the restored fixed launcher must pass the matrix: ${fixedResult.stdout ?? ''}${fixedResult.stderr ?? ''}`);
    assert.match(`${fixedResult.stdout ?? ''}${fixedResult.stderr ?? ''}`, /ALL PASS/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
