"use strict";(()=>{var e={};e.id=529,e.ids=[529],e.modules={5890:e=>{e.exports=require("better-sqlite3")},399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},4770:e=>{e.exports=require("crypto")},2048:e=>{e.exports=require("fs")},5315:e=>{e.exports=require("path")},6895:(e,t,s)=>{s.r(t),s.d(t,{originalPathname:()=>h,patchFetch:()=>_,requestAsyncStorage:()=>g,routeModule:()=>p,serverHooks:()=>S,staticGenerationAsyncStorage:()=>y});var r={};s.r(r),s.d(r,{GET:()=>u,POST:()=>m});var n=s(9303),o=s(8716),a=s(670),i=s(7070),l=s(4673),d=s(8890),c=s(7542);async function u(e){try{let t;let s=e.nextUrl.searchParams.get("workspace_id");return t=s?(0,d.Kt)(`
        SELECT * FROM agents WHERE workspace_id = ? ORDER BY is_master DESC, name ASC
      `,[s]):(0,d.Kt)(`
        SELECT * FROM agents ORDER BY is_master DESC, name ASC
      `),i.NextResponse.json(t)}catch(e){return console.error("Failed to fetch agents:",e),i.NextResponse.json({error:"Failed to fetch agents"},{status:500})}}async function m(e){try{let t=await e.json();if(!t.name||!t.role)return i.NextResponse.json({error:"Name and role are required"},{status:400});let s=(0,l.Z)(),r=new Date().toISOString();(0,d.KH)(`INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, workspace_id, soul_md, user_md, agents_md, tools_md, memory_md, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,[s,t.name,t.role,t.description||null,t.avatar_emoji||"\uD83E\uDD16",t.is_master?1:0,t.workspace_id||"default",t.soul_md||null,t.user_md||null,t.agents_md||null,t.tools_md||null,t.memory_md||null,t.model||null,r,r]),(0,d.KH)(`INSERT INTO events (id, type, agent_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,[(0,l.Z)(),"agent_joined",s,`${t.name} joined the team`,r]),(0,c.jw)(t.name,t.role,t.model||"default");let n=(0,d.pP)("SELECT * FROM agents WHERE id = ?",[s]);return i.NextResponse.json(n,{status:201})}catch(e){return console.error("Failed to create agent:",e),i.NextResponse.json({error:"Failed to create agent"},{status:500})}}let p=new n.AppRouteRouteModule({definition:{kind:o.x.APP_ROUTE,page:"/api/agents/route",pathname:"/api/agents",filename:"route",bundlePath:"app/api/agents/route"},resolvedPagePath:"/Users/blackceomacmini/projects/mission-control/src/app/api/agents/route.ts",nextConfigOutput:"",userland:r}),{requestAsyncStorage:g,staticGenerationAsyncStorage:y,serverHooks:S}=p,h="/api/agents/route";function _(){return(0,a.patchFetch)({serverHooks:S,staticGenerationAsyncStorage:y})}},7542:(e,t,s)=>{s.d(t,{Dx:()=>p,HU:()=>c,KA:()=>u,jw:()=>m});var r=s(2048),n=s.n(r),o=s(5315),a=s.n(o);let i=a().join(process.cwd(),"agents"),l={soul_md:"SOUL.md",agents_md:"AGENTS.md",tools_md:"TOOLS.md",memory_md:"MEMORY.md"};function d(e){return a().join(i,e.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,""))}function c(e,t,s){let r=d(e),o=l[t];o&&(n().existsSync(r)||n().mkdirSync(r,{recursive:!0}),n().writeFileSync(a().join(r,o),s,"utf-8"))}function u(e,t,s){let r=a().join(d(e),"memory");n().existsSync(r)||n().mkdirSync(r,{recursive:!0}),n().writeFileSync(a().join(r,`${t}.md`),s,"utf-8")}function m(e,t,s){let r=d(e),o=a().join(r,"memory");n().mkdirSync(o,{recursive:!0});let i="Execution";for(let[o,l]of(s.includes("opus")?i="Strategic":s.includes("perplexity")&&(i="Research"),Object.entries({"SOUL.md":`# ${e}

## Identity
- **Role:** ${t}
- **Model:** ${s}
- **Tier:** ${i}

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
`}))){let e=a().join(r,o);n().existsSync(e)||n().writeFileSync(e,l,"utf-8")}}function p(e){let t=d(e);return!!n().existsSync(t)&&(n().rmSync(t,{recursive:!0}),!0)}}};var t=require("../../../webpack-runtime.js");t.C(e);var s=e=>t(t.s=e),r=t.X(0,[8948,5972,420],()=>s(6895));module.exports=r})();