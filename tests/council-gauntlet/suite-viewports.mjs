/**
 * suite-viewports.mjs — CWE-044 gauntlet: T098 viewport matrix.
 *
 * Renders the gauntlet snapshots in Chromium at the full Section 32.6
 * matrix (320x780, 390x844, 768x1024, 1366x768, 1920x1080) plus the
 * 200%-zoom equivalents (683x384, 960x540 CSS px) and ASSERTS layout
 * from live geometry: all nine names present and exact, name type at
 * or above the 16px floor, no name clipping, no pairwise seat
 * overlap, no horizontal overflow, council touch targets at or above
 * the 44px product target. Screenshots are saved beside the results
 * as evidence, never as the assertion itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  OUT_DIR,
  ROSTER,
  fail,
  fileUrl,
  launchBrowser,
  pass,
} from './lib.mjs';

const MATRIX = [
  { w: 320, h: 780 },
  { w: 390, h: 844 },
  { w: 768, h: 1024 },
  { w: 1366, h: 768 },
  { w: 1920, h: 1080 },
];
const ZOOM = [
  { w: 683, h: 384, label: '1366x768-at-200pct' },
  { w: 960, h: 540, label: '1920x1080-at-200pct' },
];

async function measure(page, kind) {
  return page.evaluate((kind) => {
    const doc = document.documentElement;
    const out = {
      kind,
      innerWidth: window.innerWidth,
      scrollWidth: Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0),
    };
    out.horizontalOverflow = out.scrollWidth > window.innerWidth + 1;
    const seatSel =
      kind === 'reading'
        ? '[data-testid^="council-reading-row-"]'
        : '[data-testid^="council-seat-"]';
    const seats = Array.from(document.querySelectorAll(seatSel));
    out.seats = seats.map((el) => {
      const r = el.getBoundingClientRect();
      const nameEl = el.querySelector('.council-seat-name') ?? el;
      const nr = nameEl.getBoundingClientRect();
      const style = getComputedStyle(nameEl);
      return {
        testid: el.getAttribute('data-testid'),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        nameText: (nameEl.textContent ?? '').trim(),
        nameFontPx: parseFloat(style.fontSize),
        nameClipped:
          nameEl.scrollWidth > nameEl.clientWidth + 1 ||
          nameEl.scrollHeight > nameEl.clientHeight + 2,
        nameBox: { w: Math.round(nr.width), h: Math.round(nr.height) },
      };
    });
    out.overlaps = [];
    if (kind === 'room') {
      for (let i = 0; i < out.seats.length; i++) {
        for (let j = i + 1; j < out.seats.length; j++) {
          const a = out.seats[i];
          const b = out.seats[j];
          const ox =
            Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const oy =
            Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (ox > 2 && oy > 2) {
            out.overlaps.push([a.testid, b.testid, Math.round(ox), Math.round(oy)]);
          }
        }
      }
    }
    const targetSel =
      '.council-btn, .council-seat, [data-testid="council-view-room"], [data-testid="council-view-reading"]';
    out.smallTargets = Array.from(document.querySelectorAll(targetSel))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          testid: el.getAttribute('data-testid') ?? el.className,
          w: Math.round(r.width),
          h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0,
        };
      })
      .filter((t) => t.visible && (t.w < 44 || t.h < 44));
    out.verdictPresent = Boolean(
      document.querySelector('[data-testid="council-verdict"]'),
    );
    return out;
  }, kind);
}

function seatProblems(m, kind) {
  const problems = [];
  if (m.horizontalOverflow) {
    problems.push(`horizontal overflow: scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth}`);
  }
  if (kind === 'room' || kind === 'reading') {
    if (m.seats.length !== 9) problems.push(`expected 9 seats/rows, found ${m.seats.length}`);
    for (const seat of m.seats) {
      const id = seat.testid.replace('council-seat-', '').replace('council-reading-row-', '');
      const expected = ROSTER[id];
      if (expected && seat.nameText !== expected) {
        problems.push(`${seat.testid}: name "${seat.nameText}" != roster "${expected}"`);
      }
      if (seat.nameFontPx < 16) {
        problems.push(`${seat.testid}: name font ${seat.nameFontPx}px < 16px floor`);
      }
      if (seat.nameClipped) problems.push(`${seat.testid}: name clipped`);
    }
    if (m.overlaps.length > 0) {
      problems.push(`seat overlaps: ${JSON.stringify(m.overlaps)}`);
    }
  }
  return problems;
}

export async function run() {
  const checks = [];
  const browser = await launchBrowser();
  try {
    const pages = [
      { file: 'gauntlet-room.html', kind: 'room', label: 'room' },
      { file: 'gauntlet-reading.html', kind: 'reading', label: 'reading' },
      { file: 'gauntlet-session.html', kind: 'session', label: 'session' },
    ];
    for (const p of pages) {
      for (const vp of [...MATRIX, ...ZOOM]) {
        const vpLabel = vp.label ?? `${vp.w}x${vp.h}`;
        const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
        await page.goto(fileUrl(p.file), { waitUntil: 'networkidle' });
        const m = await measure(page, p.kind);
        const shot = `shot-${p.label}-${vpLabel}.png`;
        await page.screenshot({
          path: path.join(OUT_DIR, shot),
          fullPage: p.kind !== 'room',
        });
        const problems = seatProblems(m, p.kind);
        if (p.kind === 'session' && !m.verdictPresent) {
          problems.push('verdict article missing on composed session page');
        }
        const id = `T098-${p.label}-${vpLabel}`;
        checks.push(
          problems.length === 0
            ? pass(id, `${p.label} at ${vpLabel}: names legible, no overlap, no overflow`, JSON.stringify(m.seats?.length === 9 ? { seats: 9, minNameFont: Math.min(...m.seats.map((s) => s.nameFontPx)) } : { scrollWidth: m.scrollWidth }), shot)
            : fail(id, `${p.label} at ${vpLabel}`, problems.join('; '), shot),
        );
        // Touch targets asserted at phone + desktop sizes.
        if ((vp.w === 320 || vp.w === 1366) && !vp.label) {
          const tId = `T100-targets-${p.label}-${vpLabel}`;
          checks.push(
            m.smallTargets.length === 0
              ? pass(tId, `${p.label} at ${vpLabel}: all council controls >= 44px`, 'measured in Chromium')
              : fail(tId, `${p.label} at ${vpLabel}: controls below 44px`, JSON.stringify(m.smallTargets)),
          );
        }
        await page.close();
      }
    }
    // Journey pages: 320px usability (no two-dimensional scrolling)
    // and desktop.
    for (const p of [
      { file: 'gauntlet-journey-home.html', label: 'journey-home' },
      { file: 'gauntlet-journey-brief.html', label: 'journey-brief' },
    ]) {
      for (const vp of [MATRIX[0], MATRIX[3]]) {
        const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
        await page.goto(fileUrl(p.file), { waitUntil: 'networkidle' });
        const m = await measure(page, 'plain');
        const shot = `shot-${p.label}-${vp.w}x${vp.h}.png`;
        await page.screenshot({ path: path.join(OUT_DIR, shot), fullPage: true });
        const id = `T098-${p.label}-${vp.w}x${vp.h}`;
        checks.push(
          m.horizontalOverflow
            ? fail(id, `${p.label} at ${vp.w}x${vp.h}`, `horizontal overflow: scrollWidth ${m.scrollWidth} > ${vp.w}`, shot)
            : pass(id, `${p.label} at ${vp.w}x${vp.h}: no horizontal overflow`, `scrollWidth ${m.scrollWidth}`, shot),
        );
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { suite: 'viewports (T098)', checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { checks } = await run();
  for (const c of checks) console.log(`${c.status.toUpperCase()} ${c.id}: ${c.detail}`);
  if (!fs.existsSync(OUT_DIR)) throw new Error('no out dir');
  process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
}
