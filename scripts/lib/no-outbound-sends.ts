/**
 * no-outbound-sends.ts — the smoke-script muzzle (SAFETY-05).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `src/lib/notify.ts` is now fail-closed (SAFETY-01): it refuses to send inside a
 * test runner. But it detects a test runner from the environment the RUNNER sets —
 * NODE_TEST_CONTEXT (node --test), VITEST, JEST_WORKER_ID, NODE_ENV=test, or CI.
 *
 * A smoke script run BARE — `npx tsx scripts/smoke-test-*.ts` — has NO runner.
 * Node sets none of those variables, and the `--import ./tests/setup/...` hook that
 * `npm run test:unit` relies on is never loaded either. So as far as notify.ts can
 * tell, a bare smoke script is indistinguishable from production... because at the
 * process level it IS. This is the one hole SAFETY-01 cannot close by itself, and
 * it is a real one: `smoke-test-converge-and-dept.ts` drives the tasks/ingest route,
 * which calls notifyOwnerAssigned() -> notifyOwner() -> a REAL `openclaw message
 * send`. It sandboxes the DATABASE and nothing else.
 *
 * So a smoke script must DECLARE itself. Importing this module first does that: it
 * sets the explicit mute and strips the operator/webhook pins, so nothing can leave
 * the box no matter which route or job the script ends up driving.
 *
 * CONTRACT: any script under scripts/ whose import graph reaches src/lib/notify.ts
 * and which is a TEST (not a real job) MUST import this FIRST:
 *
 *     import './lib/no-outbound-sends.js';
 *
 * `tests/unit/notify-hardening.test.ts` ENFORCES this — it walks the
 * import graph of every scripts/smoke-*.ts and fails if one reaches notify.ts
 * without this guard. It is checked, not remembered.
 *
 * DO NOT import this from a real job (scripts/sop-auto-replace-job.ts) or from an
 * operator maintenance script (scripts/clear-qc-heuristic-final.ts). Those SHOULD
 * notify — muzzling them would re-create the silent-drop bug MSG-07 fixed.
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';

// Strip every pin that could resolve a real chat id / escalation target, so even a
// code path that somehow bypassed the gate has nowhere to send.
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;

export {};
