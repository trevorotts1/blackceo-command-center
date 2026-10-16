/**
 * B.4 (ported from the fleet's hand-applied hot fix, 2026-09-06 → main 2026-09-18):
 * pm2 ecosystem configs resolve DATABASE_PATH from the checkout's own .env.local
 * when the caller's shell did not export it, anchored on the config file's own
 * directory (never process.cwd()), so a restart from watchdog-cc.sh or
 * atomic-deploy never serves an empty decoy database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, mkdirSync, cpSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function loadConfigFrom(dir: string, file: string, envLocal: string | null): any {
  if (envLocal !== null) writeFileSync(path.join(dir, '.env.local'), envLocal);
  copyFileSync(path.join(process.cwd(), file), path.join(dir, file));
  // The configs resolve the Node runtime through scripts/lib/node-runtime.sh; ship it and pin CC_NODE_BIN.
  cpSync(path.join(process.cwd(), 'scripts', 'lib'), path.join(dir, 'scripts', 'lib'), { recursive: true });
  process.env.CC_NODE_BIN = process.execPath;
  const prev = process.env.DATABASE_PATH; delete process.env.DATABASE_PATH;
  try {
    const mod = require(path.join(dir, file));
    return mod;
  } finally {
    if (prev !== undefined) process.env.DATABASE_PATH = prev;
  }
}

for (const file of ['ecosystem.config.cjs', 'ecosystem.cc-prod.config.cjs']) {
  test(`${file}: DATABASE_PATH comes from the config dir's .env.local when the shell has none`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'eco-'));
    try {
      mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      const cfg = loadConfigFrom(dir, file, 'DATABASE_PATH="/srv/box/data/mission-control.db"\n');
      const app = cfg.apps[0];
      const got = app.env?.DATABASE_PATH ?? app.env_production?.DATABASE_PATH;
      assert.equal(got, '/srv/box/data/mission-control.db');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test(`${file}: a relative DATABASE_PATH in .env.local resolves against the config dir, not cwd`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'eco-'));
    try {
      mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      const cfg = loadConfigFrom(dir, file, 'DATABASE_PATH=./data/mc.db\n');
      const app = cfg.apps[0];
      const got = app.env?.DATABASE_PATH ?? app.env_production?.DATABASE_PATH;
      assert.equal(got, path.join(realpathSync(dir), 'data', 'mc.db'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
