"use strict";(()=>{var e={};e.id=225,e.ids=[225],e.modules={5890:e=>{e.exports=require("better-sqlite3")},399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},2048:e=>{e.exports=require("fs")},5315:e=>{e.exports=require("path")},1627:(e,t,a)=>{a.r(t),a.d(t,{originalPathname:()=>N,patchFetch:()=>L,requestAsyncStorage:()=>g,routeModule:()=>c,serverHooks:()=>m,staticGenerationAsyncStorage:()=>A});var s={};a.r(s),a.d(s,{GET:()=>_,POST:()=>p});var i=a(9303),n=a(8716),o=a(670),E=a(7070),T=a(8890),d=a(568),r=a(4235),l=a(2048);async function _(e,{params:t}){try{let e=t.id,a=(0,T.zA)().prepare(`
      SELECT *
      FROM task_deliverables
      WHERE task_id = ?
      ORDER BY created_at DESC
    `).all(e);return E.NextResponse.json(a)}catch(e){return console.error("Error fetching deliverables:",e),E.NextResponse.json({error:"Failed to fetch deliverables"},{status:500})}}async function p(e,{params:t}){try{let a=t.id,s=await e.json(),i=r.th.safeParse(s);if(!i.success)return E.NextResponse.json({error:"Validation failed",details:i.error.issues},{status:400});let{deliverable_type:n,title:o,path:_,description:p}=i.data,c=!0,g=_;"file"!==n||!_||(g=_.replace(/^~/,process.env.HOME||""),(c=(0,l.existsSync)(g))||console.warn(`[DELIVERABLE] Warning: File does not exist: ${g}`));let A=(0,T.zA)(),m=crypto.randomUUID();A.prepare(`
      INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(m,a,n,o,_||null,p||null);let N=A.prepare(`
      SELECT *
      FROM task_deliverables
      WHERE id = ?
    `).get(m);if((0,d.fM)({type:"deliverable_added",payload:N}),"file"===n&&!c)return E.NextResponse.json({...N,warning:`File does not exist at path: ${g}. Please create the file.`},{status:201});return E.NextResponse.json(N,{status:201})}catch(e){return console.error("Error creating deliverable:",e),E.NextResponse.json({error:"Failed to create deliverable"},{status:500})}}let c=new i.AppRouteRouteModule({definition:{kind:n.x.APP_ROUTE,page:"/api/tasks/[id]/deliverables/route",pathname:"/api/tasks/[id]/deliverables",filename:"route",bundlePath:"app/api/tasks/[id]/deliverables/route"},resolvedPagePath:"/Users/blackceomacmini/projects/mission-control/src/app/api/tasks/[id]/deliverables/route.ts",nextConfigOutput:"",userland:s}),{requestAsyncStorage:g,staticGenerationAsyncStorage:A,serverHooks:m}=c,N="/api/tasks/[id]/deliverables/route";function L(){return(0,o.patchFetch)({serverHooks:m,staticGenerationAsyncStorage:A})}},8890:(e,t,a)=>{a.d(t,{zA:()=>p,Kt:()=>c,pP:()=>g,KH:()=>A});var s=a(5890),i=a.n(s),n=a(5315),o=a.n(n),E=a(2048),T=a.n(E);let d=`
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
      `),e.exec("CREATE INDEX IF NOT EXISTS idx_agent_memory_logs_agent ON agent_memory_logs(agent_id, log_date DESC)"),console.log("[Migration 007] Created agent_memory_logs table")}}],l=process.env.DATABASE_PATH||o().join(process.cwd(),"mission-control.db"),_=null;function p(){if(!_){let e=!T().existsSync(l);(_=new(i())(l)).pragma("journal_mode = WAL"),_.pragma("foreign_keys = ON"),_.exec(d),function(e){e.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);let t=new Set(e.prepare("SELECT id FROM _migrations").all().map(e=>e.id));for(let a of r)if(!t.has(a.id)){console.log(`[DB] Running migration ${a.id}: ${a.name}`);try{e.transaction(()=>{a.up(e),e.prepare("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(a.id,a.name)})(),console.log(`[DB] Migration ${a.id} completed`)}catch(e){throw console.error(`[DB] Migration ${a.id} failed:`,e),e}}}(_),e&&console.log("[DB] New database created at:",l)}return _}function c(e,t=[]){return p().prepare(e).all(...t)}function g(e,t=[]){return p().prepare(e).get(...t)}function A(e,t=[]){return p().prepare(e).run(...t)}},568:(e,t,a)=>{a.d(t,{Ty:()=>n,fM:()=>o,z1:()=>i});let s=new Set;function i(e){s.add(e)}function n(e){s.delete(e)}function o(e){let t=new TextEncoder,a=`data: ${JSON.stringify(e)}

`,i=t.encode(a);for(let e of Array.from(s))try{e.enqueue(i)}catch(t){console.error("Failed to send SSE event to client:",t),s.delete(e)}console.log(`[SSE] Broadcast ${e.type} to ${s.size} client(s)`)}},4235:(e,t,a)=>{a.d(t,{$O:()=>T,_b:()=>d,kP:()=>r,th:()=>l,uR:()=>c});var s=a(6543);let i=s.KmV(["backlog","in_progress","review","blocked","done"]),n=s.KmV(["low","medium","high","critical"]),o=s.KmV(["spawned","updated","completed","file_created","status_changed"]),E=s.KmV(["file","url","artifact"]),T=s.Ryn({title:s.Z_8().min(1,"Title is required").max(500,"Title must be 500 characters or less"),description:s.Z_8().max(1e4,"Description must be 10000 characters or less").optional(),status:i.optional(),priority:n.optional(),assigned_agent_id:s.Z_8().uuid().optional(),created_by_agent_id:s.Z_8().uuid().optional(),business_id:s.Z_8().optional(),workspace_id:s.Z_8().optional(),due_date:s.Z_8().optional()}),d=s.Ryn({title:s.Z_8().min(1).max(500).optional(),description:s.Z_8().max(1e4).optional(),status:i.optional(),priority:n.optional(),assigned_agent_id:s.Z_8().uuid().optional().nullable(),due_date:s.Z_8().optional().nullable(),updated_by_agent_id:s.Z_8().uuid().optional()}),r=s.Ryn({activity_type:o,message:s.Z_8().min(1,"Message is required").max(5e3,"Message must be 5000 characters or less"),agent_id:s.Z_8().uuid().optional(),metadata:s.Z_8().optional()}),l=s.Ryn({deliverable_type:E,title:s.Z_8().min(1,"Title is required"),path:s.Z_8().optional(),description:s.Z_8().optional()}),_=[".png",".jpg",".jpeg",".svg",".webp"],p=["drive.google.com","docs.google.com","dropbox.com","dl.dropboxusercontent.com"];function c(e){let t;try{t=new URL(e)}catch{return{valid:!1,error:"That does not look like a valid URL. Please provide a full URL starting with https://"}}if("https:"!==t.protocol&&"http:"!==t.protocol)return{valid:!1,error:"Please use a URL that starts with https://"};let a=t.hostname.toLowerCase();if(p.some(e=>a===e||a.endsWith("."+e)))return a.includes("google.com")?{valid:!1,error:"Google Drive links will not work. Please use a direct image link ending in .png, .jpg, or .svg. Try uploading your image to imgur.com or your own website and sharing that link instead."}:{valid:!1,error:"Dropbox links will not work. Please use a direct image link ending in .png, .jpg, or .svg. Try uploading your image to imgur.com or your own website and sharing that link instead."};let s=t.pathname.toLowerCase();return _.some(e=>s.endsWith(e))?{valid:!0}:{valid:!1,error:`The URL must point directly to an image file. Please make sure the link ends in .png, .jpg, .jpeg, .svg, or .webp. (Your link ends with "${s.split("/").pop()||s}")`}}}};var t=require("../../../../../webpack-runtime.js");t.C(e);var a=e=>t(t.s=e),s=t.X(0,[8948,5972,6543],()=>a(1627));module.exports=s})();