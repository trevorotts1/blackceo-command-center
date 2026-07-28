import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { canonicalDeptSlug, canonicalDeptFromAnyLabel, CANONICAL_SLUGS } from '@/lib/routing/canonical-slug';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('canonicalDeptFromAnyLabel', () => {
  const EXCEPTIONS = new Set(['anthology']);
  const LIVE_VALUES = ['Anthology', 'Communications', 'Marketing', 'OpenClaw Maintenance', 'Presentations', 'Web Development', 'communications', 'crm', 'general-task'];

  it('lands every live department value in CANONICAL_SLUGS or the named exception array', () => {
    let good = 0; const bad = [];
    for (const v of LIVE_VALUES) {
      const out = canonicalDeptFromAnyLabel(v);
      const ok = CANONICAL_SLUGS.has(out) || EXCEPTIONS.has(out);
      if (!ok) bad.push(v + ' -> ' + out); else good++;
    }
    console.log('live values: in CANONICAL_SLUGS (or exceptions)=', good, 'NOT=', bad.length, 'total=', LIVE_VALUES.length);
    if (bad.length > 0) console.log('NOT canonical:', bad);
    expect(bad).toEqual([]);
    expect(good).toEqual(LIVE_VALUES.length);
  });
  it('alias map fires after slugification (CEO / COM -> master-orchestrator)', () => { expect(canonicalDeptFromAnyLabel('CEO / COM')).toBe('master-orchestrator'); });
  it('slugifies display name with spaces (Web Development -> web-development)', () => { expect(canonicalDeptFromAnyLabel('Web Development')).toBe('web-development'); });
  it('strips dept- prefix (dept-presentations -> presentations)', () => { expect(canonicalDeptFromAnyLabel('dept-presentations')).toBe('presentations'); });
  it('is ADDITIVE: for every canonical slug, result equals canonicalDeptSlug', () => {
    const drift = [];
    for (const s of CANONICAL_SLUGS) { const w=canonicalDeptFromAnyLabel(s); const d=canonicalDeptSlug(s); if (w!==d) drift.push(s+' -> '+w+' '+d); }
    console.log('ADDITIVITY drift:', drift.length);
    if (drift.length>0) console.log('ADDITIVITY drift:', drift);
    expect(drift).toEqual([]);
  });
});

describe('resolveDeptSlugForWrite', () => {
  let tmpDir, dbPath;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'u036-test-'));
    dbPath = join(tmpDir, 'test.db');
    const db = new Database(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, company_id TEXT DEFAULT 'default', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT DEFAULT datetime('now'));");
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO workspaces VALUES (?,?,?,?,?,?)").run('presentations', 'Presentations', 'dept-presentations', 'default', now, now);
    db.prepare("INSERT OR IGNORE INTO workspaces VALUES (?,?,?,?,?,?)").run('web-development', 'Web Development', 'web-development', 'default', now, now);
    db.close();
    process.env.DATABASE_PATH = dbPath;
  });
  afterAll(() => { delete process.env.DATABASE_PATH; try{rmSync(tmpDir,{recursive:true,force:true})}catch{} });
  let f;
  beforeAll(async () => { const m=await import('@/lib/routing/resolve-dept-slug-for-write'); const mod=m.default??m; f=mod.resolveDeptSlugForWrite; if(typeof f!=='function') throw Error('not a function'); });
  it('dept-presentations -> presentations', () => { expect(f('Presentations')).toBe('presentations'); });
  it('OpenClaw Maintenance -> openclaw-maintenance', () => { expect(f('OpenClaw Maintenance')).toBe('openclaw-maintenance'); });
  it('CEO / COM -> master-orchestrator', () => { expect(f('CEO / COM')).toBe('master-orchestrator'); });
  it('crm -> crm', () => { expect(f('crm')).toBe('crm'); });
  it('empty string', () => { expect(f('')).toBe(''); expect(()=>f('')).not.toThrow(); });
  it('null/undefined', () => { expect(f(null)).toBe(''); expect(f(undefined)).toBe(''); });
});

describe('MissionQueue matchesScope', () => {
  it('Presentations matches presentations', () => { expect(canonicalDeptFromAnyLabel('Presentations')===canonicalDeptFromAnyLabel('presentations')).toBe(true); });
  it('Communications matches communications', () => { expect(canonicalDeptFromAnyLabel('Communications')===canonicalDeptFromAnyLabel('communications')).toBe(true); });
  it('Web Development matches web-development', () => { expect(canonicalDeptFromAnyLabel('Web Development')===canonicalDeptFromAnyLabel('web-development')).toBe(true); });
});
