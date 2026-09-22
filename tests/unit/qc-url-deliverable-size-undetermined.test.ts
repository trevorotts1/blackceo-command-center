/**
 * QC URL deliverables — "null bytes" is not a measurement.
 *
 * Live incident (client box, 2026-09-21): a Google Doc holding 18,169
 * characters across 155 body elements (text export 20,126 bytes, content
 * confirmed written 2026-09-21T15:29:21Z) was scored as an EMPTY deliverable
 * three separate times. The card was blocked and burned its entire reroute
 * budget. The document was never empty — the scorer could not see it.
 *
 * Root cause, two consumers of one bad convention:
 *   • the url branch of the manifest builder set `sizeBytes: null` and never
 *     retrieved or measured the URL's content;
 *   • `buildQCPrompt` interpolated that straight into
 *     `EXISTS — ${d.sizeBytes} bytes`, handing the judge the literal string
 *     "EXISTS — null bytes";
 *   • `evaluateCriteria`'s `existence` and `min_resolution` gates coerced the
 *     same null with `(m.sizeBytes ?? 0)`, so an unmeasured size read as zero.
 *
 * Every assertion below fails on the pre-fix source. The controls (marked
 * CONTROL) pass both before and after — they exist to prove the gates were
 * tightened where they should be and NOT weakened where they should not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-url-size-'));
process.env.DATABASE_PATH = path.join(TMP, 'test.db');
process.env.PROJECTS_PATH = path.join(TMP, 'projects');
process.env.WORKSPACE_BASE_PATH = TMP;
fs.mkdirSync(process.env.PROJECTS_PATH, { recursive: true });

type Scorer = typeof import('../../src/lib/qc-scorer');
const load = (): Promise<Scorer> => import('../../src/lib/qc-scorer') as Promise<Scorer>;

type ManifestItem = Scorer extends { buildQCPrompt: (i: infer I) => string }
  ? NonNullable<I extends { deliverableManifest?: infer M | null } ? M : never>[number]
  : never;

/** The live case: a Google Doc registered as a url deliverable. */
function urlItem(over: Partial<ManifestItem> = {}): ManifestItem {
  return {
    title: 'Client onboarding brief',
    path: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit',
    type: 'url',
    sizeBytes: null,
    dimensions: null,
    valid: true,
    ...over,
  } as ManifestItem;
}

function promptFor(items: ManifestItem[], buildQCPrompt: Scorer['buildQCPrompt']): string {
  return buildQCPrompt({
    taskId: 't-1',
    taskTitle: 'Write the client onboarding brief',
    taskDescription: null,
    sopSuccessCriteria: null,
    sopName: null,
    sopSteps: null,
    departmentSlug: 'operations',
    deliverableManifest: items,
  } as Parameters<Scorer['buildQCPrompt']>[0]);
}

/** Swap global fetch for one call, always restoring it. */
async function withFetch<T>(impl: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

function jsonResponse(body: string, init: { status?: number; type?: string; url?: string } = {}): Response {
  const r = new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.type ?? 'text/plain' },
  });
  Object.defineProperty(r, 'url', { value: init.url ?? 'https://example.com/x', configurable: true });
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The judge prompt must never describe a deliverable as "null bytes"
// ═══════════════════════════════════════════════════════════════════════════

test('1. an unmeasured url deliverable never renders as "null bytes"', async () => {
  const { buildQCPrompt } = await load();
  const prompt = promptFor([urlItem()], buildQCPrompt);

  // THE regression. Pre-fix this line read `EXISTS — null bytes`.
  assert.ok(!prompt.includes('null bytes'), 'prompt must not contain the substring "null bytes"');
  assert.ok(!prompt.includes('undefined bytes'), 'prompt must not contain "undefined bytes" either');
  assert.match(prompt, /SIZE UNKNOWN/, 'an unknown size must render as UNKNOWN');
  assert.match(prompt, /EXISTS —/, 'a well-formed url deliverable is still EXISTS, not MISSING');
});

test('2. the prompt tells the judge that UNKNOWN is not empty and a link is not a miss', async () => {
  const { buildQCPrompt } = await load();
  const prompt = promptFor([urlItem()], buildQCPrompt);
  assert.match(prompt, /NOT a\s+size of zero/, 'judge must be told UNKNOWN ≠ zero');
  assert.match(prompt, /never because its size is UNKNOWN|because its size is UNKNOWN/,
    'judge must be told not to fail a deliverable for an unknown size');
  assert.match(prompt, /never missing or empty merely because it is a link/,
    'judge must be told a link is a delivered artifact');
});

test('3. CONTROL — a measured size still renders as a real byte count', async () => {
  const { buildQCPrompt } = await load();
  const prompt = promptFor(
    [urlItem({ sizeBytes: 20126, contentNote: 'URL content retrieved and measured (text/plain) — 20126 bytes of actual content' })],
    buildQCPrompt,
  );
  assert.match(prompt, /EXISTS — 20126 bytes/, 'a known size must still print as bytes');
  const manifestLine = prompt.split('\n').find((l) => l.includes('EXISTS —'))!;
  assert.ok(!manifestLine.includes('SIZE UNKNOWN'), 'a measured item must not claim UNKNOWN on its manifest line');
});

test('4. CONTROL — a genuinely missing deliverable still renders MISSING/INVALID', async () => {
  const { buildQCPrompt } = await load();
  const prompt = promptFor(
    [urlItem({ valid: false, invalidReason: 'Not a valid http(s) URL: ftp://nope' })],
    buildQCPrompt,
  );
  assert.match(prompt, /MISSING\/INVALID — Not a valid http\(s\) URL/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5–8. The deterministic gates: UNKNOWN is UNDETERMINED, never zero
// ═══════════════════════════════════════════════════════════════════════════

test('5. existence gate passes a reachable url whose size could not be measured', async () => {
  const { evaluateCriteria } = await load();
  const res = await evaluateCriteria(
    [{ id: 'existence', type: 'existence', description: 'artifact exists and is non-empty' }] as Parameters<Scorer['evaluateCriteria']>[0],
    [urlItem()] as Parameters<Scorer['evaluateCriteria']>[1],
  );
  const existence = res.results.find((r) => r.id === 'existence');
  assert.ok(existence, 'existence criterion must be evaluated');
  // Pre-fix: (null ?? 0) > 0 === false → the deliverable was declared empty.
  assert.equal(existence.pass, true, 'an unmeasured but reachable deliverable is NOT empty');
  assert.match(existence.reason, /UNDETERMINED/, 'the reason must say UNDETERMINED, not claim content');
});

test('6. CONTROL — existence still fails when NOTHING resolved', async () => {
  const { evaluateCriteria } = await load();
  const res = await evaluateCriteria(
    [{ id: 'existence', type: 'existence', description: 'artifact exists and is non-empty' }] as Parameters<Scorer['evaluateCriteria']>[0],
    [urlItem({ valid: false, invalidReason: 'Not a valid http(s) URL: ftp://nope' })] as Parameters<Scorer['evaluateCriteria']>[1],
  );
  assert.equal(res.results.find((r) => r.id === 'existence')?.pass, false);
});

test('7. CONTROL — existence still fails a file measured at zero bytes', async () => {
  const { evaluateCriteria } = await load();
  const empty = path.join(TMP, 'empty.md');
  fs.writeFileSync(empty, '');
  const res = await evaluateCriteria(
    [{ id: 'existence', type: 'existence', description: 'artifact exists and is non-empty' }] as Parameters<Scorer['evaluateCriteria']>[0],
    [{ title: 'empty', path: empty, type: 'file', sizeBytes: 0, dimensions: null, valid: true }] as Parameters<Scorer['evaluateCriteria']>[1],
  );
  assert.equal(res.results.find((r) => r.id === 'existence')?.pass, false,
    'a MEASURED zero is still empty — the fix must not swallow real emptiness');
});

test('8. min_resolution treats an unmeasured size as UNDETERMINED, not "too small"', async () => {
  const { evaluateCriteria } = await load();
  const criteria = [{ id: 'min_resolution', type: 'min_resolution', description: 'not below minimum resolution' }] as Parameters<Scorer['evaluateCriteria']>[0];

  const unknown = await evaluateCriteria(criteria, [urlItem()] as Parameters<Scorer['evaluateCriteria']>[1]);
  assert.equal(unknown.results.find((r) => r.id === 'min_resolution')?.pass, true,
    'an unmeasured size cannot prove an artifact is too small');

  // CONTROL — a MEASURED small artifact still fails.
  const tiny = await evaluateCriteria(criteria, [
    { title: 'tiny', path: '/tmp/tiny.png', type: 'image', sizeBytes: 64, dimensions: null, valid: true },
  ] as Parameters<Scorer['evaluateCriteria']>[1]);
  assert.equal(tiny.results.find((r) => r.id === 'min_resolution')?.pass, false,
    'a measured 64-byte artifact is still too small');
});

// ═══════════════════════════════════════════════════════════════════════════
// 9–15. probeUrlDeliverable — real evidence where possible, UNDETERMINED else
// ═══════════════════════════════════════════════════════════════════════════

test('9. a url pointing at real content is FETCHED and MEASURED', async () => {
  const { probeUrlDeliverable } = await load();
  const body = 'x'.repeat(20126);
  const probe = await withFetch(
    async () => jsonResponse(body, { type: 'text/plain; charset=utf-8' }),
    () => probeUrlDeliverable('https://docs.google.com/document/d/DOCID/edit'),
  );
  assert.equal(probe.valid, true);
  assert.equal(probe.sizeBytes, 20126, 'the deliverable must be measured, not reported as unknown');
  assert.ok(probe.structuralChecks, 'text content must carry structural checks for the judge');
  // The excerpt is bounded at CONTENT_EXCERPT_MAX_BYTES (8 KB) by design; the
  // SIZE is the full measurement, the structural counts are over the excerpt.
  assert.equal(probe.structuralChecks!.nonEmptyChars, 8192);
  assert.match(probe.contentNote, /retrieved and measured/);
});

test('10. the google editor link is rewritten to its plain-content export URL', async () => {
  const { googleExportUrl, probeUrlDeliverable } = await load();
  assert.equal(
    googleExportUrl('https://docs.google.com/document/d/DOCID/edit?tab=t.0'),
    'https://docs.google.com/document/d/DOCID/export?format=txt',
  );
  assert.equal(
    googleExportUrl('https://docs.google.com/spreadsheets/d/SHEETID/edit#gid=0'),
    'https://docs.google.com/spreadsheets/d/SHEETID/export?format=csv',
  );
  assert.equal(googleExportUrl('https://example.com/a/b'), 'https://example.com/a/b');

  // Measuring the /edit shell instead would report an identical byte count for
  // an empty doc and a finished one — a false measurement, worse than none.
  let requested = '';
  await withFetch(
    async (input) => { requested = String(input); return jsonResponse('hello', { type: 'text/plain' }); },
    () => probeUrlDeliverable('https://docs.google.com/document/d/DOCID/edit'),
  );
  assert.match(requested, /\/export\?format=txt$/);
});

test('11. an auth wall is UNDETERMINED — never zero, never a fail', async () => {
  const { probeUrlDeliverable } = await load();
  const probe = await withFetch(
    async () => jsonResponse('<html>Sign in</html>', { status: 401, type: 'text/html' }),
    () => probeUrlDeliverable('https://docs.google.com/document/d/DOCID/edit'),
  );
  assert.equal(probe.valid, true, 'an auth wall does not invalidate the deliverable');
  assert.equal(probe.sizeBytes, null, 'unknown must stay null — never coerced to 0');
  assert.match(probe.contentNote, /UNDETERMINED/);
  assert.match(probe.contentNote, /authentication/i);
});

test('12. a login redirect is UNDETERMINED', async () => {
  const { probeUrlDeliverable } = await load();
  const probe = await withFetch(
    async () => jsonResponse('<html>login</html>', { type: 'text/html', url: 'https://accounts.google.com/ServiceLogin?x=1' }),
    () => probeUrlDeliverable('https://docs.google.com/document/d/DOCID/edit'),
  );
  assert.equal(probe.sizeBytes, null);
  assert.match(probe.contentNote, /UNDETERMINED/);
  assert.match(probe.contentNote, /sign-in/);
});

test('13. a network failure is UNDETERMINED, explicitly not evidence of emptiness', async () => {
  const { probeUrlDeliverable } = await load();
  const probe = await withFetch(
    async () => { throw new Error('getaddrinfo ENOTFOUND'); },
    () => probeUrlDeliverable('https://example.com/report.txt'),
  );
  assert.equal(probe.valid, true);
  assert.equal(probe.sizeBytes, null);
  assert.match(probe.contentNote, /UNDETERMINED/);
  assert.match(probe.contentNote, /NOT evidence the deliverable is empty/);
});

test('14. a private/loopback host is refused without a request being made', async () => {
  const { probeUrlDeliverable, isPrivateProbeHost } = await load();
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.9', '172.16.0.1', '169.254.169.254', '::1']) {
    assert.equal(isPrivateProbeHost(h), true, `${h} must be refused`);
  }
  assert.equal(isPrivateProbeHost('docs.google.com'), false);

  let called = false;
  const probe = await withFetch(
    async () => { called = true; return jsonResponse('secret'); },
    () => probeUrlDeliverable('http://169.254.169.254/latest/meta-data/'),
  );
  assert.equal(called, false, 'QC must not fetch cloud-metadata / private hosts');
  assert.equal(probe.sizeBytes, null);
  assert.match(probe.contentNote, /UNDETERMINED/);
});

test('15. a syntactically bad url is still INVALID', async () => {
  const { probeUrlDeliverable } = await load();
  const probe = await probeUrlDeliverable('not a url');
  assert.equal(probe.valid, false);
  assert.match(probe.invalidReason ?? '', /Not a valid http\(s\) URL/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 16–17. End to end: the live incident, and the shared builder
// ═══════════════════════════════════════════════════════════════════════════

test('16. the live incident: a 20,126-byte doc reaches the judge as content, not "null bytes"', async () => {
  const { buildDeliverableManifestItem, buildQCPrompt, evaluateCriteria } = await load();
  const body = 'The client onboarding brief.\n'.repeat(700);

  const item = await withFetch(
    async () => jsonResponse(body, { type: 'text/plain' }),
    () => buildDeliverableManifestItem({
      title: 'Client onboarding brief',
      path: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit',
      deliverable_type: 'url',
    }),
  );

  assert.equal(item.type, 'url');
  assert.equal(item.valid, true, 'a url deliverable is a delivered artifact');
  assert.equal(item.sizeBytes, Buffer.byteLength(body), 'the doc must be measured');
  assert.ok((item.structuralChecks?.nonEmptyChars ?? 0) > 0);

  const prompt = promptFor([item as ManifestItem], buildQCPrompt);
  assert.ok(!prompt.includes('null bytes'), 'THE regression: judge prompt must never say "null bytes"');
  assert.match(prompt, /EXISTS — \d+ bytes/);

  const res = await evaluateCriteria(
    [{ id: 'existence', type: 'existence', description: 'artifact exists and is non-empty' }] as Parameters<Scorer['evaluateCriteria']>[0],
    [item] as Parameters<Scorer['evaluateCriteria']>[1],
  );
  assert.equal(res.results.find((r) => r.id === 'existence')?.pass, true,
    'the deliverable must not be scored as empty');
});

test('17. an unretrievable doc still reaches the judge as EXISTS with no "null bytes"', async () => {
  const { buildDeliverableManifestItem, buildQCPrompt } = await load();
  const item = await withFetch(
    async () => { throw new Error('connect ETIMEDOUT'); },
    () => buildDeliverableManifestItem({
      title: 'Client onboarding brief',
      path: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit',
      deliverable_type: 'url',
    }),
  );
  assert.equal(item.valid, true);
  assert.equal(item.sizeBytes, null);
  const prompt = promptFor([item as ManifestItem], buildQCPrompt);
  assert.ok(!prompt.includes('null bytes'));
  assert.match(prompt, /SIZE UNKNOWN/);
  assert.match(prompt, /UNDETERMINED/);
});

test('18. the shared builder still probes FILE deliverables exactly as before', async () => {
  const { buildDeliverableManifestItem } = await load();
  const f = path.join(TMP, 'brief.md');
  fs.writeFileSync(f, '# Brief\n\nReal content here.\n');
  const item = await buildDeliverableManifestItem({ title: 'brief', path: f, deliverable_type: 'file' });
  assert.equal(item.type, 'file');
  assert.equal(item.valid, true);
  assert.equal(item.sizeBytes, fs.statSync(f).size);
  assert.ok(item.contentExcerpt?.includes('Real content here.'));

  const missing = await buildDeliverableManifestItem({ title: 'gone', path: path.join(TMP, 'nope.md'), deliverable_type: 'file' });
  assert.equal(missing.valid, false);
  assert.equal(missing.sizeBytes, null);
  assert.match(missing.invalidReason ?? '', /File not found/);
});
