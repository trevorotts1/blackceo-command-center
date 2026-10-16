import { test, expect, type BrowserContext } from 'playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

// Regression: failed interview state load must not hide durable owner declaration.
// Only GET state is fault-injected. Authentication, declaration, SQLite and gate stay real.
test('failed state load permits declaration that survives fresh browser and server restart', async ({ browser }, testInfo) => {
  test.setTimeout(900_000);
  const production = process.env.INTERVIEW_LOCK_PRODUCTION === '1';
  const buffered = process.env.PRIOR_COMPLETION_BUFFER_STATIC === '1';
  const root = path.resolve(__dirname, '../..');
  const out = path.join(root, 'test-results/prior-completion-proof', String(Date.now()));
  fs.mkdirSync(out, { recursive: true });
  const cwd = process.cwd();
  process.env.INTERVIEW_LOCK_PORT = '4137';
  let fixture: typeof import('./interview-lock.fixture');
  try {
    process.chdir(out);
    fixture = await import('./interview-lock.fixture');
  } finally { process.chdir(cwd); }
  const env = { ...process.env, ...fixture.serverEnv(), NEXT_DIST_DIR: '.next-prior-completion-proof' };
  const baseURL = fixture.BASE_URL;
  const stateBefore = fs.readFileSync(fixture.BUILD_STATE_PATH, 'utf8');
  let server: ChildProcess | undefined;
  const logPath = path.join(out, 'server.log');
  const log = fs.openSync(logPath, 'a');
  const contexts: BrowserContext[] = [];
  const evidence: Record<string, unknown> = { baseURL, database: fixture.DB_PATH, serverLog: logPath };

  async function start() {
    server = spawn(process.execPath, production ? ['tests/integration/interview-lock.production-server.mjs'] : ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '4137'], {
      cwd: root, env, detached: true, stdio: ['ignore', log, log],
    });
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Next exited ${server.exitCode}; log ${logPath}`);
      try {
        const response = await fetch(`${production ? 'http://localhost:4138' : baseURL}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (response.ok) return server.pid;
      } catch { /* Server compiling; bounded readiness loop. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Server readiness timed out; log ${logPath}`);
  }
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const exited = once(server, 'exit');
    process.kill(-server.pid!, 'SIGTERM');
    await exited;
  }
  async function signedIn() {
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: production });
    contexts.push(context);
    // Buffer origin bytes only; never alter application scripts or application requests.
    if (buffered) await context.route('**/_next/static/**', async route => {
      const response = await fetch(route.request().url(), { headers: { 'Accept-Encoding': 'identity' } });
      const body = Buffer.from(await response.arrayBuffer());
      await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') || 'application/octet-stream', body });
    });
    const denied = await context.request.get('/api/interview/gate-status');
    expect([401, 403]).toContain(denied.status());
    const enrolled = await context.request.post('/api/auth/interview-session', { data: { ticket: fixture.signFixtureTenantGrant('enrollment') } });
    expect(enrolled.status(), await enrolled.text()).toBe(200);
    const cookies = await context.cookies();
    expect(cookies.some(cookie => cookie.name === 'mc_tenant_session' && cookie.httpOnly)).toBe(true);
    expect(cookies.some(cookie => cookie.name === fixture.INTERVIEW_COOKIE_NAME)).toBe(false);
    return context;
  }
  function rows() {
    const db = new Database(fixture.DB_PATH, { readonly: true });
    try { return db.prepare('SELECT * FROM interview_prior_completion_declarations').all(); }
    finally { db.close(); }
  }
  async function unlocked(context: BrowserContext) {
    const status = await context.request.get('/api/interview/gate-status');
    expect(status.status()).toBe(200);
    expect(await status.json()).toMatchObject({ priorCompletionDeclared: true });
    const page = await context.newPage();
    const response = await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(`${baseURL}/`);
    await expect(page.locator('body')).not.toBeEmpty();
    await page.screenshot({ path: path.join(out, `unlocked-${contexts.length}.png`), fullPage: true });
  }

  try {
    evidence.production = production;
    evidence.bufferedStaticDiagnostic = buffered;
    if (production) {
      const build = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'build', '--webpack'], { cwd: root, env, stdio: ['ignore', log, log] });
      const [code] = await once(build, 'exit');
      expect(code, `Production build failed; see ${logPath}`).toBe(0);
    }
    evidence.initialServerPid = await start();
    const context = await signedIn();
    expect(rows()).toHaveLength(0);
    const page = await context.newPage();
    const errors: unknown[] = [];
    evidence.browserErrors = errors;
    page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack }));
    page.on('response', async response => {
      if (!response.url().includes('/_next/static/chunks/app/layout.js')) return;
      const body = await response.body();
      evidence.layoutResponse = { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), headers: response.headers() };
      fs.writeFileSync(path.join(out, 'layout-response.js'), body);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Runtime.enable');
    await cdp.send('Debugger.enable');
    await cdp.send('Network.enable');
    const layoutRequests = new Set<string>();
    cdp.on('Network.responseReceived', event => {
      if (event.response.url.includes('/_next/static/chunks/app/layout.js')) layoutRequests.add(event.requestId);
    });
    cdp.on('Network.loadingFinished', async event => {
      if (!layoutRequests.has(event.requestId)) return;
      const result = await cdp.send('Network.getResponseBody', { requestId: event.requestId });
      const body = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
      evidence.layoutNetworkBody = { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), encodedDataLength: event.encodedDataLength };
    });
    cdp.on('Debugger.scriptFailedToParse', async event => {
      const source = await cdp.send('Debugger.getScriptSource', { scriptId: event.scriptId });
      const file = path.join(out, `rejected-script-${event.scriptId}.js`);
      fs.writeFileSync(file, source.scriptSource);
      errors.push({ rejectedScript: file, url: event.url, startLine: event.startLine });
    });
    cdp.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails));
    await page.addInitScript(() => window.addEventListener('error', event => console.error('BROWSER_SCRIPT_ERROR', event.filename, event.lineno, event.colno, event.message)));
    let failedReads = 0;
    await page.route('**/api/interview/state*', async route => {
      if (route.request().method() === 'GET') {
        failedReads++;
        evidence.failedStateReads = failedReads;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'forced state read failure' }) });
      } else await route.continue();
    });
    await page.goto(`${baseURL}/interview`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Check your access' })).toBeVisible();
    expect(failedReads).toBeGreaterThan(0);
    const declare = page.getByRole('button', { name: 'I have already completed the interview', exact: true });
    await expect(declare).toBeVisible();
    await page.screenshot({ path: path.join(out, 'failed-state-declaration-visible.png'), fullPage: true });
    const posted = page.waitForResponse(response => response.url().endsWith('/api/interview/prior-completion') && response.request().method() === 'POST');
    await declare.click();
    const declaration = await posted;
    expect(declaration.status()).toBe(200);
    evidence.declarationPostStatus = declaration.status();
    await expect(page).toHaveURL(`${baseURL}/`);
    const saved = rows();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ tenant_id: 'interview-lock-tenant', company_id: 'default', installation_id: 'interview-lock-install', declared_by: 'owner:fixture', source: 'owner-self-attestation' });
    expect(fs.readFileSync(fixture.BUILD_STATE_PATH, 'utf8')).toBe(stateBefore);
    evidence.failedStateReads = failedReads;
    evidence.declaration = saved[0];
    await context.close();
    await unlocked(await signedIn());
    evidence.freshBrowserUnlocked = true;
    await stop();
    evidence.restartedServerPid = await start();
    expect(evidence.restartedServerPid).not.toBe(evidence.initialServerPid);
    expect(rows()).toEqual(saved);
    await unlocked(await signedIn());
    expect(fs.readFileSync(fixture.BUILD_STATE_PATH, 'utf8')).toBe(stateBefore);
    evidence.restartAndFreshBrowserUnlocked = true;
    evidence.result = 'PASS';
  } catch (error) {
    evidence.result = 'FAIL';
    evidence.error = String(error);
    throw error;
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await stop();
    fs.closeSync(log);
    const evidencePath = path.join(out, 'evidence.json');
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(`Browser proof evidence: ${evidencePath}`);
    await testInfo.attach('evidence', { path: evidencePath, contentType: 'application/json' });
  }
});
