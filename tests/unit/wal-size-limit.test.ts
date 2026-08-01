/**
 * U040 -- wal-size-limit.test.ts
 * Tests journal_size_limit = 8388608 bounds the WAL high-water mark.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIMIT = 8388608;

function scratchDir() {
  const d = path.join(os.tmpdir(),
    'u040-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function dbPath(d: string, n: string) { return path.join(d, n + '.db'); }

function probe(dir: string, name: string, getHandle: (p: string) => any) {
  const p = dbPath(dir, name);
  const walFile = p + '-wal';
  const pad = 'x'.repeat(4000);
  const h = getHandle(p);
  h.pragma('wal_autocheckpoint = 0');
  h.exec('CREATE TABLE IF NOT EXISTS u040_probe (id INTEGER PRIMARY KEY, blob TEXT)');
  const ins = h.prepare('INSERT INTO u040_probe (blob) VALUES (?)');
  h.transaction(() => { for (let i = 0; i < 4000; i++) ins.run(pad); })();
  const before = fs.statSync(walFile).size;
  assert.ok(before > LIMIT,
    'Fixture too small: -wal is ' + before + ' bytes, must exceed ' + LIMIT +
    '. Increase rows or suppress wal_autocheckpoint.');
  h.pragma('wal_checkpoint(RESTART)');
  h.prepare("INSERT INTO u040_probe (blob) VALUES ('post-reset')").run();
  const after = fs.statSync(walFile).size;
  const row = h.prepare('SELECT count(*) c FROM u040_probe').get();
  return { before, after, rows: row.c };
}

test('CASE 1 -- limit on getDb()', async () => {
  const d = scratchDir();
  try {
    process.env.DATABASE_PATH = dbPath(d, 'probe');
    const { getDb } = await import('../../src/lib/db');
    const db = getDb();
    assert.strictEqual(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.strictEqual(db.pragma('journal_size_limit', { simple: true }), LIMIT);
    assert.strictEqual(db.pragma('busy_timeout', { simple: true }), 5000);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('CASE 2 -- observable truncation vs -1 control', async () => {
  const d = scratchDir();
  try {
    const Database = require('better-sqlite3');
    const lim = new Database(dbPath(d, 'limited'));
    lim.pragma('journal_mode = WAL');
    lim.pragma('journal_size_limit = ' + LIMIT);
    const limResult = probe(d, 'limited', () => lim);

    const ctl = new Database(dbPath(d, 'ctl'));
    ctl.pragma('journal_mode = WAL');
    ctl.pragma('journal_size_limit = -1');
    const ctlResult = probe(d, 'ctl', () => ctl);

    assert.strictEqual(limResult.rows, 4001);
    assert.strictEqual(ctlResult.rows, 4001);
    assert.strictEqual(limResult.after, LIMIT,
      'LIMITED after must be ' + LIMIT + ', got ' + limResult.after);
    assert.strictEqual(ctlResult.after, ctlResult.before,
      'CONTROL after must equal before (' + ctlResult.before + '), got ' + ctlResult.after);
    assert.notStrictEqual(limResult.after, ctlResult.after);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('CASE 3 -- oversized tx commits intact', async () => {
  const d = scratchDir();
  try {
    const Database = require('better-sqlite3');
    const p = dbPath(d, 'big');
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    db.pragma('journal_size_limit = ' + LIMIT);
    db.pragma('wal_autocheckpoint = 0');
    db.exec('CREATE TABLE IF NOT EXISTS u040_big (id INTEGER PRIMARY KEY, blob TEXT)');
    const ins = db.prepare('INSERT INTO u040_big (blob) VALUES (?)');
    const pad = 'x'.repeat(4000);
    db.transaction(() => { for (let i = 0; i < 4000; i++) ins.run(pad); })();
    const row = db.prepare('SELECT count(*) c FROM u040_big').get();
    assert.strictEqual(row.c, 4000);
    const first = db.prepare('SELECT blob FROM u040_big WHERE id = 1').get();
    assert.strictEqual(first.blob.length, 4000);
    assert.ok(first.blob === pad, 'Blob content corrupted');
    const tot = db.prepare('SELECT sum(length(blob)) s FROM u040_big').get();
    assert.strictEqual(tot.s, 4000 * 4000);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('CASE 4 -- journal_mode is wal', async () => {
  const d = scratchDir();
  try {
    process.env.DATABASE_PATH = dbPath(d, 'mode');
    const { getDb } = await import('../../src/lib/db');
    assert.strictEqual(getDb().pragma('journal_mode', { simple: true }), 'wal');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('CASE 5 -- singleton idempotency', async () => {
  const d = scratchDir();
  try {
    process.env.DATABASE_PATH = dbPath(d, 'idem');
    const { getDb } = await import('../../src/lib/db');
    assert.strictEqual(getDb().pragma('journal_size_limit', { simple: true }), LIMIT);
    assert.strictEqual(getDb().pragma('journal_size_limit', { simple: true }), LIMIT);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('CASE 6 -- TRUNCATE undiscriminating trap', async () => {
  const d = scratchDir();
  try {
    const Database = require('better-sqlite3');
    const p = dbPath(d, 'trap');
    const walFile = p + '-wal';
    const pad = 'x'.repeat(4000);
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    db.pragma('journal_size_limit = -1');
    db.pragma('wal_autocheckpoint = 0');
    db.exec('CREATE TABLE IF NOT EXISTS u040_trap (id INTEGER PRIMARY KEY, blob TEXT)');
    const ins = db.prepare('INSERT INTO u040_trap (blob) VALUES (?)');
    db.transaction(() => { for (let i = 0; i < 4000; i++) ins.run(pad); })();
    const before = fs.statSync(walFile).size;
    assert.ok(before > LIMIT, 'Fixture must exceed limit: ' + before);
    db.pragma('wal_checkpoint(TRUNCATE)');
    assert.strictEqual(fs.statSync(walFile).size, 0,
      'TRUNCATE with limit=-1 must zero the log');
    const row = db.prepare('SELECT count(*) c FROM u040_trap').get();
    assert.strictEqual(row.c, 4000);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
