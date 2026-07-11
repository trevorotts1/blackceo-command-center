// Isolated screenshot + layout-audit harness for the redesign pass.
// Usage: node scripts/dev-shots.mjs <LABEL> <outDir> [route ...]
// Captures viewport + full-page PNGs at mobile/tablet/desktop for each route
// and prints a JSON layout audit (horizontal overflow + unreachable clipped
// content) per route/breakpoint.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.SHOT_BASE || `http://localhost:${process.env.PORT || 4000}`;
const [, , LABEL = 'SHOT', OUT_DIR = '.dev-shots', ...routesArg] = process.argv;

const ROUTES = routesArg.length
  ? routesArg
  : ['/', '/tasks/all', '/ceo-board', '/ceo-board/departments', '/settings', '/settings/intelligence', '/tasks/by-department'];

const BREAKPOINTS = [
  { name: 'mobile-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1440', width: 1440, height: 900 },
];

const slug = (r) => (r === '/' ? 'home' : r.replace(/^\//, '').replace(/\//g, '-'));

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 2 });
await context.addInitScript(() => {
  // suppress first-run walkthrough decks
  const decks = ['home', 'kanban', 'ceo-board', 'operator', 'settings', 'conversational-ai', 'tasks-all', 'tasks-by-department', 'departments', 'intelligence', 'company', 'workspace'];
  try { decks.forEach((d) => localStorage.setItem(`bcc-${d}-walkthrough-seen`, '1')); } catch {}
});
const page = await context.newPage();

// Warm the interview-gate cookie: hit / (302 -> /interview), let the
// InterviewGateSync server action mint the signed cookie, then proceed.
await page.goto(BASE + '/', { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(1500);

const audit = [];
for (const route of ROUTES) {
  for (const bp of BREAKPOINTS) {
    await page.setViewportSize({ width: bp.width, height: bp.height });
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      await page.goto(BASE + route, { waitUntil: 'networkidle' }).catch(() => {});
      ok = !page.url().includes('/interview');
      if (!ok) await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(1200); // let framer-motion entrances settle
    const file = `${LABEL}-${slug(route)}-${bp.name}`;
    await page.screenshot({ path: path.join(OUT_DIR, `${file}.png`) });
    await page.screenshot({ path: path.join(OUT_DIR, `${file}-full.png`), fullPage: true }).catch(() => {});

    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const vw = window.innerWidth;
      const horizOverflow = Math.max(0, doc.scrollWidth - vw);
      // offenders: elements wider than viewport
      const wide = [];
      document.querySelectorAll('body *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > vw + 1 && wide.length < 6) {
          wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} w=${Math.round(r.width)}`);
        }
      });
      // unreachable clipped content: scrollHeight > clientHeight but overflowY
      // is visible/hidden AND some ancestor hides overflow (content cut off)
      const clipped = [];
      document.querySelectorAll('body *').forEach((el) => {
        if (clipped.length >= 6) return;
        const cs = getComputedStyle(el);
        if ((cs.overflowY === 'hidden') && el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 40) {
          clipped.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} client=${el.clientHeight} scroll=${el.scrollHeight}`);
        }
      });
      return {
        vw,
        vh: window.innerHeight,
        docScrollHeight: doc.scrollHeight,
        pageScrolls: doc.scrollHeight > window.innerHeight,
        horizOverflow,
        wide,
        clipped,
      };
    });
    audit.push({ route, bp: bp.name, url: page.url(), ...metrics });
  }
}

console.log(JSON.stringify(audit, null, 1));
await browser.close();
