/** Shared browser request boundary: HTTP errors are failures, not empty data. */
export async function checkedJson<T>(url: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Access could not be verified. Sign in again or contact your operator.');
      throw new Error(`Refresh failed (HTTP ${response.status}). Please retry.`);
    }
    return await response.json() as T;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('The request timed out. Please retry.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
