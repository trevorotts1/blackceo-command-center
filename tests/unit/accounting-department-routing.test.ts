/**
 * Bookkeeping work routes to an 'accounting' workspace instead of falling to General Task.
 *
 * The router had no profile and no seed keywords for 'accounting' (it is not in the
 * 26-department floor), and the only bookkeeping dispatch rule in the SOP seed was keyed
 * 'finance-accounting', which no 'accounting' workspace matched. Bank-feed entries, journal
 * entries, QBO cleanup, Bill.com, audits and 990s were all stamped
 * "Model pick chose General Task: the task fits no listed department".
 *
 * Real router, real department loader, offline (keyword routing only).
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = process.env.CC_TEST_FIXTURE_ROOT!;
Object.assign(process.env, {
  OPENCLAW_ROOT: path.join(root, 'openclaw'), OPENCLAW_WORKSPACE_ROOT: root, WORKSPACE_BASE_PATH: root,
  DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1', OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
  SOP_EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: '', DECISION_ENGINE_MODE: 'off',
});
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Accounting routing fixture forbids network'); };

let db: typeof import('../../src/lib/db');
let router: typeof import('../../src/lib/routing/department-router');
let config: typeof import('../../src/lib/routing/departments.config');
let slugs: typeof import('../../src/lib/routing/canonical-slug');
let profiles: typeof import('../../src/lib/routing/department-profiles');

test.before(async () => {
  db = await import('../../src/lib/db'); db.getDb();
  router = await import('../../src/lib/routing/department-router');
  config = await import('../../src/lib/routing/departments.config');
  slugs = await import('../../src/lib/routing/canonical-slug');
  profiles = await import('../../src/lib/routing/department-profiles');
  fs.mkdirSync(path.join(root, 'openclaw', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'openclaw', 'openclaw.json'), JSON.stringify({ agents: { list: [] } }));
});
test.after(() => { globalThis.fetch = oldFetch; db?.closeDb(); });

/** A department workspace (id = slug, as the seeds create them) with one live worker. */
function department(company: string, id: string, name: string) {
  const worker = `worker-${id}`;
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', [id, name, id, company]);
  db.run('INSERT INTO agents(id,name,role,workspace_id,is_master,status) VALUES(?,?,?,?,0,?)', [worker, worker, 'Specialist', id, 'standby']);
  db.run('UPDATE agents SET openclaw_agent_id=? WHERE id=?', [`rt-${worker}`, worker]);
  fs.mkdirSync(path.join(root, 'openclaw', 'agents', `rt-${worker}`), { recursive: true });
  const configPath = path.join(root, 'openclaw', 'openclaw.json');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  cfg.agents.list.push({ id: `rt-${worker}` });
  fs.writeFileSync(configPath, JSON.stringify(cfg));
  return worker;
}
function company(name: string) {
  const id = `${name}-${randomUUID()}`;
  db.run('INSERT INTO companies(id,name,slug) VALUES(?,?,?)', [id, name, id]);
  return id;
}
async function routedTo(companyId: string, title: string) {
  const decision = await router.routeTaskDecision({ title, priority: 'medium', company_id: companyId });
  assert.equal(decision.status, 'assigned', JSON.stringify(decision));
  return decision.status === 'assigned' ? decision.routing : null;
}

/** One company on the box: General Task, Accounting and Billing / Finance (workspace slugs are unique across the DB). */
let box: { company: string; general: string; accounting: string; billing: string } | undefined;
function fixture() {
  if (!box) {
    const co = company('acct-box');
    box = { company: co, general: department(co, 'general-task', 'General Task'), accounting: department(co, 'accounting', 'Accounting'), billing: department(co, 'billing-finance', 'Billing / Finance') };
  }
  return box;
}

// Each title carries two or more bookkeeping terms, so the keyword picker is confident on its own.
const KEYWORD_ROUTED_TASKS = [
  'Categorize the bank-feed entries and reconcile September',
  'Post the payroll journal entry for the 15th',
  'QBO cleanup: remove the duplicate transactions',
  'Reconcile the operating account and fix the chart of accounts',
  'Fix the QuickBooks bank feed so the journal entries stop duplicating',
];

test('bookkeeping work routes to the accounting workspace, not General Task', async () => {
  const f = fixture();
  for (const title of KEYWORD_ROUTED_TASKS) {
    const routing = await routedTo(f.company, title);
    assert.equal(routing!.agentId, f.accounting, `${title} -> ${routing!.department} (${routing!.reason})`);
  }
});

test('invoice and collections work still goes to Billing / Finance, not accounting', async () => {
  const f = fixture();
  for (const title of ['Send the invoice to the client and chase the late payment', 'Issue the refund and cancel the subscription']) {
    const routing = await routedTo(f.company, title);
    assert.equal(routing!.agentId, f.billing, `${title} -> ${routing!.department}`);
  }
});

// A title with a single bookkeeping term is not decided by keywords alone (a stray hit is not
// evidence). It reaches the model pick, which can only choose a department it is shown.
test('a single-term bookkeeping task puts Accounting, with its profile, in front of the model pick', async () => {
  const f = fixture();
  const departments = config.loadDepartments(f.company);
  for (const title of ['Approve and pay the vendor bills in Bill.com', 'Prepare the Form 990 workpapers', 'Audit of the books before the board meeting']) {
    let shown: Array<{ id: string; purpose: string }> = [];
    const tiebreak = async (req: { candidates: Array<{ id: string; purpose: string }> }) => {
      shown = req.candidates;
      const accounting = req.candidates.find((c) => c.id === 'accounting');
      return accounting ? { decided: true, departmentId: 'accounting', provenance: 'test' } : { decided: true, departmentId: 'general-task', provenance: 'test' };
    };
    const pick = await router.pickDepartment({ title }, departments, { order: [], tail: ['model'], tiebreakSeam: { companyId: f.company, model: 'm', permissionOverride: true, tiebreak } as never });
    assert.equal(pick.department?.id, 'accounting', `${title}: ${pick.note}`);
    const accounting = shown.find((c) => c.id === 'accounting')!;
    assert.match(accounting.purpose, /Typical:/);
    assert.match(accounting.purpose, /bank feed entries/i);
    assert.match(accounting.purpose, /Not /);
  }
});

/** A box whose accounting workspace uses the 'bookkeeping' spelling. */
let bookkeepingBox: { company: string; worker: string } | undefined;
function bookkeeping() {
  if (!bookkeepingBox) {
    const co = company('bookkeeping-box');
    bookkeepingBox = { company: co, worker: department(co, 'bookkeeping', 'Bookkeeping') };
  }
  return bookkeepingBox;
}

test('a workspace using a bookkeeping spelling gets the same seed and routes the same way', async () => {
  const b = bookkeeping();
  const routing = await routedTo(b.company, 'Categorize the bank feed entries and reconcile September');
  assert.equal(routing!.agentId, b.worker, routing!.reason);
});

test('the accounting profile exists under every spelling and says what it does not handle', () => {
  for (const id of ['accounting', 'bookkeeping', 'finance-accounting', 'dept-accounting']) {
    assert.equal(slugs.canonicalDeptSlug(id), 'accounting', id);
    const profile = profiles.profileFor({ id });
    assert.ok(profile, `profile for ${id}`);
    assert.ok(profile!.owns.length > 20 && profile!.not.length > 20);
  }
  assert.match(profiles.profileText({ id: 'accounting', purpose: '' } as never), /bank feed/i);
  // Invoices and collections stay a different department.
  assert.equal(slugs.canonicalDeptSlug('billing'), 'billing-finance');
  assert.equal(slugs.canonicalDeptSlug('billing-finance'), 'billing-finance');
});

test('the 26-department floor and canonical set are unchanged', () => {
  assert.equal(config.DEFAULT_DEPARTMENTS.length, 26);
  assert.ok(!config.DEFAULT_DEPARTMENTS.some((d) => d.id === 'accounting'));
  assert.ok(!slugs.CANONICAL_SLUGS.has('accounting'));
});

test("the 'finance-accounting' dispatch rule applies to accounting spellings, and only those", () => {
  const b = bookkeeping();
  const other = company('rule-box');
  db.run('INSERT INTO workspaces(id,name,slug,company_id) VALUES(?,?,?,?)', ['web-development', 'Web Development', 'web-development', other]);
  const ruleIds = [randomUUID(), randomUUID()];
  try {
    db.run('INSERT INTO dispatch_rules(id,department_slug,task_keywords,priority) VALUES(?,?,?,?)', [ruleIds[0], 'finance-accounting', 'zebra crossing', 9]);
    db.run('INSERT INTO dispatch_rules(id,department_slug,task_keywords,priority) VALUES(?,?,?,?)', [ruleIds[1], 'webdev', 'zebra crossing', 9]);
    const accounting = config.loadDepartments(b.company).find((d) => d.id === 'bookkeeping')!;
    assert.deepEqual(accounting.keywords, ['zebra crossing'], 'the rule keyed finance-accounting reaches the bookkeeping workspace');
    assert.equal(accounting.priority, 9);
    const web = config.loadDepartments(other).find((d) => d.id === 'web-development')!;
    assert.ok(!web.keywords.includes('zebra crossing'), "a legacy 'webdev' rule is not switched on for other departments");
  } finally {
    for (const id of ruleIds) db.run('DELETE FROM dispatch_rules WHERE id=?', [id]);
  }
});
