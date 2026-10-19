/**
 * Gap F (server half) - /api/files/preview used to serve only html + images, so
 * a pdf / mp3 deliverable could not be opened in a browser and a pptx could not
 * be fetched at all (the only other route, /api/files/reveal, opens Finder on
 * the server box). Now: pdf/audio/video render inline, and `download=1` serves
 * any file type as an attachment under the SAME path allow-list.
 *
 * node --import tsx --test tests/unit/cc-gap-f-preview-route.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccgapf-')));
const projects = path.join(root, 'projects');
const outside = path.join(root, 'outside');
fs.mkdirSync(projects, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
process.env.PROJECTS_PATH = projects;
delete process.env.WORKSPACE_BASE_PATH;

const pdf = path.join(projects, 'PRESENTER-GUIDE.pdf');
const pptx = path.join(projects, 'Deck-FINAL.pptx');
const secret = path.join(outside, 'secret.pptx');
fs.writeFileSync(pdf, '%PDF-1.4 test');
fs.writeFileSync(pptx, 'PK-not-really-a-deck');
fs.writeFileSync(secret, 'nope');

async function get(file: string, extra = ''): Promise<Response> {
  const { GET } = await import('../../src/app/api/files/preview/route');
  const url = `http://localhost/api/files/preview?path=${encodeURIComponent(file)}${extra}`;
  return GET(new NextRequest(url));
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('pdf renders inline with the pdf content type', async () => {
  const res = await get(pdf);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-disposition'), 'inline');
  assert.equal(await res.text(), '%PDF-1.4 test');
});

test('a pptx is refused for inline preview (unchanged) but downloadable as an attachment', async () => {
  assert.equal((await get(pptx)).status, 400);

  const res = await get(pptx, '&download=1');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''Deck-FINAL\.pptx$/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await res.text(), 'PK-not-really-a-deck');
});

test('download=1 does not widen the path allow-list', async () => {
  assert.equal((await get(secret, '&download=1')).status, 403);
  assert.equal((await get(`${projects}/../outside/secret.pptx`, '&download=1')).status, 403);
  assert.equal((await get(path.join(projects, 'missing.pptx'), '&download=1')).status, 404);
});
