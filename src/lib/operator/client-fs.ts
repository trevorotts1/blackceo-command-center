/**
 * Per-client filesystem access for the Operator Console feature clusters.
 *
 * The SINGLE-TENANT → PER-CLIENT foundation (src/lib/clients.ts +
 * src/lib/platform.ts) gives every feature a SELECTED client and a
 * `resolveClientPath(client, kind)` descriptor that is EITHER a local absolute
 * path (the operator's own box) OR a remote descriptor that lives on the
 * client's box and must be reached over the Cloudflare Access SSH tunnel.
 *
 * Feature clusters (Journal mirror, Memory search, Notebooks, Workspace, …)
 * should NOT each re-implement that branch. This module is the one place that:
 *
 *   - resolves a kind for the CURRENTLY SELECTED client (`selectedClientPath`),
 *   - reads a directory tree or a single file for that client regardless of
 *     whether it is local or remote (`readClientDir`, `readClientFile`),
 *   - writes a file for that client (`writeClientFile`) — local fs for self,
 *     remote `cat > file` over SSH for a remote client,
 *
 * and ALWAYS fails soft: a down tunnel, a missing `ssh_target`, a missing
 * `cloudflared`, or any SSH error returns an empty result / `null` plus a
 * structured `RemoteError`, never an unhandled throw into a route or the UI.
 *
 * SSH transport matches the fleet's documented pattern: connect over the
 * Cloudflare Access tunnel with `cloudflared` as the ProxyCommand and the
 * CF-Access service token injected as env. The absolute `cloudflared` path is
 * required because a non-login shell has no Homebrew on PATH.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import {
  getClientContext,
  type Client,
} from '@/lib/clients';
import {
  resolveClientPath,
  type ClientPathKind,
  type ResolvedClientPath,
} from '@/lib/platform';

/** Absolute path to cloudflared. A non-login SSH shell has no Homebrew PATH. */
const CLOUDFLARED_BIN = process.env.BCC_CLOUDFLARED_BIN || '/opt/homebrew/bin/cloudflared';

/** Hard ceiling on a remote command's runtime so a hung tunnel cannot wedge a request. */
const REMOTE_TIMEOUT_MS = 12_000;

/** Cap remote output so a runaway `find`/`cat` cannot exhaust memory. */
const REMOTE_MAX_BUFFER = 8 * 1024 * 1024;

export interface RemoteError {
  /** True when the read/write could not complete (tunnel down, no ssh target, ssh error). */
  failed: true;
  /** Human-readable, UI-safe reason. Never contains secrets. */
  reason: string;
  /** True specifically when the client has no `ssh_target` configured. */
  notConfigured?: boolean;
}

export interface ClientFile {
  /** Path relative to the resolved root. */
  relPath: string;
  /** Absolute path on the box the file lives on (local or remote). */
  absPath: string;
  /** UTF-8 contents. */
  contents: string;
  /** ISO mtime when known (local reads always have it; remote is best-effort). */
  mtime: string | null;
  /** Byte size when known. */
  size: number | null;
}

export interface ReadClientDirResult {
  /** The client whose box was read. */
  client: Client;
  /** Resolved root (local path or remote descriptor). */
  root: ResolvedClientPath;
  /** Files read. Empty when the root is missing or the remote read failed. */
  files: ClientFile[];
  /** Set when a remote read failed; the UI renders a soft-degraded state. */
  error: RemoteError | null;
}

/**
 * Resolve a path-kind for the currently selected client. Falls back to the
 * self client when nothing is selected. Returns null only when the clients
 * table is empty (should not happen after migration 048 seeds self).
 */
export function selectedClientPath(kind: ClientPathKind): { client: Client; resolved: ResolvedClientPath } | null {
  const client = getClientContext();
  if (!client) return null;
  return { client, resolved: resolveClientPath(client, kind) };
}

/** True when the selected (or supplied) client's data lives on a remote box. */
export function clientIsRemote(client?: Client | null): boolean {
  const c = client ?? getClientContext();
  return !!c && !c.is_self;
}

// ---------------------------------------------------------------------------
// SSH-over-Cloudflare-tunnel transport
// ---------------------------------------------------------------------------

interface RemoteExecOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  reason?: string;
}

/**
 * Build the SSH argv + env for a remote command over the Cloudflare Access
 * tunnel. The CF-Access service token is injected as env (never on the command
 * line) so it does not leak into `ps`/process listings. `cloudflared` is the
 * ProxyCommand with its ABSOLUTE path (non-login shell has no Homebrew PATH).
 */
function buildSshInvocation(
  client: Client,
  remoteCommand: string
): { argv: string[]; env: NodeJS.ProcessEnv } | null {
  const sshTarget = client.ssh_target?.trim();
  if (!sshTarget) return null;

  const env: NodeJS.ProcessEnv = { ...process.env };
  // CF-Access service token → env vars cloudflared reads on the proxy hop.
  if (client.cf_access_client_id && client.cf_access_client_secret) {
    env.TUNNEL_SERVICE_TOKEN_ID = client.cf_access_client_id;
    env.TUNNEL_SERVICE_TOKEN_SECRET = client.cf_access_client_secret;
  }

  const argv = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.ceil(REMOTE_TIMEOUT_MS / 1000)}`,
    '-o', `ProxyCommand=${CLOUDFLARED_BIN} access ssh --hostname %h`,
    sshTarget,
    // Wrap in a login-ish shell so node/brew tools are on PATH if the command
    // needs them; for plain `find`/`cat` it is harmless.
    'zsh', '-lc', remoteCommand,
  ];
  return { argv, env };
}

function runSsh(client: Client, remoteCommand: string): Promise<RemoteExecOutcome> {
  const inv = buildSshInvocation(client, remoteCommand);
  if (!inv) {
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: '',
      reason: 'no ssh_target configured for this client',
    });
  }
  return new Promise((resolve) => {
    execFile(
      'ssh',
      inv.argv,
      { timeout: REMOTE_TIMEOUT_MS, maxBuffer: REMOTE_MAX_BUFFER, env: inv.env, windowsHide: true },
      (err, stdout, stderr) => {
        const out = stdout?.toString() ?? '';
        const errOut = stderr?.toString() ?? '';
        if (err) {
          // Keep the reason UI-safe: surface ssh/cloudflared message, not the token.
          const base = err.message.includes('ETIMEDOUT') || (err as { killed?: boolean }).killed
            ? 'remote connection timed out (tunnel may be down)'
            : errOut.trim().split('\n').slice(-1)[0] || err.message;
          resolve({ ok: false, stdout: out, stderr: errOut, reason: base });
          return;
        }
        resolve({ ok: true, stdout: out, stderr: errOut });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Directory + file reads (local or remote)
// ---------------------------------------------------------------------------

export interface ReadClientDirOptions {
  /** Extensions (with dot, lowercase) to include. Default: any. */
  extensions?: Set<string> | string[];
  /** Max files to read. Default 2000. */
  maxFiles?: number;
  /** Max bytes per file. Default 256 KiB. */
  maxFileBytes?: number;
  /** Directory names to skip (in addition to the heavy defaults). */
  skipDirs?: string[];
}

const HEAVY_SKIP = ['node_modules', '.git', '.next', '.turbo', 'dist', 'build', '.venv', '__pycache__'];

function normalizeExts(exts?: Set<string> | string[]): Set<string> | null {
  if (!exts) return null;
  return exts instanceof Set ? exts : new Set(exts.map((e) => e.toLowerCase()));
}

/**
 * Read every text file under a client's resolved root. Local self reads use
 * `fs`; remote clients read over SSH with a single `find … | while read … cat`
 * pass so one round-trip carries the whole subtree. Always returns a result;
 * `error` is set (and `files` empty) on remote failure.
 */
export async function readClientDir(
  kind: ClientPathKind,
  opts: ReadClientDirOptions = {}
): Promise<ReadClientDirResult> {
  const sel = selectedClientPath(kind);
  if (!sel) {
    // Empty clients table — degrade, never throw.
    const stub: Client = {
      id: 'self', name: 'self', gateway_url: '', gateway_token: null,
      cf_access_client_id: null, cf_access_client_secret: null,
      workspace_root: null, ssh_target: null, interview_complete: false,
      is_self: true, created_at: null, updated_at: null,
    };
    return { client: stub, root: { remote: false, path: '' }, files: [], error: null };
  }
  const { client, resolved } = sel;
  const exts = normalizeExts(opts.extensions);
  const maxFiles = opts.maxFiles ?? 2000;
  const maxBytes = opts.maxFileBytes ?? 256 * 1024;
  const skip = new Set([...HEAVY_SKIP, ...(opts.skipDirs ?? [])]);

  if (!resolved.remote) {
    const files = await readLocalDir(resolved.path, { exts, maxFiles, maxBytes, skip });
    return { client, root: resolved, files, error: null };
  }

  // Remote read over the tunnel.
  const { files, error } = await readRemoteDir(client, resolved.path, { exts, maxFiles, maxBytes });
  return { client, root: resolved, files, error };
}

interface InternalReadOpts {
  exts: Set<string> | null;
  maxFiles: number;
  maxBytes: number;
  skip: Set<string>;
}

async function readLocalDir(root: string, opts: InternalReadOpts): Promise<ClientFile[]> {
  const files: ClientFile[] = [];
  let scanned = 0;
  const stack: string[] = [root];
  // Cheap existence short-circuit.
  if (!root || !fsSync.existsSync(root)) return files;
  while (stack.length > 0) {
    if (scanned >= opts.maxFiles) break;
    const current = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (opts.skip.has(ent.name) || ent.name.startsWith('.')) continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (scanned >= opts.maxFiles) break;
      scanned += 1;
      const ext = path.extname(ent.name).toLowerCase();
      if (opts.exts && !opts.exts.has(ext)) continue;
      try {
        const st = await fs.stat(full);
        if (!st.isFile()) continue;
        const buf = await fs.readFile(full, 'utf8');
        const contents = st.size > opts.maxBytes ? buf.slice(0, opts.maxBytes) : buf;
        files.push({
          relPath: path.relative(root, full),
          absPath: full,
          contents,
          mtime: st.mtime.toISOString(),
          size: st.size,
        });
      } catch {
        // unreadable file — skip, keep scanning
      }
    }
  }
  return files;
}

/**
 * Remote read in ONE ssh round-trip. We list matching files with `find`, then
 * emit each as a small NUL-delimited envelope: `<<<BCCFILE>>>\t<relpath>\n<bytes>`.
 * Parsing is line-disciplined and bounded by maxFiles/maxBytes upstream.
 */
async function readRemoteDir(
  client: Client,
  remoteRoot: string,
  opts: Omit<InternalReadOpts, 'skip'>
): Promise<{ files: ClientFile[]; error: RemoteError | null }> {
  // Build a find expression scoped to the requested extensions.
  const extClause = opts.exts && opts.exts.size > 0
    ? '\\( ' + Array.from(opts.exts)
        .map((e) => `-iname "*${e.replace(/"/g, '')}"`)
        .join(' -o ') + ' \\)'
    : '';
  // Marker-delimited stream: per file print a header line then the body.
  // head -c bounds each file; we cap the file count with a head on find.
  const root = shellQuote(remoteRoot);
  const cmd =
    `test -e ${root} || { echo "__BCC_NOROOT__"; exit 0; }; ` +
    `find ${root} -type f ${extClause} 2>/dev/null | head -n ${opts.maxFiles} | ` +
    `while IFS= read -r f; do ` +
    `echo "__BCC_FILE__ $f"; ` +
    `head -c ${opts.maxBytes} "$f" 2>/dev/null; ` +
    `echo; echo "__BCC_END__"; done`;

  const res = await runSsh(client, cmd);
  if (!res.ok) {
    return {
      files: [],
      error: {
        failed: true,
        reason: res.reason || 'remote read failed',
        notConfigured: !client.ssh_target,
      },
    };
  }
  if (res.stdout.includes('__BCC_NOROOT__')) {
    // Root simply does not exist on the remote box — not an error, just empty.
    return { files: [], error: null };
  }
  return { files: parseRemoteStream(res.stdout, remoteRoot), error: null };
}

function parseRemoteStream(stdout: string, remoteRoot: string): ClientFile[] {
  const files: ClientFile[] = [];
  const lines = stdout.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('__BCC_FILE__ ')) {
      const absPath = line.slice('__BCC_FILE__ '.length);
      const bodyLines: string[] = [];
      i += 1;
      while (i < lines.length && lines[i] !== '__BCC_END__') {
        bodyLines.push(lines[i]);
        i += 1;
      }
      // Drop the trailing newline we injected before __BCC_END__.
      if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
      const contents = bodyLines.join('\n');
      files.push({
        relPath: absPath.startsWith(remoteRoot)
          ? absPath.slice(remoteRoot.length).replace(/^\/+/, '')
          : absPath,
        absPath,
        contents,
        mtime: null,
        size: Buffer.byteLength(contents, 'utf8'),
      });
    }
    i += 1;
  }
  return files;
}

/**
 * Read ONE file for the selected client. `relativePath` is joined under the
 * resolved root. Returns the file or a RemoteError on failure (never throws).
 */
export async function readClientFile(
  kind: ClientPathKind,
  relativePath: string
): Promise<ClientFile | RemoteError | null> {
  const sel = selectedClientPath(kind);
  if (!sel) return null;
  const { client, resolved } = sel;

  if (!resolved.remote) {
    const abs = path.join(resolved.path, relativePath);
    try {
      const st = await fs.stat(abs);
      const contents = await fs.readFile(abs, 'utf8');
      return {
        relPath: relativePath,
        absPath: abs,
        contents,
        mtime: st.mtime.toISOString(),
        size: st.size,
      };
    } catch {
      return null;
    }
  }

  const abs = path.posix.join(resolved.path, relativePath);
  const res = await runSsh(client, `cat ${shellQuote(abs)} 2>/dev/null || echo "__BCC_MISSING__"`);
  if (!res.ok) {
    return { failed: true, reason: res.reason || 'remote read failed', notConfigured: !client.ssh_target };
  }
  if (res.stdout.includes('__BCC_MISSING__')) return null;
  return { relPath: relativePath, absPath: abs, contents: res.stdout, mtime: null, size: Buffer.byteLength(res.stdout, 'utf8') };
}

/**
 * Write ONE file for the selected client under a resolved root. Local self uses
 * `fs`; a remote client streams the bytes over SSH into `cat > file`. Returns
 * the absolute path written, or a RemoteError (never throws).
 */
export async function writeClientFile(
  kind: ClientPathKind,
  relativePath: string,
  contents: string
): Promise<{ absPath: string; remote: boolean } | RemoteError | null> {
  const sel = selectedClientPath(kind);
  if (!sel) return null;
  const { client, resolved } = sel;

  if (!resolved.remote) {
    const abs = path.join(resolved.path, relativePath);
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents, 'utf8');
      return { absPath: abs, remote: false };
    } catch (err) {
      return { failed: true, reason: err instanceof Error ? err.message : 'local write failed' };
    }
  }

  const abs = path.posix.join(resolved.path, relativePath);
  const dir = path.posix.dirname(abs);
  // base64 the payload so arbitrary content survives the shell intact.
  const b64 = Buffer.from(contents, 'utf8').toString('base64');
  const cmd = `mkdir -p ${shellQuote(dir)} && printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(abs)}`;
  const res = await runSsh(client, cmd);
  if (!res.ok) {
    return { failed: true, reason: res.reason || 'remote write failed', notConfigured: !client.ssh_target };
  }
  return { absPath: abs, remote: true };
}

/** True when a value is the RemoteError shape. */
export function isRemoteError(v: unknown): v is RemoteError {
  return !!v && typeof v === 'object' && (v as RemoteError).failed === true;
}

/** Single-quote a string for safe interpolation into a remote shell command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export { runSsh as runClientSsh };
