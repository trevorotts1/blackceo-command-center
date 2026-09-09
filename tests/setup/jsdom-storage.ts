/**
 * Use this test file's actual jsdom storage, never Node's process-global Web
 * Storage. Recent Node releases expose localStorage even without a backing
 * file; Vitest then preserves that undefined/native global instead of jsdom's
 * browser implementation. Binding both stores also keeps files isolated.
 */
const browserWindow = (globalThis as typeof globalThis & {
  jsdom: { window: Window };
}).jsdom.window;

for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: browserWindow[name],
  });
}
