// CTR-104 browser fixture: the real CouncilHome chamber entry, rendered in
// Chromium from this tree's actual components (esbuild bundle, stubbed
// authorized reads). Proves, by live geometry rather than eyeball:
//   • clicking Council lands on the chamber: nine seats render and no
//     intake form is mounted on entry;
//   • the question box is a native GET form to /council/new;
//   • at 320/390/768/1366 px there is no horizontal page overflow, the
//     room stays inside the viewport, and the question input + submit keep
//     the 44px touch target;
//   • opening the chamber issues exactly the two authorized GET reads and
//     no POST/mutation of any kind.
// Screenshots and a JSON measurement file are written as evidence.
//
//   node tests/browser/council-chamber-entry.mjs
// Env: COUNCIL_SOURCE_ROOT, COUNCIL_OUTPUT_DIR, COUNCIL_CHROME_PATH.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root =
  process.env.COUNCIL_SOURCE_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output =
  process.env.COUNCIL_OUTPUT_DIR ||
  path.join(root, '..', 'evidence', 'council-chamber-entry');
mkdirSync(output, { recursive: true });

const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { CouncilPageShell } from './src/components/council/CouncilPageShell';
      import { CouncilHome } from './src/components/council/CouncilHome';
      const envelope = (data) => ({ ok: true, data, request_id: 'req-fixture' });
      const calls = [];
      window.__calls = calls;
      window.fetch = async (input, init) => {
        const url = String(input);
        calls.push({ url, method: (init && init.method) || 'GET' });
        if (url.startsWith('/api/council/capabilities')) {
          return { ok: true, status: 200, json: async () => envelope({
            foundation: { unit: 'CWE-029', scope: 'fixture', registry_contract: 'c',
              route_ownership_after_acceptance: 'CWE-050' },
            endpoints: { total: 31, ready: 8, not_ready: 23, by_owning_unit: {} },
            routes: { total: 1, by_readiness: { UNTESTED: 1 }, runtime_verified: false },
            principal: { subject: 'fixture-principal' },
          }) };
        }
        if (url.startsWith('/api/council/sessions?')) {
          return { ok: true, status: 200, json: async () => envelope({
            sessions: [{
              session_id: 'sess-ctr104-fixture', mode: 'full', visibility: 'private',
              state: 'DRAFT', state_version: 1, brief_revision: 1, archived: false,
              owner_subject: 'owner:fixture',
              created_at: '2026-10-29T00:00:00.000Z', updated_at: '2026-10-29T00:00:00.000Z',
            }],
            count: 1, total_in_scope: 1,
          }) };
        }
        return { ok: false, status: 404, json: async () => ({ ok: false, error: {
          code: 'NOT_FOUND', message: 'unstubbed ' + url, retryable: false, action: 'fix_request' } }) };
      };
      // Mount inside the real page shell, exactly as src/app/council/page.tsx
      // does: the shell supplies the .council-theme token wrapper.
      window.mount = () =>
        createRoot(document.getElementById('root')).render(
          React.createElement(
            CouncilPageShell,
            { title: 'Council of Wise Elders' },
            React.createElement(CouncilHome),
          ),
        );
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  loader: { '.css': 'empty', '.svg': 'dataurl' },
  alias: {
    'next/link': path.join(root, 'tests/browser/stubs/next-link.tsx'),
    '@': path.join(root, 'src'),
  },
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});

const css = ['council-theme.css', 'council-room.css', 'council-journey.css']
  .map((file) => readFileSync(path.join(root, 'src/components/council', file), 'utf8'))
  .join('\n');
const script = bundle.outputFiles[0].text;

const browser = await chromium.launch(
  process.env.COUNCIL_CHROME_PATH ? { executablePath: process.env.COUNCIL_CHROME_PATH } : {},
);
const page = await browser.newPage();
const measurements = [];
try {
  for (const width of [320, 390, 768, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><div id="root"></div>',
    );
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.mount());
    await page.locator('[data-testid="council-room"]').last().waitFor();
    await page.locator('[data-testid="council-sessions-list"]').waitFor();

    const measured = await page.evaluate(() => {
      const rect = (element) => {
        const r = element.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
          right: Math.round(r.right),
        };
      };
      const chamber = document.querySelector('[data-testid="council-chamber"]');
      const room = document.querySelector('[data-testid="council-room"]');
      const guided = document.querySelector('[data-testid="council-chamber-guided-intake"]');
      const form = document.querySelector('[data-testid="council-chamber-ask"]');
      const input = document.querySelector('[data-testid="council-chamber-question"]');
      const submit = document.querySelector('[data-testid="council-chamber-submit"]');
      return {
        viewport: window.innerWidth,
        pageWidth: Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0,
        ),
        pageShellMounted: Boolean(document.querySelector('[data-testid="council-page-shell"]')),
        seats: document.querySelectorAll('[data-testid^="council-seat-"]').length,
        modeBadge: document.querySelector('[data-testid="council-mode-badge"]')?.textContent,
        intakeMounted: Boolean(document.querySelector('[data-testid="decision-composer"]')),
        formAction: form?.getAttribute('action') ?? null,
        formMethod: (form?.getAttribute('method') ?? '').toLowerCase() || null,
        inputName: input?.getAttribute('name') ?? null,
        inputRequired: Boolean(input?.required),
        inputRect: input ? rect(input) : null,
        submitRect: submit ? rect(submit) : null,
        // Raw (unrounded) heights: the 44px floor is a CSS contract and a
        // fractional sub-pixel box must not read as a failure.
        inputHeight: input ? input.getBoundingClientRect().height : 0,
        submitHeight: submit ? submit.getBoundingClientRect().height : 0,
        roomRect: room ? rect(room) : null,
        chamberRect: chamber ? rect(chamber) : null,
        roomBeforeGuided: Boolean(
          room &&
            guided &&
            room.compareDocumentPosition(guided) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        calls: window.__calls ?? [],
      };
    });

    measurements.push({ width, ...measured });

    assert.equal(measured.viewport, width);
    assert.ok(measured.pageShellMounted, 'rendered inside the real council page shell');
    assert.equal(measured.seats, 9, `nine seats at ${width}px`);
    assert.equal(measured.modeBadge, 'Chamber open', 'honest pre-sitting room badge');
    assert.equal(measured.intakeMounted, false, `intake form must not mount on entry (${width}px)`);
    assert.equal(measured.formAction, '/council/new');
    assert.equal(measured.formMethod, 'get');
    assert.equal(measured.inputName, 'question');
    assert.equal(measured.inputRequired, true);
    assert.ok(measured.roomBeforeGuided, `chamber renders before the intake link (${width}px)`);
    assert.ok(measured.roomRect.x >= 0, `room starts inside the viewport (${width}px)`);
    assert.ok(
      measured.roomRect.right <= width + 1,
      `room fits the viewport (${width}px): ${measured.roomRect.right}`,
    );
    assert.ok(
      measured.pageWidth <= width + 1,
      `no horizontal page overflow (${width}px): ${measured.pageWidth}`,
    );
    assert.ok(measured.inputHeight >= 43.5, `question input is 44px tall (${width}px): ${measured.inputHeight}`);
    assert.ok(measured.submitHeight >= 43.5, `submit is 44px tall (${width}px): ${measured.submitHeight}`);
    assert.equal(measured.calls.length, 2, `only the two authorized reads (${width}px)`);
    assert.ok(measured.calls.every((call) => call.method === 'GET'), 'no mutation on open');

    await page.screenshot({
      path: path.join(output, `council-chamber-${width}.png`),
      fullPage: true,
    });
  }

  const mutations = measurements
    .flatMap((m) => m.calls)
    .filter((call) => call.method !== 'GET');
  assert.equal(mutations.length, 0, 'opening the chamber never mutates anything');
  const startCalls = measurements
    .flatMap((m) => m.calls)
    .filter((call) => call.url.includes('/start') || call.url.includes('/models'));
  assert.equal(startCalls.length, 0, 'opening the chamber starts no run and reads no model catalog');

  writeFileSync(
    path.join(output, 'council-chamber-entry.json'),
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
  console.log(
    `PASS ${measurements.length} real-browser chamber-entry viewports: chamber first, nine seats, native question form, 44px targets, no overflow, reads only`,
  );
} finally {
  await browser.close();
}
