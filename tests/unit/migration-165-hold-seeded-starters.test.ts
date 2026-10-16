/**
 * Migration 165: installer-seeded "Welcome to <Dept>" cards were inserted
 * without dispatch_hold, so the intake sweep dispatched them right after
 * install and every stop paged the owner. The migration holds the ones still
 * untouched in backlog -- and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrations } from '../../src/lib/db/migrations';

test('migration 165 holds untouched seeded starter cards only', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT,
           dispatch_hold INTEGER NOT NULL DEFAULT 0)`);
  const ins = db.prepare('INSERT INTO tasks (id, title, description, status) VALUES (?, ?, ?, ?)');
  const starter = "This is your Sales department's first task. Click to edit.";
  ins.run('seeded', 'Welcome to Sales', starter, 'backlog');
  ins.run('started', 'Welcome to Bugs', "This is your Bugs department's first task.", 'in_progress');
  ins.run('real', 'Welcome to the new site', 'Build the landing page.', 'backlog');
  migrations.find((m) => m.id === '165')!.up(db);
  const hold = (id: string) => (db.prepare('SELECT dispatch_hold FROM tasks WHERE id = ?').get(id) as { dispatch_hold: number }).dispatch_hold;
  assert.equal(hold('seeded'), 1);
  assert.equal(hold('started'), 0, 'a card already moving is left to its lifecycle');
  assert.equal(hold('real'), 0, 'real work that merely starts with "Welcome to" is untouched');
});
