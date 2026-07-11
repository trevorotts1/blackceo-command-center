/**
 * Command Center Demo Pack — seeder.
 *
 *   tsx scripts/demo/seed-demo.ts --profile interview|dashboard \
 *        [--fixture harbor-oak] [--db PATH] [--workspace PATH] \
 *        [--company-root PATH] [--config-dir PATH]
 *
 * Opens the demo DB through the app's own getDb() (src/lib/db) so schema +
 * migrations always match the running build and the seeder can never drift from
 * the schema. Seeds a fully fictional company ("Harbor & Oak Candle Co.").
 *
 * HONEST GRADES: we seed the FOUR grading INPUTS the real computeCompanyHealth
 * engine reads (throughput, qcPassRate, sopCoverage, kpiAttainment) — tasks, QC
 * results, task_dispatched events, and kpi_snapshots — and let the real engine
 * compute the letters. No grade column is ever written.
 *
 * The `interview` profile ALSO writes the canonical interview FILES (build-state
 * ~65% complete, genuine transcript, handoff) so the shell-locked /interview
 * surface shows WelcomeBack → prefill → brand-color re-theme → department board →
 * Complete → seeded Command Center. The `dashboard` profile writes a completed
 * build-state and themes the clients row.
 *
 * Fictional data only. No provider keys, no real gateway, no real client PII.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { randomUUID } from 'crypto';

/* ----------------------------- argv / env --------------------------------- */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const profile = (arg('profile') || 'interview') as 'interview' | 'dashboard';
if (profile !== 'interview' && profile !== 'dashboard') {
  console.error(`seed-demo: unknown --profile '${profile}' (expected interview|dashboard)`);
  process.exit(2);
}
const fixtureName = arg('fixture') || 'harbor-oak';
const repoRoot = arg('repo-root') || process.cwd();
const fixturePath = path.join(repoRoot, 'scripts', 'demo', 'fixtures', `${fixtureName}.json`);
const impUrl = (rel: string) => pathToFileURL(path.join(repoRoot, rel)).href;

/* ── DESTRUCTIVE-SEED SAFETY GATE (C8: "test residue in client surfaces") ─────
 * This seeder is DESTRUCTIVE: it DELETEs from 14 tables (tasks, agents,
 * workspaces, companies, messages, conversations, kpi_snapshots, campaigns,
 * dept_memory, ...) and then re-brands `clients` row 'self' to the demo company.
 *
 * It therefore MUST NEVER be able to resolve to a real client's live database.
 *
 * The `--db` flag is REQUIRED and there is deliberately NO `DATABASE_PATH`
 * fallback. That fallback used to exist and was a FAIL-OPEN footgun: on any
 * client box `DATABASE_PATH` points at the LIVE Command Center DB (that is how
 * src/lib/db/index.ts locates it), so a bare
 *     npx tsx scripts/demo/seed-demo.ts --profile dashboard
 * run in any shell that had sourced the box's env (`set -a; source .env`, a pm2
 * or cron env, an operational shell) would have silently wiped that client's
 * Command Center and re-branded it to the fictional demo company. No caller ever
 * relied on the fallback — the only invoker, scripts/demo/reset-demo.sh, always
 * passes --db explicitly — so requiring it costs nothing and closes the hole.
 *
 * Belt-and-braces: even an EXPLICIT --db is refused when it resolves to the same
 * file as the live DATABASE_PATH, which catches the realistic accident of
 * pasting the live path in by hand.
 */
const dbPath = arg('db');
const workspaceRoot = arg('workspace') || process.env.OPENCLAW_WORKSPACE_ROOT;
const companyRoot = arg('company-root') || process.env.OPENCLAW_COMPANY_ROOT;
const configDir = arg('config-dir') || path.join(repoRoot, 'config');

if (!dbPath) {
  console.error('seed-demo: --db is REQUIRED (refusing to guess).');
  console.error('  This seeder is DESTRUCTIVE (DELETEs 14 tables, re-brands the client row).');
  console.error('  It does NOT fall back to $DATABASE_PATH, because on a client box that is');
  console.error('  the LIVE Command Center database. Pass an explicit demo-sandbox DB path.');
  process.exit(2);
}
{
  const livePath = process.env.DATABASE_PATH;
  if (livePath && path.resolve(livePath) === path.resolve(dbPath)) {
    console.error('seed-demo: REFUSING to seed — --db resolves to the same file as the live');
    console.error(`  $DATABASE_PATH (${path.resolve(dbPath)}).`);
    console.error('  This seeder is DESTRUCTIVE and must only ever target a demo sandbox DB.');
    process.exit(2);
  }
}
if (!workspaceRoot) {
  console.error('seed-demo: --workspace or OPENCLAW_WORKSPACE_ROOT is required.');
  process.exit(2);
}
// Pin the DB path BEFORE importing getDb (it caches DATABASE_PATH at module load).
process.env.DATABASE_PATH = dbPath;

// ISOLATION: getDb()'s first-boot auto-seed resolves departments.json + company
// config from os.homedir()-based paths, which on the operator box reach the REAL
// ZHC build (~/clawd/zero-human-company/...). Point HOME at an isolated, empty
// demo home so EVERY homedir probe misses and the demo DB can never absorb real
// company/department data. libuv's os.homedir() honors $HOME. Also pin the ZHC
// resolver envs at demo dirs as belt-and-suspenders.
const demoHome = arg('home') || process.env.DEMO_HOME;
if (demoHome) {
  fs.mkdirSync(demoHome, { recursive: true });
  process.env.HOME = demoHome;
  process.env.ZERO_HUMAN_COMPANY_DIR = path.join(companyRoot || demoHome, fx0slug());
  process.env.MASTER_FILES_DIR = companyRoot || demoHome;
}
function fx0slug(): string {
  try { return JSON.parse(fs.readFileSync(fixturePath, 'utf-8')).company.slug; } catch { return 'demo'; }
}

/* ------------------------------ helpers ----------------------------------- */

// Deterministic PRNG (mulberry32) so a reseed is byte-stable.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const MS_DAY = 86400000;
/** SQLite canonical 'YYYY-MM-DD HH:MM:SS' (UTC) — julianday() parses this cleanly. */
function sqlTs(daysAgo: number, jitterHours = 0): string {
  const d = new Date(Date.now() - daysAgo * MS_DAY - jitterHours * 3600000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
/** ISO-8601 with Z (for JSON files read by JS, not by SQLite). */
function isoTs(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * MS_DAY).toISOString().replace(/\.\d+Z$/, 'Z');
}

interface Fixture {
  company: {
    name: string; slug: string; industry: string; commandCenterName: string;
    brandColor: string; brandSecondaryColor: string;
    connectedSystems: Record<string, string>;
    companyKPIs: Array<{ id: string; name: string; target: number; unit: string }>;
  };
  logoSvg: string;
  departments: Array<{
    slug: string; name: string; emoji: string; headTitle: string; grade: string;
    targetInputs: { throughput: number; qcPassRate: number; sopCoverage: number; kpiAttainment: number };
    taskCount: number; trendDown?: boolean;
    prevInputs?: { throughput: number; qcPassRate: number; sopCoverage: number };
  }>;
  agents: Array<{ name: string; role: string; emoji: string; isMaster?: boolean; workspace: string; status: string; persona: string }>;
  taskPools: Record<string, string[]>;
  sops: Array<{ name: string; slug: string; department: string; steps: string; success: string }>;
  campaigns: Array<{ name: string; description: string; status: string; departments: string[] }>;
  conversation: { title: string; messages: Array<{ agent: string; text: string }> };
  interview: {
    ownerId: string; startedDate: string; lastUpdated: string; lastQuestionNumber: number;
    phasesCompleteCount: number; synthesis: string;
    answers: Array<{ id: string; prompt: string; answer: string; logged: string; provenance?: string }>;
    conversationalDepth: Array<{ prompt: string; answer: string; logged: string }>;
    decidedDepartments: Record<string, 'yes' | 'no' | 'later'>;
    undecidedDepartments: string[];
  };
}

const fx: Fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
const logoDataUri = `data:image/svg+xml;base64,${Buffer.from(fx.logoSvg, 'utf-8').toString('base64')}`;
const themed = profile === 'dashboard'; // dashboard is fully themed; interview leaves color fresh

async function main() {
  const dbmod = await import(impUrl('src/lib/db/index.ts'));
  const memmod = await import(impUrl('src/lib/db/seed-dept-memory.ts'));
  const gradingmod = await import(impUrl('src/lib/grading.ts'));
  const db = dbmod.getDb();
  db.pragma('foreign_keys = ON');

  const companyId = fx.company.slug;
  const now = sqlTs(0);

  const seedTx = db.transaction(() => {
    /* --- clean slate: drop any first-boot auto-seed strays so the demo DB
           holds ONLY fictional Harbor & Oak content (the DB is fresh on reset,
           so these are just deterministic safety). Keep the clients self-row
           (migration-seeded) and the repo starter SOP library. --- */
    for (const t of ['task_qc_results', 'task_activities', 'events', 'messages',
                     'conversation_participants', 'conversations', 'task_history',
                     'tasks', 'kpi_snapshots', 'campaigns', 'agents', 'dept_memory',
                     'workspaces', 'companies']) {
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
    }

    /* --- companies (structural default + demo company) --- */
    db.prepare(`INSERT OR IGNORE INTO companies (id, name, slug, industry, created_at, updated_at)
                VALUES ('default','Default','default','', ?, ?)`).run(now, now);
    db.prepare(`INSERT OR REPLACE INTO companies (id, name, slug, industry, logo_url, config, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)`).run(
      companyId, fx.company.name, companyId, fx.company.industry, logoDataUri,
      JSON.stringify({ primaryColor: fx.company.brandColor, secondaryColor: fx.company.brandSecondaryColor, commandCenterName: fx.company.commandCenterName }),
      now, now,
    );

    /* --- clients self-row (drives the live brand re-theme + known-context) --- */
    const selfExists = db.prepare(`SELECT id FROM clients WHERE id='self'`).get();
    const brandColor = themed ? fx.company.brandColor : null;
    if (selfExists) {
      db.prepare(`UPDATE clients SET name=?, brand_color=?, brand_secondary_color=?, logo_url=?, interview_complete=?, updated_at=? WHERE id='self'`)
        .run(fx.company.name, brandColor, fx.company.brandSecondaryColor, logoDataUri, profile === 'dashboard' ? 1 : 0, now);
    } else {
      db.prepare(`INSERT INTO clients (id, name, gateway_url, is_self, interview_complete, brand_color, brand_secondary_color, logo_url, created_at, updated_at)
                  VALUES ('self', ?, 'ws://127.0.0.1:1', 1, ?, ?, ?, ?, ?, ?)`)
        .run(fx.company.name, profile === 'dashboard' ? 1 : 0, brandColor, fx.company.brandSecondaryColor, logoDataUri, now, now);
    }

    /* --- structural default workspace (tasks/agents FK to it) --- */
    db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
                VALUES ('default','General','default','Catch-all','📁','default', 0, ?, ?)`).run(now, now);

    /* --- department workspaces --- */
    fx.departments.forEach((d, i) => {
      db.prepare(`INSERT OR REPLACE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(d.slug, d.name, d.slug, `${d.name} department`, d.emoji, companyId, (i + 1) * 10, now, now);
    });

    /* --- agents (workspaces first; then patch head_agent_id) --- */
    const agentIdByWorkspace: Record<string, string> = {};
    for (const a of fx.agents) {
      const id = randUuid();
      db.prepare(`INSERT INTO agents (id, name, role, description, avatar_emoji, status, is_master, workspace_id, persona, specialist_type, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, a.name, a.role, a.persona, a.emoji, a.status, a.isMaster ? 1 : 0, a.workspace, a.persona, a.isMaster ? 'permanent' : 'permanent', now, now);
      if (!agentIdByWorkspace[a.workspace]) agentIdByWorkspace[a.workspace] = id;
    }
    for (const d of fx.departments) {
      const head = agentIdByWorkspace[d.slug];
      if (head) db.prepare(`UPDATE workspaces SET head_agent_id=? WHERE id=?`).run(head, d.slug);
    }

    /* --- SOPs --- */
    const sopIdByDept: Record<string, string> = {};
    for (const s of fx.sops) {
      const id = randUuid();
      db.prepare(`INSERT OR IGNORE INTO sops (id, name, slug, description, version, department, steps, success_criteria, source, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, s.name, s.slug, `${s.name} — standard operating procedure`, 1, s.department, s.steps, s.success, 'demo-seed', now, now);
      if (!sopIdByDept[s.department]) sopIdByDept[s.department] = id;
    }

    /* --- per-department task / event / QC / KPI generation --- */
    const KANBAN_NONDONE = ['in_progress', 'review', 'testing', 'planning', 'backlog'];
    const fallbackSop = Object.values(sopIdByDept)[0] ?? null;
    for (const d of fx.departments) {
      const sopId = sopIdByDept[d.slug] ?? fallbackSop;
      seedDepartment(db, d, sopId, agentIdByWorkspace[d.slug] ?? null, 0, d.targetInputs, d.taskCount, KANBAN_NONDONE);
      if (d.trendDown && d.prevInputs) {
        // Prior-window batch (30..58d ago) with HIGHER scores → negative delta → worst-trending.
        seedDepartment(db, d, sopId, agentIdByWorkspace[d.slug] ?? null, 32, {
          throughput: d.prevInputs.throughput, qcPassRate: d.prevInputs.qcPassRate,
          sopCoverage: d.prevInputs.sopCoverage, kpiAttainment: d.targetInputs.kpiAttainment,
        }, 6, KANBAN_NONDONE, /*kpi*/ false);
      }
    }

    /* --- recent live-feed events (so the feed looks alive at minute zero) --- */
    const feed: Array<[string, string, number]> = [
      ['system', `${fx.company.commandCenterName} is online — all departments reporting.`, 6],
      ['agent_joined', `Mara joined Marketing and picked up the autumn launch.`, 5],
      ['task_created', `Sage opened "Resolve the carrier delay on the harvest batch".`, 3],
      ['task_updated', `Nova moved "Film 3 candle-pour reels" to review.`, 2],
      ['agent_completed', `Wren completed "Answer the melted-in-transit replacement queue".`, 1],
      ['task_updated', `Kai moved "Refresh Meta creative for the harvest set" to in progress.`, 0],
    ];
    for (const [type, msg, dago] of feed) {
      db.prepare(`INSERT INTO events (id, type, message, created_at) VALUES (?,?,?,?)`)
        .run(randUuid(), type, msg, sqlTs(dago, randInt(1, 20)));
    }

    /* --- campaigns (CEO board) --- */
    for (const c of fx.campaigns) {
      db.prepare(`INSERT INTO campaigns (id, name, description, status, department_ids, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(randUuid(), c.name, c.description, c.status, JSON.stringify(c.departments), now, now);
    }

    /* --- team chat --- */
    const convoId = randUuid();
    db.prepare(`INSERT INTO conversations (id, title, type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run(convoId, fx.conversation.title, 'group', now, now);
    const nameToAgent: Record<string, string> = {};
    for (const a of fx.agents) {
      const row = db.prepare(`SELECT id FROM agents WHERE name=? LIMIT 1`).get(a.name) as { id: string } | undefined;
      if (row) nameToAgent[a.name] = row.id;
    }
    for (const a of fx.agents) {
      if (nameToAgent[a.name]) db.prepare(`INSERT OR IGNORE INTO conversation_participants (conversation_id, agent_id, joined_at) VALUES (?,?,?)`).run(convoId, nameToAgent[a.name], now);
    }
    fx.conversation.messages.forEach((m, i) => {
      db.prepare(`INSERT INTO messages (id, conversation_id, sender_agent_id, content, message_type, created_at) VALUES (?,?,?,?,?,?)`)
        .run(randUuid(), convoId, nameToAgent[m.agent] ?? null, m.text, 'text', sqlTs(1, (fx.conversation.messages.length - i) * 2));
    });
  });
  seedTx();

  // Department memory (idempotent; seeds the canonical dept slugs it knows).
  try { memmod.seedDeptMemory('default'); } catch { /* non-fatal */ }

  /* --- config files (runtime-only; repo copy stays template) --- */
  writeConfigFiles();

  /* --- workspace interview files + company-root build-progress --- */
  writeWorkspaceFiles();

  const health = summarizeHealth(db, gradingmod);
  console.log(`\n[seed-demo] profile=${profile} fixture=${fixtureName}`);
  console.log(`[seed-demo] db=${dbPath}`);
  console.log(`[seed-demo] workspace=${workspaceRoot}`);
  console.log(`[seed-demo] seeded ${fx.departments.length} departments, ${fx.agents.length} agents.`);
  console.log(`[seed-demo] computed company health: ${health}`);
  dbmod.closeDb?.();
}

function randUuid(): string { return randomUUID(); }

/**
 * Seed one department's four grading INPUTS by generating real rows the engine
 * reads: tasks (throughput), task_dispatched events + sop_id (sopCoverage),
 * llm task_qc_results (qcPassRate), kpi_snapshots (kpiAttainment).
 */
function seedDepartment(
  db: any,
  d: Fixture['departments'][number],
  sopId: string | null,
  headAgentId: string | null,
  offsetDays: number,
  inputs: { throughput: number; qcPassRate: number; sopCoverage: number; kpiAttainment: number },
  count: number,
  nonDoneStatuses: string[],
  seedKpi = true,
) {
  const pool = fx.taskPools[d.slug] ?? [`${d.name} task`];
  const doneCount = Math.max(1, Math.round((count * inputs.throughput) / 100));
  const sopCount = Math.round((count * inputs.sopCoverage) / 100);
  const taskIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const id = randUuid();
    taskIds.push(id);
    const createdDaysAgo = offsetDays + randInt(1, 26);
    const title = pool[i % pool.length];
    const isDone = i < doneCount;
    const status = isDone ? 'done' : (d.trendDown && offsetDays === 0 && i === doneCount ? 'blocked' : nonDoneStatuses[(i - doneCount) % nonDoneStatuses.length]);
    const withSop = i < sopCount ? sopId : null;
    const completedAt = isDone ? sqlTs(Math.max(offsetDays + 1, createdDaysAgo - randInt(0, 2)), randInt(1, 12)) : null;
    const priority = pick(['low', 'medium', 'medium', 'high', 'critical']);
    const blockedReason = status === 'blocked' ? 'credential' : null;
    db.prepare(`INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id, department, sop_id, completed_at, blocked_reason, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, title, `${d.name}: ${title}`, status, priority, headAgentId, d.slug, d.slug, withSop, completedAt, blockedReason,
           sqlTs(createdDaysAgo, randInt(1, 20)), completedAt ?? sqlTs(createdDaysAgo, randInt(1, 20)));

    // Every task gets a task_dispatched event (sopCoverage denominator).
    db.prepare(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?,?,?,?,?)`)
      .run(randUuid(), 'task_dispatched', id, `Dispatched: ${title}`, sqlTs(createdDaysAgo, randInt(1, 18)));

    // A couple of task activities for life.
    if (isDone) {
      db.prepare(`INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at) VALUES (?,?,?,?,?,?)`)
        .run(randUuid(), id, headAgentId, 'deliverable', `Completed: ${title}`, completedAt);
    } else if (i % 2 === 0) {
      db.prepare(`INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at) VALUES (?,?,?,?,?,?)`)
        .run(randUuid(), id, headAgentId, 'comment', `Working on ${title.toLowerCase()}.`, sqlTs(offsetDays + randInt(0, 3), randInt(1, 10)));
    }
  }

  // QC results (llm rows only are graded). Round-robin over the dept tasks.
  const qcTotal = Math.max(5, count);
  const qcPass = Math.round((qcTotal * inputs.qcPassRate) / 100);
  for (let i = 0; i < qcTotal; i++) {
    const passed = i < qcPass ? 1 : 0;
    const score = passed ? 8.5 + rand() * 1.4 : 6.0 + rand() * 2.3; // >=8.5 pass, <8.5 fail
    const tId = taskIds[i % taskIds.length];
    db.prepare(`INSERT INTO task_qc_results (id, task_id, workspace_id, department_slug, score, passed, scoring_path, attempt, scored_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randUuid(), tId, d.slug, d.slug, Math.round(score * 100) / 100, passed, 'llm', passed ? 1 : (i % 3 === 0 ? 2 : 1), sqlTs(offsetDays + randInt(0, 24), randInt(1, 12)));
  }

  // KPI snapshots (kpiAttainment + trend chart). One kpi_id per dept.
  if (seedKpi) {
    const kpiId = `${d.slug}-output`;
    const kpiName = `${d.name} Output Index`;
    const target = 100;
    const final = inputs.kpiAttainment;
    const start = d.trendDown ? Math.min(96, final + 26) : Math.max(55, final - 12);
    const points = 10;
    for (let p = 0; p < points; p++) {
      const daysAgo = Math.round((points - 1 - p) * (58 / (points - 1)));
      const frac = p / (points - 1);
      const value = Math.round(start + (final - start) * frac + (rand() * 4 - 2));
      db.prepare(`INSERT INTO kpi_snapshots (id, department_id, kpi_id, kpi_name, value, target, unit, snapshot_date)
                  VALUES (?,?,?,?,?,?,?,?)`)
        .run(randUuid(), d.slug, kpiId, kpiName, value, target, 'index', sqlTs(daysAgo, 0).slice(0, 10));
    }
  }
}

/* ------------------------- config file writers ---------------------------- */

function writeConfigFiles() {
  fs.mkdirSync(configDir, { recursive: true });
  const departments = fx.departments.map((d) => ({
    id: d.slug, emoji: d.emoji, name: d.name, headTitle: d.headTitle,
  }));
  fs.writeFileSync(path.join(configDir, 'departments.json'), JSON.stringify(departments, null, 2) + '\n');

  const companyConfig = {
    companyName: fx.company.name,
    industry: fx.company.industry,
    commandCenterName: fx.company.commandCenterName,
    createdAt: fx.interview.startedDate,
    connectedSystems: fx.company.connectedSystems,
    companyKPIs: fx.company.companyKPIs,
    default_persona_id: null,
    governance_persona_id: null,
    gradingWeights: { kpiAchievement: 0.4, agentPerformance: 0.3, daCompliance: 0.15, recommendationFollowThrough: 0.15 },
    departments: fx.departments.map((d) => ({ id: d.slug, name: d.name, emoji: d.emoji, headTitle: d.headTitle })),
  };
  fs.writeFileSync(path.join(configDir, 'company-config.json'), JSON.stringify(companyConfig, null, 2) + '\n');
}

/* ---------------------- workspace / interview files ----------------------- */

function writeWorkspaceFiles() {
  const ws = workspaceRoot!;
  const discovery = path.join(ws, 'company-discovery');
  fs.mkdirSync(discovery, { recursive: true });
  // Marker: the demo Skill-23 stubs REFUSE to write unless this file exists,
  // so they can never touch a real workspace even if misconfigured.
  fs.writeFileSync(path.join(ws, '.demo-workspace'), `Harbor & Oak demo workspace (${profile}) — safe to wipe.\n`);

  const sessionId = randomUUID();

  if (profile === 'interview') {
    // ~65% complete build-state: identity + most branding answered; brand color
    // and command-center name are the last two structured cards. 26 of 28
    // canonical departments decided (provenanced); 2 left for the live board.
    const decisions: Record<string, unknown> = {};
    let d = 6;
    for (const [dept, verb] of Object.entries(fx.interview.decidedDepartments)) {
      decisions[dept] = {
        decision: verb, source: 'owner-interview', decidedAt: isoTs(d),
        decidedBy: fx.interview.ownerId, sessionId,
      };
      d = Math.max(1, d - 0.2);
    }
    const buildState = {
      interviewSessionId: sessionId,
      interviewComplete: false,
      interviewProgress: {
        lastQuestionNumber: fx.interview.lastQuestionNumber,
        lastQuestionPhase: 'phase3',
        lastQuestionAskedBy: 'web',
        lastQuestionAt: isoTs(1),
        phasesComplete: ['welcome', 'identity', 'branding'].slice(0, fx.interview.phasesCompleteCount),
        status: 'in_progress',
      },
      interviewQc: { status: 'pending' },
      canonicalReconciliation: { decisions, ownerDeclineConfirmed: true },
    };
    fs.writeFileSync(path.join(ws, '.workforce-build-state.json'), JSON.stringify(buildState, null, 2) + '\n');
    fs.writeFileSync(path.join(discovery, 'workforce-interview-answers.md'), renderTranscript());
    fs.writeFileSync(path.join(discovery, 'interview-handoff.md'), renderHandoff());
  } else {
    // dashboard: interview already complete + build complete (nothing reads real state).
    const buildState = {
      interviewSessionId: sessionId,
      interviewComplete: true,
      interviewCompletedAt: isoTs(20),
      interviewQc: { status: 'pass' },
      buildCompletedAt: isoTs(19),
      canonicalReconciliation: { decisions: {}, ownerDeclineConfirmed: true },
    };
    fs.writeFileSync(path.join(ws, '.workforce-build-state.json'), JSON.stringify(buildState, null, 2) + '\n');
  }

  // build-progress.json (stage=complete) so /onboarding/building reveals the CC.
  if (companyRoot) {
    const cdir = path.join(companyRoot, fx.company.slug);
    fs.mkdirSync(cdir, { recursive: true });
    const total = 42;
    const progress = {
      stage: 'complete',
      message: 'Your AI workforce is ready',
      documents_total: total,
      documents_complete: total,
      departments: fx.departments.map((x) => ({ name: x.name, roles_total: 3, roles_complete: 3, status: 'complete' })),
      eta_minutes: 0,
      started_at: isoTs(1),
      completed_at: isoTs(0),
    };
    fs.writeFileSync(path.join(cdir, 'build-progress.json'), JSON.stringify(progress, null, 2) + '\n');
  }
}

function renderTranscript(): string {
  const lines: string[] = [];
  lines.push('# Workforce Interview Answers');
  lines.push('');
  lines.push(`_Owner-conducted interview for ${fx.company.name}. Genuine, interactive transcript._`);
  lines.push('');
  const blocks = [
    ...fx.interview.answers.map((a) => ({ q: a.prompt, a: a.answer, prov: a.provenance, logged: a.logged })),
    ...fx.interview.conversationalDepth.map((c) => ({ q: c.prompt, a: c.answer, prov: undefined as string | undefined, logged: c.logged })),
  ];
  for (const b of blocks) {
    lines.push('---');
    lines.push('');
    lines.push(`**Q:** ${b.q}`);
    lines.push(`**A:** ${b.a}`);
    if (b.prov) lines.push(`**Provenance:** ${b.prov}`);
    lines.push(`**Logged:** ${b.logged}`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderHandoff(): string {
  const i = fx.interview;
  return [
    '---',
    'status: in_progress',
    `started_date: ${i.startedDate}`,
    `last_updated: ${i.lastUpdated}`,
    `last_question_number: ${i.lastQuestionNumber}`,
    `total_questions_answered: ${i.answers.length}`,
    'total_questions_estimated: 30',
    'skipped_questions: []',
    `synthesis: ${i.synthesis}`,
    '---',
    '',
    '## Synthesis',
    '',
    i.synthesis,
    '',
    '## Resume',
    '',
    'The owner has completed identity and most of branding. The next cards are the',
    'brand color and the home-base name, then the department board.',
    '',
  ].join('\n');
}

/* ------------------------------ health echo ------------------------------- */

function summarizeHealth(db: any, g: any): string {
  try {
    const h = g.computeCompanyHealth(db, { windowDays: 30 });
    const perDept = h.departments
      .filter((x: any) => x.grade)
      .map((x: any) => {
        const i = x.inputs;
        return `\n    ${x.slug.padEnd(22)} ${x.grade} ${String(x.score).padStart(6)}  tp=${i.throughput.score ?? '-'} qc=${i.qcPassRate.score ?? '-'} sop=${i.sopCoverage.score ?? '-'} kpi=${i.kpiAttainment.score ?? '-'}`;
      })
      .join('');
    const worst = (h.worstTrending || []).map((w: any) => `${w.slug}(${w.delta})`).join(',');
    return `company=${h.grade}(${h.score}) | ${perDept} | worst-trending=[${worst}]`;
  } catch (e) {
    return `(grading summary unavailable: ${e instanceof Error ? e.message : e})`;
  }
}

main().catch((e) => {
  console.error('[seed-demo] FAILED:', e);
  process.exit(1);
});
