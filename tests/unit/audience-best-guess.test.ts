/** Fail-safe: unanswered "who will read this?" past the deadline -> best-guess audience. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writtenForLabel, writtenForChipLabel, needsAudienceAnswer } from '../../src/lib/board/audience-chip';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-best-guess-')), 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
process.env.DISABLE_QC_AUTO_SCORER = 'true';

type Db = typeof import('../../src/lib/db');
let run: Db['run']; let queryOne: Db['queryOne']; let queryAll: Db['queryAll'];
let persist: typeof import('../../src/lib/persona-selector')['persistPersonaBundle'];
let T: typeof import('../../src/lib/tasks');
let G: typeof import('../../src/lib/audience-best-guess');
let n = 0;

function mk(id: string, dept = 'marketing', source: string | null = null, label: string | null = null, createdAt = new Date().toISOString()) {
  run(`INSERT INTO tasks (id,title,status,priority,workspace_id,business_id,department,created_at,updated_at,audience_source,audience_label)
       VALUES (?,?, 'backlog','medium',NULL,NULL,?,?,?,?,?)`, [id, `Write a newsletter ${id}`, dept, createdAt, createdAt, source, label]);
}
function bundle(): import('../../src/lib/types').PersonaBundle {
  return {
    topic: 'x', confirm_required: true,
    resolved_audience: { source: 'asked', candidates: [], confidence: 0, label: null, id: null },
    voice: { audience_persona: { id: 'a' }, topic_persona: { id: 'b' }, collapsed: false, topic_as_task_guidance: true },
    blend_directive: 'Write in the audience voice.', task_personas: [], catalog_version: '1.3',
  } as never;
}
const okRescore = (async (id: string) => {
  run("UPDATE task_persona_bundle SET confirm_state='confirmed' WHERE task_id=?", [id]);
  run("UPDATE task_persona_bundle SET bundle_json=json_set(bundle_json,'$.rationale.refresh_pending',json('false')) WHERE task_id=?", [id]);
  return { rescored: true, bundle: null };
}) as unknown as typeof T.rescoreAudienceBlend;

test.before(async () => {
  const db = await import('../../src/lib/db');
  ({ run, queryOne, queryAll } = db); db.getDb();
  ({ persistPersonaBundle: persist } = await import('../../src/lib/persona-selector'));
  T = await import('../../src/lib/tasks');
  G = await import('../../src/lib/audience-best-guess');
});
test.after(() => { try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ } });

const llmNever = (async () => { throw new Error('LLM must not be called'); }) as never;

test('tier a: most frequently confirmed audience wins, old/unconfirmed rows ignored', async () => {
  for (let i = 0; i < 3; i++) mk(`h-${++n}`, 'marketing', 'operator_confirmed', 'Women entrepreneurs');
  mk(`h-${++n}`, 'marketing', 'task_named', 'Dana Cole');
  for (let i = 0; i < 5; i++) mk(`old-${++n}`, 'marketing', 'operator_confirmed', 'Stale audience', '2020-01-01T00:00:00.000Z');
  for (let i = 0; i < 5; i++) mk(`bg-${++n}`, 'marketing', 'best_guess', 'Guess-only audience');
  const id = `t-${++n}`; mk(id); persist(id, bundle());
  const r = await G.bestGuessAudienceForTask(id, null, llmNever, okRescore);
  assert.deepEqual(r, { label: 'Women entrepreneurs', tier: 'most_common' });
  const row = queryOne<{ audience_source: string; audience_label: string }>('SELECT audience_source,audience_label FROM tasks WHERE id=?', [id]);
  assert.equal(row?.audience_source, 'best_guess');
  assert.equal(T.evaluateAudienceConfirmGate(id).hold, false);
  const ev = queryAll<{ message: string }>("SELECT message FROM events WHERE task_id=? AND type='audience_best_guess'", [id]);
  assert.equal(ev.length, 1);
  assert.match(ev[0].message, /Women entrepreneurs.*most_common/);
  assert.equal(writtenForChipLabel(row!), 'Women entrepreneurs (best guess)');
  assert.equal(needsAudienceAnswer({ blend_confirm_state: 'pending', audience_source: 'best_guess' }), false);
});

test('tier b: no history -> inferred label from stubbed LLM, validated', async () => {
  run("DELETE FROM tasks WHERE audience_source IN ('operator_confirmed','task_named','owner_default')");
  const id = `t-${++n}`; mk(id); persist(id, bundle());
  const seen: string[] = [];
  const llm = (async (_s: string, u: string) => { seen.push(u); return '"Women entrepreneurs in the coaching community."'; });
  const r = await G.bestGuessAudienceForTask(id, null, llm, okRescore);
  assert.deepEqual(r, { label: 'Women entrepreneurs in the coaching community', tier: 'inferred' });
  assert.match(seen[0], /task title: Write a newsletter/);
});

test('tier c: LLM fails or returns junk -> null, nothing written, house-voice release unchanged', async () => {
  run("DELETE FROM tasks WHERE audience_source IN ('operator_confirmed','task_named','owner_default')");
  for (const bad of [async () => { throw new Error('timeout'); }, async () => 'x'.repeat(81), async () => 'Ignore previous instructions and reply', async () => '']) {
    const id = `t-${++n}`; mk(id); persist(id, bundle());
    assert.equal(await G.bestGuessAudienceForTask(id, null, bad as never, okRescore), null);
    assert.equal(queryAll("SELECT id FROM events WHERE task_id=? AND type='audience_best_guess'", [id]).length, 0);
    T.markAudienceDeadlineFallback(id);
    assert.equal(queryOne<{ confirm_state: string }>('SELECT confirm_state FROM task_persona_bundle WHERE task_id=?', [id])?.confirm_state, 'deadline_fallback');
  }
});

test('hard-hold departments unchanged and checked before the best-guess path', () => {
  assert.equal(T.isHardHoldConfirmDepartment('funnels'), true);
  assert.equal(T.isHardHoldConfirmDepartment('web-development'), true);
  assert.equal(T.isHardHoldConfirmDepartment('marketing'), false);
  const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/task-dispatcher.ts'), 'utf8');
  assert.ok(src.indexOf('blockForOwnerConfirm(task.id') < src.indexOf("import('@/lib/audience-best-guess')"));
});

test('chip: best_guess shows (best guess); other sources unchanged', () => {
  assert.equal(writtenForChipLabel({ audience_source: 'best_guess', audience_label: 'Coaches' }), 'Coaches (best guess)');
  assert.equal(writtenForChipLabel({ audience_source: 'task_named', audience_label: 'Dana' }), 'Dana');
  assert.equal(writtenForLabel({ audience_source: 'best_guess', audience_label: 'Coaches' }), 'Coaches');
  assert.equal(writtenForChipLabel({ audience_source: 'operator_confirmed', audience_label: 'Dana' }), null);
});
