/** Evidence is bound to the current execution, full persona decision and files.
 * This verifies a producer's declaration; independent QC still assesses quality. */
import { createHash } from 'crypto';
import { openSync, closeSync, readSync, fstatSync } from 'fs';
import { getDb } from '@/lib/db';
import { latestExecution } from '@/lib/execution-attempts';
import { personaBundleHash } from '@/lib/persona-state';
import { isContentTask } from '@/lib/tasks';
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
export function comparePersonaManifest(bundle:unknown,report:PersonaManifest):string|null {
 const expected=expectedPersonaManifest(bundle);
 if(report.bundle_sha!==expected.bundle_sha) return 'persona_bundle_revision_mismatch';
 if(report.voice_persona_id!==expected.voice_persona_id) return 'persona_voice_mismatch';
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
  if(!row)return isContentTask(`${task.title} ${task.description??''}`)?{pass:false,reason:'persona_bundle_required'}:{pass:true,reason:'non_content'};
  const bundle=JSON.parse(row.bundle_json);
  if(bundle.decision_context?.input_revision!==task.persona_input_revision)return {pass:false,reason:'persona_input_changed'};
  const execution=latestExecution(taskId,db);
  if(!execution)return {pass:false,reason:'persona_execution_identity_missing'};
  if(execution.agent_id!==task.assigned_agent_id || execution.assignment_version!==task.assignment_version)return {pass:false,reason:'persona_execution_superseded'};
  const reports=(db.prepare("SELECT metadata FROM task_activities WHERE task_id=? AND agent_id=? AND json_valid(metadata) AND json_extract(metadata,'$.kind')='persona_used' ORDER BY created_at DESC,rowid DESC").all(taskId,execution.agent_id) as {metadata:string}[]).map(r=>JSON.parse(r.metadata) as PersonaManifest).filter(r=>r.execution_id===execution.id);
  const root=reports.find(r=>!r.page&&!r.scope);
  if(!root)return {pass:false,reason:'persona_conformance_not_reported'};
  const mismatch=comparePersonaManifest(bundle,root);if(mismatch)return {pass:false,reason:mismatch};
  const scopes=db.prepare('SELECT scope,bundle_json FROM task_persona_bundle_scope WHERE task_id=?').all(taskId) as {scope:string;bundle_json:string}[];
  for(const scope of scopes){
   const scopedBundle=JSON.parse(scope.bundle_json);
   if(scopedBundle.decision_context?.input_revision!==task.persona_input_revision || scopedBundle.decision_context?.root_bundle_sha!==personaBundleHash(bundle))return {pass:false,reason:'persona_scope_revision_changed'};
   const report=reports.find(r=>(r.scope??r.page)===scope.scope);
   if(!report)return {pass:false,reason:'persona_scope_conformance_missing'};
   const mismatch=comparePersonaManifest(JSON.parse(scope.bundle_json),report);
   if(mismatch)return {pass:false,reason:`scope_${mismatch}`};
  }
  const deliverables=db.prepare('SELECT id,path,sha256,deliverable_type FROM task_deliverables WHERE task_id=?').all(taskId) as {id:string;path:string;sha256:string|null;deliverable_type:string}[];
  if(!deliverables.length)return {pass:false,reason:'persona_artifact_snapshot_missing'};
  for(const file of deliverables){
   const evidence=root.artifacts?.find(r=>r.deliverable_id===file.id);
   if(!evidence)return {pass:false,reason:'persona_artifact_snapshot_missing'};
   // URLs are immutable report identities, not a claim that remote bytes were fetched.
   const digest=file.deliverable_type==='url'?createHash('sha256').update(file.path).digest('hex'):hashLocalArtifact(file.path);
   if(evidence.sha256!==digest||(file.sha256&&file.sha256!==digest))return {pass:false,reason:'persona_artifact_revision_changed'};
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
 return `**Persona evidence required before review:** After registering all deliverables, POST to ${baseUrl}/api/tasks/${taskId}/activities with bearer $MC_API_TOKEN, activity_type "completed", agent_id "${agentId}" and metadata for EACH decision below. Metadata must include kind "persona_used", execution_id "${executionId}", the decision's scope (omit for root), bundle_sha, voice_persona_id, topic_persona_id, task_persona_ids, and conformance_passed (true ONLY after checking your output actually follows that decision). The root report must include artifacts: [{deliverable_id,sha256}] for EVERY registered deliverable, using SHA-256 of local file bytes (or SHA-256 of the exact URL string for URL registrations). Report the personas actually used; deviations must be corrected or reported as false. Independent QC evaluates quality. Current decisions: ${JSON.stringify(reports)}. Include execution_id "${executionId}" in both PATCH status:review and completion-webhook requests.`;
}
