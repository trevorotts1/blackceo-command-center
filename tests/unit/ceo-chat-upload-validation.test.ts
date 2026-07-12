/**
 * P5-01 — My AI CEO upload validation (the QC break-it probes as a unit test).
 *
 * The spec (e) break-it list requires: a 5GB file gets a clean refusal; an
 * executable gets a type refusal. validateUpload() is the PURE decision both the
 * route and the judge exercise, so we prove it directly here — no live route, no
 * disk.
 *
 * Fail-first: against the pre-P5-01 tree src/lib/ceo-chat/upload.ts does not
 * exist, so this suite cannot even import — it is red until the feature lands.
 */
import { describe, it, expect } from 'vitest';
import {
  validateUpload,
  MAX_UPLOAD_BYTES,
  resolveInboxDir,
  inboxDateSegment,
  extensionOf,
  sanitizeFilename,
} from '@/lib/ceo-chat/upload';

describe('validateUpload — size cap (break-it: a 5GB file)', () => {
  it('refuses a 5GB upload with reason "too-large" (never buffers it)', () => {
    const v = validateUpload({ filename: 'huge.mp4', mimeType: 'video/mp4', size: 5 * 1024 * 1024 * 1024 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('too-large');
  });

  it('accepts a large-but-legal file at exactly the cap', () => {
    const v = validateUpload({ filename: 'ok.mp4', mimeType: 'video/mp4', size: MAX_UPLOAD_BYTES });
    expect(v.ok).toBe(true);
  });

  it('refuses an empty (0-byte) file', () => {
    const v = validateUpload({ filename: 'empty.pdf', mimeType: 'application/pdf', size: 0 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('empty');
  });
});

describe('validateUpload — type allow-list (break-it: an executable)', () => {
  it('refuses a raw .exe', () => {
    const v = validateUpload({ filename: 'malware.exe', mimeType: 'application/x-msdownload', size: 1024 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('type-not-allowed');
  });

  it('refuses a .sh script', () => {
    const v = validateUpload({ filename: 'evil.sh', mimeType: 'text/x-shellscript', size: 200 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('type-not-allowed');
  });

  it('refuses an executable renamed .png when the MIME betrays it', () => {
    const v = validateUpload({ filename: 'notreally.png', mimeType: 'application/x-msdownload', size: 4096 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('type-not-allowed');
  });

  it('refuses a file with no extension', () => {
    const v = validateUpload({ filename: 'README', mimeType: '', size: 100 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('type-not-allowed');
  });

  it.each([
    ['brief.pdf', 'application/pdf'],
    ['spec.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['notes.md', 'text/markdown'],
    ['photo.png', 'image/png'],
    ['pic.jpg', 'image/jpeg'],
    ['clip.mp4', 'video/mp4'],
    ['clip.mov', 'video/quicktime'],
  ])('accepts an allowed type %s', (filename, mime) => {
    const v = validateUpload({ filename, mimeType: mime, size: 2048 });
    expect(v.ok).toBe(true);
    expect(v.safeName).toBe(filename);
  });

  it('accepts an allowed extension when the picker sends octet-stream / empty MIME', () => {
    const octet = validateUpload({ filename: 'doc.pdf', mimeType: 'application/octet-stream', size: 500 });
    const empty = validateUpload({ filename: 'doc.pdf', mimeType: '', size: 500 });
    expect(octet.ok).toBe(true);
    expect(empty.ok).toBe(true);
    // pdf has no magic-byte sniffer (not a binary-media extension) — the
    // extension-only fallback still applies to it, unchanged.
    expect(octet.needsContentSniff).toBeFalsy();
    expect(empty.needsContentSniff).toBeFalsy();
  });
});

describe('validateUpload — MIME-gate bypass (break-it: an executable renamed .png, sent octet-stream)', () => {
  const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const MP4_FTYP = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); // "....ftypisom"
  // A Windows PE executable's real magic bytes ("MZ...") — this is what
  // `malware.png` actually contains once you look past its extension.
  const EXE_MAGIC = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);

  it('does NOT accept a renamed executable on extension + generic MIME alone (no bytes supplied)', () => {
    const v = validateUpload({ filename: 'malware.png', mimeType: 'application/octet-stream', size: 4096 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('type-not-allowed');
    // Signals the caller to fetch a byte prefix and re-validate — the route
    // must NOT treat this as "accepted" just because extension+ext-gate passed.
    expect(v.needsContentSniff).toBe(true);
  });

  it('the same holds for an empty (missing) MIME type, not just octet-stream', () => {
    const v = validateUpload({ filename: 'malware.png', mimeType: '', size: 4096 });
    expect(v.ok).toBe(false);
    expect(v.needsContentSniff).toBe(true);
  });

  it('refuses the renamed executable once its real bytes (MZ header) are checked', () => {
    const v = validateUpload({
      filename: 'malware.png',
      mimeType: 'application/octet-stream',
      size: 4096,
      bytesPrefix: EXE_MAGIC,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('type-not-allowed');
  });

  it('accepts a genuine .png with generic MIME once its magic bytes are supplied and match', () => {
    const v = validateUpload({
      filename: 'photo.png',
      mimeType: 'application/octet-stream',
      size: 4096,
      bytesPrefix: PNG_MAGIC,
    });
    expect(v.ok).toBe(true);
    expect(v.safeName).toBe('photo.png');
  });

  it('the same executable-renamed bypass is closed for video (.mp4)', () => {
    const rejectedNoBytes = validateUpload({ filename: 'malware.mp4', mimeType: '', size: 4096 });
    expect(rejectedNoBytes.ok).toBe(false);
    expect(rejectedNoBytes.needsContentSniff).toBe(true);

    const rejectedWithExeBytes = validateUpload({
      filename: 'malware.mp4',
      mimeType: '',
      size: 4096,
      bytesPrefix: EXE_MAGIC,
    });
    expect(rejectedWithExeBytes.ok).toBe(false);

    const acceptedRealVideo = validateUpload({
      filename: 'clip.mp4',
      mimeType: 'application/octet-stream',
      size: 4096,
      bytesPrefix: MP4_FTYP,
    });
    expect(acceptedRealVideo.ok).toBe(true);
  });

  it('a declared, mismatched MIME is still refused before any sniffing (unchanged prior behavior)', () => {
    const v = validateUpload({ filename: 'malware.png', mimeType: 'application/x-msdownload', size: 4096 });
    expect(v.ok).toBe(false);
    expect(v.needsContentSniff).toBeFalsy();
  });
});

describe('filename sanitization + inbox path (no traversal)', () => {
  it('strips directory + traversal parts from the stored name', () => {
    expect(sanitizeFilename('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sanitizeFilename('C:\\Windows\\evil.png')).toBe('evil.png');
    expect(sanitizeFilename('  ..config  ')).not.toMatch(/^\./);
  });

  it('a traversal filename is refused when it has no allowed extension', () => {
    const v = validateUpload({ filename: '../../../etc/passwd', mimeType: '', size: 100 });
    expect(v.ok).toBe(false);
  });

  it('resolveInboxDir lands under <root>/inbox/ceo-chat/<YYYY-MM-DD>', () => {
    const dir = resolveInboxDir('/srv/workspace', new Date('2026-07-11T12:00:00Z'));
    expect(dir).toBe('/srv/workspace/inbox/ceo-chat/2026-07-11');
    expect(inboxDateSegment(new Date('2026-07-11T23:59:59Z'))).toBe('2026-07-11');
  });

  it('extensionOf is lower-cased and dotless', () => {
    expect(extensionOf('Report.PDF')).toBe('pdf');
    expect(extensionOf('noext')).toBe('');
  });
});
