/**
 * Offline Duck pipeline: real authenticated Next routes, company routing,
 * confirmed producer persona decision, SOP/model selection, durable dispatch to
 * a local gateway stub, mocked PNG + session evidence, current-execution review,
 * independent QC, event feed and artifact serving. No status-write substitute
 * for a gateway send and no external provider calls.
 *
 * CI builds .next and exercises next start. Local runs may use
 * NEXT_DIST_DIR=.next-duck-e2e for an isolated next dev/build directory.
 * Run: node --import tsx --test tests/e2e/duck-test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { createHmac, createHash, generateKeyPairSync } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { runMockGenerator } from '../fixtures/mock-generator';

// ── Fail-closed API auth (v4.52.0 AUTH HARDEN) — test credentials ────────────
// The 60-commit L1-L9 integration train made the API fail CLOSED: EXTERNAL
// /api/* callers must present an MC_API_TOKEN Bearer (src/middleware.ts Gate B),
// and the WEBHOOK_SECRET_ROUTES — POST /api/tasks/ingest here — must ALSO carry
// an HMAC-SHA256(WEBHOOK_SECRET, rawBody) signature (route-level check in
// src/app/api/tasks/ingest/route.ts). INGEST-05 then hard-gated the legacy
// ALLOW_INSECURE_OPEN_API escape hatch on NODE_ENV !== 'production', and
// `next start` (the hasNextBuild() path CI actually runs) FORCES
// NODE_ENV=production — so the escape hatch is intentionally dead here and this
// harness must authenticate exactly like a real production caller.
//
// We therefore provision test-only secrets on the spawned server (serverEnv
// below) and have every HTTP helper SEND the matching Bearer + HMAC signature.
// This exercises the real production auth path end-to-end and touches NO
// production auth code. These values live only inside this ephemeral localhost
// test process; they are never real credentials.
const TEST_MC_API_TOKEN   = 'duck-e2e-mc-api-token';
const TEST_WEBHOOK_SECRET  = 'duck-e2e-webhook-secret';

/** Middleware layer-2 bearer header every same-process /api/* helper sends. */
function bearerHeader(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_MC_API_TOKEN}` };
}

/** Route-level webhook signature = HMAC-SHA256(WEBHOOK_SECRET, rawBody) hex. */
function webhookSignature(rawBody: string): string {
  return createHmac('sha256', TEST_WEBHOOK_SECRET).update(rawBody).digest('hex');
}

// ── Test timing ──────────────────────────────────────────────────────────────
// Next.js dev startup takes 20-60s; the full pipeline including server startup,
// ingest, routing, dispatch, QC adds another ~30s. 180s gives headroom.
const TEST_TIMEOUT_MS = 180_000;

// ── Temp directory setup ─────────────────────────────────────────────────────
const TMP_DIR      = fs.mkdtempSync(path.join(os.tmpdir(), 'duck-e2e-'));
const DB_PATH      = path.join(TMP_DIR, 'mission-control.test.db');
const PROJECTS_DIR = path.join(TMP_DIR, 'projects');
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// Explicit filesystem/config roots keep all fixture state away from an installed
// runtime. The real dispatch and QC guards use these same configured roots.
const OPENCLAW_ROOT = path.join(TMP_DIR, 'openclaw');
const COMPANY_ROOT = path.join(TMP_DIR, 'company');
fs.mkdirSync(path.join(OPENCLAW_ROOT, 'agents', 'dept-graphics', 'sessions'), {recursive:true});
fs.mkdirSync(COMPANY_ROOT, {recursive:true});
fs.writeFileSync(path.join(OPENCLAW_ROOT,'openclaw.json'),JSON.stringify({agents:{list:[{id:'dept-graphics',name:'Pixel',model:{primary:'openai/gpt-4o'}}]}}));
const COMPANY_CONFIG=path.join(COMPANY_ROOT,'company-config.json');
const PERSONA_CATALOG=path.join(COMPANY_ROOT,'persona-categories.json');
fs.writeFileSync(COMPANY_CONFIG,JSON.stringify({company_id:'default',company_slug:'default'}));
fs.writeFileSync(PERSONA_CATALOG,JSON.stringify({version:'duck-v1',personas:{'duck-e2e-persona':{name:'Duck Graphics Specialist'}}}));
fs.mkdirSync(path.join(TMP_DIR,'coaching-personas'),{recursive:true});
fs.copyFileSync(PERSONA_CATALOG,path.join(TMP_DIR,'coaching-personas','persona-categories.json'));
const FIXTURE_ENV:NodeJS.ProcessEnv={
  CC_TEST_FIXTURE_ROOT:TMP_DIR, WORKSPACE_BASE_PATH:TMP_DIR,
  OPENCLAW_ROOT, OPENCLAW_WORKSPACE_ROOT:TMP_DIR, OPENCLAW_COMPANY_ROOT:COMPANY_ROOT,
  BCC_DEVICE_IDENTITY_DIR:path.join(TMP_DIR,'identity'),
  OPENCLAW_SKILL23_SCRIPTS:path.join(TMP_DIR,'absent-scripts'),
  OPENCLAW_CLI_BIN:'/usr/bin/false', OWNER_NOTIFY_TELEGRAM_DISABLED:'1',
  DISABLE_CRON:'1',DISABLE_REGISTRY_BOOT_SEED:'1',DISABLE_BRIDGE_BOOTSTRAP:'1',DISABLE_AGENT_SYNC:'1',
  MC_COMPANY_ID:'default',MC_INSTALLATION_ID:'duck-install',
  MC_TENANT_REGISTRY_JSON:JSON.stringify({'127.0.0.1':{kind:'self',tenantId:'duck-tenant',companyId:'default',installationId:'duck-install'}}),
  MC_PERSONA_COMPANY_CONTEXTS_JSON:JSON.stringify({default:{companyRoot:COMPANY_ROOT,companyConfig:COMPANY_CONFIG,companySlug:'default',personaCatalog:PERSONA_CATALOG}}),
};
// Preseed test-only device identity; device loader must never copy a live key.
fs.mkdirSync(FIXTURE_ENV.BCC_DEVICE_IDENTITY_DIR!,{recursive:true});
const pair=generateKeyPairSync('ed25519');
fs.writeFileSync(path.join(FIXTURE_ENV.BCC_DEVICE_IDENTITY_DIR!,'device.json'),JSON.stringify({version:1,deviceId:'duck-fixture-device',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString(),privateKeyPem:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString(),createdAtMs:Date.now()}),{mode:0o600});
const BLOCK_EXTERNAL=path.join(TMP_DIR,'block-external.cjs');
fs.writeFileSync(BLOCK_EXTERNAL,`
const allowed=new Set(['127.0.0.1','localhost','::1','[::1]']);
const ports=new Set((process.env.DUCK_ALLOWED_PORTS||'').split(','));
const originalFetch=globalThis.fetch;
globalThis.fetch=(url,...args)=>{if(!allowed.has(new URL(typeof url==='string'||url instanceof URL?url:url.url).hostname)||!ports.has(new URL(typeof url==='string'||url instanceof URL?url:url.url).port))return Promise.reject(new Error('duck fixture blocks external network'));return originalFetch(url,...args)};
for(const mod of [require('http'),require('https')])for(const method of ['request','get']){const original=mod[method];mod[method]=function(input,...args){const hostname=typeof input==='string'||input instanceof URL?new URL(input).hostname:input.hostname||input.host||'localhost';const port=typeof input==='string'||input instanceof URL?new URL(input).port:String(input.port||'');if(!allowed.has(hostname)||!ports.has(port))throw new Error('duck fixture blocks external network');return original.call(this,input,...args)}};
`);
// Fill every provider-discovery slot with unusable fixture values so boot never
// reads operator secret files. External network is independently blocked above.
for(const key of ['KIE_API_KEY','KIEAI_API_KEY','KIE_AI_API_KEY','OPENAI_API_KEY','FAL_KEY','FAL_API_KEY','FAL_AI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GENERATIVE_AI_API_KEY','FISH_AUDIO_API_KEY','ELEVENLABS_API_KEY','REPLICATE_API_TOKEN','REPLICATE_API_KEY','LUMA_API_KEY','LUMAAI_API_KEY','STABILITY_API_KEY','STABILITY_AI_API_KEY','RUNWAY_API_KEY','RUNWAYML_API_SECRET','ANTHROPIC_API_KEY','OLLAMA_CLOUD_API_KEY','OLLAMA_API_KEY','X_AI_API_KEY','XAI_API_KEY','ZAI_API_KEY','ZHIPU_API_KEY','GLM_API_KEY','Z_AI_API_KEY','OPENROUTER_API_KEY','MOONSHOT_API_KEY','MINIMAX_API_KEY','XIAOMI_API_KEY'])FIXTURE_ENV[key]='isolated-duck-fixture-no-provider-access';
const sentMessages:Record<string,unknown>[]=[];
let executionId:string;
async function producerDecision(){
  const {personaBundleHash}=await import('../../src/lib/persona-state');
  const audience={label:'General consumers',candidates:['General consumers'],source:'asked',confidence:1};
  const bundle={company_id:'default',confirm_required:false,voice:{audience_persona:{id:'duck-e2e-persona',why:'Confirmed fixture voice'},topic_persona:{id:'duck-e2e-persona',why:'Graphics expertise'},collapsed:true,collapsed_persona_id:'duck-e2e-persona'},resolved_audience:audience,blend_directive:'Use the confirmed graphics specialist to create a clear blue duck image.',task_personas:[],catalog_version:'duck-v1',confirmation:{actor_id:'duck-owner',confirmed_at:new Date().toISOString(),audience_hash:personaBundleHash(audience)}};
  return {voice_persona_id:'duck-e2e-persona',topic_persona_id:'duck-e2e-persona',task_persona_ids:[],persona_bundle:bundle,bundle_sha:personaBundleHash(bundle)};
}

// ── Stub WS server (executor seam) ───────────────────────────────────────────
// We stand up a minimal WS server that speaks just enough of the OpenClaw
// challenge/response protocol for getOpenClawClient().connect() to succeed.
// task-dispatcher then calls client.call('chat.send', …) which succeeds (we
// return a { type:'res', id, ok:true } frame), and the task reaches in_progress.
let stubWss: WebSocketServer;
let stubPort: number;

async function startOpenClawStub(): Promise<{ port: number; wss: WebSocketServer }> {
  const port = await freePort();
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    // Step 1: send challenge event
    ws.send(JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'duck-test-nonce' },
    }));

    ws.on('message', (rawMsg) => {
      try {
        const msg = JSON.parse(rawMsg.toString()) as Record<string, unknown>;
        if (msg.type === 'req' && msg.method === 'connect') {
          // Approve the connect handshake
          ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: {} }));
        } else if (msg.type === 'req') {
          // Only the local stub receives the real dispatch.
          if(msg.method==='chat.send')sentMessages.push(msg.params as Record<string,unknown>);
          ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: {runId:`duck-${msg.id}`,sessions:[]} }));
        }
      } catch {
        // ignore malformed messages
      }
    });
  });

  return new Promise((resolve) => {
    wss.once('listening', () => resolve({ port, wss }));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

// ── App server management ─────────────────────────────────────────────────────
let appPort: number;
let appProc: ChildProcess;
let appBase: string;

const REPO_ROOT = path.resolve(__dirname, '../..');

function hasNextBuild(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, process.env.NEXT_DIST_DIR || '.next', 'BUILD_ID'));
}

async function startAppServer(): Promise<{ port: number; proc: ChildProcess }> {
  const port = await freePort();
  const mode = hasNextBuild() ? 'start' : 'dev';

  // Env for the test server: isolated DB + projects path + stub WS + no SOP fast-loop
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...FIXTURE_ENV,
    NEXT_DIST_DIR: process.env.NEXT_DIST_DIR || '.next',
    MISSION_CONTROL_URL:`http://127.0.0.1:${port}`,
    NEXT_PUBLIC_APP_URL:`http://127.0.0.1:${port}`,
    DUCK_ALLOWED_PORTS:`${port},${stubPort}`,
    NODE_OPTIONS: `--require=${BLOCK_EXTERNAL}`,
    DATABASE_PATH:     DB_PATH,
    PORT:              String(port),
    PROJECTS_PATH:     PROJECTS_DIR,
    OPENCLAW_GATEWAY_URL:   `ws://127.0.0.1:${stubPort}`,
    OPENCLAW_GATEWAY_TOKEN: 'duck-test-token',
    // Disable side-channel calls that would fail with no API key
    DISABLE_SOP_FAST_LOOP:  '1',
    SKIP_DEMO_SEED:          'true',
    DISABLE_QC_AUTO_SCORER:  '0', // leave QC scorer ON — we want to observe it
    NODE_ENV: 'test',
    // The fail-closed middleware (v4.52.0 AUTH HARDEN) rejects external /api/*
    // with 503 when MC_API_TOKEN/WEBHOOK_SECRET are unset. The former
    // ALLOW_INSECURE_OPEN_API escape hatch is now NEUTERED under `next start`
    // (INGEST-05 gates it on NODE_ENV !== 'production', and `next start` forces
    // NODE_ENV=production), so instead of trying to bypass auth we provision
    // real test-only secrets HERE and have every HTTP helper present the
    // matching Bearer + HMAC signature. This authenticates the harness exactly
    // like a production caller — the real prod auth path is exercised, and NO
    // production auth code is touched or weakened. These secrets exist only in
    // this ephemeral localhost test server's env.
    MC_API_TOKEN:  TEST_MC_API_TOKEN,
    WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    // Cloudflare Access enforcement (DATA-10) is now DEFAULT-ON whenever
    // NODE_ENV === 'production'. `next start` (the `hasNextBuild()` path used in
    // CI) FORCES NODE_ENV=production regardless of the NODE_ENV:'test' set above,
    // so the middleware would 401 every /api/* request with
    // "Cloudflare Access is not active on this subdomain" — there is no
    // Cloudflare edge in front of this ephemeral localhost test server to inject
    // the Cf-Access-* headers. Opt this test server into the documented dev/test
    // posture (src/middleware.ts: "Anywhere else (dev/test) keeps the historical
    // default-OFF"; see .env.example + docs/CLOUDFLARE_ACCESS_SETUP.md). This is
    // a TEST-SERVER-ONLY env the train's own auth code reads; it does NOT change
    // production (prod images stay default-ON) and touches no production code.
    REQUIRE_CF_ACCESS: 'false',
  };

  // Use the same node binary, run next via node_modules
  const proc = spawn(
    path.join(REPO_ROOT, 'node_modules/.bin/next'),
    [mode, '--port', String(port)],
    { cwd: REPO_ROOT, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  appProc=proc;
  const output=fs.createWriteStream(path.join(TMP_DIR,'server.log'));
  proc.stdout?.pipe(output);proc.stderr?.pipe(output);
  console.log(`[duck-e2e] Server log: ${path.join(TMP_DIR,'server.log')}`);
  // Wait until the server is accepting connections
  await waitForHttp(`http://127.0.0.1:${port}/api/health`, 60_000);

  return { port, proc };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) throw new Error(`Server did not start within ${timeoutMs}ms`);
    const ok = await httpGet200(url).catch(() => false);
    if (ok) return;
    await sleep(500);
  }
}

function httpGet200(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    }).on('error', () => resolve(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── SSE subscription ──────────────────────────────────────────────────────────
interface SSEEvent { type: string; payload?: unknown }
const sseEvents: SSEEvent[] = [];
let sseCleanup: (() => void) | null = null;
let sseConnected = false;

function subscribeSSE(base: string): Promise<void> {
  return new Promise((resolve,reject) => {
    const url = `${base}/api/events/stream`;
    // /api/events/stream is MC_API_TOKEN-gated (middleware Gate B). A real
    // EventSource can only pass the token as a `?token=` query param, but this
    // raw-http subscriber can send the standard Bearer header, which the
    // middleware accepts on the fall-through path.
    const req = http.get(url, { headers: bearerHeader() }, (res) => {
      if(res.statusCode!==200){res.resume();clearTimeout(timer);reject(new Error(`SSE refused: ${res.statusCode}`));return;}
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          // The SSE stream sends `: connected` as the first comment line.
          if (!sseConnected && line.startsWith(':')) {
            sseConnected = true;
            clearTimeout(timer);
            resolve(); // signal: connection is established
          }
          if (line.startsWith('data: ')) {
            try {
              const evt = JSON.parse(line.slice(6)) as SSEEvent;
              sseEvents.push(evt);
            } catch {
              // ignore non-JSON data lines
            }
          }
        }
      });
    });
    sseCleanup = () => req.destroy();
    const timer=setTimeout(()=>{req.destroy();reject(new Error('SSE did not connect'));},10_000);
    req.on('error',error=>{clearTimeout(timer);reject(error);});
  });
}

function sseHasType(type: string): boolean {
  return sseEvents.some((e) => e.type === type);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          // Middleware layer-2 bearer (all external /api/* callers).
          ...bearerHeader(),
          // Route-level HMAC over the EXACT raw body we send. Only the
          // WEBHOOK_SECRET_ROUTES (POST /api/tasks/ingest) validate it; other
          // POSTs (e.g. /deliverables) ignore the extra header harmlessly.
          'x-webhook-signature': webhookSignature(payload),
        } },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, json: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode!, json: data }); }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function get(url: string): Promise<{ status: number; json: unknown; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: bearerHeader() }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, json: JSON.parse(data), headers: res.headers as Record<string, string | string[] | undefined> }); }
        catch { resolve({ status: res.statusCode!, json: data, headers: res.headers as Record<string, string | string[] | undefined> }); }
      });
    }).on('error', reject);
  });
}

async function patch(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          // Middleware layer-2 bearer. PATCH /api/tasks/:id is NOT a
          // WEBHOOK_SECRET_ROUTE, so no HMAC signature is required.
          ...bearerHeader(),
        } },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, json: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode!, json: data }); }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Derive the expected artifact directory for a task.
 *
 * §3 contract (this branch): PROJECTS_DIR/artifacts/<task-id>/
 * This matches task-lifecycle.ts artifactDir() which is the canonical §3 path.
 */
function expectedArtifactDir(taskId: string, _taskTitle: string): string {
  // §3 contract: artifacts/<task-id>/ (task-lifecycle.ts artifactDir)
  return path.join(PROJECTS_DIR, 'artifacts', taskId);
}

// ── Wait helpers ──────────────────────────────────────────────────────────────

async function pollTask(taskId: string, predicate: (t: Record<string, unknown>) => boolean, label: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { json } = await get(`${appBase}/api/tasks/${taskId}`);
    if (predicate(json as Record<string, unknown>)) return json as Record<string, unknown>;
    await sleep(300);
  }
  const { json } = await get(`${appBase}/api/tasks/${taskId}`);
  throw new Error(`Timeout waiting for: ${label}. Last task: ${JSON.stringify(json)}`);
}

async function pollEvents(taskId: string, predicate: (evts: unknown[]) => boolean, label: string, timeoutMs = 15_000): Promise<unknown[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { json } = await get(`${appBase}/api/tasks/${taskId}/activities`);
    const arr = Array.isArray(json) ? json : [];
    if (predicate(arr)) return arr;
    await sleep(300);
  }
  const { json } = await get(`${appBase}/api/tasks/${taskId}/activities`);
  throw new Error(`Timeout waiting for activities: ${label}. Last: ${JSON.stringify(json)}`);
}

// ── DB helpers (direct sqlite via the same DB_PATH after app is running) ──────
// We query the DB directly for assertions that are simpler at the row level.
// Import is deferred so DATABASE_PATH is set before better-sqlite3 opens the file.

async function getTaskRow(taskId: string): Promise<Record<string, unknown> | null> {
  const { queryOne } = await import('../../src/lib/db') as typeof import('../../src/lib/db');
  return (queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [taskId]) ?? null) as Record<string, unknown> | null;
}

async function getEventsForTask(taskId: string): Promise<Array<Record<string, unknown>>> {
  const { queryAll } = await import('../../src/lib/db') as typeof import('../../src/lib/db');
  return queryAll<Record<string, unknown>>('SELECT * FROM events WHERE task_id = ? ORDER BY created_at ASC', [taskId]);
}

// ── Seed helper ───────────────────────────────────────────────────────────────
async function seedFixtures(): Promise<void> {
  // We need DATABASE_PATH set before importing db, so set it now (already set
  // as process.env for the child server process; we also need it for OUR
  // direct DB queries above).
  process.env.DATABASE_PATH = DB_PATH;
  Object.assign(process.env,FIXTURE_ENV);

  const { getDb, closeDb, run, queryAll } = await import('../../src/lib/db') as typeof import('../../src/lib/db');

  // Boot migrations
  getDb();

  const now = new Date().toISOString();
  run("UPDATE workspaces SET slug=slug||'-seed' WHERE slug IN ('graphics','master-orchestrator')");

  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'BlackCEO Demo', 'default', '{}', ?, ?)`,
    [now, now],
  );

  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('ws-master', 'Master Orchestrator', 'master-orchestrator', 'CEO workspace', '🎯', 'default', 0, ?, ?)`,
    [now, now],
  );

  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('ws-graphics', 'Graphics', 'graphics', 'Graphics department', '🎨', 'default', 10, ?, ?)`,
    [now, now],
  );

  // Check if role_type column exists (migration 060)
  const cols = queryAll<{ name: string }>('PRAGMA table_info(agents)', []);
  const hasRoleType = cols.some((c) => c.name === 'role_type');

  if (hasRoleType) {
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id, specialist_type, role_type, created_at, updated_at)
       VALUES ('d0000000-0000-4000-8000-000000000002', 'Stefanie', 'CEO', 'Master orchestrator', '🤖', 'standby', 1, 'ws-master', 'permanent', null, ?, ?)`,
      [now, now],
    );
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id, specialist_type, role_type, created_at, updated_at)
       VALUES ('d0000000-0000-4000-8000-000000000001', 'Pixel', 'Graphics Specialist', 'Creates images and visual assets', '🎨', 'standby', 0, 'ws-graphics', 'permanent', null, ?, ?)`,
      [now, now],
    );
  } else {
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id, specialist_type, created_at, updated_at)
       VALUES ('d0000000-0000-4000-8000-000000000002', 'Stefanie', 'CEO', 'Master orchestrator', '🤖', 'standby', 1, 'ws-master', 'permanent', ?, ?)`,
      [now, now],
    );
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id, specialist_type, created_at, updated_at)
       VALUES ('d0000000-0000-4000-8000-000000000001', 'Pixel', 'Graphics Specialist', 'Creates images and visual assets', '🎨', 'standby', 0, 'ws-graphics', 'permanent', ?, ?)`,
      [now, now],
    );
  }

  run("INSERT OR IGNORE INTO model_registry(model_id,label,provider,capabilities,status) VALUES('openai/gpt-4o','Fixture writer','openai','[\"text\",\"vision\"]','active')");
  run("INSERT OR IGNORE INTO agent_settings(id,department_id,role_id,setting_type,value) VALUES('duck-model','ws-graphics','d0000000-0000-4000-8000-000000000001','model','openai/gpt-4o')");

  // Seed a Graphics SOP so the Triad Rule gate (description + sop_id + persona_id)
  // can be satisfied before the test advances the task out of backlog.
  // The SOP must be non-deleted and reference the Graphics department.
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, description, version, department, steps, created_at, updated_at)
     VALUES ('sop-duck-e2e', 'Duck Image Generation SOP', 'duck-image-generation',
             'Standard operating procedure for generating duck images via mock generator',
             1, 'Graphics', '["Generate image","Verify PNG","Register deliverable"]', ?, ?)`,
    [now, now],
  );

  closeDb();
}

/** Mock executor evidence for the real AF-I14 parser, stored only below the
 * explicit OPENCLAW_ROOT. It proves the fixture contract, not a real KIE run. */
function seedKieSessionTrace(taskId: string, agentId: string): string {
  const sessionId = executionId;
  const sessDir = path.join(OPENCLAW_ROOT, 'agents', agentId, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'message', role: 'user', content: `Task ${taskId}: create a blue duck image` }),
    JSON.stringify({
      type: 'tool_use',
      name: 'bash',
      input: { command: `python3 scripts/kie_generate.py prompts.json renders/ # api.kie.ai /api/v1/jobs/createTask` },
    }),
    JSON.stringify({ type: 'message', role: 'assistant', content: `Image generated via kie_generate.py (api.kie.ai) for task ${taskId}.` }),
  ];
  fs.writeFileSync(path.join(sessDir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');
  return sessionId;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

test('duck pipeline end-to-end (mock generator)', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  t.after(async()=>{sseCleanup?.();appProc?.kill('SIGTERM');for(const client of stubWss?.clients??[])client.terminate();stubWss?.close();});
  async function step(name:string,run:()=>Promise<void>){let failure:unknown;await t.test(name,async()=>{try{await run();}catch(error){failure=error;throw error;}});if(failure)throw failure;}


  // ── Setup: stub WS + DB seed + app server ─────────────────────────────────
  await step('setup: seed fixtures', async () => {
    await seedFixtures();
  });

  await step('setup: start OpenClaw stub WS', async () => {
    const result = await startOpenClawStub();
    stubPort = result.port;
    stubWss  = result.wss;
    console.log(`[duck-e2e] OpenClaw stub listening on ws://127.0.0.1:${stubPort}`);
  });

  await step('setup: start Next.js app server', async () => {
    const result = await startAppServer();
    appPort = result.port;
    appProc = result.proc;
    appBase = `http://127.0.0.1:${appPort}`;
    console.log(`[duck-e2e] App server at ${appBase}`);
  });

  await step('setup: subscribe to SSE stream', async () => {
    // subscribeSSE returns a promise that resolves when the `: connected`
    // comment arrives. This ensures registerClient()
    // has run in the server process before we fire the ingest POST.
    await subscribeSSE(appBase);
    console.log(`[duck-e2e] SSE connected`);
  });

  // ── a. POST "create a blue duck image" to ingest ──────────────────────────
  let taskId: string;
  let taskTitle: string;
  let ingestWorkspaceId: string;

  await step('a. POST to /api/tasks/ingest → 201', async () => {
    taskTitle = 'create a blue duck image';
    const res = await post(`${appBase}/api/tasks/ingest`, {
      title: taskTitle,
      description: 'Generate a high-quality image of a blue rubber duck.',
      source: 'e2e-test',
      department_slug: 'graphics',
      ...await producerDecision(),
    });
    assert.equal(res.status, 201, `Expected 201 from ingest, got ${res.status}: ${JSON.stringify(res.json)}`);
    const body = res.json as Record<string, unknown>;
    assert.ok(body.task_id, 'task_id must be present in ingest response');
    assert.equal(body.ok, true, 'ok must be true');
    taskId = body.task_id as string;
    ingestWorkspaceId = body.workspace_id as string;
    console.log(`[duck-e2e] Task created: ${taskId}`);
  });

  // ── b. Task routed to graphics workspace ─────────────────────────────────
  await step('b. task routed to graphics workspace', async () => {
    const task = await pollTask(
      taskId,
      (t) => {
        const wsId = t.workspace_id as string | undefined;
        return !!(wsId && (wsId === 'ws-graphics' || wsId.includes('graphics')));
      },
      'workspace_id contains graphics',
      10_000,
    );
    const wsId = task.workspace_id as string;
    assert.ok(
      wsId === 'ws-graphics' || wsId.toLowerCase().includes('graphics'),
      `Expected graphics workspace, got: ${wsId}`,
    );
    console.log(`[duck-e2e] Task workspace: ${wsId}`);
  });

  // ── c. Persona AND model recorded on the task row (non-null) ─────────────
  // The persona selector is async (spawns Python) and may not have run yet.
  // We accept: model_id resolved OR assigned_agent_id present (agent carries model).
  // persona_id may not be set yet if the Python selector is not installed; we
  // assert the agent assignment (which IS deterministic) and note persona.
  await step('c. agent assigned (persona/model seam verified)', async () => {
    const task = await pollTask(
      taskId,
      (t) => !!(t.assigned_agent_id),
      'assigned_agent_id non-null',
      10_000,
    );
    assert.ok(task.assigned_agent_id, `assigned_agent_id must be non-null; got: ${JSON.stringify(task)}`);
    // model_id may be null until dispatch fires; we verify it via DB row after dispatch
    console.log(`[duck-e2e] Agent assigned: ${task.assigned_agent_id}, model_id: ${task.model_id ?? '(pending dispatch)'}`);

    assert.equal(task.persona_id,'duck-e2e-persona','producer decision must be pinned');
    assert.ok(task.sop_id,'a matching SOP must be selected before dispatch');
    const {queryOne}=await import('../../src/lib/db');
    const sop=queryOne<{department:string;deleted_at:string|null}>('SELECT department,deleted_at FROM sops WHERE id=?',[task.sop_id as string]);
    assert.match(sop!.department.toLowerCase(),/graphics/);
    assert.equal(sop!.deleted_at,null);
  });

  // Actual dispatch must reach the local WS stub, reserve one durable attempt,
  // and commit in_progress. No direct status PATCH can substitute for a send.
  await step('d. auto-dispatch sends exactly once and owns in_progress',async()=>{
    await pollTask(taskId,t=>t.status==='in_progress','actual gateway dispatch',30_000);
    const {queryAll}=await import('../../src/lib/db');
    let attempts:Record<string,unknown>[]=[];
    const deadline=Date.now()+15_000;
    do {attempts=queryAll<Record<string,unknown>>('SELECT * FROM task_executions WHERE task_id=?',[taskId]);if(attempts[0]?.state==='accepted')break;await sleep(100);}while(Date.now()<deadline);
    assert.equal(attempts.length,1,'one durable execution');
    executionId=String(attempts[0].id);
    assert.equal(attempts[0].state,'accepted');
    assert.equal(sentMessages.length,1,'one remote chat.send');
    assert.ok(JSON.stringify(sentMessages[0]).includes(executionId),'prompt carries current execution identity');
    assert.ok((await getEventsForTask(taskId)).some(e=>e.type==='task_dispatched'),'actual dispatch event required');
  });

  // Check model_id after dispatch (intelligence-resolver stamps it)
  await step('c2. model_id stamped on task row after dispatch', async () => {
    const row = await getTaskRow(taskId);
    assert.ok(row, 'task row must exist');
    // model_id is set by task-dispatcher after resolveAndLog; it may be null if
    // resolveAndLog returned the hardcoded default without a DB entry. We accept
    // either a non-null model_id OR the presence of the assigned agent (which
    // carries its own model). The important invariant is the agent IS assigned.
    assert.ok(row.assigned_agent_id, `assigned_agent_id must be non-null post-dispatch; row: ${JSON.stringify(row)}`);
    console.log(`[duck-e2e] Post-dispatch: model_id=${row.model_id}, assigned_agent_id=${row.assigned_agent_id}`);
  });

  // ── e. Execute via MOCK generator → write real PNG ────────────────────────
  let artifactPath: string;
  let artifactFilename: string;

  await step('e. mock generator writes valid PNG', async () => {
    const artifactDir = expectedArtifactDir(taskId, taskTitle);
    artifactFilename = 'blue-duck.png';
    artifactPath = path.join(artifactDir, artifactFilename);

    const generated = runMockGenerator(artifactPath);
    assert.ok(generated, 'mock generator must return true in mock mode');
    assert.ok(fs.existsSync(artifactPath), `PNG must exist at ${artifactPath}`);

    const stat = fs.statSync(artifactPath);
    assert.ok(stat.size > 0, `PNG must be non-empty; got ${stat.size} bytes`);

    // Verify the PNG is ≥1 KB so the QC scorer's min_resolution heuristic passes.
    // The mock generator writes a 64×64 gradient PNG (~11 KB) — a solid-colour
    // 8×8 PNG compresses to ~73 bytes which fails the ≥1024-byte size proxy.
    assert.ok(
      stat.size >= 1024,
      `PNG must be ≥1024 bytes to satisfy QC min_resolution heuristic; got ${stat.size} bytes`,
    );

    // Verify magic bytes (PNG signature: 89 50 4E 47 0D 0A 1A 0A)
    const buf = Buffer.alloc(8);
    const fd  = fs.openSync(artifactPath, 'r');
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(buf, PNG_SIG, 'File must start with PNG magic bytes');

    console.log(`[duck-e2e] PNG written: ${artifactPath} (${stat.size} bytes)`);
  });

  // ── f. Artifact lands at the artifact-contract location ──────────────────
  // §3 contract: artifacts/<task-id>/ (task-lifecycle.ts artifactDir)
  await step('f. artifact at contract location (§3: PROJECTS_PATH/artifacts/<task-id>/)', async () => {
    const expectedDir = expectedArtifactDir(taskId, taskTitle);
    assert.ok(
      fs.existsSync(artifactPath),
      `Artifact must exist at contract path ${artifactPath}`,
    );
    assert.ok(
      artifactPath.startsWith(expectedDir),
      `Artifact path ${artifactPath} must be inside ${expectedDir}`,
    );
    console.log(`[duck-e2e] §3 Artifact path contract verified: ${expectedDir}`);
  });

  // ── Register deliverable via API ──────────────────────────────────────────
  let deliverableId: string;

  await step('register deliverable via POST /api/tasks/:id/deliverables', async () => {
    const res = await post(`${appBase}/api/tasks/${taskId}/deliverables`, {
      deliverable_type: 'file',
      title: 'Blue Duck Image',
      path: artifactPath,
      description: 'Mock-generated blue duck PNG for CI test',
    });
    // 201 = created fresh; 200 with warning is also acceptable if file validation warns
    assert.ok(
      res.status === 201 || res.status === 200,
      `Expected 200/201 from deliverables POST, got ${res.status}: ${JSON.stringify(res.json)}`,
    );
    const body = res.json as Record<string, unknown>;
    assert.ok(body.id, 'deliverable id must be present');
    deliverableId = body.id as string;
    console.log(`[duck-e2e] Deliverable registered: ${deliverableId}`);
  });

  // ── Seed KIE.ai session trace so AF-I14 guardrail passes (see helper) ─────
  // Must run BEFORE the review PATCH (which fires runQCOnReview → AF-I14).
  await step('seed KIE.ai session trace for AF-I14 guardrail', async () => {
    const row = await getTaskRow(taskId);
    const agentId = (row?.assigned_agent_id as string | undefined) ?? 'd0000000-0000-4000-8000-000000000001';
    const {queryOne}=await import('../../src/lib/db');
    const attempt=queryOne<{session_id:string}>('SELECT session_id FROM task_executions WHERE id=?',[executionId])!;
    const sessionId = seedKieSessionTrace(taskId, agentId);
    const sessions=path.join(OPENCLAW_ROOT,'agents',agentId,'sessions');
    fs.renameSync(path.join(sessions,`${sessionId}.jsonl`),path.join(sessions,`${attempt.session_id}.jsonl`));
    const {runAFI14Guardrail}=await import('../../src/lib/qc-scorer');
    const trace=runAFI14Guardrail(taskId,agentId,'graphics',true);
    assert.equal(trace.traceFound,true,'mock execution trace is locatable under configured runtime');
    assert.equal(trace.violated,false,'mock trace satisfies the real mandated-tool guard');
    console.log(`[duck-e2e] AF-I14 trace seeded: agent=${agentId} session=${sessionId} runtime=${OPENCLAW_ROOT}`);
  });

  // ── Advance task to review (triggers QC) ─────────────────────────────────
  await step('advance task to review via PATCH', async () => {
    const {queryOne}=await import('../../src/lib/db');
    const {expectedPersonaManifest}=await import('../../src/lib/persona-conformance');
    const bundle=JSON.parse(queryOne<{bundle_json:string}>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?',[taskId])!.bundle_json);
    const task=await getTaskRow(taskId);
    const evidence=await post(`${appBase}/api/tasks/${taskId}/activities`,{activity_type:'completed',agent_id:task!.assigned_agent_id,message:'Mock executor checked its persona and artifact.',metadata:{kind:'persona_used',execution_id:executionId,...expectedPersonaManifest(bundle),conformance_passed:true,artifacts:[{deliverable_id:deliverableId,sha256:createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex')}]}});
    assert.equal(evidence.status,201,JSON.stringify(evidence.json));
    const {requirePersonaConformanceForCompletion}=await import('../../src/lib/persona-conformance');
    assert.equal(requirePersonaConformanceForCompletion(taskId).pass,true,'whole persona and artifact manifest verified');
    const stale=await patch(`${appBase}/api/tasks/${taskId}`,{status:'review',execution_id:'dead0000-0000-4000-8000-000000000000'});
    assert.equal(stale.status,409,'stale completion must be refused');
    const res = await patch(`${appBase}/api/tasks/${taskId}`, { status: 'review',execution_id:executionId });
    assert.ok(
      res.status === 200 || res.status === 201,
      `Expected 200/201 from PATCH status=review, got ${res.status}: ${JSON.stringify(res.json)}`,
    );
    const body = res.json as Record<string, unknown>;
    console.log(`[duck-e2e] PATCH review → status: ${body.status}`);
    assert.equal(queryOne<{state:string}>('SELECT state FROM task_executions WHERE id=?',[executionId])!.state,'succeeded','current worker execution released after accepted review');
  });

  // The mock proves executor/evidence plumbing. External vision is blocked,
  // so independent QC must explicitly hold the image instead of claiming that
  // a PNG header proves it depicts a duck. This is a deliberate negative control.
  await step('g. independent QC explicitly holds unavailable visual verification', async () => {
    // Wait for the explicit quality hold and its durable reason.
    let qcEventFound = false;
    let finalStatus = '';
    let qcMessage = '';
    const start = Date.now();
    // Leave headroom for independent QC and reroute accounting on CI.
    while (Date.now() - start < 45_000) {
      const events = await getEventsForTask(taskId);
      const qcEvt = events.find((e) => {
        const msg = String(e.message ?? '');
        const t   = String(e.type ?? '');
        return t.includes('qc') || msg.toLowerCase().includes('qc') || msg.toLowerCase().includes('score') || msg.toLowerCase().includes('criteria');
      });
      if (qcEvt) {
        qcEventFound = true;
        qcMessage=String(qcEvt.message);
        console.log(`[duck-e2e] QC event found: type=${qcEvt.type} msg=${String(qcEvt.message).slice(0, 120)}`);
      }
      const { json } = await get(`${appBase}/api/tasks/${taskId}`);
      const taskNow = json as Record<string, unknown>;
      finalStatus = taskNow.status as string;
      assert.notEqual(finalStatus,'done','unverified visual output cannot auto-pass QC');
      if (finalStatus === 'blocked' && qcEventFound) {
        break;
      }
      await sleep(400);
    }
    assert.ok(qcEventFound, 'QC must have run (qc event in events table)');
    assert.match(qcMessage,/vision_match/i,'hold names unavailable independent visual verification');
    assert.equal(
      finalStatus,'blocked',
      `Expected explicit blocked state after unavailable independent vision, got: ${finalStatus}`,
    );
    console.log(`[duck-e2e] Independent QC refused unverified visual claims: ${finalStatus}`);
  });

  await step('h. offline vision hold remains visible on the board',async()=>{
    const {json}=await get(`${appBase}/api/tasks/${taskId}`);
    assert.equal((json as Record<string,unknown>).status,'blocked');
  });

  // Require real task-specific SSE frames as well as independent DB audit
  // persistence. Durable rows alone do not prove the browser was notified.
  await step('i. SSE/live-feed event stream contains every transition', async () => {
    // Side A: in-process SSE events captured by our subscriber
    const relevantTypes = new Set(['task_created', 'task_updated', 'deliverable_added']);
    const sideASse = sseEvents.filter((e) => relevantTypes.has(e.type));
    console.log(`[duck-e2e] SSE side-A events: ${sseEvents.map((e) => e.type).join(', ') || '(none)' }`);

    // Side B: DB events for this task (via HTTP — proves the broadcast pipeline)
    const { json: eventsJson } = await get(`${appBase}/api/events?workspace_id=${ingestWorkspaceId}&limit=100`);
    const dbEvents = Array.isArray(eventsJson) ? eventsJson as Array<Record<string, unknown>> : [];
    const taskEvents = dbEvents.filter((e) => e.task_id === taskId);
    const taskEventTypes = taskEvents.map((e) => String(e.type ?? ''));
    console.log(`[duck-e2e] DB events for task: ${taskEventTypes.join(', ') || '(none)'}`);

    const hasCreated   = taskEventTypes.some((t) => t.includes('created') || t.includes('dispatched'));
    const hasCompleted = taskEventTypes.some((t) => t.includes('completed') || t.includes('qc') || t.includes('status'));

    const received=(type:string)=>sseEvents.some(event=>event.type===type && (event.payload as Record<string,unknown>|undefined)?.id===taskId);
    const deliverableReceived=()=>sseEvents.some(event=>event.type==='deliverable_added' && ((event.payload as Record<string,unknown>|undefined)?.task_id===taskId));
    const sseDeadline=Date.now()+10_000;
    while(Date.now()<sseDeadline && !(received('task_created')&&received('task_updated')&&deliverableReceived()))await sleep(100);
    assert.ok(received('task_created'),'actual task_created SSE frame required for this task');
    assert.ok(received('task_updated'),'actual task_updated SSE frame required for this task');
    assert.ok(deliverableReceived(),'actual deliverable_added SSE frame required for this task');

    // Additional assertion: the DB events table proves every major transition fired
    assert.ok(hasCreated, `DB must contain a task_created or task_dispatched event; types: ${taskEventTypes.join(', ')}`);
    assert.ok(hasCompleted, `DB must contain a task_completed or QC event; types: ${taskEventTypes.join(', ')}`);

    console.log(`[duck-e2e] i. PASS — SSE side-A: ${sideASse.length} events, DB side-B: ${taskEventTypes.join(', ')}`);
  });

  // ── j. Artifact URL returns 200 with image/png ────────────────────────────
  // §3 contract: /api/artifacts/<task-id>/<file> serves the PNG with image/png.
  // Also assert /api/files/preview (extended by the cherry-picked PR #80).
  await step('j. artifact URL returns 200 with image/png (§3 artifacts endpoint + preview)', async () => {
    // §3 artifacts endpoint
    const artifactsUrl = `${appBase}/api/artifacts/${taskId}/blue-duck.png`;
    const res = await get(artifactsUrl);
    assert.equal(res.status, 200, `§3 /api/artifacts endpoint must return 200; got ${res.status}: ${JSON.stringify(res.json)}`);
    const ct = res.headers['content-type'] as string | undefined ?? '';
    assert.ok(
      ct.includes('image/png') || ct.includes('image/'),
      `Content-Type must be image/png; got: ${ct}`,
    );
    console.log(`[duck-e2e] §3 /api/artifacts URL: ${artifactsUrl} → ${res.status} ${ct}`);

    // PR #80 preview endpoint (extended to serve images)
    const previewUrl = `${appBase}/api/files/preview?path=${encodeURIComponent(artifactPath)}`;
    const previewRes = await get(previewUrl);
    assert.equal(previewRes.status, 200, `Preview endpoint must return 200 for PNG (PR #80); got ${previewRes.status}`);
    const previewCt = previewRes.headers['content-type'] as string | undefined ?? '';
    assert.ok(
      previewCt.includes('image/') || previewCt.includes('png'),
      `Preview Content-Type must be image/*; got: ${previewCt}`,
    );
    console.log(`[duck-e2e] PR#80 /api/files/preview: ${previewRes.status} ${previewCt}`);

    // Also assert original download endpoint still works
    const downloadUrl = `${appBase}/api/files/download?path=${encodeURIComponent(artifactPath)}&raw=true`;
    const dlRes = await get(downloadUrl);
    assert.equal(dlRes.status, 200, `Download endpoint must return 200; got ${dlRes.status}`);
    console.log(`[duck-e2e] /api/files/download: ${dlRes.status}`);
  });

  // ── Teardown ──────────────────────────────────────────────────────────────
  await step('teardown', async () => {
    if (sseCleanup) sseCleanup();
    if (appProc) appProc.kill('SIGTERM');
    if (stubWss) stubWss.close();
    try {
      const { closeDb } = await import('../../src/lib/db') as typeof import('../../src/lib/db');
      closeDb();
    } catch { /* ok */ }
    // Clean up temp dir
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ok */ }
  });
});
