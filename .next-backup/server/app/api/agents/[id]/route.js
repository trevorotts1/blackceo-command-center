"use strict";(()=>{var e={};e.id=9969,e.ids=[9969],e.modules={5890:e=>{e.exports=require("better-sqlite3")},399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},4770:e=>{e.exports=require("crypto")},2048:e=>{e.exports=require("fs")},5315:e=>{e.exports=require("path")},1581:(e,t,s)=>{s.r(t),s.d(t,{originalPathname:()=>R,patchFetch:()=>y,requestAsyncStorage:()=>g,routeModule:()=>E,serverHooks:()=>_,staticGenerationAsyncStorage:()=>h});var n={};s.r(n),s.d(n,{DELETE:()=>m,GET:()=>c,PATCH:()=>l});var o=s(9303),r=s(8716),i=s(670),a=s(7070),d=s(4673),u=s(8890),p=s(7542);async function c(e,{params:t}){try{let{id:e}=await t,s=(0,u.pP)("SELECT * FROM agents WHERE id = ?",[e]);if(!s)return a.NextResponse.json({error:"Agent not found"},{status:404});return a.NextResponse.json(s)}catch(e){return console.error("Failed to fetch agent:",e),a.NextResponse.json({error:"Failed to fetch agent"},{status:500})}}async function l(e,{params:t}){try{let{id:s}=await t,n=await e.json(),o=(0,u.pP)("SELECT * FROM agents WHERE id = ?",[s]);if(!o)return a.NextResponse.json({error:"Agent not found"},{status:404});let r=[],i=[];if(void 0!==n.name&&(r.push("name = ?"),i.push(n.name)),void 0!==n.role&&(r.push("role = ?"),i.push(n.role)),void 0!==n.description&&(r.push("description = ?"),i.push(n.description)),void 0!==n.avatar_emoji&&(r.push("avatar_emoji = ?"),i.push(n.avatar_emoji)),void 0!==n.status){r.push("status = ?"),i.push(n.status);let e=new Date().toISOString();(0,u.KH)(`INSERT INTO events (id, type, agent_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,[(0,d.Z)(),"agent_status_changed",s,`${o.name} is now ${n.status}`,e])}if(void 0!==n.is_master&&(r.push("is_master = ?"),i.push(n.is_master?1:0)),void 0!==n.soul_md&&(r.push("soul_md = ?"),i.push(n.soul_md)),void 0!==n.user_md&&(r.push("user_md = ?"),i.push(n.user_md)),void 0!==n.agents_md&&(r.push("agents_md = ?"),i.push(n.agents_md)),void 0!==n.tools_md&&(r.push("tools_md = ?"),i.push(n.tools_md)),void 0!==n.memory_md&&(r.push("memory_md = ?"),i.push(n.memory_md)),void 0!==n.model&&(r.push("model = ?"),i.push(n.model)),0===r.length)return a.NextResponse.json({error:"No updates provided"},{status:400});for(let e of(r.push("updated_at = ?"),i.push(new Date().toISOString()),i.push(s),(0,u.KH)(`UPDATE agents SET ${r.join(", ")} WHERE id = ?`,i),["soul_md","agents_md","tools_md","memory_md"]))void 0!==n[e]&&(0,p.HU)(o.name,e,n[e]||"");let c=(0,u.pP)("SELECT * FROM agents WHERE id = ?",[s]);return a.NextResponse.json(c)}catch(e){return console.error("Failed to update agent:",e),a.NextResponse.json({error:"Failed to update agent"},{status:500})}}async function m(e,{params:t}){try{let{id:e}=await t,s=(0,u.pP)("SELECT * FROM agents WHERE id = ?",[e]);if(!s)return a.NextResponse.json({error:"Agent not found"},{status:404});return(0,u.KH)("DELETE FROM openclaw_sessions WHERE agent_id = ?",[e]),(0,u.KH)("DELETE FROM events WHERE agent_id = ?",[e]),(0,u.KH)("DELETE FROM messages WHERE sender_agent_id = ?",[e]),(0,u.KH)("DELETE FROM conversation_participants WHERE agent_id = ?",[e]),(0,u.KH)("UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?",[e]),(0,u.KH)("UPDATE tasks SET created_by_agent_id = NULL WHERE created_by_agent_id = ?",[e]),(0,u.KH)("UPDATE task_activities SET agent_id = NULL WHERE agent_id = ?",[e]),(0,u.KH)("DELETE FROM agents WHERE id = ?",[e]),(0,p.Dx)(s.name),a.NextResponse.json({success:!0})}catch(e){return console.error("Failed to delete agent:",e),a.NextResponse.json({error:"Failed to delete agent"},{status:500})}}let E=new o.AppRouteRouteModule({definition:{kind:r.x.APP_ROUTE,page:"/api/agents/[id]/route",pathname:"/api/agents/[id]",filename:"route",bundlePath:"app/api/agents/[id]/route"},resolvedPagePath:"/Users/blackceomacmini/projects/mission-control/src/app/api/agents/[id]/route.ts",nextConfigOutput:"",userland:n}),{requestAsyncStorage:g,staticGenerationAsyncStorage:h,serverHooks:_}=E,R="/api/agents/[id]/route";function y(){return(0,i.patchFetch)({serverHooks:_,staticGenerationAsyncStorage:h})}},7542:(e,t,s)=>{s.d(t,{Dx:()=>m,HU:()=>p,KA:()=>c,jw:()=>l});var n=s(2048),o=s.n(n),r=s(5315),i=s.n(r);let a=i().join(process.cwd(),"agents"),d={soul_md:"SOUL.md",agents_md:"AGENTS.md",tools_md:"TOOLS.md",memory_md:"MEMORY.md"};function u(e){return i().join(a,e.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,""))}function p(e,t,s){let n=u(e),r=d[t];r&&(o().existsSync(n)||o().mkdirSync(n,{recursive:!0}),o().writeFileSync(i().join(n,r),s,"utf-8"))}function c(e,t,s){let n=i().join(u(e),"memory");o().existsSync(n)||o().mkdirSync(n,{recursive:!0}),o().writeFileSync(i().join(n,`${t}.md`),s,"utf-8")}function l(e,t,s){let n=u(e),r=i().join(n,"memory");o().mkdirSync(r,{recursive:!0});let a="Execution";for(let[r,d]of(s.includes("opus")?a="Strategic":s.includes("perplexity")&&(a="Research"),Object.entries({"SOUL.md":`# ${e}

## Identity
- **Role:** ${t}
- **Model:** ${s}
- **Tier:** ${a}

## Personality
Define this agent's personality, communication style, and values here.

## Boundaries
What this agent should and should not do.
`,"AGENTS.md":`# ${e} - Workspace Rules

## Role
${t}

## Rules
- Follow instructions precisely
- Report completion with evidence
- Escalate blockers to Master Orchestrator
`,"TOOLS.md":`# ${e} - Tools & Capabilities

## Available Tools
List the tools, APIs, and integrations this agent has access to.

## Credentials
Reference any API keys or credentials this agent needs (do not store secrets here).
`,"MEMORY.md":`# ${e} - Long-Term Memory

## Lessons Learned
Curated memories, decisions, and lessons learned over time.

## Key Decisions
Important decisions that should persist across sessions.
`}))){let e=i().join(n,r);o().existsSync(e)||o().writeFileSync(e,d,"utf-8")}}function m(e){let t=u(e);return!!o().existsSync(t)&&(o().rmSync(t,{recursive:!0}),!0)}}};var t=require("../../../../webpack-runtime.js");t.C(e);var s=e=>t(t.s=e),n=t.X(0,[8948,5972,420],()=>s(1581));module.exports=n})();