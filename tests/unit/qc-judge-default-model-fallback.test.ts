/**
 * QC judge falls back to the box's DEFAULT model when the configured judge
 * model is gone (Ollama Cloud 410 "retired", 404 unknown model).
 *
 * Incident: QC_JUDGE_MODEL=deepseek-v4-flash:cloud was retired upstream (HTTP
 * 410). The scorer logged "judge UNREACHABLE", deferred, then parked every card
 * at [QC-JUDGE-FAILED-FINAL] and excluded it from the sweep.
 *
 * Isolated temp DB + temp openclaw.json + loopback judge. No live calls, no secrets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qc-fallback-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'mission-control.test.db');
process.env.OPENCLAW_ROOT = TMP_DIR;
process.env.HOME = TMP_DIR; // never read the host box's real key stores
for (const k of ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'OLLAMA_API_KEY', 'QC_SIMULATE_PROVIDER_DOWN', 'QC_FIXTURE_JSON_PATH', 'DISABLE_QC_AUTO_SCORER', 'DISABLE_QC_REVIEW_SWEEP']) delete process.env[k];
process.env.QC_JUDGE_FAILURE_MAX_PASSES = '2';

const RETIRED = 'retired-judge:cloud';
const GOOD = 'good-default:cloud';
const SECOND = 'second-fallback:cloud';
const DEAD_MODELS = new Set([RETIRED, 'dead-default:cloud']);
let called: string[] = [];
let server: http.Server;

function setBox(defaults: { primary?: string; fallbacks?: string[] } | null) {
  const p = path.join(TMP_DIR, 'openclaw.json');
  if (!defaults) { try { fs.rmSync(p); } catch { /* none */ } return; }
  fs.writeFileSync(p, JSON.stringify({ agents: { defaults: { model: defaults } } }));
}
function useJudge(model = RETIRED) {
  process.env.QC_JUDGE_MODEL = model;
  process.env.OLLAMA_CLOUD_API_KEY = 'fake-client-key';
}

const input = (writerModel?: string) => ({
  taskId: 'task-fallback',
  taskTitle: 'Fallback task',
  taskDescription: 'A completed deliverable.',
  sopSuccessCriteria: 'Must be complete.',
  sopName: 'SOP',
  sopSteps: null,
  departmentSlug: 'general-task',
  writerModel,
});

test.before(async () => {
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const model: string = JSON.parse(body || '{}').model;
        called.push(model);
        if (DEAD_MODELS.has(model)) {
          res.writeHead(410, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `${model} was retired at 2026-09-25` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: '{"score": 9.1, "pass": true, "reason": "ok", "gaps": []}' }, finish_reason: 'stop' }],
          usage: { completion_tokens: 20 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      process.env.OLLAMA_CLOUD_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  (await import('../../src/lib/db')).getDb();
});

test.after(async () => {
  delete process.env.QC_JUDGE_MODEL;
  delete process.env.OLLAMA_CLOUD_API_KEY;
  delete process.env.OLLAMA_CLOUD_BASE_URL;
  delete process.env.QC_JUDGE_FAILURE_MAX_PASSES;
  delete process.env.OPENCLAW_ROOT;
  try { (await import('../../src/lib/db')).closeDb(); } catch { /* ignore */ }
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

test('[FB-1] retired judge (410) -> box default model judges, one fallback recorded', async () => {
  const { scoreTaskForQC } = await import('../../src/lib/qc-scorer');
  setBox({ primary: `ollama/${GOOD}` });
  useJudge();
  called = [];
  const r = await scoreTaskForQC(input());
  assert.equal(r.scoringPath, 'llm');
  assert.deepEqual(called, [RETIRED, GOOD]);
  assert.equal(r.judgeFallback?.to, `ollama-cloud/${GOOD}`);
});

test('[FB-2] default == writer -> next fallback is used', async () => {
  const { scoreTaskForQC } = await import('../../src/lib/qc-scorer');
  setBox({ primary: `ollama/${GOOD}`, fallbacks: [`ollama/${SECOND}`] });
  useJudge();
  called = [];
  const r = await scoreTaskForQC(input(`ollama/${GOOD}`));
  assert.equal(r.scoringPath, 'llm');
  assert.deepEqual(called, [RETIRED, SECOND], 'the writer model must never judge');
});

test('[FB-3] nothing usable -> fail-closed to human review path (no verdict, marked model-gone)', async () => {
  const { scoreTaskForQC } = await import('../../src/lib/qc-scorer');
  setBox({ primary: 'ollama/dead-default:cloud' });
  useJudge();
  called = [];
  let r = await scoreTaskForQC(input());
  assert.equal(r.scoringPath, 'heuristic');
  assert.equal(r.pass, false);
  assert.equal(r.heuristicReason, 'provider-down');
  assert.equal(r.judgeModelGone, true);
  assert.deepEqual(called, [RETIRED, 'dead-default:cloud']);

  setBox(null); // no openclaw.json at all
  called = [];
  r = await scoreTaskForQC(input());
  assert.equal(r.scoringPath, 'heuristic');
  assert.deepEqual(called, [RETIRED]);

  setBox({ primary: `ollama/${GOOD}` });
  delete process.env.OLLAMA_CLOUD_API_KEY; // never borrow a key: no client key -> no judge at all
  called = [];
  r = await scoreTaskForQC(input());
  assert.equal(r.scoringPath, 'heuristic');
  assert.deepEqual(called, []);
});

test('[FB-4] healthy configured judge is untouched (no fallback, one call)', async () => {
  const { scoreTaskForQC } = await import('../../src/lib/qc-scorer');
  setBox({ primary: `ollama/${SECOND}` });
  useJudge(GOOD);
  called = [];
  const r = await scoreTaskForQC(input());
  assert.equal(r.scoringPath, 'llm');
  assert.equal(r.judgeFallback, undefined);
  assert.deepEqual(called, [GOOD]);
});

test('[FB-5] fallback event is written once (deduped) and the sweep heals a model-gone FINAL card', async () => {
  const { queryAll, run, queryOne } = await import('../../src/lib/db');
  const { runQCReviewSweep } = await import('../../src/lib/jobs/qc-review-sweep');
  const now = new Date().toISOString();
  run(`INSERT OR IGNORE INTO sops (id, name, slug, success_criteria, steps, department, created_at, updated_at) VALUES ('sop-fb','SOP','sop-fb','Complete.', '[]','general-task',?,?)`, [now, now]);
  const mk = (id: string, finalMsg: string) => {
    run(`INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, sop_id, created_at, updated_at) VALUES (?, ?, 'desc', 'review', 'medium', NULL, NULL, 'sop-fb', ?, ?)`, [id, id, now, now]);
    const f = path.join(TMP_DIR, `${id}.txt`);
    fs.writeFileSync(f, 'x');
    run(`INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at) VALUES (?, ?, 'file', 't', ?, ?)`, [`d-${id}`, id, f, now]);
    run(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'qc_review', ?, ?, datetime('now','-2 hours'))`, [`e-${id}`, id, finalMsg]);
  };
  mk('heal-new', '[QC-JUDGE-FAILED-FINAL] [JUDGE-MODEL-GONE] Score: 5/10 judge died');
  mk('heal-legacy', '[QC-JUDGE-FAILED-FINAL] Score: 5/10 DETAIL: Ollama Cloud request failed: 410 Gone retired');
  mk('stay-final', '[QC-JUDGE-FAILED-FINAL] Score: 5/10 starved budget, empty content');
  setBox({ primary: `ollama/${GOOD}` });
  useJudge();
  await runQCReviewSweep();
  const st = (id: string) => queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])!.status;
  assert.equal(st('heal-new'), 'done');
  assert.equal(st('heal-legacy'), 'done');
  assert.equal(st('stay-final'), 'review', 'a non-model-level FINAL stays parked');
  const ev = queryAll<{ id: string }>(`SELECT id FROM events WHERE type = 'qc_judge_fallback'`);
  assert.equal(ev.length, 1, 'one deduped fallback event, no spam');
});

test('[FB-6] router-prefixed default (9router/<route>/<model>:cloud) resolves to the Ollama Cloud leaf', async () => {
  const { scoreTaskForQC } = await import('../../src/lib/qc-scorer');
  setBox({ primary: `9router/oc-route/${GOOD}` });
  useJudge();
  called = [];
  const r = await scoreTaskForQC(input());
  assert.equal(r.scoringPath, 'llm');
  assert.deepEqual(called, [RETIRED, GOOD]);
});
