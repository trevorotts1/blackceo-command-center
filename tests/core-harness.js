'use strict';
/**
 * tests/core-harness.js: Item 26 ingestion-core acceptance harness.
 *
 * Exercises the DELIVERED src/lib/skill71-runs.ts (compiled to JS)
 * against the five-run fixtures in tests/fixtures/skill71-runs/ and
 * asserts the amended Item 26 acceptance behavior: dedupe by event_id,
 * idempotent re-import, blocked stage named with its failure lines,
 * SELF-REVIEWED and UNKNOWN runs flagged, per-client isolation, cost
 * aggregation, ingest-token binding, payload-rule rejection.
 *
 * How it was run for this build (the CC app itself is not installed in
 * the build sandbox):
 *   1. Compile src/lib/skill71-runs.ts with tsc (strict) together with
 *      a test-only @/lib/db shim backed by node:sqlite that exposes the
 *      same queryAll/queryOne/run/transaction surface as
 *      src/lib/db/index.ts. The shim is scaffolding, not product code.
 *   2. Create the four tables with the exact DDL from DB-CHANGES.md.
 *   3. Run: SKILL71_CORE_JS=<compiled skill71-runs.js> \
 *           SKILL71_DB_JS=<compiled shim> \
 *           node tests/core-harness.js
 * In the real repo, the same assertions belong in the CC test suite
 * against the real db layer; the core's behavior is identical because
 * it only touches the database through those four helpers.
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CORE_JS = process.env.SKILL71_CORE_JS;
const DB_JS = process.env.SKILL71_DB_JS;
if (!CORE_JS || !DB_JS) {
  console.error('set SKILL71_CORE_JS and SKILL71_DB_JS (see header)');
  process.exit(2);
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@/lib/db') return DB_JS;
  return origResolve.call(this, request, ...rest);
};

const DB_PATH = process.env.SKILL71_TEST_DB || '/tmp/skill71-core-harness.db';
process.env.SKILL71_TEST_DB = DB_PATH;
fs.rmSync(DB_PATH, { force: true });

const { DatabaseSync } = require('node:sqlite');
const setup = new DatabaseSync(DB_PATH);
setup.exec(`
CREATE TABLE skill71_runs (
  run_id TEXT PRIMARY KEY, page_name TEXT, brand_id TEXT, client TEXT,
  client_slug TEXT, host_shape TEXT, run_dir TEXT,
  test_run INTEGER NOT NULL DEFAULT 0, overall TEXT NOT NULL DEFAULT 'incomplete',
  review_mode TEXT, report_json_path TEXT, report_md_path TEXT, blocked_stage TEXT,
  started_at TEXT, last_event_at TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE skill71_run_stages (
  run_id TEXT NOT NULL REFERENCES skill71_runs(run_id) ON DELETE CASCADE,
  stage TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', receipt_status TEXT,
  closed_at TEXT, duration_s REAL, scores_summary_json TEXT, cost_json TEXT,
  artifact_hashes_json TEXT, failures_json TEXT,
  items_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, stage)
);
CREATE TABLE skill71_run_events (
  event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, event_type TEXT NOT NULL,
  emitted_at TEXT NOT NULL, source TEXT NOT NULL, payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE skill71_ingest_tokens (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, client_slug TEXT NOT NULL,
  host_shape TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), revoked_at TEXT
);
`);
setup.close();

const core = require(CORE_JS);
const FX = path.join(__dirname, 'fixtures', 'skill71-runs');

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ok - ${label}`); }
  else { failures += 1; console.log(`  FAIL - ${label}`); }
}

function importFile(file) {
  const counts = { read: 0, inserted: 0, duplicates: 0, rejected: 0 };
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    counts.read += 1;
    const v = core.validateSkill71Event(JSON.parse(line));
    if (!v.ok) { counts.rejected += 1; continue; }
    const out = core.ingestSkill71Event(v.event, { source: `file:${file}` });
    counts[out.status === 'inserted' ? 'inserted' : 'duplicates'] += 1;
  }
  return counts;
}

console.log('import client-a (runs 1-3):');
let c = importFile(path.join(FX, 'client-a/runs.jsonl'));
assert(c.read === 29 && c.inserted === 29 && c.duplicates === 0 && c.rejected === 0, JSON.stringify(c));

console.log('import pushed-hostinger (run 4, one duplicated line):');
c = importFile(path.join(FX, 'pushed-hostinger.jsonl'));
assert(c.read === 5 && c.inserted === 4 && c.duplicates === 1 && c.rejected === 0, JSON.stringify(c));

console.log('import client-b (run 5):');
c = importFile(path.join(FX, 'client-b/runs.jsonl'));
assert(c.read === 3 && c.inserted === 3, JSON.stringify(c));

const all = core.listSkill71Runs({});
assert(all.total === 5, `five runs listed (got ${all.total})`);

const byClient = core.listSkill71Runs({ client_slug: 'client-a' });
assert(byClient.total === 3, 'client-a filter shows exactly its 3 runs');
const clientBIds = new Set(core.listSkill71Runs({ client_slug: 'client-b' }).runs.map(r => r.run_id));
assert(clientBIds.size === 1 && !byClient.runs.some(r => clientBIds.has(r.run_id)),
  "client B's run never surfaces under client A");

const complete = all.runs.find(r => r.overall === 'complete');
assert(complete && complete.stages_closed === 13, 'complete run shows 13/13 stages');
assert(complete && complete.review_flag === null, 'independent run carries no review flag');
assert(complete && complete.cost_by_provider.kie === 42, 'cost aggregated by provider (kie 42)');

const testRun = all.runs.find(r => r.overall === 'test-run');
assert(testRun && testRun.review_flag === 'SELF-REVIEWED', 'self-reviewed test run is flagged');
assert(testRun && testRun.test_run === 1, 'test run marked');

const unknown = all.runs.find(r => r.client_slug === 'client-b');
assert(unknown && unknown.review_flag === 'UNKNOWN', 'UNKNOWN review mode is flagged');
assert(unknown && unknown.review_mode === 'UNKNOWN', 'review mode recorded');

const blockedDetail = core.getSkill71Run(
  all.runs.find(r => r.page_name === 'Blocked Page').run_id);
assert(blockedDetail.run.blocked_stage === 'image-generation-qc', 'blocked stage named on the run');
const blockedStage = blockedDetail.stages.find(s => s.stage === 'image-generation-qc');
assert(blockedStage.status === 'blocked' && blockedStage.failures.length === 1,
  'blocked stage row carries the gate failure line');
assert(blockedDetail.stages.length === 13, 'detail returns all 13 stages in contract order');

console.log('re-import everything (idempotency):');
c = importFile(path.join(FX, 'client-a/runs.jsonl'));
assert(c.inserted === 0 && c.duplicates === 29, `second import inserts nothing (${JSON.stringify(c)})`);
assert(core.listSkill71Runs({}).total === 5, 'still five runs after re-import');

console.log('ingest token binding:');
const hash = crypto.createHash('sha256').update('tok-value').digest('hex');
const db = new DatabaseSync(DB_PATH);
db.prepare('INSERT INTO skill71_ingest_tokens (id, token_hash, client_slug, host_shape) VALUES (?,?,?,?)')
  .run('t1', hash, 'client-c', 'fleet-hostinger');
db.close();
const binding = core.verifySkill71IngestToken('tok-value');
assert(binding && binding.client_slug === 'client-c' && binding.host_shape === 'fleet-hostinger',
  'token verifies to its client binding');
assert(core.verifySkill71IngestToken('wrong') === null, 'wrong token rejected');
const pushed = JSON.parse(fs.readFileSync(path.join(FX, 'pushed-hostinger.jsonl'), 'utf-8').split('\n')[0]);
const v = core.validateSkill71Event(pushed);
assert(v.ok && core.eventContradictsToken(v.event, binding) === null, 'bound events pass the binding check');
const foreign = { ...v.event, client_slug: 'someone-else' };
assert(typeof core.eventContradictsToken(foreign, binding) === 'string',
  'an event claiming another client is contradicted by the token');

console.log('schema violations rejected by the core validator:');
const noId = { ...v.event }; delete noId.event_id;
assert(!core.validateSkill71Event(noId).ok, 'missing event_id rejected');
const secret = { ...v.event, api_key: 'should-never-appear' };
assert(!core.validateSkill71Event(secret).ok, 'unknown field (payload-rule violation) rejected');

if (failures > 0) { console.log(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nPASS: ingestion core satisfies the amended Item 26 acceptance behavior');
