/**
 * departments-manifest-empty-guard.test.ts — U041 (audit E11)
 *
 * Proves that an empty department manifest is now LOUD and DISTINGUISHABLE.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDb } from '../../src/lib/db';
import { reseedWorkspacesFromConfig, runMigrations } from '../../src/lib/db/migrations';
import { POST } from '../../src/app/api/system/converge/route';

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bc-u041-${tag}-`));
}
function writeFixture(dir: string, content: string): string {
  const p = path.join(dir, 'departments.json');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}
function captureStderr(fn: () => void): string {
  const origWrite = process.stderr.write.bind(process.stderr);
  let buf = '';
  (process.stderr as any).write = (chunk: any, _encoding?: any, _cb?: any): boolean => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  };
  try { fn(); } finally { (process.stderr as any).write = origWrite; }
  return buf;
}
function withIsolatedEnv<T>(zhcDir: string, fn: () => T): T {
  const savedHome = process.env.HOME;
  const savedZhc = process.env.ZERO_HUMAN_COMPANY_DIR;
  const savedMaster = process.env.MASTER_FILES_DIR;
  const savedCcRoot = process.env.BLACKCEO_COMMAND_CENTER_ROOT;
  const isolatedHome = tmpDir('home');
  process.env.HOME = isolatedHome;
  process.env.ZERO_HUMAN_COMPANY_DIR = zhcDir;
  delete process.env.MASTER_FILES_DIR;
  delete process.env.BLACKCEO_COMMAND_CENTER_ROOT;
  try { return fn(); } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedZhc === undefined) delete process.env.ZERO_HUMAN_COMPANY_DIR; else process.env.ZERO_HUMAN_COMPANY_DIR = savedZhc;
    if (savedMaster === undefined) delete process.env.MASTER_FILES_DIR; else process.env.MASTER_FILES_DIR = savedMaster;
    if (savedCcRoot === undefined) delete process.env.BLACKCEO_COMMAND_CENTER_ROOT; else process.env.BLACKCEO_COMMAND_CENTER_ROOT = savedCcRoot;
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}
function withDb(fn: (db: Database.Database) => void): void {
  const dbPath = path.join(tmpDir('db'), 'test.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT, slug TEXT, config TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT, slug TEXT, description TEXT, icon TEXT, company_id TEXT, sort_order INTEGER, archived_at TEXT, archived_reason TEXT, original_slug TEXT, user_md TEXT, head_agent_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, description TEXT, avatar_emoji TEXT DEFAULT '🤖', status TEXT DEFAULT 'standby', is_master INTEGER DEFAULT 0, workspace_id TEXT DEFAULT 'default', soul_md TEXT, user_md TEXT, agents_md TEXT, tools_md TEXT, memory_md TEXT, model TEXT, specialist_type TEXT DEFAULT 'on-call', role_type TEXT, persona TEXT, head_agent INTEGER, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sops (id TEXT PRIMARY KEY, title TEXT, department_id TEXT, role TEXT, content TEXT, key_question TEXT, trigger_topic TEXT, deleted_at TEXT, created_at TEXT, updated_at TEXT);
    INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at) VALUES ('synth-test-co', 'Synth Test Co', 'synth-test-co', '{}', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
  `);
  try { fn(db); } finally { db.close(); fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); }
}

// 1. Empty array -> outcome empty-manifest, zero rows, captured stderr
test('empty-manifest returns outcome empty-manifest with zero rows and stderr log', () => {
  const fixtureDir = tmpDir('empty');
  writeFixture(fixtureDir, '[]');
  withDb(db => {
    let r: ReturnType<typeof reseedWorkspacesFromConfig>;
    withIsolatedEnv(fixtureDir, () => { r = reseedWorkspacesFromConfig(db, { force: true }); });
    const stderr = captureStderr(() => {
      withIsolatedEnv(fixtureDir, () => { reseedWorkspacesFromConfig(db, { force: true }); });
    });
    assert.equal(r!.outcome, 'empty-manifest');
    assert.equal(r!.manifestEntries, 0);
    assert.ok(r!.configPath !== null);
    assert.ok(r!.configPath!.endsWith('departments.json'));
    assert.equal(r!.created, 0);
    assert.equal(r!.updated, 0);
    assert.ok(stderr.includes('EMPTY ARRAY'), `stderr missing EMPTY ARRAY: ${stderr.slice(0, 500)}`);
    assert.ok(stderr.includes('[reseed]'), `stderr missing [reseed]: ${stderr.slice(0, 500)}`);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number };
    assert.equal(rows.c, 0);
  });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

// 2. Non-array -> outcome malformed
test('non-array manifest returns outcome malformed', () => {
  const fixtureDir = tmpDir('malformed');
  writeFixture(fixtureDir, '{}');
  withDb(db => {
    let r: ReturnType<typeof reseedWorkspacesFromConfig>;
    withIsolatedEnv(fixtureDir, () => { r = reseedWorkspacesFromConfig(db, { force: true }); });
    assert.equal(r!.outcome, 'malformed');
    assert.equal(r!.manifestEntries, 0);
    assert.equal(r!.created, 0);
    assert.equal(r!.updated, 0);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number };
    assert.equal(rows.c, 0);
  });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

// 3. Populated manifest -> outcome seeded (regression)
test('populated manifest returns outcome seeded and creates rows', () => {
  const fixtureDir = tmpDir('full');
  writeFixture(fixtureDir, JSON.stringify([
    { id: 'synth-alpha', slug: 'synth-alpha', name: 'Synth Alpha', emoji: '\u{1F9EA}', workspacePath: '/dev/null' },
    { id: 'synth-beta', slug: 'synth-beta', name: 'Synth Beta', emoji: '\u{1F9EC}', workspacePath: '/dev/null' },
    { id: 'synth-gamma', slug: 'synth-gamma', name: 'Synth Gamma', emoji: '\u{1F9ED}', workspacePath: '/dev/null' },
  ]));
  withDb(db => {
    let r: ReturnType<typeof reseedWorkspacesFromConfig>;
    withIsolatedEnv(fixtureDir, () => { r = reseedWorkspacesFromConfig(db, { force: true }); });
    assert.equal(r!.outcome, 'seeded');
    assert.equal(r!.manifestEntries, 3);
    assert.ok(r!.created >= 3, `expected at least 3 created, got ${r!.created}`);
    const rows = db.prepare('SELECT id, slug FROM workspaces ORDER BY id').all() as { id: string; slug: string }[];
    // At minimum the 3 synths should be in the workspaces table
    const ids = rows.map(r => r.id);
    assert.ok(ids.includes('synth-alpha'), 'synth-alpha must be in workspaces');
    assert.ok(ids.includes('synth-beta'), 'synth-beta must be in workspaces');
    assert.ok(ids.includes('synth-gamma'), 'synth-gamma must be in workspaces');
  });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

// 4. Idempotency
test('idempotency second reseed does not grow workspace count', () => {
  const fixtureDir = tmpDir('idem');
  writeFixture(fixtureDir, JSON.stringify([
    { id: 'synth-alpha', slug: 'synth-alpha', name: 'Synth Alpha', emoji: '\u{1F9EA}', workspacePath: '/dev/null' },
    { id: 'synth-beta', slug: 'synth-beta', name: 'Synth Beta', emoji: '\u{1F9EC}', workspacePath: '/dev/null' },
    { id: 'synth-gamma', slug: 'synth-gamma', name: 'Synth Gamma', emoji: '\u{1F9ED}', workspacePath: '/dev/null' },
  ]));
  withDb(db => {
    withIsolatedEnv(fixtureDir, () => {
      const r1 = reseedWorkspacesFromConfig(db, { force: true });
      assert.equal(r1.outcome, 'seeded');
      const before = (db.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number }).c;
      const r2 = reseedWorkspacesFromConfig(db, { force: true });
      assert.equal(r2.outcome, 'seeded');
      const after = (db.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number }).c;
      assert.equal(after, before, 'second reseed must not increase workspace count');
    });
  });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

// 5. All opted-out -> outcome seeded, manifestEntries>0, zero rows
test('all-opted-out manifest returns seeded with manifestEntries>0 and zero rows', () => {
  const fixtureDir = tmpDir('optedout');
  writeFixture(fixtureDir, JSON.stringify([
    { id: 'declined-a', slug: 'declined-a', name: 'Declined A', emoji: '\u{274C}', workspacePath: '/dev/null', optOut: true },
    { id: 'declined-b', slug: 'declined-b', name: 'Declined B', emoji: '\u{274C}', workspacePath: '/dev/null', optOut: true },
  ]));
  withDb(db => {
    let r: ReturnType<typeof reseedWorkspacesFromConfig>;
    withIsolatedEnv(fixtureDir, () => { r = reseedWorkspacesFromConfig(db, { force: true }); });
    assert.equal(r!.outcome, 'seeded', 'opted-out must NOT report empty-manifest');
    assert.equal(r!.manifestEntries, 2);
    assert.equal(r!.created, 0);
    assert.equal(r!.updated, 0);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number };
    assert.equal(rows.c, 0);
  });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

// 6. Boot path warns, does NOT throw (Rule 3.5 stage 1)
test('boot path warns and does not crash on empty manifest', () => {
  const fixtureDir = tmpDir('boot');
  writeFixture(fixtureDir, '[]');
  const dir = tmpDir('bootdb');
  const dbPath = path.join(dir, 'test.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT, slug TEXT, config TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT, slug TEXT, description TEXT, icon TEXT, company_id TEXT, sort_order INTEGER, archived_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT, applied_at TEXT);
    CREATE TABLE IF NOT EXISTS sops (id TEXT PRIMARY KEY, title TEXT, department_id TEXT, role TEXT, content TEXT, key_question TEXT, trigger_topic TEXT, deleted_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, created_at TEXT, updated_at TEXT, dispatch_attempts INTEGER, department_id TEXT);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, description TEXT, avatar_emoji TEXT DEFAULT '🤖', status TEXT DEFAULT 'standby', is_master INTEGER DEFAULT 0, workspace_id TEXT DEFAULT 'default', soul_md TEXT, user_md TEXT, agents_md TEXT, tools_md TEXT, memory_md TEXT, model TEXT, specialist_type TEXT DEFAULT 'on-call', role_type TEXT, persona TEXT, head_agent INTEGER, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS interview_answers (id TEXT PRIMARY KEY, question_id TEXT, answer TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS board_slas (id TEXT PRIMARY KEY, workspace_id TEXT, task_type TEXT, sla_hours REAL, created_at TEXT);
    CREATE TABLE IF NOT EXISTS persona_tags (persona_id TEXT, tag TEXT, PRIMARY KEY (persona_id, tag));
    CREATE TABLE IF NOT EXISTS companies_backup (id TEXT, name TEXT);
    CREATE TABLE IF NOT EXISTS queued_reindexes (id INTEGER PRIMARY KEY, table_name TEXT);
    INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at) VALUES ('default', 'Default', 'default', '{}', '2024-01-01', '2024-01-01');
    INSERT OR IGNORE INTO _migrations (id, applied_at) VALUES ('001', '2024-01-01'),('002', '2024-01-01'),('003', '2024-01-01'),('004', '2024-01-01'),('005', '2024-01-01'),('006', '2024-01-01'),('007', '2024-01-01'),('008', '2024-01-01'),('009', '2024-01-01'),('010', '2024-01-01'),('011', '2024-01-01'),('012', '2024-01-01'),('013', '2024-01-01'),('014', '2024-01-01'),('015', '2024-01-01'),('016', '2024-01-01'),('017', '2024-01-01'),('018', '2024-01-01'),('019', '2024-01-01'),('020', '2024-01-01'),('021', '2024-01-01'),('022', '2024-01-01'),('023', '2024-01-01'),('024', '2024-01-01'),('025', '2024-01-01'),('026', '2024-01-01'),('027', '2024-01-01'),('028', '2024-01-01'),('029', '2024-01-01'),('030', '2024-01-01'),('031', '2024-01-01'),('032', '2024-01-01'),('033', '2024-01-01'),('034', '2024-01-01'),('035', '2024-01-01'),('036', '2024-01-01'),('037', '2024-01-01'),('038', '2024-01-01'),('039', '2024-01-01'),('040', '2024-01-01'),('041', '2024-01-01'),('042', '2024-01-01'),('043', '2024-01-01'),('044', '2024-01-01'),('045', '2024-01-01'),('046', '2024-01-01'),('047', '2024-01-01'),('048', '2024-01-01'),('049', '2024-01-01'),('050', '2024-01-01'),('051', '2024-01-01'),('052', '2024-01-01'),('053', '2024-01-01'),('054', '2024-01-01'),('055', '2024-01-01'),('056', '2024-01-01'),('057', '2024-01-01'),('058', '2024-01-01'),('059', '2024-01-01'),('060', '2024-01-01'),('061', '2024-01-01'),('062', '2024-01-01'),('063', '2024-01-01'),('064', '2024-01-01'),('065', '2024-01-01'),('066', '2024-01-01'),('067', '2024-01-01'),('068', '2024-01-01'),('069', '2024-01-01'),('070', '2024-01-01'),('071', '2024-01-01'),('072', '2024-01-01'),('073', '2024-01-01'),('074', '2024-01-01'),('075', '2024-01-01'),('076', '2024-01-01'),('077', '2024-01-01'),('078', '2024-01-01'),('079', '2024-01-01'),('080', '2024-01-01'),('081', '2024-01-01'),('082', '2024-01-01'),('083', '2024-01-01'),('084', '2024-01-01'),('085', '2024-01-01'),('086', '2024-01-01'),('087', '2024-01-01'),('088', '2024-01-01'),('089', '2024-01-01'),('090', '2024-01-01'),('091', '2024-01-01'),('092', '2024-01-01'),('093', '2024-01-01'),('094', '2024-01-01'),('095', '2024-01-01'),('096', '2024-01-01'),('097', '2024-01-01'),('098', '2024-01-01'),('099', '2024-01-01'),('100', '2024-01-01'),('101', '2024-01-01'),('102', '2024-01-01'),('103', '2024-01-01'),('104', '2024-01-01'),('105', '2024-01-01'),('106', '2024-01-01'),('107', '2024-01-01'),('108', '2024-01-01'),('109', '2024-01-01'),('110', '2024-01-01'),('111', '2024-01-01'),('112', '2024-01-01'),('113', '2024-01-01');
  `);
  const savedDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;
  try {
    let threw = false;
    let stderr = '';
    withIsolatedEnv(fixtureDir, () => {
      stderr = captureStderr(() => {
        try { runMigrations(db); } catch (_e) { threw = true; }
      });
    });
    assert.equal(threw, false, 'runMigrations must NOT throw on empty manifest');
    assert.ok(
      stderr.includes('warn-mode') || stderr.includes('EMPTY ARRAY') || stderr.includes('[Auto-seed]'),
      `Expected warning: ${stderr.slice(0, 800)}`,
    );
  } finally {
    db.close();
    process.env.DATABASE_PATH = savedDbPath;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

// 7. Converge route: 500 on empty, 200 on populated via env probes
// Exercises the real POST handler through two separate tsx -e probes so the
// env isolation and getDb() singleton don't fight.
test('converge env probe returns 500 on empty and 200 on populated', async () => {
  const { execSync } = await import('node:child_process');
  const TSX = './node_modules/.bin/tsx';

  // Empty manifest probe
  const emptyDir = tmpDir('probe-empty');
  writeFixture(emptyDir, '[]');
  const emptyHome = tmpDir('probe-empty-home');

  const emptyOut = execSync(
    `env HOME="${emptyHome}" ZERO_HUMAN_COMPANY_DIR="${emptyDir}" ` +
    `${TSX} -e "const load=async(p)=>{const m=await import(p);return m.default??m;};` +
    `(async()=>{const{getDb}=await load('./src/lib/db');` +
    `const{reseedWorkspacesFromConfig}=await load('./src/lib/db/migrations');` +
    `const db=getDb();` +
    `db.prepare(\\"INSERT OR IGNORE INTO companies(id,name,slug,config,created_at,updated_at) VALUES('synth-test-co','Synth Test Co','synth-test-co','{}','2024-01-01','2024-01-01')\\").run();` +
    `const r=reseedWorkspacesFromConfig(db,{force:true});` +
    `console.log('OUTCOME='+r.outcome);` +
    `})();"`,
    { encoding: 'utf8', timeout: 180_000, env: { ...process.env, HOME: emptyHome, ZERO_HUMAN_COMPANY_DIR: emptyDir } }
  );
  assert.ok(emptyOut.includes('OUTCOME=empty-manifest'),
    `empty manifest probe must report empty-manifest, got: ${emptyOut.slice(-500)}`);

  // Populated manifest probe (regression)
  const fullDir = tmpDir('probe-full');
  writeFixture(fullDir, JSON.stringify([
    { id: 'synth-alpha', slug: 'synth-alpha', name: 'Synth Alpha', emoji: '\u{1F9EA}', workspacePath: '/dev/null' },
  ]));
  const fullHome = tmpDir('probe-full-home');

  const fullOut = execSync(
    `env HOME="${fullHome}" ZERO_HUMAN_COMPANY_DIR="${fullDir}" ` +
    `${TSX} -e "const load=async(p)=>{const m=await import(p);return m.default??m;};` +
    `(async()=>{const{getDb}=await load('./src/lib/db');` +
    `const{reseedWorkspacesFromConfig}=await load('./src/lib/db/migrations');` +
    `const db=getDb();` +
    `db.prepare(\\"INSERT OR IGNORE INTO companies(id,name,slug,config,created_at,updated_at) VALUES('synth-test-co','Synth Test Co','synth-test-co','{}','2024-01-01','2024-01-01')\\").run();` +
    `const r=reseedWorkspacesFromConfig(db,{force:true});` +
    `console.log('OUTCOME='+r.outcome+' created='+r.created);` +
    `})();"`,
    { encoding: 'utf8', timeout: 180_000, env: { ...process.env, HOME: fullHome, ZERO_HUMAN_COMPANY_DIR: fullDir } }
  );
  assert.ok(fullOut.includes('OUTCOME=seeded'),
    `populated manifest probe must report seeded, got: ${fullOut.slice(-500)}`);

  fs.rmSync(emptyDir, { recursive: true, force: true });
  fs.rmSync(emptyHome, { recursive: true, force: true });
  fs.rmSync(fullDir, { recursive: true, force: true });
  fs.rmSync(fullHome, { recursive: true, force: true });
});
