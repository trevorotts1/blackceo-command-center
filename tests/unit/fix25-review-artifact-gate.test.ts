/**
 * FIX 25 — entering `review` requires completion evidence (real artifact rows),
 * NOT just a completed string. Closes the FOUR doors a zero-evidence completion
 * could previously walk through to reach review:
 *
 *   Door 1  task-lifecycle.ts checkPreconditions() — `case 'review': break;`
 *           was a no-op, so ANY transition() call with operatorOverride:true
 *           (webhook, watcher, status route) passed.
 *   Door 2  agent-completion webhook — direct task_id path AND session path:
 *           MR-18 wrote a soft `review_no_evidence` event and advanced anyway.
 *   Door 3  execution-watcher reconcile — chat-grep TASK_COMPLETE string then
 *           advanceToReview; the string was never matched against artifacts.
 *   Door 4  agent self-PATCH status=review — funnels through transition(),
 *           so the shared gate (Door 1) closes it and PATCH maps the thrown
 *           TransitionError to 422. Proven here through the real PATCH handler.
 *
 * FIX: the same completion-evidence invariant that guards `done` now also
 * guards `review`, placed ABOVE the operatorOverride bail-out so no door can
 * waive it. Flag: PRESENTATION_REVIEW_EVIDENCE_GATE (default ON, =0 restores
 * the pre-fix soft behavior — asserted in the rollback block).
 *
 * RED: before the fix, all zero/unreachable-evidence review moves SUCCEED, so
 * every "refused" assertion fails. GREEN: after the fix, all pass.
 *
 * LOCAL-ONLY: no network. The watcher path is driven through the real
 * transition() gate the reconcile funnels through (advanceToReview), with the
 * gateway transport stubbed when the full reconcile is exercised. DB is an
 * isolated temp file (import _isolated-db FIRST).
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';
import { transition, TransitionError } from '../../src/lib/task-lifecycle';
import { collectCompletionEvidence } from '../../src/lib/completion-evidence';
import { vi } from 'vitest';

// LOCAL-ONLY: stub the ONLY network touch on the watcher path (the OpenClaw
// gateway chat.history read) at the transport boundary. ESM module namespaces
// are sealed after evaluation, so the stub is installed via vi.mock (hoisted
// before any import of execution-watcher's dependency graph) and scripted
// per-test through `scriptedHistory`.
const gatewayStub = vi.hoisted(() => ({
  history: [] as Array<{ role: string; content: string }>,
}));
let scriptedHistory: Array<{ role: string; content: string }> = [];
vi.mock('../../src/lib/planning-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/planning-utils')>();
  return {
    ...actual,
    getMessagesFromOpenClaw: async () => gatewayStub.history,
  };
});

let fixtureDir: string;
let workspaceId: string;
let agentId: string;
let emptyTaskId: string;       // zero deliverables
let unreachableTaskId: string; // deliverable rows, all unreachable
let evidTaskId: string;        // reachable file + url deliverables (control)
let nonexistentPath: string;

function seedTask(id: string, title: string): void {
  getDb().prepare(
    `INSERT INTO tasks (id, title, status, priority, assigned_agent_id, workspace_id, department)
     VALUES (?, ?, 'in_progress', 'high', ?, ?, 'presentations')`,
  ).run(id, title, agentId, workspaceId);
}

function seedDeliverable(taskId: string, id: string, type: string, title: string, diskPath: string | null): void {
  getDb().prepare(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, taskId, type, title, diskPath);
}

function statusOf(taskId: string): string {
  return (getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status;
}

function eventCount(type: string): number {
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get(type) as { n: number };
  return r.n;
}

function reviewNoEvidenceEvents(taskId: string): number {
  const r = getDb().prepare(
    "SELECT COUNT(*) AS n FROM events WHERE type = 'review_no_evidence' AND task_id = ?",
  ).get(taskId) as { n: number };
  return r.n;
}

function taskCompletedEvents(taskId: string): number {
  const r = getDb().prepare(
    "SELECT COUNT(*) AS n FROM events WHERE type = 'task_completed' AND task_id = ?",
  ).get(taskId) as { n: number };
  return r.n;
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix25-'));
  nonexistentPath = path.join(fixtureDir, 'never-created.pptx');
  workspaceId = 'presentations';
  // companies parent row first: workspaces.company_id DEFAULT 'default' carries
  // a REFERENCES companies(id) and foreign_keys=ON, so a fresh isolated DB
  // refuses the workspace INSERT without it.
  if (!getDb().prepare('SELECT id FROM companies WHERE id = ?').get('default')) {
    getDb().prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)')
      .run('default', 'Default Company', 'default');
  }
  if (!getDb().prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)) {
    getDb().prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)')
      .run(workspaceId, 'Presentations', 'presentations', 'Presentation', 10);
  }
  agentId = '00000000-0000-4000-8000-00000000f125'; // uuid-shaped: PATCH's updated_by_agent_id is z.string().uuid()
  getDb().prepare(
    `INSERT INTO agents (id, name, role, status, workspace_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(agentId, 'FIX25 Builder', 'builder', 'working', workspaceId);

  emptyTaskId = `fix25-empty-${Date.now()}`;
  unreachableTaskId = `fix25-unreach-${Date.now()}`;
  evidTaskId = `fix25-evid-${Date.now()}`;
  seedTask(emptyTaskId, 'FIX25 no deliverables');
  seedTask(unreachableTaskId, 'FIX25 unreachable deliverables');
  seedTask(evidTaskId, 'FIX25 real deliverable');

  seedDeliverable(unreachableTaskId, `fix25-d1-${Date.now()}`, 'file', 'Ghost Deck', nonexistentPath);
  seedDeliverable(unreachableTaskId, `fix25-d2-${Date.now()}`, 'url', 'Broken Link', 'not-a-valid-url');

  const realFile = path.join(fixtureDir, 'deck.pptx');
  fs.writeFileSync(realFile, 'real deck bytes', 'utf-8');
  seedDeliverable(evidTaskId, `fix25-d3-${Date.now()}`, 'file', 'Real Deck', realFile);
  // The url row keeps the control green even while FIX 28's in-flight edit to
  // completion-evidence.ts (statSync import) lands or not — url usability is
  // shape-only and never touches the filesystem.
  seedDeliverable(evidTaskId, `fix25-d4-${Date.now()}`, 'url', 'Decision Link', 'https://example.com/fix25-evidence');

  // Sanity: the evidence helper itself must agree with the seeds.
  expect(collectCompletionEvidence(emptyTaskId).hasEvidence).toBe(false);
  expect(collectCompletionEvidence(unreachableTaskId).hasEvidence).toBe(false);
  expect(collectCompletionEvidence(evidTaskId).hasEvidence).toBe(true);
});

afterAll(() => {
  const db = getDb();
  // Children first (openclaw_sessions / task_activities reference tasks and
  // agents; onDelete cascades exist but the webhook also inserts legacy event
  // rows by task) so the teardown FK-checks clean.
  db.prepare('DELETE FROM openclaw_sessions WHERE agent_id = ?').run(agentId);
  db.prepare('DELETE FROM task_activities WHERE agent_id = ?').run(agentId);
  for (const t of [emptyTaskId, unreachableTaskId, evidTaskId]) {
    db.prepare('DELETE FROM task_deliverables WHERE task_id = ?').run(t);
    db.prepare('DELETE FROM task_events WHERE task_id = ?').run(t);
    db.prepare('DELETE FROM events WHERE task_id = ?').run(t);
    db.prepare('DELETE FROM task_activities WHERE task_id = ?').run(t);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t);
  }
  db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ok */ }
});

beforeEach(() => {
  // Reset all tasks to their pre-test source status.
  for (const t of [emptyTaskId, unreachableTaskId, evidTaskId]) {
    getDb().prepare('UPDATE tasks SET status = ?, assigned_agent_id = ?, completed_at = NULL WHERE id = ?')
      .run('in_progress', agentId, t);
  }
  // Earlier doors free the agent to standby on success; reset it so each test
  // observes its OWN door's side effects, not the previous test's.
  getDb().prepare('UPDATE agents SET status = ? WHERE id = ?').run('working', agentId);
  getDb().prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(agentId);
});

afterEach(() => {
  delete process.env.PRESENTATION_REVIEW_EVIDENCE_GATE;
});

// ─────────────────────────────────────────────────────────────────────────────
// Door 1 — the ONE shared gate: transition(to='review') with no evidence.
// operatorOverride:true is the exact shape webhook/watcher calls make; if this
// still succeeds pre-fix, every downstream door stands open.
// ─────────────────────────────────────────────────────────────────────────────
describe('FIX 25 door 1 — transition(in_progress → review) refuses without evidence', () => {
  it('refuses a zero-deliverable task even with operatorOverride', async () => {
    await expect(transition(emptyTaskId, 'review', {
      actor: agentId,
      reason: 'precondition check',
      operatorOverride: true,
    })).rejects.toMatchObject({ code: 'PRECONDITION_EVIDENCE' });
    expect(statusOf(emptyTaskId)).toBe('in_progress');
  });

  it('refuses a task whose deliverables are all unreachable, even with operatorOverride', async () => {
    await expect(transition(unreachableTaskId, 'review', {
      actor: agentId,
      reason: 'precondition check',
      operatorOverride: true,
    })).rejects.toMatchObject({ code: 'PRECONDITION_EVIDENCE' });
    expect(statusOf(unreachableTaskId)).toBe('in_progress');
  });

  it('names POST /api/tasks/{id}/deliverables in the refusal', async () => {
    let message = '';
    try {
      await transition(emptyTaskId, 'review', { actor: agentId, operatorOverride: true });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`/api/tasks/${emptyTaskId}/deliverables`);
    expect(message).toContain('review');
  });

  it('lets an evidenced task into review with the same evidence (control)', async () => {
    const updated = await transition(evidTaskId, 'review', {
      actor: agentId,
      reason: 'real artifact registered',
      operatorOverride: true,
    });
    expect(updated.status).toBe('review');
    expect(statusOf(evidTaskId)).toBe('review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Door 2a — webhook direct path: POST { task_id } with no evidence. Under the
// gate it must REFUSE: non-2xx, task stays in_progress, no task_completed,
// agent not freed to standby (the agent still owns the work), no success.
// ─────────────────────────────────────────────────────────────────────────────
async function postWebhook(body: Record<string, unknown>) {
  const { POST } = await import('../../src/app/api/webhooks/agent-completion/route');
  const req = new NextRequest('http://localhost/api/webhooks/agent-completion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req);
}

describe('FIX 25 door 2a — agent-completion webhook (direct task_id) refuses without evidence', () => {
  it('refuses a zero-deliverable completion: non-2xx, still in_progress, no task_completed, agent stays working', async () => {
    const beforeCompleted = eventCount('task_completed');
    const res = await postWebhook({ task_id: emptyTaskId, summary: 'Task finished' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const json = await res.json();
    expect(json.success).toBeFalsy();
    expect(json.new_status).toBeUndefined();
    expect(statusOf(emptyTaskId)).toBe('in_progress');
    expect(eventCount('task_completed')).toBe(beforeCompleted);
    expect((getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string }).status)
      .toBe('working');
  });

  it('refuses an unreachable-deliverable completion the same way', async () => {
    const res = await postWebhook({ task_id: unreachableTaskId, summary: 'Done (paths are fake)' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(statusOf(unreachableTaskId)).toBe('in_progress');
  });

  it('still accepts an evidenced completion into review (control)', async () => {
    const res = await postWebhook({ task_id: evidTaskId, summary: 'Deck produced' });
    expect(res.status).toBe(200);
    expect(statusOf(evidTaskId)).toBe('review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Door 2b — webhook session path: POST { session_id, message: TASK_COMPLETE }
// with no evidence. Same refusal contract as 2a.
// ─────────────────────────────────────────────────────────────────────────────
describe('FIX 25 door 2b — agent-completion webhook (session path) refuses without evidence', () => {
  beforeEach(() => {
    const sid = 'mission-control-fix25-agent';
    const existing = getDb().prepare(
      'SELECT id FROM openclaw_sessions WHERE openclaw_session_id = ? AND status = ? AND deleted_at IS NULL',
    ).get(sid, 'active');
    if (!existing) {
      getDb().prepare(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id)
         VALUES (?, ?, ?, 'mission-control', 'active', ?)`,
      ).run(`fix25-sess-${Date.now()}`, agentId, sid, emptyTaskId);
    }
  });

  it('refuses an unevidenced TASK_COMPLETE via session message', async () => {
    const beforeCompleted = eventCount('task_completed');
    const res = await postWebhook({
      session_id: 'mission-control-fix25-agent',
      message: 'TASK_COMPLETE: Built the deck (no artifact)',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const json = await res.json();
    expect(json.success).toBeFalsy();
    expect(json.new_status).toBeUndefined();
    expect(statusOf(emptyTaskId)).toBe('in_progress');
    expect(eventCount('task_completed')).toBe(beforeCompleted);
    expect((getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string }).status)
      .toBe('working');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Door 3 — execution-watcher reconcile. The reconcile's chat-grep lands on the
// same transition() funnel via advanceToReview, so the shared gate decides.
// We drive the REAL reconcile pipeline with a stubbed gateway transport (no
// network): one task whose live session history contains TASK_COMPLETE and
// zero deliverables must stay in_progress with the agent NOT freed; a second
// run with a real deliverable registered advances (control).
// ─────────────────────────────────────────────────────────────────────────────
describe('FIX 25 door 3 — execution-watcher reconcile refuses the zero-evidence chat marker', () => {
  it('leaves a TASK_COMPLETE-with-no-artifacts task in_progress across a reconcile tick', async () => {
    // Seed the active session the reconcile scans; the gateway transport is
    // vi.mock'd at module top (ESM namespaces are sealed — property stubbing
    // fails), so this test just flips the scripted response and runs the REAL
    // reconcile with no network.
    getDb().prepare(
      `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id)
       VALUES (?, ?, ?, 'mission-control', 'active', ?)`,
    ).run(`fix25-sess2-${Date.now()}`, agentId, 'agent:main:' + agentId, emptyTaskId);

    scriptedHistory = [{ role: 'assistant', content: 'All done. TASK_COMPLETE: deck assembled from vibes' }];
    gatewayStub.history = scriptedHistory;
    const beforeCompleted = taskCompletedEvents(emptyTaskId);
    const { runExecutionCompletionReconcile } = await import('../../src/lib/jobs/execution-watcher');
    await runExecutionCompletionReconcile();
    // The reconcile must NOT have advanced the task (refused) ...
    expect(statusOf(emptyTaskId)).toBe('in_progress');
    // ... and must NOT have logged a completion for it. (The agent-standby flag
    // cannot be asserted here: the same scripted session history is scanned for
    // ALL of this agent's tasks in one tick, and the evidenced CONTROL task
    // legitimately completes and frees the agent. The per-task audit trail is
    // the precise probe: refusal => zero task_completed rows for THIS task.)
    expect(taskCompletedEvents(emptyTaskId)).toBe(beforeCompleted);
    // While the evidenced control DID advance to review in the same tick.
    expect(statusOf(evidTaskId)).toBe('review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Door 4 — agent self-PATCH status=review. Funnelled through transition(), so
// the shared gate closes it; the PATCH route maps the TransitionError to 422.
// Driven through the REAL PATCH handler (agent attribution via
// updated_by_agent_id; no CF header — a scripted agent).
// ─────────────────────────────────────────────────────────────────────────────
describe('FIX 25 door 4 — self-PATCH status=review is refused by the shared gate', () => {
  it('returns 422 and leaves the task in_progress for a zero-evidence task', async () => {
    const { PATCH } = await import('../../src/app/api/tasks/[id]/route');
    const req = new NextRequest(`http://localhost/api/tasks/${unreachableTaskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'review', updated_by_agent_id: agentId }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: unreachableTaskId }) });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe('PRECONDITION_EVIDENCE');
    expect(statusOf(unreachableTaskId)).toBe('in_progress');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting: the gate outranks operatorOverride (it sits ABOVE the bail)
// and the refusal is observable on every door via review_no_evidence-style
// state, not a silent no-op. Rollback: flag =0 restores pre-fix behavior.
// ─────────────────────────────────────────────────────────────────────────────
describe('FIX 25 — documented rollback path (PRESENTATION_REVIEW_EVIDENCE_GATE=0)', () => {
  it('flag=0 restores the pre-fix soft behavior for an unevidenced review move', async () => {
    process.env.PRESENTATION_REVIEW_EVIDENCE_GATE = '0';
    const updated = await transition(emptyTaskId, 'review', {
      actor: agentId,
      reason: 'rollback behavior check',
      operatorOverride: true,
    });
    expect(updated.status).toBe('review');
  });
});
