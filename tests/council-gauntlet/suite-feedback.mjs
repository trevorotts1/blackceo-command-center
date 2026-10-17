/**
 * suite-feedback.mjs — CWE-044 gauntlet: the two browser-side T154
 * budgets (Section 32.6).
 *
 *   - Local interface action feedback p95 <= 200 ms: on the
 *     interactive harness page (real CouncilShell in Chromium), the
 *     Room/Reading view toggle is clicked 30 times; each sample runs
 *     from the click to the toggled view being present in the DOM.
 *   - Initial council page usable <= 3 s on a cold-cache 10 Mbps /
 *     100 ms RTT link: the room snapshot page is served over loopback
 *     with CDP network throttling; the sample runs from navigation
 *     start to the room being rendered. Disclosed scope: the page
 *     payload (HTML + inlined CSS) crosses the throttled link; the
 *     medallion images are local files and do not, which makes this
 *     a floor measurement of first paint, labeled as such.
 *
 * Machine-relative: loaded 2-CPU VM, 2026-10-14.
 */
import { fail, launchBrowser, pass, serveOutDir } from './lib.mjs';

function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

export async function run() {
  const checks = [];
  const browser = await launchBrowser();
  const server = await serveOutDir();
  try {
    /* ── Local action feedback ─────────────────────────────────── */
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await page.goto(`${server.base}/gauntlet-interactive.html`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('[data-testid="council-room"]', { timeout: 20000 });
    // Measured IN the page: a MutationObserver timestamps the moment
    // the toggled view lands in the DOM after an in-page click, so
    // the sample is the app's own feedback loop, not the test
    // driver's round trips (which on this loaded VM measure the
    // driver, at several hundred ms per call).
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const toReading = i % 2 === 0;
      const buttonSel = toReading
        ? '[data-testid="council-view-reading"]'
        : '[data-testid="council-view-room"]';
      const targetTestId = toReading ? 'council-reading-view' : 'council-room';
      const ms = await page.evaluate(
        ({ buttonSel, targetTestId }) =>
          new Promise((resolve, reject) => {
            const target = document.querySelector(
              `[data-testid="${targetTestId}"]`,
            );
            if (target) return resolve(0);
            const started = performance.now();
            const observer = new MutationObserver(() => {
              if (document.querySelector(`[data-testid="${targetTestId}"]`)) {
                observer.disconnect();
                resolve(performance.now() - started);
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            const button = document.querySelector(buttonSel);
            if (!button) {
              observer.disconnect();
              return reject(new Error(`button ${buttonSel} not found`));
            }
            button.click();
            setTimeout(() => {
              observer.disconnect();
              reject(new Error('toggle target never appeared'));
            }, 5000);
          }),
        { buttonSel, targetTestId },
      );
      samples.push(ms);
      await page.waitForTimeout(30);
    }
    const feedbackP95 = p95(samples);
    checks.push(
      feedbackP95 <= 200
        ? pass(
            'T154-local-feedback',
            'local interface action feedback (view toggle) p95 within 200 ms',
            `n=30 p95=${feedbackP95.toFixed(1)}ms max=${Math.max(...samples).toFixed(1)}ms`,
          )
        : fail(
            'T154-local-feedback',
            'local interface action feedback p95',
            `n=30 p95=${feedbackP95.toFixed(1)}ms exceeds 200ms`,
          ),
    );
    await page.close();

    /* ── Initial load under throttling ─────────────────────────── */
    const ctx = await browser.newContext();
    const cold = await ctx.newPage();
    const cdp = await ctx.newCDPSession(cold);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 100,
      downloadThroughput: (10 * 1024 * 1024) / 8,
      uploadThroughput: (10 * 1024 * 1024) / 8,
    });
    await cdp.send('Network.clearBrowserCache').catch(() => undefined);
    const startedAt = Date.now();
    await cold.goto(`${server.base}/gauntlet-room.html`, {
      waitUntil: 'load',
      timeout: 30000,
    });
    await cold.waitForSelector('[data-testid="council-room"]', { timeout: 30000 });
    const usableMs = Date.now() - startedAt;
    checks.push(
      usableMs <= 3000
        ? pass(
            'T154-initial-load',
            'initial council page usable within 3 s at 10 Mbps / 100 ms RTT (cold cache)',
            `${usableMs}ms to rendered room`,
          )
        : fail(
            'T154-initial-load',
            'initial load budget',
            `${usableMs}ms exceeds 3000ms`,
          ),
    );
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
  return { suite: 'interface feedback and initial load (T154)', checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { checks } = await run();
  for (const c of checks) console.log(`${c.status.toUpperCase()} ${c.id}: ${c.detail}`);
  process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
}
