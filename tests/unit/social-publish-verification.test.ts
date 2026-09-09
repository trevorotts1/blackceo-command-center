import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {getDb,run,queryOne} from '../../src/lib/db';
import {runSocialVerificationSweep,verificationAdapters} from '../../src/lib/jobs/social-publish-verification';
import {artifactDir} from '../../src/lib/task-lifecycle';
getDb();
process.env.PROJECTS_PATH=fs.mkdtempSync(path.join(os.tmpdir(),'social-verifier-'));
let seq=0;const notices:string[]=[];const descriptions:string[]=[];
const adapters={
 create:(async(input:{description?:string})=>{const id=`verify-fixture-${++seq}`;descriptions.push(input.description??'');run("INSERT INTO tasks(id,title,status,workspace_id) VALUES (?,?,'backlog','verify-ws')",[id,id]);return {task:{id},deduped:false};}) as typeof verificationAdapters.create,
 dispatch:(async()=>({status:'acknowledged',reason:'fixture',executionId:'fixture-exec'})) as typeof verificationAdapters.dispatch,
 notify:((message:string)=>{notices.push(message);return true;}) as typeof verificationAdapters.notify,
};
const start=Date.now();
run("INSERT INTO companies(id,name,slug) VALUES ('verify-co','Fixture','verify-co')");
run("INSERT INTO workspaces(id,name,slug,company_id) VALUES ('verify-ws','Fixture','verify-ws','verify-co')");
run("INSERT INTO tasks(id,title,status,workspace_id) VALUES ('source-task','Production','done','verify-ws')");
function seed(id:string,platforms:string[],stamp=start){
 const task=`source-${id}`;run("INSERT INTO tasks(id,title,status,workspace_id) VALUES (?,?,'done','verify-ws')",[task,task]);
 run("INSERT INTO publish_queue(id,company_id,topic,platforms,status,cc_task_id,created_at,updated_at) VALUES (?,'verify-co','fixture',?,'verification_required',?,?,?)",[id,JSON.stringify(platforms),task,new Date(stamp).toISOString(),new Date(stamp).toISOString()]);
 const posts:any[]=[];
 for(const platform of platforms){
  let accounts=getDb().prepare("SELECT id FROM social_connected_accounts WHERE company_id='verify-co' AND platform=?").all(platform) as {id:string}[];
  if(!accounts.length){const account=`fixture-${platform}`;run("INSERT INTO social_connected_accounts(id,company_id,platform,account_name,health) VALUES (?,'verify-co',?,?,'ready')",[account,platform,account]);accounts=[{id:account}];}
  for(const account of accounts)posts.push({account_id:account.id,platform,post_id:`post-${id}-account:${account.id}`});
 }
 const dir=artifactDir(task);fs.mkdirSync(dir,{recursive:true});const p=path.join(dir,'publish-receipts.json');fs.writeFileSync(p,JSON.stringify({company_id:'verify-co',queue_id:id,planned_posts:posts.length,posts}));
 run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title,path,sha256) VALUES (?,?,'artifact','Source',?,?)",[`receipt-${task}`,task,p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);
}
function proof(queue:string,target:string,now:number,state='published',mutate?:(body:any)=>void){
 const row=queryOne<{task_id:string;platform:string;account_id:string|null}>('SELECT * FROM social_publish_verifications WHERE queue_id=? AND target=?',[queue,target])!;
 const source=queryOne<{sha256:string}>("SELECT d.sha256 FROM task_deliverables d JOIN publish_queue q ON q.cc_task_id=d.task_id WHERE q.id=?",[queue])!;
 const body={company_id:'verify-co',queue_id:queue,source_receipt_sha256:source.sha256,planned_posts:1,created_posts:1,posts:[{post_id:`post-${queue}-${target}`,url:'https://example.com/post',platform:row.platform,account_id:row.account_id??'resolved-account',scheduled_at:new Date(now+600_000).toISOString(),readback:{id:`post-${queue}-${target}`,account_id:row.account_id??'resolved-account',status:state,checked_at:new Date(now).toISOString()}}]};
 mutate?.(body);
 const dir=artifactDir(row.task_id);fs.mkdirSync(dir,{recursive:true});const p=path.join(dir,'publish-receipts.json');fs.writeFileSync(p,JSON.stringify(body));
 run('UPDATE tasks SET status=\'done\' WHERE id=?',[row.task_id]);
 run('DELETE FROM task_deliverables WHERE task_id=?',[row.task_id]);
 run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title,path,sha256) VALUES (?,?,'artifact','Readback',?,?)",[`receipt-${row.task_id}`,row.task_id,p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);
 return p;
}

test('verification stays actively owned, per-target, bounded and visible until real receipt proof',async()=>{
 seed('owned',['linkedin','instagram']);
 const first=await runSocialVerificationSweep(start,adapters);
 assert.equal(first.dispatched,2);assert.ok(descriptions.every(x=>x.includes('READBACK ONLY')&&x.includes('Never create, repost')));
 const initial=seq;
 await runSocialVerificationSweep(start+60_000,adapters);assert.equal(seq,initial,'not due yet');
 run("UPDATE tasks SET status='done' WHERE id IN (SELECT task_id FROM social_publish_verifications WHERE queue_id='owned')");
 await runSocialVerificationSweep(start+121_000,adapters);assert.equal(seq,initial+2,'missing receipt gets new owned readback tasks, not terminal silence');
 proof('owned','account:fixture-linkedin',start+242_000);
 await runSocialVerificationSweep(start+242_000,adapters);
 assert.equal(queryOne<{state:string}>("SELECT state FROM social_publish_verifications WHERE queue_id='owned' AND platform='linkedin'")!.state,'published','healthy target confirms independently');
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='owned'")!.status,'verification_required','other target still unresolved');
 await runSocialVerificationSweep(start+16*60_000,adapters);
 assert.ok(notices.some(x=>x.includes('account:fixture-instagram')),'overdue verification alerts once');
 const count=notices.length;await runSocialVerificationSweep(start+19*60_000,adapters);assert.equal(notices.length,count,'unchanged escalation not spammed');
 proof('owned','account:fixture-instagram',start+22*60_000);
 await runSocialVerificationSweep(start+22*60_000,adapters);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='owned'")!.status,'published','late valid proof reconciles even after dispatch budget');
});

test('foreign, modified and future scheduled proof cannot be mistaken for publication',async()=>{
 const now=start+30*60_000;seed('isolation',['youtube'],now);
 await runSocialVerificationSweep(now,adapters);
 proof('isolation','account:fixture-youtube',now+121_000,'published',b=>{b.company_id='foreign';});
 await runSocialVerificationSweep(now+121_000,adapters);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='isolation'")!.status,'verification_required');
 const p=proof('isolation','account:fixture-youtube',now+242_000);fs.appendFileSync(p,' ');
 await runSocialVerificationSweep(now+242_000,adapters);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='isolation'")!.status,'verification_required','changed hash rejected');
 proof('isolation','account:fixture-youtube',now+363_000,'scheduled');
 await runSocialVerificationSweep(now+363_000,adapters);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='isolation'")!.status,'scheduled');
 const before=seq;
 await runSocialVerificationSweep(now+364_000,adapters);assert.equal(seq,before,'future posting waits until due');
 await runSocialVerificationSweep(now+1_084_000,adapters);assert.ok(seq>before,'scheduled post gets a new readback after due time');
 assert.notEqual(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='isolation'")!.status,'published');
});

test('verification never touches unrelated queued or independently scheduled work',async()=>{
 run("INSERT INTO publish_queue(id,company_id,topic,platforms,status) VALUES ('unrelated-queued','verify-co','fixture','[\"x\"]','queued'),('unrelated-scheduled','verify-co','fixture','[\"pinterest\"]','scheduled')");
 await runSocialVerificationSweep(start+100*60_000,adapters);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='unrelated-queued'")!.status,'queued');
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='unrelated-scheduled'")!.status,'scheduled');
});

test('verification rejects symlinked proof and wrong known account while healthy account proceeds',async()=>{
 const now=start+120*60_000;
 for(const id of ['verify-account-a','verify-account-b'])run("INSERT INTO social_connected_accounts(id,company_id,platform,account_name,health) VALUES (?,'verify-co','linkedin',?,'ready')",[id,id]);
 seed('account-scope',['linkedin'],now);await runSocialVerificationSweep(now,adapters);
 proof('account-scope','account:verify-account-a',now+121_000);
 const p=proof('account-scope','account:verify-account-b',now+121_000,'published',b=>{b.posts[0].account_id='verify-account-a';b.posts[0].readback.account_id='verify-account-a';});
 await runSocialVerificationSweep(now+121_000,adapters);
 assert.equal(queryOne<{state:string}>("SELECT state FROM social_publish_verifications WHERE queue_id='account-scope' AND account_id='verify-account-a'")!.state,'published');
 assert.notEqual(queryOne<{state:string}>("SELECT state FROM social_publish_verifications WHERE queue_id='account-scope' AND account_id='verify-account-b'")!.state,'published');
 const p2=proof('account-scope','account:verify-account-b',now+242_000);
 fs.renameSync(p2,p2+'.real');fs.symlinkSync(p2+'.real',p2);
 await runSocialVerificationSweep(now+242_000,adapters);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='account-scope'")!.status,'verification_required');
 fs.unlinkSync(p2);void p;
});

test('creation failures consume a bounded retry budget and remain visible for recovery',async()=>{
 const now=start+180*60_000;seed('create-failure',['tiktok'],now);let calls=0;
 const failing={...adapters,create:(async(input:any,...rest:any[])=>{if(input.description.includes('publish queue create-failure')){calls++;throw new Error('fixture create unavailable');}return (adapters.create as any)(input,...rest);}) as typeof adapters.create};
 for(let i=0;i<6;i++)await runSocialVerificationSweep(now+i*121_000,failing);
 assert.equal(calls,3,'no infinite creation retry');
 const row=queryOne<{attempt_count:number;error:string;retry_at:string}>("SELECT * FROM social_publish_verifications WHERE queue_id='create-failure'")!;
 assert.equal(row.attempt_count,3);assert.match(row.error,/limit reached/);assert.ok(row.retry_at);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='create-failure'")!.status,'verification_required');
});

test('source inventory and company-owned account are mandatory; later accounts are not added',async()=>{
 const now=start+240*60_000;seed('inventory-proof',['threads'],now);
 run("INSERT INTO social_connected_accounts(id,company_id,platform,account_name,health) VALUES ('late-account','verify-co','threads','Late','ready')");
 await runSocialVerificationSweep(now,adapters);
 assert.equal(queryOne<{n:number}>("SELECT count(*) n FROM social_publish_verifications WHERE queue_id='inventory-proof'")!.n,1,'only original intended account');
 const source=queryOne<{id:string;path:string}>("SELECT d.id,d.path FROM task_deliverables d JOIN publish_queue q ON q.cc_task_id=d.task_id WHERE q.id='inventory-proof'")!;
 const body=JSON.parse(fs.readFileSync(source.path,'utf8'));
 body.posts.push({...body.posts[0],post_id:'second-planned-post'});body.planned_posts=2;
 fs.writeFileSync(source.path,JSON.stringify(body));run('UPDATE task_deliverables SET sha256=? WHERE id=?',[createHash('sha256').update(fs.readFileSync(source.path)).digest('hex'),source.id]);
 proof('inventory-proof','account:fixture-threads',now+121_000);
 await runSocialVerificationSweep(now+121_000,adapters);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='inventory-proof'")!.status,'verification_required','one-of-two proof rejected despite self-consistent counters');
 // Restore a complete legacy source inventory without explicit company/queue:
 // canonical source task ownership remains required and supplies that binding.
 body.posts.pop();body.planned_posts=1;delete body.company_id;delete body.queue_id;
 fs.writeFileSync(source.path,JSON.stringify(body));run('UPDATE task_deliverables SET sha256=? WHERE id=?',[createHash('sha256').update(fs.readFileSync(source.path)).digest('hex'),source.id]);
 proof('inventory-proof','account:fixture-threads',now+242_000);
 run("UPDATE social_connected_accounts SET company_id='default' WHERE id='fixture-threads'");
 await runSocialVerificationSweep(now+242_000,adapters);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='inventory-proof'")!.status,'verification_required','foreign/unowned account cannot close');
 run("UPDATE social_connected_accounts SET company_id='verify-co' WHERE id='fixture-threads'");
 proof('inventory-proof','account:fixture-threads',now+363_000);
 run("UPDATE tasks SET status='review' WHERE id='source-inventory-proof'");
 await runSocialVerificationSweep(now+363_000,adapters);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='inventory-proof'")!.status,'verification_required','reopened source QC prevents publication confirmation');
 run("UPDATE tasks SET status='done' WHERE id='source-inventory-proof'");
 proof('inventory-proof','account:fixture-threads',now+484_000);
 await runSocialVerificationSweep(now+484_000,adapters);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='inventory-proof'")!.status,'published','legacy source is accepted only with real canonical company/task binding');
});

test('missing inventory placeholder is replaced when real owned account inventory becomes available',async()=>{
 const now=start+300*60_000;seed('placeholder',['bluesky'],now);
 const source=queryOne<{path:string}>("SELECT d.path FROM task_deliverables d JOIN publish_queue q ON q.cc_task_id=d.task_id WHERE q.id='placeholder'")!;
 fs.renameSync(source.path,source.path+'.held');
 await runSocialVerificationSweep(now,adapters);
 assert.equal(queryOne<{state:string}>("SELECT state FROM social_publish_verifications WHERE queue_id='placeholder' AND target='platform:bluesky'")!.state,'running');
 fs.renameSync(source.path+'.held',source.path);
 await runSocialVerificationSweep(now+121_000,adapters);
 assert.equal(queryOne<{state:string}>("SELECT state FROM social_publish_verifications WHERE queue_id='placeholder' AND target='platform:bluesky'")!.state,'superseded');
 proof('placeholder','account:fixture-bluesky',now+242_000);
 await runSocialVerificationSweep(now+242_000,adapters);
 assert.equal(queryOne<{status:string}>("SELECT status FROM publish_queue WHERE id='placeholder'")!.status,'published','obsolete placeholder cannot stall concrete verified target');
});
