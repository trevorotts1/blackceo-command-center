/**
 * A startup lock whose holder pid is ALIVE but is NOT a Command Center (pid
 * reuse: on a client box the pid had become the pm2 God Daemon) must be treated
 * as stale and taken over. A holder that IS a node process is honoured.
 */
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.DISABLE_STARTUP_LOCK;
delete process.env.VITEST;
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function loadLock() {
  const mod = await import('../../src/lib/startup-lock');
  return mod;
}

test('pid-reused holder (a live sleep, not a CC) is treated as stale and the lock is taken over', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lock-reuse-'));
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    writeFileSync(path.join(dir, 'mission-control.lock'), `${child.pid}\n`);
    const { claimStartupLock } = await loadLock();
    const got = claimStartupLock(dir);
    assert.equal(got, true, 'lock must be taken over from a non-CC holder');
    const now = readFileSync(path.join(dir, 'mission-control.lock'), 'utf8').trim();
    assert.equal(now, String(process.pid), 'lock now names this process');
  } finally {
    child.kill('SIGKILL');
    process.env.NODE_ENV = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bare node process (an MCP server, not a CC) holding the lock is treated as stale', async () => {
  // 2026-09-18: a Contabo box's lock named a pid reused by the GHL community
  // MCP server (/usr/local/bin/node .../mcp-servers/ghl-community-mcp/dist/main.js).
  // "node" appears in every such command line; it must not count as a CC.
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lock-mcp-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)', 'ghl-community-mcp/dist/main.js'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(path.join(dir, 'mission-control.lock'), `${child.pid}\n`);
    const { claimStartupLock } = await loadLock();
    const got = claimStartupLock(dir);
    assert.equal(got, true, 'a non-CC node process must not hold the Command Center lock');
    const now = readFileSync(path.join(dir, 'mission-control.lock'), 'utf8').trim();
    assert.equal(now, String(process.pid), 'lock now names this process');
  } finally {
    child.kill('SIGKILL');
    process.env.NODE_ENV = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live Next.js server holder is honoured: claim is denied', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lock-node-'));
  // The real CC command line carries "next" (node .../next/dist/bin/next start, or the
  // rewritten title "next-server (vX)"); the marker argument reproduces that.
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)', 'next-server-marker'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(path.join(dir, 'mission-control.lock'), `${child.pid}\n`);
    const { claimStartupLock } = await loadLock();
    const got = claimStartupLock(dir);
    assert.equal(got, false, 'a real Next.js server holding the lock must be honoured');
    const still = readFileSync(path.join(dir, 'mission-control.lock'), 'utf8').trim();
    assert.equal(still, String(child.pid), 'lock file untouched');
  } finally {
    child.kill('SIGKILL');
    process.env.NODE_ENV = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});
