/**
 * CWE-035 per-key async mutex.
 *
 * better-sqlite3 work is synchronous, but createTaskCore is async, so
 * two overlapping ensure/materialize calls for the same session could
 * interleave at await points. This mutex serializes the find-or-create
 * critical sections per key; the database unique constraints
 * (task_request_keys primary key, council_kanban_links and
 * council_task_links uniques) remain the cross-process backstop.
 */
const tails = new Map<string, Promise<void>>();

export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => gate);
  tails.set(key, tail);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
