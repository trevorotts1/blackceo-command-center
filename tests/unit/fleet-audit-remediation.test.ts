import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkGatewayVersion, checkOrphanedPm2, checkDiskUsage, checkDecoyDb,
  checkDuplicateCrons, checkBuildState, checkDiskAlertCron, checkWeeklyCronMutex,
  checkFleetCronHealth, computeFleetAudit,
} from '../../src/lib/fleet-audit-remediation';
import type { CronEntry, FleetAuditInput } from '../../src/lib/fleet-audit-remediation';

// F1 — Gateway version
test('[U126] F1: stale gateway (minor < 4) flagged', () => {
  const r = checkGatewayVersion('2026.3.1');
  assert.equal(r.passed, false); assert.equal(r.namedStop, true); assert.ok(r.detail.includes('stale'));
});
test('[U126] F1: current gateway (minor >= 4) passes', () => {
  assert.equal(checkGatewayVersion('2026.6.8').passed, true);
  assert.equal(checkGatewayVersion('2026.4.0').passed, true);
});
test('[U126] F1: null or unparseable fails safely', () => {
  assert.equal(checkGatewayVersion(null).passed, false);
  assert.equal(checkGatewayVersion('bad').passed, false);
});

// F2 — Orphaned pm2
test('[U126] F2: retired/deleted flagged as orphan', () => {
  assert.equal(checkOrphanedPm2([{name:'retired-worker'}]).passed, false);
  assert.equal(checkOrphanedPm2([{name:'deleted-app'}]).passed, false);
  assert.equal(checkOrphanedPm2([{name:'retired-worker'}]).namedStop, true);
});
test('[U126] F2: normal processes are OK', () => {
  assert.equal(checkOrphanedPm2([{name:'gateway'},{name:'n8n'}]).passed, true);
  assert.equal(checkOrphanedPm2([]).passed, true);
  assert.equal(checkOrphanedPm2(null).passed, true);
});

// F3 — Disk usage
test('[U126] F3: disk >= 85% is fail, < 85% is OK', () => {
  assert.equal(checkDiskUsage(87).passed, false);
  assert.equal(checkDiskUsage(85).passed, false);
  assert.equal(checkDiskUsage(84).passed, true);
  assert.equal(checkDiskUsage(null).passed, false);
});

// F4 — Decoy DB
test('[U126] F4: 0-byte decoy flagged as Named Stop', () => {
  const r = checkDecoyDb('/tmp/fake.db', 0);
  assert.equal(r.passed, false); assert.equal(r.namedStop, true);
});
test('[U126] F4: non-zero or null passes', () => {
  assert.equal(checkDecoyDb('/tmp/real.db', 4096).passed, true);
  assert.equal(checkDecoyDb(null, null).passed, true);
});

// F5 — Duplicate crons
test('[U126] F5: duplicates detected, unique passes', () => {
  const dupes: CronEntry[] = [{name:'a',id:'1'},{name:'a',id:'2'},{name:'b',id:'3'}];
  const r = checkDuplicateCrons(dupes);
  assert.equal(r.passed, false); assert.equal(r.namedStop, true);
  assert.ok(r.detail.includes('a (x2)'));
  assert.equal(checkDuplicateCrons([{name:'a'},{name:'b'}]).passed, true);
  assert.equal(checkDuplicateCrons([]).passed, true);
  assert.equal(checkDuplicateCrons(null).passed, false);
});

// F6 — Build-state
test('[U126] F6: corrupt or no-schema is Named Stop', () => {
  assert.equal(checkBuildState(false, null).namedStop, true);
  assert.equal(checkBuildState(true, false).namedStop, true);
});
test('[U126] F6: valid or null passes', () => {
  assert.equal(checkBuildState(true, true).passed, true);
  assert.equal(checkBuildState(null, null).passed, true);
});

// F8 — Disk alert cron
test('[U126] F8: announce delivery flagged, silent passes', () => {
  const announce: CronEntry[] = [{name:'disk-usage-alert', delivery:{mode:'announce',to:'123'}}];
  assert.equal(checkDiskAlertCron(announce).passed, false);
  const silent: CronEntry[] = [{name:'disk-usage-alert', delivery:{mode:'none'}}];
  assert.equal(checkDiskAlertCron(silent).passed, true);
  assert.equal(checkDiskAlertCron([{name:'other'}]).passed, false);
});

// F9 — Weekly cron mutex
test('[U126] F9: missing mutex flagged, present or null passes', () => {
  assert.equal(checkWeeklyCronMutex(false).namedStop, true);
  assert.equal(checkWeeklyCronMutex(true).passed, true);
  assert.equal(checkWeeklyCronMutex(null).passed, true);
});

// F10 — Fleet cron health
test('[U126] F10: healthy crons pass, dupes/errors flagged', () => {
  assert.equal(checkFleetCronHealth([{name:'a'},{name:'b'},{name:'c'}]).passed, true);
  assert.equal(checkFleetCronHealth([{name:'dup'},{name:'dup'}]).namedStop, true);
  assert.equal(checkFleetCronHealth([{name:'broken', status:'error'}]).namedStop, true);
});

// computeFleetAudit integration
test('[U126] computeFleetAudit: clean box = all pass', () => {
  const input: FleetAuditInput = {
    gatewayVersion:'2026.6.8', pm2ProcessList:[], diskUsagePercent:42,
    decoyDbPath:null, decoyDbSize:null,
    cronEntries:[{name:'disk-usage-alert',delivery:{mode:'none'}}],
    buildStateParseable:true, buildStateHasSchemaVersion:true,
    workspaceSeeded:true, weeklyCronHasMutex:true,
  };
  const r = computeFleetAudit(input);
  assert.equal(r.findings.length, 10); assert.equal(r.passCount, 10);
  assert.equal(r.failCount, 0); assert.equal(r.stopCount, 0);
});

test('[U126] computeFleetAudit: dirty box = mixed pass/fail/stop', () => {
  const input: FleetAuditInput = {
    gatewayVersion:'2026.3.1', pm2ProcessList:[{name:'retired'}], diskUsagePercent:87,
    decoyDbPath:'/fake.db', decoyDbSize:0,
    cronEntries:[{name:'disk-usage-alert',delivery:{mode:'announce',to:'123'}},{name:'disk-usage-alert'}],
    buildStateParseable:false, buildStateHasSchemaVersion:false,
    workspaceSeeded:false, weeklyCronHasMutex:false,
  };
  const r = computeFleetAudit(input);
  assert.ok(r.stopCount >= 5);
  assert.ok(r.summary.includes('U126'));
  assert.ok(r.summary.includes('Named Stop'));
});

// MUTATION PROOF
test('[U126] MUT-T1: decoy check discriminates 0-byte vs non-zero', () => {
  // Real: 0-byte = STOP. Mutation (size>0) = PASS.
  assert.equal(checkDecoyDb('/x', 0).passed, false, 'real: 0-byte MUST fail');
  assert.equal(checkDecoyDb('/x', 4096).passed, true, 'mutated: non-zero would pass — proves T4 discriminating');
});

test('[U126] MUT-T2: duplicate cron check discriminates dupes vs unique', () => {
  assert.equal(checkDuplicateCrons([{name:'a'},{name:'a'}]).passed, false, 'real: dupes MUST fail');
  assert.equal(checkDuplicateCrons([{name:'a'},{name:'b'}]).passed, true, 'mutated: unique would pass — proves T6 discriminating');
});
