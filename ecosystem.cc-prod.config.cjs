/**
 * PM2 ecosystem config — LOCAL "cc-prod" Command Center (operator box).
 *
 * WHY THIS FILE EXISTS
 *   The operator's local Command Center runs under the pm2 app name `cc-prod`
 *   (not the fleet-canonical `blackceo-command-center`). The original `cc-prod`
 *   process was started ad-hoc from an interactive shell with NO restart
 *   circuit-breaker, so a fatal launcher exit (stale build) crash-looped it
 *   74,528 times. This file reintroduces `cc-prod` with the SAME hardened
 *   launcher (scripts/cc-start.sh) AND the circuit-breaker the ad-hoc start
 *   lacked, so it can never hammer again.
 *
 * CIRCUIT-BREAKER (the fix for the 74k-restart loop):
 *   min_uptime                 — a process that dies before this counts as a
 *                                FAILED start (so max_restarts actually trips).
 *   max_restarts               — after this many failed starts pm2 moves the app
 *                                to `errored` and STOPS trying (no more hammer).
 *   exp_backoff_restart_delay  — exponential backoff between restarts (500ms →
 *                                1s → 2s → 4s …) instead of a tight full-speed
 *                                loop, so even the pre-error attempts don't hammer
 *                                the port/disk.
 *
 * ENV MODEL (fleet-standard, matches ecosystem.config.cjs):
 *   The app loads its operational secrets from .env.local (Next.js auto-loads it
 *   from the project root at `next start`) and hydrates provider keys from the
 *   OpenClaw secret files at boot (src/instrumentation.ts). So this pm2 env block
 *   stays MINIMAL: only NODE_ENV, CC_PORT and the canonical DATABASE_PATH, plus
 *   the same conditional pass-throughs the canonical config uses (never blanks a
 *   .env.local value — each is spread ONLY when present in the start environment).
 *
 * LAUNCHER: never call `next start` directly — always via scripts/cc-start.sh,
 *   which strips ambient PORT, kills orphan :4000 holders, and FAIL-LOUD exits on
 *   a missing/stale build so this circuit-breaker (not an infinite loop) surfaces
 *   the problem.
 */

const path = require('path');
// Match the fleet-canonical ecosystem.config.cjs resolution pattern:
// CC_INSTALL_DIR takes precedence; fall back to process.cwd() so the cc-prod
// process always starts from the directory this config was loaded from.
const INSTALL_DIR = process.env.CC_INSTALL_DIR || process.cwd();
// Canonical absolute DB path — identical to .env.local and the previously
// working cc-prod pm2 env, so a restart always opens the same database.
const DB_PATH = process.env.DATABASE_PATH || path.join(process.env.HOME, 'command-center/data/mission-control.db');
// CC_PORT ONLY — cc-start.sh reads this, strips ambient PORT, then re-exports it.
const CC_PORT = process.env.CC_PORT || '4000';

// ── ISSUE-09: NODE RUNTIME IDENTITY (resolved at config load) ────────────────
// This config used to run `script: 'bash'` with no interpreter and no PATH,
// and scripts/cc-start.sh then exec'd a BARE `node` off whatever PATH pm2
// happened to inherit. On a Mac that is launchd's minimal PATH at boot and the
// operator's interactive PATH after `pm2 restart --update-env`, which are not
// the same node. Meanwhile `postinstall` compiles better-sqlite3 against
// whichever node ran npm. Client boxes ended up running the app on node@24
// (ABI 137) while cron and update shells resolved Node 26 (ABI 147), so every
// update reintroduced a NODE_MODULE_VERSION crash loop.
//
// scripts/lib/node-runtime.sh is now the single place that decides, and it is
// asked HERE so the resolved binary reaches the pm2 child env. CC_NODE_BIN is
// what cc-start.sh execs; its directory is prepended to PATH so any tool the
// app shells out to resolves the same node.
//
// FAIL LOUD, never fall back. A config that silently defaults to bare `node`
// is exactly the defect: pm2 would start, the app would load a native module
// built for a different ABI, and the box would crash-loop with a message that
// names neither the config nor the runtime. Throwing here surfaces the real
// problem, with the install command, before anything starts.
// spawnSync rather than execFileSync: stderr has to be CAPTURED so the
// resolver's remedy can be folded into the thrown Error (pm2 surfaces a
// config-load throw, but does not reliably surface a child's inherited
// stderr), AND re-emitted on the success path so a warning about an override
// pinning the wrong major is never silent. Only spawnSync gives both.
const { spawnSync } = require('child_process');

function resolveCcNodeBin() {
  const resolver = path.join(__dirname, 'scripts', 'lib', 'node-runtime.sh');
  const proc = spawnSync('bash', [resolver], { encoding: 'utf8' });
  const stderr = String((proc && proc.stderr) || '').trim();
  if (proc.error || proc.status !== 0) {
    const detail = stderr || String((proc.error && proc.error.message) || 'resolver exited ' + proc.status);
    throw new Error(
      'BlackCEO Command Center: cannot resolve the Node runtime, refusing to start.\n' +
      detail + '\n' +
      'Resolver: ' + resolver + '\n' +
      'Set CC_NODE_BIN to an explicit node path to override.'
    );
  }
  if (stderr) process.stderr.write(stderr + '\n');
  const resolved = String(proc.stdout || '').trim();
  if (!resolved) {
    throw new Error(
      'BlackCEO Command Center: ' + resolver + ' exited 0 but named no node binary. Refusing to start.'
    );
  }
  return resolved;
}

const CC_NODE_BIN = resolveCcNodeBin();
const CC_NODE_DIR = path.dirname(CC_NODE_BIN);

module.exports = {
  apps: [{
    name: 'cc-prod',
    script: 'bash',
    args: `scripts/cc-start.sh --port ${CC_PORT}`,
    cwd: INSTALL_DIR,
    env: {
      NODE_ENV: 'production',
      CC_PORT: CC_PORT,
      DATABASE_PATH: DB_PATH,
      // ISSUE-09: the resolved fleet runtime. Its directory is prepended to the
      // pinned PATH below, so `node` there is the same binary cc-start.sh execs.
      CC_NODE_BIN: CC_NODE_BIN,

      // ── MSG-08 (2026-07-15): OPERATOR-OWNER CLEAN NOTIFY (this box ONLY) ──
      // This IS the operator's own board: resolveOwnerChatId() is structurally
      // always null here (validOwnerChatId() rejects every operator id — the
      // guardrail that stops a CLIENT box DMing the operator as its owner), so
      // every owner report his own tasks generate used to fall into
      // escalateUndeliverableOwner() and self-spam an "UNDELIVERABLE owner"
      // digest. With this flag set, and ONLY after resolveOwnerChatId() returns
      // null, notifyOwner() delivers the owner-facing message directly to the
      // resolved OPERATOR chat id — cleanly, ONCE, no UNDELIVERABLE wrapper
      // (src/lib/notify.ts operatorIsOwnerBox() / MSG-08). NEVER set on a client
      // box — it is provisioned here only, on the operator's own machine.
      CC_OPERATOR_IS_OWNER: '1',

      // ── NOTIFY-01 (2026-07-14): OWNER NOTIFICATIONS ARE 100% DEAD ─────────
      // src/lib/notify.ts fires execFile('openclaw', […], { timeout: 5_000 }).
      // MEASURED on this box: a real, SUCCESSFULLY DELIVERED
      //   `openclaw message send --channel telegram --target <real chat>`
      // takes 6.19s–6.38s (exit 0). The budget is 5.00s. So execFile ALWAYS
      // SIGTERM-kills the child ~1.2s before it finishes, and logs
      //   "[notify] Telegram send failed … Command failed: openclaw message send"
      // with an EMPTY stderr. Empty-stderr "Command failed" == a TIMEOUT KILL;
      // a missing binary would read "spawn openclaw ENOENT". This was NEVER a
      // PATH bug, and it is not intermittent — EVERY owner notification dies.
      //
      // *** THIS CANNOT BE FIXED FROM THIS FILE. *** OWNER_SEND_TIMEOUT_MS is a
      // compile-time const (src/lib/notify.ts:40), not an env var. The real fix
      // is one line in the repo: 5_000 -> 30_000. It is safe — notifyTelegram()
      // is deliberately fire-and-forget (not awaited), so a longer timeout
      // cannot block the event loop. This is a FLEET-WIDE defect: every client
      // Command Center shells out to the same ~3-6s CLI under the same 5s cap.
      //
      // The var below is NOT the fix. It only removes the CLI's auto-update
      // NETWORK round-trip from a production hot path, which cut the tail
      // outlier (a 5.15s spike) and reduced variance. Kept as a cheap win.
      // (OPENCLAW_NO_RESPAWN was tested and REJECTED: it measured slightly
      // SLOWER — 6.38s vs 6.19s — most likely by defeating the CLI's respawn
      // into a warm compile cache.)
      OPENCLAW_NO_AUTO_UPDATE: '1',

      // ── NOTIFY-02: PIN THE MUTE **OFF** FOR PRODUCTION ────────────────────
      // A temporary anti-spam mute exports OWNER_NOTIFY_TELEGRAM_DISABLED=1 in
      // ~/.zshenv, so EVERY interactive shell on this box carries it. notify.ts
      // honours it IN-PROCESS (src/lib/notify.ts:322 → returns false BEFORE it
      // ever shells out). So a single `pm2 restart cc-prod --update-env` run
      // from the operator's own shell would inherit =1 and silently mute the
      // production Command Center FOREVER — no error, no log, alerts just gone.
      // Pinning it here makes cc-prod immune to whatever the restarting shell
      // carries. This does NOT weaken the test guard: test/dev sends are still
      // blocked by ~/.openclaw/openclaw-send-guard.sh and the ~/.openclaw-testshim
      // PATH shim, neither of which is touched. (Set to '1' to mute cc-prod.)
      OWNER_NOTIFY_TELEGRAM_DISABLED: '0',

      // ── NOTIFY-03: EXPLICIT PATH (PM2 under launchd has a minimal PATH) ───
      // Pinned so `openclaw` and `npx` always resolve, and — critically — so a
      // --update-env restart from a shell whose PATH is prefixed with
      // ~/.openclaw-testshim can NEVER make production resolve `openclaw` to the
      // test shim that swallows sends. The test shim is deliberately ABSENT here.
      //
      // ISSUE-09: CC_NODE_DIR goes FIRST. The entries below list /usr/local/bin
      // and /opt/homebrew/bin, either of which can hold a node of the wrong
      // major, and whichever came first used to win. The resolved fleet runtime
      // now precedes both, so every tool this process shells out to sees the
      // same node the app itself runs on.
      PATH: [
        CC_NODE_DIR,                                    // ISSUE-09: fleet runtime
        path.join(process.env.HOME, '.npm-global/bin'), // openclaw, npx
        path.join(process.env.HOME, '.local/bin'),      // openclaw (symlink)
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/bin', '/bin', '/usr/sbin', '/sbin',
      ].join(':'),

      // Conditional pass-throughs (identical policy to ecosystem.config.cjs):
      // spread ONLY when present so an unset value never overrides .env.local.
      ...(process.env.COMPANY_NAME ? { COMPANY_NAME: process.env.COMPANY_NAME } : {}),
      ...(process.env.OPENCLAW_GATEWAY_URL ? { OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL } : {}),
      ...(process.env.OPENCLAW_GATEWAY_TOKEN ? { OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN } : {}),
      ...(process.env.MC_API_TOKEN ? { MC_API_TOKEN: process.env.MC_API_TOKEN } : {}),
      ...(process.env.WEBHOOK_SECRET ? { WEBHOOK_SECRET: process.env.WEBHOOK_SECRET } : {})
    },
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    // ── CIRCUIT-BREAKER (per remediation spec) ──────────────────────────────
    min_uptime: 10000,               // <10s uptime = a failed start
    max_restarts: 10,                // after 10 failed starts → errored, stop looping
    exp_backoff_restart_delay: 500,  // exponential backoff (500ms → 1s → 2s → …)
    // Missing/stale builds exit 78: require a rebuild instead of endless restarts.
    stop_exit_codes: [78],
    kill_timeout: 10000,
    watch: false,
    max_memory_restart: '512M'
  }]
};
