/**
 * suite-contrast.mjs — CWE-044 gauntlet: T100 per-client theme
 * contrast, measured on rendered pages in Chromium.
 *
 * For each representative client primary the repo itself resolves
 * (src/lib/branding.ts COLOR_NAME_MAP + the BlackCEO fallback), the
 * snapshot generator emitted the council room and council home with
 * the :root variables that buildThemeVars (the exact function
 * <BrandTheme/> uses) produces for that primary. This suite reads
 * computed foreground/background pairs from the live DOM, composites
 * translucent layers, computes WCAG 2.2 ratios, and asserts the
 * Section 23 floors (4.5:1 ordinary text).
 *
 * Named regression checks carried from CWE-031: the primary button
 * hover pair (white on the accent-ink step; measured 4.12:1 before
 * CWE-031's fix, corrected to 7.07:1 on the default theme) and the
 * stage state-badge pairs (lightened on the stage by CWE-031) must
 * hold under EVERY client theme, not only the default.
 */
import {
  compositeOver,
  contrastRatio,
  fail,
  fileUrl,
  launchBrowser,
  parseColor,
  pass,
} from './lib.mjs';

const THEMES = [
  'blackceo',
  'navy',
  'burgundy',
  'gold',
  'coral',
  'charcoal',
  'purple',
  'yellow',
];

/** Probe specs: name -> selector of a representative text element. */
const ROOM_PROBES = [
  { name: 'footer label (meta on canvas)', sel: '[data-testid="council-shell"] > p.council-meta' },
  { name: 'view toggle pressed (accent-ink on accent-wash)', sel: '[data-testid="council-view-room"]' },
  { name: 'view toggle quiet (accent-ink on surface-2)', sel: '[data-testid="council-view-reading"]' },
  { name: 'seat name (stage-ink on stage-raised)', sel: '.council-stage .council-seat-name' },
  { name: 'seat role (stage-muted on stage-raised)', sel: '.council-stage .council-seat-role' },
  { name: 'room center meta (stage-muted on stage)', sel: '.council-room-center .council-meta' },
];
const STATE_CLASSES = [
  'council-state-support',
  'council-state-conditional',
  'council-state-oppose',
  'council-state-abstain',
];

async function probe(page, sel) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const chain = [];
    let node = el;
    while (node) {
      chain.push(getComputedStyle(node).backgroundColor);
      node = node.parentElement;
    }
    const s = getComputedStyle(el);
    return { fg: s.color, chain, fontPx: parseFloat(s.fontSize) };
  }, sel);
}

function ratioOf(p) {
  if (!p) return null;
  let bg = { r: 255, g: 255, b: 255, a: 1 };
  const layers = p.chain
    .map(parseColor)
    .filter((c) => c && c.a > 0)
    .reverse();
  for (const layer of layers) bg = compositeOver(layer, bg);
  const fg = compositeOver(parseColor(p.fg), bg);
  return { ratio: contrastRatio(fg, bg), fg: p.fg, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` };
}

export async function run() {
  const checks = [];
  const browser = await launchBrowser();
  try {
    for (const theme of THEMES) {
      const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
      await page.goto(fileUrl(`gauntlet-room-theme-${theme}.html`), {
        waitUntil: 'networkidle',
      });
      const results = [];
      const missing = [];
      for (const spec of ROOM_PROBES) {
        const r = ratioOf(await probe(page, spec.sel));
        if (r) results.push({ ...spec, ...r });
        else missing.push(spec.name);
      }
      for (const cls of STATE_CLASSES) {
        const r = ratioOf(await probe(page, `.council-stage .${cls}`));
        if (r) results.push({ name: `state badge ${cls} on stage`, ...r });
        else missing.push(`state badge ${cls}`);
      }
      const missingNote =
        missing.length > 0
          ? ` | not present in fixture, not measured: ${missing.join(', ')}`
          : '';
      const below = results.filter((r) => r.ratio < 4.5);
      checks.push(
        below.length === 0
          ? pass(
              `T100-theme-${theme}`,
              `theme ${theme}: all ${results.length} measured text pairs >= 4.5:1`,
              results.map((r) => `${r.name}=${r.ratio.toFixed(2)}`).join('; ') + missingNote,
            )
          : fail(
              `T100-theme-${theme}`,
              `theme ${theme}: pairs below 4.5:1`,
              below
                .map((r) => `${r.name}=${r.ratio.toFixed(2)} (fg ${r.fg} on ${r.bg})`)
                .join('; '),
            ),
      );
      const stageStates = results.filter((r) => r.name.startsWith('state badge'));
      const stageBelow = stageStates.filter((r) => r.ratio < 4.5);
      checks.push(
        stageStates.length > 0 && stageBelow.length === 0
          ? pass(
              `T100-regression-stage-states-${theme}`,
              `theme ${theme}: stage state badges keep 4.5:1 (CWE-031 regression)`,
              stageStates.map((r) => `${r.name}=${r.ratio.toFixed(2)}`).join('; '),
            )
          : fail(
              `T100-regression-stage-states-${theme}`,
              `theme ${theme}: stage state badge contrast`,
              stageBelow.map((r) => `${r.name}=${r.ratio.toFixed(2)}`).join('; ') || 'no state badges found',
            ),
      );
      await page.close();

      /* Primary button under this theme, rest + hover. */
      const home = await browser.newPage({ viewport: { width: 1366, height: 768 } });
      await home.goto(fileUrl(`gauntlet-journey-home-theme-${theme}.html`), {
        waitUntil: 'networkidle',
      });
      const rest = ratioOf(await probe(home, '[data-testid="council-ask"]'));
      await home.hover('[data-testid="council-ask"]');
      await home.waitForTimeout(250);
      const hover = ratioOf(await probe(home, '[data-testid="council-ask"]'));
      checks.push(
        rest && rest.ratio >= 4.5
          ? pass(`T100-primary-rest-${theme}`, `theme ${theme}: primary action text on accent fill`, `${rest.ratio.toFixed(2)}:1 (fg ${rest.fg} on ${rest.bg})`)
          : fail(`T100-primary-rest-${theme}`, `theme ${theme}: primary action rest contrast`, rest ? `${rest.ratio.toFixed(2)}:1 (fg ${rest.fg} on ${rest.bg})` : 'button not found'),
      );
      checks.push(
        hover && hover.ratio >= 4.5
          ? pass(`T100-regression-hover-${theme}`, `theme ${theme}: primary hover pair keeps 4.5:1 (CWE-031 regression: was 4.12:1 pre-fix on default)`, `${hover.ratio.toFixed(2)}:1 (fg ${hover.fg} on ${hover.bg})`)
          : fail(`T100-regression-hover-${theme}`, `theme ${theme}: primary hover contrast`, hover ? `${hover.ratio.toFixed(2)}:1 (fg ${hover.fg} on ${hover.bg})` : 'button not found'),
      );
      await home.close();
    }
  } finally {
    await browser.close();
  }
  return { suite: 'theme contrast (T100)', checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { checks } = await run();
  for (const c of checks) console.log(`${c.status.toUpperCase()} ${c.id}: ${c.detail}`);
  process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
}
