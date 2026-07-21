/**
 * QC judge failure: correct DIAGNOSIS + bounded retry + escalation hatch.
 *
 * ── WHAT ACTUALLY HAPPENED (proved by reproduction on the live box) ─────────
 * The configured judge (`deepseek-v4-flash:cloud`) is a REASONING model: its
 * reply carries a hidden `reasoning` field alongside `content`, billed against
 * the SAME completion budget. `qc-scorer.ts` asked for `max_tokens: 300`. The
 * reasoning consumed the entire budget and `content` came back EMPTY.
 *   - max_tokens 300  → content empty
 *   - max_tokens 1500 → 587 completion tokens → clean parse → real verdict
 *
 * Two symptoms, one cause:
 *   - Empty content   → `if (!raw) return null` → logged "provider-down".
 *   - Partial content → truncated mid-`reason` → "Unterminated string at line 4
 *     column 52" (line 4 IS the reason field).
 *
 * ── THE DEFECTS THIS PINS ──────────────────────────────────────────────────
 * 1. BUDGET (`:967`): 300 was not marginally low, it was wrong by a factor.
 * 2. MISLABEL (`:971-972`): every judge failure collapsed into `return null` and
 *    the caller called ALL of them "provider-down". The provider was never down —
 *    it answered perfectly and the code blamed the network. That single wrong
 *    label sent three consecutive analyses chasing a routing problem that did
 *    not exist. A wrong diagnosis printed confidently is worse than none,
 *    because it looks like evidence.
 * 3. The six-day silence: the deferral retried forever and never escalated. Had
 *    the bounded hatch existed this would have surfaced in minutes. The
 *    escalation must report the REAL failure — escalating "provider-down" when
 *    we starved the budget rebuilds the defect one layer up.
 *
 * NOT tested here, because it was DISPROVED: the response envelope always parses
 * as a single document (`stream: false`). It is not newline-delimited and
 * `res.json()` never chokes. Routing, address and credentials are exonerated.
 *
 * The fake judge below encodes the PROVEN behaviour: reasoning costs ~587
 * completion tokens, so a budget under that yields empty content, and a budget
 * over it yields a real verdict.
 *
 * Isolated temp DB + a real loopback HTTP judge. No live calls, no secrets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qc-judge-fail-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

// Clean slate — a truly ambient-free box.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.QC_JUDGE_MODEL;
delete process.env.OLLAMA_CLOUD_API_KEY;
delete process.env.OLLAMA_API_KEY;
delete process.env.QC_SIMULATE_PROVIDER_DOWN;
delete process.env.QC_FIXTURE_JSON_PATH;
delete process.env.DISABLE_QC_AUTO_SCORER;
delete process.env.DISABLE_QC_REVIEW_SWEEP;
delete process.env.QC_JUDGE_MAX_TOKENS;

// Bound the retry tightly so termination is proved in bounded time.
const MAX_PASSES = 3;
process.env.QC_JUDGE_FAILURE_MAX_PASSES = String(MAX_PASSES);

const JUDGE_MODEL = 'ollama-cloud/deepseek-v4-flash:cloud';
const FINAL_MARKER = '[QC-JUDGE-FAILED-FINAL]';
const DEFER_MARKER = '[QC-DEFERRED-PROVIDER-DOWN]';

/** Completion tokens the reasoning field costs before ANY content is emitted. */
const REASONING_TOKEN_COST = 587;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type ScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: ScorerModule['runQCOnReview'];

type SweepModule = typeof import('../../src/lib/jobs/qc-review-sweep');
let runQCReviewSweep: SweepModule['runQCReviewSweep'];

type PromoteModule = typeof import('../../src/lib/qc-promote');
let getQcHeuristicPark: PromoteModule['getQcHeuristicPark'];

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}`;
const SOP_ID = 'sop-judge-failure-fixture';

function insertReviewTask(id: string) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, sop_id, created_at, updated_at)
     VALUES (?, ?, ?, 'review', 'medium', NULL, NULL, ?, ?, ?)`,
    [id, `Judge-failure task ${id}`, 'A completed deliverable ready for QC inspection.', SOP_ID, now, now],
  );
}

function qcMessages(taskId: string): string[] {
  return queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'qc_review' ORDER BY created_at ASC, rowid ASC`,
    [taskId],
  ).map((r) => r.message);
}

const countMatching = (taskId: string, needle: string) =>
  qcMessages(taskId).filter((m) => m.includes(needle)).length;

// ── A fake Ollama Cloud judge that behaves like the REAL reasoning model ─────
type JudgeMode = 'reasoning' | 'truncate';
let judgeMode: JudgeMode = 'reasoning';
let capturedRequests: Array<{ max_tokens?: number; model?: string }> = [];
let judgeServer: http.Server;
let judgeUrl = '';

function startJudge(): Promise<void> {
  return new Promise((resolve) => {
    judgeServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const reqJson = JSON.parse(body || '{}');
        capturedRequests.push(reqJson);
        const budget: number = reqJson.max_tokens ?? 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });

        if (judgeMode === 'truncate') {
          // The exact live signature: cut off mid-`reason` (line 4) by the budget.
          const cut = '{\n  "score": 2,\n  "pass": false,\n  "reason": "The deliverable is missing the';
          res.end(
            JSON.stringify({
              choices: [{ index: 0, message: { role: 'assistant', content: cut }, finish_reason: 'length' }],
              usage: { completion_tokens: budget },
            }),
          );
          return;
        }

        // Reasoning model: the reasoning field is emitted FIRST and billed against
        // the same budget. Under REASONING_TOKEN_COST it eats everything and
        // content arrives EMPTY — the proven 300-token behaviour.
        if (budget < REASONING_TOKEN_COST) {
          res.end(
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: '', reasoning: 'r'.repeat(budget * 4) },
                  finish_reason: 'length',
                },
              ],
              usage: { completion_tokens: budget },
            }),
          );
          return;
        }

        // Budget fits: reasoning completes AND a real verdict is emitted.
        res.end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    score: 9.2,
                    pass: true,
                    reason: 'Deliverable meets every stated success criterion.',
                    gaps: [],
                  }),
                  reasoning: 'r'.repeat(1200),
                },
                finish_reason: 'stop',
              },
            ],
            usage: { completion_tokens: REASONING_TOKEN_COST },
          }),
        );
      });
    });
    judgeServer.listen(0, '127.0.0.1', () => {
      judgeUrl = `http://127.0.0.1:${(judgeServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

/** Point the scorer at the fake judge. */
function useJudge(url = judgeUrl) {
  process.env.QC_JUDGE_MODEL = JUDGE_MODEL;
  process.env.OLLAMA_CLOUD_API_KEY = 'fake-ollama-key';
  process.env.OLLAMA_CLOUD_BASE_URL = url;
}
function clearJudge() {
  delete process.env.QC_JUDGE_MODEL;
  delete process.env.OLLAMA_CLOUD_API_KEY;
  delete process.env.OLLAMA_CLOUD_BASE_URL;
  delete process.env.QC_JUDGE_MAX_TOKENS;
}

test.before(async () => {
  await startJudge();
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb();

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, success_criteria, steps, department, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      SOP_ID,
      'Judge-failure Fixture SOP',
      'judge-failure-fixture',
      'Deliverable must be complete, verified, and meet all stated requirements.',
      JSON.stringify([{ step: 1, action: 'Complete the deliverable' }]),
      'general-task',
      now,
      now,
    ],
  );

  const scorer = await import('../../src/lib/qc-scorer');
  runQCOnReview = scorer.runQCOnReview;
  runQCReviewSweep = (await import('../../src/lib/jobs/qc-review-sweep')).runQCReviewSweep;
  getQcHeuristicPark = (await import('../../src/lib/qc-promote')).getQcHeuristicPark;
});

test.after(async () => {
  clearJudge();
  delete process.env.QC_JUDGE_FAILURE_MAX_PASSES;
  delete process.env.QC_SIMULATE_PROVIDER_DOWN;
  try { closeDb(); } catch { /* ignore */ }
  await new Promise<void>((r) => judgeServer.close(() => r()));
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── 1: the budget fix, proved end-to-end ────────────────────────────────────
test('[BUDGET-1] a REASONING judge now gets a budget that fits — real verdict instead of empty content', async () => {
  judgeMode = 'reasoning';
  capturedRequests = [];
  useJudge();
  const id = nextId('budget-e2e');
  insertReviewTask(id);

  // The completion-evidence gate (src/lib/completion-evidence.ts) now refuses
  // `done` unless the task has at least one registered, reachable deliverable.
  // This test proves the judge budget fix, not the evidence gate, so give the
  // fixture a real file-backed deliverable to satisfy that separate invariant.
  const deliverablePath = path.join(TMP_DIR, `${id}.txt`);
  fs.writeFileSync(deliverablePath, 'delivered\n');
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, 'file', ?, ?, ?)`,
    [nextId('deliv'), id, `deliverable for ${id}`, deliverablePath, new Date().toISOString()],
  );

  try {
    const result = await runQCOnReview(id);
    assert.ok(result, 'must return a result');
    // On the broken code max_tokens=300 → reasoning eats it → content empty →
    // heuristic 'provider-down'. The whole six-day incident, in one assertion.
    assert.equal(
      result.scoringPath,
      'llm',
      `the judge must produce a REAL verdict, not a heuristic fallback ` +
        `(scoringPath=${result.scoringPath}, heuristicReason=${result.heuristicReason}) — ` +
        `a 300-token budget starves a reasoning model's content field`,
    );
    assert.ok(result.pass, 'the fixture verdict (9.2) passes the gate');
  } finally {
    clearJudge();
  }

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id]);
  assert.equal(task!.status, 'done', 'a real passing verdict auto-advances review→done');
});

// ── 2: the budget actually sent on the wire ─────────────────────────────────
test('[BUDGET-2] the judge call requests a completion budget that fits a reasoning model', async () => {
  judgeMode = 'reasoning';
  capturedRequests = [];
  useJudge();
  const id = nextId('budget-wire');
  insertReviewTask(id);
  try {
    await runQCOnReview(id);
  } finally {
    clearJudge();
  }

  assert.ok(capturedRequests.length > 0, 'the judge must actually have been called');
  const sent = capturedRequests[capturedRequests.length - 1].max_tokens ?? 0;
  // Observed need: 587 completion tokens. 300 is wrong by a factor; require real
  // headroom, not a snug fit that re-arms the trap on a harder prompt.
  assert.ok(
    sent >= 1500,
    `max_tokens must leave real headroom over the observed 587-token need (got ${sent}). ` +
      `300 is what caused the six-day outage.`,
  );
});

// ── 3: THE MISLABEL — empty content is NEVER "provider-down" ────────────────
test('[LABEL-1] empty content from a healthy provider is diagnosed as a BUDGET/empty-response fault, never provider-down', async () => {
  judgeMode = 'reasoning';
  useJudge();
  // Force the starved budget the live box had.
  process.env.QC_JUDGE_MAX_TOKENS = '300';
  const id = nextId('label-empty');
  insertReviewTask(id);

  try {
    const result = await runQCOnReview(id);
    assert.ok(result, 'must return a result');
    assert.equal(
      result.heuristicReason,
      'judge-empty-response',
      `an EMPTY answer from a provider that ANSWERED must be labelled 'judge-empty-response' ` +
        `(got '${result.heuristicReason}'). The provider was never down — calling this ` +
        `'provider-down' is what sent three analyses chasing a routing problem that did not exist.`,
    );
    assert.ok(
      /budget|max_tokens|reasoning/i.test(result.judgeFailureDetail ?? ''),
      `the detail must point at the completion budget, not the network (got: ${result.judgeFailureDetail})`,
    );
  } finally {
    clearJudge();
  }

  // The board event must not tell a human the provider is down either.
  const msg = qcMessages(id).find((m) => m.includes(DEFER_MARKER));
  assert.ok(msg, 'a deferral event must be written');
  assert.ok(/provider is UP/i.test(msg!), `the event must state the provider is UP (got: ${msg})`);
});

// ── 4: truncated mid-JSON is reported, not swallowed ────────────────────────
test('[LABEL-2] content truncated mid-JSON by the budget is diagnosed as malformed-response and never silently swallowed', async () => {
  judgeMode = 'truncate';
  useJudge();
  const id = nextId('label-trunc');
  insertReviewTask(id);

  try {
    const result = await runQCOnReview(id);
    assert.equal(
      result!.heuristicReason,
      'judge-malformed-response',
      `a truncated reply must be labelled 'judge-malformed-response' (got '${result!.heuristicReason}')`,
    );
    const detail = result!.judgeFailureDetail ?? '';
    // The live signature was "Unterminated string at line 4 column 52".
    assert.ok(
      /unterminated|json|parse/i.test(detail),
      `the parser error must be surfaced verbatim, not swallowed (got: ${detail})`,
    );
    assert.ok(
      /finish_reason=length/i.test(detail),
      `finish_reason=length is the definitive budget-truncation evidence and must be reported (got: ${detail})`,
    );
    assert.ok(/provider is UP/i.test(detail), 'a truncated reply means the provider is UP');
  } finally {
    judgeMode = 'reasoning';
    clearJudge();
  }
});

// ── 5: a genuinely unreachable provider is STILL called provider-down ───────
test('[LABEL-3] an unreachable provider is distinctly labelled provider-down (the one case that name is true)', async () => {
  useJudge('http://127.0.0.1:1'); // reserved port, nothing listening → ECONNREFUSED
  const id = nextId('label-unreach');
  insertReviewTask(id);

  try {
    const result = await runQCOnReview(id);
    assert.equal(
      result!.heuristicReason,
      'provider-down',
      `a provider that never answers IS down (got '${result!.heuristicReason}')`,
    );
    assert.ok(
      (result!.judgeFailureDetail ?? '').includes('127.0.0.1:1'),
      'the detail must name the address that did not answer',
    );
  } finally {
    clearJudge();
  }
});

// ── 6: the hatch — empty-response terminates and escalates the REAL cause ───
test('[HATCH-1] a starved-budget judge TERMINATES and escalates naming the budget — never loops, never blames the network', async () => {
  judgeMode = 'reasoning';
  useJudge();
  process.env.QC_JUDGE_MAX_TOKENS = '300'; // reproduce the live starvation
  const id = nextId('hatch-empty');
  insertReviewTask(id);

  try {
    for (let i = 0; i < MAX_PASSES + 3; i++) await runQCOnReview(id);
  } finally {
    clearJudge();
  }

  assert.equal(
    countMatching(id, FINAL_MARKER),
    1,
    `must escalate EXACTLY ONCE to ${FINAL_MARKER} — the six-day silence is the bug`,
  );
  assert.ok(
    countMatching(id, DEFER_MARKER) < MAX_PASSES + 3,
    'deferrals must be BOUNDED, not one-per-pass forever (the six-day signature)',
  );

  const finalMsg = qcMessages(id).find((m) => m.includes(FINAL_MARKER))!;
  // The escalation must report the REAL failure, not a guessed category.
  assert.ok(/EMPTY/i.test(finalMsg), 'the escalation must say the content was EMPTY');
  assert.ok(/provider is UP/i.test(finalMsg), 'the escalation must say the provider is UP');
  assert.ok(
    /QC_JUDGE_MAX_TOKENS/.test(finalMsg),
    'the escalation must prescribe the fix that matches the observed failure (the budget)',
  );
  assert.ok(
    !/CHECK THE ADDRESS FIRST/i.test(finalMsg),
    'the escalation must NOT send the reader hunting the address — that is the wrong lead that burned three analyses',
  );
  assert.ok(finalMsg.includes(JUDGE_MODEL), 'the escalation must name the judge model');

  const task = queryOne<{ status: string; qc_reroute_attempts: number | null }>(
    'SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(task!.status, 'review', 'escalated task stays board-visible in review');
  assert.equal(task!.qc_reroute_attempts ?? 0, 0, 'a judge fault must never burn the task reroute budget');
});

// ── 7: the hatch — unreachable terminates and escalates, distinctly ─────────
test('[HATCH-2] an unreachable judge TERMINATES and escalates, distinctly labelled and naming the address', async () => {
  useJudge('http://127.0.0.1:1');
  const id = nextId('hatch-unreach');
  insertReviewTask(id);

  try {
    for (let i = 0; i < MAX_PASSES + 3; i++) await runQCOnReview(id);
  } finally {
    clearJudge();
  }

  assert.equal(countMatching(id, FINAL_MARKER), 1, 'an unreachable judge must also escalate exactly once');
  assert.ok(countMatching(id, DEFER_MARKER) < MAX_PASSES + 3, 'deferrals must be bounded here too');

  const finalMsg = qcMessages(id).find((m) => m.includes(FINAL_MARKER))!;
  assert.ok(/UNREACHABLE|never answered/i.test(finalMsg), 'must be labelled as genuinely unreachable');
  assert.ok(finalMsg.includes('127.0.0.1:1'), 'must name the address it tried to reach');
  assert.ok(
    /OLLAMA_CLOUD_BASE_URL/.test(finalMsg),
    'for a REAL outage, pointing at the address IS the right lead',
  );
  // The two failures must not read alike.
  assert.ok(!/content was EMPTY/i.test(finalMsg), 'an unreachable provider did not answer with empty content');
});

// ── 8: the sweep excludes an escalated task permanently ────────────────────
test('[HATCH-3] qc-review-sweep excludes an escalated task PERMANENTLY — the silent retry loop is dead', async () => {
  const id = nextId('sweep-excluded');
  insertReviewTask(id);
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'qc_review', ?, ?, datetime('now', '-6 days'))`,
    [nextId('evt'), id, `${FINAL_MARKER} judge answered EMPTY — completion budget starved`],
  );

  const before = qcMessages(id).length;
  await runQCReviewSweep();
  assert.equal(qcMessages(id).length, before, 'an escalated task must NEVER be re-scored by the sweep again');
  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id]);
  assert.equal(task!.status, 'review', 'it stays board-visible in review for a human');
});

// ── 9: escalated must NOT look identical to "still working" ────────────────
test('[HATCH-4] an escalated task is DISTINGUISHABLE from one merely still working', async () => {
  const working = nextId('still-working');
  insertReviewTask(working);
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'qc_review', ?, ?, datetime('now'))`,
    [nextId('evt'), working, `${DEFER_MARKER} Score: 5.0/10 | judge produced no verdict — auto-rescoring.`],
  );
  assert.equal(getQcHeuristicPark(working), null, 'a task still working raises no human-facing park');

  const stuck = nextId('escalated');
  insertReviewTask(stuck);
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'qc_review', ?, ?, datetime('now'))`,
    [nextId('evt'), stuck, `${FINAL_MARKER} Score: 5.0/10 | judge answered EMPTY — MANUAL REVIEW REQUIRED.`],
  );
  const park = getQcHeuristicPark(stuck);
  assert.ok(park, 'an ESCALATED task MUST surface a human-facing park — silence is the entire bug');
  assert.equal(park!.marker, 'QC-JUDGE-FAILED-FINAL', 'labelled as the judge-failure terminal state');
});

// ── 10: no regression — a blip under the bound still defers ────────────────
test('[HATCH-5] regression: a genuine blip under the bound still defers and stays sweep-eligible', async () => {
  process.env.QC_JUDGE_MODEL = JUDGE_MODEL;
  process.env.OLLAMA_CLOUD_API_KEY = 'fake-ollama-key';
  process.env.QC_SIMULATE_PROVIDER_DOWN = '1';

  const id = nextId('blip');
  insertReviewTask(id);
  try {
    const result = await runQCOnReview(id);
    assert.equal(result!.heuristicReason, 'provider-down', 'a simulated outage is a genuine provider-down');
  } finally {
    clearJudge();
    delete process.env.QC_SIMULATE_PROVIDER_DOWN;
  }

  assert.equal(countMatching(id, DEFER_MARKER), 1, 'first blip writes the ordinary deferral marker');
  assert.equal(countMatching(id, FINAL_MARKER), 0, 'a single blip must NOT escalate — that would be alarm noise');
  assert.equal(getQcHeuristicPark(id), null, 'a deferred blip raises no human-facing park');
});
