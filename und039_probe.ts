/**
 * UND-039 / A39 probe — selected/stored/dispatched/used hash mismatch across
 * the LIVE comparison path, run against the REAL CC modules at
 * worktrees/cc-und039 (origin/main af71ebf8 + und039/a39-hash-mismatch).
 *
 * Two defects this probe must catch on the pre-fix tree and pass after:
 *   DETECT   stored-vs-dispatched was compared NOWHERE on the record path
 *            (comparePersonaManifest measures the REPORT against dispatched;
 *            a stored rebuild after dispatch was silent).
 *   VISIBLE  the reason now rides the events row + the tasks GET board row so
 *            the MissionQueue chip can tell producer divergence from a moved
 *            stored decision (pre-fix the chip claimed the producer diverged).
 *
 * Ran with: PATH=/opt/homebrew/opt/node@20/bin:$PATH node@20 --import tsx
 * Import ORDER (matters): env FIRST, then db (migrates), then modules.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'und039-a39-'));
process.env.DATABASE_PATH = path.join(TEMP, 'a39.db');
process.env.CC_TEST_FIXTURE_ROOT = TEMP;
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.PERSONA_FIXTURE_JSON = '{}';
delete process.env.DISABLE_QC_AUTO_SCORER;

let db: typeof import('@/lib/db');
let selectors: typeof import('@/lib/persona-selector');
let conformance: typeof import('@/lib/persona-conformance');
let mismatch: typeof import('@/lib/persona-mismatch');
let attempts: typeof import('@/lib/execution-attempts');
let personaState: typeof import('@/lib/persona-state');

async function main() {
  const now = new Date().toISOString();
  db = await import('@/lib/db');
  db.getDb();
  db.run("INSERT OR IGNORE INTO companies(id,name,slug,config,created_at,updated_at) VALUES('default','Default','default','{}',?,?)", [now, now]);
  db.run("INSERT OR IGNORE INTO workspaces(id,name,slug,description,icon,company_id,sort_order,created_at,updated_at) VALUES('marketing','Marketing','marketing','','M','default',10,?,?)", [now, now]);
  selectors = await import('@/lib/persona-selector');
  conformance = await import('@/lib/persona-conformance');
  mismatch = await import('@/lib/persona-mismatch');
  attempts = await import('@/lib/execution-attempts');
  personaState = await import('@/lib/persona-state');

  function bundle(voiceId: string, extra: Record<string, unknown> = {}) {
    return {
      confirm_required: false,
      voice: { audience_persona: { id: voiceId, why: 'voice' }, collapsed: false },
      resolved_audience: { label: 'Audience A', candidates: ['Audience A'], source: 'asked', confidence: 0.9 },
      blend_directive: 'Write for Audience A. Topic and task personas provide expertise without replacing the audience voice.',
      task_personas: [],
      catalog_version: 'test-v1',
      ...extra,
    } as never;
  }

  /** A dispatched card with the stored bundle, dispatch snapshot and report —
   *  all over the REAL reserve/render functions (mirrors qc-hard-gap fixture). */
  function dispatchedCard(voiceId: string, opts: { reportBundleSha?: string | null; artifact?: string } = {}) {
    const id = randomUUID(), agent = randomUUID();
    db.run("INSERT INTO agents(id,name,role,workspace_id,model) VALUES(?,?,'builder','marketing','ollama-cloud/deepseek-v4-pro:0813')", [agent, `Writer ${agent.slice(0, 8)}`]);
    db.run("INSERT INTO tasks(id,title,description,status,department,workspace_id,created_at,updated_at) VALUES(?,'Write the launch email','Draft the announcement email.','assigned','marketing','marketing',?,?)", [id, now, now]);
    db.run('UPDATE tasks SET assigned_agent_id=?,persona_contract_version=1 WHERE id=?', [agent, id]);
    selectors.persistPersonaBundle(id, bundle(voiceId));
    const execution = attempts.reserveExecution(db.queryOne('SELECT * FROM tasks WHERE id=?', [id])!, `agent:a39:${id}`, randomUUID()).execution!;
    if (!execution) throw new Error('fixture must reserve an execution');
    attempts.beginExecutionSend(execution);
    conformance.renderPersonaConformanceInstructions(id, execution.id, agent, 'http://localhost:4000');
    const artifact = opts.artifact ?? path.join(TEMP, `${id}.txt`);
    if (!opts.artifact) fs.writeFileSync(artifact, 'Delivered copy.');
    db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title,path) VALUES(?,?,'file','Email copy',?)", [randomUUID(), id, artifact]);
    db.run("UPDATE task_executions SET state='succeeded' WHERE id=?", [execution.id]);
    return { id, agent, executionId: execution.id, artifact };
  }

  const storedShaOf = (taskId: string) =>
    personaState.personaBundleHash(JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [taskId])!.bundle_json));
  const dispatchedShaOf = (executionId: string) => conformance.dispatchedPersonaShas(executionId)?.root ?? null;
  const mismatchEvents = (taskId: string) =>
    db.queryAll<{ message: string; metadata: string }>("SELECT message,metadata FROM events WHERE task_id=? AND type='persona_mismatch' ORDER BY rowid", [taskId]);
  const mismatchCounter = (taskId: string) =>
    db.queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE task_id=? AND type='persona_mismatch'", [taskId])!.c;
  const chipOf = (taskId: string) => mismatch.getOpenPersonaMismatch(taskId);

  const out: string[] = [];
  const log = (line: string) => { out.push(line); console.log(line); };
  const section = (t: string) => log(`\n===== ${t} =====`);

  // ── PROBE 1: selected-vs-stored — the stored bundle is what was committed ----
  section('PROBE 1  selected-vs-stored (mismatch must be DETECTED)');
  {
    const card = dispatchedCard('voice-one');
    const selected = bundle('voice-two');               // selector's candidate decision
    const stored = storedShaOf(card.id);                // committed/stored decision
    const selectedSha = personaState.personaBundleHash(selected);
    const detected = selectedSha !== stored;
    log(`selected_sha   = ${selectedSha}`);
    log(`stored_sha     = ${stored}`);
    log(`compare        = personaBundleHash(selected) !== personaBundleHash(stored)`);
    log(`DETECTED       = ${detected}`);
    if (!detected) throw new Error('PROBE 1 FAILED: selected-vs-stored not detected');
  }

  // ── PROBE 2: stored-vs-dispatched mismatch — must be DETECTED (the fix) ------
  section('PROBE 2  stored-vs-dispatched (mismatch must be DETECTED, raw output)');
  {
    const card = dispatchedCard('voice-one');
    log(`stored_sha(pre-rebuild)  = ${storedShaOf(card.id)}`);
    log(`dispatched_sha           = ${dispatchedShaOf(card.executionId)}`);
    // exact QC re-route move: same voice, different bytes → different sha
    selectors.persistPersonaBundle(card.id, bundle('voice-one', { rationale: { rebuilt_by: 'qc-reroute' } }));
    const rebuilt = storedShaOf(card.id);
    const dispatched = dispatchedShaOf(card.executionId);
    log(`stored_sha(post-rebuild) = ${rebuilt}`);
    log(`rebuilt !== dispatched   = ${rebuilt !== dispatched}`);
    const report = { kind: 'persona_used' as const, execution_id: card.executionId,
      ...conformance.expectedPersonaManifest(bundle('voice-one')), voice_persona_id: 'voice-one',
      bundle_sha: dispatched, conformance_passed: true, artifacts: [] };
    const info = mismatch.recordPersonaUsedAndCompare(card.id, report as never);
    const events = mismatchEvents(card.id);
    log(`recordPersonaUsedAndCompare -> ${JSON.stringify(info)}`);
    log(`events count               = ${events.length}`);
    for (const e of events) log(`  message:  ${e.message}`);
    for (const e of events) log(`  metadata: ${e.metadata}`);
    if (mismatchCounter(card.id) !== 1) throw new Error('PROBE 2 FAILED: stored-vs-dispatched mismatch NOT detected');
    if (!events[0].message.includes('stored decision revision changed after dispatch'))
      throw new Error('PROBE 2 FAILED: message claims producer divergence for a stored rebuild');
    const chip = chipOf(card.id);
    log(`chip (GET board shape)     = ${JSON.stringify(chip)}`);
    if (chip?.reason !== 'persona_bundle_revision_mismatch')
      throw new Error('PROBE 2 FAILED: chip does not carry the distinguishing reason');
    if (chip?.revision_source !== 'stored')
      throw new Error('PROBE 2 FAILED: chip does not name the stored rebuild as the revision source');
  }

  // ── PROBE 3: dispatched-vs-used mismatch — must be DETECTED ------------------
  section('PROBE 3  dispatched-vs-used (mismatch must be DETECTED, raw output)');
  {
    const card = dispatchedCard('voice-one');
    const dispatched = dispatchedShaOf(card.executionId);
    const report = { kind: 'persona_used' as const, execution_id: card.executionId,
      ...conformance.expectedPersonaManifest(bundle('voice-one')), voice_persona_id: 'voice-one',
      bundle_sha: 'f'.repeat(64),            // the producer ran a DIFFERENT revision
      conformance_passed: true, artifacts: [] };
    log(`dispatched_sha = ${dispatched}`);
    log(`reported_sha   = ${report.bundle_sha}`);
    const direct = conformance.comparePersonaManifest(bundle('voice-one'), report as never, dispatched);
    log(`comparePersonaManifest reason = ${direct}`);
    const info = mismatch.recordPersonaUsedAndCompare(card.id, report as never);
    const events = mismatchEvents(card.id);
    log(`recordPersonaUsedAndCompare -> ${JSON.stringify(info)}`);
    log(`events count               = ${events.length}`);
    for (const e of events) log(`  metadata: ${e.metadata}`);
    if (direct !== 'persona_bundle_revision_mismatch') throw new Error('PROBE 3 FAILED: dispatched-vs-used not detected');
    if (mismatchCounter(card.id) !== 1) throw new Error('PROBE 3 FAILED: no record written');
  }

  // ---- PROBE 0: selected-vs-stored, in-code comparison (CAS) ---------------
  section('PROBE 0  selected-vs-stored: stale selection cannot overwrite stored');
  {
    const card = dispatchedCard('voice-one');
    const snapshot = personaState.capturePersonaSnapshot(card.id);
    db.run("UPDATE tasks SET title='Owner edited the brief' WHERE id=?", [card.id]);
    let conflict: string | null = null;
    try {
      personaState.commitPersonaMutation(snapshot, () => 'wrote', );
    } catch (err) {
      conflict = (err as Error).message;
    }
    log(`commitPersonaMutation on stale snapshot -> ${conflict}`);
    if (conflict !== 'persona_input_changed')
      throw new Error('PROBE 0 FAILED: stale SELECTED decision was allowed to overwrite STORED');
  }

  // ---- PROBE 4: all-equal control - NO false positive ----------------------
  section('PROBE 4  all-equal control (selected == stored == dispatched == used)');
  {
    const card = dispatchedCard('voice-one');
    const stored = storedShaOf(card.id);
    const dispatched = dispatchedShaOf(card.executionId);
    const manifest = conformance.expectedPersonaManifest(bundle('voice-one'));
    const report = { kind: 'persona_used' as const, execution_id: card.executionId, ...manifest,
      voice_persona_id: 'voice-one', bundle_sha: dispatched, conformance_passed: true, artifacts: [] };
    log(`selected=stored=dispatched sha = ${stored}`);
    log(`report.bundle_sha (used)        = ${dispatched}`);
    for (let i = 0; i < 3; i++) {
      const info = mismatch.recordPersonaUsedAndCompare(card.id, report as never);
      log(`run ${i + 1}: recordPersonaUsedAndCompare -> ${JSON.stringify(info)}`);
    }
    log(`persona_mismatch events         = ${mismatchCounter(card.id)}`);
    log(`chip                            = ${JSON.stringify(chipOf(card.id))}`);
    if (mismatchCounter(card.id) !== 0) throw new Error('PROBE 4 FAILED: false positive on all-equal');
    log(`revision_source absent on all-equal = ${chipOf(card.id) === null}`);
    if (chipOf(card.id) !== null) throw new Error('PROBE 4 FAILED: chip raised on all-equal');
  }

  // ---- PROBE 5: visibility through the REAL GET routes ---------------------
  section('PROBE 5  VISIBILITY: mismatch rendered on the GET routes a human reads');
  {
    const { NextRequest } = await import('next/server');
    const boardRoute = await import('@/app/api/tasks/route') as { GET: (req: unknown) => Promise<Response> };
    const detailRoute = await import('@/app/api/tasks/[id]/route') as { GET: (req: unknown, ctx: { params: { id: string } }) => Promise<Response> };
    const card = dispatchedCard('voice-one');
    // make stored diverge from dispatched (the A39 stored-vs-dispatched leg)
    selectors.persistPersonaBundle(card.id, bundle('voice-one', { rationale: { rebuilt_by: 'qc-reroute' } }));
    mismatch.recordPersonaUsedAndCompare(card.id, { kind: 'persona_used', execution_id: card.executionId,
      ...conformance.expectedPersonaManifest(bundle('voice-one')), voice_persona_id: 'voice-one',
      conformance_passed: true, artifacts: [] } as never);
    const boardRes = await boardRoute.GET(new NextRequest('http://localhost/api/tasks'));
    const board = await boardRes.json() as Array<{ id: string; persona_mismatch: unknown }>;
    const row = board.find((t) => t.id === card.id);
    log(`GET /api/tasks           status=${boardRes.status}`);
    log(`board row persona_mismatch = ${JSON.stringify(row?.persona_mismatch)}`);
    const detailRes = await detailRoute.GET(new NextRequest(`http://localhost/api/tasks/${card.id}`), { params: { id: card.id } });
    const detail = await detailRes.json() as { persona_mismatch?: unknown };
    log(`GET /api/tasks/${card.id.slice(0, 8)}… status=${detailRes.status}`);
    log(`detail persona_mismatch  = ${JSON.stringify(detail.persona_mismatch)}`);
    if (!row?.persona_mismatch) throw new Error('PROBE 5 FAILED: board row carries no mismatch');
    if (!detail.persona_mismatch) throw new Error('PROBE 5 FAILED: task detail carries no mismatch');
  }

  console.log(`\nTEMP kept for inspection: ${TEMP}`);
}

main().catch((err) => { console.error('PROBE ABORTED:', err); process.exit(1); });
