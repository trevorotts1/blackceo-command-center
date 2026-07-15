/**
 * report-back-invariant.test.ts — U95 / U-X5 (master spec Section X.2,
 * exec-summary item 12): "the trust engine's report-back loop is well-built
 * and verified (CLAIM-then-send outbox, requester-only lane, quiet hours);
 * the residual is requester-stamp coverage [U94] + an invariant test that no
 * code path but the trust engine ever messages a requester [U95]."
 *
 * Doctrine pinned (Section X.2.1): "ONLY the trust engine speaks to the
 * requester, keyed strictly off `requester_chat_id` ... Any new surface that
 * spawns work MUST NOT add any new direct-to-client send path."
 *
 * TWO-PART BINARY ACCEPTANCE (U-X5's own "what"):
 *   (a) STATICALLY — the only call sites of notifyTelegram() targeting
 *       `requester_chat_id` live in trust-engine.ts (scripts/guard-
 *       report-back-invariant.sh). Proven here with a MUTATION PROOF: a
 *       planted rogue sender in a throwaway scratch tree makes the guard
 *       FAIL, and removing it makes the guard PASS again — teeth, not just
 *       a green checkmark.
 *   (b) BEHAVIORALLY — a worker completing/failing a fixture task produces
 *       ZERO client-lane sends outside the trust engine's own stamped plan,
 *       and a worker failure path goes through return-to-orchestrator
 *       (task_returned event + backlog transition + reroute-cap-3
 *       escalation, per that route's own header contract).
 *
 * SAFETY OF THIS TEST ITSELF: Section B never lets the real `openclaw`
 * binary become reachable during a probe — PATH is restricted to a stub
 * directory whenever a send is possible, mirroring the proven-safe pattern
 * in tests/unit/notify-no-send-in-tests.test.ts.
 *
 *   node --import tsx --test tests/unit/report-back-invariant.test.ts
 *   (or: npm run test:unit, which globs this file in automatically)
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_TRUST_ENGINE;

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

import './_isolated-db'; // MUST precede any '@/lib/db' import: throwaway DATABASE_PATH.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'guard-report-back-invariant.sh');

// ============================================================================
// SECTION A — STATIC CALL-SITE GUARD + MUTATION PROOF (acceptance part 'a')
// ============================================================================

/** Minimal stub file content carrying BOTH tokens the guard co-occurrence
 *  check looks for, so a scratch fixture can stand in for real source without
 *  copying the real repo tree. */
const SENDER_STUB = [
  '// scratch fixture — stands in for a real requester-messaging call site.',
  'export const REQUESTER_COLUMN = "requester_chat_id";',
  'function send(chatId: string, message: string) {',
  '  return notifyTelegram({ chatId, message });',
  '}',
].join('\n');

const REQUESTER_ONLY_STUB = [
  '// negative control: mentions requester_chat_id but never sends anything.',
  'export const REQUESTER_COLUMN = "requester_chat_id";',
].join('\n');

// NOTE: this fixture's CONTENT must never contain the watched column-name
// token (see the guard's co-occurrence check) — otherwise it stops being a
// valid negative control. Its comment deliberately describes the pattern in
// prose instead of naming the literal column, mirroring sop-auto-replace.ts /
// sop-authoring.ts (real owner-lane senders that route via
// findClientChatId()=resolveOwnerChatId(), a box-level resolver, never a
// specific task's per-row requester field).
const SENDER_ONLY_STUB = [
  '// negative control: an owner-lane sender — calls notifyTelegram() with a',
  '// box-level chat id resolved independently of any particular task row.',
  'function send(chatId: string, message: string) {',
  '  return notifyTelegram({ chatId, message });',
  '}',
].join('\n');

function runGuard(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(GUARD, args, { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function makeScratchTree(): { root: string; jobsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-back-guard-fixture-'));
  const jobsDir = path.join(root, 'src', 'lib', 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  // Mirror the real allowlist baseline so the fixture PASSES before mutation.
  fs.writeFileSync(path.join(jobsDir, 'trust-engine.ts'), SENDER_STUB, 'utf8');
  fs.writeFileSync(path.join(jobsDir, 'board-hygiene.ts'), SENDER_STUB, 'utf8');
  return { root, jobsDir };
}

test('[STATIC] guard PASSES against the real repository tree — pins the current, audited allowlist', () => {
  const { status, stdout, stderr } = runGuard();
  assert.equal(status, 0, `expected PASS against the real tree, got:\n${stdout}${stderr}`);
  assert.match(stdout, /src\/lib\/jobs\/trust-engine\.ts/);
  assert.match(stdout, /src\/lib\/jobs\/board-hygiene\.ts/);
});

test('[STATIC][MUTATION PROOF] the guard FAILS when a rogue requester-send call site is planted, and PASSES once it is removed', () => {
  const { root, jobsDir } = makeScratchTree();
  try {
    // Baseline: the allowlisted pair alone must PASS.
    const baseline = runGuard(['--root', root]);
    assert.equal(baseline.status, 0, `expected baseline PASS, got:\n${baseline.stdout}${baseline.stderr}`);

    // MUTATION: plant a rogue sender OUTSIDE the allowlist — a new file that
    // both references requester_chat_id and calls notifyTelegram(.
    const roguePath = path.join(jobsDir, 'rogue-sender.ts');
    fs.writeFileSync(roguePath, SENDER_STUB, 'utf8');

    const mutated = runGuard(['--root', root]);
    assert.equal(
      mutated.status,
      1,
      `expected the guard to FAIL on the planted rogue sender, got exit ${mutated.status}:\n${mutated.stdout}${mutated.stderr}`,
    );
    assert.match(mutated.stdout, /INVARIANT VIOLATED/);
    assert.match(mutated.stdout, /rogue-sender\.ts/, 'the violation report must name the offending file');

    // HEAL: remove the rogue file — the guard must go back to a clean PASS.
    fs.rmSync(roguePath);
    const healed = runGuard(['--root', root]);
    assert.equal(
      healed.status,
      0,
      `expected PASS after removing the rogue sender, got exit ${healed.status}:\n${healed.stdout}${healed.stderr}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[STATIC] negative controls — mentioning requester_chat_id alone, or calling notifyTelegram() alone (an owner-lane sender), is NOT a violation', () => {
  const { root, jobsDir } = makeScratchTree();
  try {
    fs.writeFileSync(path.join(jobsDir, 'stamps-only.ts'), REQUESTER_ONLY_STUB, 'utf8');
    fs.writeFileSync(path.join(jobsDir, 'owner-lane-sender.ts'), SENDER_ONLY_STUB, 'utf8');

    const result = runGuard(['--root', root]);
    assert.equal(
      result.status,
      0,
      `a requester_chat_id-only reference and an owner-lane-only sender must never trip the guard ` +
        `(it targets the co-occurrence, not either token alone), got:\n${result.stdout}${result.stderr}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION B — BEHAVIORAL FIXTURE (acceptance part 'b'): worker paths produce
// ZERO client-lane sends outside the trust engine's own stamped plan.
// ============================================================================

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'report-back-behavior-'));
const SENTINEL = path.join(TMP_ROOT, 'openclaw-was-invoked.log');
const SHIM_DIR = path.join(TMP_ROOT, 'bin');
fs.mkdirSync(SHIM_DIR, { recursive: true });
// A stub `openclaw` that records every invocation. Absolute shebang, so it
// runs even when PATH is restricted to SHIM_DIR alone (see notify-no-send-
// in-tests.test.ts, the proven-safe precedent this mirrors).
fs.writeFileSync(
  path.join(SHIM_DIR, 'openclaw'),
  `#!/bin/sh\necho "invoked: $@" >> ${JSON.stringify(SENTINEL)}\n`,
  { mode: 0o755 },
);
// Isolate: never let this file resolve a real workspace/config while probing.
process.env.OPENCLAW_WORKSPACE_PATH = path.join(TMP_ROOT, 'workspace');
fs.mkdirSync(process.env.OPENCLAW_WORKSPACE_PATH, { recursive: true });
const REAL_PATH = process.env.PATH ?? '';

async function sentinelAppeared(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(SENTINEL)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function resetSentinel(): void {
  fs.rmSync(SENTINEL, { force: true });
}

type DbModule = typeof import('../../src/lib/db');
type ReturnRouteModule = typeof import('../../src/app/api/tasks/[id]/return-to-orchestrator/route');
type EngineModule = typeof import('../../src/lib/jobs/trust-engine');

let db: DbModule;
let returnRoute: ReturnRouteModule;
let engine: EngineModule;

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  returnRoute = await import('../../src/app/api/tasks/[id]/return-to-orchestrator/route');
  engine = await import('../../src/lib/jobs/trust-engine');
});

test.after(() => {
  try { db.closeDb(); } catch { /* ignore */ }
  process.env.PATH = REAL_PATH;
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

let fixtureCounter = 0;
function insertFixtureTask(status: string): string {
  const id = `rbi-${++fixtureCounter}-${uuidv4()}`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, title, status, workspace_id, business_id, requester_channel,
        requester_chat_id, qc_reroute_attempts, created_at, updated_at, last_progress_at)
     VALUES (?, ?, ?, NULL, NULL, 'telegram', ?, 0, ?, ?, ?)`,
    [id, `Report-back invariant fixture ${id}`, status, `req-${id}`, now, now, now],
  );
  return id;
}

function handback(id: string, note: string) {
  return returnRoute.POST(
    new NextRequest(`http://localhost/api/tasks/${id}/return-to-orchestrator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        problem: note,
        what_i_tried: 'attempted the assigned work via the normal doer path',
        what_i_think_it_needs: 'a different specialist / more context',
      }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

test('[BEHAVIOR] worker FAILURE path (return-to-orchestrator) never messages the client directly — task_returned + backlog every time, cap-3 escalation, ZERO client-lane sends', async () => {
  process.env.PATH = SHIM_DIR; // real `openclaw` unreachable — belt-and-braces.
  resetSentinel();
  const id = insertFixtureTask('in_progress');

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = (await handback(id, `attempt ${attempt} failed`)) as unknown as Response;
    assert.equal(res.status, 200, `handback ${attempt} must succeed`);
    const body = (await res.json()) as { status: string; reroute_attempts: number; cap_reached: boolean };
    assert.equal(body.status, 'backlog', `handback ${attempt}: response must report backlog`);
    assert.equal(body.reroute_attempts, attempt);

    const row = db.queryOne<{ status: string; qc_reroute_attempts: number }>(
      'SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?',
      [id],
    );
    assert.equal(row?.status, 'backlog', `handback ${attempt}: DB status must be backlog`);
    assert.equal(row?.qc_reroute_attempts, attempt);

    const returnedCount = db.queryAll<{ id: string }>(
      `SELECT id FROM events WHERE task_id = ? AND type = 'task_returned'`,
      [id],
    ).length;
    assert.equal(returnedCount, attempt, `a task_returned event must accumulate on every handback (${attempt} so far)`);

    const escalated = db.queryOne<{ id: string }>(
      `SELECT id FROM events WHERE task_id = ? AND type = 'task_escalated'`,
      [id],
    );
    if (attempt < 3) {
      assert.equal(escalated, undefined, `handback ${attempt}: no operator escalation before the cap`);
      assert.equal(body.cap_reached, false);
    } else {
      assert.ok(escalated, 'handback 3 (the cap, MAX_REROUTES default): a task_escalated event must be recorded');
      assert.equal(body.cap_reached, true, 'the route must report cap_reached at attempt 3');
    }
  }

  // The requester's own report-back stamps must be UNTOUCHED by the failure
  // path — return-to-orchestrator is not a messaging surface at all, only a
  // handback/audit one.
  const finalRow = db.queryOne<{
    ack_sent_at: string | null;
    progress_last_sent_at: string | null;
    completion_sent_at: string | null;
  }>(
    'SELECT ack_sent_at, progress_last_sent_at, completion_sent_at FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(finalRow?.ack_sent_at, null);
  assert.equal(finalRow?.progress_last_sent_at, null);
  assert.equal(finalRow?.completion_sent_at, null);

  assert.equal(
    await sentinelAppeared(500),
    false,
    'the worker-failure path (3 handbacks, including the cap-3 escalation) must NEVER invoke the client-messaging gateway',
  );

  process.env.PATH = REAL_PATH;
});

test('[BEHAVIOR] worker COMPLETION write (marking a task done) is silent by itself — only an explicit trust-engine sweep may ever send, and it stamps what it sends', async () => {
  process.env.PATH = SHIM_DIR;
  resetSentinel();
  const id = insertFixtureTask('in_progress');

  // Simulate the worker/write-back marking the task done directly at the DB
  // layer (what a doer's authenticated PATCH write-back ultimately performs)
  // WITHOUT invoking the trust engine at all — this is the raw completion
  // event a worker produces.
  db.run(`UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);

  assert.equal(
    await sentinelAppeared(500),
    false,
    'a raw worker completion write must never itself dispatch a client message',
  );

  // ANTI-VACUOUS: prove the harness genuinely detects a send when the ONE
  // legitimate path — the trust engine's own sweep — actually fires one.
  // Without this, the negative assertions above would be equally "true" if
  // the harness were simply broken and captured nothing, ever.
  const savedGate = process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  try {
    const result = engine.runTrustEngineSweep({ taskId: id, now: new Date(2026, 6, 15, 15, 0, 0) });
    assert.equal(result.sent, 1, 'the trust-engine sweep must be the one path that actually sends');
    assert.equal(
      await sentinelAppeared(3000),
      true,
      'the stub must capture the trust-engine dispatch — otherwise the negatives above prove nothing',
    );

    const row = db.queryOne<{ completion_sent_at: string | null }>(
      'SELECT completion_sent_at FROM tasks WHERE id = ?',
      [id],
    );
    assert.ok(row?.completion_sent_at, "the one send that happened must be the trust engine's own claimed/stamped plan");
  } finally {
    delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
    if (savedGate !== undefined) process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = savedGate;
    process.env.PATH = REAL_PATH;
  }
});
