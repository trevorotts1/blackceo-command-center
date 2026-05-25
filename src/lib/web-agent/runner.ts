/**
 * Web Agent runner - orchestrates a single Anthropic Computer Use session.
 *
 * Track B9 (SCOPE-ADDITION Section 7).
 *
 * Lifecycle:
 *   1. Persist a new `web_agent_sessions` row (status `pending`).
 *   2. Spin up an isolated Playwright context via `PlaywrightDriver`.
 *   3. Drive Claude Sonnet 4.6 with the `computer_use_20250124` tool enabled.
 *      Each turn we:
 *        - capture a screenshot
 *        - send it (with action history) to the Anthropic Messages API
 *        - if the model returns `tool_use` blocks of type `computer`, dispatch
 *          them through the driver, append the resulting screenshot as the
 *          `tool_result`, and loop
 *        - if the model returns only text and no tool_use, treat that text
 *          as the final markdown report
 *   4. Update the DB row (status `completed` or `failed`), mirror the markdown
 *      result to `<vault>/web-agent/YYYY/MM/YYYY-MM-DD-<slug>.md`, tear down
 *      the browser context.
 *
 * Anthropic SDK note: `@anthropic-ai/sdk` is not in package.json today.
 * Rather than gate B9 on a dependency PR, this runner calls the public
 * Messages API directly via `fetch` with the `anthropic-beta:
 * computer-use-2025-01-24` header. See BUILD-NOTES.md "Pending dependencies"
 * for the upgrade path to the typed SDK; the API surface used here is the
 * same one the SDK wraps.
 *
 * Store helpers (createSession/getSession/listSessions/updateSession) live in
 * this module because Track B9's ownership list does not include a separate
 * `web-agent-store.ts`. The route handlers in `src/app/api/operator/web-agent`
 * are the only callers.
 */

import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { queryAll, queryOne, run } from '@/lib/db';
import { vaultRoot, operatorScratchRoot } from '@/lib/platform';
import { PlaywrightDriver, type ComputerAction, type ActionResult } from './playwright-driver';
import { getStreamBus } from './screenshot-stream';

// -- Types ------------------------------------------------------------------

export type WebAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WebAgentSessionRow {
  id: string;
  task: string;
  status: WebAgentStatus;
  started_at: string;
  ended_at: string | null;
  result_markdown: string | null;
  action_log: string;
  screenshots_dir: string | null;
  created_at: string;
}

export interface ActionLogEntry {
  ts: string;
  // High-level kind: 'action' for driver dispatches, 'model' for assistant
  // text-only turns, 'error' for failures.
  kind: 'action' | 'model' | 'error' | 'system';
  description: string;
  // Optional structured payload for inspection. Kept JSON-serializable.
  detail?: Record<string, unknown>;
}

export interface WebAgentSession {
  id: string;
  task: string;
  status: WebAgentStatus;
  started_at: string;
  ended_at: string | null;
  result_markdown: string | null;
  action_log: ActionLogEntry[];
  screenshots_dir: string | null;
  created_at: string;
}

// -- Store helpers ---------------------------------------------------------

function decodeRow(row: WebAgentSessionRow): WebAgentSession {
  let log: ActionLogEntry[] = [];
  try {
    log = row.action_log ? (JSON.parse(row.action_log) as ActionLogEntry[]) : [];
    if (!Array.isArray(log)) log = [];
  } catch {
    log = [];
  }
  return {
    id: row.id,
    task: row.task,
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    result_markdown: row.result_markdown,
    action_log: log,
    screenshots_dir: row.screenshots_dir,
    created_at: row.created_at,
  };
}

export function createSession(input: { task: string }): WebAgentSession {
  const id = randomUUID();
  const now = new Date().toISOString();
  const screenshotsDir = path.join(operatorScratchRoot(), 'web-agent', id);
  run(
    `INSERT INTO web_agent_sessions
       (id, task, status, started_at, ended_at, result_markdown, action_log, screenshots_dir, created_at)
     VALUES (?, ?, 'pending', ?, NULL, NULL, '[]', ?, ?)`,
    [id, input.task, now, screenshotsDir, now]
  );
  return {
    id,
    task: input.task,
    status: 'pending',
    started_at: now,
    ended_at: null,
    result_markdown: null,
    action_log: [],
    screenshots_dir: screenshotsDir,
    created_at: now,
  };
}

export function getSession(id: string): WebAgentSession | null {
  const row = queryOne<WebAgentSessionRow>(
    `SELECT id, task, status, started_at, ended_at, result_markdown, action_log, screenshots_dir, created_at
     FROM web_agent_sessions WHERE id = ?`,
    [id]
  );
  if (!row) return null;
  return decodeRow(row);
}

export interface ListSessionsOptions {
  limit?: number;
  offset?: number;
}

export interface ListSessionsResult {
  items: WebAgentSession[];
  total: number;
  limit: number;
  offset: number;
}

export function listSessions(opts: ListSessionsOptions = {}): ListSessionsResult {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 25)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const totalRow = queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM web_agent_sessions`);
  const total = totalRow?.c || 0;
  const rows = queryAll<WebAgentSessionRow>(
    `SELECT id, task, status, started_at, ended_at, result_markdown, action_log, screenshots_dir, created_at
     FROM web_agent_sessions
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return { items: rows.map(decodeRow), total, limit, offset };
}

function updateSession(
  id: string,
  patch: Partial<{
    status: WebAgentStatus;
    ended_at: string | null;
    result_markdown: string | null;
    action_log: ActionLogEntry[];
  }>
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.ended_at !== undefined) {
    sets.push('ended_at = ?');
    params.push(patch.ended_at);
  }
  if (patch.result_markdown !== undefined) {
    sets.push('result_markdown = ?');
    params.push(patch.result_markdown);
  }
  if (patch.action_log !== undefined) {
    sets.push('action_log = ?');
    params.push(JSON.stringify(patch.action_log));
  }
  if (sets.length === 0) return;
  params.push(id);
  run(`UPDATE web_agent_sessions SET ${sets.join(', ')} WHERE id = ?`, params);
}

export function slugifyTask(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}

// -- Runner ----------------------------------------------------------------

const MODEL = 'claude-sonnet-4-5'; // Anthropic API model id; aligns with "Sonnet 4.6" naming in the spec.
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MAX_ITERATIONS = 30; // Hard cap so a runaway model cannot loop forever.
const DEFAULT_START_URL = 'about:blank';

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[] | unknown[];
}

interface AnthropicResponse {
  id: string;
  role: 'assistant';
  content: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: Record<string, number>;
}

export interface RunOptions {
  // Optional starting URL for the browser context. Defaults to about:blank
  // so the model decides where to navigate via the `navigate` action.
  startUrl?: string;
  // Optional override for the model id (used in tests).
  model?: string;
}

/**
 * Run a Web Agent session to completion. Designed to be called from the
 * `/api/operator/web-agent/run` route inside the same Next.js process. The
 * route returns the session id immediately and lets this run continue in the
 * background; events flow over the SSE bus.
 */
export async function runSession(sessionId: string, opts: RunOptions = {}): Promise<void> {
  const bus = getStreamBus();
  const session = getSession(sessionId);
  if (!session) {
    bus.publish(sessionId, 'error', { message: `session ${sessionId} not found` });
    bus.publish(sessionId, 'done', { status: 'failed' });
    return;
  }
  const log: ActionLogEntry[] = [...session.action_log];

  const startedAt = new Date().toISOString();
  updateSession(sessionId, { status: 'running' });
  bus.publish(sessionId, 'status', { status: 'running', started_at: startedAt });
  appendLog(log, sessionId, 'system', `session started: ${session.task}`);
  updateSession(sessionId, { action_log: log });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !process.env.WEB_AGENT_FIXTURE_PATH) {
    appendLog(log, sessionId, 'error', 'ANTHROPIC_API_KEY is not set');
    updateSession(sessionId, {
      status: 'failed',
      ended_at: new Date().toISOString(),
      action_log: log,
    });
    bus.publish(sessionId, 'error', { message: 'ANTHROPIC_API_KEY is not set' });
    bus.publish(sessionId, 'done', { status: 'failed' });
    return;
  }

  const screenshotsDir =
    session.screenshots_dir || path.join(operatorScratchRoot(), 'web-agent', sessionId);
  const driver = new PlaywrightDriver({
    sessionId,
    screenshotsDir,
    startUrl: opts.startUrl || DEFAULT_START_URL,
  });

  let finalText = '';
  let status: WebAgentStatus = 'failed';

  try {
    await driver.start();
    appendLog(log, sessionId, 'system', 'browser context started');
    updateSession(sessionId, { action_log: log });

    // Seed the conversation with an initial screenshot of about:blank so the
    // model has visual context for its first move.
    const initial = await driver.dispatch({ action: 'screenshot' });
    bus.publish(sessionId, 'screenshot', { png_base64: initial.screenshotBase64 });

    const messages: AnthropicMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Task: ${session.task}\n\n` +
              `You are operating a headless Chromium browser. Use the computer tool to ` +
              `navigate, click, type, and scroll. The browser starts on about:blank, so your ` +
              `first action will usually be to navigate to a starting URL. When you have ` +
              `finished, reply with a final Markdown report (no tool use) summarizing the ` +
              `result. Use a level-1 heading, a short summary paragraph, then any tables, ` +
              `lists, or links the task asked for.`,
          },
          {
            type: 'tool_use_initial_screenshot' as unknown as 'text',
            // The Anthropic API wants the seed screenshot as part of the
            // user's first message via a tool_result, but on the very first
            // turn there is no prior tool_use_id to reference. We inline it
            // as an image so the model still sees the blank canvas.
            // Replaced below by the proper image block.
          } as unknown as AnthropicContentBlock,
        ],
      },
    ];
    // Replace the second placeholder block with a real image block.
    messages[0].content = [
      (messages[0].content as AnthropicContentBlock[])[0],
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: initial.screenshotBase64,
        },
      } as unknown as AnthropicContentBlock,
    ];

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const response = await callAnthropic({
        apiKey: apiKey || '',
        model: opts.model || MODEL,
        messages,
        viewport: driver.viewport,
      });

      // Persist the assistant turn so subsequent calls have full history.
      messages.push({ role: 'assistant', content: response.content });

      // Collect tool_use blocks; if none, this is the final answer.
      const toolUses = response.content.filter(
        (b): b is AnthropicToolUseBlock => b.type === 'tool_use'
      );
      const texts = response.content.filter(
        (b): b is AnthropicTextBlock => b.type === 'text'
      );

      if (toolUses.length === 0) {
        finalText = texts.map((t) => t.text).join('\n\n').trim();
        if (texts.length > 0) {
          appendLog(log, sessionId, 'model', truncate(finalText, 200));
          updateSession(sessionId, { action_log: log });
        }
        status = 'completed';
        break;
      }

      // Execute each tool_use and assemble the corresponding tool_result blocks.
      const toolResults: AnthropicContentBlock[] = [];
      for (const use of toolUses) {
        if (use.name !== 'computer') {
          // Unknown tool from the model. Return an error result so it can
          // recover instead of crashing the loop.
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: [{ type: 'text', text: `Unsupported tool: ${use.name}` }],
            is_error: true,
          } as unknown as AnthropicContentBlock);
          continue;
        }
        const action = coerceAction(use.input);
        if (!action) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: [{ type: 'text', text: `Invalid computer action: ${JSON.stringify(use.input)}` }],
            is_error: true,
          } as unknown as AnthropicContentBlock);
          continue;
        }
        let result: ActionResult;
        try {
          result = await driver.dispatch(action);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown driver error';
          appendLog(log, sessionId, 'error', `driver: ${msg}`, { action });
          updateSession(sessionId, { action_log: log });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: [{ type: 'text', text: `Action failed: ${msg}` }],
            is_error: true,
          } as unknown as AnthropicContentBlock);
          continue;
        }
        appendLog(log, sessionId, 'action', result.description, {
          action,
          url: await driver.currentUrl().catch(() => null),
        });
        updateSession(sessionId, { action_log: log });
        bus.publish(sessionId, 'action', { description: result.description, action });
        bus.publish(sessionId, 'screenshot', { png_base64: result.screenshotBase64 });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: [
            ...(result.output ? [{ type: 'text', text: JSON.stringify(result.output) }] : []),
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: result.screenshotBase64,
              },
            },
          ],
        } as unknown as AnthropicContentBlock);
      }

      messages.push({ role: 'user', content: toolResults });
    }

    if (status !== 'completed') {
      // Hit MAX_ITERATIONS without a text-only turn.
      finalText = finalText || '# Web Agent\n\nThe agent reached the action limit without finishing the task.';
      status = 'failed';
      appendLog(log, sessionId, 'error', `max iterations (${MAX_ITERATIONS}) reached`);
      updateSession(sessionId, { action_log: log });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown runner error';
    appendLog(log, sessionId, 'error', `runner: ${msg}`);
    updateSession(sessionId, { action_log: log });
    bus.publish(sessionId, 'error', { message: msg });
    status = 'failed';
    finalText = finalText || `# Web Agent\n\nThe agent failed before completing: ${msg}`;
  } finally {
    await driver.stop().catch(() => {
      // ignore teardown failures
    });
  }

  const finalMarkdown = ensureMarkdown(finalText, session.task);
  const endedAt = new Date().toISOString();
  updateSession(sessionId, {
    status,
    ended_at: endedAt,
    result_markdown: finalMarkdown,
    action_log: log,
  });

  // Mirror to vault so Memory and All Searches buckets pick it up.
  const vaultFile = await mirrorToVault({
    id: sessionId,
    task: session.task,
    markdown: finalMarkdown,
  });
  if (vaultFile) {
    appendLog(log, sessionId, 'system', `vault mirror: ${vaultFile}`);
    updateSession(sessionId, { action_log: log });
  }

  bus.publish(sessionId, 'result', { markdown: finalMarkdown, vault_path: vaultFile });
  bus.publish(sessionId, 'status', { status, ended_at: endedAt });
  bus.publish(sessionId, 'done', { status, ended_at: endedAt });
}

// -- Anthropic call --------------------------------------------------------

interface CallAnthropicArgs {
  apiKey: string;
  model: string;
  messages: AnthropicMessage[];
  viewport: { width: number; height: number };
}

async function callAnthropic(args: CallAnthropicArgs): Promise<AnthropicResponse> {
  // Test/offline path: a fixture file emits a canned response, allowing CI
  // to exercise the runner without a real API key.
  const fixturePath = process.env.WEB_AGENT_FIXTURE_PATH;
  if (fixturePath) {
    const raw = await fs.readFile(fixturePath, 'utf8');
    return JSON.parse(raw) as AnthropicResponse;
  }

  const body = {
    model: args.model,
    max_tokens: 4096,
    tools: [
      {
        type: 'computer_20250124',
        name: 'computer',
        display_width_px: args.viewport.width,
        display_height_px: args.viewport.height,
        display_number: 1,
      },
    ],
    messages: args.messages,
  };

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': args.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'computer-use-2025-01-24',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as AnthropicResponse;
}

// -- Helpers ---------------------------------------------------------------

function appendLog(
  log: ActionLogEntry[],
  sessionId: string,
  kind: ActionLogEntry['kind'],
  description: string,
  detail?: Record<string, unknown>
): void {
  const entry: ActionLogEntry = {
    ts: new Date().toISOString(),
    kind,
    description,
    detail,
  };
  log.push(entry);
  getStreamBus().publish(sessionId, 'log', entry);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '...';
}

function coerceAction(input: Record<string, unknown>): ComputerAction | null {
  const action = input.action;
  if (typeof action !== 'string') return null;
  // Trust the structure provided by the model and let the driver throw if
  // something is malformed. The discriminated union in playwright-driver
  // covers every variant the computer tool emits.
  return { ...(input as Record<string, unknown>), action } as unknown as ComputerAction;
}

function ensureMarkdown(text: string, task: string): string {
  const trimmed = (text || '').trim();
  if (trimmed.length > 0) return trimmed;
  return `# Web Agent\n\n**Task:** ${task}\n\nThe agent did not return a final report.`;
}

async function mirrorToVault(args: {
  id: string;
  task: string;
  markdown: string;
}): Promise<string | null> {
  try {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const slug = slugifyTask(args.task);
    const dir = path.join(vaultRoot(), 'web-agent', yyyy, mm);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${yyyy}-${mm}-${dd}-${slug}.md`);
    const header = `<!-- web_agent_session_id: ${args.id} -->\n<!-- task: ${args.task.replace(/-->/g, '__')} -->\n`;
    await fs.writeFile(file, header + args.markdown, 'utf8');
    return file;
  } catch {
    return null;
  }
}
