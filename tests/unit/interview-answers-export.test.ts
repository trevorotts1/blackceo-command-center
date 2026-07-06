/**
 * Unit tests for GET /api/interview/answers/export — the durable ANSWERS
 * DOCUMENT download. Runs under `npm run test:unit`.
 *
 * Strategy: OPENCLAW_WORKSPACE_ROOT at a temp workspace; write the canonical
 * company-discovery/workforce-interview-answers.md and drive the real GET
 * handler.
 *
 * Verifies:
 *   1. 404 (no_answers_yet) when no transcript exists — never fabricates an
 *      empty/synthetic document.
 *   2. Byte-faithful export of the canonical file, text/markdown, with the
 *      x-interview-answer-count header.
 *   3. ?download=1 adds a Content-Disposition attachment whose filename is
 *      keyed to the recorded company slug.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ivexport-ws-'));
process.env.OPENCLAW_WORKSPACE_ROOT = WORKSPACE;

const TRANSCRIPT = [
  '# Workforce Interview Answers',
  '',
  'Started: July 06, 2026 at 09:00 AM',
  '',
  '---',
  '',
  '**Q:** What is the name of your company?',
  '**A:** Acme Rockets',
  '**Logged:** July 06, 2026 at 09:01 AM',
  '',
  '---',
  '',
  '**Q:** What does your company actually do, in your own words?',
  '**A:** We build the rockets coyotes dream about.',
  '**Logged:** July 06, 2026 at 09:03 AM',
  '',
  '---',
  '',
].join('\n');

type RouteModule = typeof import('../../src/app/api/interview/answers/export/route');
let GET: RouteModule['GET'];

function buildRequest(qs = ''): NextRequest {
  return new NextRequest(`http://localhost/api/interview/answers/export${qs}`);
}

function writeTranscript(): void {
  const dir = path.join(WORKSPACE, 'company-discovery');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workforce-interview-answers.md'), TRANSCRIPT, 'utf-8');
}

test.before(async () => {
  const mod = await import('../../src/app/api/interview/answers/export/route');
  GET = mod.GET;
});

test.after(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

// ── 1. no transcript → calm 404, never a fabricated document ─────────────────
test('404s when no answers document exists yet', async () => {
  const res = await GET(buildRequest());
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'no_answers_yet');
});

// ── 2. byte-faithful markdown export ──────────────────────────────────────────
test('exports the canonical document byte-for-byte as text/markdown', async () => {
  writeTranscript();
  const res = await GET(buildRequest());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
  assert.equal(res.headers.get('x-interview-answer-count'), '2');
  const text = await res.text();
  assert.equal(text, TRANSCRIPT, 'export must be byte-faithful to the canonical file');
  assert.equal(
    res.headers.get('content-disposition'),
    null,
    'inline (no attachment) without ?download=1',
  );
});

// ── 3. download disposition keyed to the company slug ─────────────────────────
test('?download=1 sets an attachment filename keyed to the company slug', async () => {
  writeTranscript();
  fs.writeFileSync(
    path.join(WORKSPACE, '.workforce-build-state.json'),
    JSON.stringify({ companySlug: 'Acme Rockets!!' }),
    'utf-8',
  );
  const res = await GET(buildRequest('?download=1'));
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get('content-disposition'),
    'attachment; filename="workforce-interview-answers-acme-rockets.md"',
  );
});
