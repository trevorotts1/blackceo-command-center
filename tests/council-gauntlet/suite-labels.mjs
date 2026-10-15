/**
 * suite-labels.mjs — CWE-044 gauntlet: the composed-page Section 7
 * label check (carried from CWE-034).
 *
 * CWE-034's evidence render was the bare CouncilVerdict component;
 * the label sentence lives in shell chrome. This suite asserts, on
 * the COMPOSED pages this tree actually renders, that wherever
 * seat-attributed content appears the Section 7 attribution line is
 * present and visible on the same page: the journey shell form on
 * journey pages, the room shell form on the session page (where it
 * must co-exist with the verdict article and follow the room in DOM
 * order), and the per-seat profile label in the source drawer
 * (asserted by suite-keyboard on the interactive page).
 *
 * If a future composition (CWE-050) drops the shell or moves verdict
 * content off the labeled page, these checks fail there, by design.
 */
import { fail, fileUrl, launchBrowser, pass } from './lib.mjs';

const PAGE_SHELL_LABEL =
  'Each council member is an AI perspective inspired by the published work of the named author. Not the individual and not an endorsement.';
const ROOM_SHELL_LABEL_PARTS = [
  'Each member is an AI perspective inspired by the published work of the named author.',
  'Not the individual and not an endorsement.',
];

async function labelVisible(page, text) {
  return page.evaluate((text) => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
    );
    let node = walker.nextNode();
    while (node) {
      const el = node;
      if (
        el.children.length === 0 &&
        (el.textContent ?? '').includes(text)
      ) {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          found: true,
          visible:
            r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden',
          tag: el.tagName,
        };
      }
      node = walker.nextNode();
    }
    return { found: false, visible: false, tag: null };
  }, text);
}

export async function run() {
  const checks = [];
  const browser = await launchBrowser();
  try {
    for (const p of [
      { file: 'gauntlet-journey-home.html', label: 'journey home' },
      { file: 'gauntlet-journey-brief.html', label: 'journey brief review' },
    ]) {
      const page = await browser.newPage();
      await page.goto(fileUrl(p.file), { waitUntil: 'networkidle' });
      const res = await labelVisible(page, PAGE_SHELL_LABEL);
      checks.push(
        res.found && res.visible
          ? pass(`LABEL-${p.label}`, `${p.label}: Section 7 label line present and visible in page shell`, `element=${res.tag}`)
          : fail(`LABEL-${p.label}`, `${p.label}: Section 7 label line`, JSON.stringify(res)),
      );
      await page.close();
    }

    for (const p of [
      { file: 'gauntlet-room.html', label: 'room' },
      { file: 'gauntlet-reading.html', label: 'reading view' },
    ]) {
      const page = await browser.newPage();
      await page.goto(fileUrl(p.file), { waitUntil: 'networkidle' });
      const parts = [];
      for (const part of ROOM_SHELL_LABEL_PARTS) {
        parts.push(await labelVisible(page, part));
      }
      const ok = parts.every((r) => r.found && r.visible);
      checks.push(
        ok
          ? pass(`LABEL-${p.label}`, `${p.label}: room shell label line present and visible`, 'both sentences')
          : fail(`LABEL-${p.label}`, `${p.label}: room shell label line`, JSON.stringify(parts)),
      );
      await page.close();
    }

    /* The composed session page: label + verdict co-presence + order. */
    const page = await browser.newPage();
    await page.goto(fileUrl('gauntlet-session.html'), { waitUntil: 'networkidle' });
    const parts = [];
    for (const part of ROOM_SHELL_LABEL_PARTS) {
      parts.push(await labelVisible(page, part));
    }
    const composed = await page.evaluate(() => {
      const verdict = document.querySelector('[data-testid="council-verdict"]');
      const room = document.querySelector('[data-testid="council-room"]');
      const all = Array.from(document.querySelectorAll('p'));
      const labelP = all.find((el) =>
        (el.textContent ?? '').includes(
          'Each member is an AI perspective inspired',
        ),
      );
      const order =
        room && labelP
          ? Boolean(
              room.compareDocumentPosition(labelP) &
                Node.DOCUMENT_POSITION_FOLLOWING,
            )
          : false;
      return { verdict: Boolean(verdict), room: Boolean(room), order };
    });
    const labelOk = parts.every((r) => r.found && r.visible);
    checks.push(
      labelOk && composed.verdict && composed.room
        ? pass(
            'LABEL-composed-session',
            'composed session page: Section 7 label line present and visible on the same page as the seat-attributed verdict',
            `verdict=${composed.verdict} room=${composed.room} labelFollowsRoom=${composed.order}`,
          )
        : fail(
            'LABEL-composed-session',
            'composed session page label co-presence',
            `label=${JSON.stringify(parts)} composed=${JSON.stringify(composed)}`,
          ),
    );
    await page.close();
  } finally {
    await browser.close();
  }
  return { suite: 'composed-page Section 7 label (CWE-034 carry)', checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { checks } = await run();
  for (const c of checks) console.log(`${c.status.toUpperCase()} ${c.id}: ${c.detail}`);
  process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
}
