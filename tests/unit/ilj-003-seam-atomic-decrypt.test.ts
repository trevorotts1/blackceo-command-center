import './_isolated-db';
/**
 * ilj-003-seam-atomic-decrypt.test.ts (ILJ-003)
 *
 * Pins:
 *   1. decrypt_failed is explicit — an `.enc` store that exists but no longer
 *      decrypts (key rotated under the data) surfaces `decrypt: 'decrypt_failed'`
 *      from readTranscriptText AND appendTranscriptTextAtomic, which writes
 *      nothing (no append over a blank slate).
 *   2. No lost update — N parallel worker PROCESSES appending distinct markers
 *      through appendTranscriptTextAtomic all survive (lock-serialized;
 *      genuinely parallel, not sequential awaits).
 *   3. Tail-merge is locked — a plaintext tail present alongside a valid `.enc`
 *      merges exactly once even under the locked path, and the tail is consumed.
 *   4. Backward compatible — readTranscriptText keeps its { text, path, exists }
 *      shape (decrypt is additive); plaintext-only stores still migrate + read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

process.env.MC_INTERVIEW_SECRET = 'ilj003-test-secret-do-not-use-in-prod';

import {
  _resetKeyCache,
  writeEncryptedFile,
} from '../../src/lib/interview/crypto';
import {
  readTranscriptText,
  appendTranscriptTextAtomic,
} from '../../src/lib/interview/seam';

function freshWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilj003-test-'));
  const ws = path.join(dir, 'ws');
  const discovery = path.join(ws, 'company-discovery');
  fs.mkdirSync(discovery, { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.workforce-build-state.json'),
    JSON.stringify({ interviewProgress: {} }),
  );
  process.env.OPENCLAW_WORKSPACE_ROOT = ws;
  _resetKeyCache();
  return ws;
}

function encPathOf(ws: string): string {
  return path.join(ws, 'company-discovery', 'workforce-interview-answers.md.enc');
}

function plainPathOf(ws: string): string {
  return path.join(ws, 'company-discovery', 'workforce-interview-answers.md');
}

test('decrypt failure surfaces decrypt_failed and appends nothing', () => {
  const ws = freshWorkspace();
  const enc = encPathOf(ws);
  writeEncryptedFile(enc, '**Q:** real answer\n');
  const before = fs.readFileSync(enc, 'utf-8');
  // Rotate the key under the data: the store exists but no longer decrypts.
  process.env.MC_INTERVIEW_SECRET = 'ilj003-different-key';
  _resetKeyCache();
  try {
    const read = readTranscriptText();
    assert.equal(read.decrypt, 'decrypt_failed');
    assert.equal(read.exists, false);
    const appended = appendTranscriptTextAtomic('**Q:** new\n**A:** lost?\n');
    assert.equal(appended.decrypt, 'decrypt_failed');
    assert.equal(
      fs.readFileSync(enc, 'utf-8'),
      before,
      'failed-decrypt append must not rewrite the store',
    );
  } finally {
    process.env.MC_INTERVIEW_SECRET = 'ilj003-test-secret-do-not-use-in-prod';
    _resetKeyCache();
  }
});

test('plaintext tail merges once and is consumed', () => {
  const ws = freshWorkspace();
  const enc = encPathOf(ws);
  writeEncryptedFile(enc, 'BASE');
  fs.writeFileSync(plainPathOf(ws), 'TAIL-CONTENT');
  const first = readTranscriptText();
  assert.equal(first.decrypt, 'ok');
  assert.ok(first.text.includes('BASE') && first.text.includes('TAIL-CONTENT'));
  assert.ok(!fs.existsSync(plainPathOf(ws)), 'tail consumed after locked merge');
  const second = readTranscriptText();
  assert.equal(second.text, first.text, 'second read is stable, no double-merge');
  assert.equal(second.text.split('TAIL-CONTENT').length - 1, 1);
});

test('parallel worker processes lose no answer', async () => {
  const ws = freshWorkspace();
  const enc = encPathOf(ws);
  writeEncryptedFile(enc, 'SEED\n');
  const N = 8;
  const markers = Array.from({ length: N }, (_, i) => `ILJ003-MARKER-${i}-FIXED`);
  const workerPath = path.resolve('tests/helpers/ilj003-atomic-worker.ts');
  // Genuinely concurrent: all N workers are SPAWNED (async, un-awaited) before
  // waiting on any, so their lock-held read-modify-write windows overlap in
  // wall-clock time. spawnSync would run them one-after-another and prove
  // nothing about the race — spawn + Promise.all proves the lock serializes.
  const runs = markers.map(
    (m) =>
      new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn('npx', ['tsx', workerPath, m], {
          cwd: process.cwd(),
          env: { ...process.env, OPENCLAW_WORKSPACE_ROOT: ws },
        });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ status: null, stderr: `${stderr}TIMEOUT` });
        }, 120_000);
        child.on('close', (status) => {
          clearTimeout(timer);
          resolve({ status, stderr });
        });
      }),
  );
  const procs = await Promise.all(runs);
  for (const [i, p] of procs.entries()) {
    assert.equal(p.status, 0, `worker ${i} failed: ${p.stderr.slice(0, 500)}`);
  }
  const final = readTranscriptText();
  assert.equal(final.decrypt, 'ok');
  for (const m of markers) {
    assert.equal(
      final.text.split(m).length - 1,
      1,
      `marker lost or duplicated: ${m}`,
    );
  }
});

test('plaintext-only store still migrates and reads (backward compatible)', () => {
  const ws = freshWorkspace();
  fs.writeFileSync(plainPathOf(ws), 'LEGACY-PLAINTEXT');
  const read = readTranscriptText();
  assert.equal(read.decrypt, 'ok');
  assert.equal(read.exists, true);
  assert.ok(read.text.includes('LEGACY-PLAINTEXT'));
});

test('empty workspace reports absent (backward compatible)', () => {
  freshWorkspace();
  const read = readTranscriptText();
  assert.equal(read.decrypt, 'absent');
  assert.equal(read.exists, false);
  assert.equal(read.text, '');
});
