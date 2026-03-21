"use strict";(()=>{var e={};e.id=9022,e.ids=[9022],e.modules={5890:e=>{e.exports=require("better-sqlite3")},399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},2048:e=>{e.exports=require("fs")},5315:e=>{e.exports=require("path")},3597:(e,t,a)=>{a.r(t),a.d(t,{originalPathname:()=>A,patchFetch:()=>N,requestAsyncStorage:()=>g,routeModule:()=>c,serverHooks:()=>m,staticGenerationAsyncStorage:()=>p});var i={};a.r(i),a.d(i,{GET:()=>l,POST:()=>_});var s=a(9303),n=a(8716),o=a(670),T=a(7070),E=a(8890),d=a(568),r=a(4235);async function l(e,{params:t}){try{let e=t.id,a=(0,E.zA)().prepare(`
      SELECT 
        a.*,
        ag.id as agent_id,
        ag.name as agent_name,
        ag.avatar_emoji as agent_avatar_emoji
      FROM task_activities a
      LEFT JOIN agents ag ON a.agent_id = ag.id
      WHERE a.task_id = ?
      ORDER BY a.created_at DESC
    `).all(e).map(e=>({id:e.id,task_id:e.task_id,agent_id:e.agent_id,activity_type:e.activity_type,message:e.message,metadata:e.metadata,created_at:e.created_at,agent:e.agent_id?{id:e.agent_id,name:e.agent_name,avatar_emoji:e.agent_avatar_emoji,role:"",status:"working",is_master:!1,workspace_id:"default",description:"",created_at:"",updated_at:""}:void 0}));return T.NextResponse.json(a)}catch(e){return console.error("Error fetching activities:",e),T.NextResponse.json({error:"Failed to fetch activities"},{status:500})}}async function _(e,{params:t}){try{let a=t.id,i=await e.json(),s=r.kP.safeParse(i);if(!s.success)return T.NextResponse.json({error:"Validation failed",details:s.error.issues},{status:400});let{activity_type:n,message:o,agent_id:l,metadata:_}=s.data,c=(0,E.zA)(),g=crypto.randomUUID();c.prepare(`
      INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(g,a,l||null,n,o,_?JSON.stringify(_):null);let p=c.prepare(`
      SELECT 
        a.*,
        ag.id as agent_id,
        ag.name as agent_name,
        ag.avatar_emoji as agent_avatar_emoji
      FROM task_activities a
      LEFT JOIN agents ag ON a.agent_id = ag.id
      WHERE a.id = ?
    `).get(g),m={id:p.id,task_id:p.task_id,agent_id:p.agent_id,activity_type:p.activity_type,message:p.message,metadata:p.metadata,created_at:p.created_at,agent:p.agent_id?{id:p.agent_id,name:p.agent_name,avatar_emoji:p.agent_avatar_emoji,role:"",status:"working",is_master:!1,workspace_id:"default",description:"",created_at:"",updated_at:""}:void 0};return(0,d.fM)({type:"activity_logged",payload:m}),T.NextResponse.json(m,{status:201})}catch(e){return console.error("Error creating activity:",e),T.NextResponse.json({error:"Failed to create activity"},{status:500})}}let c=new s.AppRouteRouteModule({definition:{kind:n.x.APP_ROUTE,page:"/api/tasks/[id]/activities/route",pathname:"/api/tasks/[id]/activities",filename:"route",bundlePath:"app/api/tasks/[id]/activities/route"},resolvedPagePath:"/Users/blackceomacmini/projects/mission-control/src/app/api/tasks/[id]/activities/route.ts",nextConfigOutput:"",userland:i}),{requestAsyncStorage:g,staticGenerationAsyncStorage:p,serverHooks:m}=c,A="/api/tasks/[id]/activities/route";function N(){return(0,o.patchFetch)({serverHooks:m,staticGenerationAsyncStorage:p})}},8890:(e,t,a)=>{a.d(t,{zA:()=>c,Kt:()=>g,pP:()=>p,KH:()=>m});var i=a(5890),s=a.n(i),n=a(5315),o=a.n(n),T=a(2048),E=a.n(T);let d=`
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
`,r=[{id:"001",name:"initial_schema",up:e=>{console.log("[Migration 001] Baseline schema marker")}},{id:"002",name:"add_workspaces",up:e=>{console.log("[Migration 002] Adding workspaces table and columns..."),e.exec(`
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
      `),e.exec("CREATE INDEX IF NOT EXISTS idx_agent_memory_logs_agent ON agent_memory_logs(agent_id, log_date DESC)"),console.log("[Migration 007] Created agent_memory_logs table")}}],l=process.env.DATABASE_PATH||o().join(process.cwd(),"mission-control.db"),_=null;function c(){if(!_){let e=!E().existsSync(l);(_=new(s())(l)).pragma("journal_mode = WAL"),_.pragma("foreign_keys = ON"),_.exec(d),function(e){e.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);let t=new Set(e.prepare("SELECT id FROM _migrations").all().map(e=>e.id));for(let a of r)if(!t.has(a.id)){console.log(`[DB] Running migration ${a.id}: ${a.name}`);try{e.transaction(()=>{a.up(e),e.prepare("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(a.id,a.name)})(),console.log(`[DB] Migration ${a.id} completed`)}catch(e){throw console.error(`[DB] Migration ${a.id} failed:`,e),e}}}(_),e&&console.log("[DB] New database created at:",l)}return _}function g(e,t=[]){return c().prepare(e).all(...t)}function p(e,t=[]){return c().prepare(e).get(...t)}function m(e,t=[]){return c().prepare(e).run(...t)}},568:(e,t,a)=>{a.d(t,{Ty:()=>n,fM:()=>o,z1:()=>s});let i=new Set;function s(e){i.add(e)}function n(e){i.delete(e)}function o(e){let t=new TextEncoder,a=`data: ${JSON.stringify(e)}

`,s=t.encode(a);for(let e of Array.from(i))try{e.enqueue(s)}catch(t){console.error("Failed to send SSE event to client:",t),i.delete(e)}console.log(`[SSE] Broadcast ${e.type} to ${i.size} client(s)`)}},4235:(e,t,a)=>{a.d(t,{$O:()=>E,_b:()=>d,kP:()=>r,th:()=>l,uR:()=>g});var i=a(6543);let s=i.KmV(["backlog","in_progress","review","blocked","done"]),n=i.KmV(["low","medium","high","critical"]),o=i.KmV(["spawned","updated","completed","file_created","status_changed"]),T=i.KmV(["file","url","artifact"]),E=i.Ryn({title:i.Z_8().min(1,"Title is required").max(500,"Title must be 500 characters or less"),description:i.Z_8().max(1e4,"Description must be 10000 characters or less").optional(),status:s.optional(),priority:n.optional(),assigned_agent_id:i.Z_8().uuid().optional(),created_by_agent_id:i.Z_8().uuid().optional(),business_id:i.Z_8().optional(),workspace_id:i.Z_8().optional(),due_date:i.Z_8().optional()}),d=i.Ryn({title:i.Z_8().min(1).max(500).optional(),description:i.Z_8().max(1e4).optional(),status:s.optional(),priority:n.optional(),assigned_agent_id:i.Z_8().uuid().optional().nullable(),due_date:i.Z_8().optional().nullable(),updated_by_agent_id:i.Z_8().uuid().optional()}),r=i.Ryn({activity_type:o,message:i.Z_8().min(1,"Message is required").max(5e3,"Message must be 5000 characters or less"),agent_id:i.Z_8().uuid().optional(),metadata:i.Z_8().optional()}),l=i.Ryn({deliverable_type:T,title:i.Z_8().min(1,"Title is required"),path:i.Z_8().optional(),description:i.Z_8().optional()}),_=[".png",".jpg",".jpeg",".svg",".webp"],c=["drive.google.com","docs.google.com","dropbox.com","dl.dropboxusercontent.com"];function g(e){let t;try{t=new URL(e)}catch{return{valid:!1,error:"That does not look like a valid URL. Please provide a full URL starting with https://"}}if("https:"!==t.protocol&&"http:"!==t.protocol)return{valid:!1,error:"Please use a URL that starts with https://"};let a=t.hostname.toLowerCase();if(c.some(e=>a===e||a.endsWith("."+e)))return a.includes("google.com")?{valid:!1,error:"Google Drive links will not work. Please use a direct image link ending in .png, .jpg, or .svg. Try uploading your image to imgur.com or your own website and sharing that link instead."}:{valid:!1,error:"Dropbox links will not work. Please use a direct image link ending in .png, .jpg, or .svg. Try uploading your image to imgur.com or your own website and sharing that link instead."};let i=t.pathname.toLowerCase();return _.some(e=>i.endsWith(e))?{valid:!0}:{valid:!1,error:`The URL must point directly to an image file. Please make sure the link ends in .png, .jpg, .jpeg, .svg, or .webp. (Your link ends with "${i.split("/").pop()||i}")`}}}};var t=require("../../../../../webpack-runtime.js");t.C(e);var a=e=>t(t.s=e),i=t.X(0,[8948,5972,6543],()=>a(3597));module.exports=i})();