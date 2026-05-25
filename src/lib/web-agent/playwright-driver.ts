/**
 * Playwright driver - thin wrapper around a per-session Chromium context.
 *
 * Track B9 (SCOPE-ADDITION Section 7).
 *
 * Exposes the small action surface Anthropic's Computer Use tool uses
 * (`computer_use_20250124`). The runner translates each tool call from the
 * Claude API into a `dispatch()` call here, captures the resulting
 * screenshot, and pushes both the action log entry and the new screenshot
 * back over the SSE bus.
 *
 * Per SCOPE-ADDITION 7.5 each session uses an isolated browser context with
 * no persistent cookies or credentials. Per-session credential injection is
 * a v4.1 feature.
 *
 * Playwright is already a dependency from BlackCEO v3.7 QC tooling, so this
 * module does not add a new npm package.
 */

import path from 'path';
import fs from 'fs/promises';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export type ComputerAction =
  | { action: 'screenshot' }
  | { action: 'left_click'; coordinate: [number, number] }
  | { action: 'right_click'; coordinate: [number, number] }
  | { action: 'middle_click'; coordinate: [number, number] }
  | { action: 'double_click'; coordinate: [number, number] }
  | { action: 'triple_click'; coordinate: [number, number] }
  | { action: 'mouse_move'; coordinate: [number, number] }
  | { action: 'left_mouse_down'; coordinate?: [number, number] }
  | { action: 'left_mouse_up'; coordinate?: [number, number] }
  | { action: 'left_click_drag'; start_coordinate: [number, number]; coordinate: [number, number] }
  | { action: 'scroll'; coordinate: [number, number]; scroll_direction: 'up' | 'down' | 'left' | 'right'; scroll_amount: number }
  | { action: 'type'; text: string }
  | { action: 'key'; text: string }
  | { action: 'hold_key'; text: string; duration: number }
  | { action: 'wait'; duration: number }
  | { action: 'cursor_position' }
  | { action: 'navigate'; url: string };

export interface ActionResult {
  // Base64 PNG of the viewport after the action. Anthropic's tool spec
  // requires every tool result to include a screenshot so the model can
  // observe the consequence.
  screenshotBase64: string;
  // Human-readable summary used in the action log and in error contexts.
  description: string;
  // Optional structured payload (e.g. cursor position) returned to the model.
  output?: unknown;
}

export interface DriverOptions {
  sessionId: string;
  screenshotsDir: string;
  startUrl?: string;
  viewport?: { width: number; height: number };
  // If true, the underlying Chromium launches headed for debugging. The
  // production path leaves this unset (headless, per SCOPE-ADDITION 7.3).
  headed?: boolean;
}

export class PlaywrightDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private screenshotCounter = 0;
  private readonly opts: Required<Omit<DriverOptions, 'startUrl' | 'headed'>> &
    Pick<DriverOptions, 'startUrl' | 'headed'>;

  constructor(opts: DriverOptions) {
    this.opts = {
      sessionId: opts.sessionId,
      screenshotsDir: opts.screenshotsDir,
      viewport: opts.viewport || DEFAULT_VIEWPORT,
      startUrl: opts.startUrl,
      headed: opts.headed,
    };
  }

  get viewport(): { width: number; height: number } {
    return this.opts.viewport;
  }

  async start(): Promise<void> {
    await fs.mkdir(this.opts.screenshotsDir, { recursive: true });
    this.browser = await chromium.launch({
      headless: !this.opts.headed,
      // Standard CI / container friendly flags. Mac Mini and VPS Docker both
      // pass these in their own playwright usage already.
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    this.context = await this.browser.newContext({
      viewport: this.opts.viewport,
      // Isolated context, no storage state. SCOPE-ADDITION 7.5.
      acceptDownloads: false,
    });
    this.page = await this.context.newPage();
    if (this.opts.startUrl) {
      await this.page.goto(this.opts.startUrl, { waitUntil: 'domcontentloaded' });
    }
  }

  async dispatch(action: ComputerAction): Promise<ActionResult> {
    const page = this.requirePage();
    let description = '';
    let output: unknown;
    switch (action.action) {
      case 'screenshot': {
        description = 'screenshot';
        break;
      }
      case 'navigate': {
        await page.goto(action.url, { waitUntil: 'domcontentloaded' });
        description = `navigate ${action.url}`;
        break;
      }
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        const [x, y] = action.coordinate;
        const button =
          action.action === 'right_click'
            ? 'right'
            : action.action === 'middle_click'
              ? 'middle'
              : 'left';
        const clickCount =
          action.action === 'double_click' ? 2 : action.action === 'triple_click' ? 3 : 1;
        await page.mouse.click(x, y, { button, clickCount });
        description = `${action.action} at (${x}, ${y})`;
        break;
      }
      case 'mouse_move': {
        const [x, y] = action.coordinate;
        await page.mouse.move(x, y);
        description = `move to (${x}, ${y})`;
        break;
      }
      case 'left_mouse_down': {
        if (action.coordinate) {
          await page.mouse.move(action.coordinate[0], action.coordinate[1]);
        }
        await page.mouse.down();
        description = 'mouse down';
        break;
      }
      case 'left_mouse_up': {
        if (action.coordinate) {
          await page.mouse.move(action.coordinate[0], action.coordinate[1]);
        }
        await page.mouse.up();
        description = 'mouse up';
        break;
      }
      case 'left_click_drag': {
        const [sx, sy] = action.start_coordinate;
        const [ex, ey] = action.coordinate;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move(ex, ey, { steps: 12 });
        await page.mouse.up();
        description = `drag (${sx}, ${sy}) to (${ex}, ${ey})`;
        break;
      }
      case 'scroll': {
        const [x, y] = action.coordinate;
        await page.mouse.move(x, y);
        // Translate Anthropic's normalized scroll amount into a pixel delta.
        // The model expresses "ticks"; one tick is roughly 100px.
        const pixels = action.scroll_amount * 100;
        let dx = 0;
        let dy = 0;
        if (action.scroll_direction === 'down') dy = pixels;
        else if (action.scroll_direction === 'up') dy = -pixels;
        else if (action.scroll_direction === 'right') dx = pixels;
        else if (action.scroll_direction === 'left') dx = -pixels;
        await page.mouse.wheel(dx, dy);
        description = `scroll ${action.scroll_direction} ${action.scroll_amount}`;
        break;
      }
      case 'type': {
        // Use insertText for predictable IME-free typing.
        await page.keyboard.type(action.text);
        description = `type ${truncate(action.text, 60)}`;
        break;
      }
      case 'key': {
        // Anthropic uses xdotool-style key strings ("Return", "ctrl+a").
        const keys = action.text.split('+').map((k) => normalizeKey(k.trim()));
        if (keys.length === 1) {
          await page.keyboard.press(keys[0]);
        } else {
          // Hold modifiers, press final key, release modifiers.
          for (let i = 0; i < keys.length - 1; i++) {
            await page.keyboard.down(keys[i]);
          }
          await page.keyboard.press(keys[keys.length - 1]);
          for (let i = keys.length - 2; i >= 0; i--) {
            await page.keyboard.up(keys[i]);
          }
        }
        description = `key ${action.text}`;
        break;
      }
      case 'hold_key': {
        const key = normalizeKey(action.text);
        await page.keyboard.down(key);
        await page.waitForTimeout(action.duration * 1000);
        await page.keyboard.up(key);
        description = `hold ${action.text} for ${action.duration}s`;
        break;
      }
      case 'wait': {
        await page.waitForTimeout(action.duration * 1000);
        description = `wait ${action.duration}s`;
        break;
      }
      case 'cursor_position': {
        // Playwright does not expose cursor position directly. Anthropic
        // sends this rarely; report the viewport center as a stable default.
        const x = Math.round(this.opts.viewport.width / 2);
        const y = Math.round(this.opts.viewport.height / 2);
        output = { x, y };
        description = `cursor position (${x}, ${y})`;
        break;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`Unsupported action: ${JSON.stringify(_exhaustive)}`);
      }
    }

    const screenshotBase64 = await this.captureScreenshot();
    return { screenshotBase64, description, output };
  }

  async currentUrl(): Promise<string> {
    return this.requirePage().url();
  }

  async stop(): Promise<void> {
    // Tear down in reverse construction order. Each step is best-effort so a
    // partial failure does not leak the rest of the resources.
    if (this.page) {
      try {
        await this.page.close({ runBeforeUnload: false });
      } catch {
        // ignore
      }
      this.page = null;
    }
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // ignore
      }
      this.context = null;
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // ignore
      }
      this.browser = null;
    }
  }

  private async captureScreenshot(): Promise<string> {
    const page = this.requirePage();
    const buf = await page.screenshot({ type: 'png', fullPage: false });
    const index = String(this.screenshotCounter++).padStart(4, '0');
    const file = path.join(this.opts.screenshotsDir, `frame-${index}.png`);
    // Best-effort disk persistence. If the disk write fails, the in-memory
    // SSE stream still gets the base64 payload so the operator UI never
    // freezes on a transient FS error.
    try {
      await fs.writeFile(file, buf);
    } catch {
      // ignore
    }
    return buf.toString('base64');
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error('PlaywrightDriver not started');
    }
    return this.page;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '...';
}

// Map xdotool-style key names to the names Playwright's keyboard.press
// expects. This is the small set Anthropic's model emits in practice;
// anything else passes through unchanged.
const KEY_ALIAS: Record<string, string> = {
  return: 'Enter',
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  space: ' ',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  ctrl: 'Control',
  control: 'Control',
  shift: 'Shift',
  alt: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  super: 'Meta',
};

function normalizeKey(k: string): string {
  const lower = k.toLowerCase();
  if (KEY_ALIAS[lower]) return KEY_ALIAS[lower];
  // Single character: pass as-is so Playwright sees the literal.
  if (k.length === 1) return k;
  // Capitalize first letter for things like "F1", "ArrowUp" style names.
  return k.charAt(0).toUpperCase() + k.slice(1);
}
