/**
 * UND-039 supplement — A39 "used" leg through the REAL production ingestion
 * route. und039_probe.ts constructs the producer report inline; this drives it
 * the way a worker actually does: POST /api/tasks/[id]/activities with
 * kind='persona_used', then reads the mismatch back off the two GET routes.
 *
 * Run: PATH=/opt/homebrew/opt/node@20/bin:$PATH node --import tsx und039_used_route.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'und039-used-'));
process.env.DATABASE_PATH = path.join(TEMP, 'used.db');
process.env.CC_TEST_FIXTURE_ROOT = TEMP;
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.PERSONA_FIXTURE_JSON = '{}';
delete process.env.DISABLE_QC_AUTO_SCORER;

async function main() {
  const now = new Date().toISOString();
  const db: any = await import('@/lib/db');
  db.getDb();
  db.run("INSERT OR IGNORE INTO companies(id,name,slug,config,created_at,updated_at) VALUES('default','Default','default','{}',?,?)", [now, now]);
  db.run("INSERT OR IGNORE INTO workspaces(id,name,slug,description,icon,company_id,sort_order,created_at,updated_at) VALUES('marketing','Marketing','marketing','','M','default',10,?,?)", [now, now]);
  const selectors: any = await import('@/lib/persona-selector');
  const conformance: any = await import('@/lib/persona-conformance');
  const attempts: any = await import('@/lib/execution-attempts');
  const personaState: any = await import('@/lib/persona-state');

  const id = randomUUID(), agent = randomUUID();
  db.run("INSERT INTO agents(id,name,role,workspace_id,model) VALUES(?,?,'builder','marketing','ollama-cloud/deepseek-v4-pro:0813')", [agent, `Writer ${agent.slice(0, 8)}`]);
  db.run("INSERT INTO tasks(id,title,description,status,department,workspace_id,created_at,updated_at) VALUES(?,'Write the launch email','Draft the announcement email.','assigned','marketing','marketing',?,?)", [id, now, now]);
  db.run('UPDATE tasks SET assigned_agent_id=?,persona_contract_version=1 WHERE id=?', [agent, id]);
  const bundle = {
    confirm_required: false,
    voice: { audience_persona: { id: 'voice-one', why: 'voice' }, collapsed: false },
    resolved_audience: { label: 'Audience A', candidates: ['Audience A'], source: 'asked', confidence: 0.9 },
    blend_directive: 'Write for Audience A.',
    task_personas: [], catalog_version: 'test-v1',
  } as never;
  selectors.persistPersonaBundle(id, bundle);
  const execution = attempts.reserveExecution(db.queryOne('SELECT * FROM tasks WHERE id=?', [id])!, `agent:a39used:${id}`, randomUUID()).execution!;
  attempts.beginExecutionSend(execution);
  conformance.renderPersonaConformanceInstructions(id, execution.id, agent, 'http://localhost:4000');
  db.run("UPDATE task_executions SET state='succeeded' WHERE id=?", [execution.id]);

  const dispatched = conformance.dispatchedPersonaShas(execution.id)?.root ?? null;
  const storedBefore = personaState.personaBundleHash(
    JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [id])!.bundle_json));

  // ── the REAL ingestion route, payload exactly as a producer with a DIFFERENT used revision would send ──
  const { NextRequest } = await import('next/server');
  const acts: any = await import('@/app/api/tasks/[id]/activities/route');
  const body = {
    activity_type: 'completed',
    message: 'producer reported the persona bundle it wrote with',
    agent_id: agent,
    metadata: {
      kind: 'persona_used', execution_id: execution.id,
      ...conformance.expectedPersonaManifest(bundle),
      voice_persona_id: 'voice-one',
      bundle_sha: 'e'.repeat(64),          // producer ran a DIFFERENT revision than dispatched
      conformance_passed: false, artifacts: [],
    },
  };
  const res = await acts.POST(
    new NextRequest(`http://localhost/api/tasks/${id}/activities`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) });
  const resBody = await res.json().catch(() => null);

  const events = db.queryAll<{ message: string; metadata: string }>(
    "SELECT message,metadata FROM events WHERE task_id=? AND type='persona_mismatch'", [id]);

  const boardRoute: any = await import('@/app/api/tasks/route');
  const bRes = await boardRoute.GET(new NextRequest('http://localhost/api/tasks'));
  const board = await bRes.json() as Array<{ id: string; persona_mismatch: unknown }>;
  const row = board.find((t) => t.id === id);
  const detailRoute: any = await import('@/app/api/tasks/[id]/route');
  const dRes = await detailRoute.GET(new NextRequest(`http://localhost/api/tasks/${id}`), { params: { id } });
  const detail = await dRes.json() as { persona_mismatch?: unknown };

  const L: string[] = [];
  L.push(`stored_sha    = ${storedBefore}`);
  L.push(`dispatched_sha= ${dispatched}`);
  L.push(`used_sha(sent)= ${'e'.repeat(64)}`);
  L.push(`POST activities status=${res.status} body=${JSON.stringify({ ok: resBody?.ok, id: resBody?.id }).slice(0, 160)}`);
  L.push(`persona_mismatch events = ${events.length}`);
  for (const e of events) L.push(`  message: ${e.message}`);
  for (const e of events) L.push(`  metadata: ${e.metadata}`);
  L.push(`GET /api/tasks        status=${bRes.status} persona_mismatch=${JSON.stringify(row?.persona_mismatch)}`);
  L.push(`GET /api/tasks/[id]   status=${dRes.status} persona_mismatch=${JSON.stringify(detail.persona_mismatch)}`);

  const ok = res.status === 201 && events.length === 1 && !!row?.persona_mismatch && !!detail.persona_mismatch;
  L.push(`USED_LEG_THROUGH_REAL_ROUTE = ${ok ? 'DETECTED_AND_VISIBLE' : 'FAILED'}`);
  console.log(L.join('\n'));
  if (!ok) process.exit(1);
}
main().catch((err) => { console.error('ABORTED:', err); process.exit(1); });
