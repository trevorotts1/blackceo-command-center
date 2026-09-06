import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = path.resolve('scripts/next-service-env.cjs');
const nextEnv = require.resolve('@next/env');
function fixture(run: (directory: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-literal-env-'));
  try { run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function child(directory: string, extra: Record<string, string>, source: string) {
  return spawnSync(process.execPath, ['-e', source, helper, nextEnv, directory], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', ...extra }, encoding: 'utf8',
  });
}

test('actual Next loader preserves inherited literal dollars exactly once', () => fixture(directory => {
  fs.writeFileSync(path.join(directory, '.env.local'), "DATABASE_PATH='/tmp/fixture\\$ROOT/#db.sqlite'\nMC_API_TOKEN='fixture\\${ROOT}'\nMC_COMPANY_ID='own'\n");
  const result = child(directory, {
    ROOT: 'MUST_NOT_EXPAND', DATABASE_PATH: '/tmp/fixture$ROOT/#db.sqlite', MC_API_TOKEN: 'fixture${ROOT}',
    MC_COMPANY_ID: 'own', UNMANAGED: '$ROOT',
  }, `
    const prepare = require(process.argv[1]).prepareNextEnvironment;
    prepare(process.argv[3]); prepare(process.argv[3]);
    require(process.argv[2]).loadEnvConfig(process.argv[3], false);
    process.stdout.write(JSON.stringify(['DATABASE_PATH','MC_API_TOKEN','MC_COMPANY_ID','UNMANAGED'].map(k => process.env[k])));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['/tmp/fixture$ROOT/#db.sqlite', 'fixture${ROOT}', 'own', '$ROOT']);
}));

test('layered dollar bindings fail before modifying environment or disclosing values', () => fixture(directory => {
  fs.writeFileSync(path.join(directory, '.env.local'), "TOKEN='fixture\\$ROOT'\n");
  fs.writeFileSync(path.join(directory, '.env'), "TOKEN='fallback'\n");
  const result = child(directory, { TOKEN: 'fixture$ROOT' }, `
    try { require(process.argv[1]).prepareNextEnvironment(process.argv[3]); process.exit(2); }
    catch (error) { if (process.env.TOKEN !== 'fixture$ROOT' || error.message.includes('fixture')) process.exit(3); }
  `);
  assert.equal(result.status, 0, result.stderr);
}));

test('quoted multiline text is not mistaken for another env binding', () => fixture(directory => {
  fs.writeFileSync(path.join(directory, '.env.local'), 'DESCRIPTION="first\nUNMANAGED=inside text"\n');
  const result = child(directory, { UNMANAGED: '$ROOT' }, `
    require(process.argv[1]).prepareNextEnvironment(process.argv[3]);
    process.stdout.write(process.env.UNMANAGED);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '$ROOT');
}));

test('already processed Next environment is refused instead of double escaping', () => fixture(directory => {
  const result = child(directory, { __NEXT_PROCESSED_ENV: 'true' }, `
    try { require(process.argv[1]).prepareNextEnvironment(process.argv[3]); process.exit(2); } catch {}
  `);
  assert.equal(result.status, 0, result.stderr);
}));
