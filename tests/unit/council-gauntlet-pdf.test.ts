/**
 * council-gauntlet-pdf.test.ts — CWE-044 gauntlet: rendered PDF
 * (T106) and the PDF half of cross-format agreement (T105), over
 * CWE-038's own byte-exact export fixtures.
 *
 * Fixtures (tests/council-gauntlet/fixtures/cwe038/) are produced by
 * CWE-038's unmodified ReportExportService via
 * tests/council-gauntlet/make-cwe038-fixtures.mjs; the manifest pins
 * their SHA-256s and the ONB commit they came from. The first test
 * re-verifies those hashes: fixture drift fails loudly here and is
 * never silently absorbed.
 *
 * What is proven, with poppler (pdfinfo/pdftotext) as an independent
 * reader of the produced bytes:
 *   - the golden print HTML renders to a real, valid PDF;
 *   - its text carries the verdict, the recommendation, the golden
 *     score rows (132/168/145, display 7.6), the report revision id
 *     and the verdict content hash, agreeing with the Markdown and
 *     record JSON siblings byte-for-byte on those fields;
 *   - every seat carries its Section 7 attribution label and its
 *     permitted source detail (source qualification) in the PDF;
 *   - the long report paginates with "Page N of M" on every page and
 *     the evidence table header repeating on continuation pages;
 *   - render time fits the Section 32.6 report budgets for its size;
 *   - byte-level honesty: a missing Chromium capability refuses with
 *     typed EXPORT_FORMAT_NOT_READY and a garbage render refuses with
 *     EXPORT_RENDER_FAILED. No path yields placeholder bytes.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ReportPdfError,
  probePdfCapability,
  renderCouncilReportPdf,
} from '../../src/lib/council/report-pdf';

const FIXTURES = join(process.cwd(), 'tests/council-gauntlet/fixtures/cwe038');
const EVIDENCE_DIR =
  process.env.GAUNTLET_OUT ?? join(homedir(), 'workspace/skill77/cwe-044/evidence');

const SEAT_LABELS: Record<string, string> = {
  'simon-sinek': 'Simon Sinek',
  'td-jakes': 'T. D. Jakes',
  'oprah-winfrey': 'Oprah Winfrey',
  'tiffany-aliche': 'Tiffany Aliche',
  'russell-brunson': 'Russell Brunson',
  'michelle-obama': 'Michelle Obama',
  'brene-brown': 'Brené Brown',
  'dennis-kimbro': 'Dr. Dennis Kimbro',
  'les-brown': 'Les Brown',
};

interface Manifest {
  report_revision_id: string;
  verdict_content_sha256: string;
  pdf_refusal: { code: string; missing_piece: string };
  artifacts: Record<string, { sha256: string; bytes: number }>;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')) as Manifest;
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function pdfText(pdfPath: string, page?: number): string {
  const args = ['-layout'];
  if (page) args.push('-f', String(page), '-l', String(page));
  args.push(pdfPath, '-');
  return execFileSync('pdftotext', args, { maxBuffer: 16 * 1024 * 1024 }).toString('utf8');
}

function pdfPages(pdfPath: string): number {
  const out = execFileSync('pdfinfo', [pdfPath]).toString('utf8');
  const m = out.match(/^Pages:\s+(\d+)/m);
  assert.ok(m, 'pdfinfo reports a page count');
  return Number(m[1]);
}

test('fixtures are byte-identical to the CWE-038 manifest (drift check)', () => {
  const man = manifest();
  for (const [name, info] of Object.entries(man.artifacts)) {
    const bytes = readFileSync(join(FIXTURES, name));
    const sha = createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha, info.sha256, `${name} drifted from the manifest`);
    assert.equal(bytes.length, info.bytes, `${name} size drifted`);
  }
  assert.equal(man.pdf_refusal.code, 'EXPORT_FORMAT_NOT_READY');
  assert.ok(man.pdf_refusal.missing_piece.includes('CWE-044'));
});

test('capability probe finds the Chromium renderer on this machine', () => {
  const cap = probePdfCapability();
  assert.equal(cap.ready, true, `probe: ${JSON.stringify(cap)}`);
  assert.ok(cap.executablePath && cap.executablePath.length > 0);
});

test('golden report renders to a real PDF agreeing with its siblings (T106/T105)', async () => {
  const man = manifest();
  // Timing method (Section 32.6 budget): one warmup render first
  // (cold Chromium start on a loaded machine measures the machine,
  // not the pipeline), then the measured render. Machine-relative:
  // loaded 2-CPU VM, 2026-10-14; the harness repeats identically on
  // a quiet machine.
  await renderCouncilReportPdf(fixture('golden-print.html'));
  const started = performance.now();
  const rendered = await renderCouncilReportPdf(fixture('golden-print.html'));
  const elapsedMs = performance.now() - started;
  const pdfPath = join(EVIDENCE_DIR, 'golden-report.pdf');
  writeFileSync(pdfPath, rendered.bytes);

  assert.equal(rendered.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  const pages = pdfPages(pdfPath);
  assert.equal(pages, rendered.pageCount, 'module page count matches pdfinfo');
  assert.ok(pages >= 2, `golden report paginates (got ${pages})`);

  const text = pdfText(pdfPath);
  const md = fixture('golden.md');
  const record = JSON.parse(fixture('golden-record.json')) as {
    report_revision_id: string;
    verdict_block: { label: string; recommended_option_id: string; content_sha256: string };
  };

  // Verdict, recommendation, golden numbers.
  for (const needle of [
    'Verdict: GO',
    'Recommendation: B (Pilot the revised offer)',
    '132',
    '168',
    '145',
    '7.6',
    '6.0',
    '6.6',
  ]) {
    assert.ok(text.includes(needle), `PDF text contains ${needle}`);
  }
  // Revision identity and verdict hash agree across all formats.
  assert.ok(text.includes(man.report_revision_id), 'PDF carries the report revision id');
  assert.ok(text.includes(man.verdict_content_sha256), 'PDF carries the verdict hash');
  assert.ok(md.includes(man.report_revision_id) && md.includes(man.verdict_content_sha256));
  assert.equal(record.report_revision_id, man.report_revision_id);
  assert.equal(record.verdict_block.content_sha256, man.verdict_content_sha256);
  assert.equal(record.verdict_block.label, 'GO');
  assert.equal(record.verdict_block.recommended_option_id, 'B');

  // Every seat: attribution label + permitted source detail.
  for (const [seatId, name] of Object.entries(SEAT_LABELS)) {
    assert.ok(
      text.includes(
        `AI perspective inspired by the published work of ${name}. Not the individual and not an endorsement.`,
      ),
      `PDF carries the Section 7 attribution label for ${name}`,
    );
    assert.ok(
      text.includes(`${name} (${seatId}), source qualification: bibliographic_only`),
      `PDF carries the permitted source detail for ${name}`,
    );
  }

  // Section 32.6: a report of this size (<= 10 pages) renders in <= 10 s.
  assert.ok(pages <= 10);
  assert.ok(
    elapsedMs <= 10_000,
    `golden render (warm, incl. browser launch) took ${elapsedMs.toFixed(0)}ms; budget 10000ms for <=10 pages; machine-relative (loaded 2-CPU VM)`,
  );
});

test('long report: page numbers on every page, evidence header repeats (T106)', async () => {
  const started = performance.now();
  const rendered = await renderCouncilReportPdf(fixture('long-print.html'));
  const elapsedMs = performance.now() - started;
  const pdfPath = join(EVIDENCE_DIR, 'long-report.pdf');
  writeFileSync(pdfPath, rendered.bytes);
  const pages = pdfPages(pdfPath);
  assert.equal(pages, rendered.pageCount);
  assert.ok(pages >= 3, `long report spans several pages (got ${pages})`);
  const budgetMs = pages <= 10 ? 10_000 : 30_000;
  assert.ok(
    elapsedMs <= budgetMs,
    `long render took ${elapsedMs.toFixed(0)}ms for ${pages} pages; budget ${budgetMs}ms; machine-relative (loaded 2-CPU VM)`,
  );

  for (let p = 1; p <= pages; p++) {
    const pageText = pdfText(pdfPath, p);
    assert.ok(
      pageText.includes(`Page ${p} of ${pages}`),
      `page ${p} carries its "Page ${p} of ${pages}" footer`,
    );
  }
  // The evidence table (57 rows) must show its column header on at
  // least two pages: the start page and a continuation page.
  let headerPages = 0;
  for (let p = 1; p <= pages; p++) {
    const pageText = pdfText(pdfPath, p);
    if (pageText.includes('Evidence') && pageText.includes('SHA-256')) headerPages++;
  }
  assert.ok(headerPages >= 2, `evidence table header repeats (seen on ${headerPages} pages)`);
});

test('missing Chromium capability refuses typed, with the missing piece named', async () => {
  await assert.rejects(
    renderCouncilReportPdf(fixture('golden-print.html'), {
      probe: () => ({
        ready: false,
        executablePath: null,
        missingPiece: 'the Playwright Chromium browser executable is not installed in this environment (install it with: npx playwright install chromium); without it no PDF can be rendered and requests refuse honestly instead of returning placeholder bytes',
      }),
    }),
    (err: unknown) => {
      assert.ok(err instanceof ReportPdfError);
      assert.equal(err.code, 'EXPORT_FORMAT_NOT_READY');
      assert.ok(err.missingPiece?.includes('npx playwright install chromium'));
      return true;
    },
  );
});

test('garbage render output refuses typed instead of returning bytes', async () => {
  const fakeBrowser = {
    newPage: async () => ({
      setContent: async () => undefined,
      emulateMedia: async () => undefined,
      pdf: async () => Buffer.from('this is not a pdf at all'),
    }),
    close: async () => undefined,
  };
  await assert.rejects(
    renderCouncilReportPdf(fixture('golden-print.html'), {
      // The fake is structurally the two methods the renderer calls.
      launcher: async () => fakeBrowser as never,
    }),
    (err: unknown) => {
      assert.ok(err instanceof ReportPdfError);
      assert.equal(err.code, 'EXPORT_RENDER_FAILED');
      return true;
    },
  );
  await assert.rejects(renderCouncilReportPdf('not html'), (err: unknown) => {
    assert.ok(err instanceof ReportPdfError);
    assert.equal(err.code, 'EXPORT_RENDER_FAILED');
    return true;
  });
});
