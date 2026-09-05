type EventRow = Record<string, unknown>;

/** Acceptance and its asynchronous audit write are separate checkpoints. */
export async function waitForDispatchReceipt(options: {
  taskId: string;
  executionId: string;
  readEvents: () => Promise<EventRow[]>;
  diagnostics: () => Promise<unknown>;
  timeoutMs: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<EventRow> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;
  let events: EventRow[] = [];
  for (;;) {
    events = await options.readEvents();
    for (const event of events) {
      if (event.task_id !== options.taskId || event.type !== 'task_dispatched') continue;
      try {
        const metadata = JSON.parse(String(event.metadata));
        if (metadata?.execution_id === options.executionId) return event;
      } catch { /* A malformed or legacy event cannot prove this execution. */ }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(options.intervalMs ?? 100, remaining));
  }
  throw new Error(`Timeout waiting for actual dispatch event: task=${options.taskId} execution=${options.executionId}. ` +
    `Event types: ${JSON.stringify(events.map(e => e.type))}. Diagnostics: ${JSON.stringify(await options.diagnostics())}`);
}
