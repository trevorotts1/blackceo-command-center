import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

// The real client/message handler runs against an in-memory transport. Seed a
// private identity so construction neither reads nor copies an installed key.
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'rpc-correlation-'));
process.env.BCC_DEVICE_IDENTITY_DIR=fixture;
const pair=generateKeyPairSync('ed25519');
fs.writeFileSync(path.join(fixture,'device.json'),JSON.stringify({version:1,deviceId:'fixture',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString(),privateKeyPem:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString(),createdAtMs:Date.now()}),{mode:0o600});

type Frame={type?:string;id?:string;method?:string;payload?:unknown;[key:string]:unknown};
class FixtureSocket {
 static OPEN=1;static CONNECTING=0;static latest:FixtureSocket;
 readyState=1;
 onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onerror:((error:unknown)=>void)|null=null;
 onmessage:((event:{data:string})=>void)|null=null;
 requests:Frame[]=[];
 constructor(){FixtureSocket.latest=this;queueMicrotask(()=>{this.onopen?.();this.receive({type:'event',event:'connect.challenge',payload:{nonce:randomUUID()}});});}
 receive(frame:Frame){this.onmessage?.({data:JSON.stringify(frame)});}
 send(raw:string){const frame=JSON.parse(raw) as Frame;this.requests.push(frame);if(frame.method==='connect')queueMicrotask(()=>this.receive({type:'res',id:frame.id,ok:true,payload:{}}));}
 close(){this.readyState=3;this.onclose?.();}
}
async function flush(){await Promise.resolve();await Promise.resolve();}

test('RPC replies correlate by pending ID while only events are content-deduplicated',async t=>{
 const original=globalThis.WebSocket;
 globalThis.WebSocket=FixtureSocket as unknown as typeof WebSocket;
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const {OpenClawClient}=await import('../../src/lib/openclaw/client');
 const client=new OpenClawClient('ws://127.0.0.1:1','fixture-only');
 try {
  await client.connect();const socket=FixtureSocket.latest;
  await t.test('two different request IDs with identical bodies both resolve, even matching auth reply',async()=>{
   const resolved:unknown[]=[];
   const first=client.call('fixture.first').then(value=>{resolved.push(value);return value;});
   const second=client.call('fixture.second').then(value=>{resolved.push(value);return value;});
   const [one,two]=socket.requests.slice(-2);assert.notEqual(one.id,two.id);
   socket.receive({type:'res',id:two.id,ok:true,payload:{}});
   socket.receive({type:'res',id:one.id,ok:true,payload:{}});
   await flush();assert.equal(resolved.length,2,'both empty acknowledgements must be delivered');
   assert.deepEqual(await Promise.all([first,second]),[{},{}]);
  });
  await t.test('completed and unrelated response IDs cannot resolve another pending request',async()=>{
   const completedId=socket.requests.at(-1)!.id;
   let settled=false;const pending=client.call('fixture.third').then(value=>{settled=true;return value;});
   const expectedId=socket.requests.at(-1)!.id;
   socket.receive({type:'res',id:completedId,ok:true,payload:{wrong:'duplicate'}});
   socket.receive({type:'res',id:randomUUID(),ok:true,payload:{wrong:'unrelated'}});
   socket.receive({type:'res',ok:true,payload:{wrong:'missing-id'}});
   await flush();assert.equal(settled,false,'unowned replies are inert');
   socket.receive({type:'res',id:expectedId,ok:true,payload:{correct:true}});
   await flush();assert.equal(settled,true);assert.deepEqual(await pending,{correct:true});
  });
  await t.test('error replies are fenced by request ID too',async()=>{
   let rejected=0;const one=client.call('fixture.error-one').catch(error=>{rejected++;return error.message;});const two=client.call('fixture.error-two').catch(error=>{rejected++;return error.message;});
   for(const request of socket.requests.slice(-2))socket.receive({type:'res',id:request.id,ok:false,error:{message:'same refusal'}});
   await flush();assert.equal(rejected,2);assert.deepEqual(await Promise.all([one,two]),['same refusal','same refusal']);
  });
  await t.test('supported legacy result and error replies use their pending IDs, not body hashes',async()=>{
   const resolved:unknown[]=[];
   const first=client.call('legacy.one').then(value=>{resolved.push(value);return value;});
   const second=client.call('legacy.two').then(value=>{resolved.push(value);return value;});
   const [one,two]=socket.requests.slice(-2);
   socket.receive({jsonrpc:'2.0',id:two.id,result:{}});socket.receive({jsonrpc:'2.0',id:one.id,result:{}});
   await flush();assert.equal(resolved.length,2);assert.deepEqual(await Promise.all([first,second]),[{},{}]);
   let finished=false;const third=client.call('legacy.three').then(value=>{finished=true;return value;});
   const expected=socket.requests.at(-1)!.id;
   socket.receive({jsonrpc:'2.0',id:one.id,result:'duplicate'});socket.receive({jsonrpc:'2.0',id:randomUUID(),result:'unrelated'});
   await flush();assert.equal(finished,false);
   socket.receive({jsonrpc:'2.0',id:expected,result:'correct'});await flush();assert.equal(finished,true);assert.equal(await third,'correct');
   let rejected=0;const errors=[client.call('legacy.error-one').catch(error=>{rejected++;return error.message;}),client.call('legacy.error-two').catch(error=>{rejected++;return error.message;})];
   for(const request of socket.requests.slice(-2))socket.receive({jsonrpc:'2.0',id:request.id,error:{message:'legacy refusal'}});
   await flush();assert.equal(rejected,2);assert.deepEqual(await Promise.all(errors),['legacy refusal','legacy refusal']);
  });
  await t.test('duplicate events remain suppressed and different event payloads are delivered',()=>{
   const values:unknown[]=[];client.on('fixture.event',value=>values.push(value));
   const event={type:'event',event:'fixture.event',method:'fixture.event',seq:1,payload:{value:1},params:{value:1}};
   socket.receive(event);socket.receive(event);
   socket.receive({...event,seq:2,payload:{value:2},params:{value:2}});
   // Even an unknown res carrying event-looking fields remains a response.
   socket.receive({...event,type:'res',id:randomUUID()});
   assert.deepEqual(values,[{value:1},{value:2}]);
  });
 }finally{client.disconnect();globalThis.WebSocket=original;t.mock.timers.reset();fs.rmSync(fixture,{recursive:true,force:true});}
});
