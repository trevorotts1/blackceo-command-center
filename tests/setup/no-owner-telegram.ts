/**
 * SAFETY-01 — suite-wide owner-notification mute.
 *
 * Loaded via `node --import ./tests/setup/no-owner-telegram.ts` from the
 * `test:unit` script, so it runs FIRST in every unit-test child process,
 * before any test file's module scope executes.
 *
 * This is the SECOND of two independent layers. It is deliberately redundant:
 *
 *   Layer 1 (primary, un-bypassable): src/lib/notify.ts::ownerSendsSuppressed()
 *     refuses every send when it detects a test runner. It needs no cooperation
 *     from this file, the npm script, or the test author — so it still holds
 *     when someone runs a single file directly
 *     (`node --import tsx --test tests/unit/foo.test.ts`) or adds a new runner.
 *
 *   Layer 2 (this file): sets the documented OWNER_NOTIFY_TELEGRAM_DISABLED=1
 *     contract for the whole suite, so the repo's long-standing env-var gate is
 *     satisfied by default instead of being re-typed in each of ~20 test files
 *     and forgotten in the 21st. That omission is exactly what shipped live
 *     Telegram messages to a real person's phone.
 *
 * Layer 1 alone is sufficient to prevent a send. Layer 2 alone is NOT (it is
 * bypassed by running a test file directly). Keeping both means the failure of
 * either one is not a leak.
 */
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
