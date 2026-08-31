/**
 * FIX 28 — CC re-verifies the artifact bundle before `done`.
 *
 * Spec: the strong build_deck.py postflight gate (per-artifact size floors +
 * leading magic bytes, symlink rejection, md size-only, webinar skipped) runs
 * CLIENT-SIDE; CC trusted the certificate JSON and never re-checked bytes.
 * PROOF TARGET: "a cert that claims done but whose registered deliverables
 * fail magic-byte/size checks does NOT reach done."
 *
 * The check re-mirrors build_deck.py's DELIVERABLES_REQUIRED / DELIVERABLE_MAGIC
 * semantics at the ONE choke point every done path funnels through:
 * collectCompletionEvidence() (task-lifecycle transition, PATCH route, bulk,
 * webhook, qc-scorer producer re-check). Rollback: PRESENTATION_BUNDLE_REVERIFY=0
 * restores the pre-fix existence-only behavior verbatim.
 *
 * Drives the REAL transition() through task-lifecycle on an isolated DB
 * (_isolated-db first import). No network anywhere. The probe unit tests
 * dynamically import the (new) export so a pre-fix build fails them with a
 * named error while the lifecycle RED asserts — which use only pre-existing
 * exports — demonstrably show the decoy passing the gate before the fix.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../../src/lib/db';
import { collectCompletionEvidence } from '../../src/lib/completion-evidence';
import { transition, TransitionError } from '../../src/lib/task-lifecycle';

// Floors mirror build_deck.py DELIVERABLES_REQUIRED (client-side authority).
const PPTX_FLOOR = 1_048_576;
const PDF_FLOOR = 51_200;
const MD_FLOOR = 2_048;
const MP3_FLOOR = 512_000;
const PNG_FLOOR = 102_400;
const HTML_FLOOR = 20_000;

let fixtureDir: string;
let taskId: string;

const CERT = 'a'.repeat(64); // valid registered process_certificate_sha (64-hex)

function filler(byte: number, total: number, prefix: Buffer = Buffer.alloc(0)): Buffer {
  const rest = Buffer.alloc(Math.max(0, total - prefix.length), byte);
  return Buffer.concat([prefix, rest]);
}

async function probeBundle(rawPath: string): Promise<unknown> {
  const mod = await import('../../src/lib/completion-evidence');
  const fn = (mod as unknown as Record<string, unknown>).verifyPresentationBundleDeliverable;
  if (typeof fn !== 'function') {
    throw new Error('FIX 28 probe export verifyPresentationBundleDeliverable missing (pre-fix build)');
  }
  return (fn as (p: string) => unknown).call(mod, rawPath);
}

async function expectBundleReject(rawPath: string, mustName: string) {
  const verdict = (await probeBundle(rawPath)) as { ok?: boolean; reason?: string };
  expect(verdict, `probe verdict for ${path.basename(rawPath)}`).toBeTruthy();
  expect(verdict.ok, `expected rejection naming ${mustName}`).toBe(false);
  expect(verdict.reason).toContain(mustName);
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix28-'));
  taskId = `fix28-task-${Date.now()}`;
  const db = getDb();
  if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get('presentations')) {
    db.prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)')
      .run('presentations', 'Presentations', 'presentations', 'Presentation', 10);
  }
  db.prepare(
    "INSERT INTO tasks (id,title,status,priority,workspace_id,department,process_certificate_sha) VALUES (?,?,'review','medium','presentations','presentations',?)",
  ).run(taskId, 'FIX 28 Bundle Reverify Task', CERT);
});

afterAll(() => {
  const db = getDb();
  db.prepare('DELETE FROM task_deliverables WHERE task_id = ?').run(taskId);
  try { db.prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId); } catch { /* table name drift on legacy test dbs */ }
  try { db.prepare('DELETE FROM events WHERE task_id = ?').run(taskId); } catch { /* ok */ }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ok */ }
});

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM task_deliverables WHERE task_id = ?').run(taskId);
  db.prepare("UPDATE tasks SET status = 'review', process_certificate_sha = ? WHERE id = ?").run(CERT, taskId);
});

afterEach(() => {
  delete process.env.PRESENTATION_BUNDLE_REVERIFY;
  try { fs.rmSync(path.join(fixtureDir, 'linked-FINAL.pptx'), { force: true }); } catch { /* ok */ }
});

/**
 * End-to-end through the REAL gate: register deliverable rows then drive
 * transition(taskId, 'done') on a presentations task whose 64-hex certificate
 * IS registered — so the evidence gate is the only gate under test.
 */
async function driveDone(paths: Array<{ deliverable_type: string; title: string; path?: string }>): Promise<{ threw: boolean; code?: string; message?: string }> {
  const db = getDb();
  const ins = db.prepare(
    'INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  );
  paths.forEach((p, i) => {
    ins.run(`fix28-r-${Date.now()}-${i}`, taskId, p.deliverable_type, p.title, p.path ?? null, new Date().toISOString(), new Date().toISOString());
  });
  try {
    await transition(taskId, 'done', { actor: 'qc-scorer', expectedFrom: 'review' });
    return { threw: false };
  } catch (err) {
    if (err instanceof TransitionError) return { threw: true, code: err.code, message: err.message };
    throw err;
  }
}

describe('FIX 28 — bundle probe mirrors build_deck.py postflight semantics', () => {
  it('rejects an absent {slug}-FINAL.pptx (ABSENT)', async () => {
    await expectBundleReject(path.join(fixtureDir, 'NOPE-FINAL.pptx'), 'ABSENT');
  });

  it('rejects a symlink to a huge real deck (SYMLINK) — never follows the link', async () => {
    const target = path.join(fixtureDir, 'real-target.pptx');
    fs.writeFileSync(target, filler(0x50, PPTX_FLOOR + 1, Buffer.from('PK\x03\x04')));
    const link = path.join(fixtureDir, 'linked-FINAL.pptx');
    fs.symlinkSync(target, link);
    await expectBundleReject(link, 'SYMLINK');
  });

  it('rejects a full-size deck with junk leading bytes (WRONG_TYPE) — the decoy of the right size', async () => {
    const decoy = path.join(fixtureDir, 'ACME-DEF-FINAL.pptx');
    fs.writeFileSync(decoy, filler(0x41, PPTX_FLOOR + 1, Buffer.from('JUNKX')));
    await expectBundleReject(decoy, 'WRONG_TYPE');
  });

  it('rejects an under-floor %PDF (UNDER_THRESHOLD) even with correct magic', async () => {
    const tiny = path.join(fixtureDir, 'ACME-DEF-FINAL.pdf');
    fs.writeFileSync(tiny, Buffer.from('%PDF-1.4 tiny stub — far under the 50KB floor'));
    await expectBundleReject(tiny, 'UNDER_THRESHOLD');
  });

  it('accepts a exactly-at-floor correct-magic file (size == floor passes)', async () => {
    const exact = path.join(fixtureDir, 'ACME-EXACT-FINAL.pdf');
    fs.writeFileSync(exact, filler(0x00, PDF_FLOOR, Buffer.from('%PDF-1.4')));
    const verdict = (await probeBundle(exact)) as { ok?: boolean; sizeBytes?: number };
    expect(verdict.ok).toBe(true);
    expect(verdict.sizeBytes).toBe(PDF_FLOOR);
  });

  it('accepts a full-size PK magic deck (the happy path)', async () => {
    const good = path.join(fixtureDir, 'ACME-GOOD-FINAL.pptx');
    fs.writeFileSync(good, filler(0x00, PPTX_FLOOR + 1, Buffer.from('PK\x03\x04')));
    const verdict = (await probeBundle(good)) as { ok?: boolean };
    expect(verdict.ok).toBe(true);
  });

  it('md stays size-only: at-floor md passes without any magic signature', async () => {
    const md = path.join(fixtureDir, 'PRESENTERS-SPEECH.md');
    fs.writeFileSync(md, Buffer.alloc(MD_FLOOR, 0x78));
    const verdict = (await probeBundle(md)) as { ok?: boolean };
    expect(verdict.ok).toBe(true);
  });

  it('rejects an under-floor md (UNDER_THRESHOLD)', async () => {
    const md = path.join(fixtureDir, 'PRESENTERS-SPEECH.md');
    fs.writeFileSync(md, Buffer.from('# stub'));
    await expectBundleReject(md, 'UNDER_THRESHOLD');
  });

  it('rejects a full-size junk mp3 (WRONG_TYPE) and accepts an ID3 lead', async () => {
    const junk = path.join(fixtureDir, 'PRESENTER-AUDIO.mp3');
    fs.writeFileSync(junk, filler(0x41, MP3_FLOOR, Buffer.from('NOTAUDIO')));
    await expectBundleReject(junk, 'WRONG_TYPE');
    const good = path.join(fixtureDir, 'PRESENTER-AUDIO-GOOD.mp3');
    fs.writeFileSync(good, filler(0x00, MP3_FLOOR + 1, Buffer.from('ID3')));
    const verdict = (await probeBundle(good)) as { ok?: boolean };
    expect(verdict.ok).toBe(true);
  });

  it('rejects a full-size non-PNG infographic (WRONG_TYPE) and accepts an 89PNG lead', async () => {
    const junk = path.join(fixtureDir, 'infographic.png');
    fs.writeFileSync(junk, filler(0x41, PNG_FLOOR + 1, Buffer.from('GIF89a')));
    await expectBundleReject(junk, 'WRONG_TYPE');
    const good = path.join(fixtureDir, 'infographic-real.png');
    fs.writeFileSync(good, filler(0x00, PNG_FLOOR + 1, Buffer.from('\x89PNG')));
    const verdict = (await probeBundle(good)) as { ok?: boolean };
    expect(verdict.ok).toBe(true);
  });

  it('rejects a full-size non-HTML teleprompter (WRONG_TYPE); accepts doctype-lead and BOM-lead', async () => {
    const junk = path.join(fixtureDir, 'presenter-teleprompter.html');
    fs.writeFileSync(junk, filler(0x41, HTML_FLOOR + 1, Buffer.from('NO-HTML-HERE')));
    await expectBundleReject(junk, 'WRONG_TYPE');
    const good = path.join(fixtureDir, 'presenter-teleprompter-real.html');
    fs.writeFileSync(good, filler(0x00, HTML_FLOOR + 1, Buffer.from('<!DOCTYPE html>')));
    const bom = path.join(fixtureDir, 'presenter-teleprompter-bom.html');
    fs.writeFileSync(bom, filler(0x00, HTML_FLOOR + 1, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!DOCTYPE html>')])));
    for (const p of [good, bom]) {
      const verdict = (await probeBundle(p)) as { ok?: boolean };
      expect(verdict.ok, `expected ok for ${path.basename(p)}`).toBe(true);
    }
  });

  it('speaker-guide PDF floor mirrors guide_pdf (under floor rejected)', async () => {
    const guide = path.join(fixtureDir, 'PRESENTER-GUIDE.pdf');
    fs.writeFileSync(guide, Buffer.from('%PDF small guide stub'));
    await expectBundleReject(guide, 'UNDER_THRESHOLD');
  });
});

describe('FIX 28 — PROOF: decoy bundle does NOT reach done even with a registered cert', () => {
  it('collectCompletionEvidence refuses the junk decoy (fix: not usable; pre-fix: usable)', () => {
    const decoy = path.join(fixtureDir, 'ACME-EVD-FINAL.pptx');
    fs.writeFileSync(decoy, filler(0x41, PPTX_FLOOR + 1, Buffer.from('JUNKX')));
    const db = getDb();
    db.prepare('INSERT INTO task_deliverables (id,task_id,deliverable_type,title,path,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(`fix28-unit-${Date.now()}`, taskId, 'file', 'Assembled deck PPTX', decoy, new Date().toISOString(), new Date().toISOString());
    const evidence = collectCompletionEvidence(taskId);
    expect(evidence.hasEvidence).toBe(false);
    expect(evidence.problems.join(' ')).toContain('WRONG_TYPE');
  });

  it('transition to done REFUSES the decoy with PRECONDITION_EVIDENCE (cert registered, still refused)', async () => {
    const decoy = path.join(fixtureDir, 'ACME-DELTA-FINAL.pptx');
    fs.writeFileSync(decoy, filler(0x41, PPTX_FLOOR + 1, Buffer.from('JUNKX'))); // full-size junk — the exact pre-fix hole
    const res = await driveDone([
      { deliverable_type: 'file', title: 'Assembled deck PPTX', path: decoy },
    ]);
    expect(res.threw, 'pre-fix: decoy counted as evidence and done SUCCEEDED — gate missing').toBe(true);
    expect(res.code).toBe('PRECONDITION_EVIDENCE');
    expect(res.message).toContain('WRONG_TYPE');
  });

  it('transition to done with the REAL bundle SUCCEEDS (no over-blocking)', async () => {
    const good = path.join(fixtureDir, 'ACME-SUCCESS-FINAL.pptx');
    fs.writeFileSync(good, filler(0x00, PPTX_FLOOR + 1, Buffer.from('PK\x03\x04')));
    const res = await driveDone([
      { deliverable_type: 'file', title: 'Assembled deck PPTX', path: good },
      { deliverable_type: 'url', title: 'Decision record', path: 'https://example.com/decision' },
    ]);
    expect(res.threw, res.message).toBe(false);
    const row = getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
    expect(row.status).toBe('done');
  });

  it('non-bundle files keep their old evidence rules (no over-reach to ordinary deliverables)', async () => {
    const notes = path.join(fixtureDir, 'notes.txt');
    fs.writeFileSync(notes, Buffer.from('plain notes'));
    const res = await driveDone([
      { deliverable_type: 'file', title: 'Meeting notes', path: notes },
    ]);
    expect(res.threw, res.message).toBe(false);
    expect(res.code).toBeUndefined();
  });

  it('rollback PRESENTATION_BUNDLE_REVERIFY=0 restores pre-fix behavior verbatim', async () => {
    process.env.PRESENTATION_BUNDLE_REVERIFY = '0';
    const decoy = path.join(fixtureDir, 'ACME-ROLL-FINAL.pptx');
    fs.writeFileSync(decoy, filler(0x41, 32, Buffer.from('JUNKX'))); // junk, tiny
    const res = await driveDone([
      { deliverable_type: 'file', title: 'Assembled deck PPTX', path: decoy },
    ]);
    expect(res.threw, res.message).toBe(false); // old existence-only semantics
    expect(res.code).toBeUndefined();
  });
});