"use strict";(()=>{var e={};e.id=3769,e.ids=[3769],e.modules={5890:e=>{e.exports=require("better-sqlite3")},399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},4770:e=>{e.exports=require("crypto")},7702:e=>{e.exports=require("events")},2048:e=>{e.exports=require("fs")},9801:e=>{e.exports=require("os")},5315:e=>{e.exports=require("path")},8898:(e,t,n)=>{n.r(t),n.d(t,{originalPathname:()=>N,patchFetch:()=>_,requestAsyncStorage:()=>h,routeModule:()=>E,serverHooks:()=>R,staticGenerationAsyncStorage:()=>k});var s={};n.r(s),n.d(s,{DELETE:()=>m,GET:()=>c,POST:()=>g});var a=n(9303),r=n(8716),i=n(670),o=n(7070),p=n(8890),l=n(6566),d=n(568),u=n(2858);async function c(e,{params:t}){let{id:n}=await t;try{let e=(0,p.zA)().prepare("SELECT * FROM tasks WHERE id = ?").get(n);if(!e)return o.NextResponse.json({error:"Task not found"},{status:404});let t=e.planning_messages?JSON.parse(e.planning_messages):[],s=[...t].reverse().find(e=>"assistant"===e.role),a=null;if(s){let e=(0,u.N)(s.content);e&&"question"in e&&(a=e)}return o.NextResponse.json({taskId:n,sessionKey:e.planning_session_key,messages:t,currentQuestion:a,isComplete:!!e.planning_complete,spec:e.planning_spec?JSON.parse(e.planning_spec):null,agents:e.planning_agents?JSON.parse(e.planning_agents):null,isStarted:t.length>0})}catch(e){return console.error("Failed to get planning state:",e),o.NextResponse.json({error:"Failed to get planning state"},{status:500})}}async function g(e,{params:t}){let{id:n}=await t;try{let e=(0,p.zA)().prepare("SELECT * FROM tasks WHERE id = ?").get(n);if(!e)return o.NextResponse.json({error:"Task not found"},{status:404});if(e.planning_session_key)return o.NextResponse.json({error:"Planning already started",sessionKey:e.planning_session_key},{status:400});let t=(0,p.pP)("SELECT id FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1",[e.workspace_id]),s=(0,p.Kt)(`SELECT id, name, role
       FROM agents
       WHERE is_master = 1
       AND id != ?
       AND workspace_id = ?
       AND status != 'offline'`,[t?.id??"",e.workspace_id]);if(s.length>0)return o.NextResponse.json({error:"Other orchestrators available",message:`There ${1===s.length?"is":"are"} ${s.length} other orchestrator${1===s.length?"":"s"} available in this workspace: ${s.map(e=>e.name).join(", ")}. Please assign this task to them directly.`,otherOrchestrators:s},{status:409});let a=`agent:main:planning:${n}`,r=`PLANNING REQUEST

Task Title: ${e.title}
Task Description: ${e.description||"No description provided"}

You are starting a planning session for this task. Read PLANNING.md for your protocol.

Generate your FIRST question to understand what the user needs. Remember:
- Questions must be multiple choice
- Include an "Other" option
- Be specific to THIS task, not generic

Respond with ONLY valid JSON in this format:
{
  "question": "Your question here?",
  "options": [
    {"id": "A", "label": "First option"},
    {"id": "B", "label": "Second option"},
    {"id": "C", "label": "Third option"},
    {"id": "other", "label": "Other"}
  ]
}`,i=(0,l.o)();i.isConnected()||await i.connect(),await i.call("chat.send",{sessionKey:a,message:r,idempotencyKey:`planning-start-${n}-${Date.now()}`});let d=[{role:"user",content:r,timestamp:Date.now()}];return(0,p.zA)().prepare(`
      UPDATE tasks
      SET planning_session_key = ?, planning_messages = ?, status = 'backlog'
      WHERE id = ?
    `).run(a,JSON.stringify(d),n),o.NextResponse.json({success:!0,sessionKey:a,messages:d,note:"Planning started. Poll GET endpoint for updates."})}catch(e){return console.error("Failed to start planning:",e),o.NextResponse.json({error:"Failed to start planning: "+e.message},{status:500})}}async function m(e,{params:t}){let{id:n}=await t;try{if(!(0,p.pP)("SELECT * FROM tasks WHERE id = ?",[n]))return o.NextResponse.json({error:"Task not found"},{status:404});(0,p.KH)(`
      UPDATE tasks
      SET planning_session_key = NULL,
          planning_messages = NULL,
          planning_complete = 0,
          planning_spec = NULL,
          planning_agents = NULL,
          status = 'backlog',
          updated_at = datetime('now')
      WHERE id = ?
    `,[n]);let e=(0,p.pP)("SELECT * FROM tasks WHERE id = ?",[n]);return e&&(0,d.fM)({type:"task_updated",payload:e}),o.NextResponse.json({success:!0})}catch(e){return console.error("Failed to cancel planning:",e),o.NextResponse.json({error:"Failed to cancel planning: "+e.message},{status:500})}}let E=new a.AppRouteRouteModule({definition:{kind:r.x.APP_ROUTE,page:"/api/tasks/[id]/planning/route",pathname:"/api/tasks/[id]/planning",filename:"route",bundlePath:"app/api/tasks/[id]/planning/route"},resolvedPagePath:"/Users/blackceomacmini/projects/mission-control/src/app/api/tasks/[id]/planning/route.ts",nextConfigOutput:"",userland:s}),{requestAsyncStorage:h,staticGenerationAsyncStorage:k,serverHooks:R}=E,N="/api/tasks/[id]/planning/route";function _(){return(0,i.patchFetch)({serverHooks:R,staticGenerationAsyncStorage:k})}}};var t=require("../../../../../webpack-runtime.js");t.C(e);var n=e=>t(t.s=e),s=t.X(0,[8948,5972,6566,881],()=>n(8898));module.exports=s})();