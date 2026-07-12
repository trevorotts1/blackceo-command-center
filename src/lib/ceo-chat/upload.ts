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
 * executable renamed with a disallowed extension. For binary media types
 * (images/video/audio — see MAGIC_SNIFFERS below) that extension-only fallback
 * is further tightened: an executable renamed `malware.png` and sent with an
 * empty/octet-stream MIME is refused unless its actual bytes match the format's
 * magic-byte signature.
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
  /**
   * A small prefix of the ACTUAL file bytes (the first ~32 bytes are enough
   * for every signature below), used to close the MIME-gate bypass: a
   * renamed executable sent with an empty/`application/octet-stream` MIME
   * type. Only required when the extension is a binary media type (see
   * MAGIC_SNIFFERS) and no trustworthy MIME was declared — see
   * `needsContentSniff` on the result when this is missing.
   */
  bytesPrefix?: Uint8Array | ArrayBuffer | number[];
}

/** Normalize any of the accepted byte-prefix shapes to a Uint8Array. */
function toUint8Array(input: Uint8Array | ArrayBuffer | number[]): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (Array.isArray(input)) return Uint8Array.from(input);
  return new Uint8Array(input);
}

/** True when `bytes` starts with the given byte sequence at `offset`. */
function bytesStartWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** True when `bytes` has the ASCII string `text` at `offset`. */
function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** ISO-BMFF (MP4/QuickTime family) box types that legitimately open a file. */
const ISO_BMFF_BOX_TYPES = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'];

/**
 * Magic-byte signature checkers, keyed by lower-cased extension, for every
 * binary media type in ALLOWED_UPLOAD_TYPES (images, video, audio). An
 * extension with no entry here has no cheap, reliable signature (e.g. text
 * formats) and is left on the extension-only fallback. Extensions listed
 * here are exactly the ones an attacker would rename an executable to
 * ("malware.png") to ride the octet-stream/empty-MIME fallback — see
 * validateUpload().
 */
export const MAGIC_SNIFFERS: Record<string, (bytes: Uint8Array) => boolean> = {
  png: (b) => bytesStartWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: (b) => bytesStartWith(b, [0xff, 0xd8, 0xff]),
  jpeg: (b) => bytesStartWith(b, [0xff, 0xd8, 0xff]),
  gif: (b) => asciiAt(b, 0, 'GIF8'),
  webp: (b) => asciiAt(b, 0, 'RIFF') && asciiAt(b, 8, 'WEBP'),
  heic: (b) => asciiAt(b, 4, 'ftyp'),
  mp4: (b) => asciiAt(b, 4, 'ftyp'),
  m4v: (b) => asciiAt(b, 4, 'ftyp'),
  mov: (b) => ISO_BMFF_BOX_TYPES.some((box) => asciiAt(b, 4, box)),
  webm: (b) => bytesStartWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  mp3: (b) => asciiAt(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  m4a: (b) => asciiAt(b, 4, 'ftyp'),
  wav: (b) => asciiAt(b, 0, 'RIFF') && asciiAt(b, 8, 'WAVE'),
};

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
  /**
   * Set (with `ok: false`) when this is a binary media extension with no
   * trustworthy declared MIME type and no `bytesPrefix` was supplied — the
   * caller should read a small prefix of the real bytes (see MAGIC_SNIFFERS)
   * and re-validate with `bytesPrefix` set before treating this as a final
   * rejection.
   */
  needsContentSniff?: boolean;
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
  // (an executable masquerading as an image) is refused.
  const declared = (mimeType || '').toLowerCase().split(';')[0].trim();
  const isGenericMime = !declared || declared === 'application/octet-stream';
  if (!isGenericMime && !allowedMimes.includes(declared)) {
    return {
      ok: false,
      reason: 'type-not-allowed',
      message: `The file's content type "${declared}" doesn't match a "${ext}" file.`,
    };
  }

  // An empty / generic octet-stream MIME (some mobile pickers send this)
  // falls back to the extension gate above — EXCEPT for binary media types,
  // where extension alone is exactly what lets an executable renamed
  // `malware.png` through. For those, require the real bytes to match the
  // format's magic-byte signature before accepting.
  const sniffer = MAGIC_SNIFFERS[ext];
  if (isGenericMime && sniffer) {
    if (candidate.bytesPrefix === undefined) {
      return {
        ok: false,
        reason: 'type-not-allowed',
        needsContentSniff: true,
        message: `Can't verify this "${ext}" file without a content type — its actual bytes need to be checked.`,
        safeName,
        ext,
      };
    }
    if (!sniffer(toUint8Array(candidate.bytesPrefix))) {
      return {
        ok: false,
        reason: 'type-not-allowed',
        message: `The file's contents don't match a "${ext}" file.`,
      };
    }
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
