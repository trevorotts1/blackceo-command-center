/** Evidence is bound to the current execution, full persona decision and files.
 * This verifies a producer's declaration; independent QC still assesses quality. */
import { createHash } from 'crypto';
import { openSync, closeSync, readSync, fstatSync } from 'fs';
import { getDb } from '@/lib/db';
import { latestExecution } from '@/lib/execution-attempts';
import { personaBundleHash } from '@/lib/persona-state';
import { shouldUsePersonaBlend } from '@/lib/tasks';
import type Database from 'better-sqlite3';

export interface PersonaConformanceResult { pass: boolean; reason: string }
export interface PersonaManifest {
 kind?:string; execution_id?:string; scope?:string|null; page?:string|null;
 bundle_sha?:string; voice_persona_id?:string|null; topic_persona_id?:string|null;
 task_persona_ids?:string[]; conformance_passed?:boolean;
 artifacts?:{deliverable_id:string;sha256:string}[];
}
export function expectedPersonaManifest(bundle:any) {
 return {bundle_sha:personaBundleHash(bundle),
  voice_persona_id:bundle.voice?.collapsed ? bundle.voice.collapsed_persona_id : bundle.voice?.audience_persona?.id,
  topic_persona_id:bundle.voice?.topic_persona?.id ?? null,
  task_persona_ids:Array.from(new Set<string>((bundle.task_personas??[]).map((r:{persona_id?:string})=>r.persona_id).filter(Boolean))).sort()};
}
/** A persona id that is absent, blank, or the literal text "null"/"undefined" is
 * NOT a declaration. Two non-declarations are not a divergence. Fabricating one
 * is what failed every content card on a live box (2026-09-21): the bundle
 * declared no voice, the producer reported no voice, and the comparison read
 * `null !== undefined` as a hard gap — `declared "null" but the producer
 * reported writing with "null"`. Both sides normalise through here. */
export function personaId(value:unknown):string|null {
 if(typeof value!=='string')return null;
 const trimmed=value.trim();
 return !trimmed||trimmed==='null'||trimmed==='undefined'?null:trimmed;
}
/** `dispatchBundleSha` is the bundle sha this EXECUTION was actually handed at
 * dispatch (recorded by renderPersonaConformanceInstructions). The revision
 * check measures the producer against THAT, never against a bundle rebuilt
 * afterwards — a QC re-route rebuilds the bundle, and comparing to the rebuilt
 * one failed the producer for a revision it could not have seen. No recorded
 * snapshot (a pre-upgrade execution) skips the check: fail-soft, never fail. */
export function comparePersonaManifest(bundle:unknown,report:PersonaManifest,dispatchBundleSha?:string|null):string|null {
 const expected=expectedPersonaManifest(bundle);
 if(dispatchBundleSha && report.bundle_sha!==dispatchBundleSha) return 'persona_bundle_revision_mismatch';
 const declaredVoice=personaId(expected.voice_persona_id),usedVoice=personaId(report.voice_persona_id);
 if(declaredVoice && usedVoice && declaredVoice!==usedVoice) return 'persona_voice_mismatch';
 if((report.topic_persona_id??null)!==expected.topic_persona_id) return 'persona_topic_mismatch';
 if(JSON.stringify(Array.from(new Set(report.task_persona_ids??[])).sort())!==JSON.stringify(expected.task_persona_ids)) return 'persona_task_roles_mismatch';
 if(report.conformance_passed!==true) return 'persona_conformance_not_passed';
 return null;
}
/** Fixed memory hashing supports media files without an arbitrary size hold.
 * Recheck inode/size/mtime around reading to reject concurrently changing files. */
function hashLocalArtifact(filename:string):string {
 const fd=openSync(filename,'r');
 try {
  const before=fstatSync(fd);if(!before.isFile())throw new Error('artifact_not_file');
  const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);
  let count:number;while((count=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));
  const after=fstatSync(fd);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('artifact_changed');
  return hash.digest('hex');
 } finally {closeSync(fd);}
}
export interface DispatchedPersonaShas { root:string|null; scopes:Record<string,string> }
/** What the producer was ACTUALLY handed at dispatch, stored ON the execution
 * row (migration 154) because it is a property of that attempt and of nothing
 * else — not a feed entry, and never re-derivable afterwards. Written once per
 * send by renderPersonaConformanceInstructions, the single point the
 * expectation leaves the Command Center, so the revision check has a fixed
 * target a later bundle rebuild cannot move. Fail-soft throughout: a
 * pre-migration box, a failed write, or a malformed value all mean "no
 * snapshot", which SKIPS the revision check rather than failing a producer for
 * a revision nobody recorded. */
export function recordPersonaDispatchManifest(executionId:string,shas:DispatchedPersonaShas,db:Database.Database=getDb()):void {
 try {
  db.prepare('UPDATE task_executions SET persona_bundle_shas=? WHERE id=?').run(JSON.stringify(shas),executionId);
 } catch (err) {
  console.warn(`[persona-conformance] dispatch persona snapshot not recorded for execution ${executionId} (non-fatal):`,(err as Error).message);
 }
}
export function dispatchedPersonaShas(executionId:string|undefined,db:Database.Database=getDb()):DispatchedPersonaShas|null {
 if(!executionId)return null;
 try {
  const row=db.prepare('SELECT persona_bundle_shas FROM task_executions WHERE id=?').get(executionId) as {persona_bundle_shas:string|null}|undefined;
  if(!row?.persona_bundle_shas)return null;
  const parsed=JSON.parse(row.persona_bundle_shas) as {root?:string|null;scopes?:Record<string,string>};
  return {root:parsed.root??null,scopes:parsed.scopes??{}};
 } catch { return null; }
}
export interface DeliverableRow { id:string; path:string; sha256:string|null; deliverable_type:string }
/** Find the producer's evidence for one registered deliverable.
 *
 * The manifest is keyed on `deliverable_id`, which is the UUID the registration
 * endpoint returns in its 201 — a value the producer only learns by reading
 * that response. On a live box (2026-09-21) a FRESH single-execution card
 * failed `persona_artifact_snapshot_missing` with the bytes matching exactly:
 * the row was `5da67569-…` and the producer had reported the FILENAME in the
 * `deliverable_id` field. Another card reported UUIDs belonging to rows that no
 * longer existed. A lookup by id alone reads both as "this artifact was never
 * snapshotted", which is false — the producer hashed the right bytes.
 *
 * So identity is resolved in the order the evidence is trustworthy: the id it
 * was given, then the SHA-256 of the bytes themselves, then the path or
 * basename it may have used as a name instead. A byte-identical hash IS the
 * snapshot — no id can be more authoritative about which artifact was hashed
 * than the hash. What cannot be recovered is still a hard gap: evidence that
 * matches nothing, or matches by name with a different digest, fails as before.
 * The instruction in renderPersonaConformanceInstructions now names the 201
 * `id` explicitly, so the id lane is the one future reports take. */
export function matchArtifactEvidence(file:DeliverableRow,digest:string,artifacts:{deliverable_id:string;sha256:string}[]|undefined):{deliverable_id:string;sha256:string}|undefined {
 if(!artifacts?.length)return undefined;
 const base=file.path?file.path.split('/').pop():undefined;
 return artifacts.find(r=>r.deliverable_id===file.id)
  ?? artifacts.find(r=>r.sha256===digest)
  ?? artifacts.find(r=>r.deliverable_id===file.path||(!!base&&r.deliverable_id===base));
}
/** The deliverables THIS attempt must account for.
 *
 * `task_deliverables` accumulates across QC re-routes — attempt 2 registers its
 * output beside everything attempt 1 left — while a producer report only ever
 * covers the artifacts of the attempt that wrote it. Measuring one against the
 * other blocked a live card (2026-09-21) at 13 registered deliverables versus 6
 * in its latest root report: a perfect score, `persona_artifact_snapshot_missing`,
 * and every re-execution widening the gap it was sent to close. So the question
 * is scoped to the rows migration 158 attributes to the CURRENT execution.
 *
 * FALLBACK, and why it cannot weaken the gate: a row registered before that
 * linkage existed carries NULL. When the current execution has NOT attributed a
 * single row of its own — a pre-158 attempt finishing right after an upgrade —
 * the whole card is measured exactly as it was before this change. That is the
 * STRICTER of the two rules, never the looser one, and it cannot hide a real
 * gap: the moment this attempt registers anything, its own rows are what it is
 * held to, and one of them missing from the report is still a hard failure. */
export function currentExecutionDeliverables(taskId:string,executionId:string,db:Database.Database=getDb()):DeliverableRow[] {
 // SELECT * on purpose: a pre-158 database has no `execution_id`, and naming a
 // column that does not exist would throw inside the caller's catch and turn a
 // healthy un-migrated box into `persona_conformance_unavailable`. Absent reads
 // as undefined, which is simply "not this execution".
 const all=db.prepare('SELECT * FROM task_deliverables WHERE task_id=?').all(taskId) as (DeliverableRow&{execution_id?:string|null})[];
 const mine=all.filter(r=>r.execution_id===executionId);
 return mine.length?mine:all;
}
export function requirePersonaConformanceForCompletion(taskId:string,db:Database.Database=getDb()):PersonaConformanceResult {
 try {
  const task=db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as any;
  if(!task)return {pass:false,reason:'task_missing'};
  // The immutable engine source uses the existing specialized artifact/certificate
  // authority. It never receives a CC-dispatched execution. This is not a generic
  // legacy escape hatch and cannot be selected through task PATCH.
  const source=String(task.source??'').trim().toLowerCase();
  if(source==='build_deck_phase')return {pass:true,reason:'external_engine_phase_authority'};
  if(source==='build_deck'){
   const qc=db.prepare('SELECT passed,score FROM task_qc_results WHERE task_id=? ORDER BY scored_at DESC,rowid DESC LIMIT 1').get(taskId) as {passed:number;score:number}|undefined;
   return qc?.passed===1 && qc.score>=8 && task.process_certificate_sha ? {pass:true,reason:'external_engine_qc_authority'}:{pass:false,reason:'external_engine_qc_evidence_required'};
  }
  if(!task.persona_contract_version)return {pass:true,reason:'legacy_contract'};
  const row=db.prepare('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?').get(taskId) as {bundle_json:string}|undefined;
  if(!row)return shouldUsePersonaBlend(`${task.title} ${task.description??''}`, task.department)?{pass:false,reason:'persona_bundle_required'}:{pass:true,reason:'non_content'};
  const bundle=JSON.parse(row.bundle_json);
  if(bundle.decision_context?.input_revision!==task.persona_input_revision)return {pass:false,reason:'persona_input_changed'};
  const execution=latestExecution(taskId,db);
  if(!execution)return {pass:false,reason:'persona_execution_identity_missing'};
  if(execution.agent_id!==task.assigned_agent_id || execution.assignment_version!==task.assignment_version)return {pass:false,reason:'persona_execution_superseded'};
  const reports=(db.prepare("SELECT metadata FROM task_activities WHERE task_id=? AND agent_id=? AND json_valid(metadata) AND json_extract(metadata,'$.kind')='persona_used' ORDER BY created_at DESC,rowid DESC").all(taskId,execution.agent_id) as {metadata:string}[]).map(r=>JSON.parse(r.metadata) as PersonaManifest).filter(r=>r.execution_id===execution.id);
  const root=reports.find(r=>!r.page&&!r.scope);
  if(!root)return {pass:false,reason:'persona_conformance_not_reported'};
  const dispatched=dispatchedPersonaShas(execution.id,db);
  const mismatch=comparePersonaManifest(bundle,root,dispatched?.root);if(mismatch)return {pass:false,reason:mismatch};
  const scopes=db.prepare('SELECT scope,bundle_json FROM task_persona_bundle_scope WHERE task_id=?').all(taskId) as {scope:string;bundle_json:string}[];
  for(const scope of scopes){
   const scopedBundle=JSON.parse(scope.bundle_json);
   if(scopedBundle.decision_context?.input_revision!==task.persona_input_revision || scopedBundle.decision_context?.root_bundle_sha!==personaBundleHash(bundle))return {pass:false,reason:'persona_scope_revision_changed'};
   const report=reports.find(r=>(r.scope??r.page)===scope.scope);
   if(!report)return {pass:false,reason:'persona_scope_conformance_missing'};
   const mismatch=comparePersonaManifest(JSON.parse(scope.bundle_json),report,dispatched?.scopes[scope.scope]);
   if(mismatch)return {pass:false,reason:`scope_${mismatch}`};
  }
  const deliverables=currentExecutionDeliverables(taskId,execution.id,db);
  if(!deliverables.length)return {pass:false,reason:'persona_artifact_snapshot_missing'};
  for(const file of deliverables){
   // URLs are immutable report identities, not a claim that remote bytes were fetched.
   const digest=file.deliverable_type==='url'?createHash('sha256').update(file.path).digest('hex'):hashLocalArtifact(file.path);
   if(file.sha256&&file.sha256!==digest)return {pass:false,reason:'persona_artifact_revision_changed'};
   const evidence=matchArtifactEvidence(file,digest,root.artifacts);
   if(!evidence)return {pass:false,reason:'persona_artifact_snapshot_missing'};
   if(evidence.sha256!==digest)return {pass:false,reason:'persona_artifact_revision_changed'};
  }
  return {pass:true,reason:'current_persona_declaration_verified'};
 } catch {return {pass:false,reason:'persona_conformance_unavailable'};}
}
export function renderPersonaConformanceInstructions(taskId:string,executionId:string,agentId:string,baseUrl:string):string {
 const db=getDb();
 const task=db.prepare('SELECT persona_contract_version FROM tasks WHERE id=?').get(taskId) as {persona_contract_version:number}|undefined;
 const row=db.prepare('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?').get(taskId) as {bundle_json:string}|undefined;
 if(!task?.persona_contract_version||!row)return '';
 const reports=[{scope:null,...expectedPersonaManifest(JSON.parse(row.bundle_json))},...(db.prepare('SELECT scope,bundle_json FROM task_persona_bundle_scope WHERE task_id=?').all(taskId) as {scope:string;bundle_json:string}[]).map(r=>({scope:r.scope,...expectedPersonaManifest(JSON.parse(r.bundle_json))}))];
 // Record what this execution is being handed, at the one moment it is handed
 // over. The completion check measures the producer against THIS, so a bundle
 // rebuilt later (a QC re-route does exactly that) can never retroactively make
 // an honest report look stale.
 recordPersonaDispatchManifest(executionId,{
  root:reports[0]?.bundle_sha??null,
  scopes:Object.fromEntries(reports.slice(1).map(r=>[String(r.scope),r.bundle_sha])),
 },db);
 return `**Persona evidence required before review:** After registering all deliverables, POST to ${baseUrl}/api/tasks/${taskId}/activities with bearer $MC_API_TOKEN, activity_type "completed", agent_id "${agentId}" and metadata for EACH decision below. Metadata must include kind "persona_used", execution_id "${executionId}", the decision's scope (omit for root), bundle_sha, voice_persona_id, topic_persona_id, task_persona_ids, and conformance_passed (true ONLY after checking your output actually follows that decision). The root report must include artifacts: [{deliverable_id,sha256}] covering EXACTLY the deliverables you registered in THIS execution, using SHA-256 of local file bytes (or SHA-256 of the exact URL string for URL registrations). deliverable_id is the \`id\` field returned in the 201 response when you POST the deliverable to /api/tasks/${taskId}/deliverables — keep that id from each response and echo it here; it is NOT the filename. Report the personas actually used; deviations must be corrected or reported as false. Independent QC evaluates quality. Current decisions: ${JSON.stringify(reports)}. Include execution_id "${executionId}" in both PATCH status:review and completion-webhook requests.`;
}
