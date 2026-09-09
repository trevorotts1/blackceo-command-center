import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import {getDb,run,queryOne,closeDb} from '../../src/lib/db';
import {runSocialPublishDispatcherSweep} from '../../src/lib/jobs/social-publish-dispatcher';
import {buildPublishMessage,type SummaryPublishRow} from '../../src/lib/social/summary';
getDb();
test.after(()=>closeDb());

test('a completed canonical task never invents remote publication proof',async()=>{
 const now=new Date().toISOString();
 for(const id of ['proof-company','other-company']) run('INSERT OR IGNORE INTO companies (id,name,slug) VALUES (?,?,?)',[id,id,id]);
 run(`INSERT INTO workspaces (id,name,slug,company_id) VALUES ('proof-workspace','Proof','proof-workspace','proof-company')`);
 run(`INSERT INTO tasks (id,title,status,workspace_id,created_at,updated_at) VALUES ('proof-task','completed production task','done','proof-workspace',?,?)`,[now,now]);
 run(`INSERT INTO publish_queue (id,company_id,topic,platforms,status,cc_task_id,created_at,updated_at) VALUES ('proof-queue','proof-company','fixture','["linkedin","instagram"]','running','proof-task',?,?)`,[now,now]);
 // Independent already scheduled work remains scheduled, never blocked by this row.
 run(`INSERT INTO publish_queue (id,company_id,topic,platforms,status,created_at,updated_at) VALUES ('healthy-queue','other-company','fixture','["youtube"]','scheduled',?,?)`,[now,now]);
 await runSocialPublishDispatcherSweep();
 const row=queryOne<SummaryPublishRow & {completed_at:string|null}>(`SELECT * FROM publish_queue WHERE id='proof-queue'`)!;
 assert.equal(row.status,'verification_required');
 assert.equal(row.completed_at,null);
 assert.match(row.error??'',/readback receipts/);
 assert.equal(queryOne<{status:string}>(`SELECT status FROM publish_queue WHERE id='healthy-queue'`)!.status,'scheduled');
 const summary=buildPublishMessage(row,{id:'proof-task',status:'done',updated_at:now});
 assert.equal(summary.stage,'verification required');
 assert.equal(summary.owner,'system');
 assert.match(summary.nextAction,/each requested account/);
 await runSocialPublishDispatcherSweep();
 assert.equal(queryOne<{status:string}>(`SELECT status FROM publish_queue WHERE id='proof-queue'`)!.status,'verification_required','another tick cannot promote without proof');
});

test('legacy generic done also means verification required, not published',()=>{
 const row=queryOne<SummaryPublishRow>(`SELECT * FROM publish_queue WHERE id='proof-queue'`)!;
 const result=buildPublishMessage({...row,status:'done'},null);
 assert.equal(result.stage,'verification required');
 assert.notEqual(result.stage,'published');
 const scheduled=buildPublishMessage({...row,status:'scheduled'},null);
 assert.equal(scheduled.stage,'scheduled');
});
