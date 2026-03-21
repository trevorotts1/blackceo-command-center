"use strict";(()=>{var e={};e.id=6651,e.ids=[6651],e.modules={5890:e=>{e.exports=require("better-sqlite3")},399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},4770:e=>{e.exports=require("crypto")},7702:e=>{e.exports=require("events")},2048:e=>{e.exports=require("fs")},9801:e=>{e.exports=require("os")},5315:e=>{e.exports=require("path")},2949:(e,t,s)=>{s.r(t),s.d(t,{originalPathname:()=>T,patchFetch:()=>y,requestAsyncStorage:()=>_,routeModule:()=>h,serverHooks:()=>m,staticGenerationAsyncStorage:()=>E});var a={};s.r(a),s.d(a,{POST:()=>g});var i=s(9303),r=s(8716),n=s(670),o=s(7070),d=s(4673),c=s(8890),p=s(6566),l=s(568),u=s(5844);async function g(e,{params:t}){try{let{id:e}=await t,s=(0,c.pP)(`SELECT t.*, a.name as assigned_agent_name, a.is_master
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       WHERE t.id = ?`,[e]);if(!s)return o.NextResponse.json({error:"Task not found"},{status:404});if(!s.assigned_agent_id)return o.NextResponse.json({error:"Task has no assigned agent"},{status:400});let a=(0,c.pP)("SELECT * FROM agents WHERE id = ?",[s.assigned_agent_id]);if(!a)return o.NextResponse.json({error:"Assigned agent not found"},{status:404});if(a.is_master){let e=(0,c.Kt)(`SELECT id, name, role
         FROM agents
         WHERE is_master = 1
         AND id != ?
         AND workspace_id = ?
         AND status != 'offline'`,[a.id,s.workspace_id]);if(e.length>0)return o.NextResponse.json({success:!1,warning:"Other orchestrators available",message:`There ${1===e.length?"is":"are"} ${e.length} other orchestrator${1===e.length?"":"s"} available in this workspace: ${e.map(e=>e.name).join(", ")}. Consider assigning this task to them instead.`,otherOrchestrators:e},{status:409})}let i=(0,p.o)();if(!i.isConnected())try{await i.connect()}catch(e){return console.error("Failed to connect to OpenClaw Gateway:",e),o.NextResponse.json({error:"Failed to connect to the backend gateway"},{status:503})}let r=(0,c.pP)("SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?",[a.id,"active"]),n=new Date().toISOString();if(!r){let e=(0,d.Z)(),t=`mission-control-${a.name.toLowerCase().replace(/\s+/g,"-")}`;(0,c.KH)(`INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,[e,a.id,t,"mission-control","active",n,n]),r=(0,c.pP)("SELECT * FROM openclaw_sessions WHERE id = ?",[e]),(0,c.KH)(`INSERT INTO events (id, type, agent_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,[(0,d.Z)(),"agent_status_changed",a.id,`${a.name} session created`,n])}if(!r)return o.NextResponse.json({error:"Failed to create agent session"},{status:500});let g={low:"\uD83D\uDD35",medium:"⚪",high:"\uD83D\uDFE1",critical:"\uD83D\uDD34"}[s.priority]||"⚪",h=(0,u.nR)(),_=s.title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""),E=`${h}/${_}`,m=(0,u.qN)(),T=`${g} **NEW TASK ASSIGNED**

**Title:** ${s.title}
${s.description?`**Description:** ${s.description}
`:""}
**Priority:** ${s.priority.toUpperCase()}
${s.due_date?`**Due:** ${s.due_date}
`:""}
**Task ID:** ${s.id}

**OUTPUT DIRECTORY:** ${E}
Create this directory and save all deliverables there.

**IMPORTANT:** After completing work, you MUST call these APIs:
1. Log activity: POST ${m}/api/tasks/${s.id}/activities
   Body: {"activity_type": "completed", "message": "Description of what was done"}
2. Register deliverable: POST ${m}/api/tasks/${s.id}/deliverables
   Body: {"deliverable_type": "file", "title": "File name", "path": "${E}/filename.html"}
3. Update status: PATCH ${m}/api/tasks/${s.id}
   Body: {"status": "review"}

When complete, reply with:
\`TASK_COMPLETE: [brief summary of what you did]\`

If you need help or clarification, ask the orchestrator.`;try{let t=`agent:main:${r.openclaw_session_id}`;await i.call("chat.send",{sessionKey:t,message:T,idempotencyKey:`dispatch-${s.id}-${Date.now()}`}),(0,c.KH)("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",["in_progress",n,e]);let p=(0,c.pP)("SELECT * FROM tasks WHERE id = ?",[e]);p&&(0,l.fM)({type:"task_updated",payload:p}),(0,c.KH)("UPDATE agents SET status = ?, updated_at = ? WHERE id = ?",["working",n,a.id]);let u=(0,d.Z)();(0,c.KH)(`INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,[u,"task_dispatched",a.id,s.id,`Task "${s.title}" dispatched to ${a.name}`,n]);let g=crypto.randomUUID();return(0,c.KH)(`INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,[g,s.id,a.id,"status_changed",`Task dispatched to ${a.name} - Agent is now working on this task`,n]),o.NextResponse.json({success:!0,task_id:s.id,agent_id:a.id,session_id:r.openclaw_session_id,message:"Task dispatched to agent"})}catch(e){return console.error("Failed to send message to agent:",e),o.NextResponse.json({error:"Internal server error"},{status:500})}}catch(e){return console.error("Failed to dispatch task:",e),o.NextResponse.json({error:"Internal server error"},{status:500})}}let h=new i.AppRouteRouteModule({definition:{kind:r.x.APP_ROUTE,page:"/api/tasks/[id]/dispatch/route",pathname:"/api/tasks/[id]/dispatch",filename:"route",bundlePath:"app/api/tasks/[id]/dispatch/route"},resolvedPagePath:"/Users/blackceomacmini/projects/mission-control/src/app/api/tasks/[id]/dispatch/route.ts",nextConfigOutput:"",userland:a}),{requestAsyncStorage:_,staticGenerationAsyncStorage:E,serverHooks:m}=h,T="/api/tasks/[id]/dispatch/route";function y(){return(0,n.patchFetch)({serverHooks:m,staticGenerationAsyncStorage:E})}},5844:(e,t,s)=>{function a(){return process.env.MISSION_CONTROL_URL||"http://localhost:4000"}function i(){return process.env.PROJECTS_PATH||"~/Documents/Shared/projects"}s.d(t,{nR:()=>i,qN:()=>a})},568:(e,t,s)=>{s.d(t,{Ty:()=>r,fM:()=>n,z1:()=>i});let a=new Set;function i(e){a.add(e)}function r(e){a.delete(e)}function n(e){let t=new TextEncoder,s=`data: ${JSON.stringify(e)}

`,i=t.encode(s);for(let e of Array.from(a))try{e.enqueue(i)}catch(t){console.error("Failed to send SSE event to client:",t),a.delete(e)}console.log(`[SSE] Broadcast ${e.type} to ${a.size} client(s)`)}}};var t=require("../../../../../webpack-runtime.js");t.C(e);var s=e=>t(t.s=e),a=t.X(0,[8948,5972,420,6566],()=>s(2949));module.exports=a})();