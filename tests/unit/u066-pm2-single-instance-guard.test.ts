/**
 * U066 — behavioural proof of the pm2-single-instance-guard.
 * No database needed. Case 9 is a SECRETS TEST.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const SECRET_WORDS = ['SECRET', 'TOKEN', 'PASSWORD', 'CREDENTIAL'];
const DB_PATH_KEY = 'DATABASE' + '_PATH';
const HOME_PREFIX = '/Users/';

function makeWarnCapture() {
  const seen: string[] = [];
  const orig = console.warn;
  return {
    seen,
    install() { console.warn = (...a: unknown[]) => { seen.push(a.map(String).join(' ')); }; },
    restore() { console.warn = orig; },
  };
}

test('warnIfClustered fires on a cluster environment', async () => {
  const mod = await import('../../src/lib/events');
  const cap = makeWarnCapture();
  cap.install();
  try {
    mod.warnIfClustered({ exec_mode: 'cluster_mode' });
    assert.equal(cap.seen.length, 1);
    assert.ok(cap.seen[0].startsWith('[SSE] WARNING:'));
  } finally { cap.restore(); }
});

test('warnIfClustered silent in fork+instance0', async () => {
  const mod = await import('../../src/lib/events');
  const cap = makeWarnCapture();
  cap.install();
  try {
    mod.warnIfClustered({ exec_mode: 'fork', NODE_APP_INSTANCE: '0' });
    assert.equal(cap.seen.length, 0);
  } finally { cap.restore(); }
});

test('cluster warning does not mention siblings or shared dir', async () => {
  const mod = await import('../../src/lib/events');
  const cap = makeWarnCapture();
  cap.install();
  try {
    mod.warnIfClustered({ exec_mode: 'cluster_mode' });
    assert.equal(cap.seen.length, 1);
    assert.ok(!/sibling|same (working )?directory|pm_cwd/i.test(cap.seen[0]));
  } finally { cap.restore(); }
});

test('warnIfClustered silent on bare env', async () => {
  const mod = await import('../../src/lib/events');
  const cap = makeWarnCapture();
  cap.install();
  try {
    mod.warnIfClustered({});
    assert.equal(cap.seen.length, 0);
  } finally { cap.restore(); }
});

test('warnIfClustered fires on NODE_APP_INSTANCE:2', async () => {
  const mod = await import('../../src/lib/events');
  const cap = makeWarnCapture();
  cap.install();
  try {
    mod.warnIfClustered({ NODE_APP_INSTANCE: '2' });
    assert.equal(cap.seen.length, 1);
  } finally { cap.restore(); }
});

let runGuard: any;
let loadRequirableConfig: any;
let auditApps: any;
let describeApp: any;

test('import guard module', async () => {
  const mod = await import('../../scripts/pm2-single-instance-guard.mjs');
  runGuard = mod.runGuard;
  loadRequirableConfig = mod.loadRequirableConfig;
  auditApps = mod.auditApps;
  describeApp = mod.describeApp;
  assert.equal(typeof runGuard, 'function');
  assert.equal(typeof loadRequirableConfig, 'function');
  assert.equal(typeof auditApps, 'function');
  assert.equal(typeof describeApp, 'function');
});

test('real configs: no hard findings', () => {
  const r = runGuard({ repoRoot: process.cwd() });
  assert.equal(r.pass, true);
  assert.equal(r.hard.length, 0);
});

test('real configs: correct advisory counts', () => {
  const r = runGuard({ repoRoot: process.cwd() });
  const u = r.advisory.filter((f: any) => f.code === 'INSTANCES-UNDECLARED');
  assert.equal(u.length, 3, 'expected 3 INSTANCES-UNDECLARED');
  const s = r.advisory.filter((f: any) => f.code === 'SHARED-WORKING-DIRECTORY');
  assert.equal(s.length, 1, 'expected 1 SHARED-WORKING-DIRECTORY');
  assert.equal(r.appCount, 6, 'expected 6 apps');
});

test('clustered fixture fails with both codes', () => {
  const p = process.cwd() + '/tests/fixtures/pm2-single-instance/clustered-ecosystem.cjs';
  const r = runGuard({ files: [p] });
  assert.equal(r.pass, false);
  const codes = r.hard.map((f: any) => f.code);
  assert.ok(codes.includes('EXEC-MODE-NOT-FORK'));
  assert.ok(codes.includes('INSTANCES-NOT-ONE'));
});

test('shared-db fixture fails with SHARED-DATABASE-PATH alone', () => {
  const p = process.cwd() + '/tests/fixtures/pm2-single-instance/shared-db-ecosystem.cjs';
  const r = runGuard({ files: [p] });
  assert.equal(r.pass, false);
  const codes = r.hard.map((f: any) => f.code);
  assert.equal(codes.length, 1, 'expected exactly 1 hard finding');
  assert.equal(codes[0], 'SHARED-DATABASE-PATH');
});

test('no report carries env, path, or secret', () => {
  const r = runGuard({ repoRoot: process.cwd() });
  const s = JSON.stringify(r);
  for (const w of SECRET_WORDS) {
    assert.ok(!new RegExp(w, 'i').test(s), 'report must not contain ' + w);
  }
  assert.ok(!s.includes(DB_PATH_KEY), 'report must not contain ' + DB_PATH_KEY);
  assert.ok(!s.includes(HOME_PREFIX), 'report must not contain ' + HOME_PREFIX);
  assert.ok(r.advisory.length > 0, 'advisory should be non-empty');
});
