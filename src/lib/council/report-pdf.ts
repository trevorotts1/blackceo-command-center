/**
 * Council report PDF production (CWE-044, directive Section 24).
 *
 * CWE-038's validated export service renders one report model to
 * record JSON, Markdown, and print HTML byte-deterministically, and
 * registers the pdf deliverable NOT READY: its runtime dependency
 * bill has no renderer, so PDF requests refuse there with the typed
 * EXPORT_FORMAT_NOT_READY error and exports requesting 'pdf' (or
 * 'all') never produce placeholder bytes.
 *
 * This module is the missing piece that registry entry names: the
 * approved Playwright/Chromium renderer (Section 24.3), hosted where
 * the Chromium capability actually exists. Its contract mirrors
 * CWE-038's honesty rules exactly:
 *
 *   - Input is CWE-038's print HTML bytes, unmodified. The renderer
 *     adds no content of its own; it paginates.
 *   - A PDF request either returns bytes that validate as a real PDF
 *     (header, trailer, non-trivial size, page count read back from
 *     the file) or throws a typed ReportPdfError. No path returns
 *     placeholder bytes.
 *   - When the Chromium executable is absent, the error is
 *     EXPORT_FORMAT_NOT_READY with the missing piece named, the same
 *     code CWE-038 uses, so callers handle one refusal shape.
 *   - Render or validation failures are EXPORT_RENDER_FAILED.
 *
 * Page numbers: CWE-038's print template declares them in an @page
 * margin box, which Chromium's print-to-PDF does not implement
 * (gauntlet finding F-PDF-1). The renderer therefore supplies the
 * identical "Page N of M" footer through Playwright's
 * displayHeaderFooter template, and passes the template's own @page
 * margins explicitly so pagination matches the template's design.
 *
 * Adoption: CWE-050 composes CWE-038's export service into the
 * production export job and download path; this renderer is the
 * function that composition calls for the pdf format (report
 * filename council-report-<session_id>-r<revision>.pdf, media type
 * application/pdf, per CWE-038's registry).
 *
 * Byte stability (CWE-044 final stream): the composed export
 * service binds every artifact by SHA-256 (journal record,
 * deliverable row, download bytes must all agree, and downloads
 * re-render and verify). Chromium's print-to-PDF output is byte
 * deterministic for identical input EXCEPT the info-dictionary
 * /CreationDate and /ModDate, which carry the render wall-clock
 * (verified empirically: two renders of the same HTML seconds
 * apart differ only in those digits). The renderer therefore pins
 * those two values' digits to zero in place before returning:
 * the replacement is digit-for-digit, so every byte length and
 * xref offset is preserved and the pinned bytes are the validated,
 * served bytes. Identical print HTML now renders to identical
 * bytes, which is what makes the hash binding honest.
 */

import {
  accessSync,
  constants as fsConstants,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';

/** Typed refusal/failure codes, aligned with CWE-038's error shape. */
export type ReportPdfErrorCode =
  | 'EXPORT_FORMAT_NOT_READY'
  | 'EXPORT_RENDER_FAILED';

export class ReportPdfError extends Error {
  readonly code: ReportPdfErrorCode;
  /** Set only for EXPORT_FORMAT_NOT_READY: the missing piece, named. */
  readonly missingPiece: string | null;

  constructor(
    code: ReportPdfErrorCode,
    message: string,
    missingPiece: string | null = null,
  ) {
    super(message);
    this.name = 'ReportPdfError';
    this.code = code;
    this.missingPiece = missingPiece;
  }
}

export const PDF_RENDERER_MISSING_PIECE =
  'the Playwright Chromium browser executable is not installed in this environment (install it with: npx playwright install chromium); without it no PDF can be rendered and requests refuse honestly instead of returning placeholder bytes';

export interface PdfCapability {
  ready: boolean;
  executablePath: string | null;
  missingPiece: string | null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a Chromium executable Playwright can drive. The pinned
 * build for the installed Playwright version wins; when it is not
 * installed, the newest installed Chromium (or headless shell) in
 * the Playwright browsers directory is used instead, because the
 * capability the directive requires is a working Chromium renderer,
 * not one specific browser revision. Returns null when no Chromium
 * is installed at all.
 */
export function resolveChromiumExecutable(): string | null {
  try {
    const pinned = chromium.executablePath();
    if (pinned && isExecutable(pinned)) return pinned;
  } catch {
    // fall through to the installed-build scan
  }
  const browsersDir =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache/ms-playwright');
  let entries: string[] = [];
  try {
    entries = readdirSync(browsersDir);
  } catch {
    return null;
  }
  const candidates: Array<{ revision: number; path: string }> = [];
  for (const entry of entries) {
    const full = /^chromium-(\d+)$/.exec(entry);
    if (full) {
      candidates.push({
        revision: Number(full[1]),
        path: join(browsersDir, entry, 'chrome-linux64', 'chrome'),
      });
      continue;
    }
    const shell = /^chromium_headless_shell-(\d+)$/.exec(entry);
    if (shell) {
      candidates.push({
        revision: Number(shell[1]),
        path: join(
          browsersDir,
          entry,
          'chrome-headless-shell-linux64',
          'chrome-headless-shell',
        ),
      });
    }
  }
  candidates.sort((a, b) => b.revision - a.revision);
  for (const candidate of candidates) {
    if (isExecutable(candidate.path)) return candidate.path;
  }
  return null;
}

/**
 * Probe the rendering capability WITHOUT launching a browser: a
 * Chromium executable Playwright can drive must be installed.
 */
export function probePdfCapability(): PdfCapability {
  const executablePath = resolveChromiumExecutable();
  if (executablePath) {
    return { ready: true, executablePath, missingPiece: null };
  }
  return {
    ready: false,
    executablePath: null,
    missingPiece: PDF_RENDERER_MISSING_PIECE,
  };
}

export interface RenderedReportPdf {
  bytes: Buffer;
  byteLength: number;
  pageCount: number;
}

export interface RenderReportPdfOptions {
  /**
   * Test seam: replace the browser launch (the gauntlet uses it to
   * prove the garbage-output refusal). Production callers omit it.
   */
  launcher?: () => Promise<Browser>;
  /**
   * Test seam: replace the capability probe (the gauntlet uses it to
   * prove the missing-browser typed refusal without uninstalling
   * Chromium). Production callers omit it.
   */
  probe?: () => PdfCapability;
}

async function launchDefaultBrowser(): Promise<Browser> {
  // The launch flags mirror the repo's existing Playwright driver
  // (src/lib/web-agent/playwright-driver.ts).
  const executablePath = resolveChromiumExecutable();
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
}

const PDF_FOOTER_TEMPLATE =
  '<div style="width: 100%; text-align: center; font-size: 14pt; color: #3A3934; font-family: Georgia, \'Times New Roman\', serif;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>';
const PDF_HEADER_TEMPLATE = '<span></span>';

/** The print template's @page margins (CTR-163), passed explicitly so
 * Chromium paginates to the template's design and leaves room for the
 * 14pt page-number footer. */
const PDF_MARGIN = { top: '17mm', bottom: '22mm', left: '20mm', right: '20mm' };

/**
 * Pin the only volatile bytes in Chromium's PDF output (the
 * info-dictionary /CreationDate and /ModDate wall-clock values) to
 * a fixed all-zero form, digit for digit, preserving every byte
 * length and xref offset. See the module header for why the
 * composed export service needs byte-stable renders.
 */
function pinVolatilePdfMetadata(bytes: Buffer): Buffer {
  const text = bytes.toString('latin1');
  const pinned = text.replace(
    /\/(CreationDate|ModDate)(\s*)\(([^)]*)\)/g,
    (_match, name: string, separator: string, inner: string) =>
      `/${name}${separator}(${inner.replace(/[0-9]/g, '0')})`,
  );
  return Buffer.from(pinned, 'latin1');
}

function countPdfPages(bytes: Buffer): number {
  const text = bytes.toString('latin1');
  const pagesNode = text.match(/\/Type\s*\/Pages[\s\S]{0,300}?\/Count\s+(\d+)/);
  if (pagesNode) return Number.parseInt(pagesNode[1], 10);
  const singles = text.match(/\/Type\s*\/Page(?![s\w])/g);
  return singles ? singles.length : 0;
}

function validatePdfBytes(bytes: Buffer): number {
  if (bytes.length < 1000) {
    throw new ReportPdfError(
      'EXPORT_RENDER_FAILED',
      `rendered output is ${bytes.length} bytes, below the minimum size of a real report PDF`,
    );
  }
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new ReportPdfError(
      'EXPORT_RENDER_FAILED',
      'rendered output does not start with the %PDF- header',
    );
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1');
  if (!tail.includes('%%EOF')) {
    throw new ReportPdfError(
      'EXPORT_RENDER_FAILED',
      'rendered output has no %%EOF trailer in its final 2048 bytes',
    );
  }
  const pageCount = countPdfPages(bytes);
  if (!Number.isFinite(pageCount) || pageCount < 1) {
    throw new ReportPdfError(
      'EXPORT_RENDER_FAILED',
      'rendered output declares no pages',
    );
  }
  return pageCount;
}

/**
 * Render CWE-038 print HTML to a validated PDF. Throws
 * ReportPdfError (typed, CWE-038-aligned codes) on every failure;
 * never returns unvalidated bytes.
 */
export async function renderCouncilReportPdf(
  printHtml: string,
  options: RenderReportPdfOptions = {},
): Promise<RenderedReportPdf> {
  if (typeof printHtml !== 'string' || !printHtml.includes('<html')) {
    throw new ReportPdfError(
      'EXPORT_RENDER_FAILED',
      'render input is not an HTML document',
    );
  }
  if (!options.launcher) {
    const capability = (options.probe ?? probePdfCapability)();
    if (!capability.ready) {
      throw new ReportPdfError(
        'EXPORT_FORMAT_NOT_READY',
        `The pdf deliverable cannot render in this environment: ${capability.missingPiece}`,
        capability.missingPiece,
      );
    }
  }
  let browser: Browser | null = null;
  try {
    browser = await (options.launcher ?? launchDefaultBrowser)();
    const page = await browser.newPage();
    await page.setContent(printHtml, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    // CTR-186: the report cover embeds one portrait per seat as a data URI
    // (nine `<img>` elements, ~1.3 MB of base64). `load` fires when the
    // documents are fetched, not when every image is decoded, so a print
    // snapshot taken straight after it can embed a different image raster
    // than a later snapshot of the SAME html. Since both renders must agree
    // byte for byte (the composed export service verifies a download against
    // the hash journaled at create time), settle the document first: fonts
    // ready, every image decoded, two frames flushed. Nothing about what is
    // printed changes — only that the paint has finished before it is taken.
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images).map((image) => image.decode().catch(() => undefined)),
      );
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
    const bytes = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: PDF_HEADER_TEMPLATE,
      footerTemplate: PDF_FOOTER_TEMPLATE,
      margin: PDF_MARGIN,
    });
    const buffer = pinVolatilePdfMetadata(Buffer.from(bytes));
    const pageCount = validatePdfBytes(buffer);
    return { bytes: buffer, byteLength: buffer.length, pageCount };
  } catch (err) {
    if (err instanceof ReportPdfError) throw err;
    throw new ReportPdfError(
      'EXPORT_RENDER_FAILED',
      `PDF render failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
