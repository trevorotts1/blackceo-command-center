"use strict";(()=>{var e={};e.id=8854,e.ids=[8854],e.modules={5890:e=>{e.exports=require("better-sqlite3")},399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},4770:e=>{e.exports=require("crypto")},2048:e=>{e.exports=require("fs")},5315:e=>{e.exports=require("path")},8771:(e,t,o)=>{o.r(t),o.d(t,{originalPathname:()=>R,patchFetch:()=>S,requestAsyncStorage:()=>g,routeModule:()=>p,serverHooks:()=>E,staticGenerationAsyncStorage:()=>y});var r={};o.r(r),o.d(r,{GET:()=>m,POST:()=>u});var s=o(9303),n=o(8716),a=o(670),i=o(7070),l=o(4673),d=o(8890),c=o(7542);async function m(e,{params:t}){try{let{id:o}=await t,r=e.nextUrl.searchParams.get("limit")||"30",s=(0,d.Kt)("SELECT * FROM agent_memory_logs WHERE agent_id = ? ORDER BY log_date DESC LIMIT ?",[o,parseInt(r)]);return i.NextResponse.json(s)}catch(e){return console.error("Failed to fetch memory logs:",e),i.NextResponse.json({error:"Failed to fetch memory logs"},{status:500})}}async function u(e,{params:t}){try{let{id:o}=await t,r=await e.json();if(!r.log_date||!r.content)return i.NextResponse.json({error:"log_date and content are required"},{status:400});let s=(0,d.pP)("SELECT * FROM agent_memory_logs WHERE agent_id = ? AND log_date = ?",[o,r.log_date]),n=new Date().toISOString(),a=(0,d.pP)("SELECT name FROM agents WHERE id = ?",[o]);if(s){(0,d.KH)("UPDATE agent_memory_logs SET content = ?, updated_at = ? WHERE id = ?",[r.content,n,s.id]),a&&(0,c.KA)(a.name,r.log_date,r.content);let e=(0,d.pP)("SELECT * FROM agent_memory_logs WHERE id = ?",[s.id]);return i.NextResponse.json(e)}{let e=(0,l.Z)();(0,d.KH)("INSERT INTO agent_memory_logs (id, agent_id, log_date, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",[e,o,r.log_date,r.content,n,n]),a&&(0,c.KA)(a.name,r.log_date,r.content);let t=(0,d.pP)("SELECT * FROM agent_memory_logs WHERE id = ?",[e]);return i.NextResponse.json(t,{status:201})}}catch(e){return console.error("Failed to save memory log:",e),i.NextResponse.json({error:"Failed to save memory log"},{status:500})}}let p=new s.AppRouteRouteModule({definition:{kind:n.x.APP_ROUTE,page:"/api/agents/[id]/memory-logs/route",pathname:"/api/agents/[id]/memory-logs",filename:"route",bundlePath:"app/api/agents/[id]/memory-logs/route"},resolvedPagePath:"/Users/blackceomacmini/projects/mission-control/src/app/api/agents/[id]/memory-logs/route.ts",nextConfigOutput:"",userland:r}),{requestAsyncStorage:g,staticGenerationAsyncStorage:y,serverHooks:E}=p,R="/api/agents/[id]/memory-logs/route";function S(){return(0,a.patchFetch)({serverHooks:E,staticGenerationAsyncStorage:y})}},7542:(e,t,o)=>{o.d(t,{Dx:()=>p,HU:()=>c,KA:()=>m,jw:()=>u});var r=o(2048),s=o.n(r),n=o(5315),a=o.n(n);let i=a().join(process.cwd(),"agents"),l={soul_md:"SOUL.md",agents_md:"AGENTS.md",tools_md:"TOOLS.md",memory_md:"MEMORY.md"};function d(e){return a().join(i,e.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,""))}function c(e,t,o){let r=d(e),n=l[t];n&&(s().existsSync(r)||s().mkdirSync(r,{recursive:!0}),s().writeFileSync(a().join(r,n),o,"utf-8"))}function m(e,t,o){let r=a().join(d(e),"memory");s().existsSync(r)||s().mkdirSync(r,{recursive:!0}),s().writeFileSync(a().join(r,`${t}.md`),o,"utf-8")}function u(e,t,o){let r=d(e),n=a().join(r,"memory");s().mkdirSync(n,{recursive:!0});let i="Execution";for(let[n,l]of(o.includes("opus")?i="Strategic":o.includes("perplexity")&&(i="Research"),Object.entries({"SOUL.md":`# ${e}

## Identity
- **Role:** ${t}
- **Model:** ${o}
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
`}))){let e=a().join(r,n);s().existsSync(e)||s().writeFileSync(e,l,"utf-8")}}function p(e){let t=d(e);return!!s().existsSync(t)&&(s().rmSync(t,{recursive:!0}),!0)}}};var t=require("../../../../../webpack-runtime.js");t.C(e);var o=e=>t(t.s=e),r=t.X(0,[8948,5972,420],()=>o(8771));module.exports=r})();