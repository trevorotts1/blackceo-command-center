"use strict";(()=>{var e={};e.id=9351,e.ids=[9351],e.modules={5890:e=>{e.exports=require("better-sqlite3")},399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},4770:e=>{e.exports=require("crypto")},7702:e=>{e.exports=require("events")},2048:e=>{e.exports=require("fs")},9801:e=>{e.exports=require("os")},5315:e=>{e.exports=require("path")},3294:(e,t,s)=>{s.r(t),s.d(t,{originalPathname:()=>L,patchFetch:()=>m,requestAsyncStorage:()=>A,routeModule:()=>g,serverHooks:()=>X,staticGenerationAsyncStorage:()=>N});var a={};s.r(a),s.d(a,{DELETE:()=>_,GET:()=>l,PATCH:()=>c,POST:()=>p});var n=s(9303),E=s(8716),T=s(670),o=s(7070),i=s(6566),r=s(8890),d=s(568);async function l(e,{params:t}){try{let{id:e}=await t,s=(0,i.o)();if(!s.isConnected())try{await s.connect()}catch{return o.NextResponse.json({error:"Failed to connect to the backend gateway"},{status:503})}let a=(await s.listSessions()).find(t=>t.id===e);if(!a)return o.NextResponse.json({error:"Session not found"},{status:404});return o.NextResponse.json({session:a})}catch(e){return console.error("Failed to get OpenClaw session:",e),o.NextResponse.json({error:"Internal server error"},{status:500})}}async function p(e,{params:t}){try{let{id:s}=await t,{content:a}=await e.json();if(!a)return o.NextResponse.json({error:"content is required"},{status:400});let n=(0,i.o)();if(!n.isConnected())try{await n.connect()}catch{return o.NextResponse.json({error:"Failed to connect to the backend gateway"},{status:503})}let E=`[Command Center] ${a}`;return await n.sendMessage(s,E),o.NextResponse.json({success:!0})}catch(e){return console.error("Failed to send message to OpenClaw session:",e),o.NextResponse.json({error:"Internal server error"},{status:500})}}async function c(e,{params:t}){try{let{id:s}=await t,{status:a,ended_at:n}=await e.json(),E=(0,r.zA)(),T=E.prepare("SELECT * FROM openclaw_sessions WHERE openclaw_session_id = ?").get(s);if(!T)return o.NextResponse.json({error:"Session not found in database"},{status:404});let i=[],l=[];if(void 0!==a&&(i.push("status = ?"),l.push(a)),void 0!==n&&(i.push("ended_at = ?"),l.push(n)),0===i.length)return o.NextResponse.json({error:"No updates provided"},{status:400});i.push("updated_at = ?"),l.push(new Date().toISOString()),l.push(T.id),E.prepare(`UPDATE openclaw_sessions SET ${i.join(", ")} WHERE id = ?`).run(...l);let p=E.prepare("SELECT * FROM openclaw_sessions WHERE id = ?").get(T.id);return"completed"===a&&(T.agent_id&&E.prepare("UPDATE agents SET status = ? WHERE id = ?").run("idle",T.agent_id),T.task_id&&(0,d.fM)({type:"agent_completed",payload:{taskId:T.task_id,sessionId:s}})),o.NextResponse.json(p)}catch(e){return console.error("Failed to update OpenClaw session:",e),o.NextResponse.json({error:"Internal server error"},{status:500})}}async function _(e,{params:t}){try{let{id:e}=await t,s=(0,r.zA)(),a=s.prepare("SELECT * FROM openclaw_sessions WHERE openclaw_session_id = ?").get(e);if(a||(a=s.prepare("SELECT * FROM openclaw_sessions WHERE id = ?").get(e)),!a)return o.NextResponse.json({error:"Session not found"},{status:404});let n=a.task_id,E=a.agent_id;if(s.prepare("DELETE FROM openclaw_sessions WHERE id = ?").run(a.id),E){let e=s.prepare("SELECT * FROM agents WHERE id = ?").get(E);e&&"Sub-Agent"===e.role?s.prepare("DELETE FROM agents WHERE id = ?").run(E):e&&s.prepare("UPDATE agents SET status = ? WHERE id = ?").run("idle",E)}return(0,d.fM)({type:"agent_completed",payload:{taskId:n,sessionId:e,deleted:!0}}),o.NextResponse.json({success:!0,deleted:a.id})}catch(e){return console.error("Failed to delete OpenClaw session:",e),o.NextResponse.json({error:"Internal server error"},{status:500})}}let g=new n.AppRouteRouteModule({definition:{kind:E.x.APP_ROUTE,page:"/api/openclaw/sessions/[id]/route",pathname:"/api/openclaw/sessions/[id]",filename:"route",bundlePath:"app/api/openclaw/sessions/[id]/route"},resolvedPagePath:"/Users/blackceomacmini/projects/mission-control/src/app/api/openclaw/sessions/[id]/route.ts",nextConfigOutput:"",userland:a}),{requestAsyncStorage:A,staticGenerationAsyncStorage:N,serverHooks:X}=g,L="/api/openclaw/sessions/[id]/route";function m(){return(0,T.patchFetch)({serverHooks:X,staticGenerationAsyncStorage:N})}},8890:(e,t,s)=>{s.d(t,{zA:()=>c,Kt:()=>_,pP:()=>g,KH:()=>A});var a=s(5890),n=s.n(a),E=s(5315),T=s.n(E),o=s(2048),i=s.n(o);let r=`
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
`,d=[{id:"001",name:"initial_schema",up:e=>{console.log("[Migration 001] Baseline schema marker")}},{id:"002",name:"add_workspaces",up:e=>{console.log("[Migration 002] Adding workspaces table and columns..."),e.exec(`
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
      `),e.exec("CREATE INDEX IF NOT EXISTS idx_agent_memory_logs_agent ON agent_memory_logs(agent_id, log_date DESC)"),console.log("[Migration 007] Created agent_memory_logs table")}}],l=process.env.DATABASE_PATH||T().join(process.cwd(),"mission-control.db"),p=null;function c(){if(!p){let e=!i().existsSync(l);(p=new(n())(l)).pragma("journal_mode = WAL"),p.pragma("foreign_keys = ON"),p.exec(r),function(e){e.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);let t=new Set(e.prepare("SELECT id FROM _migrations").all().map(e=>e.id));for(let s of d)if(!t.has(s.id)){console.log(`[DB] Running migration ${s.id}: ${s.name}`);try{e.transaction(()=>{s.up(e),e.prepare("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(s.id,s.name)})(),console.log(`[DB] Migration ${s.id} completed`)}catch(e){throw console.error(`[DB] Migration ${s.id} failed:`,e),e}}}(p),e&&console.log("[DB] New database created at:",l)}return p}function _(e,t=[]){return c().prepare(e).all(...t)}function g(e,t=[]){return c().prepare(e).get(...t)}function A(e,t=[]){return c().prepare(e).run(...t)}},568:(e,t,s)=>{s.d(t,{Ty:()=>E,fM:()=>T,z1:()=>n});let a=new Set;function n(e){a.add(e)}function E(e){a.delete(e)}function T(e){let t=new TextEncoder,s=`data: ${JSON.stringify(e)}

`,n=t.encode(s);for(let e of Array.from(a))try{e.enqueue(n)}catch(t){console.error("Failed to send SSE event to client:",t),a.delete(e)}console.log(`[SSE] Broadcast ${e.type} to ${a.size} client(s)`)}}};var t=require("../../../../../webpack-runtime.js");t.C(e);var s=e=>t(t.s=e),a=t.X(0,[8948,5972,6566],()=>s(3294));module.exports=a})();