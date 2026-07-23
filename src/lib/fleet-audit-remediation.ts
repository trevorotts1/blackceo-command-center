/**
 * fleet-audit-remediation.ts — U126 Fleet Audit Remediation (30-box Maria check)
 * Decision logic for the 10 findings from the 30-box fleet audit.
 * Pure logic only (no fs/network I/O) — unit-testable without a real box.
 *
 * FINDINGS: F1 gateway, F2 pm2, F3 disk, F4 decoy DB, F5 dup crons,
 *           F6 build-state, F7 workspace, F8 disk-alert cron, F9 mutex, F10 fleet cron health.
 * NEVER throws — degrades to safe result rather than raising.
 */
export interface CronEntry {
  name: string; id?: string;
  delivery?: { mode?: string; channel?: string; to?: string };
  status?: string; schedule?: { expr?: string };
}
export interface FleetAuditInput {
  gatewayVersion: string | null;
  pm2ProcessList: Array<{ name: string; pid?: number; pm2_env?: { status?: string } }> | null;
  diskUsagePercent: number | null;
  decoyDbPath: string | null;
  decoyDbSize: number | null;
  cronEntries: CronEntry[] | null;
  buildStateParseable: boolean | null;
  buildStateHasSchemaVersion: boolean | null;
  workspaceSeeded: boolean | null;
  weeklyCronHasMutex: boolean | null;
}
export interface FindingResult {
  finding: string; label: string; passed: boolean; namedStop: boolean; detail: string;
}
export interface FleetAuditResult {
  findings: FindingResult[]; passCount: number; failCount: number; stopCount: number; summary: string;
}

const MIN_GATEWAY_MINOR = 4;

export function checkGatewayVersion(v: string | null): FindingResult {
  if (!v) return { finding:'F1', label:'Gateway version', passed:false, namedStop:false, detail:'openclaw CLI not found' };
  const m = v.match(/^(\d{4})\.(\d+)\.(\d+)/);
  if (!m) return { finding:'F1', label:'Gateway version', passed:false, namedStop:false, detail:`unparseable: "${v}"` };
  const minor = Number(m[2]);
  if (minor < MIN_GATEWAY_MINOR) return { finding:'F1', label:'Gateway version', passed:false, namedStop:true, detail:`stale ${v} (minor ${minor} < ${MIN_GATEWAY_MINOR}). Run: npm update -g openclaw && openclaw gateway restart` };
  return { finding:'F1', label:'Gateway version', passed:true, namedStop:false, detail:`${v} current (minor ${minor} >= ${MIN_GATEWAY_MINOR})` };
}

export function checkOrphanedPm2(procs: Array<{ name: string }> | null): FindingResult {
  if (procs === null) return { finding:'F2', label:'Orphaned pm2', passed:true, namedStop:false, detail:'pm2 not installed — skip' };
  const orphans = procs.filter(p => { const n = (p.name||'').toLowerCase(); return n.includes('retired')||n.includes('deleted'); });
  if (orphans.length > 0) return { finding:'F2', label:'Orphaned pm2', passed:false, namedStop:true, detail:`${orphans.length} orphaned: ${orphans.map(p=>p.name).join(', ')}. pm2 delete <name>` };
  return { finding:'F2', label:'Orphaned pm2', passed:true, namedStop:false, detail:'no orphaned pm2 processes' };
}

export function checkDiskUsage(pct: number | null): FindingResult {
  if (pct === null) return { finding:'F3', label:'Disk usage', passed:false, namedStop:false, detail:'could not read disk usage' };
  if (pct >= 85) return { finding:'F3', label:'Disk usage', passed:false, namedStop:false, detail:`disk ${pct}% >= 85%. Free space needed.` };
  return { finding:'F3', label:'Disk usage', passed:true, namedStop:false, detail:`disk ${pct}% OK` };
}

export function checkDecoyDb(path: string | null, size: number | null): FindingResult {
  if (path === null) return { finding:'F4', label:'Decoy DB', passed:true, namedStop:false, detail:'no mission-control.db found' };
  if (size !== null && size > 0) return { finding:'F4', label:'Decoy DB', passed:true, namedStop:false, detail:`non-zero (${size}b) — real DB` };
  return { finding:'F4', label:'Decoy DB', passed:false, namedStop:true, detail:`0-byte decoy at "${path}". Run --apply to remove.` };
}

export function checkDuplicateCrons(crons: CronEntry[] | null): FindingResult {
  if (crons === null) return { finding:'F5', label:'Duplicate crons', passed:false, namedStop:false, detail:'openclaw CLI not found' };
  const m = new Map<string,number>(); for (const c of crons) { if (c.name) m.set(c.name,(m.get(c.name)||0)+1); }
  const dupes = [...m.entries()].filter(([,c])=>c>1);
  if (dupes.length) return { finding:'F5', label:'Duplicate crons', passed:false, namedStop:true, detail:`${dupes.length} duplicate(s): ${dupes.map(([n,c])=>`${n} (x${c})`).join(', ')}` };
  return { finding:'F5', label:'Duplicate crons', passed:true, namedStop:false, detail:`no duplicates among ${crons.length} entries` };
}

export function checkBuildState(parseable: boolean | null, hasSchema: boolean | null): FindingResult {
  if (parseable === null) return { finding:'F6', label:'Build-state', passed:true, namedStop:false, detail:'no state file — fresh box' };
  if (!parseable) return { finding:'F6', label:'Build-state', passed:false, namedStop:true, detail:'CORRUPTED (interrupted interview). Backup then --apply to rebuild.' };
  if (!hasSchema) return { finding:'F6', label:'Build-state', passed:false, namedStop:true, detail:'valid JSON, no schemaVersion. Run --apply to add.' };
  return { finding:'F6', label:'Build-state', passed:true, namedStop:false, detail:'valid with schemaVersion' };
}

export function checkWorkspaceSeeding(seeded: boolean | null): FindingResult {
  if (seeded === null) return { finding:'F7', label:'Workspace seeding', passed:false, namedStop:false, detail:'undetermined' };
  if (seeded) return { finding:'F7', label:'Workspace seeding', passed:true, namedStop:false, detail:'already seeded' };
  return { finding:'F7', label:'Workspace seeding', passed:false, namedStop:true, detail:'NOT seeded. Migration #17/#112 needed. Operator approval required.' };
}

export function checkDiskAlertCron(crons: CronEntry[] | null): FindingResult {
  if (crons === null) return { finding:'F8', label:'Disk alert cron', passed:false, namedStop:false, detail:'openclaw CLI not found' };
  const a = crons.find(c=>c.name==='disk-usage-alert');
  if (!a) return { finding:'F8', label:'Disk alert cron', passed:false, namedStop:false, detail:'cron NOT registered' };
  const mode = a.delivery?.mode || ''; const to = a.delivery?.to || '';
  if (mode === 'announce' || to) return { finding:'F8', label:'Disk alert cron', passed:false, namedStop:true, detail:`announcing (mode=${mode}, to=${to}). Should be silent.` };
  return { finding:'F8', label:'Disk alert cron', passed:true, namedStop:false, detail:'silent command-mode (correct)' };
}

export function checkWeeklyCronMutex(hasMutex: boolean | null): FindingResult {
  if (hasMutex === null) return { finding:'F9', label:'Weekly cron mutex', passed:true, namedStop:false, detail:'Skill 35 not installed — skip' };
  if (hasMutex) return { finding:'F9', label:'Weekly cron mutex', passed:true, namedStop:false, detail:'mutex already present' };
  return { finding:'F9', label:'Weekly cron mutex', passed:false, namedStop:true, detail:'no concurrency-safe mutex. Run --apply to inject flock guard.' };
}

export function checkFleetCronHealth(crons: CronEntry[] | null): FindingResult {
  if (crons === null) return { finding:'F10', label:'Fleet cron health', passed:false, namedStop:false, detail:'openclaw CLI not found' };
  const total = crons.length;
  const m = new Map<string,number>(); for (const c of crons) { if (c.name) m.set(c.name,(m.get(c.name)||0)+1); }
  const dupes = [...m.entries()].filter(([,c])=>c>1);
  const errors = crons.filter(c=>(c.status||'').toLowerCase()==='error');
  if (dupes.length) return { finding:'F10', label:'Fleet cron health', passed:false, namedStop:true, detail:`${total} crons, ${dupes.length} dupes, ${errors.length} errors` };
  if (errors.length) return { finding:'F10', label:'Fleet cron health', passed:false, namedStop:true, detail:`${total} crons, 0 dupes, ${errors.length} errors` };
  return { finding:'F10', label:'Fleet cron health', passed:true, namedStop:false, detail:`all ${total} crons healthy` };
}

export function computeFleetAudit(input: FleetAuditInput): FleetAuditResult {
  const findings: FindingResult[] = [
    checkGatewayVersion(input.gatewayVersion), checkOrphanedPm2(input.pm2ProcessList),
    checkDiskUsage(input.diskUsagePercent), checkDecoyDb(input.decoyDbPath, input.decoyDbSize),
    checkDuplicateCrons(input.cronEntries), checkBuildState(input.buildStateParseable, input.buildStateHasSchemaVersion),
    checkWorkspaceSeeding(input.workspaceSeeded), checkDiskAlertCron(input.cronEntries),
    checkWeeklyCronMutex(input.weeklyCronHasMutex), checkFleetCronHealth(input.cronEntries),
  ];
  const passCount = findings.filter(f=>f.passed).length;
  const failCount = findings.filter(f=>!f.passed&&!f.namedStop).length;
  const stopCount = findings.filter(f=>f.namedStop).length;
  const lines = ['Fleet Audit — U126 (30-box Maria check)', `  PASS: ${passCount}  FAIL: ${failCount}  NAMED STOP: ${stopCount}`];
  for (const f of findings) { const s = f.passed?'OK   ':f.namedStop?'STOP ':'FAIL '; lines.push(`  [${s}] ${f.label}: ${f.detail}`); }
  if (stopCount) lines.push('  Named Stops: F1 (gateway), F2 (pm2), F6 (build-state), F7 (seeding)');
  return { findings, passCount, failCount, stopCount, summary: lines.join('\n') };
}
