/**
 * safe-fs — TCC-aware, bounded-time filesystem primitives.
 *
 * WHY THIS EXISTS (proven live-client incident, 2026-07-14)
 * ---------------------------------------------------------
 * A client's Command Center hung DEAD for 13 hours while looking perfectly
 * healthy (PM2 online, port bound, zero restarts) because a synchronous
 * `fs.readdirSync('~/Downloads/openclaw-master-files/…')` on the boot path
 * BLOCKED FOREVER inside the kernel:
 *
 *     node::fs::ReadDir → uv_fs_scandir → scandir → __opendir2 → open$NOCANCEL
 *
 * macOS TCC (Transparency, Consent & Control) gates every `open()`/`opendir()`
 * under the user's ~/Downloads, ~/Desktop, ~/Documents (and iCloud Drive) for
 * an unprivileged BACKGROUND process (PM2 re-parented under launchd after a
 * reboot). Critically, it does **NOT** return EPERM — the syscall BLOCKS
 * INDEFINITELY awaiting a consent prompt that no headless process can ever
 * answer. Nothing is thrown, so try/catch cannot save you, and because the
 * boot path runs on the main thread that single blocked syscall freezes the
 * ENTIRE Node event loop: Next.js binds its port but never reaches "Ready",
 * never finishes instrumentation.register(), never registers cron.
 *
 * Measured behaviour (background/PM2 context, protected dir):
 *   - existsSync / statSync (metadata)  → OK, ~0 ms
 *   - readFileSync  (open)              → BLOCKS FOREVER
 *   - readdirSync   (opendir)           → BLOCKS FOREVER
 *
 * THE FIX (two independent guards, belt-and-suspenders)
 * -----------------------------------------------------
 *  1. isTccProtectedPath() classifies a path as living under a TCC-gated /
 *     network / removable location where open()/opendir() may block forever.
 *  2. For those paths ONLY, the read is performed in a CHILD PROCESS with a
 *     HARD wall-clock timeout and killSignal SIGKILL. A syscall that never
 *     returns therefore bounds the caller at PROBE_TIMEOUT_MS instead of
 *     freezing the event loop — the child is force-killed and the caller sees
 *     "unavailable" (never a throw, never a hang). SIGKILL is used precisely
 *     because open$NOCANCEL ignores SIGTERM; only SIGKILL reliably reaps a
 *     process stuck in the TCC consent wait.
 *
 * Non-protected paths (~/.openclaw, ~/clawd, /data, process.cwd()) take the
 * direct, fast synchronous fs.* call — zero overhead, unchanged behaviour.
 *
 * This module NEVER throws for the "would block" case and NEVER blocks the
 * event loop for longer than PROBE_TIMEOUT_MS. Any hanging FS call — TCC,
 * a dead NFS mount, an ejected volume — degrades gracefully to "unavailable".
 */
// Bare specifiers (not the `node:` scheme): this module is transitively bundled
// via platform.ts → provider-discovery.ts, and webpack rejects `node:` URIs in
// that bundle while externalizing bare builtins. Matches sop-auto-replace.ts.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/** Hard ceiling for a single bounded probe of a protected/network path. */
const PROBE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.TCC_PROBE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2000;
})();

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** Expand a leading `~` (only when it is the whole first segment). */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return homeDir();
  if (p.startsWith('~/') || p.startsWith('~' + path.sep)) {
    return path.join(homeDir(), p.slice(2));
  }
  return p;
}

function under(abs: string, base: string): boolean {
  return abs === base || abs.startsWith(base + path.sep);
}

/**
 * Is `p` under a macOS location where an unprivileged background process may
 * BLOCK FOREVER on open()/opendir()?
 *
 * Covers the TCC-gated user dirs (Downloads, Desktop, Documents), iCloud Drive
 * (~/Library/Mobile Documents — can stall on network), and removable / network
 * volumes (/Volumes, /net, /Network) where a dead mount blocks identically.
 *
 * Returns false on non-darwin platforms (Linux/VPS Docker has no TCC) so the
 * fast direct path is always taken there.
 */
export function isTccProtectedPath(p: string | null | undefined): boolean {
  if (!p) return false;
  let abs: string;
  try {
    abs = path.resolve(expandHome(p));
  } catch {
    return false;
  }

  // Removable / network volumes block the same way on a dead mount — guard on
  // every platform (an NFS/SMB stall is not macOS-specific).
  if (abs === '/Volumes' || under(abs, '/Volumes')) return true;
  if (under(abs, '/net') || under(abs, '/Network')) return true;

  // TCC privacy gating is macOS-only.
  if (process.platform !== 'darwin') return false;

  const home = homeDir();
  for (const sub of ['Downloads', 'Desktop', 'Documents']) {
    const base = path.join(home, sub);
    if (abs === base || under(abs, base)) return true;
  }
  // iCloud Drive.
  const icloud = path.join(home, 'Library', 'Mobile Documents');
  if (abs === icloud || under(abs, icloud)) return true;

  return false;
}

/* ─────────────────────────── degraded-state ledger ─────────────────────── */

export interface DegradedProbe {
  op: string;
  target: string;
  at: number;
}
const degradedProbes: DegradedProbe[] = [];

/** Record (and LOUDLY log) that a protected-path probe timed out — the service
 * is coming up WITHOUT that path rather than freezing on it. Operator-visible. */
function recordDegraded(op: string, target: string): void {
  degradedProbes.push({ op, target, at: Date.now() });
  console.error(
    `[safe-fs] DEGRADED: ${op}(${target}) exceeded ${PROBE_TIMEOUT_MS}ms and was ` +
      `abandoned (TCC-gated or dead mount). Continuing WITHOUT this path — the ` +
      `service stays up and serves, it does not freeze. Move master-files off ` +
      `~/Downloads · ~/Desktop · ~/Documents to a non-protected location ` +
      `(e.g. ~/.openclaw/master-files) to clear this.`,
  );
}

/** Snapshot of protected-path probes that timed out this process lifetime. */
export function getDegradedProbes(): DegradedProbe[] {
  return degradedProbes.slice();
}

/** True if any bounded probe has timed out (a real TCC/mount block was hit). */
export function isFilesystemDegraded(): boolean {
  return degradedProbes.length > 0;
}

/* ───────────────────────────── bounded probe ───────────────────────────── */

type ProbeOp = 'readdir' | 'readfile-utf8' | 'readfile-buffer' | 'stat';

// The child does the ONE blocking syscall and writes its raw result to an
// out-file inside os.tmpdir() (always a safe/fast location), then prints a
// tiny status line LAST. If the parent's timeout fires first the child is
// SIGKILLed mid-syscall; the parent never sees a status line and treats the
// path as unavailable. Writing the payload to a temp file (not stdout) keeps
// binary reads (QC images) byte-exact.
const CHILD_SCRIPT = `
const fs = require('fs');
const op = process.argv[1];
const target = process.argv[2];
const out = process.argv[3];
try {
  if (op === 'readdir') {
    const ents = fs.readdirSync(target, { withFileTypes: true })
      .map(function (d) { return { name: d.name, dir: d.isDirectory(), file: d.isFile() }; });
    fs.writeFileSync(out, JSON.stringify(ents));
  } else if (op === 'stat') {
    const s = fs.statSync(target);
    fs.writeFileSync(out, JSON.stringify({ dir: s.isDirectory(), file: s.isFile(), size: s.size, mtimeMs: s.mtimeMs }));
  } else if (op === 'readfile-utf8') {
    fs.writeFileSync(out, fs.readFileSync(target));
  } else if (op === 'readfile-buffer') {
    fs.writeFileSync(out, fs.readFileSync(target));
  }
  var fd = fs.openSync(out, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
  process.stdout.write('OK');
} catch (err) {
  process.stdout.write('ERR:' + String((err && err.code) || (err && err.message) || err));
}
`;

interface ProbeResult<T> {
  ok: boolean;
  timedOut: boolean;
  notFound: boolean;
  data?: T;
}

function boundedProbe<T>(op: ProbeOp, target: string): ProbeResult<T> {
  const outFile = path.join(
    os.tmpdir(),
    `safe-fs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  let status = '';
  try {
    const buf = execFileSync(process.execPath, ['-e', CHILD_SCRIPT, op, target, outFile], {
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    status = buf.toString('utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { signal?: string; killed?: boolean };
    const timedOut = e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL' || e.killed === true;
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* best-effort */
    }
    if (timedOut) recordDegraded(op, target);
    return { ok: false, timedOut, notFound: false };
  }

  if (!status.startsWith('OK')) {
    // Child caught an fs error (ENOENT/EACCES/…) — a real, fast answer, NOT a
    // block. Treat like the direct call's catch: unavailable, not degraded.
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* best-effort */
    }
    const notFound = status.includes('ENOENT');
    return { ok: false, timedOut: false, notFound };
  }

  try {
    let data: unknown;
    if (op === 'readfile-buffer') {
      data = fs.readFileSync(outFile);
    } else if (op === 'readfile-utf8') {
      data = fs.readFileSync(outFile, 'utf8');
    } else {
      data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    }
    return { ok: true, timedOut: false, notFound: false, data: data as T };
  } catch {
    return { ok: false, timedOut: false, notFound: false };
  } finally {
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* best-effort */
    }
  }
}

/* ─────────────────────────── public accessors ──────────────────────────── */

export interface SafeDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * TCC-safe fs.readdirSync(dir, { withFileTypes: true }). Never blocks longer
 * than PROBE_TIMEOUT_MS on a protected path; returns [] when the directory is
 * absent, unreadable, OR the probe timed out (degraded — logged loudly).
 */
export function safeReaddirSync(dir: string): SafeDirent[] {
  if (!isTccProtectedPath(dir)) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }) as unknown as SafeDirent[];
    } catch {
      return [];
    }
  }
  const res = boundedProbe<Array<{ name: string; dir: boolean; file: boolean }>>('readdir', dir);
  if (!res.ok || !res.data) return [];
  return res.data.map((d) => ({
    name: d.name,
    isDirectory: () => d.dir,
    isFile: () => d.file,
  }));
}

/** TCC-safe list of entry NAMES (fs.readdirSync(dir) shape). */
export function safeReaddirNames(dir: string): string[] {
  return safeReaddirSync(dir).map((d) => d.name);
}

/**
 * TCC-safe fs.readFileSync(path, 'utf8'). Returns null when the file is absent,
 * unreadable, or the probe timed out. Never blocks the loop past the deadline.
 */
export function safeReadFileUtf8(file: string): string | null {
  if (!isTccProtectedPath(file)) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }
  const res = boundedProbe<string>('readfile-utf8', file);
  return res.ok && typeof res.data === 'string' ? res.data : null;
}

/** TCC-safe fs.readFileSync(path) returning a Buffer (byte-exact; for images). */
export function safeReadFileBuffer(file: string): Buffer | null {
  if (!isTccProtectedPath(file)) {
    try {
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  }
  const res = boundedProbe<Buffer>('readfile-buffer', file);
  return res.ok && Buffer.isBuffer(res.data) ? res.data : null;
}

export interface SafeStat {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
  mtimeMs: number;
}

/**
 * TCC-safe fs.statSync. Metadata (stat) is measured-safe on ~/Downloads etc.,
 * so on those TCC dirs we take the FAST direct call. We only route through the
 * bounded child for NETWORK / REMOVABLE volumes, where even stat can block on a
 * dead mount. Returns null when the target is absent, unreadable, or timed out.
 */
export function safeStatSync(target: string): SafeStat | null {
  const needsBound =
    target != null &&
    (() => {
      let abs: string;
      try {
        abs = path.resolve(expandHome(target));
      } catch {
        return false;
      }
      return (
        abs === '/Volumes' ||
        under(abs, '/Volumes') ||
        under(abs, '/net') ||
        under(abs, '/Network') ||
        (process.platform === 'darwin' &&
          under(abs, path.join(homeDir(), 'Library', 'Mobile Documents')))
      );
    })();

  if (!needsBound) {
    try {
      const s = fs.statSync(target);
      return { isDirectory: () => s.isDirectory(), isFile: () => s.isFile(), size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  }
  const res = boundedProbe<{ dir: boolean; file: boolean; size: number; mtimeMs: number }>('stat', target);
  if (!res.ok || !res.data) return null;
  const d = res.data;
  return { isDirectory: () => d.dir, isFile: () => d.file, size: d.size, mtimeMs: d.mtimeMs };
}

/** TCC-safe existence check (metadata-only; never blocks on TCC dirs). */
export function safeExistsSync(target: string): boolean {
  return safeStatSync(target) != null;
}

/** TCC-safe "is an existing regular file". */
export function safeIsFile(target: string): boolean {
  const s = safeStatSync(target);
  return s != null && s.isFile();
}

/** TCC-safe "is an existing directory". */
export function safeIsDir(target: string): boolean {
  const s = safeStatSync(target);
  return s != null && s.isDirectory();
}
