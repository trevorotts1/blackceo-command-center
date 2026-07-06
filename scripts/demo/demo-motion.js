#!/usr/bin/env node
/**
 * Command Center Demo Pack — safe live-activity generator (optional).
 *
 *   node scripts/demo/demo-motion.js --db <DEMO_DASHBOARD_DB> [--interval 15000]
 *
 * Makes the seeded dashboard visibly ALIVE during a walkthrough: every interval
 * it advances a task's status, posts a matching feed event, and occasionally
 * flips an agent's status. Purpose-built for the demo so it uses ONLY the schema's
 * valid enums (unlike the upstream scripts/demo-simulator.js, whose TASK_IDEAS use
 * priority 'normal', which violates the tasks.priority CHECK). Fictional data only;
 * touches ONLY the DB file it is pointed at. Always stopped by reset-demo.sh.
 */
'use strict';
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const dbPath = arg('db', process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db'));
const interval = parseInt(arg('interval', '15000'), 10);

const Database = require('better-sqlite3');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const uuid = () => require('crypto').randomUUID();
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
// Forward status flow using only valid tasks.status enum values.
const FLOW = { backlog: 'planning', planning: 'in_progress', in_progress: 'review', review: 'testing', testing: 'done' };
const AGENT_STATUS = ['working', 'standby', 'working', 'working']; // bias toward "working"

function tick() {
  try {
    const t = db.prepare(
      `SELECT id, title, status, workspace_id FROM tasks
       WHERE status IN ('backlog','planning','in_progress','review','testing')
       ORDER BY RANDOM() LIMIT 1`,
    ).get();
    if (t) {
      const next = FLOW[t.status];
      const done = next === 'done';
      db.prepare(`UPDATE tasks SET status=?, updated_at=?${done ? ', completed_at=?' : ''} WHERE id=?`)
        .run(...(done ? [next, nowSql(), nowSql(), t.id] : [next, nowSql(), t.id]));
      db.prepare(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?,?,?,?,?)`)
        .run(uuid(), 'task_updated', t.id, `"${t.title}" moved to ${next.replace('_', ' ')}.`, nowSql());
    }
    if (Math.random() < 0.34) {
      const a = db.prepare(`SELECT id, name FROM agents WHERE is_master=0 ORDER BY RANDOM() LIMIT 1`).get();
      if (a) {
        const s = AGENT_STATUS[Math.floor(Math.random() * AGENT_STATUS.length)];
        db.prepare(`UPDATE agents SET status=?, updated_at=? WHERE id=?`).run(s, nowSql(), a.id);
      }
    }
    process.stdout.write(`[demo-motion] tick ${new Date().toISOString()}\n`);
  } catch (e) {
    process.stderr.write(`[demo-motion] tick error (non-fatal): ${e.message}\n`);
  }
}

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
tick();
setInterval(tick, interval);
