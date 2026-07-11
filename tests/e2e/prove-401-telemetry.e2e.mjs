#!/usr/bin/env node
/**
 * FLEET-FIX 2.3 / AUD-71 — END-TO-END PROOF against a REAL Next server.
 *
 * WHY THIS EXISTS, and why the unit tests are not enough
 * -----------------------------------------------------
 * `src/middleware.ts` runs in the EDGE runtime; the health endpoint that must
 * expose the 401 counter runs in the NODE runtime. Those are two different
 * JavaScript realms. A vitest suite runs everything in ONE Node realm, so it
 * physically CANNOT prove that the counter survives the crossing — a counter kept
 * in middleware module state passes a unit test and still reads 0 forever in
 * production. That is the exact trap the first cut of AUD-71 fell into.
 *
 * The only thing that settles it is a real `next build` + `next start`, where
 * Next compiles the middleware into an Edge bundle and the routes into a Node
 * bundle, and a real HTTP client on the outside. That is what this script does.
 *
 * It also proves the one thing the design leans on that no unit test can:
 * Next does NOT re-run middleware on a middleware-initiated rewrite. If it did,
 * the internal-only 404 guard in middleware() would swallow the rewrite and a
 * rejected caller would get 404 instead of 401. Check 1 below fails loudly if so.
 *
 * SAFETY
 * ------
 * Runs on its own port with its own throwaway DATABASE_PATH in a temp dir. It
 * never touches the operator's live `cc-prod` pm2 process, its port, or its DB.
 *
 * USAGE
 * -----
 *   npm run test:401-e2e              # builds, starts, probes, tears down
 *   CC_E2E_PORT=4111 npm run test:401-e2e
 *   CC_E2E_SKIP_BUILD=1 npm run test:401-e2e   # reuse an existing .next
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const PORT = Number(process.env.CC_E2E_PORT || 4311);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'e2e-mc-api-token-not-a-real-secret';
const UA = 'cc-401-e2e-prover/1.0';

const workdir = mkdtempSync(path.join(tmpdir(), 'cc-401-e2e-'));
const DB = path.join(workdir, 'mission-control.db');

let server = null;
const failures = [];
let checkNo = 0;

function check(name, ok, detail) {
  checkNo += 1;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${checkNo}. ${name}`);
  if (detail !== undefined) console.log(`         ${detail}`);
  if (!ok) failures.push(name);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))
    );
    p.on('error', reject);
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function waitForReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok || r.status === 503) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become ready on ${BASE} within ${timeoutMs}ms`);
}

/** The unauthorized_401 component off the REAL health surface. */
async function readHealthComponent() {
  const res = await fetch(`${BASE}/api/system/status?force=1`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`/api/system/status returned ${res.status}`);
  const body = await res.json();
  const comp = (body.components || []).find((c) => c.component === 'unauthorized_401');
  if (!comp) {
    throw new Error(
      `no unauthorized_401 component on the health surface. components: ` +
        (body.components || []).map((c) => c.component).join(', ')
    );
  }
  return comp;
}

async function main() {
  if (!(await portFree(PORT))) {
    throw new Error(
      `port ${PORT} is in use — refusing to start (will not disturb anything already listening). ` +
        `Set CC_E2E_PORT to a free port.`
    );
  }

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    MC_API_TOKEN: TOKEN,
    WEBHOOK_SECRET: 'e2e-webhook-secret-not-a-real-secret',
    DATABASE_PATH: DB,
    PORT: String(PORT),
    CC_PORT: String(PORT),
    // Keep the box's own CF-Access posture out of it; this proves the
    // credential-failure path, and the misconfiguration path is unit-tested.
    REQUIRE_CF_ACCESS: 'false',
    DEMO_MODE: 'false',
    ALLOW_INSECURE_OPEN_API: '',
  };

  if (process.env.CC_E2E_SKIP_BUILD !== '1') {
    console.log('\n[1/3] next build (Edge middleware + Node routes compiled separately)...');
    await run('npx', ['next', 'build'], { env });
  }

  console.log(`\n[2/3] next start on :${PORT} (throwaway DB at ${DB})...`);
  server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  const capture = (chunk) => {
    const s = chunk.toString();
    serverLog.push(s);
    if (process.env.CC_E2E_VERBOSE === '1') process.stdout.write(s);
  };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);

  await waitForReady();

  console.log('\n[3/3] driving real HTTP against the running server\n');

  // ── baseline ──────────────────────────────────────────────────────────────
  const before = await readHealthComponent();
  check(
    'the health endpoint exposes an `unauthorized_401` component at all',
    before.detail && typeof before.detail.count === 'number',
    `count=${before.detail?.count} status=${before.status}`
  );
  const base = before.detail.count;

  // ── (b) missing-header vs token-mismatch are distinguishable ──────────────
  const rMissing = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'user-agent': UA },
  });
  check(
    'a caller with NO Authorization header still gets 401 (the rewrite did NOT become a 404 — Next does not re-run middleware on its own rewrite)',
    rMissing.status === 401,
    `status=${rMissing.status} body=${JSON.stringify(await rMissing.clone().json())}`
  );

  const rMismatch = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'user-agent': UA, authorization: 'Bearer wrong-token-entirely' },
  });
  check(
    'a caller with the WRONG bearer gets 401',
    rMismatch.status === 401,
    `status=${rMismatch.status}`
  );

  // ── (a) the health endpoint reports a real non-zero count END TO END ───────
  const after = await readHealthComponent();
  const delta = after.detail.count - base;
  check(
    'ACCEPTANCE (a): the count on the health endpoint MOVED across the Edge->Node boundary',
    delta === 2 && after.detail.count > 0,
    `count ${base} -> ${after.detail.count} (delta ${delta}, expected 2)`
  );

  check(
    'ACCEPTANCE (b): missing-header and token-mismatch are separately counted',
    after.detail.byReason?.['missing-header'] === 1 &&
      after.detail.byReason?.['token-mismatch'] === 1,
    `byReason=${JSON.stringify(after.detail.byReason)}`
  );

  // ── (c) the caller UA is emitted ──────────────────────────────────────────
  check(
    'ACCEPTANCE (c): the caller User-Agent is on the health surface',
    after.detail.lastUa === UA,
    `lastUa=${JSON.stringify(after.detail.lastUa)}`
  );

  const logLines = serverLog
    .join('')
    .split('\n')
    .filter((l) => l.includes('"event":"middleware_401"'));
  const parsedLines = logLines
    .map((l) => {
      const i = l.indexOf('{"event"');
      try {
        return JSON.parse(l.slice(i));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  check(
    'ACCEPTANCE (c): the structured log line carries pathname, method, reason AND ua',
    parsedLines.length >= 2 &&
      parsedLines.every(
        (l) => l.pathname === '/api/tasks' && l.method === 'POST' && l.ua === UA && l.reason
      ),
    `lines=${JSON.stringify(parsedLines.map((l) => ({ reason: l.reason, ua: l.ua, count: l.count })))}`
  );
  check(
    'the log lines carry the AUTHORITATIVE running count, and both reasons appear',
    parsedLines.some((l) => l.reason === 'missing-header') &&
      parsedLines.some((l) => l.reason === 'token-mismatch') &&
      parsedLines.every((l) => typeof l.count === 'number' && l.count > 0),
    `reasons=${parsedLines.map((l) => l.reason).join(',')} counts=${parsedLines.map((l) => l.count).join(',')}`
  );

  // ── (d) a misconfiguration 401 does NOT increment the counter ─────────────
  // The CF-Access misconfiguration 401 needs REQUIRE_CF_ACCESS=true, which is a
  // build/boot-time constant; rather than a second build, prove the equivalent
  // invariant that the counter is not "every 401": the 404 on the internal sink
  // path, and an authenticated 200, both leave the count untouched. The
  // CF-misconfiguration case itself is pinned by the unit suite
  // (tests/unit/middleware-401-telemetry.test.ts, "defect 5"), where the branch
  // is reachable.
  const beforeNoise = (await readHealthComponent()).detail.count;

  const direct = await fetch(`${BASE}/api/internal/auth-rejected`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-cc-auth-reject-reason': 'token-mismatch',
      'x-cc-auth-reject-path': '/api/forged',
    },
  });
  check(
    'the internal sink route is unreachable from outside (404), so the counter cannot be forged',
    direct.status === 404,
    `status=${direct.status}`
  );

  const authed = await fetch(`${BASE}/api/system/status`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  check('an authenticated caller is not rejected', authed.status === 200, `status=${authed.status}`);

  const afterNoise = (await readHealthComponent()).detail.count;
  check(
    'ACCEPTANCE (d): non-credential-failure traffic (forged sink hit + authed 200) did NOT increment the counter',
    afterNoise === beforeNoise,
    `count ${beforeNoise} -> ${afterNoise} (expected unchanged)`
  );

  // ── the counter is a genuine cross-runtime read, not a coincidence ────────
  const final = await readHealthComponent();
  check(
    'the component degrades while credential failures are recent (operator-visible signal)',
    final.status === 'degraded' && final.detail.recentCount > 0,
    `status=${final.status} recentCount=${final.detail.recentCount} error=${JSON.stringify(final.error)}`
  );
}

try {
  await main();
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  failures.push(`fatal: ${err.message}`);
} finally {
  if (server) server.kill('SIGTERM');
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log('');
if (failures.length > 0) {
  console.log(`RESULT: FAIL — ${failures.length} check(s) failed:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`RESULT: PASS — all ${checkNo} checks green against a real next build + next start.`);
process.exit(0);
