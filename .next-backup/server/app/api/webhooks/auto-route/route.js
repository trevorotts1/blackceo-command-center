"use strict";(()=>{var e={};e.id=8813,e.ids=[8813],e.modules={5890:e=>{e.exports=require("better-sqlite3")},399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},2048:e=>{e.exports=require("fs")},5315:e=>{e.exports=require("path")},615:(e,t,a)=>{a.r(t),a.d(t,{originalPathname:()=>C,patchFetch:()=>S,requestAsyncStorage:()=>L,routeModule:()=>R,serverHooks:()=>k,staticGenerationAsyncStorage:()=>X});var n={};a.r(n),a.d(n,{GET:()=>N,POST:()=>A});var i=a(9303),o=a(8716),s=a(670),r=a(7070),d=a(8890),E=a(2048),T=a.n(E),l=a(5315),c=a.n(l);let p=[{id:"ceo-com",name:"CEO / COM",keywords:["ceo","com","central operations","chief","executive","strategy","vision","leadership","oversight","master","fallback","dispatch","coordinate","direct","command","general","overview","mission control","admin"],agentRoles:["CEO","COM","Central Operations Manager","Chief of Mission","Master Agent","Executive Assistant","Strategist"],priority:10},{id:"marketing",name:"Marketing",keywords:["marketing","campaign","brand","social media","content","ads","advertising","email","newsletter","seo","funnel","leads","outreach","promotion","advertisement","branding","market","viral","engagement","clicks"],agentRoles:["Social Media","Content","Marketing","Content Writer","Social Media Agent","Marketing Specialist","Campaign Manager","SEO Specialist"],priority:7},{id:"sales",name:"Sales",keywords:["sales","crm","lead","prospect","pipeline","deal","close","convert","revenue","quota","follow up","client","proposal","pitch","closing","opportunity","negotiation","contract","purchase","buyer"],agentRoles:["Sales","CRM","Convert and Flow","Sales Agent","Sales Rep","Account Executive","Business Development","Closer"],priority:8},{id:"billing",name:"Billing",keywords:["billing","invoice","payment","charge","subscription","pricing","bill","transaction","refund","credit","debit","fee","cost","revenue recognition","accounts receivable","ar","payment processing","stripe","paypal"],agentRoles:["Billing","Billing Agent","Accounts Receivable","Payment Processor","Invoice Manager","Subscription Manager"],priority:8},{id:"customer-support",name:"Customer Support",keywords:["support","customer","help","ticket","issue","complaint","refund","onboarding","question","inquiry","service","client care","assistance","troubleshoot","problem","bug report","user issue","help desk"],agentRoles:["Support","Support Agent","Customer Service","Customer Care","Help Desk","Technical Support","Success Manager"],priority:7},{id:"operations",name:"Operations",keywords:["operations","process","workflow","automation","n8n","zapier","system","efficiency","ops","standard","procedure","sop","infrastructure","optimization","streamline","protocol","logistics","supply chain"],agentRoles:["Operations","Operations Admin","Automation","N8N","N8N Workflow Builder","Process Engineer","Systems Manager"],priority:7},{id:"creative",name:"Creative",keywords:["creative","concept","ideation","brainstorm","story","narrative","copywriting","copy","tagline","messaging","brand voice","creative direction","art direction","vision","theme","mood board","conceptual"],agentRoles:["Creative","Creative Director","Copywriter","Concept Artist","Ideation Specialist","Brand Voice","Creative Strategist"],priority:6},{id:"hr-people",name:"HR / People",keywords:["hr","human resources","people","hiring","recruit","interview","onboard","employee","talent","performance","review","benefits","payroll","compensation","culture","training","development","retention","offboarding","team building"],agentRoles:["HR","Human Resources","People Ops","Recruiter","Talent Acquisition","HR Manager","People Partner","Training Coordinator"],priority:7},{id:"legal-compliance",name:"Legal / Compliance",keywords:["legal","law","compliance","contract","agreement","terms","policy","privacy","gdpr","regulation","license","intellectual property","ip","copyright","trademark","nda","liability","risk","disclaimer","terms of service"],agentRoles:["Legal","Compliance","Legal Counsel","Contract Manager","Policy Officer","Risk Manager","IP Specialist","Compliance Agent"],priority:8},{id:"it-tech",name:"IT / Tech",keywords:["it","tech","technology","infrastructure","server","cloud","aws","azure","network","security","firewall","vpn","hardware","software","saas","system admin","devops","ci/cd","deployment","hosting","database admin"],agentRoles:["IT","Tech","System Admin","DevOps","Cloud Engineer","Security Engineer","Network Admin","Infrastructure","IT Support"],priority:8},{id:"web-development",name:"Web Development",keywords:["web","website","frontend","backend","fullstack","react","vue","angular","html","css","javascript","typescript","node","nextjs","wordpress","web app","landing page","site","web design","responsive","webflow"],agentRoles:["Web Developer","Frontend Developer","Backend Developer","Fullstack Developer","Web Engineer","JavaScript Developer","React Developer"],priority:7},{id:"app-development",name:"App Development",keywords:["app","mobile","ios","android","react native","flutter","swift","kotlin","mobile app","application","apk","app store","play store","pwa","progressive web app","mobile development","native app"],agentRoles:["App Developer","Mobile Developer","iOS Developer","Android Developer","React Native Developer","Flutter Developer","Mobile Engineer"],priority:7},{id:"graphics",name:"Graphics",keywords:["graphic","design","visual","logo","branding","image","illustration","ui","ux","mockup","layout","color","typography","photoshop","figma","sketch","adobe","vector","svg","png","infographic","banner"],agentRoles:["Designer","Graphics","Graphics Agent","Graphic Designer","UI Designer","UX Designer","Visual Designer","Brand Designer","Illustrator"],priority:6},{id:"video-production",name:"Video Production",keywords:["video","film","movie","footage","edit","editing","premiere","final cut","after effects","motion graphics","animation","render","cut","clip","youtube","vimeo","video ad","commercial","reel","b-roll","color grade"],agentRoles:["Video Editor","Videographer","Motion Designer","Video Producer","Animator","Colorist","Post Production","Video Agent"],priority:6},{id:"audio-production",name:"Audio Production",keywords:["audio","sound","music","podcast","voiceover","voice over","narration","recording","mix","mastering","eq","compression","jingle","soundtrack","audiobook","radio","spotify","apple music","sound design","foley"],agentRoles:["Audio Engineer","Sound Designer","Podcast Editor","Voiceover Artist","Music Producer","Mixer","Mastering Engineer","Audio Agent"],priority:6},{id:"research",name:"Research",keywords:["research","analyze","analysis","data","report","survey","study","investigate","market research","competitor","trend","insight","scrape","benchmark","statistics","dataset","findings","white paper","case study"],agentRoles:["Researcher","Research Agent","Scraper","Scraper Agent","Analytics","Data Analyst","Market Researcher","Research Specialist"],priority:6},{id:"communications",name:"Communications",keywords:["communications","pr","public relations","media","press","announcement","newsletter","email blast","internal comms","external comms","messaging","spokesperson","interview","presentation","speaking","event","webinar"],agentRoles:["Communications","PR Specialist","Public Relations","Communications Manager","Media Relations","Spokesperson","Communications Agent"],priority:7}];function g(e){return Math.min(e,10)/10}function m(e){switch(e){case"critical":return 2;case"high":return 1.5;case"medium":default:return 1;case"low":return .7}}function u(e,t){let a=e.filter(e=>"offline"!==e.status).map(e=>{let a=(t.agentRoles.some(t=>e.role.toLowerCase().includes(t.toLowerCase()))?1:0)-g(e.active_tasks);return{agent:e,score:a}});return a.sort((e,t)=>t.score-e.score),a[0]?.agent}function _(e){let t=function(){let e=process.env.DEPARTMENTS_CONFIG_PATH;if(e)try{let t=c().resolve(e),a=T().readFileSync(t,"utf-8"),n=JSON.parse(a);if(!Array.isArray(n))throw Error("Departments config must be a JSON array");for(let e of n)if(!e.id||!e.name||!Array.isArray(e.keywords))throw Error(`Invalid department entry: ${JSON.stringify(e)}`);return console.log(`[DepartmentConfig] Loaded ${n.length} departments from ${t}`),n}catch(t){console.warn(`[DepartmentConfig] Failed to load from DEPARTMENTS_CONFIG_PATH="${e}": ${t.message}. Falling back to defaults.`)}return p}(),a=function(e){let t=[],a=`
    SELECT
      a.*,
      COUNT(t.id) AS active_tasks
    FROM agents a
    LEFT JOIN tasks t
      ON t.assigned_agent_id = a.id
      AND t.status = 'in_progress'
    WHERE a.status != 'offline'
  `;return e&&(a+=" AND a.workspace_id = ?",t.push(e)),a+=" GROUP BY a.id ORDER BY a.is_master DESC, a.name ASC",(0,d.Kt)(a,t)}(e.workspace_id??void 0);if(0===a.length)return console.warn("[DepartmentRouter] No available agents found"),null;let n=function(e,t,a){let n=e.title||"",i=e.description||"",o=e.priority||"medium";if(e.department){let n=a.find(t=>t.id===e.department||t.name===e.department);if(n){let e=u(t,n);if(e)return{agentId:e.id,agentName:e.name,department:n.name,score:n.priority*m(o)-g(e.active_tasks),reason:`Explicit department tag "${n.name}" matched → role-fit agent selected (load: ${e.active_tasks} tasks)`}}}for(let{department:e,score:s}of function(e,t,a,n){let i=`${e} ${t}`,o=m(a);return n.map(e=>({department:e,score:function(e,t){let a=e.toLowerCase();return t.reduce((e,t)=>a.includes(t.toLowerCase())?e+1:e,0)}(i,e.keywords)*o*(e.priority/10)})).filter(e=>e.score>0).sort((e,t)=>t.score-e.score)}(n,i,o,a)){let a=u(t,e);if(a)return{agentId:a.id,agentName:a.name,department:e.name,score:s,reason:`Keyword scoring matched department "${e.name}" (score: ${s.toFixed(2)}) → least-loaded role-fit agent selected (load: ${a.active_tasks} tasks)`}}let s=t.filter(e=>e.is_master&&"offline"!==e.status).sort((e,t)=>e.active_tasks-t.active_tasks);return s[0]?{agentId:s[0].id,agentName:s[0].name,department:"CEO / COM",score:0,reason:`No department match — routed to CEO / COM master agent (load: ${s[0].active_tasks} tasks)`}:null}(e,a,t);return n?console.log(`[DepartmentRouter] Routed "${e.title}" → ${n.agentName} (${n.department}): ${n.reason}`):console.warn(`[DepartmentRouter] Could not find a suitable agent for "${e.title}"`),n}async function A(e){try{let{taskId:t,workspaceId:a}=await e.json();if(!t)return r.NextResponse.json({error:"Missing required field: taskId"},{status:400});let n=(0,d.pP)("SELECT * FROM tasks WHERE id = ?",[t]);if(!n)return r.NextResponse.json({error:`Task not found: ${t}`},{status:404});let i=a||n.workspace_id||"default",o={title:n.title,description:n.description||"",priority:n.priority,workspace_id:i,department:n.department},s=_(o);if(!s)return r.NextResponse.json({success:!1,routed:!1,taskId:t,reason:"No suitable agent available for this task"},{status:422});let E=new Date().toISOString();return(0,d.KH)(`UPDATE tasks
       SET assigned_agent_id = ?, updated_at = ?
       WHERE id = ?`,[s.agentId,E,t]),console.log(`[AutoRoute] Task "${n.title}" (${t}) assigned to ${s.agentName} via ${s.department}`),r.NextResponse.json({success:!0,routed:!0,taskId:t,agentId:s.agentId,agentName:s.agentName,department:s.department,score:s.score,reason:s.reason})}catch(e){return console.error("[AutoRoute] Error processing auto-route webhook:",e),r.NextResponse.json({error:"Failed to process auto-route request"},{status:500})}}async function N(e){try{let{searchParams:t}=new URL(e.url),a=t.get("taskId"),n=t.get("workspaceId")||void 0;if(!a)return r.NextResponse.json({error:"Missing required query param: taskId"},{status:400});let i=(0,d.pP)("SELECT * FROM tasks WHERE id = ?",[a]);if(!i)return r.NextResponse.json({error:`Task not found: ${a}`},{status:404});let o=n||i.workspace_id||"default",s=_({title:i.title,description:i.description||"",priority:i.priority,workspace_id:o,department:i.department});return r.NextResponse.json({dryRun:!0,taskId:a,routed:!!s,routing:s??null})}catch(e){return console.error("[AutoRoute] Error in dry-run routing:",e),r.NextResponse.json({error:"Failed to compute routing"},{status:500})}}let R=new i.AppRouteRouteModule({definition:{kind:o.x.APP_ROUTE,page:"/api/webhooks/auto-route/route",pathname:"/api/webhooks/auto-route",filename:"route",bundlePath:"app/api/webhooks/auto-route/route"},resolvedPagePath:"/Users/blackceomacmini/projects/mission-control/src/app/api/webhooks/auto-route/route.ts",nextConfigOutput:"",userland:n}),{requestAsyncStorage:L,staticGenerationAsyncStorage:X,serverHooks:k}=R,C="/api/webhooks/auto-route/route";function S(){return(0,s.patchFetch)({serverHooks:k,staticGenerationAsyncStorage:X})}},8890:(e,t,a)=>{a.d(t,{zA:()=>p,Kt:()=>g,pP:()=>m,KH:()=>u});var n=a(5890),i=a.n(n),o=a(5315),s=a.n(o),r=a(2048),d=a.n(r);let E=`
-- Workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT DEFAULT '📁',
  user_md TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT,
  avatar_emoji TEXT DEFAULT '🤖',
  status TEXT DEFAULT 'standby' CHECK (status IN ('standby', 'working', 'offline')),
  is_master INTEGER DEFAULT 0,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  soul_md TEXT,
  user_md TEXT,
  agents_md TEXT,
  tools_md TEXT,
  memory_md TEXT,
  model TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Tasks table (Mission Queue)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'backlog' CHECK (status IN ('backlog', 'in_progress', 'review', 'blocked', 'done')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  assigned_agent_id TEXT REFERENCES agents(id),
  created_by_agent_id TEXT REFERENCES agents(id),
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  business_id TEXT DEFAULT 'default',
  department TEXT,
  due_date TEXT,
  planning_session_key TEXT,
  planning_messages TEXT,
  planning_complete INTEGER DEFAULT 0,
  planning_spec TEXT,
  planning_agents TEXT,
  planning_dispatch_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Planning questions table
CREATE TABLE IF NOT EXISTS planning_questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  question_type TEXT DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'text', 'yes_no')),
  options TEXT,
  answer TEXT,
  answered_at TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Planning specs table (locked specifications)
CREATE TABLE IF NOT EXISTS planning_specs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  spec_markdown TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  locked_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Conversations table (agent-to-agent or task-related)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'task')),
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Conversation participants
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, agent_id)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  sender_agent_id TEXT REFERENCES agents(id),
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'task_update', 'file')),
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Events table (for live feed)
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Businesses/Workspaces table (legacy - kept for compatibility)
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- OpenClaw session mapping
CREATE TABLE IF NOT EXISTS openclaw_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  openclaw_session_id TEXT NOT NULL,
  channel TEXT,
  status TEXT DEFAULT 'active',
  session_type TEXT DEFAULT 'persistent',
  task_id TEXT REFERENCES tasks(id),
  ended_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Task activities table (for real-time activity log)
CREATE TABLE IF NOT EXISTS task_activities (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id),
  activity_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Task deliverables table (files, URLs, artifacts)
CREATE TABLE IF NOT EXISTS task_deliverables (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  deliverable_type TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Agent daily memory logs
CREATE TABLE IF NOT EXISTS agent_memory_logs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_id, log_date)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_activities_task ON task_activities(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverables_task ON task_deliverables(task_id);
CREATE INDEX IF NOT EXISTS idx_openclaw_sessions_task ON openclaw_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_planning_questions_task ON planning_questions(task_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_agent_memory_logs_agent ON agent_memory_logs(agent_id, log_date DESC);
`,T=[{id:"001",name:"initial_schema",up:e=>{console.log("[Migration 001] Baseline schema marker")}},{id:"002",name:"add_workspaces",up:e=>{console.log("[Migration 002] Adding workspaces table and columns..."),e.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT,
          icon TEXT DEFAULT '📁',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `),e.exec(`
        INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon) 
        VALUES ('default', 'Default Workspace', 'default', 'Default workspace', '🏠');
      `),e.prepare("PRAGMA table_info(tasks)").all().some(e=>"workspace_id"===e.name)||(e.exec("ALTER TABLE tasks ADD COLUMN workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id)"),e.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id)"),console.log("[Migration 002] Added workspace_id to tasks")),e.prepare("PRAGMA table_info(agents)").all().some(e=>"workspace_id"===e.name)||(e.exec("ALTER TABLE agents ADD COLUMN workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id)"),e.exec("CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id)"),console.log("[Migration 002] Added workspace_id to agents"))}},{id:"003",name:"add_planning_tables",up:e=>{console.log("[Migration 003] Adding planning tables..."),e.exec(`
        CREATE TABLE IF NOT EXISTS planning_questions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          category TEXT NOT NULL,
          question TEXT NOT NULL,
          question_type TEXT DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'text', 'yes_no')),
          options TEXT,
          answer TEXT,
          answered_at TEXT,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `),e.exec(`
        CREATE TABLE IF NOT EXISTS planning_specs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          spec_markdown TEXT NOT NULL,
          locked_at TEXT NOT NULL,
          locked_by TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `),e.exec("CREATE INDEX IF NOT EXISTS idx_planning_questions_task ON planning_questions(task_id, sort_order)")}},{id:"004",name:"add_planning_session_columns",up:e=>{console.log("[Migration 004] Adding planning session columns to tasks...");let t=e.prepare("PRAGMA table_info(tasks)").all();t.some(e=>"planning_session_key"===e.name)||(e.exec("ALTER TABLE tasks ADD COLUMN planning_session_key TEXT"),console.log("[Migration 004] Added planning_session_key")),t.some(e=>"planning_messages"===e.name)||(e.exec("ALTER TABLE tasks ADD COLUMN planning_messages TEXT"),console.log("[Migration 004] Added planning_messages")),t.some(e=>"planning_complete"===e.name)||(e.exec("ALTER TABLE tasks ADD COLUMN planning_complete INTEGER DEFAULT 0"),console.log("[Migration 004] Added planning_complete")),t.some(e=>"planning_spec"===e.name)||(e.exec("ALTER TABLE tasks ADD COLUMN planning_spec TEXT"),console.log("[Migration 004] Added planning_spec")),t.some(e=>"planning_agents"===e.name)||(e.exec("ALTER TABLE tasks ADD COLUMN planning_agents TEXT"),console.log("[Migration 004] Added planning_agents"))}},{id:"005",name:"add_agent_model_field",up:e=>{console.log("[Migration 005] Adding model field to agents..."),e.prepare("PRAGMA table_info(agents)").all().some(e=>"model"===e.name)||(e.exec("ALTER TABLE agents ADD COLUMN model TEXT"),console.log("[Migration 005] Added model to agents"))}},{id:"006",name:"add_planning_dispatch_error_column",up:e=>{console.log("[Migration 006] Adding planning_dispatch_error column to tasks..."),e.prepare("PRAGMA table_info(tasks)").all().some(e=>"planning_dispatch_error"===e.name)||(e.exec("ALTER TABLE tasks ADD COLUMN planning_dispatch_error TEXT"),console.log("[Migration 006] Added planning_dispatch_error to tasks"))}},{id:"007",name:"add_agent_tools_memory_and_daily_logs",up:e=>{console.log("[Migration 007] Adding tools_md, memory_md to agents; user_md to workspaces; agent_memory_logs table...");let t=e.prepare("PRAGMA table_info(agents)").all();t.some(e=>"tools_md"===e.name)||(e.exec("ALTER TABLE agents ADD COLUMN tools_md TEXT"),console.log("[Migration 007] Added tools_md to agents")),t.some(e=>"memory_md"===e.name)||(e.exec("ALTER TABLE agents ADD COLUMN memory_md TEXT"),console.log("[Migration 007] Added memory_md to agents")),e.prepare("PRAGMA table_info(workspaces)").all().some(e=>"user_md"===e.name)||(e.exec("ALTER TABLE workspaces ADD COLUMN user_md TEXT"),console.log("[Migration 007] Added user_md to workspaces")),e.exec(`
        CREATE TABLE IF NOT EXISTS agent_memory_logs (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          log_date TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(agent_id, log_date)
        );
      `),e.exec("CREATE INDEX IF NOT EXISTS idx_agent_memory_logs_agent ON agent_memory_logs(agent_id, log_date DESC)"),console.log("[Migration 007] Created agent_memory_logs table")}}],l=process.env.DATABASE_PATH||s().join(process.cwd(),"mission-control.db"),c=null;function p(){if(!c){let e=!d().existsSync(l);(c=new(i())(l)).pragma("journal_mode = WAL"),c.pragma("foreign_keys = ON"),c.exec(E),function(e){e.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);let t=new Set(e.prepare("SELECT id FROM _migrations").all().map(e=>e.id));for(let a of T)if(!t.has(a.id)){console.log(`[DB] Running migration ${a.id}: ${a.name}`);try{e.transaction(()=>{a.up(e),e.prepare("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(a.id,a.name)})(),console.log(`[DB] Migration ${a.id} completed`)}catch(e){throw console.error(`[DB] Migration ${a.id} failed:`,e),e}}}(c),e&&console.log("[DB] New database created at:",l)}return c}function g(e,t=[]){return p().prepare(e).all(...t)}function m(e,t=[]){return p().prepare(e).get(...t)}function u(e,t=[]){return p().prepare(e).run(...t)}}};var t=require("../../../../webpack-runtime.js");t.C(e);var a=e=>t(t.s=e),n=t.X(0,[8948,5972],()=>a(615));module.exports=n})();