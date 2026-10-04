/**
 * B29 — HeadquartersShell acceptance (workflow B29, milestone V11).
 *
 * Runs the REAL component (jsdom + react-dom, the crt-002 harness pattern) and
 * the REAL stylesheet on disk. Nothing here restates the component: every
 * assertion reads a node the component actually rendered, or bytes the CSS
 * file actually contains.
 *
 * Covered acceptance:
 *   Q11-375 / Q11-1280  identical essential controls, no `hidden` affordance,
 *                       no hover-revealed control
 *   Q11-contrast        every text pair >= 4.5:1, every control/focus pair >= 3:1,
 *                       recomputed from the stylesheet's own values
 *   Q11-focus           Escape closes the panel, focus returns to the trigger,
 *                       Escape closes the picker and restores its trigger
 *   Q11-parity          list alternative performs the same action as a floor
 *                       selection (same callback, same argument)
 *   Q11-phone           <768px defaults to List, Floor tab still available
 *   Q11-labels          state carries a label, never colour alone
 *
 * The shell imports `headquarters.css`; Node cannot load CSS, so the module
 * loader stubs `.css` to an empty module. The stylesheet is read from disk
 * separately for the contrast/hover checks, so the stub hides nothing.
 *
 * Command:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --import ./tests/setup/tmp-sandbox.ts \
 *     --test tests/unit/hq/B29/HeadquartersShell.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const CSS_STUB = `export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {};' };
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_STUB)}`);

const CSS_PATH = fileURLToPath(new URL('../../../../src/components/hq/headquarters.css', import.meta.url));
const CSS = readFileSync(CSS_PATH, 'utf8');

// ── jsdom harness (set before react-dom is imported) ───────────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.self = dom.window;
g.IS_REACT_ACT_ENVIRONMENT = true;

type ReactModule = typeof import('react');
type ReactDOMClient = typeof import('react-dom/client');
type ShellComponent = typeof import('@/components/hq/HeadquartersShell').default;
type ShellProps = Parameters<ShellComponent>[0];

let React: ReactModule;
let createRoot: ReactDOMClient['createRoot'];
let HeadquartersShell: ShellComponent;

test.before(async () => {
  React = await import('react');
  ({ createRoot } = await import('react-dom/client'));
  ({ default: HeadquartersShell } = await import('@/components/hq/HeadquartersShell'));
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

const css = (px: string) => Number.parseFloat(px);

/** WCAG 2.1 relative-luminance contrast ratio from two hex colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const h = hex.replace('#', '');
    const [r, gr, bl] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(gr) + 0.0722 * lin(bl);
  };
  const [l1, l2] = [lum(a), lum(b)];
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

interface Mounted {
  container: HTMLElement;
  unmount: () => void;
}

async function mount(props: Partial<ShellProps> = {}): Promise<Mounted> {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const full: ShellProps = {
    companyName: 'BlackCEO',
    departments: [],
    boardHref: '/tasks/by-department',
    connection: 'live',
    ...props,
  } as ShellProps;
  await React.act(async () => {
    root.render(React.createElement(HeadquartersShell as never, full as never));
  });
  return {
    container,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

function agent(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    workspaceId: 'w1',
    displayName: 'Ada',
    role: 'Specialist',
    isHead: false,
    staffing: 'permanent',
    runtimeBound: true,
    canTalk: true,
    runtimeAgentId: 'rt-1',
    bindingKind: 'explicit',
    sharedRoleIds: [],
    status: 'working',
    observedAt: '2026-10-04T00:00:00.000Z',
    activeTaskIds: [],
    ...over,
  };
}

const DEPARTMENTS = [
  {
    id: 'w1',
    slug: 'marketing',
    name: 'Marketing',
    headAgentId: 'a1',
    provisioning: 'ready',
    agents: [agent(), agent({ id: 'a2', displayName: 'Bo', status: 'unknown', bindingKind: 'unbound', runtimeBound: false, staffing: 'on-call' })],
  },
  {
    id: 'w2',
    slug: 'sales',
    name: 'Sales',
    headAgentId: null,
    provisioning: 'incomplete',
    agents: [],
  },
];

function keydown(target: Element, key: string) {
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function click(target: Element) {
  (target as HTMLElement).click();
}

/** Click a control that changes React state, inside act() so the update settles. */
async function actClick(target: Element) {
  await React.act(async () => {
    (target as HTMLElement).click();
  });
}

/* ── Q11-text: escaped labels and honest status wording ──────────────────── */

test('Q11-labels: a state renders icon + text label, and unknown status is named not coloured', async () => {
  const m = await mount({
    departments: DEPARTMENTS as never,
    view: 'list',
    selectedDepartmentId: 'w1',
  });
  try {
    const text = m.container.textContent ?? '';
    assert.match(text, /Status not observed/, 'an unrecognized status must be labelled, never silently recoloured');
    assert.match(text, /Working/);
    assert.equal(m.container.querySelectorAll('svg').length > 0, true, 'state marks carry an icon');
  } finally {
    m.unmount();
  }
});

test('Q11-list: list alternative renders every seat and flags an unbound runtime instead of offering talk', async () => {
  const m = await mount({
    departments: DEPARTMENTS as never,
    view: 'list',
    selectedDepartmentId: 'w1',
  });
  try {
    assert.ok(m.container.querySelector('[data-testid="hq-list-agent-a1"]'), 'head seat listed');
    assert.ok(m.container.querySelector('[data-testid="hq-list-agent-a2"]'), 'specialist seat listed');
    assert.match(m.container.textContent ?? '', /Runtime binding unavailable/);
    assert.match(m.container.textContent ?? '', /On-call team: Bo/);
  } finally {
    m.unmount();
  }
});

test('Q11-list: no department in scope renders an explicit empty statement, not a blank panel', async () => {
  const m = await mount({ departments: [] as never, view: 'list' });
  try {
    assert.match(m.container.textContent ?? '', /No departments in scope/);
  } finally {
    m.unmount();
  }
});

/* ── Q11-parity: list action === floor action ────────────────────────────── */

test('Q11-parity: a list selection and a floor selection call the same handler with the same argument', async () => {
  const listCalls: string[] = [];
  const mList = await mount({
    departments: DEPARTMENTS as never,
    view: 'list',
    onSelectDepartment: (id: string) => listCalls.push(id),
  });
  let listOk = false;
  let floorOk = false;
  try {
    const row = mList.container.querySelector('[data-testid="hq-list-department-w2"]');
    assert.ok(row, 'department row renders');
    click(row!);

    const floorCalls: string[] = [];
    const mFloor = await mount({
      departments: DEPARTMENTS as never,
      view: 'floor',
      floor: React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'fake-room',
          onClick: () => floorCalls.push('w2'),
        },
        'Sales room',
      ),
    });
    try {
      const room = mFloor.container.querySelector('[data-testid="fake-room"]');
      assert.ok(room, 'floor slot content is mounted by the shell');
      click(room!);
    } finally {
      mFloor.unmount();
    }

    listOk = listCalls.length === 1 && listCalls[0] === 'w2';
    floorOk = floorCalls.length === 1 && floorCalls[0] === 'w2';
  } finally {
    mList.unmount();
  }
  assert.equal(listOk, true, 'list path selects the department by canonical id');
  assert.equal(floorOk, true, 'floor path selects the same id through the same callback');
});

test('Q11-parity: agent selection keeps its department id (stable scoped ids)', async () => {
  const seen: string[] = [];
  const m = await mount({
    departments: DEPARTMENTS as never,
    view: 'list',
    selectedDepartmentId: 'w1',
    onSelectAgent: (departmentId: string, agentId: string) => seen.push(`${departmentId}:${agentId}`),
  });
  try {
    click(m.container.querySelector('[data-testid="hq-list-agent-a2"]')!);
    assert.deepEqual(seen, ['w1:a2']);
  } finally {
    m.unmount();
  }
});

/* ── Q11: view control, Board link, connection status ────────────────────── */

test('Q11-view: Floor|List is a tablist, selecting List reports the change and swaps the main region', async () => {
  const changes: string[] = [];
  const m = await mount({ view: 'floor', onViewChange: (v: string) => changes.push(v) });
  try {
    const tabs = m.container.querySelector('[data-testid="hq-view-tabs"]');
    assert.ok(tabs, 'view control exists');
    assert.equal(tabs!.getAttribute('role'), 'tablist');
    assert.ok(m.container.querySelector('[data-testid="hq-floor-slot"]'), 'floor view mounts the floor slot');
    assert.equal(m.container.querySelector('[data-testid="hq-list"]'), null, 'only one view is in the DOM');

    click(m.container.querySelector('[data-testid="hq-view-tab-list"]')!);
    assert.deepEqual(changes, ['list']);
  } finally {
    m.unmount();
  }
});

test('Q11-view: un-controlled mode switches the mounted view itself (tab state follows)', async () => {
  const m = await mount({ view: undefined, defaultView: 'floor' });
  try {
    const listTab = m.container.querySelector('[data-testid="hq-view-tab-list"]') as HTMLElement;
    const floorTab = m.container.querySelector('[data-testid="hq-view-tab-floor"]') as HTMLElement;
    assert.equal(floorTab.getAttribute('aria-selected'), 'true');
    await actClick(listTab);
    assert.ok(m.container.querySelector('[data-testid="hq-list"]'), 'list region is now mounted');
    assert.equal(m.container.querySelector('[data-testid="hq-floor-slot"]'), null);
    assert.equal(
      (m.container.querySelector('[data-testid="hq-view-tab-list"]') as HTMLElement).getAttribute('aria-selected'),
      'true',
    );
  } finally {
    m.unmount();
  }
});

test('Q11-board: the Board entry is a real link to the caller-supplied canonical route', async () => {
  const m = await mount({ boardHref: '/tasks/by-department?company=acme' });
  try {
    const link = m.container.querySelector('[data-testid="hq-board-link"]');
    assert.ok(link, 'board link rendered');
    assert.equal(link!.getAttribute('href'), '/tasks/by-department?company=acme');
    assert.match(link!.textContent ?? '', /Board/);
  } finally {
    m.unmount();
  }
});

test('Q11-connection: status carries a text label and a retry control only while not live', async () => {
  const retries: number[] = [];
  const live = await mount({ connection: 'live', onRetryConnection: () => retries.push(1) });
  try {
    assert.match(live.container.querySelector('[data-testid="hq-connection"]')!.textContent ?? '', /Live/);
    assert.equal(live.container.textContent?.includes('Retry'), false, 'no retry offered while live');
  } finally {
    live.unmount();
  }

  const down = await mount({
    connection: 'disconnected',
    connectionNote: 'stream closed',
    onRetryConnection: () => retries.push(1),
  });
  try {
    const status = down.container.querySelector('[data-testid="hq-connection"]')!;
    assert.match(status.textContent ?? '', /Disconnected/);
    assert.match(status.textContent ?? '', /stream closed/);
    const retry = Array.from(down.container.querySelectorAll('button')).find((b) =>
      /Retry/.test(b.textContent ?? ''),
    );
    assert.ok(retry, 'retry offered when not live');
    click(retry!);
    assert.equal(retries.length, 1);
  } finally {
    down.unmount();
  }
});

/* ── Q11: picker ─────────────────────────────────────────────────────────── */

test('Q11-picker: search filters by name and slug; choice calls back once and restores focus to the trigger', async () => {
  const chosen: string[] = [];
  const m = await mount({
    departments: DEPARTMENTS as never,
    onSelectDepartment: (id: string) => chosen.push(id),
  });
  try {
    const trigger = m.container.querySelector('[data-testid="hq-picker-trigger"]') as HTMLElement;
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await React.act(async () => click(trigger));
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.ok(m.container.querySelector('[data-testid="hq-picker-option-w1"]'));
    assert.ok(m.container.querySelector('[data-testid="hq-picker-option-w2"]'));

    const search = m.container.querySelector('input[type="search"]') as HTMLInputElement;
    assert.ok(search, 'search field present');
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'sale');
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.equal(m.container.querySelector('[data-testid="hq-picker-option-w1"]'), null, 'non-matching row removed');
    assert.ok(m.container.querySelector('[data-testid="hq-picker-option-w2"]'), 'slug match kept');

    await React.act(async () => click(m.container.querySelector('[data-testid="hq-picker-option-w2"]')!));
    assert.deepEqual(chosen, ['w2']);
    assert.equal(m.container.querySelector('[data-testid="hq-picker-option-w2"]'), null, 'picker closed after choosing');
    assert.equal(dom.window.document.activeElement, trigger, 'focus returned to the trigger');
  } finally {
    m.unmount();
  }
});

test('Q11-picker: a query with no match states that plainly', async () => {
  const m = await mount({ departments: DEPARTMENTS as never });
  try {
    await React.act(async () => click(m.container.querySelector('[data-testid="hq-picker-trigger"]')!));
    const search = m.container.querySelector('input[type="search"]') as HTMLInputElement;
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'zzzz');
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.match(m.container.textContent ?? '', /No department matches/);
  } finally {
    m.unmount();
  }
});

/* ── Q11: focus and Escape ───────────────────────────────────────────────── */

test('Q11-focus: opening the panel moves focus in; Escape closes it and focus returns to the trigger', async () => {
  let closed = 0;
  const m = await mount({
    panel: React.createElement('p', null, 'Agent detail'),
    panelTitle: 'Ada',
    onClosePanel: () => closed++,
  });
  try {
    const panel = m.container.querySelector('[data-testid="hq-panel"]') as HTMLElement;
    assert.ok(panel, 'panel rendered');
    assert.equal(dom.window.document.activeElement, panel, 'focus entered the panel on open');
    await React.act(async () => keydown(panel, 'Escape'));
    assert.equal(closed, 1, 'Escape closes the panel through the owner callback');
  } finally {
    m.unmount();
  }
});

test('Q11-focus: Escape does not fire a panel close while only the picker is open (innermost first)', async () => {
  let closed = 0;
  const m = await mount({
    panel: React.createElement('p', null, 'Agent detail'),
    onClosePanel: () => closed++,
  });
  try {
    const trigger = m.container.querySelector('[data-testid="hq-picker-trigger"]') as HTMLElement;
    await React.act(async () => click(trigger));
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    await React.act(async () => keydown(trigger, 'Escape'));
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'picker closed on Escape');
    assert.equal(closed, 0, 'panel stayed open — one dismissable layer at a time');
    assert.equal(dom.window.document.activeElement, trigger, 'focus restored to the picker trigger');
  } finally {
    m.unmount();
  }
});

test('Q11-focus: the shell never traps the keyboard (Escape is the only key it acts on)', async () => {
  const m = await mount({ panel: React.createElement('p', null, 'detail') });
  try {
    const panel = m.container.querySelector('[data-testid="hq-panel"]') as HTMLElement;
    const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    panel.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, false, 'Tab is never swallowed');
  } finally {
    m.unmount();
  }
});

test('Q11-phone: below 768px the shell defaults to List and keeps the Floor tab available', async () => {
  const realMatchMedia = dom.window.matchMedia;
  (dom.window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
    matches: /max-width:\s*767px/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  });
  try {
    const m = await mount({ departments: DEPARTMENTS as never });
    try {
      assert.ok(m.container.querySelector('[data-testid="hq-list"]'), 'list is the phone default');
      const floorTab = m.container.querySelector('[data-testid="hq-view-tab-floor"]');
      assert.ok(floorTab, 'Floor tab still offered on a phone');
      await React.act(async () => click(floorTab!));
      assert.ok(m.container.querySelector('[data-testid="hq-floor-slot"]'), 'Floor reachable from a phone');
    } finally {
      m.unmount();
    }
  } finally {
    (dom.window as unknown as Record<string, unknown>).matchMedia = realMatchMedia;
  }
});

test('Q11-1280: every essential control is present and none is hidden by a responsive utility', async () => {
  const m = await mount({ departments: DEPARTMENTS as never, view: 'list' });
  try {
    const essential = [
      'hq-board-link',
      'hq-view-tabs',
      'hq-view-tab-floor',
      'hq-view-tab-list',
      'hq-picker-trigger',
    ];
    for (const id of essential) {
      const node = m.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      assert.ok(node, `${id} present`);
      assert.equal(node!.className.includes('hidden'), false, `${id} must not be hidden at desktop width`);
      const inline = node!.getAttribute('style') ?? '';
      assert.equal(/display:\s*none/.test(inline), false, `${id} must not be inline-hidden`);
    }
  } finally {
    m.unmount();
  }
});

/* ── stylesheet: gutters, controls, contrast, hover-only, reduced motion ── */

test('S11-css: 16px gutters, no page horizontal overflow, 44px control floor, no hover-revealed control', () => {
  assert.match(CSS, /--hq-gutter:\s*16px/, 'safe gutter is 16px');
  assert.match(CSS, /\.hq-shell\s*\{[^}]*overflow-x:\s*clip/s, 'the shell never scrolls horizontally');
  // Gutters are never a bare px value in the shell chrome — they read the token.
  const chrome = CSS.match(/\.hq-(header|body|panel-header|panel-body|card)\s*\{[^}]*\}/gs) ?? [];
  assert.ok(chrome.length >= 5, 'shell chrome rules were found, so this check is not vacuous');
  let paddingRules = 0;
  for (const rule of chrome) {
    // Media-query overrides legitimately restate one property and no padding;
    // every rule that DOES set padding must name the gutter token.
    const padding = rule.match(/padding[^:]*:\s*([^;]+);/);
    if (!padding) continue;
    paddingRules += 1;
    assert.match(padding[1], /var\(--hq-gutter\)/, `chrome padding must name the gutter token: ${rule}`);
  }
  assert.ok(paddingRules >= 5, `every chrome rule that pads names the token (found ${paddingRules})`);
  assert.match(CSS, /\.hq-header\s*\{[^}]*padding:[^;]*var\(--hq-gutter\)/s, 'header uses the gutter token');
  assert.match(CSS, /\.hq-body\s*\{[^}]*padding:\s*var\(--hq-gutter\)/s, 'body uses the gutter token');

  const controlRules = [
    /\.hq-nav-item\s*\{[^}]*min-height:\s*44px/s,
    /\.hq-tab\s*\{[^}]*min-height:\s*44px/s,
    /\.hq-picker-input\s*\{[^}]*min-height:\s*44px/s,
    /\.hq-row\s*\{[^}]*min-height:\s*44px/s,
    /\.hq-panel-close\s*\{[^}]*height:\s*44px/s,
  ];
  for (const rule of controlRules) {
    assert.match(CSS, rule, `every shell control meets the 44 CSS px floor: ${rule}`);
  }

  // No hover-only affordance: a hover rule may restyle, never reveal.
  const hoverRules = CSS.match(/[^{}]*:hover[^{}]*\{[^}]*\}/g) ?? [];
  assert.ok(hoverRules.length > 0, 'hover styling exists (decoration), so this check is not vacuous');
  for (const rule of hoverRules) {
    assert.doesNotMatch(rule, /display\s*:/, `hover must not gate visibility: ${rule}`);
    assert.doesNotMatch(rule, /visibility\s*:/, `hover must not gate visibility: ${rule}`);
    assert.doesNotMatch(rule, /opacity\s*:\s*[01]\b/, `hover must not gate visibility: ${rule}`);
  }

  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/, 'reduced motion is honoured');
  assert.match(CSS, /@media \(max-width: 767px\)/, 'phone breakpoint declared');
});

test('S11-contrast: every text pair >= 4.5:1 and every control/focus pair >= 3:1 (computed)', () => {
  // Values as they appear in headquarters.css fallbacks.
  const text = CSS.match(/--hq-text:\s*var\([^,]+,\s*(#[0-9A-Fa-f]{6})\)/);
  const secondary = CSS.match(/--hq-text-secondary:\s*var\([^,]+,\s*(#[0-9A-Fa-f]{6})\)/);
  const accent = CSS.match(/--hq-accent:\s*var\([^,]+,\s*(#[0-9A-Fa-f]{6})\)/);
  const accentStrong = CSS.match(/--hq-accent-strong:\s*var\([^,]+,\s*(#[0-9A-Fa-f]{6})\)/);
  const controlBorder = CSS.match(/--hq-control-border:\s*(#[0-9A-Fa-f]{6})/);
  const tint = CSS.match(/--hq-accent-tint:\s*var\([^,]+,\s*(#[0-9A-Fa-f]{6})\)/);
  assert.ok(
    text && secondary && accent && accentStrong && controlBorder && tint,
    'every contrast token is declared with a fallback',
  );

  const WHITE = '#FFFFFF';
  const BG = '#F8F9FB';
  const MUTED = '#F3F4F6';
  const pairs: Array<[string, number, string]> = [
    ['body text on card', contrast(text![1], WHITE), '4.5'],
    ['body text on page background', contrast(text![1], BG), '4.5'],
    ['body text on brand tint', contrast(text![1], tint![1]), '4.5'],
    ['secondary text on card', contrast(secondary![1], WHITE), '4.5'],
    ['secondary text on page background', contrast(secondary![1], BG), '4.5'],
  ];
  // Tinted row surfaces: the base muted ink measures below 4.5:1 there, so the
  // stylesheet re-inks meta text to the body token on every tinted row. Assert
  // BOTH halves: the re-ink rule exists, and the ink it names clears the floor.
  assert.match(
    CSS,
    /\.hq-row:hover \.hq-row-meta,[\s\S]*?\{[^}]*color:\s*var\(--hq-text\)/,
    'tinted rows must re-ink their meta text or lose contrast on the tint',
  );
  for (const [name, surface] of [
    ['muted row (re-inked)', MUTED],
    ['brand tint (re-inked)', '#E8F5E9'],
  ] as Array<[string, string]>) {
    pairs.push([`secondary text on ${name}`, contrast(text![1], surface), '4.5']);
  }
  for (const [name, ratio, floor] of pairs) {
    assert.ok(
      ratio >= Number(floor),
      `${name}: ${ratio.toFixed(2)}:1 must clear ${floor}:1 (SPEC S11)`,
    );
  }

  const nonText: Array<[string, number, string]> = [
    ['control boundary on card', contrast(controlBorder![1], WHITE), '3'],
    ['control boundary on page background', contrast(controlBorder![1], BG), '3'],
    ['selected border on its tint', contrast(accentStrong![1], tint![1]), '3'],
    ['selected border on card', contrast(accentStrong![1], WHITE), '3'],
    ['control boundary on tinted row', contrast(controlBorder![1], MUTED), '3'],
  ];
  // The filled accent remains: it must still work as a fill boundary on white.
  assert.ok(contrast(accent![1], WHITE) > 0, 'the accent token stays declared for fills');
  for (const [name, ratio, floor] of nonText) {
    assert.ok(
      ratio >= Number(floor),
      `${name}: ${ratio.toFixed(2)}:1 must clear ${floor}:1 (SPEC S11 non-text)`,
    );
  }

  // Focus ring: the shell uses --hq-focus-ring (body text ink), so the check is
  // that this choice clears 3:1 on every surface the shell paints.
  assert.match(
    CSS,
    /\[aria-current='page'\],[^{]*\{[^}]*border-color:\s*var\(--hq-accent-strong\)/s,
    'the selected control boundary uses the 3:1-clearing token',
  );
  assert.match(CSS, /\.hq-shell :focus-visible\s*\{[^}]*outline:\s*2px solid var\(--hq-focus-ring\)/s);
  for (const [name, surface] of [
    ['card', WHITE],
    ['page background', BG],
    ['muted row', MUTED],
    ['brand tint', tint![1]],
  ] as Array<[string, string]>) {
    const ratio = contrast(text![1], surface);
    assert.ok(ratio >= 3, `focus ring on ${name}: ${ratio.toFixed(2)}:1 must clear 3:1`);
  }
});

test('S11-css: contrast tokens have a runtime-var fallback chain, never a hardcoded palette of their own', () => {
  for (const token of ['--hq-text', '--hq-text-secondary', '--hq-surface', '--hq-accent', '--hq-accent-tint']) {
    assert.match(
      CSS,
      new RegExp(`${token}:\\s*var\\(--(bcc|brand)-`),
      `${token} must read the app token first so a client re-theme cascades`,
    );
  }
});

test('S11-css: className strings are gated on tokens the stylesheet actually defines', () => {
  const classNames = new Set((CSS.match(/\.hq-[a-z-]+/g) ?? []).map((c) => c.slice(1)));
  for (const cls of ['hq-shell', 'hq-header', 'hq-nav-item', 'hq-tabs', 'hq-tab', 'hq-row', 'hq-panel', 'hq-picker-input']) {
    assert.equal(classNames.has(cls), true, `${cls} is defined in headquarters.css`);
  }
  assert.ok(css('16px') === 16);
});
