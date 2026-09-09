/** Readback-only ownership after production tasks complete. No posting API calls. */
// Match scheduler jobs' bare built-ins: instrumentation is also compiled for
// Edge, though its NEXT_RUNTIME guard executes this consumer only on Node.
// The Edge compilation supports bare fallbacks, not node: URI imports.
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { queryAll, queryOne, run } from '@/lib/db';
import { createTaskCore } from '@/lib/tasks';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import { artifactDir } from '@/lib/task-lifecycle';
import { notifySystem } from '@/lib/notify';
import { broadcast } from '@/lib/events';

interface Verification {
  queue_id:string; target:string; company_id:string; platform:string; account_id:string|null;
  task_id:string|null; state:string; attempt_count:number; retry_at:string;
  created_at:string; updated_at:string; escalated_at:string|null;
}
const RETRY_MS=2*60_000;
const MAX_ATTEMPTS=3;
export const verificationAdapters={
  create: createTaskCore, dispatch:autoDispatchTask, notify:notifySystem,
};

/** Re-read a registered immutable artifact under the task's assigned directory. */
function registeredReceipt(taskId:string):{body:any;sha:string}|null {
  const artifacts=queryAll<{path:string;sha256:string}>(`SELECT path,sha256 FROM task_deliverables WHERE task_id=? AND deliverable_type IN ('file','artifact')`,[taskId]);
  for(const a of artifacts) try {
    const expected=path.resolve(artifactDir(taskId),'publish-receipts.json');
    const directory=path.dirname(expected);
    if(path.resolve(a.path)!==expected || !a.sha256 || fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(expected)!==path.join(fs.realpathSync(directory),'publish-receipts.json')) continue;
    const stat=fs.lstatSync(expected);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>1_000_000) continue;
    const bytes=fs.readFileSync(expected),sha=createHash('sha256').update(bytes).digest('hex');
    if(sha!==a.sha256) continue;
    return {body:JSON.parse(bytes.toString('utf8')),sha};
  } catch { /* Missing or changed evidence stays unresolved. */ }
  return null;
}

/** A previously accepted target cannot certify a revised production inventory. */
function invalidateChangedEvidence(queueId:string, companyId:string, sourceTaskId:string|null, stamp:string):void {
  const source=sourceTaskId?registeredReceipt(sourceTaskId):null;
  const owner=sourceTaskId?queryOne<{company_id:string;status:string}>(`SELECT w.company_id,t.status FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?`,[sourceTaskId]):null;
  const accepted=queryAll<{target:string;task_id:string|null;receipt_sha256:string|null}>(`SELECT target,task_id,receipt_sha256 FROM social_publish_verifications WHERE queue_id=? AND company_id=? AND state IN ('published','scheduled')`,[queueId,companyId]);
  for(const target of accepted) {
    const receipt=target.task_id?registeredReceipt(target.task_id):null;
    if(source && owner?.company_id===companyId && owner.status==='done' && receipt && receipt.sha===target.receipt_sha256 && receipt.body.source_receipt_sha256===source.sha) continue;
    run(`UPDATE social_publish_verifications SET state='pending',task_id=NULL,attempt_count=0,retry_at=?,receipt_sha256=NULL,verified_at=NULL,error='Source or accepted evidence changed; new readback required, never republish',updated_at=? WHERE queue_id=? AND target=?`,[stamp,stamp,queueId,target.target]);
  }
}

export function readPublicationProof(v:Verification, nowMs:number):{state:'published'|'scheduled';sha:string;retryAt:string}|null {
  if(!v.task_id || !v.account_id || queryOne<{status:string}>('SELECT status FROM tasks WHERE id=?',[v.task_id])?.status!=='done') return null;
  if(!queryOne('SELECT id FROM social_connected_accounts WHERE id=? AND company_id=? AND lower(platform)=?',[v.account_id,v.company_id,v.platform])) return null;
  const queue=queryOne<{cc_task_id:string|null}>('SELECT cc_task_id FROM publish_queue WHERE id=? AND company_id=?',[v.queue_id,v.company_id]);
  if(!queue?.cc_task_id || queue.cc_task_id===v.task_id) return null;
  const source=registeredReceipt(queue.cc_task_id),receipt=registeredReceipt(v.task_id);
  if(!source || !receipt) return null;
  const inventory=source.body,body=receipt.body;
  const sourceOwner=queryOne<{company_id:string;status:string}>(`SELECT w.company_id,t.status FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?`,[queue.cc_task_id]);
  if(sourceOwner?.company_id!==v.company_id || sourceOwner.status!=='done' || (inventory.company_id!==undefined && inventory.company_id!==v.company_id) || (inventory.queue_id!==undefined && inventory.queue_id!==v.queue_id) || !Array.isArray(inventory.posts) || inventory.planned_posts!==inventory.posts.length) return null;
  const expected=inventory.posts.filter((p:any)=>p.account_id===v.account_id&&p.platform===v.platform).map((p:any)=>p.post_id);
  if(!expected.length || expected.some((id:any)=>typeof id!=='string'||!id) || new Set(expected).size!==expected.length) return null;
  if(body.company_id!==v.company_id || body.queue_id!==v.queue_id || body.source_receipt_sha256!==source.sha || !Array.isArray(body.posts) || body.posts.length!==expected.length || body.created_posts!==body.posts.length || body.planned_posts!==body.posts.length) return null;
  let scheduled=false,next=Infinity;
  const ids=new Set<string>();
  for(const post of body.posts) try {
    const rb=post.readback,checked=Date.parse(rb?.checked_at),url=new URL(post.url);
    if(!expected.includes(post.post_id) || ids.has(post.post_id) || post.platform!==v.platform || post.account_id!==v.account_id || !['http:','https:'].includes(url.protocol) || !rb || rb.id!==post.post_id || rb.account_id!==post.account_id || !Number.isFinite(checked) || checked<Date.parse(v.created_at) || checked>nowMs+60_000 || nowMs-checked>15*60_000 || !['published','scheduled'].includes(rb.status)) return null;
    ids.add(post.post_id);
    if(rb.status==='scheduled') {
      const when=Date.parse(post.scheduled_at);
      if(!Number.isFinite(when) || when<=nowMs) return null;
      scheduled=true;next=Math.min(next,when+RETRY_MS);
    }
  } catch {return null;}
  return {state:scheduled?'scheduled':'published',sha:receipt.sha,retryAt:new Date(scheduled?next:nowMs+RETRY_MS).toISOString()};
}

export async function runSocialVerificationSweep(nowMs=Date.now(), adapters=verificationAdapters):Promise<{checked:number;dispatched:number;escalated:number}> {
  const stamp=new Date(nowMs).toISOString(), retry=new Date(nowMs+RETRY_MS).toISOString();
  const queues=queryAll<{id:string;company_id:string;platforms:string;cc_task_id:string|null;updated_at:string}>(`SELECT id,company_id,platforms,cc_task_id,updated_at FROM publish_queue WHERE status='verification_required' OR (status='scheduled' AND EXISTS(SELECT 1 FROM social_publish_verifications v WHERE v.queue_id=publish_queue.id)) ORDER BY updated_at LIMIT 25`);
  let checked=0, dispatched=0, escalated=0;
  for(const q of queues) {
    try {
      const platforms=JSON.parse(q.platforms);
      if(!Array.isArray(platforms)||!platforms.length) throw new Error('No requested destinations to verify');
      for(const platform of new Set(platforms.map((x:string)=>String(x).toLowerCase()))) {
        const source=q.cc_task_id?registeredReceipt(q.cc_task_id):null;
        const owner=q.cc_task_id?queryOne<{company_id:string}>(`SELECT w.company_id FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?`,[q.cc_task_id]):null;
        const inventory=source?.body;
        const validInventory=owner?.company_id===q.company_id && inventory && (inventory.company_id===undefined||inventory.company_id===q.company_id) && (inventory.queue_id===undefined||inventory.queue_id===q.id) && Array.isArray(inventory.posts) && inventory.planned_posts===inventory.posts.length;
        // Freeze targets to production inventory, never accounts connected later.
        const accounts:Array<{id:string}>=validInventory?[...new Set<string>(inventory.posts.filter((p:any)=>p.platform===platform&&typeof p.account_id==='string'&&p.account_id).map((p:any)=>p.account_id))].map(id=>({id})):[];
        if(accounts.length)run("UPDATE social_publish_verifications SET state='superseded',updated_at=? WHERE queue_id=? AND target=?",[stamp,q.id,`platform:${platform}`]);
        const targets=accounts.length?accounts.map(a=>({target:`account:${a.id}`,account:a.id})):[{target:`platform:${platform}`,account:null}];
        for(const t of targets) run(`INSERT OR IGNORE INTO social_publish_verifications(queue_id,target,company_id,platform,account_id,retry_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,[q.id,t.target,q.company_id,platform,t.account,stamp,stamp,stamp]);
      }
      invalidateChangedEvidence(q.id,q.company_id,q.cc_task_id,stamp);
      const rows=queryAll<Verification>('SELECT * FROM social_publish_verifications WHERE queue_id=? AND company_id=? AND state<>\'superseded\'',[q.id,q.company_id]);
      for(const v of rows) {
        if(v.state==='published'||v.retry_at>stamp) continue;
        checked++;
        try {
          const proof=readPublicationProof(v,nowMs);
          if(proof) {
            run(`UPDATE social_publish_verifications SET state=?,receipt_sha256=?,verified_at=?,retry_at=?,error=NULL,updated_at=? WHERE queue_id=? AND target=?`,[proof.state,proof.sha,stamp,proof.retryAt,stamp,q.id,v.target]);
            continue;
          }
          const task=v.task_id?queryOne<{status:string}>('SELECT status FROM tasks WHERE id=?',[v.task_id]):undefined;
          // Already scheduled posts get a new readback after their due time;
          // previously accepted scheduling is not a failed verification attempt.
          let attempts=v.state==='scheduled'?0:v.attempt_count;
          if(v.state==='scheduled')run("UPDATE social_publish_verifications SET state='pending',attempt_count=0 WHERE queue_id=? AND target=?",[q.id,v.target]);
          if(nowMs-Date.parse(v.created_at)>=15*60_000 && !v.escalated_at) {
            const alerted=adapters.notify(`Social publication verification overdue for company ${q.company_id}, queue ${q.id}, ${v.target}. Readback task ${v.task_id??'not assigned'} requires attention. Do not republish.`,{agent:'social-publish-verifier',action:'verification_overdue'});
            if(alerted) {
              run('UPDATE social_publish_verifications SET escalated_at=? WHERE queue_id=? AND target=?',[stamp,q.id,v.target]); escalated++;
            }
          }
          if(attempts>=MAX_ATTEMPTS || (task && ['in_progress','review','testing'].includes(task.status))) {
            run(`UPDATE social_publish_verifications SET retry_at=?,error=?,updated_at=? WHERE queue_id=? AND target=?`,[retry,attempts>=MAX_ATTEMPTS?'Readback dispatch limit reached; assigned task and escalation remain open':'Readback worker active; awaiting verified receipt',stamp,q.id,v.target]);
            continue;
          }
          let taskId=v.task_id;
          if(!task || task.status==='done' || v.state==='scheduled') {
            const generation=`${v.attempt_count+1}:${v.state==='scheduled'?v.retry_at:''}`;
            const sourceSha=q.cc_task_id?registeredReceipt(q.cc_task_id)?.sha:null;
            const key=createHash('sha256').update(JSON.stringify([q.company_id,q.id,v.target,generation,sourceSha,v.updated_at])).digest('hex');
            const result=await adapters.create({title:`Verify social publication: ${v.target}`,description:`READBACK ONLY. Never create, repost, edit or reschedule a post. Company ${q.company_id}; publish queue ${q.id}; target ${v.target}; platform ${v.platform}; source task ${q.cc_task_id??'unknown'}. Retrieve the existing publish-receipts.json and planned posts from the source task. Query provider status for every intended post on this target. Resolve unknown IDs/account connections visibly; do not invent them. Preserve healthy unrelated targets. Save publish-receipts.json in YOUR assigned artifact directory and register it through the existing task deliverables API; independent QC must check the provider readback before this verification task reaches done. Unknown account ownership must first be refreshed into this company's connected account registry. The production source must register its immutable publish-receipts.json with company_id, queue_id and complete posts inventory. Bind the verification receipt source_receipt_sha256 to that registered source SHA and verify the exact per-account source post ID set, rejecting omissions/extras. Receipt: company_id, queue_id, source_receipt_sha256, planned_posts, created_posts and posts[] with post_id,url,platform,account_id,scheduled_at when scheduled, readback:{id,account_id,status:published|scheduled,checked_at}. Preserve real provider responses as supporting artifacts. If proof is unavailable report the exact blocker; never label it published.`,status:'backlog',priority:'high',department:'social-media',assigned_agent_id:null,created_by_agent_id:null,workspace_id:null,idempotency_key:key,idempotency_company_id:q.company_id,source:'social-publish-verifier',eventMessage:`Readback ownership for ${q.id} ${v.target}`},{origin:'social-publish-verifier'});
            if(!result) throw new Error('Readback task creation failed');
            taskId=result.task.id;
            run('UPDATE social_publish_verifications SET task_id=? WHERE queue_id=? AND target=?',[taskId,q.id,v.target]);
          }
          const outcome=await adapters.dispatch(taskId!,'social-publish-verifier');
          attempts++;
          run(`UPDATE social_publish_verifications SET state='running',attempt_count=?,retry_at=?,error=?,updated_at=? WHERE queue_id=? AND target=?`,[attempts,retry,`Readback dispatch ${outcome.status}: ${outcome.reason??''}`,stamp,q.id,v.target]);
          dispatched++;
        } catch(error) {
          run(`UPDATE social_publish_verifications SET attempt_count=MIN(attempt_count+1,3),retry_at=?,error=?,updated_at=? WHERE queue_id=? AND target=?`,[retry,String(error),stamp,q.id,v.target]);
        }
      }
      // Dispatch awaits can span a source amendment. Recheck all accepted
      // targets immediately before deciding the aggregate completion state.
      invalidateChangedEvidence(q.id,q.company_id,q.cc_task_id,stamp);
      const states=queryAll<{state:string;retry_at:string;error:string|null}>('SELECT state,retry_at,error FROM social_publish_verifications WHERE queue_id=? AND state<>\'superseded\'',[q.id]);
      const state=states.length&&states.every(v=>v.state==='published')?'published':states.length&&states.every(v=>['published','scheduled'].includes(v.state))?'scheduled':'verification_required';
      run('UPDATE publish_queue SET status=?,retry_at=?,error=?,completed_at=?,updated_at=? WHERE id=? AND company_id=?',[state,state==='published'?null:states.filter(v=>v.state!=='published').map(v=>v.retry_at).sort()[0]??retry,state==='verification_required'?'Readback verification owned by per-target tasks; inspect social_publish_verifications for retry/worker/blocker details':null,state==='published'?stamp:null,stamp,q.id,q.company_id]);
      broadcast({type:`publish_state:${q.company_id}`,payload:{id:q.id,status:state}});
    } catch(error) {
      run('UPDATE publish_queue SET error=?,retry_at=?,updated_at=? WHERE id=?',[`Verification setup failed: ${String(error)}`,retry,stamp,q.id]);
    }
  }
  return {checked,dispatched,escalated};
}
