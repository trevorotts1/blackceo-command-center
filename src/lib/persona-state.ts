/** Persona decisions are computed asynchronously, but committed against the
 * exact input/override snapshot that was scored. No stale selector wins a race. */
import { throwIfJobLeaseLost } from '@/lib/jobs/job-lease';
import { createHash } from 'crypto';
import { getDb } from '@/lib/db';
import type Database from 'better-sqlite3';

const INPUT_KEYS = ['persona_input_revision','persona_revision','business_id','workspace_id',
 'department','assigned_agent_id','title','description','sop_id','persona_id','persona_name',
 'persona_mode','secondary_persona_id','audience_id','audience_label','audience_source',
 'operator_lock','scope_bundles','root_bundle','blend_directive','status','killed_at','archived_at'];
export interface PersonaSnapshot { taskId: string; fingerprint: string }
function fingerprint(row: Record<string, unknown>): string {
 return createHash('sha256').update(JSON.stringify(INPUT_KEYS.map(k=>[k,row[k]??null]))).digest('hex');
}
export function capturePersonaSnapshot(taskId: string, db = getDb()): PersonaSnapshot {
 const row=db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as Record<string,unknown>|undefined;
 if (!row) throw new Error('persona_task_missing');
 if (row.killed_at || row.archived_at || /OWNER KILLED/i.test(String(row.description??''))) throw new Error('persona_task_inactive');
 if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_settings'").get()) {
  row.operator_lock=db.prepare("SELECT department_id,role_id,value FROM agent_settings WHERE setting_type='persona' AND (department_id=? OR department_id=?) AND (role_id=? OR role_id IS NULL) ORDER BY department_id,role_id,value")
    .all(row.workspace_id??null,row.department??null,row.assigned_agent_id??null);
 }
 if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_persona_bundle'").get())row.root_bundle=db.prepare('SELECT bundle_json,confirm_state FROM task_persona_bundle WHERE task_id=?').get(taskId)??null;
 if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_persona_bundle_scope'").get())row.scope_bundles=db.prepare('SELECT scope,bundle_json FROM task_persona_bundle_scope WHERE task_id=? ORDER BY scope').all(taskId);
 return { taskId, fingerprint:fingerprint(row) };
}
export class PersonaConflictError extends Error {
 constructor(){super('persona_input_changed');this.name='PersonaConflictError';}
}
export function commitPersonaMutation<T>(snapshot: PersonaSnapshot, mutate:()=>T, db: Database.Database=getDb()): T {
 return db.transaction(()=>{
  throwIfJobLeaseLost();
  let current:PersonaSnapshot;
  try { current=capturePersonaSnapshot(snapshot.taskId,db); } catch { throw new PersonaConflictError(); }
  if(current.fingerprint!==snapshot.fingerprint) throw new PersonaConflictError();
  return mutate();
 }).immediate();
}
export function personaBundleHash(bundle: unknown): string {
 // Canonical recursive key order makes the digest independent of JSON transport order.
 const canonical=(value:unknown):unknown=> Array.isArray(value)?value.map(canonical):
  value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
 return createHash('sha256').update(JSON.stringify(canonical(bundle))).digest('hex');
}
