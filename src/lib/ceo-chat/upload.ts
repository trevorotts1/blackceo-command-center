/**
 * "My AI CEO" upload validation + inbox path resolution (P5-01 (c) step 1).
 *
 * Uploads must land where the agent can actually read them — a workspace inbox
 * dir — with size/type limits (spec (b)). This module is the PURE, unit-tested
 * heart of that: an allow-list of file types, a hard size cap, and a
 * path-traversal-safe destination under `<workspace>/inbox/ceo-chat/<date>/`.
 *
 * The route (src/app/api/ceo-chat/upload/route.ts) does the IO; every DECISION
 * (accept/reject, and WHERE the bytes land) lives here so the break-it QC probes
 * — a 5GB file, an executable — are proven against a function, not a live route.
 */
import path from 'path';

/** Hard byte cap for a single upload (spec (b): "size cap (e.g. 200MB)"). */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Allow-list of accepted upload types (spec (c) step 1:
 * "pdf/docx/txt/md/png/jpg/mp4/mov…"). Keyed by lower-cased file extension; the
 * value is the set of MIME types we also accept for that extension. An upload is
 * accepted only when BOTH its extension is listed AND (when the browser supplied
 * a non-empty MIME type) that MIME type is in the extension's set. A missing /
 * empty MIME type falls back to the extension alone (some mobile pickers send
 * `application/octet-stream` or nothing) — the extension gate still blocks an
 * executable renamed with a disallowed extension.
 */
export const ALLOWED_UPLOAD_TYPES: Record<string, string[]> = {
  // Documents
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  txt: ['text/plain'],
  md: ['text/markdown', 'text/plain', 'text/x-markdown'],
  csv: ['text/csv', 'text/plain'],
  rtf: ['application/rtf', 'text/rtf'],
  // Images
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  heic: ['image/heic', 'image/heif'],
  // Audio / Video
  mp4: ['video/mp4'],
  mov: ['video/quicktime'],
  m4v: ['video/x-m4v', 'video/mp4'],
  webm: ['video/webm', 'audio/webm'],
  mp3: ['audio/mpeg', 'audio/mp3'],
  m4a: ['audio/mp4', 'audio/x-m4a'],
  wav: ['audio/wav', 'audio/x-wav'],
};

export interface UploadCandidate {
  /** The original client-supplied filename (may contain path separators / junk). */
  filename: string;
  /** The browser-reported MIME type (may be empty on some mobile pickers). */
  mimeType?: string | null;
  /** The byte size of the upload. */
  size: number;
}

export type UploadRejectReason =
  | 'empty'
  | 'too-large'
  | 'type-not-allowed'
  | 'bad-filename';

export interface UploadValidation {
  ok: boolean;
  reason?: UploadRejectReason;
  message?: string;
  /** The sanitized base filename (no directory parts) used for storage. */
  safeName?: string;
  /** The lower-cased extension WITHOUT the dot. */
  ext?: string;
}

/** Extract a lower-cased, dotless extension from a filename, or '' if none. */
export function extensionOf(filename: string): string {
  const base = path.basename(filename);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Strip any directory component and control/traversal characters from a
 * client-supplied filename, yielding a safe base name to store under the inbox.
 * Never returns a name that resolves outside its directory.
 */
export function sanitizeFilename(filename: string): string {
  // Take only the last path segment (defeats "../../etc/passwd" and
  // "C:\\Windows\\x" style names), then strip anything that isn't a safe
  // filename character.
  const base = path.basename(String(filename).replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[/\0]/g, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .trim()
    .replace(/^\.+/, ''); // trim FIRST, then strip leading dots — never a dotfile / "."/".."
  return cleaned;
}

/**
 * The single accept/reject decision for an upload. PURE — no IO. The route calls
 * this before touching disk; the QC break-it probes (5GB file, .exe) call it
 * directly.
 */
export function validateUpload(candidate: UploadCandidate): UploadValidation {
  const { filename, mimeType, size } = candidate;

  if (!filename || !String(filename).trim()) {
    return { ok: false, reason: 'bad-filename', message: 'A filename is required.' };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: 'empty', message: 'The file is empty.' };
  }
  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      message: `File is too large. The limit is ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`,
    };
  }

  const safeName = sanitizeFilename(filename);
  if (!safeName) {
    return { ok: false, reason: 'bad-filename', message: 'The filename is invalid.' };
  }

  const ext = extensionOf(safeName);
  const allowedMimes = ext ? ALLOWED_UPLOAD_TYPES[ext] : undefined;
  if (!ext || !allowedMimes) {
    return {
      ok: false,
      reason: 'type-not-allowed',
      message: `Files of type "${ext || 'unknown'}" aren't allowed here. Allowed: ${Object.keys(ALLOWED_UPLOAD_TYPES).join(', ')}.`,
    };
  }

  // When the browser supplied a real MIME type, it must also match the
  // extension's allow-set — so a `.png` carrying `application/x-msdownload`
  // (an executable masquerading as an image) is refused. An empty / generic
  // octet-stream MIME falls back to the extension gate above (already passed).
  const declared = (mimeType || '').toLowerCase().split(';')[0].trim();
  if (declared && declared !== 'application/octet-stream' && !allowedMimes.includes(declared)) {
    return {
      ok: false,
      reason: 'type-not-allowed',
      message: `The file's content type "${declared}" doesn't match a "${ext}" file.`,
    };
  }

  return { ok: true, safeName, ext };
}

/**
 * The date-bucket segment (`YYYY-MM-DD`, UTC) used to shard the inbox so a busy
 * day's uploads don't pile into one directory.
 */
export function inboxDateSegment(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Resolve the absolute inbox directory an upload lands in:
 *   <workspaceRoot>/inbox/ceo-chat/<YYYY-MM-DD>/
 * The route creates it (recursive) before writing. Pure string composition.
 */
export function resolveInboxDir(workspaceRoot: string, now: Date = new Date()): string {
  return path.join(workspaceRoot, 'inbox', 'ceo-chat', inboxDateSegment(now));
}

/**
 * The workspace root uploads land under. Mirrors the env conventions the rest of
 * the CC uses (OPENCLAW_WORKSPACE_PATH → WORKSPACE_BASE_PATH → ~/Documents/Shared),
 * expanding a leading `~`. This is where the on-box agent reads its inbox.
 */
export function resolveWorkspaceRoot(): string {
  const raw =
    process.env.OPENCLAW_WORKSPACE_PATH ||
    process.env.WORKSPACE_BASE_PATH ||
    path.join(process.env.HOME || '', 'Documents', 'Shared');
  return raw.replace(/^~/, process.env.HOME || '');
}
