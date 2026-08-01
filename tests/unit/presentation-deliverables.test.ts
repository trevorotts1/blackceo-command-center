/**
 * presentation-deliverables.test.ts — U063 test suite.
 * DB-backed vitest suite. Import _isolated-db FIRST.
 */

import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../../src/lib/db';
import {
  PRESENTATION_ARTIFACTS, MAGIC_VERIFIED_KEYS, SIZE_ONLY_KEYS,
  MAGIC_VERIFIED_SET, SIZE_ONLY_SET, ARTIFACT_KEY_SET,
} from '../../src/lib/presentation-deliverables';
import type { PresentationArtifact } from '../../src/lib/presentation-deliverables';

const KNOWN_KEYS = ['deck_pptx','deck_pdf','guide_pdf','speech_md','speech_pdf','speech_fish_md','audio_mp3','infographic_png','teleprompter_html'];
const MAGIC_KEYS = ['deck_pptx','deck_pdf','guide_pdf','speech_pdf','audio_mp3','infographic_png','teleprompter_html'];
const SIZE_KEYS = ['speech_md','speech_fish_md'];

let fixtureDir: string;
let taskId: string;
let runDir: string;

function seedWorkspace() {
  const db = getDb();
  if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get('presentations')) {
    db.prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)')
      .run('presentations','Presentations','presentations','Presentation',10);
  }
}

function seedTask(tid: string) {
  getDb().prepare('INSERT INTO tasks (id,title,status,priority,workspace_id,department) VALUES (?,?,\'backlog\',\'medium\',\'presentations\',\'presentations\')')
    .run(tid, 'Test Presentation Task');
}

function seedDeliverable(id: string, tid: string, type: string, title: string, fp: string | null, fsSize: number | null, mime: string | null, sha: string | null) {
  getDb().prepare('INSERT INTO task_deliverables (id,task_id,deliverable_type,title,path,mime_type,file_size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,datetime(\'now\'))')
    .run(id, tid, type, title, fp, mime, fsSize, sha);
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pres-dlv-'));
  runDir = path.join(fixtureDir, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(runDir, 'working'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'working', 'checkpoints'), { recursive: true });
  process.env.PROJECTS_PATH = fixtureDir;
  fs.mkdirSync(path.join(fixtureDir, 'artifacts'), { recursive: true });
  taskId = 'test-pres-001';
  fs.mkdirSync(path.join(fixtureDir, 'artifacts', taskId), { recursive: true });
  seedWorkspace();
  seedTask(taskId);
});

afterAll(() => { try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ok */ } });

describe('PRESENTATION_ARTIFACTS table', () => {
  it('has exactly 9 entries', () => { expect(PRESENTATION_ARTIFACTS.length).toBe(9); });
  it('keys match producer order', () => { expect(PRESENTATION_ARTIFACTS.map((a: PresentationArtifact) => a.key)).toEqual(KNOWN_KEYS); });
  it('7+2=9 checksum', () => { expect(MAGIC_VERIFIED_KEYS.length).toBe(7); expect(SIZE_ONLY_KEYS.length).toBe(2); expect(MAGIC_VERIFIED_KEYS.length + SIZE_ONLY_KEYS.length).toBe(9); });
  it('magic keys exactly as known', () => { expect([...MAGIC_VERIFIED_KEYS].sort()).toEqual([...MAGIC_KEYS].sort()); });
  it('size-only keys are speech_md and speech_fish_md', () => { expect([...SIZE_ONLY_KEYS].sort()).toEqual([...SIZE_KEYS].sort()); });
  it('teleprompter floor=20000, deck_pptx floor=1048576', () => {
    expect(PRESENTATION_ARTIFACTS.find(a => a.key === 'teleprompter_html')?.min_bytes).toBe(20000);
    expect(PRESENTATION_ARTIFACTS.find(a => a.key === 'deck_pptx')?.min_bytes).toBe(1_048_576);
  });
  it('ARTIFACT_KEY_SET has all nine', () => { expect(ARTIFACT_KEY_SET.size).toBe(9); for (const k of KNOWN_KEYS) expect(ARTIFACT_KEY_SET.has(k)).toBe(true); });
  it('magic and size-only sets are disjoint', () => { for (const k of MAGIC_VERIFIED_SET) expect(SIZE_ONLY_SET.has(k)).toBe(false); });
});

import { NextRequest } from 'next/server';

describe('GET /api/presentations/[taskId]/deliverables', () => {
  beforeEach(() => { getDb().prepare('DELETE FROM task_deliverables').run(); });

  async function call(tid: string) {
    const { GET } = await import('../../src/app/api/presentations/[taskId]/deliverables/route');
    return GET(new NextRequest(`http://localhost/api/presentations/${tid}/deliverables`), { params: { taskId: tid } });
  }

  it('returns exactly nine rows in table order for zero deliverables', async () => {
    const res = await call(taskId); expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.rows.length).toBe(9);
    for (let i = 0; i < 9; i++) {
      expect(b.rows[i].key).toBe(KNOWN_KEYS[i]);
      expect(b.rows[i].present).toBe(false);
      expect(b.rows[i].size_source).toBe('unknown');
      expect(b.rows[i].ghl_url).toBeNull();
    }
    expect(b.extra).toEqual([]);
    expect(b.ghl_ledger_present).toBe(false);
  });

  it('deliverable matching artifact n sets only that row present', async () => {
    const fp = path.join(runDir, 'test-pitch-FINAL.pdf');
    fs.writeFileSync(fp, 'x'.repeat(60_000));
    seedDeliverable('d1', taskId, 'artifact', 'test-pitch-FINAL.pdf', fp, null, null, null);
    const b = await (await call(taskId)).json();
    expect(b.rows[1].key).toBe('deck_pdf');
    expect(b.rows[1].present).toBe(true);
    for (let i = 0; i < 9; i++) if (i !== 1) expect(b.rows[i].present).toBe(false, `Row ${i} should not be present`);
  });

  it('unmatched deliverable goes to extra[]', async () => {
    const fp = path.join(runDir, 'random.txt');
    fs.writeFileSync(fp, 'hello');
    seedDeliverable('ex1', taskId, 'file', 'Random', fp, 5, 'text/plain', 'abc');
    const b = await (await call(taskId)).json();
    expect(b.extra.length).toBe(1);
    expect(b.extra[0].title).toBe('Random');
  });

  it('file_size_bytes present => size_source: db', async () => {
    const fp = path.join(runDir, 'PRESENTER-GUIDE.pdf');
    fs.writeFileSync(fp, 'x'.repeat(55_000));
    seedDeliverable('d2', taskId, 'artifact', 'PRESENTER-GUIDE.pdf', fp, 55_000, 'application/pdf', 'sha_db');
    const b = await (await call(taskId)).json();
    const g = b.rows.find((r: any) => r.key === 'guide_pdf');
    expect(g.size_source).toBe('db'); expect(g.size_bytes).toBe(55_000);
  });

  it('absent db size, file on disk => size_source: stat', async () => {
    const fp = path.join(runDir, 'PRESENTER-GUIDE.pdf');
    fs.writeFileSync(fp, 'x'.repeat(55_000));
    seedDeliverable('d3', taskId, 'artifact', 'PRESENTER-GUIDE.pdf', fp, null, null, null);
    const b = await (await call(taskId)).json();
    const g = b.rows.find((r: any) => r.key === 'guide_pdf');
    expect(g.size_source).toBe('stat'); expect(g.size_bytes).toBe(55_000);
  });

  it('symlink => size_source: unknown', async () => {
    const realPath = path.join(runDir, 'real-guide.pdf');
    fs.writeFileSync(realPath, 'x'.repeat(55_000));
    const linkPath = path.join(runDir, 'link-guide.pdf');
    fs.symlinkSync(realPath, linkPath);
    seedDeliverable('d4', taskId, 'artifact', 'PRESENTER-GUIDE.pdf', linkPath, null, null, null);
    const b = await (await call(taskId)).json();
    const g = b.rows.find((r: any) => r.key === 'guide_pdf');
    expect(g.size_source).toBe('unknown'); expect(g.size_bytes).toBeNull();
  });

  it('below_floor: one byte below => true, one byte above => false', async () => {
    const aboveP = path.join(runDir, 'PRESENTER-GUIDE.pdf');
    fs.writeFileSync(aboveP, 'x'.repeat(51201));
    seedDeliverable('d5', taskId, 'artifact', 'PRESENTER-GUIDE.pdf', aboveP, null, null, null);
    const belowP = path.join(runDir, 'PRESENTERS-SPEECH.md');
    fs.writeFileSync(belowP, 'x'.repeat(2047));
    seedDeliverable('d6', taskId, 'artifact', 'PRESENTERS-SPEECH.md', belowP, null, null, null);
    const b = await (await call(taskId)).json();
    expect(b.rows.find((r: any) => r.key === 'guide_pdf').below_floor).toBe(false);
    expect(b.rows.find((r: any) => r.key === 'speech_md').below_floor).toBe(true);
  });

  it('GHL join on uploaded[].local_path', async () => {
    const fp = path.join(runDir, 'PRESENTERS-SPEECH.pdf');
    fs.writeFileSync(fp, 'x'.repeat(5000));
    seedDeliverable('d7', taskId, 'artifact', 'PRESENTERS-SPEECH.pdf', fp, 5000, null, null);
    fs.writeFileSync(path.join(runDir, 'working', 'checkpoints', 'media_library.json'),
      JSON.stringify({ uploaded: [{ local_path: fp, ghl_url: 'https://ex.com/ghl/speech.pdf' }] }));
    const b = await (await call(taskId)).json();
    expect(b.ghl_ledger_present).toBe(true);
    expect(b.rows.find((r: any) => r.key === 'speech_pdf').ghl_url).toBe('https://ex.com/ghl/speech.pdf');
    for (const r of b.rows) if (r.key !== 'speech_pdf') expect(r.ghl_url).toBeNull();
  });

  it('fact-5: ledger with only normalized projections yields NO links', async () => {
    const pp = path.join(runDir, 'test-deck-FINAL.pptx');
    fs.writeFileSync(pp, 'x'.repeat(2_000_000));
    seedDeliverable('d8', taskId, 'artifact', 'test-deck-FINAL.pptx', pp, 2_000_000, null, null);
    const gp = path.join(runDir, 'PRESENTER-GUIDE.pdf');
    fs.writeFileSync(gp, 'x'.repeat(60_000));
    seedDeliverable('d9', taskId, 'artifact', 'PRESENTER-GUIDE.pdf', gp, 60_000, null, null);
    fs.writeFileSync(path.join(runDir, 'working', 'checkpoints', 'media_library.json'),
      JSON.stringify({ uploaded: [], pptx_ghl_media_id: 'fake', pptx_ghl_url: 'https://ex.com/deck.pptx', slides: [] }));
    const b = await (await call(taskId)).json();
    for (const r of b.rows) expect(r.ghl_url).toBeNull();
  });

  it('missing ledger => HTTP 200, ghl_ledger_present: false', async () => {
    const b = await (await call(taskId)).json();
    expect(b.ghl_ledger_present).toBe(false);
    for (const r of b.rows) expect(r.ghl_url).toBeNull();
  });

  it('response contains no identifier keys', async () => {
    const b = await (await call(taskId)).json();
    const js = JSON.stringify(b);
    expect(js).not.toContain('ghl_media_id');
    expect(js).not.toContain('file_id');
    expect(js).not.toContain('ghl_folder_id');
    function allKeys(obj: any, s: Set<string>) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { for (const i of obj) allKeys(i, s); return; }
      for (const k of Object.keys(obj)) { s.add(k); allKeys(obj[k], s); }
    }
    const keys = new Set<string>(); allKeys(b, keys);
    for (const f of ['ghl_media_id','file_id','ghl_folder_id','location_id','tenant_id','zone']) expect(keys.has(f)).toBe(false);
  });

  it('speech_md and speech_fish_md => verification: size-only even when present and above floor', async () => {
    const mdP = path.join(runDir, 'PRESENTERS-SPEECH.md');
    fs.writeFileSync(mdP, 'x'.repeat(3000));
    seedDeliverable('d10', taskId, 'artifact', 'PRESENTERS-SPEECH.md', mdP, 3000, null, null);
    const fishP = path.join(runDir, 'PRESENTERS-SPEECH-FISH-TAGGED.md');
    fs.writeFileSync(fishP, 'x'.repeat(3000));
    seedDeliverable('d11', taskId, 'artifact', 'PRESENTERS-SPEECH-FISH-TAGGED.md', fishP, 3000, null, null);
    const b = await (await call(taskId)).json();
    expect(b.rows.find((r: any) => r.key === 'speech_md').verification).toBe('size-only');
    expect(b.rows.find((r: any) => r.key === 'speech_fish_md').verification).toBe('size-only');
  });
});
