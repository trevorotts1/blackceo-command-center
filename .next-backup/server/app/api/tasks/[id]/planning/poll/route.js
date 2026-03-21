"use strict";(()=>{var e={};e.id=8300,e.ids=[8300],e.modules={5890:e=>{e.exports=require("better-sqlite3")},399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},4770:e=>{e.exports=require("crypto")},7702:e=>{e.exports=require("events")},2048:e=>{e.exports=require("fs")},9801:e=>{e.exports=require("os")},5315:e=>{e.exports=require("path")},4639:(e,n,s)=>{s.r(n),s.d(n,{originalPathname:()=>N,patchFetch:()=>f,requestAsyncStorage:()=>E,routeModule:()=>P,serverHooks:()=>m,staticGenerationAsyncStorage:()=>h});var t={};s.r(t),s.d(t,{GET:()=>_});var a=s(9303),o=s(8716),i=s(670),l=s(7070),r=s(8890),p=s(568),g=s(2858);let d=parseInt(process.env.PLANNING_TIMEOUT_MS||"30000",10),c=parseInt(process.env.PLANNING_POLL_INTERVAL_MS||"2000",10);if(isNaN(d)||d<1e3)throw Error("PLANNING_TIMEOUT_MS must be a valid number >= 1000ms");if(isNaN(c)||c<100)throw Error("PLANNING_POLL_INTERVAL_MS must be a valid number >= 100ms");async function u(e,n,s){let t=(0,r.zA)(),a=null,o=null;if(o=t.transaction(()=>{if(t.prepare(`
      UPDATE tasks
      SET planning_messages = ?,
          planning_spec = ?,
          planning_agents = ?,
          status = 'pending_dispatch',
          planning_dispatch_error = NULL
      WHERE id = ?
    `).run(JSON.stringify(s),JSON.stringify(n.spec),JSON.stringify(n.agents),e),n.agents&&n.agents.length>0){let s=t.prepare(`
        INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, soul_md, created_at, updated_at)
        VALUES (?, (SELECT workspace_id FROM tasks WHERE id = ?), ?, ?, ?, ?, 'standby', ?, datetime('now'), datetime('now'))
      `);for(let t of n.agents){let n=crypto.randomUUID();o||(o=n),s.run(n,e,t.name,t.role,t.instructions||"",t.avatar_emoji||"\uD83E\uDD16",t.soul_md||"")}}return o})()){let n=(0,r.pP)("SELECT workspace_id FROM tasks WHERE id = ?",[e]);if(n){let e=(0,r.pP)("SELECT id FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1",[n.workspace_id]),s=(0,r.Kt)(`SELECT id, name
         FROM agents
         WHERE is_master = 1
         AND id != ?
         AND workspace_id = ?
         AND status != 'offline'`,[e?.id??"",n.workspace_id]);s.length>0&&(a=`Cannot auto-dispatch: ${s.length} other orchestrator(s) available in workspace`,console.warn(`[Planning Poll] ${a}:`,s.map(e=>e.name).join(", ")),o=null)}}let i=!1;if(o){let n=(0,r.pP)("SELECT assigned_agent_id FROM tasks WHERE id = ?",[e]);n?.assigned_agent_id&&(console.log("[Planning Poll] Task already assigned to",n.assigned_agent_id,", skipping dispatch"),o=n.assigned_agent_id,a=null,i=!0)}if(o&&!i){let n=`http://localhost:${process.env.PORT||3e3}/api/tasks/${e}/dispatch`;console.log(`[Planning Poll] Triggering dispatch: ${n}`);try{let e=await fetch(n,{method:"POST",headers:{"Content-Type":"application/json"}});if(e.ok){let n=await e.json();console.log("[Planning Poll] Dispatch successful:",n)}else{let n=await e.text();a=`Dispatch failed (${e.status}): ${n}`,console.error(`[Planning Poll] ${a}`)}}catch(e){a=`Dispatch error: ${e.message}`,console.error(`[Planning Poll] ${a}`)}}t.transaction(()=>{a?t.prepare(`
        UPDATE tasks
        SET planning_dispatch_error = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(a,e):o?(t.prepare(`
        UPDATE tasks
        SET planning_complete = 1,
            assigned_agent_id = ?,
            status = 'backlog',
            planning_dispatch_error = NULL,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(o,e),console.log(`[Planning Poll] Planning complete and dispatched to agent ${o}`)):t.prepare(`
        UPDATE tasks
        SET planning_complete = 1,
            status = 'backlog',
            planning_dispatch_error = NULL,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(e)})();let l=(0,r.pP)("SELECT * FROM tasks WHERE id = ?",[e]);return l&&(0,p.fM)({type:"task_updated",payload:l}),{firstAgentId:o,parsed:n,dispatchError:a}}async function _(e,{params:n}){let{id:s}=await n;try{let e=(0,r.pP)("SELECT * FROM tasks WHERE id = ?",[s]);if(!e||!e.planning_session_key)return l.NextResponse.json({error:"Planning session not found"},{status:404});if(e.planning_complete)return l.NextResponse.json({hasUpdates:!1,isComplete:!0});if(e.planning_dispatch_error)return l.NextResponse.json({hasUpdates:!0,dispatchError:e.planning_dispatch_error});let n=e.planning_messages?JSON.parse(e.planning_messages):[],t=n.filter(e=>"assistant"===e.role).length;console.log("[Planning Poll] Task",s,"has",n.length,"total messages,",t,"assistant messages");let a=await (0,g.L)(e.planning_session_key);if(console.log("[Planning Poll] Comparison: stored_assistant=",t,"openclaw_assistant=",a.length),a.length>t){let e=null,o=a.slice(t);for(let t of(console.log("[Planning Poll] Processing",o.length,"new messages"),o))if(console.log("[Planning Poll] Processing new message, role:",t.role,"content length:",t.content?.length||0),"assistant"===t.role){let a={role:"assistant",content:t.content,timestamp:Date.now()};n.push(a);let o=(0,g.N)(t.content);if(console.log("[Planning Poll] Parsed message content:",{hasStatus:!!o?.status,hasQuestion:!!o?.question,hasOptions:!!o?.options,status:o?.status,question:o?.question?.substring(0,50),rawPreview:t.content?.substring(0,200)}),o&&"complete"===o.status){console.log("[Planning Poll] Planning complete, handling...");let{firstAgentId:e,parsed:t,dispatchError:a}=await u(s,o,n);return l.NextResponse.json({hasUpdates:!0,complete:!0,spec:t.spec,agents:t.agents,executionPlan:t.execution_plan,messages:n,autoDispatched:!!e,dispatchError:a})}o&&o.question&&o.options&&(console.log("[Planning Poll] Found question with",o.options.length,"options"),e=o)}return console.log("[Planning Poll] Returning updates: currentQuestion =",e?"YES":"NO"),(0,r.KH)("UPDATE tasks SET planning_messages = ? WHERE id = ?",[JSON.stringify(n),s]),l.NextResponse.json({hasUpdates:!0,complete:!1,messages:n,currentQuestion:e})}return console.log("[Planning Poll] No new messages found"),l.NextResponse.json({hasUpdates:!1})}catch(e){return console.error("Failed to poll for updates:",e),l.NextResponse.json({error:"Failed to poll for updates"},{status:500})}}let P=new a.AppRouteRouteModule({definition:{kind:o.x.APP_ROUTE,page:"/api/tasks/[id]/planning/poll/route",pathname:"/api/tasks/[id]/planning/poll",filename:"route",bundlePath:"app/api/tasks/[id]/planning/poll/route"},resolvedPagePath:"/Users/blackceomacmini/projects/mission-control/src/app/api/tasks/[id]/planning/poll/route.ts",nextConfigOutput:"",userland:t}),{requestAsyncStorage:E,staticGenerationAsyncStorage:h,serverHooks:m}=P,N="/api/tasks/[id]/planning/poll/route";function f(){return(0,i.patchFetch)({serverHooks:m,staticGenerationAsyncStorage:h})}}};var n=require("../../../../../../webpack-runtime.js");n.C(e);var s=e=>n(n.s=e),t=n.X(0,[8948,5972,6566,881],()=>s(4639));module.exports=t})();