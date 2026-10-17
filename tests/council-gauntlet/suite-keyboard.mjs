/**
 * suite-keyboard.mjs — CWE-044 gauntlet: T099 keyboard, focus,
 * reduced-motion, and zoom behavior over the INTERACTIVE harness
 * page (the tree's real CouncilShell + CouncilVerdict components
 * bundled by build-interactive.mjs and driven in Chromium).
 *
 * Assertions: every seat and control is reachable by Tab in roster
 * order; focus is visibly styled under keyboard focus; the seat
 * drawer traps Tab, closes on Escape, and restores focus to the
 * opening seat; the view toggle works from the keyboard; the source
 * drawer opens from the keyboard and carries the seat's Section 7
 * profile label; under prefers-reduced-motion the shell mirrors the
 * preference, transitions collapse, and the same content is present.
 */
import { ROSTER, fail, launchBrowser, pass, serveOutDir } from './lib.mjs';

const SEAT_ORDER = Object.keys(ROSTER);

async function tabSequence(page, maxTabs = 70) {
  const seq = [];
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return {
        testid: el.getAttribute('data-testid'),
        tag: el.tagName,
        text: (el.textContent ?? '').trim().slice(0, 40),
      };
    });
    if (!info) break;
    seq.push(info);
    if (seq.length > 3 && info.testid === seq[0].testid) break;
  }
  return seq;
}

async function focusStyle(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      outlineStyle: s.outlineStyle,
      outlineWidth: parseFloat(s.outlineWidth),
      boxShadow: s.boxShadow,
    };
  });
}

export async function run() {
  const checks = [];
  const browser = await launchBrowser();
  // The interactive bundle is an ES module: Chromium refuses module
  // scripts over file://, so the harness page is served over loopback.
  const server = await serveOutDir();
  const fileUrl = (name) => `${server.base}/${name}`;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await page.goto(fileUrl('gauntlet-interactive.html'), { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="council-room"]', { timeout: 20000 });

    /* ── Tab order ─────────────────────────────────────────────── */
    const seq = await tabSequence(page);
    const seatHits = seq
      .map((s) => s.testid)
      .filter((t) => t && t.startsWith('council-seat-'))
      .map((t) => t.replace('council-seat-', ''));
    const inOrder =
      JSON.stringify(seatHits) === JSON.stringify(SEAT_ORDER);
    checks.push(
      seatHits.length === 9 && inOrder
        ? pass('T099-tab-order', 'all nine seats reachable by Tab in roster order', JSON.stringify(seatHits))
        : fail('T099-tab-order', 'seat Tab reachability/order', `hits=${JSON.stringify(seatHits)}`),
    );
    const needed = [
      'council-view-room',
      'council-view-reading',
      'verdict-sources-simon-sinek',
      // The fixture verdict's second card is Aliche's (seat tiffany-aliche).
      'verdict-sources-tiffany-aliche',
    ];
    const seen = new Set(seq.map((s) => s.testid));
    const missing = needed.filter((t) => !seen.has(t));
    checks.push(
      missing.length === 0
        ? pass('T099-reachability', 'view toggles and verdict source controls reachable by keyboard', `focusables seen: ${seq.length}`)
        : fail('T099-reachability', 'keyboard reachability', `missing: ${missing.join(', ')}`),
    );

    /* ── Focus visibility ──────────────────────────────────────── */
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      document.body.focus();
    });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const style = await focusStyle(page);
    checks.push(
      style && (style.outlineStyle !== 'none' || (style.boxShadow && style.boxShadow !== 'none'))
        ? pass('T099-focus-visible', 'keyboard focus carries a visible style', JSON.stringify(style))
        : fail('T099-focus-visible', 'focus visibility', JSON.stringify(style)),
    );

    /* ── Seat drawer: open, trap, escape, restore ──────────────── */
    await page.evaluate(() => {
      document.querySelector('[data-testid="council-seat-td-jakes"]')?.scrollIntoView();
    });
    let guard = 0;
    while (guard++ < 40) {
      const active = await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid'),
      );
      if (active === 'council-seat-td-jakes') break;
      await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Enter');
    const drawerOpen = await page
      .waitForSelector('[role="dialog"]', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    let trapOk = false;
    let focusInside = false;
    if (drawerOpen) {
      focusInside = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return Boolean(d && d.contains(document.activeElement));
      });
      trapOk = true;
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate(() => {
          const d = document.querySelector('[role="dialog"]');
          return Boolean(d && d.contains(document.activeElement));
        });
        if (!inside) {
          trapOk = false;
          break;
        }
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      const restored = await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid'),
      );
      checks.push(
        restored === 'council-seat-td-jakes'
          ? pass('T099-drawer-restore', 'Escape closes the seat drawer and focus returns to the opening seat', `active=${restored}`)
          : fail('T099-drawer-restore', 'drawer focus restore', `active=${restored}`),
      );
    }
    checks.push(
      drawerOpen && focusInside && trapOk
        ? pass('T099-drawer-trap', 'seat drawer opens from keyboard, takes focus, and traps Tab', 'role=dialog')
        : fail('T099-drawer-trap', 'seat drawer keyboard behavior', `open=${drawerOpen} inside=${focusInside} trap=${trapOk}`),
    );

    /* ── View toggle by keyboard ───────────────────────────────── */
    await page.evaluate(() => {
      document.querySelector('[data-testid="council-view-reading"]')?.focus();
    });
    await page.keyboard.press('Enter');
    const readingShown = await page
      .waitForSelector('[data-testid="council-reading-view"]', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    const rowCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid^="council-reading-row-"]').length,
    );
    checks.push(
      readingShown && rowCount === 9
        ? pass('T099-view-toggle', 'Reading view toggles from the keyboard with all nine rows', `rows=${rowCount}`)
        : fail('T099-view-toggle', 'view toggle', `shown=${readingShown} rows=${rowCount}`),
    );
    await page.evaluate(() => {
      document.querySelector('[data-testid="council-view-room"]')?.focus();
    });
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="council-room"]', { timeout: 5000 });

    /* ── Source drawer carries the seat profile label ──────────── */
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="verdict-sources-simon-sinek"]')
        ?.scrollIntoView();
      document
        .querySelector('[data-testid="verdict-sources-simon-sinek"]')
        ?.focus();
    });
    await page.keyboard.press('Enter');
    const labelSeen = await page
      .waitForFunction(
        () =>
          document.body.textContent?.includes(
            'AI perspective inspired by the published work of Simon Sinek. Not the individual and not an endorsement.',
          ),
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
    checks.push(
      labelSeen
        ? pass('T099-source-drawer-label', 'source drawer opens from the keyboard and shows the seat Section 7 profile label', 'Simon Sinek profile label')
        : fail('T099-source-drawer-label', 'source drawer label', 'profile label text not found after opening the drawer'),
    );
    await page.keyboard.press('Escape');
    await ctx.close();

    /* ── Reduced motion ────────────────────────────────────────── */
    const rmCtx = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      reducedMotion: 'reduce',
    });
    const rmPage = await rmCtx.newPage();
    await rmPage.goto(fileUrl('gauntlet-interactive.html'), { waitUntil: 'networkidle' });
    await rmPage.waitForSelector('[data-testid="council-room"]', { timeout: 20000 });
    const rm = await rmPage.evaluate(() => {
      const shell = document.querySelector('[data-testid="council-shell"]');
      const seat = document.querySelector('[data-testid="council-seat-simon-sinek"]');
      return {
        mirrored: shell?.getAttribute('data-reduced-motion'),
        transitionMs: seat
          ? Math.max(
              ...getComputedStyle(seat)
                .transitionDuration.split(',')
                .map((d) => parseFloat(d) * (d.includes('ms') && !d.includes('s,') ? 1 : 1000) || 0),
            )
          : null,
        seatCount: document.querySelectorAll('[data-testid^="council-seat-"]').length,
        names: Array.from(
          document.querySelectorAll('[data-testid^="council-seat-"] .council-seat-name'),
        ).map((n) => (n.textContent ?? '').trim()),
      };
    });
    const expectedNames = Object.values(ROSTER);
    checks.push(
      rm.mirrored === 'true' &&
        rm.seatCount === 9 &&
        JSON.stringify(rm.names) === JSON.stringify(expectedNames)
        ? pass('T099-reduced-motion-content', 'reduced motion: preference mirrored, same nine seats and names, no information loss', `data-reduced-motion=${rm.mirrored}`)
        : fail('T099-reduced-motion-content', 'reduced motion content equivalence', JSON.stringify(rm)),
    );
    checks.push(
      rm.transitionMs !== null && rm.transitionMs <= 20
        ? pass('T099-reduced-motion-transitions', 'reduced motion: seat transition durations collapse', `${rm.transitionMs}ms`)
        : fail('T099-reduced-motion-transitions', 'reduced motion transitions', `${rm.transitionMs}ms`),
    );
    await rmCtx.close();

    /* ── 200% zoom on the interactive page ─────────────────────── */
    const zCtx = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const zPage = await zCtx.newPage();
    await zPage.goto(fileUrl('gauntlet-interactive.html'), { waitUntil: 'networkidle' });
    await zPage.waitForSelector('[data-testid="council-room"]', { timeout: 20000 });
    const zoom = await zPage.evaluate(() => ({
      overflow:
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) >
        window.innerWidth + 1,
      seats: document.querySelectorAll('[data-testid^="council-seat-"]').length,
    }));
    checks.push(
      !zoom.overflow && zoom.seats === 9
        ? pass('T099-zoom-200', 'at 200% zoom (960x540 CSS px) the room fits without horizontal overflow and keeps nine seats', JSON.stringify(zoom))
        : fail('T099-zoom-200', '200% zoom room', JSON.stringify(zoom)),
    );
    await zCtx.close();
  } finally {
    await browser.close();
    server.close();
  }
  return { suite: 'keyboard and motion (T099)', checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { checks } = await run();
  for (const c of checks) console.log(`${c.status.toUpperCase()} ${c.id}: ${c.detail}`);
  process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
}
