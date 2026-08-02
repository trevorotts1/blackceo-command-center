/**
 * U030 (audit E1) — build_deck board-source acceptance tests.
 * Runs via Node built-in test runner under tsx.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createHmac } from 'node:crypto'; import { NextRequest } from 'next/server';

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(),'u030-')),'db');
process.env.DATABASE_PATH = DB;
process.env.MC_API_TOKEN = 't'; process.env.WEBHOOK_SECRET = 's';

function hmac(b:string):string{return createHmac('sha256','s').update(b).digest('hex')}
function req(id:string,body:string,a?:string,s?:string):NextRequest{
  const h:Record<string,string>={'content-type':'application/json'};
  if(a)h['authorization']=a; if(s)h['x-webhook-signature']=s;
  return new NextRequest(`http://localhost/api/tasks/${id}/status`,{method:'POST',headers:h,body});
}

let run:Function,q1:Function,close:Function,POST:Function,PATCH:Function,WSID:string;
function st(id:string):string|undefined{return q1('SELECT status FROM tasks WHERE id=?',[id])?.status}

test.before(async()=>{
  const db=await import('../../src/lib/db'); run=db.run; q1=db.queryOne; close=db.closeDb; db.getDb();
  const n=new Date().toISOString(); WSID='ws-'+Math.random().toString(36).slice(2,8);
  run("INSERT OR IGNORE INTO companies(id,name,slug,config,created_at,updated_at) VALUES ('default','D','d','{}',?,?)",[n,n]);
  run("INSERT OR IGNORE INTO workspaces(id,slug,name,icon,company_id,sort_order,created_at,updated_at) VALUES (?,'t','U030','?','default',1,?,?)",[WSID,n,n]);
  POST=(await import('../../src/app/api/tasks/[id]/status/route')).POST;
  const pm=await import('../../src/app/api/tasks/[id]/route'); PATCH=(pm.default??pm).PATCH;
});
test.after(()=>{try{close?.()}catch{}try{fs.rmSync(path.dirname(DB),{recursive:true,force:true})}catch{}});

function mk(src:string,status='backlog'):string{
  const id='u030-'+Math.random().toString(36).slice(2)+Date.now();
  const n=new Date().toISOString();
  run("INSERT INTO tasks(id,title,description,department,status,source,workspace_id,business_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",[id,'t','seed','presentations',status,src,WSID,'default',n,n]);
  return id;
}
async function post(id:string,b:object):Promise<Response>{
  const raw=JSON.stringify(b);
  return POST(req(id,raw,'Bearer t',hmac(raw)),{params:Promise.resolve({id})})as unknown as Promise<Response>;
}

test('build_deck→in_progress via POST/status 200',async()=>{
  const id=mk('build_deck');
  const r=await post(id,{status:'in_progress',note:'[P4-RENDER] rendering'});
  assert.equal(r.status,200); assert.equal(st(id),'in_progress');
  assert.match(q1('SELECT description FROM tasks WHERE id=?',[id]).description,/P4-RENDER/);
});
test('build_deck→PATCH still 400',async()=>{
  const id=mk('build_deck');
  const r=await PATCH({json:async()=>({status:'in_progress'}),headers:{get:()=>null}},{params:Promise.resolve({id})});
  const b=await r.json(); assert.equal(r.status,400); assert.equal(b.error,'Triad incomplete'); assert.equal(st(id),'backlog');
});
test('telegram→403',async()=>{
  const id=mk('telegram'); const r=await post(id,{status:'in_progress'});
  assert.equal(r.status,403); assert.equal(st(id),'backlog');
});
test('done→403',async()=>{
  const id=mk('build_deck','review'); const r=await post(id,{status:'done'});
  assert.equal(r.status,403); assert.equal(st(id),'review');
});
test('backlog→review→200 (FIX-5-HIGH-C10-BOARD-5b)',async()=>{
  const id=mk('build_deck'); const r=await post(id,{status:'review'});
  assert.equal(r.status,200); assert.equal(st(id),'review');
});
test('engineSourceLabel',async()=>{
  const m=await import('../../src/components/TaskOverviewPanels');
  assert.ok(m.engineSourceLabel({source:'build_deck',description:null}));
  assert.equal(m.engineSourceLabel({source:'telegram',description:null}),null);
  assert.equal(m.engineSourceLabel({source:'funnel',description:null}),'a Skill 6 funnel build');
});
