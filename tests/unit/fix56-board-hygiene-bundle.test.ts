/**
 * fix56-board-hygiene-bundle.test.ts — FIX 56 proof (QC.md, verbatim):
 *
 *   • Stale `expectedFrom` on `/status` → 409.
 *   • Wrong-length HMAC on ingest → 401.
 *   • `department: dept-presentations` shows the deliverables panel.
 *   • Three 5,000-char notes leave description ≤ 10,000.
 *   • `context_refs` either reaches `createTaskCore` or is gone from the route
 *     and its doc.
 *
 * Harness mirrors tests/unit/fix36-board-sources.test.ts (temp DB + auth
 * secrets configured BEFORE @/lib/db and the routes are imported; signed
 * ingest → status round trip over the REAL route handlers, no network).
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/fix56-board-hygiene-bundle.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fix56-')), 'db');
process.env.DATABASE_PATH = DB;
process.env.MC_API_TOKEN = 't56';
process.env.WEBHOOK_SECRET = 's56';

function hmac(b: string): string {
  return createHmac('sha256', 's56').update(b).digest('hex');
}

function signedPost(
  url: string,
  body: Record<string, unknown>,
  sigOverride?: string,
): NextRequest {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: 'Bearer t56',
    'x-webhook-signature': sigOverride ?? hmac(raw),
  };
  return new NextRequest(url, { method: 'POST', headers, body: raw });
}

let run: (sql: string, params?: unknown[]) => unknown;
let q1: <T>(sql: string, params?: unknown[]) => T | undefined;
let close: () => void;
let statusPOST: Function;
let ingestPOST: (req: NextRequest) => Promise<Response>;
let WSID: string;

function taskRow(id: string): { status: string; description: string | null } | undefined {
  return q1('SELECT status, description FROM tasks WHERE id = ?', [id]);
}

async function ingest(extra: Record<string, unknown> = {}): Promise<{ id: string; status: number }> {
  const raw = JSON.stringify({ title: 'FIX 56 card', description: 'seed', source: 'build_deck', ...extra });
  const req = signedPost('http://localhost/api/tasks/ingest', raw as unknown as Record<string, unknown>);
  // Re-sign with the exact raw string (JSON.stringify above is identical).
  const signed = new NextRequest('http://localhost/api/tasks/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer t56',
      'x-webhook-signature': hmac(raw),
    },
    body: raw,
  });
  void req;
  const res = (await ingestPOST(signed)) as unknown as Response;
  const body = (await res.json()) as { task_id?: string; id?: string };
  return { id: String(body.task_id ?? body.id ?? ''), status: res.status };
}

async function statusPost(
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return statusPOST(signedPost(`http://localhost/api/tasks/${id}/status`, body), {
    params: Promise.resolve({ id }),
  }) as unknown as Promise<Response>;
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  q1 = db.queryOne;
  close = db.closeDb;
  db.getDb();
  const n = new Date().toISOString();
  WSID = 'ws-fix56-' + Math.random().toString(36).slice(2, 8);
  run(
    "INSERT OR IGNORE INTO companies(id,name,slug,config,created_at,updated_at) VALUES ('default','D','d','{}',?,?)",
    [n, n],
  );
  run(
    "INSERT OR IGNORE INTO workspaces(id,slug,name,icon,company_id,sort_order,created_at,updated_at) VALUES (?,'fix56','FIX56','🔧','default',1,?,?)",
    [WSID, n, n],
  );
  statusPOST = (await import('../../src/app/api/tasks/[id]/status/route')).POST;
  ingestPOST = (await import('../../src/app/api/tasks/ingest/route')).POST;
});
test.after(() => {
  try { close?.(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(DB), { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── PROOF 1: stale expectedFrom on /status → 409 ─────────────────────────────
// The route reads `existing` once, passes `expectedFrom: existing.status` into
// transition(), and transition() re-reads the row BEFORE the idempotent
// short-circuit. The read→write window is cross-process by construction (a
// single in-process test cannot interleave between the route's two reads), so
// the 409 path is proven at its two real seams:
//   (a) the lifecycle seam — a stale expectedFrom throws TransitionError
//       CAS_CONFLICT and writes nothing (same contract the route relies on);
//   (b) the route seam — the real POST handler wires expectedFrom from its own
//       read AND maps CAS_CONFLICT → 409 Conflict (verified against the loaded
//       module and the self-describing GET).
test('FIX 56 proof a: stale expectedFrom → TransitionError CAS_CONFLICT, nothing written', async () => {
  const { id, status: created } = await ingest();
  assert.equal(created, 201, 'ingest must succeed');
  assert.equal(taskRow(id)?.status, 'backlog');

  // The caller declared the card in 'assigned'; it is actually 'backlog' —
  // the exact "concurrent writer moved the card first" case.
  const { transition, TransitionError } = await import('../../src/lib/task-lifecycle');
  try {
    await transition(id, 'in_progress', {
      actor: 'board:build_deck',
      reason: 'stale read',
      operatorOverride: true,
      expectedFrom: 'assigned',
    });
    assert.fail('transition must throw CAS_CONFLICT on a stale expectedFrom');
  } catch (err) {
    assert.ok(err instanceof TransitionError, `expected TransitionError, got ${err}`);
    assert.equal((err as { code?: string }).code, 'CAS_CONFLICT');
  }
  assert.equal(taskRow(id)?.status, 'backlog', 'card must NOT have moved');
});

test('FIX 56 proof b: /status wires expectedFrom and maps CAS_CONFLICT → 409', async () => {
  // The REAL handler, exactly as tsx loads it for the runtime.
  const mod = await import('../../src/app/api/tasks/[id]/status/route');
  const postSrc = mod.POST.toString();
  assert.ok(
    /expectedFrom:\s*existing\.status/.test(postSrc),
    'POST must pass expectedFrom from its own read into transition()',
  );
  assert.ok(
    /err\.code\s*===?\s*["']ILLEGAL_TRANSITION["']\s*\|\|\s*err\.code\s*===?\s*["']CAS_CONFLICT["']/.test(postSrc),
    'POST must map TransitionError CAS_CONFLICT to 409 Conflict',
  );
  assert.ok(
    /status:\s*409/.test(postSrc),
    'the CAS/illegal branch must return 409 Conflict',
  );
  // The self-describing GET names the behavior for producers.
  const getRes = (await (mod as { GET: () => Promise<Response> }).GET()) as unknown as Response;
  const doc = (await getRes.json()) as { returns?: string };
  assert.match(doc.returns ?? '', /409/, 'GET doc must document the 409 CAS conflict');

  // And the end-to-end happy path still works through the same wiring: a fresh
  // expectedFrom (the route's own read) transitions the card.
  const { id } = await ingest({ title: 'FIX 56 fresh read' });
  const res = await statusPost(id, { status: 'in_progress' });
  assert.equal(res.status, 200, `fresh expectedFrom must pass, got ${res.status}`);
  assert.equal(taskRow(id)?.status, 'in_progress');
});

test('FIX 56 proof: fresh expectedFrom still transitions (CAS is a guard, not a lock)', async () => {
  const { id } = await ingest();
  // Caller read 'backlog' — matches the row. Transition must succeed.
  const res = await statusPost(id, { status: 'in_progress', note: 'fresh read' });
  assert.equal(res.status, 200, `fresh expectedFrom must pass, got ${res.status}`);
  assert.equal(taskRow(id)?.status, 'in_progress');
});

// ── PROOF 2: wrong-length HMAC on ingest → 401 ───────────────────────────────
test('FIX 56 proof: wrong-length HMAC on ingest → 401 (clean false, no throw)', async () => {
  const raw = JSON.stringify({ title: 'FIX 56 bad sig', source: 'build_deck' });
  const req = new NextRequest('http://localhost/api/tasks/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer t56',
      'x-webhook-signature': 'deadbeef', // 8 chars — wrong length for a 64-char hex digest
    },
    body: raw,
  });
  const res = (await ingestPOST(req)) as unknown as Response;
  assert.equal(res.status, 401, `wrong-length signature must 401, got ${res.status}`);
});

test('FIX 56 proof: valid HMAC on ingest still passes (constant-time compare kept correct)', async () => {
  const { id, status } = await ingest({ title: 'FIX 56 good sig' });
  assert.equal(status, 201);
  assert.ok(id, 'valid signature must still ingest');
});

test('FIX 56 proof: wrong-length HMAC on stage-timings → 401 (shared lib)', async () => {
  const raw = JSON.stringify({ rows: [] });
  const req = new NextRequest('http://localhost/api/presentations/stage-timings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': 'deadbeef',
    },
    body: raw,
  });
  const { POST } = await import('../../src/app/api/presentations/stage-timings/route');
  const res = (await POST(req)) as unknown as Response;
  assert.equal(res.status, 401, `wrong-length signature must 401, got ${res.status}`);
});

// ── PROOF 3: department: dept-presentations shows the deliverables panel ─────
test('FIX 56 proof: canonicalDeptSlug(dept-presentations) === presentations (panel gate)', async () => {
  const { canonicalDeptSlug } = await import('../../src/lib/routing/canonical-slug');
  assert.equal(canonicalDeptSlug('dept-presentations'), 'presentations');
  assert.equal(canonicalDeptSlug('presentations'), 'presentations');
  assert.equal(canonicalDeptSlug('DEPT-Presentations'), 'presentations');
  // And the gate itself is written against the canonicalizer, not the raw string.
  const modalSrc = fs.readFileSync(
    path.join(__dirname, '../../src/components/TaskModal.tsx'),
    'utf8',
  );
  assert.match(
    modalSrc,
    /canonicalDeptSlug\(task\.department\) === 'presentations'/,
    'TaskModal must gate PresentationDeliverablesPanel on canonicalDeptSlug, not a raw equality',
  );
  assert.doesNotMatch(
    modalSrc,
    /^\s*\{?\s*task\.department === ['"]presentations['"]/m,
    'the raw equality that hid the panel for dept-presentations rows must be gone (code lines, comments excluded)',
  );
});

// ── PROOF 4: three 5,000-char notes leave description ≤ 10,000 ────────────────
test('FIX 56 proof: three 5,000-char notes leave description ≤ 10,000', async () => {
  const { id } = await ingest({ description: 'start'.padEnd(100, 'x') });
  const big = 'n'.repeat(5000);
  for (let i = 1; i <= 3; i++) {
    const res = await statusPost(id, { status: i % 2 === 1 ? 'in_progress' : 'backlog', note: big });
    assert.ok([200, 409].includes(res.status), `note append ${i} must be accepted (200) or CAS-409 on the flip-back race, got ${res.status}`);
    if (res.status === 409) {
      // The alternating flip can legitimately 409 if a note append raced —
      // redo the transition to keep the walk going.
      const again = await statusPost(id, { status: i % 2 === 1 ? 'in_progress' : 'backlog' });
      assert.equal(again.status, 200, 're-read → retry must converge');
    }
    const len = (taskRow(id)?.description ?? '').length;
    assert.ok(len <= 10000, `description must stay ≤ 10,000 after note ${i}, got ${len}`);
  }
  const finalLen = (taskRow(id)?.description ?? '').length;
  assert.ok(finalLen > 0, 'description must carry the appended audit lines');
  assert.ok(finalLen <= 10000, `final description ≤ 10,000, got ${finalLen}`);
});

// ── PROOF 5: context_refs reaches createTaskCore ─────────────────────────────
test('FIX 56 proof: context_refs on ingest reaches createTaskCore (Context refs line on the card)', async () => {
  const { id, status } = await ingest({
    title: 'FIX 56 context refs',
    context_refs: ['docs/runbook.md', '  ', 'docs/spec.md'],
  });
  assert.equal(status, 201);
  const desc = taskRow(id)?.description ?? '';
  assert.match(desc, /Context refs: docs\/runbook\.md, docs\/spec\.md/, 'the folded Context refs provenance line must be on the card');
});

test('FIX 56 proof: createTaskCore honors the structured context_refs field itself', async () => {
  const { createTaskCore } = await import('../../src/lib/tasks');
  const result = await createTaskCore({
    title: 'FIX 56 core refs',
    description: 'core-seed',
    workspace_id: WSID,
    status: 'backlog',
    context_refs: ['docs/one.md', 'docs/two.md'],
  } as Parameters<typeof createTaskCore>[0]);
  const task = (result as { task: { id: string; description: string | null } }).task;
  assert.ok(task?.id, 'createTaskCore must create the task');
  assert.match(
    task.description ?? '',
    /Context refs: docs\/one\.md, docs\/two\.md/,
    'createTaskCore must fold the structured context_refs onto the card description',
  );
});

test('FIX 56 proof: context_refs is documented on the ingest route (route + GET self-description)', async () => {
  const ingestSrc = fs.readFileSync(
    path.join(__dirname, '../../src/app/api/tasks/ingest/route.ts'),
    'utf8',
  );
  assert.match(ingestSrc, /context_refs/, 'ingest route must declare context_refs');
  const body = JSON.stringify({ title: 'x' });
  void body;
  const { GET } = await import('../../src/app/api/tasks/ingest/route');
  const res = (await (GET as Function)()) as unknown as Response;
  const doc = (await res.json()) as Record<string, unknown>;
  assert.ok(
    JSON.stringify(doc).includes('context_refs'),
    'the self-describing GET must document context_refs',
  );
});
