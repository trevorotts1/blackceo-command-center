/**
 * Screenshot stream - in-memory pub/sub bus for the Web Agent SSE channel.
 *
 * Track B9 (SCOPE-ADDITION Section 7).
 *
 * The Playwright driver and the Claude Computer Use runner push events into
 * this bus (screenshot bytes, action log entries, status changes). The SSE
 * route at `/api/operator/web-agent/session/[id]/stream` subscribes per
 * session id and forwards events as `event: <type>` SSE frames.
 *
 * Events are also replayed to late subscribers from a small ring buffer so
 * the live view does not start blank if the operator opens the session a
 * fraction of a second after submitting the task.
 *
 * This module is intentionally process-local. The Web Agent runs in the same
 * Next.js server process (no worker queue at this phase), so a singleton
 * EventEmitter is the simplest correct model. If a future revision moves the
 * runner to a separate worker, swap this for a Redis pubsub channel keyed on
 * session id and the SSE route stays unchanged.
 */

import { EventEmitter } from 'events';

export type WebAgentEventType =
  | 'screenshot'
  | 'action'
  | 'status'
  | 'log'
  | 'result'
  | 'error'
  | 'done';

export interface WebAgentEvent {
  type: WebAgentEventType;
  // ISO timestamp the event was emitted at. Set by `publish` so callers do
  // not have to thread it through every site.
  ts: string;
  // JSON-serializable payload. The SSE route stringifies this verbatim.
  payload: unknown;
}

const RING_CAPACITY = 200;

class WebAgentStreamBus {
  private emitter = new EventEmitter();
  // Per-session ring buffer of the most recent events. Replayed on subscribe
  // so the live view never misses a beat the first paint.
  private rings = new Map<string, WebAgentEvent[]>();
  // Tracks sessions that have already emitted `done` so a late subscriber
  // gets the final state and immediately closes its SSE connection.
  private terminal = new Set<string>();

  constructor() {
    // Default Node EventEmitter caps at 10 listeners. The SSE route adds one
    // listener per active viewer and one viewer can open multiple tabs, so
    // lift the limit to avoid spurious warnings under normal use.
    this.emitter.setMaxListeners(100);
  }

  publish(sessionId: string, type: WebAgentEventType, payload: unknown): WebAgentEvent {
    const evt: WebAgentEvent = {
      type,
      ts: new Date().toISOString(),
      payload,
    };
    const ring = this.rings.get(sessionId) || [];
    ring.push(evt);
    if (ring.length > RING_CAPACITY) {
      ring.splice(0, ring.length - RING_CAPACITY);
    }
    this.rings.set(sessionId, ring);
    if (type === 'done') {
      this.terminal.add(sessionId);
    }
    this.emitter.emit(sessionId, evt);
    return evt;
  }

  subscribe(sessionId: string, handler: (evt: WebAgentEvent) => void): () => void {
    // Replay the buffered history synchronously so the consumer can flush it
    // into the SSE connection before any future event arrives.
    const ring = this.rings.get(sessionId);
    if (ring) {
      for (const evt of ring) {
        handler(evt);
      }
    }
    this.emitter.on(sessionId, handler);
    return () => {
      this.emitter.off(sessionId, handler);
    };
  }

  isTerminal(sessionId: string): boolean {
    return this.terminal.has(sessionId);
  }

  // Test-only escape hatch. The runner does not call this. Keeping the ring
  // around indefinitely is fine for the v4 scale (small operator process).
  clear(sessionId: string): void {
    this.rings.delete(sessionId);
    this.terminal.delete(sessionId);
  }
}

// Singleton per Node process. Next.js dev-mode hot reload calls `require`
// fresh, which is fine - any in-flight session reattaches via the SSE route
// once the runner re-publishes events post-reload.
declare global {
  // eslint-disable-next-line no-var
  var __bccWebAgentStreamBus: WebAgentStreamBus | undefined;
}

export function getStreamBus(): WebAgentStreamBus {
  if (!globalThis.__bccWebAgentStreamBus) {
    globalThis.__bccWebAgentStreamBus = new WebAgentStreamBus();
  }
  return globalThis.__bccWebAgentStreamBus;
}
