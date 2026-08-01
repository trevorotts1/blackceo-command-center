/**
 * STARTUP FILESYSTEM LOCK (MR-35).
 *
 * The CC process claims a lock file next to the production database before
 * opening it. A second process that tries to boot against the same DB path will
 * find the lock held and (after a stale-PID check) exit cleanly instead of
 * fighting for the SQLite WAL — breaking the SSE single-process constraint and
 * creating two independent in-memory Client sets over one shared DB (the C8
 * leak class’s sibling: two CC servers, one SQLite file, zero coordination).
 *
 * This is BELT-AND-SUSPENDERS on top of the reactive protections that already
 * exist: the PM2 ecosystem declares `instances: 1, exec_mode: 'fork'`, the
 * watchdog self-heals when it sees `app_count > 1`, the orphan-port killer
 * reclaims :4000 before `next start` binds it, and `pm2-single-instance-guard`
 * audits configurations at commit time. Every one of those can be bypassed by
 * a human starting a manual `npx next start` from a shell, or by a
 * misconfigured PM2 on a box that has never run the installer. This lock is the
 * LAST line of defence: it runs INSIDE the process and cannot be skipped by any
 * external config.
 *
 * LOCK FILE LIFETIME:
 *   - Created atomically (O_CREAT | O_EXCL) the first time the server calls
 *     claimStartupLock().
 *   - Released on normal `SIGTERM`/`SIGINT`/`exit`/`beforeExit`.
 *   - Removed on `SIGKILL` only by the NEXT process that boots: it reads the
 *     PID from the lock and checks `/proc/<pid>` or `kill -0 <pid>`; if dead,
 *     it steals (unlinks + re-creates) the lock.
 *
 * OPT-OUT:
 *   - NODE_ENV === 'test' — tests open their own isolated DBs, never the live
 *     production path.
 *   - DISABLE_STARTUP_LOCK=1 — operator escape hatch for emergency dual-boot
 *     debugging. Use with extreme care.
 *   - `vitest` or `node:test` runner detected via argv — prevents lock
 *     creation in unit-test processes that load instrumentation.ts for imports.
 *
 * PREVIOUS FAILURE MODE (now impossible with this lock):
 *   A stale `next start` from a prior PM2 incarnation could still be running
 *   on a different port (or no port at all, e.g. a `tsx`-spawned dev server),
 *   holding the WAL open. The next `pm2 restart` would start a second CC that
 *   enumerates Clients, writes task updates, and beats the SIGKILL timing so
 *   both run for a period — two Next.js SSR engines serving the same Kanban
 *   board. This lock PREVENTS the second process from even opening the DB.
 */

import fs from 'fs';
import path from 'path';

const LOCK_FILENAME = 'mission-control.lock';

let lockFd: number | null = null;
let lockPath: string | null = null;

/** Escape hatch: set DISABLE_STARTUP_LOCK=1 to skip the lock entirely. */
function isLockDisabled(): boolean {
  return (
    process.env.DISABLE_STARTUP_LOCK === '1' ||
    process.env.DISABLE_STARTUP_LOCK === 'true'
  );
}

/** True when the current process is a test runner — never lock in tests. */
function isTestProcess(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID !== undefined) return true;
  const argv = process.argv.join(' ');
  if (argv.includes('vitest') || argv.includes('node:test')) return true;
  if (argv.includes('tsx') && (argv.includes('.test.ts') || argv.includes('.test.tsx'))) return true;
  return false;
}

/**
 * Check whether PID `pid` is alive on this host.
 *
 * On Linux/macOS: `kill(pid, 0)` returns 0 if the process exists and we can
 * signal it; `ESRCH` means the PID is free. On containers without a shell this
 * still works — it is a raw syscall, not a shell builtin.
 *
 * On Windows: not supported (CC does not run on Windows in production).
 * Returns false so the stale-detection path degrades to a warning.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return false;
    // EPERM means it exists but we cannot signal it — still alive.
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Read the PID from a lock file.
 * Format: the lock file contains a decimal PID followed by a newline, e.g.
 * "12345\n". Malformed files return null.
 */
function readLockPid(filePath: string): number | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
    return null;
  } catch {
    return null;
  }
}

/**
 * Release the lock held by this process: close the fd and unlink the file.
 * Idempotent — safe to call multiple times.
 */
function releaseLock(): void {
  if (lockFd !== null) {
    try {
      fs.closeSync(lockFd);
    } catch {
      /* best-effort */
    }
    lockFd = null;
  }
  if (lockPath !== null) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* file may already be gone */
    }
    lockPath = null;
  }
}

/**
 * Register exit handlers that release the lock.
 * Called exactly once after a successful claim.
 */
function registerReleaseHandlers(release: () => void): void {
  // Normal exit — process.on('exit') fires from clean shutdowns.
  process.on('exit', release);

  // beforeExit fires when the event loop empties (expected in Next.js).
  process.on('beforeExit', release);

  // SIGTERM / SIGINT — PM2 sends SIGTERM for graceful stop.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }

  // uncaughtException — release lock on crash so a restart is not blocked by
  // the stale-PID detection window.
  process.on('uncaughtException', (err) => {
    release();
    console.error('[startup-lock] uncaught exception — lock released:', err);
    process.exit(1);
  });
}

/**
 * Claim the startup lock for the database at `dbDir`.
 *
 * On success: the lock file is created, this process's PID is written, and
 * release handlers are registered. Returns `true`.
 *
 * On failure: the lock is already held by another LIVE process. The function
 * prints a clear, actionable error to stderr and returns `false`. The caller
 * should exit the process.
 *
 * Stale lock: if the PID in the lock file is DEAD, the function unlinks the
 * stale file and retries once. This is logged so an operator can trace the
 * takeover.
 *
 * MUST be called BEFORE `getDb()` opens the database file — otherwise two
 * processes both hold an open WAL handle by the time the lock is checked.
 */
export function claimStartupLock(dbDir: string): boolean {
  if (isLockDisabled()) {
    console.log('[startup-lock] DISABLE_STARTUP_LOCK=1 — skipping lock (operator escape hatch)');
    return true;
  }

  if (isTestProcess()) {
    console.log('[startup-lock] test environment detected — skipping lock');
    return true;
  }

  const filePath = path.join(dbDir, LOCK_FILENAME);

  // Attempt 1: atomic create-or-fail.
  try {
    lockFd = fs.openSync(filePath, 'wx');
    fs.writeSync(lockFd, `${process.pid}\n`);
    lockPath = filePath;
    registerReleaseHandlers(releaseLock);
    console.log(`[startup-lock] lock acquired (pid ${process.pid}, file ${filePath})`);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EEXIST') {
      // Unexpected error — the file system is broken, not a duplicate process.
      // Do NOT block boot for a permission error on a tmpfs.
      console.error(
        `[startup-lock] WARNING: could not create lock file (${code}): ${String(err)}. ` +
          'Proceeding WITHOUT the startup-lock guarantee — this process may share the DB ' +
          'with another CC instance.',
      );
      return true;
    }
    // EEXIST — lock file is present. Check if the holder is stale.
  }

  // Stale-check path: read the holder PID and probe it.
  const holderPid = readLockPid(filePath);
  if (holderPid === null) {
    // Lock file exists but has a malformed PID — treat as stale.
    console.warn(
      `[startup-lock] lock file ${filePath} exists but has no valid PID — assuming stale, stealing lock`,
    );
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* best-effort */
    }
    return claimStartupLock(dbDir); // retry once
  }

  if (!isPidAlive(holderPid)) {
    // Stale lock: holder PID is dead. Remove the stale file and retry.
    console.warn(
      `[startup-lock] stale lock detected: pid ${holderPid} is not alive. ` +
        `Removing stale lock file and retrying.`,
    );
    try {
      fs.unlinkSync(filePath);
    } catch {
      console.error(
        `[startup-lock] WARNING: could not unlink stale lock file ${filePath}. ` +
          `Proceeding WITHOUT the lock — this process may share the DB.`,
      );
      return true;
    }
    return claimStartupLock(dbDir); // retry once
  }

  // Lock is held by a LIVE process — refuse to boot.
  console.error(
    '\n' +
      '╔══════════════════════════════════════════════════════════════════╗\n' +
      '║  STARTUP LOCK: ANOTHER CC INSTANCE IS ALREADY RUNNING            ║\n' +
      '╠══════════════════════════════════════════════════════════════════╣\n' +
      `║  Lock file : ${filePath.padEnd(56)}║\n` +
      `║  Held by   : pid ${String(holderPid).padEnd(50)}║\n` +
      '║                                                                ║\n' +
      '║  Two CC processes sharing one SQLite database creates two       ║\n' +
      '║  independent in-memory Client sets over a single source of      ║\n' +
      '║  truth — the SSE single-process constraint is broken, task      ║\n' +
      '║  dispatching races, and the Kanban board diverges.              ║\n' +
      '║                                                                ║\n' +
      '║  To recover:                                                    ║\n' +
      `║  1. Stop the running CC:  pm2 stop blackceo-command-center      ║\n` +
      `║     (or) kill pid ${String(holderPid).padEnd(47)}║\n` +
      '║  2. Remove the lock:      rm <path>                             ║\n' +
      '║  3. Retry start.                                                ║\n' +
      '║                                                                ║\n' +
      '║  Escape hatch: DISABLE_STARTUP_LOCK=1 (ONLY for emergency       ║\n' +
      '║  dual-boot debugging — never for regular operation).            ║\n' +
      '╚══════════════════════════════════════════════════════════════════╝\n',
  );
  return false;
}
