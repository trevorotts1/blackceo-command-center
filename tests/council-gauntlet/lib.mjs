/**
 * lib.mjs — shared helpers for the CWE-044 gauntlet Playwright suites.
 *
 * Everything measures the rendered snapshots/interactive page in a
 * real Chromium (the repo's own playwright dependency and the
 * browser build installed for it). No assertion in any suite is an
 * eyeball judgment: geometry, computed styles, and text content are
 * read from the live DOM.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export const OUT_DIR =
  process.env.GAUNTLET_OUT ??
  path.join(os.homedir(), 'workspace/skill77/cwe-044/evidence');

const require = createRequire(path.join(REPO_ROOT, 'package.json'));
export const { chromium } = require('playwright');

export async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    // Fall back to the installed headless shell build, the pattern
    // CWE-032's evidence script used on this machine.
    const shellRoot = path.join(os.homedir(), '.cache/ms-playwright');
    const shells = fs
      .readdirSync(shellRoot)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort();
    const exe = path.join(
      shellRoot,
      shells[shells.length - 1],
      'chrome-headless-shell-linux64/chrome-headless-shell',
    );
    return chromium.launch({ headless: true, executablePath: exe });
  }
}

export function fileUrl(name) {
  return `file://${path.join(OUT_DIR, name)}`;
}

/** Serve the evidence dir over loopback HTTP (needed for CDP network
 * emulation in the page-weight measurement). */
export function serveOutDir() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(
      /^\/+/,
      '',
    );
    const file = path.join(OUT_DIR, name);
    if (!file.startsWith(OUT_DIR) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    const type = name.endsWith('.html')
      ? 'text/html'
      : name.endsWith('.js')
        ? 'text/javascript'
        : name.endsWith('.css')
          ? 'text/css'
          : name.endsWith('.svg')
            ? 'image/svg+xml'
            : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => server.close(),
      });
    });
  });
}

/* ── WCAG 2.2 contrast math ──────────────────────────────────────── */
export function parseColor(text) {
  if (!text) return null;
  const m = String(text).match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/,
  );
  if (!m) return null;
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

export function compositeOver(fg, bg) {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
}

function luminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Effective background of an element: walk up compositing
 * non-transparent backgrounds; the page canvas is the last resort. */
export async function effectiveBackground(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const chain = [];
    let node = el;
    while (node) {
      chain.push(getComputedStyle(node).backgroundColor);
      node = node.parentElement;
    }
    return chain;
  }, selector);
}

export const ROSTER = {
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

export function check(id, name, status, detail, evidence) {
  return { id, name, status, detail, ...(evidence ? { evidence } : {}) };
}
export const pass = (id, name, detail, evidence) =>
  check(id, name, 'pass', detail, evidence);
export const fail = (id, name, detail, evidence) =>
  check(id, name, 'fail', detail, evidence);
export const pending = (id, name, detail) => check(id, name, 'pending_cwe050_rerun', detail);
export const notRun = (id, name, detail) => check(id, name, 'not_run', detail);
