/**
 * U-22 (CC-045): reading the interview status must not write it.
 *
 * getInterviewState() used to backfill `clients.interview_complete = 1` on the
 * SELECTED client row whenever a filesystem signal fired and the row still said
 * 0. A GET /api/conversational-ai/status poll therefore wrote the row that the
 * viewer's cookie pointed at. These cases prove a positive filesystem signal is
 * reported to the caller and both client rows keep the value they held.
 *
 * Fixture: throwaway DATABASE_PATH (via _isolated-db) with this box's own row
 * (is_self = 1) and a second, remote row; a throwaway workspace through
 * OPENCLAW_WORKSPACE_ROOT; a throwaway cwd for company-config.json. The selected
 * client is set through Next's own request stores (cookies()), the same way
 * tests/unit/interview-gate-pre-enrollment.test.ts does it.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import type { TenantContext } from '../../src/lib/auth/tenant-context';

const require = createRequire(import.meta.url);
// Next's cookies() needs its request stores, which need AsyncLocalStorage on the
// global before next/dist is loaded.
Object.assign(globalThis, { AsyncLocalStorage });

const fixtureRoot = process.env.CC_TEST_FIXTURE_ROOT!;
const workspace = path.join(fixtureRoot, 'workspace');
const sandboxHome = path.join(fixtureRoot, 'home');
const appRoot = path.join(fixtureRoot, 'app');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(sandboxHome, { recursive: true });
fs.mkdirSync(path.join(appRoot, 'config'), { recursive: true });

Object.assign(process.env, {
  OPENCLAW_WORKSPACE_ROOT: workspace,
  HOME: sandboxHome,
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
});
delete process.env.OPENCLAW_COMPANY_ROOT;
// loadCompanyConfig() reads <cwd>/config/company-config.json; keep that inside
// the throwaway fixture root so no file in the checkout is read or written.
process.chdir(appRoot);

const workStore = require('next/dist/server/app-render/work-async-storage.external.js').workAsyncStorage;
const requestStore = require('next/dist/server/app-render/work-unit-async-storage.external.js').workUnitAsyncStorage;
const { ResponseCookies } = require('next/dist/compiled/@edge-runtime/cookies');

const ANSWERS_FILE = path.join(workspace, 'workforce-interview-answers.md');
const BUILD_STATE_FILE = path.join(workspace, '.workforce-build-state.json');
const COMPANY_CONFIG_FILE = path.join(appRoot, 'config', 'company-config.json');
const REMOTE_CLIENT_ID = 'u22-remote-client';

type StateModule = typeof import('../../src/lib/conversational-ai/interview-state');
type DbModule = typeof import('../../src/lib/db');
let getInterviewState: StateModule['getInterviewState'];
let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];
let invalidateCompanyConfigCache: () => void;
let selfClientId = '';

const tenant = (): TenantContext => ({
  tenantId: 'u22-tenant',
  companyId: 'u22-company',
  clientId: null,
  kind: 'self',
  subject: 'owner:u22',
  host: 'u22.example',
  installationId: 'u22-install',
});

/** Run `fn` with `selectedClientId` visible to the module's real cookies(). */
function withSelectedClient<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
  const jar = new ResponseCookies(new Headers());
  jar.set('selectedClientId', clientId);
  const headers = new Headers({ host: 'u22.example' });
  return workStore.run({ route: '/api/conversational-ai/status' } as never, () =>
    requestStore.run(
      {
        type: 'request',
        phase: 'action',
        headers,
        cookies: jar,
        mutableCookies: jar,
        userspaceMutableCookies: jar,
      } as never,
      fn,
    ),
  );
}

function flags(): { self: number; remote: number } {
  const db = getDb();
  const self = db.prepare('SELECT interview_complete FROM clients WHERE id = ?').get(selfClientId) as
    | { interview_complete: number }
    | undefined;
  const remote = db.prepare('SELECT interview_complete FROM clients WHERE id = ?').get(REMOTE_CLIENT_ID) as
    | { interview_complete: number }
    | undefined;
  assert.ok(self, 'self client row must exist');
  assert.ok(remote, 'remote client row must exist');
  return { self: self.interview_complete, remote: remote.interview_complete };
}

function reset() {
  for (const file of [ANSWERS_FILE, BUILD_STATE_FILE, COMPANY_CONFIG_FILE]) {
    try { fs.unlinkSync(file); } catch { /* absent */ }
  }
  invalidateCompanyConfigCache();
  const db = getDb();
  db.prepare('UPDATE clients SET interview_complete = 0').run();
}

test.before(async () => {
  const dbModule = await import('../../src/lib/db');
  getDb = dbModule.getDb;
  closeDb = dbModule.closeDb;
  const db = getDb(); // runs the full migration chain, seeding the self row

  const selfRow = db.prepare('SELECT id FROM clients WHERE is_self = 1 LIMIT 1').get() as
    | { id: string }
    | undefined;
  assert.ok(selfRow, 'migrations must seed exactly one is_self client');
  selfClientId = selfRow.id;
  db.prepare('INSERT OR REPLACE INTO clients (id, name, gateway_url, is_self, interview_complete) VALUES (?, ?, ?, 0, 0)')
    .run(REMOTE_CLIENT_ID, 'U-22 remote client', 'ws://127.0.0.1:18789');
  db.prepare('UPDATE clients SET interview_complete = 0').run();

  const configModule = await import('../../src/lib/company-config');
  invalidateCompanyConfigCache = configModule.invalidateCompanyConfigCache;

  const stateModule = await import('../../src/lib/conversational-ai/interview-state');
  getInterviewState = stateModule.getInterviewState;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

test('U-22 case 1: an answers file reports complete and writes neither row', async () => {
  reset();
  fs.writeFileSync(ANSWERS_FILE, '# AI Workforce Interview\nBusiness: Fixture Corp\n');

  const state = await withSelectedClient(REMOTE_CLIENT_ID, () => getInterviewState(tenant()));
  fs.unlinkSync(ANSWERS_FILE);

  assert.equal(state.complete, true);
  assert.equal(state.known, true);
  assert.equal(state.signal, 'interview-answers-file');
  assert.deepEqual(flags(), { self: 0, remote: 0 }, 'a status read must not write the selected row');
});

test('U-22 case 2: a company settings file with goals and a specific industry writes neither row', async () => {
  reset();
  fs.writeFileSync(
    COMPANY_CONFIG_FILE,
    JSON.stringify({
      companyName: 'Fixture Corp',
      industry: 'residential-real-estate',
      goals: ['Grow referral pipeline', 'Publish 4 market updates a month'],
      companyKPIs: [
        { id: 'pipeline', name: 'Pipeline value', target: 100000, unit: 'USD' },
      ],
    }),
  );
  invalidateCompanyConfigCache();

  const state = await withSelectedClient(REMOTE_CLIENT_ID, () => getInterviewState(tenant()));
  fs.unlinkSync(COMPANY_CONFIG_FILE);
  invalidateCompanyConfigCache();

  assert.equal(state.complete, true);
  assert.equal(state.signal, 'company-config-kpis');
  assert.deepEqual(flags(), { self: 0, remote: 0 }, 'a status read must not write the selected row');
});

test('U-22 case 3: a build-state file reporting complete writes neither row', async () => {
  reset();
  fs.writeFileSync(BUILD_STATE_FILE, JSON.stringify({ stage: 'complete', interviewComplete: true }));

  const state = await withSelectedClient(REMOTE_CLIENT_ID, () => getInterviewState(tenant()));
  fs.unlinkSync(BUILD_STATE_FILE);

  assert.equal(state.complete, true);
  assert.equal(state.signal, 'build-state-complete');
  assert.deepEqual(flags(), { self: 0, remote: 0 }, 'a status read must not write the selected row');
});

test('U-22 case 4: the own row already marked complete still takes the client-flag fast path', async () => {
  reset();
  getDb().prepare('UPDATE clients SET interview_complete = 1 WHERE id = ?').run(selfClientId);

  const state = await withSelectedClient(selfClientId, () => getInterviewState(tenant()));

  assert.equal(state.complete, true);
  assert.equal(state.signal, 'client-flag');
  assert.deepEqual(flags(), { self: 1, remote: 0 }, 'the fast path reads the flag and writes nothing');
});
